/**
 * AgentOS — Cloudflare Agents Deployment (Modernized)
 *
 * Uses Cloudflare Agents SDK patterns:
 *   - @callable() methods for type-safe RPC
 *   - Dedicated MCP server agent for MCP protocol support
 *   - this.schedule() / this.queue() for job orchestration
 *   - this.sql`` for persistent state
 *   - routeAgentRequest for URL-based agent dispatch
 */

import {
  Agent,
  AgentNamespace,
  Connection,
  callable,
  routeAgentRequest,
  getAgentByName,
  type StreamingResponse,
} from "agents";
import { getSandbox, type Sandbox } from "@cloudflare/sandbox";
import {
  edgeRun, edgeBatch, edgeResume, computeLatencyBreakdown, loadRuntimeEventsPage, replayOtelEventsAtCursor, buildRuntimeRunTree,
  writeEvalRun, writeEvalTrial, listEvalRuns, getEvalRun, listEvalTrialsByRun,
  executeBoundedDagDeclarativeRun,
  executeLinearDeclarativeRun,
  type RunRequest, type RuntimeEnv, type BatchRequest, type GraphSpec,
} from "./runtime";
import { streamRun } from "./runtime/stream";

// Re-export Sandbox so Cloudflare can discover the Durable Object class
export { Sandbox as AgentSandbox } from "@cloudflare/sandbox";

// ---------------------------------------------------------------------------
// Environment bindings
// ---------------------------------------------------------------------------

export interface Env extends Cloudflare.Env {
  OPENROUTER_API_KEY?: string;   // OpenRouter key (used via AI Gateway)
  AUTH_JWT_SECRET?: string;      // End-user JWT auth (portal, API clients)
  SERVICE_TOKEN?: string;        // Service-to-service auth (dispatch workers → main worker)
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_API_TOKEN?: string;
  AI_GATEWAY_ID?: string;        // CF AI Gateway slug (e.g. "one-shots")
  AI_GATEWAY_TOKEN?: string;     // Dedicated gateway token (least-privilege)
  BRAVE_SEARCH_KEY?: string;     // Brave Search API key
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_AGENT_NAME?: string;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AgentState {
  config: AgentConfig;
  working: Record<string, unknown>;
  turnCount: number;
  sessionActive: boolean;
  totalCostUsd: number;
}

interface AgentConfig {
  plan: string;
  provider: string;
  model: string;
  orgId?: string;
  projectId?: string;
  maxTurns: number;
  budgetLimitUsd: number;
  blockedTools: string[];
  tools: string[];  // Tool names this agent has access to
  systemPrompt: string;
  agentName: string;
  agentDescription: string;
}

interface TurnResult {
  turn: number;
  content: string;
  toolResults: any[];
  done: boolean;
  error?: string;
  costUsd: number;
  model: string;
}

interface ObservabilityEvent {
  id: number;
  session_id: string;
  turn: number;
  event_type: string;
  action: string;
  plan: string;
  tier: string;
  provider: string;
  model: string;
  tool_name: string;
  status: string;
  latency_ms: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  details_json: string;
  created_at: string;
}

type ComplexityTier = "simple" | "moderate" | "complex" | "tool_call";

type PlanRoute = {
  provider: string;
  model: string;
  maxTokens: number;
};

type PlanRouting = Record<ComplexityTier, PlanRoute>;

function normalizePlan(value?: string): string {
  const raw = (value || "").trim().toLowerCase();
  if (!raw) return "standard";
  if (raw === "balanced") return "standard";
  if (raw === "manual") return "manual";
  return ["basic", "standard", "premium", "code", "dedicated", "private"].includes(raw) ? raw : "standard";
}

// ---------------------------------------------------------------------------
// AgentOS Agent — main agent with @callable methods
// ---------------------------------------------------------------------------

export class AgentOSAgent extends Agent<Env, AgentState> {
  initialState: AgentState = {
    config: {
      plan: "standard",
      provider: "openrouter",
      model: "deepseek/deepseek-chat-v3-0324",
      orgId: "",
      projectId: "",
      maxTurns: 50,
      budgetLimitUsd: 10.0,
      blockedTools: [],
      tools: [],
      systemPrompt: "You are a helpful AI assistant.",
      agentName: "agentos",
      agentDescription: "AgentOS Agent",
    },
    working: {},
    turnCount: 0,
    sessionActive: false,
    totalCostUsd: 0,
  };

  async onStart() {
    // DO SQLite: fast local conversation cache
    this.sql`CREATE TABLE IF NOT EXISTS conversation_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      channel TEXT NOT NULL DEFAULT '',
      created_at REAL NOT NULL DEFAULT (unixepoch('now'))
    )`;

    // Hydrate from Supabase if DO SQLite is empty (cold start / post-deploy)
    const localCount = this.sql<{ cnt: number }>`SELECT COUNT(*) as cnt FROM conversation_messages`;
    if ((localCount[0]?.cnt || 0) === 0 && this.env.HYPERDRIVE) {
      try {
        const { loadConversationHistory } = await import("./runtime/db");
        const messages = await loadConversationHistory(this.env.HYPERDRIVE, this.name, 24);
        for (const msg of messages) {
          this.sql`INSERT INTO conversation_messages (role, content, channel, created_at)
            VALUES (${msg.role}, ${msg.content.slice(0, 8000)}, ${msg.channel}, ${msg.created_at || Date.now() / 1000})`;
        }
      } catch {}
    }
  }

  // ── Callable Methods (RPC from client) ──────────────────────────

  @callable()
  async run(input: string): Promise<TurnResult[]> {
    // Always execute on edge runtime.
    return this._runAtEdge(input);
  }

  /**
   * Run the agent entirely at the edge using CF bindings.
   * No backend hop — LLM, tools, DB all execute here.
   * Errors surface directly; no silent fallback to backend.
   */
  private async _runAtEdge(input: string): Promise<TurnResult[]> {
    const config = this.state.config;
    const started = Date.now();

    const runtimeEnv: RuntimeEnv = {
      AI: this.env.AI,
      HYPERDRIVE: this.env.HYPERDRIVE,
      VECTORIZE: this.env.VECTORIZE,
      STORAGE: this.env.STORAGE,
      SANDBOX: this.env.SANDBOX,
      LOADER: this.env.LOADER,
      TELEMETRY_QUEUE: this.env.TELEMETRY_QUEUE,
      BROWSER: this.env.BROWSER,
      AI_GATEWAY_ID: this.env.AI_GATEWAY_ID,
      AI_GATEWAY_TOKEN: this.env.AI_GATEWAY_TOKEN,
      BRAVE_SEARCH_KEY: this.env.BRAVE_SEARCH_KEY,
      CLOUDFLARE_ACCOUNT_ID: this.env.CLOUDFLARE_ACCOUNT_ID,
      CLOUDFLARE_API_TOKEN: this.env.CLOUDFLARE_API_TOKEN,
      DEFAULT_PROVIDER: this.env.DEFAULT_PROVIDER || config.provider || "openrouter",
      DEFAULT_MODEL: this.env.DEFAULT_MODEL || config.model || "deepseek/deepseek-chat-v3-0324",
    };

    const request: RunRequest = {
      agent_name: config.agentName || "agentos",
      task: input,
      org_id: config.orgId || "",
      project_id: config.projectId || "",
    };

    const result = await edgeRun(
      runtimeEnv,
      this.env.HYPERDRIVE,
      request,
      this.env.TELEMETRY_QUEUE,
    );

    const elapsed = Date.now() - started;

    // Record locally for DO observability
    this._recordEvent({
      sessionId: result.session_id,
      turn: 0,
      eventType: "session.complete",
      action: "run_edge",
      plan: normalizePlan(config.plan || this.env.DEFAULT_PLAN),
      status: result.success ? "ok" : "error",
      latencyMs: elapsed,
      costUsd: result.cost_usd,
      details: {
        turns: result.turns,
        tool_calls: result.tool_calls,
        source: "edge_runtime",
        stop_reason: result.stop_reason,
      },
    });

    // Session data is written to Supabase directly by edgeRun via Hyperdrive.
    // No backend mirroring — Supabase is the single source of truth.

    return [{
      turn: result.turns,
      content: result.output,
      toolResults: [],
      done: true,
      error: result.success ? undefined : "Edge runtime reported failure",
      costUsd: result.cost_usd,
      model: runtimeEnv.DEFAULT_MODEL,
    }];
  }

  @callable()
  getConfig(): AgentConfig {
    return this.state.config;
  }

  @callable()
  setConfig(config: Partial<AgentConfig>): AgentConfig {
    const before = this.state.config;
    const plan = normalizePlan(config.plan ?? before.plan ?? this.env.DEFAULT_PLAN);
    const updated = { ...before, ...config, plan };
    this.setState({ ...this.state, config: updated });
    const changedKeys = Object.keys(config || {}).filter((k) => {
      const key = k as keyof AgentConfig;
      return JSON.stringify(before[key]) !== JSON.stringify(updated[key]);
    });
    // Audit config changes via telemetry queue → Supabase
    if (changedKeys.length > 0 && this.env.TELEMETRY_QUEUE) {
      for (const key of changedKeys) {
        this.env.TELEMETRY_QUEUE.send({
          type: "event",
          payload: {
            event_type: "config.update",
            agent_name: updated.agentName || "agentos",
            field_changed: key,
            old_value: JSON.stringify(before[key as keyof AgentConfig] ?? ""),
            new_value: JSON.stringify(updated[key as keyof AgentConfig] ?? ""),
            changed_by: "worker",
            created_at: Date.now() / 1000,
          },
        }).catch(() => {});
      }
    }
    return updated;
  }

  @callable()
  getWorkingMemory(): Record<string, unknown> {
    return this.state.working;
  }

  @callable()
  setWorkingMemory(key: string, value: unknown): void {
    const working = { ...this.state.working, [key]: value };
    this.setState({ ...this.state, working });
  }

  @callable()
  getSessions(limit: number = 20): any[] {
    return this.sql`SELECT * FROM sessions ORDER BY created_at DESC LIMIT ${limit}`;
  }

  @callable()
  getStats(): any {
    const sessions = this.sql<{ cnt: number }>`SELECT COUNT(*) as cnt FROM sessions`;
    const totalCost = this.sql<{ total: number }>`SELECT COALESCE(SUM(cost_usd), 0) as total FROM sessions`;
    return {
      totalSessions: sessions[0]?.cnt ?? 0,
      totalCostUsd: totalCost[0]?.total ?? 0,
      turnCount: this.state.turnCount,
      sessionActive: this.state.sessionActive,
      config: this.state.config,
    };
  }

  private _loadConversationHistory(limit: number = 24): Array<{
    role: "user" | "assistant";
    content: string;
  }> {
    const rows = this.sql<{ role: string; content: string }>`
      SELECT role, content
      FROM conversation_messages
      WHERE role IN ('user', 'assistant')
      ORDER BY id DESC
      LIMIT ${Math.max(1, Math.min(limit, 100))}
    `;
    return rows
      .reverse()
      .map((r) => {
        const role: "user" | "assistant" = r.role === "assistant" ? "assistant" : "user";
        return {
          role,
          content: String(r.content || ""),
        };
      })
      .filter((r) => r.content.trim().length > 0);
  }

  private _appendConversationMessage(
    role: "user" | "assistant",
    content: string,
    channel: string,
  ): void {
    const clean = String(content || "").trim();
    if (!clean) return;
    // 1. DO SQLite (fast, local)
    this.sql`INSERT INTO conversation_messages (role, content, channel, created_at)
      VALUES (${role}, ${clean.slice(0, 8000)}, ${channel || ""}, ${Date.now() / 1000})`;
    // 2. Supabase (durable, survives deploys) — fire-and-forget
    if (this.env.HYPERDRIVE) {
      import("./runtime/db").then(({ writeConversationMessage }) =>
        writeConversationMessage(this.env.HYPERDRIVE, {
          agent_name: this.state.config.agentName || this.name,
          instance_id: this.name,
          role,
          content: clean.slice(0, 8000),
          channel: channel || "",
        }),
      ).catch(() => {});
    }
  }

  private async _isAuthorized(request: Request): Promise<boolean> {
    const url = new URL(request.url);
    if (url.hostname === "internal") return true;
    const serviceToken = String(this.env.SERVICE_TOKEN || "").trim();
    const secret = String(this.env.AUTH_JWT_SECRET || "").trim();
    if (!serviceToken && !secret) return true;
    const auth = request.headers.get("Authorization") || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    if (!token) return false;
    if (serviceToken && token === serviceToken) return true;
    if (!secret) return false;
    return verifyHs256Jwt(token, secret);
  }

  // ── WebSocket (real-time token streaming) ───────────────────────
  //
  // Protocol:
  //   Client → { type: "run", input: "...", agent_name?: "...", org_id?: "...", project_id?: "..." }
  //   Server → { type: "token", content: "..." }         — LLM token chunk (real-time)
  //   Server → { type: "tool_call", name, tool_call_id }  — tool execution started
  //   Server → { type: "tool_result", name, result }      — tool execution complete
  //   Server → { type: "turn_start", turn, model }        — new turn
  //   Server → { type: "turn_end", turn, cost_usd, done } — turn complete
  //   Server → { type: "done", output, turns, cost_usd }  — run complete
  //   Server → { type: "error", message }                 — error

  async onConnect(connection: Connection) {
    connection.send(JSON.stringify({
      type: "connected",
      agent: this.state.config.agentName,
      session_affinity: true,
    }));
  }

  async onMessage(connection: Connection, message: string | ArrayBuffer) {
    const data = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));

    if (data.type === "run") {
      const config = this.state.config;
      const runtimeEnv: RuntimeEnv = {
        AI: this.env.AI,
        HYPERDRIVE: this.env.HYPERDRIVE,
        VECTORIZE: this.env.VECTORIZE,
        STORAGE: this.env.STORAGE,
        SANDBOX: this.env.SANDBOX,
        LOADER: this.env.LOADER,
        TELEMETRY_QUEUE: this.env.TELEMETRY_QUEUE,
        BROWSER: this.env.BROWSER,
        OPENROUTER_API_KEY: this.env.OPENROUTER_API_KEY,
        AI_GATEWAY_ID: this.env.AI_GATEWAY_ID,
        AI_GATEWAY_TOKEN: this.env.AI_GATEWAY_TOKEN,
      BRAVE_SEARCH_KEY: this.env.BRAVE_SEARCH_KEY,
        CLOUDFLARE_ACCOUNT_ID: this.env.CLOUDFLARE_ACCOUNT_ID,
        CLOUDFLARE_API_TOKEN: this.env.CLOUDFLARE_API_TOKEN,
        DEFAULT_PROVIDER: this.env.DEFAULT_PROVIDER || config.provider || "openrouter",
        DEFAULT_MODEL: this.env.DEFAULT_MODEL || config.model || "@cf/moonshotai/kimi-k2.5",
      };

      const inputText = String(data.input || "");
      const history = this._loadConversationHistory(24);
      let finalOutput = "";
      const sendAndCapture = (msg: string) => {
        connection.send(msg);
        try {
          const parsed = JSON.parse(msg) as { type?: string; output?: string };
          if (parsed.type === "done" && typeof parsed.output === "string") {
            finalOutput = parsed.output;
          }
        } catch {
          // ignore malformed ws payloads
        }
      };

      // Stream the run — tokens flow to client in real-time
      await streamRun(
        runtimeEnv,
        this.env.HYPERDRIVE,
        inputText,
        data.agent_name || config.agentName || "agentos",
        sendAndCapture,
        {
          org_id: data.org_id || config.orgId || "",
          project_id: data.project_id || config.projectId || "",
          channel: data.channel || "websocket",
          history_messages: history,
        },
      );

      this._appendConversationMessage("user", inputText, data.channel || "websocket");
      this._appendConversationMessage("assistant", finalOutput, data.channel || "websocket");
    }
  }

  // ── Internal HTTP (async run from REST invoke) ──────────────────
  // Called by the Worker fetch handler via ctx.waitUntil(agent.fetch(...))
  // Runs the agent in the DO context (no timeout) and writes result to Supabase.

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/run" && request.method === "POST") {
      if (!(await this._isAuthorized(request))) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      const data = await request.json() as any;
      const config = this.state.config;
      const inputText = String(data.input || "");
      const history = this._loadConversationHistory(24);
      let finalOutput = "";
      let finalSessionId = "";
      let finalTraceId = "";
      let finalTurns = 0;
      let finalToolCalls = 0;
      let finalCostUsd = 0;
      let finalLatencyMs = 0;
      const runtimeEnv: RuntimeEnv = {
        AI: this.env.AI,
        HYPERDRIVE: this.env.HYPERDRIVE,
        VECTORIZE: this.env.VECTORIZE,
        STORAGE: this.env.STORAGE,
        SANDBOX: this.env.SANDBOX,
        LOADER: this.env.LOADER,
        TELEMETRY_QUEUE: this.env.TELEMETRY_QUEUE,
        BROWSER: this.env.BROWSER,
        AI_GATEWAY_ID: this.env.AI_GATEWAY_ID,
        AI_GATEWAY_TOKEN: this.env.AI_GATEWAY_TOKEN,
      BRAVE_SEARCH_KEY: this.env.BRAVE_SEARCH_KEY,
        CLOUDFLARE_ACCOUNT_ID: this.env.CLOUDFLARE_ACCOUNT_ID,
        CLOUDFLARE_API_TOKEN: this.env.CLOUDFLARE_API_TOKEN,
        DEFAULT_PROVIDER: this.env.DEFAULT_PROVIDER || config.provider || "openrouter",
        DEFAULT_MODEL: this.env.DEFAULT_MODEL || config.model || "@cf/moonshotai/kimi-k2.5",
      };

      // Run in DO context (no Worker timeout) — result written to Supabase
      await streamRun(
        runtimeEnv,
        this.env.HYPERDRIVE,
        inputText,
        data.agent_name || config.agentName || "agentos",
        (msg) => {
          try {
            const parsed = JSON.parse(msg) as {
              type?: string;
              output?: string;
              session_id?: string;
              trace_id?: string;
              turns?: number;
              tool_calls?: number;
              cost_usd?: number;
              latency_ms?: number;
            };
            if (parsed.type === "done") {
              if (typeof parsed.output === "string") finalOutput = parsed.output;
              if (typeof parsed.session_id === "string") finalSessionId = parsed.session_id;
              if (typeof parsed.trace_id === "string") finalTraceId = parsed.trace_id;
              finalTurns = Number(parsed.turns) || 0;
              finalToolCalls = Number(parsed.tool_calls) || 0;
              finalCostUsd = Number(parsed.cost_usd) || 0;
              finalLatencyMs = Number(parsed.latency_ms) || 0;
            }
          } catch {
            // ignore malformed payload
          }
        },
        {
          org_id: data.org_id || config.orgId || "",
          project_id: data.project_id || config.projectId || "",
          channel: data.channel || "async_rest",
          history_messages: history,
        },
      );

      this._appendConversationMessage("user", inputText, data.channel || "async_rest");
      this._appendConversationMessage("assistant", finalOutput, data.channel || "async_rest");

      return Response.json({
        status: "completed",
        success: true,
        output: finalOutput,
        session_id: finalSessionId,
        trace_id: finalTraceId,
        turns: finalTurns,
        tool_calls: finalToolCalls,
        cost_usd: finalCostUsd,
        latency_ms: finalLatencyMs,
      });
    }
    return new Response("Not found", { status: 404 });
  }

  // ── Telemetry ────────────────────────────────────────────────────
  // Events are written to DO-local SQLite for real-time queries,
  // and queued to TELEMETRY_QUEUE → Supabase for durable storage.
  // No backend HTTP calls — Supabase is the single source of truth.

  private _recordEvent(input: {
    sessionId: string;
    turn?: number;
    eventType: string;
    action?: string;
    plan?: string;
    tier?: string;
    provider?: string;
    model?: string;
    toolName?: string;
    status?: string;
    latencyMs?: number;
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
    details?: Record<string, unknown>;
  }): void {
    const turn = input.turn ?? 0;
    const action = input.action || "";
    const plan = input.plan || "";
    const tier = input.tier || "";
    const provider = input.provider || "";
    const model = input.model || "";
    const toolName = input.toolName || "";
    const status = input.status || "";
    const latencyMs = input.latencyMs || 0;
    const inputTokens = input.inputTokens || 0;
    const outputTokens = input.outputTokens || 0;
    const costUsd = input.costUsd || 0;
    const detailsJson = JSON.stringify(input.details || {});

    // 1. DO-local SQLite (instant, queryable via RPC)
    this.sql`INSERT INTO otel_events (
      session_id, turn, event_type, action, plan, tier, provider, model, tool_name, status, latency_ms,
      input_tokens, output_tokens, cost_usd, details_json
    ) VALUES (
      ${input.sessionId}, ${turn}, ${input.eventType}, ${action}, ${plan}, ${tier}, ${provider}, ${model}, ${toolName}, ${status}, ${latencyMs},
      ${inputTokens}, ${outputTokens}, ${costUsd}, ${detailsJson}
    )`;

    // 2. Queue → Supabase (durable, async, non-blocking)
    if (this.env.TELEMETRY_QUEUE) {
      this.env.TELEMETRY_QUEUE.send({
        type: "event",
        payload: {
          session_id: input.sessionId, turn, event_type: input.eventType,
          action, plan, tier, provider, model, tool_name: toolName,
          status, latency_ms: latencyMs, input_tokens: inputTokens,
          output_tokens: outputTokens, cost_usd: costUsd,
          details_json: detailsJson, created_at: Date.now() / 1000,
        },
      }).catch(() => {});
    }
  }
}

// Backward-compatibility export for previously deployed Durable Object class name.
// Some existing Cloudflare deployments reference AgentOSWorker in prior migrations.
export class AgentOSWorker extends AgentOSAgent {}

function base64UrlToBytes(input: string): Uint8Array {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function verifyHs256Jwt(token: string, secret: string): Promise<boolean> {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [headerB64, payloadB64, signatureB64] = parts;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const rawSig = base64UrlToBytes(signatureB64);
    const signature = new Uint8Array(rawSig);
    const valid = await crypto.subtle.verify("HMAC", key, signature, signingInput);
    if (!valid) return false;
    const payloadRaw = new TextDecoder().decode(base64UrlToBytes(payloadB64));
    const payload = JSON.parse(payloadRaw) as { exp?: number };
    if (payload.exp && Date.now() / 1000 > payload.exp) return false;
    return true;
  } catch {
    return false;
  }
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const arr = Array.from(new Uint8Array(digest));
  return arr.map((b) => b.toString(16).padStart(2, "0")).join("");
}

function extractBearerToken(request: Request): string {
  const auth = request.headers.get("Authorization") || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7).trim();
  const url = new URL(request.url);
  const q = url.searchParams.get("token") || url.searchParams.get("api_key") || "";
  return q.trim();
}

async function authorizeAgentIngress(request: Request, env: Env): Promise<Response | null> {
  const token = extractBearerToken(request);
  const serviceToken = String(env.SERVICE_TOKEN || "").trim();
  const jwtSecret = String(env.AUTH_JWT_SECRET || "").trim();

  if (!serviceToken && !jwtSecret) return null;
  if (!token) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (serviceToken && token === serviceToken) return null;
  if (jwtSecret && (await verifyHs256Jwt(token, jwtSecret))) return null;
  return Response.json({ error: "unauthorized" }, { status: 401 });
}

// ---------------------------------------------------------------------------
// MCP Server Agent — exposes tools via Model Context Protocol
// ---------------------------------------------------------------------------

export class AgentOSMcpServer extends Agent<Env> {
  async onStart() {
    // MCP tools are registered here
  }

  async onRequest(request: Request): Promise<Response> {
    // MCP JSON-RPC handler
    if (request.method === "POST") {
      const body = await request.json() as any;
      const method = body.method;

      if (method === "initialize") {
        return Response.json({
          jsonrpc: "2.0", id: body.id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "agentos-mcp", version: "0.2.0" },
          },
        });
      }

      if (method === "tools/list") {
        return Response.json({
          jsonrpc: "2.0", id: body.id,
          result: {
            tools: [
              {
                name: "run-agent",
                description: "Run an AgentOS agent on a task",
                inputSchema: {
                  type: "object",
                  properties: {
                    agent_name: { type: "string", description: "Agent name" },
                    task: { type: "string", description: "Task to execute" },
                  },
                  required: ["task"],
                },
              },
              {
                name: "search-knowledge",
                description: "Search the agent's knowledge base",
                inputSchema: {
                  type: "object",
                  properties: {
                    query: { type: "string", description: "Search query" },
                  },
                  required: ["query"],
                },
              },
            ],
          },
        });
      }

      if (method === "tools/call") {
        const toolName = body.params?.name;
        const args = body.params?.arguments || {};

        if (toolName === "run-agent") {
          // Delegate to the main agent
          const agentId = this.env.AGENTOS_AGENT.idFromName(args.agent_name || "default");
          const agent = this.env.AGENTOS_AGENT.get(agentId);
          const resp = await agent.fetch(new Request("http://internal/run", {
            method: "POST",
            body: JSON.stringify({ input: args.task }),
          }));
          const result = await resp.json();
          return Response.json({
            jsonrpc: "2.0", id: body.id,
            result: { content: [{ type: "text", text: JSON.stringify(result) }] },
          });
        }

        if (toolName === "search-knowledge") {
          const query = String(args.query || "");
          if (!query.trim()) {
            return Response.json({
              jsonrpc: "2.0", id: body.id,
              result: { content: [{ type: "text", text: "query is required" }], isError: true },
            });
          }
          try {
            const agentId = this.env.AGENTOS_AGENT.idFromName("default");
            const agent = this.env.AGENTOS_AGENT.get(agentId);
            const resp = await agent.fetch(new Request("http://internal/run", {
              method: "POST",
              body: JSON.stringify({ input: `Use knowledge search for: ${query}` }),
            }));
            const result = await resp.json();
            return Response.json({
              jsonrpc: "2.0", id: body.id,
              result: { content: [{ type: "text", text: JSON.stringify(result) }] },
            });
          } catch (err: any) {
            return Response.json({
              jsonrpc: "2.0", id: body.id,
              result: {
                content: [{ type: "text", text: `search-knowledge failed: ${err?.message || err}` }],
                isError: true,
              },
            });
          }
        }

        return Response.json({
          jsonrpc: "2.0", id: body.id,
          result: { content: [{ type: "text", text: `Unknown tool: ${toolName}` }] },
        });
      }

      return Response.json({
        jsonrpc: "2.0", id: body.id,
        error: { code: -32601, message: `Method not found: ${method}` },
      });
    }

    return new Response("MCP Server — POST JSON-RPC requests here", { status: 200 });
  }
}

// ---------------------------------------------------------------------------
// Worker entry point — routes to agents
// ---------------------------------------------------------------------------

function detectLang(code: string): "javascript" | "python" | "bash" {
  const py = [/\b(def |class |import |from |print\()/m, /\b(lambda |yield )\b/].filter(r => r.test(code)).length;
  const js = [/\b(const|let|var|function|=>)\b/, /\bconsole\.\b/].filter(r => r.test(code)).length;
  if (py > js) return "python";
  if (js > 0) return "javascript";
  return "bash";
}

/**
 * Run an agent through its DO — the single authoritative execution path.
 * All ingress (REST, WebSocket, Telegram) should use this.
 * The DO handles: conversation persistence, streaming, tool execution, billing.
 *
 * DO instance naming: {agent_name}-{user_id}
 *   - Each user gets their own DO instance → isolated conversation
 *   - Same user across channels shares the same DO → conversation continuity
 *   - If no user_id, falls back to agent_name only (shared instance)
 */
async function runViaAgent(
  env: { AGENTOS_AGENT: any; SERVICE_TOKEN?: string },
  agentName: string,
  task: string,
  opts?: { org_id?: string; project_id?: string; channel?: string; channel_user_id?: string },
): Promise<{ output: string; success: boolean; error?: string; turns: number; tool_calls: number; cost_usd: number; latency_ms: number; session_id: string; trace_id: string; stop_reason: string; [key: string]: unknown }> {
  // Per-user DO isolation: each user gets their own conversation thread
  const userId = opts?.channel_user_id || "";
  const doName = userId ? `${agentName}-u-${userId}` : agentName;
  const agentId = env.AGENTOS_AGENT.idFromName(doName);
  const agent = env.AGENTOS_AGENT.get(agentId);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (env.SERVICE_TOKEN) headers.Authorization = `Bearer ${env.SERVICE_TOKEN}`;
  const resp = await agent.fetch(new Request("http://internal/run", {
    method: "POST",
    headers,
    body: JSON.stringify({
      input: task,
      agent_name: agentName,
      org_id: opts?.org_id || "",
      project_id: opts?.project_id || "",
      channel: opts?.channel || "api",
      channel_user_id: opts?.channel_user_id || "",
    }),
  }));
  return resp.json() as any;
}

function runnableInputToTask(input: unknown, task?: string): string {
  if (typeof task === "string" && task.trim().length > 0) return task;
  if (typeof input === "string") return input;
  if (input == null) return "";
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

function extractRunnableConfig(config?: Record<string, unknown>): {
  run_name: string;
  tags: string[];
  metadata: Record<string, unknown>;
  input_raw?: unknown;
} {
  const runName = typeof config?.run_name === "string"
    ? config.run_name
    : (typeof config?.runName === "string" ? config.runName : "");
  const tagsRaw = Array.isArray(config?.tags) ? config?.tags : [];
  const tags = tagsRaw.map((t) => String(t)).filter((t) => t.length > 0);
  const metadata = (config?.metadata && typeof config.metadata === "object" && !Array.isArray(config.metadata))
    ? (config.metadata as Record<string, unknown>)
    : {};
  const inputRaw = config?.input_raw;
  return { run_name: runName, tags, metadata, input_raw: inputRaw };
}

function extractRunnableMetadataFromEvents(
  runtimeEvents: Array<{ event_type?: string; session_id?: string; trace_id?: string; data?: Record<string, unknown> }>,
): {
  run_id: string;
  session_id: string;
  trace_id: string;
  run_name: string;
  tags: string[];
  metadata: Record<string, unknown>;
  input_raw: unknown;
} {
  let sessionId = "";
  let traceId = "";
  let runName = "";
  let tags: string[] = [];
  let metadata: Record<string, unknown> = {};
  let inputRaw: unknown = "";
  for (const row of runtimeEvents) {
    sessionId = sessionId || String(row.session_id || "");
    traceId = traceId || String(row.trace_id || "");
    const data = (row.data && typeof row.data === "object") ? row.data : {};
    if (String(row.event_type || "") === "session_start") {
      runName = String(data.run_name || runName);
      tags = Array.isArray(data.tags) ? data.tags.map((t) => String(t)).filter((t) => t.length > 0) : tags;
      metadata = (data.metadata && typeof data.metadata === "object" && !Array.isArray(data.metadata))
        ? (data.metadata as Record<string, unknown>)
        : metadata;
      inputRaw = data.input_raw ?? inputRaw;
      break;
    }
  }
  return {
    run_id: traceId || sessionId,
    session_id: sessionId,
    trace_id: traceId,
    run_name: runName,
    tags,
    metadata,
    input_raw: inputRaw,
  };
}

function buildRunnableMetadata(input: {
  success?: boolean;
  turns?: number;
  tool_calls?: number;
  cost_usd?: number;
  latency_ms?: number;
  session_id?: string;
  trace_id?: string;
  run_id?: string;
  stop_reason?: string;
  checkpoint_id?: string;
  parent_session_id?: string;
  resumed_from_checkpoint?: string;
  run_name?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  input_raw?: unknown;
}): Record<string, unknown> {
  const sessionId = String(input.session_id || "");
  const traceId = String(input.trace_id || "");
  return {
    success: Boolean(input.success),
    turns: Number(input.turns || 0),
    tool_calls: Number(input.tool_calls || 0),
    cost_usd: Number(input.cost_usd || 0),
    latency_ms: Number(input.latency_ms || 0),
    session_id: sessionId,
    trace_id: traceId,
    run_id: String(input.run_id || traceId || sessionId),
    stop_reason: String(input.stop_reason || ""),
    checkpoint_id: String(input.checkpoint_id || ""),
    parent_session_id: String(input.parent_session_id || ""),
    resumed_from_checkpoint: String(input.resumed_from_checkpoint || ""),
    run_name: String(input.run_name || ""),
    tags: Array.isArray(input.tags) ? input.tags : [],
    metadata: (input.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata))
      ? input.metadata
      : {},
    input_raw: input.input_raw ?? "",
  };
}

function gradeEvalOutput(
  output: string,
  expected: string,
  grader: string,
): { score: number; passed: boolean } {
  const actual = String(output || "");
  const target = String(expected || "");
  const mode = String(grader || "contains").trim().toLowerCase();
  if (!target) return { score: 1, passed: true };
  if (mode === "exact") {
    const passed = actual.trim() === target.trim();
    return { score: passed ? 1 : 0, passed };
  }
  const passed = actual.toLowerCase().includes(target.toLowerCase());
  return { score: passed ? 1 : 0, passed };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === "/health") {
      return Response.json({ status: "ok", version: "0.2.0" });
    }

    // ── Usage / Billing API ──────────────────────────────────────
    // GET /api/v1/usage?org_id=X&agent_name=Y&cursor=Z&limit=N&from=T&to=T
    // Returns: summary (totals) + cursor-paginated session list with costs
    if (url.pathname === "/api/v1/usage" && request.method === "GET") {
      const serviceToken = env.SERVICE_TOKEN || "";
      if (serviceToken) {
        const authHeader = request.headers.get("Authorization") || "";
        const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
        if (token !== serviceToken) {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }
      }

      try {
        const { queryUsage } = await import("./runtime/db");
        const result = await queryUsage(env.HYPERDRIVE, {
          org_id: url.searchParams.get("org_id") || "default",
          agent_name: url.searchParams.get("agent_name") || undefined,
          cursor: url.searchParams.get("cursor") || undefined,
          limit: Number(url.searchParams.get("limit")) || 20,
          from_ts: Number(url.searchParams.get("from")) || 0,
          to_ts: Number(url.searchParams.get("to")) || undefined,
        });
        return Response.json(result);
      } catch (err: any) {
        return Response.json({ error: err.message }, { status: 500 });
      }
    }

    // ── Edge-native eval run (persists eval_runs + eval_trials) ──────────
    if (url.pathname === "/api/v1/eval/run" && request.method === "POST") {
      const serviceToken = env.SERVICE_TOKEN || "";
      if (serviceToken) {
        const authHeader = request.headers.get("Authorization") || "";
        const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
        if (token !== serviceToken) {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }
      }
      // Contract: JSON body with `tasks` (required). Optional query overrides for
      // `agent_name` and `trials` so control-plane can mirror the portal query contract
      // on direct worker calls, while normal path is a single JSON payload from the proxy.
      type EvalRunBody = {
        agent_name?: string;
        eval_name?: string;
        trials?: number;
        tasks?: Array<{
          name?: string;
          input?: string;
          expected?: string;
          grader?: string;
        }>;
        org_id?: string;
        project_id?: string;
        channel?: string;
        channel_user_id?: string;
      };
      let body: EvalRunBody = {};
      const rawBody = await request.text();
      if (rawBody.trim()) {
        try {
          const parsed: unknown = JSON.parse(rawBody);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return Response.json({ error: "JSON body must be an object" }, { status: 400 });
          }
          body = parsed as EvalRunBody;
        } catch {
          return Response.json({ error: "invalid JSON body" }, { status: 400 });
        }
      }
      const qpAgent = String(url.searchParams.get("agent_name") || "").trim();
      const qpTrialsRaw = url.searchParams.get("trials");
      const qpTrials =
        qpTrialsRaw !== null && qpTrialsRaw !== "" ? Number(qpTrialsRaw) : undefined;
      const mergedTrials =
        body.trials !== undefined && body.trials !== null && !Number.isNaN(Number(body.trials))
          ? Number(body.trials)
          : qpTrials !== undefined && !Number.isNaN(qpTrials)
            ? qpTrials
            : 1;
      const tasks = Array.isArray(body.tasks) ? body.tasks : [];
      const trials = Math.max(1, Math.min(mergedTrials || 1, 20));
      if (tasks.length === 0) {
        return Response.json({ error: "tasks are required" }, { status: 400 });
      }
      const runtimeEnv: RuntimeEnv = {
        AI: env.AI, HYPERDRIVE: env.HYPERDRIVE, VECTORIZE: env.VECTORIZE,
        STORAGE: env.STORAGE, SANDBOX: env.SANDBOX, LOADER: env.LOADER,
        TELEMETRY_QUEUE: env.TELEMETRY_QUEUE, BROWSER: env.BROWSER,
        AI_GATEWAY_ID: env.AI_GATEWAY_ID,
        AI_GATEWAY_TOKEN: env.AI_GATEWAY_TOKEN,
        BRAVE_SEARCH_KEY: env.BRAVE_SEARCH_KEY,
        CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID,
        CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN,
        DEFAULT_PROVIDER: env.DEFAULT_PROVIDER, DEFAULT_MODEL: env.DEFAULT_MODEL,
      };

      try {
        const agentName = String(body.agent_name || qpAgent || "").trim() || "agentos";
        const evalName = body.eval_name || `edge_eval_${Date.now()}`;
        const startedAt = Date.now();
        const trialRows: Array<{
          task_name: string;
          trial_number: number;
          score: number;
          passed: boolean;
          latency_ms: number;
          cost_usd: number;
          tool_calls: number;
          error: string;
          stop_reason: string;
          session_id: string;
          trace_id: string;
          metadata: Record<string, unknown>;
        }> = [];

        let passCount = 0;
        let errorCount = 0;
        let totalScore = 0;
        let totalLatency = 0;
        let totalCost = 0;

        for (const task of tasks) {
          const taskName = String(task?.name || "");
          const expected = String(task?.expected || "");
          const grader = String(task?.grader || "contains");
          const input = String(task?.input || "");
          for (let trial = 1; trial <= trials; trial++) {
            // Eval needs blocking await to grade each trial.
            // TODO: Move eval runner into a dedicated DO for no-timeout execution.
            const runResult = await runViaAgent(env, agentName, input, {
              org_id: body.org_id,
              project_id: body.project_id,
              channel: body.channel,
              channel_user_id: body.channel_user_id,
            });
            const grade = gradeEvalOutput(runResult.output, expected, grader);
            if (grade.passed) passCount += 1;
            if (!runResult.success || runResult.error) errorCount += 1;
            totalScore += grade.score;
            totalLatency += Number(runResult.latency_ms || 0);
            totalCost += Number(runResult.cost_usd || 0);
            trialRows.push({
              task_name: taskName,
              trial_number: trial,
              score: grade.score,
              passed: grade.passed,
              latency_ms: Number(runResult.latency_ms || 0),
              cost_usd: Number(runResult.cost_usd || 0),
              tool_calls: Number(runResult.tool_calls || 0),
              error: String(runResult.error || ""),
              stop_reason: String(runResult.stop_reason || ""),
              session_id: String(runResult.session_id || ""),
              trace_id: String(runResult.trace_id || ""),
              metadata: {
                expected,
                grader,
                output: runResult.output,
                run_id: runResult.run_id || runResult.trace_id || runResult.session_id,
              },
            });
          }
        }

        const totalTrials = trialRows.length;
        const failCount = Math.max(0, totalTrials - passCount);
        const passRate = totalTrials > 0 ? passCount / totalTrials : 0;
        const avgScore = totalTrials > 0 ? totalScore / totalTrials : 0;
        const avgLatency = totalTrials > 0 ? totalLatency / totalTrials : 0;
        const evalRunId = await writeEvalRun(env.HYPERDRIVE, {
          agent_name: agentName,
          eval_name: evalName,
          total_tasks: tasks.length,
          total_trials: totalTrials,
          pass_count: passCount,
          fail_count: failCount,
          error_count: errorCount,
          pass_rate: passRate,
          avg_score: avgScore,
          avg_latency_ms: avgLatency,
          total_cost_usd: totalCost,
          eval_conditions_json: JSON.stringify({
            source: "edge_eval_api",
            trials_per_task: trials,
            created_at_ms: Date.now(),
          }),
        });
        for (const row of trialRows) {
          await writeEvalTrial(env.HYPERDRIVE, {
            eval_run_id: evalRunId,
            eval_name: evalName,
            agent_name: agentName,
            trial_index: row.trial_number,
            passed: row.passed,
            score: row.score,
            details_json: JSON.stringify({
              task_name: row.task_name,
              trial_number: row.trial_number,
              latency_ms: row.latency_ms,
              cost_usd: row.cost_usd,
              tool_calls: row.tool_calls,
              error: row.error,
              stop_reason: row.stop_reason,
              ...row.metadata,
            }),
            trace_id: row.trace_id,
            session_id: row.session_id,
          });
        }

        return Response.json({
          run_id: evalRunId,
          eval_name: evalName,
          pass_rate: passRate,
          avg_score: avgScore,
          avg_latency_ms: avgLatency,
          total_cost_usd: totalCost,
          total_tasks: tasks.length,
          total_trials: totalTrials,
          pass_count: passCount,
          fail_count: failCount,
          error_count: errorCount,
          latency_ms: Date.now() - startedAt,
        });
      } catch (err: any) {
        return Response.json({ error: err.message || String(err) }, { status: 500 });
      }
    }

    // ── Edge-native eval read APIs (backend parity) ───────────────────────
    if (url.pathname === "/api/v1/eval/runs" && request.method === "GET") {
      const serviceToken = env.SERVICE_TOKEN || "";
      if (serviceToken) {
        const authHeader = request.headers.get("Authorization") || "";
        const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
        if (token !== serviceToken) {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }
      }
      try {
        const agentName = String(url.searchParams.get("agent_name") || "").trim();
        const limit = Number(url.searchParams.get("limit") || 20);
        const runs = await listEvalRuns(env.HYPERDRIVE, { agent_name: agentName, limit });
        return Response.json(runs);
      } catch (err: any) {
        return Response.json({ error: err.message || String(err) }, { status: 500 });
      }
    }
    const evalRunMatch = url.pathname.match(/^\/api\/v1\/eval\/runs\/(\d+)$/);
    if (evalRunMatch && request.method === "GET") {
      const serviceToken = env.SERVICE_TOKEN || "";
      if (serviceToken) {
        const authHeader = request.headers.get("Authorization") || "";
        const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
        if (token !== serviceToken) {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }
      }
      try {
        const runId = Number(evalRunMatch[1] || 0);
        const run = await getEvalRun(env.HYPERDRIVE, runId);
        if (!run) return Response.json({ error: "Eval run not found" }, { status: 404 });
        const trials = await listEvalTrialsByRun(env.HYPERDRIVE, runId);
        return Response.json({ ...run, trials });
      } catch (err: any) {
        return Response.json({ error: err.message || String(err) }, { status: 500 });
      }
    }
    const evalTrialsMatch = url.pathname.match(/^\/api\/v1\/eval\/runs\/(\d+)\/trials$/);
    if (evalTrialsMatch && request.method === "GET") {
      const serviceToken = env.SERVICE_TOKEN || "";
      if (serviceToken) {
        const authHeader = request.headers.get("Authorization") || "";
        const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
        if (token !== serviceToken) {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }
      }
      try {
        const runId = Number(evalTrialsMatch[1] || 0);
        const run = await getEvalRun(env.HYPERDRIVE, runId);
        if (!run) return Response.json({ error: "Eval run not found" }, { status: 404 });
        const trials = await listEvalTrialsByRun(env.HYPERDRIVE, runId);
        return Response.json({ run_id: runId, trials });
      } catch (err: any) {
        return Response.json({ error: err.message || String(err) }, { status: 500 });
      }
    }

    // ── Edge Runtime API — runtime contract endpoints ─────────
    // These replace the backend runtime-proxy for edge-native execution.
    // POST /api/v1/runtime-proxy/runnable/invoke
    // POST /api/v1/runtime-proxy/runnable/stream-events
    // POST /api/v1/runtime-proxy/runnable/replay
    // POST /api/v1/runtime-proxy/agent/run (edge-native)

    // ── REST invoke — always async, always through DO ──
    // Agent execution happens in the DO (no timeout, conversation persistence).
    // REST is just a kick-start — returns 202 immediately.
    // For results: connect WebSocket or poll GET /api/v1/runs/{run_id}.
    if (url.pathname === "/api/v1/runtime-proxy/runnable/invoke" && request.method === "POST") {
      const serviceToken = env.SERVICE_TOKEN || "";
      if (serviceToken) {
        const authHeader = request.headers.get("Authorization") || "";
        const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
        if (token !== serviceToken) {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }
      }

      const body = await request.json() as {
        agent_name?: string; task?: string; input?: unknown;
        org_id?: string; project_id?: string; channel?: string; channel_user_id?: string;
      };

      const agentName = body.agent_name || "agentos";
      const task = runnableInputToTask(body.input, body.task);
      const userId = body.channel_user_id || "";

      // Start run in DO (non-blocking)
      ctx.waitUntil(
        runViaAgent(env, agentName, task, {
          org_id: body.org_id,
          project_id: body.project_id,
          channel: body.channel,
          channel_user_id: userId,
        }).catch(() => {}),
      );

      // DO name for WebSocket connection
      const doName = userId ? `${agentName}-u-${userId}` : agentName;

      return Response.json({
        status: "running",
        agent_name: agentName,
        websocket_url: `/agents/agentos-agent/${doName}`,
        message: "Run started. Connect via WebSocket for streaming, or poll GET /api/v1/runs/{run_id}.",
      }, { status: 202 });
    }

    if (url.pathname === "/api/v1/runtime-proxy/runnable/stream-events" && request.method === "POST") {
      const serviceToken = env.SERVICE_TOKEN || "";
      if (serviceToken) {
        const authHeader = request.headers.get("Authorization") || "";
        const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
        if (token !== serviceToken) {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }
      }

      const body = await request.json() as {
        agent_name?: string; task?: string; input?: unknown;
        org_id?: string; project_id?: string; channel?: string; channel_user_id?: string;
        session_id?: string; trace_id?: string; limit?: number; cursor?: string; watermark_cursor?: string;
        event_type?: string; tool_name?: string; status?: string; from_ts_ms?: number; to_ts_ms?: number;
        config?: Record<string, unknown>;
      };
      const runtimeCfg = extractRunnableConfig(body.config);

      try {
        let replayEvents: any[] = [];
        let doneData: Record<string, unknown> = {
          replay: true,
          has_more: false,
          next_cursor: String(body.cursor || "0"),
          watermark_cursor: String(body.watermark_cursor || body.cursor || "0"),
        };

        const hasReplaySelector = Boolean(body.session_id || body.trace_id);
        if (hasReplaySelector) {
          const page = await loadRuntimeEventsPage(env.HYPERDRIVE, {
            session_id: body.session_id,
            trace_id: body.trace_id,
            limit: body.limit,
            cursor: body.cursor,
            watermark_cursor: body.watermark_cursor,
            event_type: body.event_type,
            tool_name: body.tool_name,
            status: body.status,
            from_ts_ms: body.from_ts_ms,
            to_ts_ms: body.to_ts_ms,
          });
          replayEvents = page.events;
          doneData = {
            ...doneData,
            session_id: body.session_id || "",
            trace_id: body.trace_id || "",
            event_count: replayEvents.length,
            has_more: page.has_more,
            next_cursor: page.next_cursor,
            watermark_cursor: page.watermark_cursor,
          };
        } else {
          // No session_id — start run via DO (async), return WebSocket URL
          const agentName = body.agent_name || "agentos";
          const userId = body.channel_user_id || "";
          const doName = userId ? `${agentName}-u-${userId}` : agentName;
          ctx.waitUntil(
            runViaAgent(env, agentName, runnableInputToTask(body.input, body.task), {
              org_id: body.org_id,
              project_id: body.project_id,
              channel: body.channel,
              channel_user_id: userId,
            }).catch(() => {}),
          );
          return Response.json({
            status: "running",
            message: "Run started. Connect WebSocket for live events, or query /stream-events with session_id after completion.",
            websocket_url: `/agents/agentos-agent/${doName}`,
          }, { status: 202 });
        }

        // Return replayed events as SSE-style newline-delimited JSON
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          start(controller) {
            for (const event of replayEvents) {
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
              );
            }
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ event_type: "done", data: doneData })}\n\n`),
            );
            controller.close();
          },
        });

        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        });
      } catch (err: any) {
        return Response.json({ error: err.message }, { status: 500 });
      }
    }

    // ── JSON events replay (cursor/watermark paging) ──────────
    if (url.pathname === "/api/v1/runtime-proxy/runnable/events" && request.method === "POST") {
      const serviceToken = env.SERVICE_TOKEN || "";
      if (serviceToken) {
        const authHeader = request.headers.get("Authorization") || "";
        const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
        if (token !== serviceToken) {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }
      }
      const body = await request.json() as {
        session_id?: string;
        trace_id?: string;
        limit?: number;
        cursor?: string;
        watermark_cursor?: string;
        event_type?: string;
        tool_name?: string;
        status?: string;
        from_ts_ms?: number;
        to_ts_ms?: number;
      };
      try {
        const page = await loadRuntimeEventsPage(env.HYPERDRIVE, {
          session_id: body.session_id,
          trace_id: body.trace_id,
          limit: body.limit,
          cursor: body.cursor,
          watermark_cursor: body.watermark_cursor,
          event_type: body.event_type,
          tool_name: body.tool_name,
          status: body.status,
          from_ts_ms: body.from_ts_ms,
          to_ts_ms: body.to_ts_ms,
        });
        return Response.json({
          ...page,
          metadata: buildRunnableMetadata(extractRunnableMetadataFromEvents(page.events)),
        });
      } catch (err: any) {
        return Response.json({ error: err.message }, { status: 500 });
      }
    }

    // ── Time-travel replay at cursor (otel_events) ─────────────
    if (url.pathname === "/api/v1/runtime-proxy/runnable/replay" && request.method === "POST") {
      const serviceToken = env.SERVICE_TOKEN || "";
      if (serviceToken) {
        const authHeader = request.headers.get("Authorization") || "";
        const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
        if (token !== serviceToken) {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }
      }
      const body = await request.json() as {
        session_id?: string;
        trace_id?: string;
        up_to_id?: number;
        cursor_index?: number;
        event_id?: string;
        include_events?: boolean;
        max_scan?: number;
      };
      try {
        const replay = await replayOtelEventsAtCursor(env.HYPERDRIVE, {
          session_id: body.session_id,
          trace_id: body.trace_id,
          up_to_row_id: body.up_to_id,
          cursor_index: body.cursor_index,
          event_id: body.event_id,
          include_events: body.include_events,
          max_scan: body.max_scan,
        });
        return Response.json({
          ...replay,
          metadata: buildRunnableMetadata(extractRunnableMetadataFromEvents(
            replay.event_at_cursor ? [replay.event_at_cursor] : [],
          )),
        });
      } catch (err: any) {
        return Response.json({ error: err.message }, { status: 500 });
      }
    }

    // ── LangSmith-style run tree (JSON) ───────────────────────
    if (url.pathname === "/api/v1/runtime-proxy/runnable/runs/tree" && request.method === "POST") {
      const serviceToken = env.SERVICE_TOKEN || "";
      if (serviceToken) {
        const authHeader = request.headers.get("Authorization") || "";
        const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
        if (token !== serviceToken) {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }
      }
      const body = await request.json() as {
        trace_id?: string;
        session_id?: string;
        limit?: number;
        event_type?: string;
        tool_name?: string;
        status?: string;
        from_ts_ms?: number;
        to_ts_ms?: number;
      };
      try {
        const tree = await buildRuntimeRunTree(env.HYPERDRIVE, {
          trace_id: body.trace_id,
          session_id: body.session_id,
          limit: body.limit,
          event_type: body.event_type,
          tool_name: body.tool_name,
          status: body.status,
          from_ts_ms: body.from_ts_ms,
          to_ts_ms: body.to_ts_ms,
        });
        return Response.json({
          ...tree,
          metadata: buildRunnableMetadata(
            extractRunnableMetadataFromEvents(Array.isArray(tree.runtime_events) ? tree.runtime_events : []),
          ),
        });
      } catch (err: any) {
        return Response.json({ error: err.message }, { status: 500 });
      }
    }

    // POST /api/v1/graphs/linear-run — declarative linear graph (control-plane validated → edge execute)
    if (url.pathname === "/api/v1/graphs/linear-run" && request.method === "POST") {
      const serviceToken = env.SERVICE_TOKEN || "";
      if (serviceToken) {
        const authHeader = request.headers.get("Authorization") || "";
        const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
        if (token !== serviceToken) {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }
      }

      const body = await request.json() as {
        graph?: unknown;
        task?: string;
        agent_context?: {
          agent_name?: string;
          org_id?: string;
          project_id?: string;
          channel?: string;
          channel_user_id?: string;
        };
        initial_state?: Record<string, unknown>;
        validation?: { linear_path?: string[]; graph_id?: string };
      };

      const task = typeof body.task === "string" ? body.task : "";
      if (!task.trim()) {
        return Response.json({ error: "task is required", error_code: "MISSING_TASK" }, { status: 400 });
      }
      const ctx = body.agent_context;
      if (!ctx || typeof ctx.agent_name !== "string" || !ctx.agent_name.trim()) {
        return Response.json(
          { error: "agent_context.agent_name is required", error_code: "MISSING_AGENT" },
          { status: 400 },
        );
      }
      if (!body.graph || typeof body.graph !== "object") {
        return Response.json({ error: "graph is required", error_code: "MISSING_GRAPH" }, { status: 400 });
      }

      try {
        const result = executeLinearDeclarativeRun({
          graph: body.graph as GraphSpec,
          task: task.trim(),
          agent_context: {
            agent_name: ctx.agent_name.trim(),
            org_id: ctx.org_id,
            project_id: ctx.project_id,
            channel: ctx.channel,
            channel_user_id: ctx.channel_user_id,
          },
          initial_state: body.initial_state,
          validation: body.validation,
        });
        if (!result.success) {
          const status =
            result.error_code === "VALIDATION_MISMATCH"
              ? 409
              : result.error_code === "MISSING_NODE_KIND"
                ? 422
                : 400;
          return Response.json(
            {
              success: false,
              error: result.error,
              error_code: result.error_code,
              linear_path: result.linear_path,
              linear_trace: result.linear_trace,
            },
            { status },
          );
        }
        const traceDigestSha256 = await sha256Hex(JSON.stringify(result.linear_trace));
        return Response.json({
          success: true,
          linear_path: result.linear_path,
          linear_trace: result.linear_trace,
          trace_digest_sha256: traceDigestSha256,
          state: result.state,
          task: task.trim(),
          agent_context: {
            agent_name: ctx.agent_name.trim(),
            org_id: ctx.org_id ?? "",
            project_id: ctx.project_id ?? "",
            channel: ctx.channel ?? "",
            channel_user_id: ctx.channel_user_id ?? "",
          },
        });
      } catch (err: any) {
        return Response.json(
          { success: false, error: err.message || String(err), error_code: "INTERNAL" },
          { status: 500 },
        );
      }
    }

    // POST /api/v1/graphs/dag-run — declarative bounded DAG graph (deterministic topo execution)
    if (url.pathname === "/api/v1/graphs/dag-run" && request.method === "POST") {
      const serviceToken = env.SERVICE_TOKEN || "";
      if (serviceToken) {
        const authHeader = request.headers.get("Authorization") || "";
        const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
        if (token !== serviceToken) {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }
      }

      const body = await request.json() as {
        graph?: unknown;
        task?: string;
        agent_context?: {
          agent_name?: string;
          org_id?: string;
          project_id?: string;
          channel?: string;
          channel_user_id?: string;
        };
        initial_state?: Record<string, unknown>;
        max_branching?: number;
        max_fanin?: number;
        validation?: { execution_order?: string[]; graph_id?: string };
      };

      const task = typeof body.task === "string" ? body.task : "";
      if (!task.trim()) {
        return Response.json({ error: "task is required", error_code: "MISSING_TASK" }, { status: 400 });
      }
      const ctx = body.agent_context;
      if (!ctx || typeof ctx.agent_name !== "string" || !ctx.agent_name.trim()) {
        return Response.json(
          { error: "agent_context.agent_name is required", error_code: "MISSING_AGENT" },
          { status: 400 },
        );
      }
      if (!body.graph || typeof body.graph !== "object") {
        return Response.json({ error: "graph is required", error_code: "MISSING_GRAPH" }, { status: 400 });
      }

      try {
        const result = executeBoundedDagDeclarativeRun({
          graph: body.graph as GraphSpec,
          task: task.trim(),
          agent_context: {
            agent_name: ctx.agent_name.trim(),
            org_id: ctx.org_id,
            project_id: ctx.project_id,
            channel: ctx.channel,
            channel_user_id: ctx.channel_user_id,
          },
          initial_state: body.initial_state,
          max_branching: body.max_branching,
          max_fanin: body.max_fanin,
          validation: body.validation,
        });
        if (!result.success) {
          const status =
            result.error_code === "VALIDATION_MISMATCH"
              ? 409
              : result.error_code === "MISSING_NODE_KIND"
                ? 422
                : 400;
          return Response.json(
            {
              success: false,
              error: result.error,
              error_code: result.error_code,
              execution_order: result.execution_order,
              execution_trace: result.execution_trace,
            },
            { status },
          );
        }
        const traceDigestSha256 = await sha256Hex(JSON.stringify(result.execution_trace));
        return Response.json({
          success: true,
          execution_order: result.execution_order,
          execution_trace: result.execution_trace,
          trace_digest_sha256: traceDigestSha256,
          state: result.state,
          task: task.trim(),
          agent_context: {
            agent_name: ctx.agent_name.trim(),
            org_id: ctx.org_id ?? "",
            project_id: ctx.project_id ?? "",
            channel: ctx.channel ?? "",
            channel_user_id: ctx.channel_user_id ?? "",
          },
        });
      } catch (err: any) {
        return Response.json(
          { success: false, error: err.message || String(err), error_code: "INTERNAL" },
          { status: 500 },
        );
      }
    }

    // Edge-native agent/run — same contract as backend /runtime-proxy/agent/run
    // /agent/run redirects to the standard invoke endpoint (async, DO-based)
    if (url.pathname === "/api/v1/runtime-proxy/agent/run" && request.method === "POST") {
      const serviceToken = env.SERVICE_TOKEN || "";
      if (serviceToken) {
        const authHeader = request.headers.get("Authorization") || "";
        const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
        if (token !== serviceToken) {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }
      }

      const body = await request.json() as {
        agent_name?: string; task?: string;
        org_id?: string; project_id?: string; channel?: string; channel_user_id?: string;
      };

      const agentName = body.agent_name || "agentos";
      const userId = body.channel_user_id || "";
      const doName = userId ? `${agentName}-u-${userId}` : agentName;

      ctx.waitUntil(
        runViaAgent(env, agentName, body.task || "", {
          org_id: body.org_id,
          project_id: body.project_id,
          channel: body.channel,
          channel_user_id: userId,
        }).catch(() => {}),
      );

      return Response.json({
        status: "running",
        agent_name: agentName,
        websocket_url: `/agents/agentos-agent/${doName}`,
      }, { status: 202 });
    }

    // ── Batch invoke ────────────────────────────────────────────
    if (url.pathname === "/api/v1/runtime-proxy/runnable/batch" && request.method === "POST") {
      const serviceToken = env.SERVICE_TOKEN || "";
      if (serviceToken) {
        const authHeader = request.headers.get("Authorization") || "";
        const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
        if (token !== serviceToken) {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }
      }

      const body = await request.json() as { inputs: Array<{
        agent_name?: string; task?: string; input?: unknown;
        org_id?: string; project_id?: string; channel?: string; channel_user_id?: string;
        config?: Record<string, unknown>;
      }> };

      const runtimeEnv: RuntimeEnv = {
        AI: env.AI, HYPERDRIVE: env.HYPERDRIVE, VECTORIZE: env.VECTORIZE,
        STORAGE: env.STORAGE, SANDBOX: env.SANDBOX, LOADER: env.LOADER,
        TELEMETRY_QUEUE: env.TELEMETRY_QUEUE, BROWSER: env.BROWSER,
        AI_GATEWAY_ID: env.AI_GATEWAY_ID,
        AI_GATEWAY_TOKEN: env.AI_GATEWAY_TOKEN,
        BRAVE_SEARCH_KEY: env.BRAVE_SEARCH_KEY,
        CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID,
        CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN,
        DEFAULT_PROVIDER: env.DEFAULT_PROVIDER, DEFAULT_MODEL: env.DEFAULT_MODEL,
      };

      try {
        const batchReq: BatchRequest = {
          inputs: (body.inputs || []).map((inp) => ({
            ...(() => {
              const cfg = extractRunnableConfig(inp.config);
              return {
                run_name: cfg.run_name,
                tags: cfg.tags,
                metadata: cfg.metadata,
                input_raw: cfg.input_raw ?? inp.input ?? inp.task ?? "",
              };
            })(),
            agent_name: inp.agent_name || "agentos",
            task: runnableInputToTask(inp.input, inp.task),
            org_id: inp.org_id,
            project_id: inp.project_id,
            channel: inp.channel,
            channel_user_id: inp.channel_user_id,
          })),
        };
        const result = await edgeBatch(runtimeEnv, env.HYPERDRIVE, batchReq, env.TELEMETRY_QUEUE);
        return Response.json({
          outputs: result.results.map((item) => ({
            ok: item.success,
            error: item.error || "",
            output: item.output,
            metadata: buildRunnableMetadata({
              success: item.success,
              turns: item.turns,
              tool_calls: item.tool_calls,
              cost_usd: item.cost_usd,
              latency_ms: item.latency_ms,
              session_id: item.session_id,
              trace_id: item.trace_id,
              run_id: item.run_id || item.trace_id || item.session_id,
              stop_reason: item.stop_reason,
              checkpoint_id: item.checkpoint_id || "",
              parent_session_id: item.parent_session_id || "",
              resumed_from_checkpoint: item.resumed_from_checkpoint || "",
            }),
          })),
          batch_metadata: {
            count: result.results.length,
            max_concurrency: 1,
            total_latency_ms: result.total_latency_ms,
          },
        });
      } catch (err: any) {
        return Response.json({ error: err.message }, { status: 500 });
      }
    }

    // ── Latency breakdown ─────────────────────────────────────
    // Latency breakdown — query from existing session events (no execution)
    // POST with session_id to analyze, or omit to run + analyze
    if (url.pathname === "/api/v1/runtime-proxy/runnable/latency-breakdown" && request.method === "POST") {
      const serviceToken = env.SERVICE_TOKEN || "";
      if (serviceToken) {
        const authHeader = request.headers.get("Authorization") || "";
        const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
        if (token !== serviceToken) {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }
      }

      const body = await request.json() as {
        session_id?: string;
        agent_name?: string; task?: string; input?: unknown;
        org_id?: string; project_id?: string; channel?: string; channel_user_id?: string;
      };

      // If session_id provided, compute breakdown from existing events
      if (body.session_id) {
        try {
          const events = await loadRuntimeEventsPage(env.HYPERDRIVE, {
            session_id: body.session_id, limit: 1000,
          });
          const breakdown = computeLatencyBreakdown(events.events);
          return Response.json({ session_id: body.session_id, latency_breakdown: breakdown });
        } catch (err: any) {
          return Response.json({ error: err.message }, { status: 500 });
        }
      }

      // No session_id — kick off a run and return WebSocket URL for results
      const agentName = body.agent_name || "agentos";
      const userId = body.channel_user_id || "";
      const doName = userId ? `${agentName}-u-${userId}` : agentName;

      ctx.waitUntil(
        runViaAgent(env, agentName, runnableInputToTask(body.input, body.task), {
          org_id: body.org_id,
          project_id: body.project_id,
          channel: body.channel,
          channel_user_id: userId,
        }).catch(() => {}),
      );

      return Response.json({
        status: "running",
        message: "Run started. After completion, call this endpoint again with the session_id to get the breakdown.",
        websocket_url: `/agents/agentos-agent/${doName}`,
      }, { status: 202 });
    }

    // ── Checkpoint resume ─────────────────────────────────────
    const checkpointResumeMatch = url.pathname.match(
      /^\/api\/v1\/runtime-proxy\/agent\/run\/checkpoints\/([a-zA-Z0-9]+)\/resume$/,
    );
    if (checkpointResumeMatch && request.method === "POST") {
      const checkpointId = checkpointResumeMatch[1];
      const serviceToken = env.SERVICE_TOKEN || "";
      if (serviceToken) {
        const authHeader = request.headers.get("Authorization") || "";
        const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
        if (token !== serviceToken) {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }
      }

      const runtimeEnv: RuntimeEnv = {
        AI: env.AI, HYPERDRIVE: env.HYPERDRIVE, VECTORIZE: env.VECTORIZE,
        STORAGE: env.STORAGE, SANDBOX: env.SANDBOX, LOADER: env.LOADER,
        TELEMETRY_QUEUE: env.TELEMETRY_QUEUE, BROWSER: env.BROWSER,
        AI_GATEWAY_ID: env.AI_GATEWAY_ID,
        AI_GATEWAY_TOKEN: env.AI_GATEWAY_TOKEN,
        BRAVE_SEARCH_KEY: env.BRAVE_SEARCH_KEY,
        CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID,
        CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN,
        DEFAULT_PROVIDER: env.DEFAULT_PROVIDER, DEFAULT_MODEL: env.DEFAULT_MODEL,
      };

      try {
        const result = await edgeResume(runtimeEnv, env.HYPERDRIVE, checkpointId, env.TELEMETRY_QUEUE);
        return Response.json(result);
      } catch (err: any) {
        return Response.json({ error: err.message }, { status: 500 });
      }
    }

    // ── Run status/result query (non-blocking polling) ──────
    // GET /api/v1/runs/{run_id} — check status and get result for an async run
    const runStatusMatch = url.pathname.match(/^\/api\/v1\/runs\/([a-zA-Z0-9-]+)$/);
    if (runStatusMatch && request.method === "GET") {
      const runId = runStatusMatch[1];
      const serviceToken = env.SERVICE_TOKEN || "";
      if (serviceToken) {
        const authHeader = request.headers.get("Authorization") || "";
        const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
        if (token !== serviceToken) {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }
      }

      // Look up session by session_id (run_id = session_id)
      try {
        const { getDb } = await import("./runtime/db");
        const sql = await getDb(env.HYPERDRIVE);
        const rows = await sql`
          SELECT session_id, agent_name, status, input_text, output_text,
                 model, trace_id, step_count, action_count,
                 wall_clock_seconds, cost_total_usd, created_at
          FROM sessions
          WHERE session_id = ${runId} OR trace_id = ${runId}
          LIMIT 1
        `;
        if (rows.length === 0) {
          return Response.json({
            run_id: runId,
            status: "running",
            message: "Run in progress or not found. Try again shortly.",
          });
        }
        const row = rows[0] as any;
        return Response.json({
          run_id: runId,
          status: row.status === "success" ? "completed" : row.status === "error" ? "failed" : "running",
          agent_name: row.agent_name,
          output: row.output_text || "",
          input: row.input_text || "",
          model: row.model || "",
          trace_id: row.trace_id || "",
          turns: row.step_count || 0,
          tool_calls: row.action_count || 0,
          cost_usd: row.cost_total_usd || 0,
          wall_clock_seconds: row.wall_clock_seconds || 0,
          created_at: row.created_at,
        });
      } catch (err: any) {
        return Response.json({ run_id: runId, status: "unknown", error: err.message }, { status: 500 });
      }
    }

    // Route Agents SDK requests: /agents/:agent-name/:instance-name
    // Each agent is a DO instance. Auth guard before routing.
    if (url.pathname.startsWith("/agents/")) {
      const deny = await authorizeAgentIngress(request, env);
      if (deny) return deny;
    }
    const agentResponse = await routeAgentRequest(request, env);
    if (agentResponse) return agentResponse;

    // ── Telegram Webhook ──────────────────────────────────────
    // URL: /chat/telegram/{agent_name}/webhook
    // Bot token loaded from Supabase per-agent (channel_config table) or env fallback.
    // Runs on main worker because dispatch workers can't call back to main (CF routing).
    const telegramMatch = url.pathname.match(/^\/chat\/telegram\/([a-zA-Z0-9_-]+)\/webhook$/);
    if ((telegramMatch || url.pathname === "/chat/telegram/webhook") && request.method === "POST") {
      const agentName = telegramMatch?.[1] || env.TELEGRAM_AGENT_NAME || "my-assistant";

      // Load bot token: try Supabase first, fall back to env
      let botToken = "";
      try {
        const { getDb } = await import("./runtime/db");
        const sql = await getDb(env.HYPERDRIVE);
        const rows = await sql`
          SELECT access_token FROM connector_tokens
          WHERE connector_name = 'telegram' AND org_id = (
            SELECT org_id FROM agents WHERE name = ${agentName} LIMIT 1
          )
          LIMIT 1
        `;
        botToken = rows[0]?.access_token || "";
      } catch {}
      if (!botToken) botToken = env.TELEGRAM_BOT_TOKEN || "";
      if (!botToken) return Response.json({ error: "No Telegram bot token configured for agent: " + agentName }, { status: 503 });

      const payload = await request.json() as any;
      const msg = payload.message || payload.edited_message;
      if (!msg?.text) return Response.json({ ok: true });

      const chatId = msg.chat?.id;
      const text = msg.text || "";
      const messageId = msg.message_id;
      const tgApi = `https://api.telegram.org/bot${botToken}`;

      if (text.startsWith("/start")) {
        await fetch(`${tgApi}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text: `Hi! I'm ${agentName}. Send me a message and I'll help.`, parse_mode: "Markdown" }),
        });
        return Response.json({ ok: true });
      }

      // Typing indicator
      fetch(`${tgApi}/sendChatAction`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, action: "typing" }),
      }).catch(() => {});

      // Run agent in background — return 200 immediately to avoid Telegram 60s timeout.
      // Uses runViaAgent which creates a per-user DO instance: {agent}-u-{chatId}
      const userInput = text.startsWith("/ask ") ? text.slice(5) : text;

      ctx.waitUntil((async () => {
        try {
          // Keep typing indicator alive while agent works
          const typingInterval = setInterval(() => {
            fetch(`${tgApi}/sendChatAction`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ chat_id: chatId, action: "typing" }),
            }).catch(() => {});
          }, 5000);

          const result = await runViaAgent(env, agentName, userInput, {
            channel: "telegram",
            channel_user_id: String(chatId),
          });

          clearInterval(typingInterval);
          let output = result.output || "";
          if (!output && result.error) output = "Sorry, I couldn't process that. Try again.";
          if (!output) output = "No response generated.";

          for (let i = 0; i < output.length; i += 4000) {
            await fetch(`${tgApi}/sendMessage`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                chat_id: chatId,
                text: output.slice(i, i + 4000),
                reply_to_message_id: i === 0 ? messageId : undefined,
                parse_mode: "Markdown",
              }),
            });
          }
        } catch (err: any) {
          await fetch(`${tgApi}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: chatId, text: `Error: ${(err.message || "unknown").slice(0, 200)}` }),
          }).catch(() => {});
        }
      })());

      // Return immediately — Telegram gets 200 OK, agent runs in background
      return Response.json({ ok: true });
    }

    // ── /cf/* — Cloudflare binding endpoints ────────────────────────
    // Authenticated via SERVICE_TOKEN (service-to-service).

    if (url.pathname.startsWith("/cf/")) {
      const serviceToken = env.SERVICE_TOKEN || "";
      if (!serviceToken) {
        return Response.json({ error: "service_token_not_configured" }, { status: 503 });
      }
      const authHeader = request.headers.get("Authorization") || "";
      const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
      if (token !== serviceToken) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }

      // /cf/sandbox/exec — run code in Dynamic Worker or Container
      if (url.pathname === "/cf/sandbox/exec" && request.method === "POST") {
        const body = await request.json() as { code: string; language?: string; timeoutMs?: number };
        const code = body.code || "";
        const language = (body.language || detectLang(code)) as "javascript" | "python" | "bash";
        const timeout = body.timeoutMs || 30000;

        if (language === "javascript" || language === "python") {
          try {
            const workerCode = `const __o=[],__e=[];console.log=(...a)=>__o.push(a.map(String).join(" "));console.error=(...a)=>__e.push(a.map(String).join(" "));export default{async fetch(){try{${code};return Response.json({stdout:__o.join("\\n"),stderr:__e.join("\\n"),exit_code:0})}catch(e){return Response.json({stdout:__o.join("\\n"),stderr:e.message||String(e),exit_code:1})}}}`;
            const loaded = await env.LOADER.load({
              compatibilityDate: "2026-03-01",
              mainModule: "main.js",
              modules: {
                "main.js": { js: workerCode },
              },
              env: {},  // No bindings — isolate cannot access secrets or DB
              globalOutbound: null,  // Block all outbound network from /cf/sandbox/exec
            });
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeout);
            const result = await loaded.getEntrypoint().fetch("http://internal/run", { signal: controller.signal });
            clearTimeout(timer);
            return Response.json(await result.json());
          } catch (err: any) {
            return Response.json({ stdout: "", stderr: err.message, exit_code: 1 });
          }
        }

        if (language === "bash" && env.SANDBOX) {
          try {
            const sandbox = getSandbox(env.SANDBOX, `cf-exec-${crypto.randomUUID().slice(0, 8)}`);
            const result = await sandbox.exec(code, { timeout: Math.ceil(timeout / 1000) });
            return Response.json({ stdout: result.stdout || "", stderr: result.stderr || "", exit_code: result.exitCode ?? 0 });
          } catch (err: any) {
            return Response.json({ stdout: "", stderr: err.message, exit_code: 1 });
          }
        }

        return Response.json({ error: `unsupported language: ${language}` }, { status: 400 });
      }

      // /cf/ai/embed — embed text via Workers AI
      if (url.pathname === "/cf/ai/embed" && request.method === "POST") {
        const body = await request.json() as { texts: string[] };
        try {
          const result = await env.AI.run("@cf/baai/bge-base-en-v1.5", { text: body.texts }) as any;
          return Response.json({ vectors: result.data || [] });
        } catch (err: any) {
          return Response.json({ error: err.message }, { status: 500 });
        }
      }

      // /cf/llm/infer — Universal LLM endpoint
      // Routes: @cf/* → Workers AI (edge) | others → OpenRouter via BYOK
      // Backend never calls LLM providers directly — all go through this worker.
      if (url.pathname === "/cf/llm/infer" && request.method === "POST") {
        const body = await request.json() as {
          model: string;
          messages: { role: string; content: string }[];
          max_tokens?: number;
          temperature?: number;
          tools?: any[];
          provider?: string;  // "workers-ai" | "openrouter" | auto-detect from model
        };
        const model = body.model || "@cf/meta/llama-3.1-8b-instruct";
        const isWorkersAI = model.startsWith("@cf/");
        const started = Date.now();

        try {
          let content = "";
          let toolCalls: any[] = [];
          let inputTokens = 0;
          let outputTokens = 0;
          let resolvedModel = model;

          if (isWorkersAI) {
            // ── Workers AI (edge inference, sub-second) ──
            const aiResult = await env.AI.run(model as keyof AiModels, {
              messages: body.messages,
              max_tokens: body.max_tokens || 1024,
              temperature: body.temperature || 0,
              ...(body.tools ? { tools: body.tools } : {}),
            }) as any;
            content = aiResult.response || aiResult.content || "";
            toolCalls = aiResult.tool_calls || [];
            inputTokens = aiResult.usage?.input_tokens || 0;
            outputTokens = aiResult.usage?.output_tokens || 0;

          } else {
            // ── OpenRouter (400+ models, BYOK) ──
            const orKey = env.OPENROUTER_API_KEY || "";
            if (!orKey) {
              return Response.json({ error: "OPENROUTER_API_KEY not configured on worker" }, { status: 503 });
            }

            // Build payload — handle GPT-5.x max_completion_tokens
            const payload: Record<string, any> = {
              model,
              messages: body.messages.map(m => ({
                ...m,
                role: m.role === "system" && model.includes("gpt-5") ? "developer" : m.role,
              })),
              temperature: body.temperature || 0,
            };
            if (model.includes("gpt-5")) {
              payload.max_completion_tokens = body.max_tokens || 1024;
            } else {
              payload.max_tokens = body.max_tokens || 1024;
            }
            if (body.tools) {
              // Fix array schemas for GPT-5.x strict validation
              payload.tools = body.tools.map((t: any) => {
                const params = t.function?.parameters || t.parameters || {};
                const fixed = JSON.parse(JSON.stringify(params));
                const fixArrays = (obj: any) => {
                  if (!obj || typeof obj !== "object") return;
                  for (const [k, v] of Object.entries(obj)) {
                    if (v && typeof v === "object") {
                      const val = v as Record<string, any>;
                      if (val.type === "array" && !val.items) val.items = { type: "string" };
                      fixArrays(val);
                    }
                  }
                };
                fixArrays(fixed);
                return { type: "function", function: { name: t.function?.name || t.name, description: t.function?.description || t.description, parameters: fixed } };
              });
            }

            const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
              method: "POST",
              headers: { "Authorization": `Bearer ${orKey}`, "Content-Type": "application/json" },
              body: JSON.stringify(payload),
            });

            if (!resp.ok) {
              const errBody = await resp.text();
              return Response.json({ error: `OpenRouter ${resp.status}: ${errBody.slice(0, 200)}`, model }, { status: resp.status });
            }

            const data = await resp.json() as any;
            const choice = (data.choices || [{}])[0];
            const msg = choice.message || {};
            content = msg.content || "";
            toolCalls = (msg.tool_calls || []).map((tc: any) => ({
              id: tc.id, name: tc.function?.name, arguments: tc.function?.arguments,
            }));
            inputTokens = data.usage?.prompt_tokens || 0;
            outputTokens = data.usage?.completion_tokens || 0;
            resolvedModel = data.model || model;
          }

          const latencyMs = Date.now() - started;
          return Response.json({
            content, model: resolvedModel, provider: isWorkersAI ? "workers-ai" : "openrouter",
            tool_calls: toolCalls, input_tokens: inputTokens, output_tokens: outputTokens, latency_ms: latencyMs,
          });
        } catch (err: any) {
          return Response.json({ error: err.message, model }, { status: 500 });
        }
      }

      // /cf/rag/query — semantic search via Vectorize
      if (url.pathname === "/cf/rag/query" && request.method === "POST") {
        const body = await request.json() as { query: string; topK?: number; org_id?: string; agent_name?: string };
        try {
          const embedResult = await env.AI.run("@cf/baai/bge-base-en-v1.5", { text: [body.query] }) as any;
          const queryVec = embedResult.data?.[0];
          if (!queryVec) return Response.json({ results: [] });

          const filter: Record<string, string> = {};
          if (body.org_id) filter.org_id = body.org_id;
          if (body.agent_name) filter.agent_name = body.agent_name;

          const matches = await env.VECTORIZE.query(queryVec, {
            topK: body.topK || 10,
            filter: Object.keys(filter).length > 0 ? filter : undefined,
            returnMetadata: "all",
          });

          const results = (matches.matches || []).map((m: any) => ({
            id: m.id,
            score: m.score,
            text: m.metadata?.text || "",
            source: m.metadata?.source || "",
            chunk_index: m.metadata?.chunk_index || 0,
          }));
          return Response.json({ results });
        } catch (err: any) {
          return Response.json({ error: err.message }, { status: 500 });
        }
      }

      // /cf/rag/ingest — chunk, embed, store in Vectorize + R2
      if (url.pathname === "/cf/rag/ingest" && request.method === "POST") {
        const body = await request.json() as { text: string; source?: string; org_id?: string; agent_name?: string };
        try {
          const words = body.text.split(/\s+/);
          const chunks: string[] = [];
          for (let i = 0; i < words.length; i += 400) {
            chunks.push(words.slice(i, i + 512).join(" "));
          }

          const embedResult = await env.AI.run("@cf/baai/bge-base-en-v1.5", { text: chunks }) as any;
          const vectors = embedResult.data || [];

          const vecInserts = vectors.map((vec: number[], idx: number) => ({
            id: `${body.source || "text"}-${Date.now()}-${idx}`,
            values: vec,
            metadata: {
              text: chunks[idx],
              source: body.source || "api",
              org_id: body.org_id || "",
              agent_name: body.agent_name || "",
              chunk_index: idx,
            },
          }));

          if (vecInserts.length > 0) {
            await env.VECTORIZE.upsert(vecInserts);
          }

          // Store original text in R2
          const r2Key = `rag/${body.org_id || "global"}/${body.source || "text"}-${Date.now()}.txt`;
          await env.STORAGE.put(r2Key, body.text, {
            customMetadata: { source: body.source || "api", org_id: body.org_id || "", agent_name: body.agent_name || "" },
          });

          return Response.json({ chunks: chunks.length, vectors: vecInserts.length, r2_key: r2Key });
        } catch (err: any) {
          return Response.json({ error: err.message }, { status: 500 });
        }
      }

      // /cf/storage/put — upload to R2
      if (url.pathname === "/cf/storage/put" && request.method === "POST") {
        const key = url.searchParams.get("key");
        if (!key) return Response.json({ error: "key required" }, { status: 400 });
        await env.STORAGE.put(key, request.body, {
          customMetadata: Object.fromEntries(
            [...request.headers.entries()].filter(([k]) => k.startsWith("x-meta-")).map(([k, v]) => [k.slice(7), v])
          ),
        });
        return Response.json({ success: true, key });
      }

      // /cf/storage/get — download from R2
      if (url.pathname === "/cf/storage/get" && request.method === "GET") {
        const key = url.searchParams.get("key");
        if (!key) return Response.json({ error: "key required" }, { status: 400 });
        const obj = await env.STORAGE.get(key);
        if (!obj) return Response.json({ error: "not found" }, { status: 404 });
        return new Response(obj.body, {
          headers: { "Content-Type": obj.httpMetadata?.contentType || "application/octet-stream" },
        });
      }

      // /cf/browse/crawl — async crawl via CF Browser Rendering /crawl endpoint
      if (url.pathname === "/cf/browse/crawl" && request.method === "POST") {
        const body = await request.json() as {
          url: string; limit?: number; depth?: number; formats?: string[];
        };
        const brBase = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/browser-rendering`;
        const brAuth = { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, "Content-Type": "application/json" };
        try {
          // Start crawl job
          const startResp = await fetch(`${brBase}/crawl`, {
            method: "POST",
            headers: brAuth,
            body: JSON.stringify({
              url: body.url,
              limit: body.limit || 10,
              depth: body.depth || 2,
              formats: body.formats || ["markdown"],
              render: true,
            }),
          });
          const startData = await startResp.json() as any;
          if (!startResp.ok) return Response.json(startData, { status: startResp.status });

          // Poll for results (up to 60s)
          const jobId = startData.result;
          if (!jobId) return Response.json(startData);

          for (let i = 0; i < 12; i++) {
            await new Promise(r => setTimeout(r, 5000));
            const pollResp = await fetch(`${brBase}/crawl/${jobId}?limit=100`, { headers: brAuth });
            const pollData = await pollResp.json() as any;
            const status = pollData.result?.status;
            if (status === "completed" || status === "errored" || status?.startsWith("cancelled")) {
              return Response.json(pollData);
            }
          }
          // Timeout — return partial results
          const finalResp = await fetch(`${brBase}/crawl/${jobId}?limit=100`, { headers: brAuth });
          return Response.json(await finalResp.json());
        } catch (err: any) {
          return Response.json({ error: err.message }, { status: 500 });
        }
      }

      // /cf/browse/render — single-page render via CF Browser Rendering REST API
      if (url.pathname === "/cf/browse/render" && request.method === "POST") {
        const body = await request.json() as {
          url: string; action?: string; waitForSelector?: string; timeout?: number;
        };
        const brBase = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/browser-rendering`;
        const brAuth = { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, "Content-Type": "application/json" };
        // Map action to CF endpoint
        const actionMap: Record<string, string> = {
          markdown: "markdown", text: "markdown", html: "content",
          links: "links", screenshot: "screenshot", scrape: "scrape",
        };
        const endpoint = actionMap[body.action || "markdown"] || "markdown";
        const payload: Record<string, any> = { url: body.url };
        if (body.waitForSelector) payload.waitForSelector = body.waitForSelector;
        if (body.timeout) payload.gotoOptions = { timeout: body.timeout };
        try {
          const resp = await fetch(`${brBase}/${endpoint}`, {
            method: "POST", headers: brAuth,
            body: JSON.stringify(payload),
          });
          if (endpoint === "screenshot") {
            // Binary response — base64 encode for JSON transport
            const buf = await resp.arrayBuffer();
            const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
            return Response.json({ screenshot_base64: b64, url: body.url });
          }
          const data = await resp.json() as any;
          return Response.json(data);
        } catch (err: any) {
          return Response.json({ error: err.message }, { status: 500 });
        }
      }

      // /cf/agent/teardown — clean up all CF resources for a deleted agent
      if (url.pathname === "/cf/agent/teardown" && request.method === "POST") {
        const body = await request.json() as { agent_name: string; org_id?: string };
        const agentName = body.agent_name || "";
        const orgId = body.org_id || "";
        if (!agentName) return Response.json({ error: "agent_name required" }, { status: 400 });

        const results: Record<string, number | string> = {};

        // 1. Delete Vectorize entries for this agent
        try {
          // Vectorize doesn't have a bulk delete-by-metadata API yet,
          // so we query matching vectors and delete by ID
          const embedResult = await env.AI.run("@cf/baai/bge-base-en-v1.5", { text: [agentName] }) as any;
          const queryVec = embedResult.data?.[0];
          if (queryVec) {
            const filter: Record<string, string> = { agent_name: agentName };
            if (orgId) filter.org_id = orgId;
            // Vectorize max topK is 100; loop to delete in batches
            let totalDeleted = 0;
            for (let batch = 0; batch < 10; batch++) {
              const matches = await env.VECTORIZE.query(queryVec, {
                topK: 100,
                filter,
                returnMetadata: "none",
              });
              const ids = (matches.matches || []).map((m: any) => m.id);
              if (ids.length === 0) break; // no more matches
              await env.VECTORIZE.deleteByIds(ids);
              totalDeleted += ids.length;
              if (ids.length < 100) break; // last batch
            }
            results.vectorize_deleted = totalDeleted;
          }
        } catch (err: any) {
          results.vectorize_error = err.message;
        }

        // 2. Delete R2 files under the agent's prefix
        try {
          const prefix = orgId ? `rag/${orgId}/${agentName}` : `rag/global/${agentName}`;
          const listed = await env.STORAGE.list({ prefix, limit: 1000 });
          const keys = listed.objects.map((o: any) => o.key);
          for (const key of keys) {
            await env.STORAGE.delete(key);
          }
          results.r2_deleted = keys.length;

          // Also check for telegram-scoped files
          const tgPrefix = `telegram-`;
          const tgListed = await env.STORAGE.list({ prefix: tgPrefix, limit: 100 });
          let tgDeleted = 0;
          for (const obj of tgListed.objects) {
            if (obj.key.includes(agentName)) {
              await env.STORAGE.delete(obj.key);
              tgDeleted++;
            }
          }
          if (tgDeleted > 0) results.r2_telegram_deleted = tgDeleted;
        } catch (err: any) {
          results.r2_error = err.message;
        }

        return Response.json({ agent_name: agentName, org_id: orgId, cleanup: results });
      }

      // ── /cf/tool/exec — universal tool execution endpoint ──────
      // The backend harness calls this for ALL tool execution.
      // Each tool is routed to the appropriate CF binding.
      if (url.pathname === "/cf/tool/exec" && request.method === "POST") {
        const body = await request.json() as {
          tool: string;
          args: Record<string, any>;
          session_id?: string;
          turn?: number;
        };
        const { tool, args, session_id } = body;
        const started = Date.now();

        try {
          let result: any;

          switch (tool) {
            // ── Web Search (DuckDuckGo HTML — free, no rate limits) ──
            case "web-search": {
              const query = args.query || "";
              const maxResults = args.max_results || 5;
              try {
                const ddgResp = await fetch("https://html.duckduckgo.com/html/", {
                  method: "POST",
                  headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "AgentOS/0.2.0" },
                  body: `q=${encodeURIComponent(query)}`,
                });
                const html = await ddgResp.text();
                const linkRe = /<a rel="nofollow" class="result__a" href="([^"]+)"[^>]*>(.*?)<\/a>/g;
                const snippetRe = /<a class="result__snippet"[^>]*>(.*?)<\/a>/gs;
                const links: [string, string][] = [];
                let m;
                while ((m = linkRe.exec(html)) && links.length < maxResults) {
                  links.push([m[1], m[2].replace(/<[^>]+>/g, "").trim()]);
                }
                const snippets: string[] = [];
                while ((m = snippetRe.exec(html)) && snippets.length < maxResults) {
                  snippets.push(m[1].replace(/<[^>]+>/g, "").trim());
                }
                const lines = links.map(([url, title], i) =>
                  `${i + 1}. ${title}\n   ${url}\n   ${snippets[i] || ""}`
                );
                result = lines.length > 0 ? lines.join("\n\n") : `No results found for: ${query}`;
              } catch (err: any) {
                result = `Web search failed: ${err.message}`;
              }
              break;
            }

            // ── Bash (Sandbox Container) ──
            case "bash": {
              const command = args.command || "";
              const timeout = Math.min(args.timeout_seconds || 30, 120);
              const sandboxId = `session-${session_id || "default"}`;
              const sandbox = getSandbox(env.SANDBOX, sandboxId);
              const execResult = await sandbox.exec(command, { timeout });
              result = JSON.stringify({
                stdout: execResult.stdout || "",
                stderr: execResult.stderr || "",
                exit_code: execResult.exitCode ?? 0,
              });
              break;
            }

            // ── HTTP Request (Worker fetch) ──
            case "http-request": {
              const url = args.url || "";
              const method = (args.method || "GET").toUpperCase();
              const headers = args.headers || {};
              const reqBody = args.body || "";
              const timeout = args.timeout_seconds || 30;
              const controller = new AbortController();
              const timer = setTimeout(() => controller.abort(), timeout * 1000);
              try {
                const resp = await fetch(url, {
                  method,
                  headers: { ...headers },
                  ...(method !== "GET" && method !== "HEAD" && reqBody ? { body: reqBody } : {}),
                  signal: controller.signal,
                });
                clearTimeout(timer);
                const respBody = await resp.text();
                result = JSON.stringify({
                  status: resp.status,
                  headers: Object.fromEntries(resp.headers.entries()),
                  body: respBody.slice(0, 10000),
                });
              } catch (err: any) {
                clearTimeout(timer);
                result = JSON.stringify({ error: err.message });
              }
              break;
            }

            // ── Python exec (Sandbox Container) ──
            case "python-exec": {
              const code = args.code || "";
              const timeout = Math.min(args.timeout_seconds || 30, 120);
              const sandboxId = `session-${session_id || "default"}`;
              const sandbox = getSandbox(env.SANDBOX, sandboxId);
              // Write code to temp file and execute (handles multiline, imports, etc.)
              const tmpFile = `/tmp/exec_${Date.now()}.py`;
              await sandbox.writeFile(tmpFile, code);
              const execResult = await sandbox.exec(`python3 ${tmpFile}`, { timeout });
              result = JSON.stringify({
                stdout: execResult.stdout || "",
                stderr: execResult.stderr || "",
                exit_code: execResult.exitCode ?? 0,
              });
              break;
            }

            // ── File operations (Sandbox Container filesystem) ──
            case "read-file": {
              const path = args.path || "";
              const sandboxId = `session-${session_id || "default"}`;
              const sandbox = getSandbox(env.SANDBOX, sandboxId);
              const execResult = await sandbox.exec(`cat -n "${path}" 2>&1 | head -2000`, { timeout: 10 });
              result = execResult.stdout || execResult.stderr || "File not found or empty";
              break;
            }

            case "write-file": {
              const path = args.path || "";
              const content = args.content || "";
              const sandboxId = `session-${session_id || "default"}`;
              const sandbox = getSandbox(env.SANDBOX, sandboxId);
              await sandbox.writeFile(path, content);
              result = `Written ${content.length} bytes to ${path}`;
              break;
            }

            case "edit-file": {
              const path = args.path || "";
              const oldText = args.old_text || args.old_string || "";
              const newText = args.new_text || args.new_string || "";
              const sandboxId = `session-${session_id || "default"}`;
              const sandbox = getSandbox(env.SANDBOX, sandboxId);
              const readResult = await sandbox.exec(`cat "${path}"`, { timeout: 10 });
              const content = readResult.stdout || "";
              if (!content.includes(oldText)) {
                result = `Error: old_text not found in ${path}`;
              } else {
                const newContent = content.replace(oldText, newText);
                await sandbox.writeFile(path, newContent);
                result = `Edited ${path}: replaced ${oldText.length} chars`;
              }
              break;
            }

            case "grep": {
              const pattern = args.pattern || "";
              const path = args.path || ".";
              const maxResults = args.max_results || 20;
              const sandboxId = `session-${session_id || "default"}`;
              const sandbox = getSandbox(env.SANDBOX, sandboxId);
              const execResult = await sandbox.exec(
                `grep -rn "${pattern.replace(/"/g, '\\"')}" "${path}" | head -${maxResults}`,
                { timeout: 15 }
              );
              result = execResult.stdout || "No matches found";
              break;
            }

            case "glob": {
              const pattern = args.pattern || "*";
              const path = args.path || ".";
              const sandboxId = `session-${session_id || "default"}`;
              const sandbox = getSandbox(env.SANDBOX, sandboxId);
              const execResult = await sandbox.exec(
                `find "${path}" -name "${pattern.replace(/"/g, '\\"')}" -type f | head -50`,
                { timeout: 10 }
              );
              result = execResult.stdout || "No files found";
              break;
            }

            // ── Sandbox operations ──
            case "sandbox_exec": {
              const command = args.command || "";
              const sandboxId = `session-${session_id || args.sandbox_id || "default"}`;
              const sandbox = getSandbox(env.SANDBOX, sandboxId);
              const execResult = await sandbox.exec(command, { timeout: Math.min(args.timeout || 30, 120) });
              result = JSON.stringify({
                sandbox_id: sandboxId,
                stdout: execResult.stdout || "",
                stderr: execResult.stderr || "",
                exit_code: execResult.exitCode ?? 0,
              });
              break;
            }

            case "sandbox_file_write": {
              const sandboxId = `session-${session_id || args.sandbox_id || "default"}`;
              const sandbox = getSandbox(env.SANDBOX, sandboxId);
              await sandbox.writeFile(args.path || "/tmp/file", args.content || "");
              result = `Written to ${args.path}`;
              break;
            }

            case "sandbox_file_read": {
              const sandboxId = `session-${session_id || args.sandbox_id || "default"}`;
              const sandbox = getSandbox(env.SANDBOX, sandboxId);
              const execResult = await sandbox.exec(`cat "${args.path || "/tmp/file"}"`, { timeout: 10 });
              result = execResult.stdout || "";
              break;
            }

            case "sandbox_kill": {
              result = "Sandbox cleanup scheduled";
              break;
            }

            // ── Project Persistence (Sandbox ↔ R2) ──
            case "save-project": {
              const workspace = args.workspace || "/workspace";
              const orgId = args.org_id || "";
              const projectId = args.project_id || "";
              const agentName = args.agent_name || "";
              if (!orgId || !agentName) {
                result = "save-project requires org_id and agent_name";
                break;
              }
              const sandboxId = `session-${session_id || "default"}`;
              const sandbox = getSandbox(env.SANDBOX, sandboxId);
              try {
                // Tar the workspace
                const tarResult = await sandbox.exec(
                  `cd ${workspace} 2>/dev/null && tar czf /tmp/workspace.tar.gz . 2>/dev/null || echo "__EMPTY__"`,
                  { timeout: 30 }
                );
                if (tarResult.stdout?.includes("__EMPTY__")) {
                  result = `No files found in ${workspace}`;
                  break;
                }
                // Read tar as base64
                const b64Result = await sandbox.exec(`base64 /tmp/workspace.tar.gz`, { timeout: 30 });
                const b64Data = b64Result.stdout?.trim() || "";
                if (!b64Data) {
                  result = "Failed to read workspace archive";
                  break;
                }
                // Upload to R2
                const r2Key = `workspaces/${orgId}/${projectId || "default"}/${agentName}/latest.tar.gz`;
                const versionKey = `workspaces/${orgId}/${projectId || "default"}/${agentName}/v${Date.now()}.tar.gz`;
                const bytes = Uint8Array.from(atob(b64Data), c => c.charCodeAt(0));
                await env.STORAGE.put(r2Key, bytes, {
                  customMetadata: { org_id: orgId, project_id: projectId, agent_name: agentName, saved_at: new Date().toISOString() },
                });
                await env.STORAGE.put(versionKey, bytes, {
                  customMetadata: { org_id: orgId, project_id: projectId, agent_name: agentName, saved_at: new Date().toISOString() },
                });
                // Count files
                const countResult = await sandbox.exec(`find ${workspace} -type f | wc -l`, { timeout: 5 });
                const fileCount = parseInt(countResult.stdout?.trim() || "0");
                result = JSON.stringify({
                  saved: true, r2_key: r2Key, version_key: versionKey,
                  files: fileCount, size_bytes: bytes.byteLength,
                });
              } catch (err: any) {
                result = `save-project failed: ${err.message}`;
              }
              break;
            }

            case "load-project": {
              const workspace = args.workspace || "/workspace";
              const orgId = args.org_id || "";
              const projectId = args.project_id || "";
              const agentName = args.agent_name || "";
              const version = args.version || "latest";
              if (!orgId || !agentName) {
                result = "load-project requires org_id and agent_name";
                break;
              }
              const sandboxId = `session-${session_id || "default"}`;
              const sandbox = getSandbox(env.SANDBOX, sandboxId);
              try {
                const r2Key = version === "latest"
                  ? `workspaces/${orgId}/${projectId || "default"}/${agentName}/latest.tar.gz`
                  : `workspaces/${orgId}/${projectId || "default"}/${agentName}/${version}.tar.gz`;
                const obj = await env.STORAGE.get(r2Key);
                if (!obj) {
                  result = JSON.stringify({ loaded: false, reason: "No saved workspace found. Start fresh." });
                  break;
                }
                // Write tar to sandbox and extract
                const buf = await obj.arrayBuffer();
                const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
                await sandbox.writeFile("/tmp/workspace.tar.gz.b64", b64);
                await sandbox.exec(`mkdir -p ${workspace}`, { timeout: 5 });
                await sandbox.exec(
                  `base64 -d /tmp/workspace.tar.gz.b64 > /tmp/workspace.tar.gz && cd ${workspace} && tar xzf /tmp/workspace.tar.gz`,
                  { timeout: 30 }
                );
                const countResult = await sandbox.exec(`find ${workspace} -type f | wc -l`, { timeout: 5 });
                const fileCount = parseInt(countResult.stdout?.trim() || "0");
                result = JSON.stringify({
                  loaded: true, r2_key: r2Key, files: fileCount,
                  size_bytes: buf.byteLength,
                });
              } catch (err: any) {
                result = `load-project failed: ${err.message}`;
              }
              break;
            }

            case "list-project-versions": {
              const orgId = args.org_id || "";
              const projectId = args.project_id || "";
              const agentName = args.agent_name || "";
              if (!orgId || !agentName) {
                result = "list-project-versions requires org_id and agent_name";
                break;
              }
              try {
                const prefix = `workspaces/${orgId}/${projectId || "default"}/${agentName}/`;
                const listed = await env.STORAGE.list({ prefix, limit: 50 });
                const versions = listed.objects.map((o: any) => ({
                  key: o.key.replace(prefix, ""),
                  size: o.size,
                  uploaded: o.uploaded,
                }));
                result = JSON.stringify({ versions, count: versions.length });
              } catch (err: any) {
                result = `list-project-versions failed: ${err.message}`;
              }
              break;
            }

            // ── Browse (simple HTTP fetch, no JS rendering) ──
            case "browse": {
              const targetUrl = args.url || "";
              try {
                const resp = await fetch(targetUrl, {
                  headers: { "User-Agent": "AgentOS/0.2.0" },
                  redirect: "follow",
                });
                const html = await resp.text();
                // Strip HTML tags for clean text
                const text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
                  .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
                  .replace(/<[^>]+>/g, " ")
                  .replace(/\s+/g, " ")
                  .trim()
                  .slice(0, 10000);
                result = text || "Empty page";
              } catch (err: any) {
                result = `Browse failed: ${err.message}`;
              }
              break;
            }

            // ── A2A (Agent-to-Agent protocol) ──
            case "a2a-send": {
              const targetUrl = args.url || "";
              const task = args.task || args.message || "";
              try {
                const resp = await fetch(`${targetUrl}/tasks/send`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    jsonrpc: "2.0", method: "tasks/send", id: crypto.randomUUID(),
                    params: { message: { role: "user", parts: [{ type: "text", text: task }] } },
                  }),
                });
                result = await resp.text();
              } catch (err: any) {
                result = `A2A send failed: ${err.message}`;
              }
              break;
            }

            // ── Connector (Pipedream MCP) ──
            case "connector": {
              const toolName = args.tool_name || "";
              // Explicitly edge-only: no backend fallback path from worker runtime.
              return Response.json(
                {
                  tool,
                  error: `Connector '${toolName}' is not available on edge runtime (no backend fallback).`,
                },
                { status: 400 },
              );
            }

            // ── Dynamic exec (JS in V8 isolate — already on CF) ──
            case "dynamic-exec": {
              const code = args.code || "";
              const language = args.language || "javascript";
              const timeout = args.timeout_ms || 10000;
              if (language === "javascript" || language === "python") {
                try {
                  const workerCode = `const __o=[],__e=[];console.log=(...a)=>__o.push(a.map(String).join(" "));console.error=(...a)=>__e.push(a.map(String).join(" "));export default{async fetch(){try{${code};return Response.json({stdout:__o.join("\\n"),stderr:__e.join("\\n"),exit_code:0})}catch(e){return Response.json({stdout:__o.join("\\n"),stderr:e.message||String(e),exit_code:1})}}}`;
                  const loaded = await env.LOADER.load({
                    compatibilityDate: "2026-03-01",
                    mainModule: "main.js",
                    modules: {
                      "main.js": { js: workerCode },
                    },
                    env: {},  // No bindings — isolate cannot access secrets or DB
                    globalOutbound: null,  // Block all outbound network from /cf/tool/exec dynamic-exec
                  });
                  const controller = new AbortController();
                  const timer = setTimeout(() => controller.abort(), timeout);
                  const execResp = await loaded.getEntrypoint().fetch("http://internal/run", { signal: controller.signal });
                  clearTimeout(timer);
                  result = JSON.stringify(await execResp.json());
                } catch (err: any) {
                  result = JSON.stringify({ stdout: "", stderr: err.message, exit_code: 1 });
                }
              } else {
                // bash/shell — use Sandbox
                const sandboxId = `session-${session_id || "default"}`;
                const sandbox = getSandbox(env.SANDBOX, sandboxId);
                const execResult = await sandbox.exec(code, { timeout: Math.ceil(timeout / 1000) });
                result = JSON.stringify({ stdout: execResult.stdout || "", stderr: execResult.stderr || "", exit_code: execResult.exitCode ?? 0 });
              }
              break;
            }

            // ── Web crawl (CF Browser Rendering — already on CF) ──
            case "web-crawl": {
              const crawlUrl = args.url || "";
              const limit = args.max_pages || 10;
              const depth = args.max_depth || 2;
              const brBase = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/browser-rendering`;
              const brAuth = { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, "Content-Type": "application/json" };
              try {
                const startResp = await fetch(`${brBase}/crawl`, {
                  method: "POST", headers: brAuth,
                  body: JSON.stringify({ url: crawlUrl, limit, depth, formats: ["markdown"], render: true }),
                });
                const startData = await startResp.json() as any;
                const jobId = startData.result;
                if (!jobId) { result = JSON.stringify(startData); break; }
                for (let i = 0; i < 12; i++) {
                  await new Promise(r => setTimeout(r, 5000));
                  const pollResp = await fetch(`${brBase}/crawl/${jobId}?limit=100`, { headers: brAuth });
                  const pollData = await pollResp.json() as any;
                  const status = pollData.result?.status;
                  if (status === "completed" || status === "errored" || status?.startsWith("cancelled")) {
                    result = JSON.stringify(pollData); break;
                  }
                }
                if (!result) {
                  const finalResp = await fetch(`${brBase}/crawl/${jobId}?limit=100`, { headers: brAuth });
                  result = JSON.stringify(await finalResp.json());
                }
              } catch (err: any) {
                result = JSON.stringify({ error: err.message });
              }
              break;
            }

            // ── Browser render (CF Browser Rendering — already on CF) ──
            case "browser-render": {
              const renderUrl = args.url || "";
              const action = args.action || "markdown";
              const brBase = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/browser-rendering`;
              const brAuth = { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, "Content-Type": "application/json" };
              const actionMap: Record<string, string> = { markdown: "markdown", text: "markdown", html: "content", links: "links", screenshot: "screenshot" };
              const endpoint = actionMap[action] || "markdown";
              const payload: Record<string, any> = { url: renderUrl };
              if (args.wait_for) payload.waitForSelector = args.wait_for;
              try {
                const resp = await fetch(`${brBase}/${endpoint}`, { method: "POST", headers: brAuth, body: JSON.stringify(payload) });
                if (endpoint === "screenshot") {
                  const buf = await resp.arrayBuffer();
                  result = JSON.stringify({ screenshot_base64: btoa(String.fromCharCode(...new Uint8Array(buf))), url: renderUrl });
                } else {
                  result = JSON.stringify(await resp.json());
                }
              } catch (err: any) {
                result = JSON.stringify({ error: err.message });
              }
              break;
            }

            // ── Knowledge (RAG via Vectorize + R2 — already on CF) ──
            case "store-knowledge": {
              const text = args.content || args.text || "";
              const key = args.key || "knowledge";
              try {
                const embedResult = await env.AI.run("@cf/baai/bge-base-en-v1.5", { text: [text] }) as any;
                const vec = embedResult.data?.[0];
                if (vec) {
                  await env.VECTORIZE.upsert([{
                    id: `knowledge-${Date.now()}`,
                    values: vec,
                    metadata: { text, source: key, agent_name: args.agent_name || "", org_id: args.org_id || "" },
                  }]);
                }
                result = `Stored knowledge: '${key}' (${text.length} chars)`;
              } catch (err: any) {
                result = `Store failed: ${err.message}`;
              }
              break;
            }

            case "knowledge-search": {
              const query = args.query || "";
              const topK = args.top_k || 5;
              try {
                const embedResult = await env.AI.run("@cf/baai/bge-base-en-v1.5", { text: [query] }) as any;
                const queryVec = embedResult.data?.[0];
                if (!queryVec) { result = "Embedding failed"; break; }
                const matches = await env.VECTORIZE.query(queryVec, {
                  topK, returnMetadata: "all",
                  ...(args.agent_name ? { filter: { agent_name: args.agent_name } } : {}),
                });
                const results = (matches.matches || []).map((m: any) => ({
                  score: m.score, text: m.metadata?.text || "", source: m.metadata?.source || "",
                }));
                result = results.length > 0
                  ? results.map((r: any, i: number) => `${i + 1}. [${r.source}] ${r.text.slice(0, 200)}`).join("\n\n")
                  : `No relevant knowledge found for: ${query}`;
              } catch (err: any) {
                result = `Search failed: ${err.message}`;
              }
              break;
            }

            // ── Multimodal (GMI Cloud requestqueue API) ──
            // ── Image Generation (Workers AI FLUX or OpenRouter Gemini) ──
            case "image-generate": {
              const prompt = args.prompt || "";
              try {
                // Primary: Workers AI FLUX (free, edge)
                const aiResult = await env.AI.run(
                  "@cf/bfl/flux-2-klein-4b" as keyof AiModels,
                  { prompt }
                ) as ReadableStream | ArrayBuffer;
                const buf = aiResult instanceof ArrayBuffer
                  ? aiResult : await new Response(aiResult).arrayBuffer();
                // Store in R2 and return URL
                const key = `images/${Date.now()}-${Math.random().toString(36).slice(2,8)}.png`;
                await env.STORAGE.put(key, buf, { customMetadata: { prompt } });
                result = JSON.stringify({
                  image_key: key, format: "png", size_bytes: buf.byteLength, model: "@cf/bfl/flux-2-klein-4b",
                });
              } catch (err: any) {
                // Fallback: OpenRouter Gemini image
                try {
                  const orKey = env.OPENROUTER_API_KEY || "";
                  if (orKey) {
                    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
                      method: "POST",
                      headers: { Authorization: `Bearer ${orKey}`, "Content-Type": "application/json" },
                      body: JSON.stringify({
                        model: "google/gemini-2.5-flash-image",
                        messages: [{ role: "user", content: `Generate an image: ${prompt}` }],
                      }),
                    });
                    const data = await resp.json() as any;
                    const content = data.choices?.[0]?.message?.content || "";
                    result = JSON.stringify({ description: content, model: "google/gemini-2.5-flash-image" });
                  } else {
                    result = `Image gen failed: ${err.message}`;
                  }
                } catch (e2: any) {
                  result = `Image gen failed: ${err.message}, fallback: ${e2.message}`;
                }
              }
              break;
            }

            // ── Text-to-Speech (Workers AI Deepgram Aura) ──
            case "text-to-speech": {
              const text = args.text || "";
              try {
                const audioRaw = await env.AI.run(
                  "@cf/deepgram/aura-2-en" as keyof AiModels,
                  { text },
                ) as ArrayBuffer | Uint8Array | ReadableStream | string;
                const audioResult = audioRaw instanceof ArrayBuffer
                  ? audioRaw
                  : audioRaw instanceof Uint8Array
                    ? audioRaw.buffer.slice(audioRaw.byteOffset, audioRaw.byteOffset + audioRaw.byteLength)
                    : await new Response(audioRaw as BodyInit).arrayBuffer();
                const audioBytes = new Uint8Array(audioResult);
                // Store audio in R2
                const key = `audio/${Date.now()}-${Math.random().toString(36).slice(2,8)}.mp3`;
                await env.STORAGE.put(key, audioBytes, { customMetadata: { text: text.slice(0, 200) } });
                result = JSON.stringify({
                  audio_key: key, size_bytes: audioBytes.byteLength, model: "@cf/deepgram/aura-2-en",
                });
              } catch (err: any) {
                result = `TTS failed: ${err.message}`;
              }
              break;
            }

            case "speech-to-text": {
              // Workers AI Whisper — needs audio file in sandbox or R2
              const audioPath = args.audio_path || args.path || "";
              if (!audioPath) {
                result = "speech-to-text requires audio_path (path to audio file in sandbox)";
                break;
              }
              try {
                const sandboxId = `session-${session_id || "default"}`;
                const sandbox = getSandbox(env.SANDBOX, sandboxId);
                const catResult = await sandbox.exec(`base64 "${audioPath}"`, { timeout: 10 });
                if (catResult.exitCode !== 0) {
                  result = `Could not read audio file: ${catResult.stderr}`;
                  break;
                }
                const audioBytes = Uint8Array.from(atob(catResult.stdout.trim()), c => c.charCodeAt(0));
                const whisperResult = await env.AI.run("@cf/openai/whisper", {
                  audio: [...audioBytes],
                }) as any;
                result = JSON.stringify({ text: whisperResult.text || "", language: whisperResult.language || "" });
              } catch (err: any) {
                result = `STT failed: ${err.message}`;
              }
              break;
            }

            // ── Todo (session-scoped, Sandbox filesystem) ──
            case "todo": {
              const action = args.action || "list";
              const sandboxId = `session-${session_id || "default"}`;
              const sandbox = getSandbox(env.SANDBOX, sandboxId);
              const todoFile = "/tmp/todos.json";
              let todos: any[] = [];
              try {
                const readResult = await sandbox.exec(`cat ${todoFile} 2>/dev/null || echo "[]"`, { timeout: 5 });
                todos = JSON.parse(readResult.stdout || "[]");
              } catch { todos = []; }

              if (action === "add") {
                todos.push({ id: todos.length + 1, text: args.text || "", done: false });
                await sandbox.writeFile(todoFile, JSON.stringify(todos));
                result = `Added todo #${todos.length}: ${args.text}`;
              } else if (action === "complete") {
                const id = args.id || args.todo_id;
                const t = todos.find((t: any) => t.id == id);
                if (t) { t.done = true; await sandbox.writeFile(todoFile, JSON.stringify(todos)); result = `Completed todo #${id}`; }
                else result = `Todo #${id} not found`;
              } else {
                result = todos.length > 0
                  ? todos.map((t: any) => `${t.done ? "✓" : "○"} #${t.id}: ${t.text}`).join("\n")
                  : "No todos yet. Use action='add' with text to create one.";
              }
              break;
            }

            default:
              return Response.json({
                tool, error: `Tool '${tool}' not available on edge runtime.`,
              }, { status: 400 });
          }

          const latencyMs = Date.now() - started;
          return Response.json({ tool, result, latency_ms: latencyMs });

        } catch (err: any) {
          return Response.json({
            tool, error: err.message || String(err), latency_ms: Date.now() - started,
          }, { status: 500 });
        }
      }

      return Response.json({ error: "unknown /cf endpoint" }, { status: 404 });
    }

    // Serve static assets (portal SPA)
    return env.ASSETS.fetch(request);
  },

  // ── Queue Consumer — writes telemetry to Supabase via Hyperdrive ──
  // Messages flow: Agent DO → TELEMETRY_QUEUE → this consumer → Supabase
  // Guaranteed delivery, batched writes, automatic retries.
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    if (!env.HYPERDRIVE) {
      batch.retryAll();
      return;
    }

    // Connect via Postgres.js + Hyperdrive (Worker-compatible driver)
    const postgres = (await import("postgres")).default;
    const sql: any = postgres(env.HYPERDRIVE.connectionString, {
      max: 5,
      fetch_types: false,
      prepare: false,  // Hyperdrive requires prepare:false (transaction-mode pooling)
    });

    try {
      for (const msg of batch.messages) {
        const body = (msg.body || {}) as { type?: string; payload?: Record<string, unknown> };
        const type = String(body.type || "");
        const p = (body.payload || {}) as Record<string, any>;
        try {
          if (type === "session") {
            await sql`INSERT INTO sessions (
              session_id, org_id, project_id, agent_name, status,
              input_text, output_text, model, trace_id, parent_session_id,
              depth, step_count, action_count, wall_clock_seconds,
              cost_total_usd, created_at
            ) VALUES (
              ${p.session_id}, ${p.org_id || ""}, ${p.project_id || ""},
              ${p.agent_name || "agentos"}, ${p.status || "success"},
              ${p.input_text || ""}, ${p.output_text || ""},
              ${p.model || ""}, ${p.trace_id || ""}, ${p.parent_session_id || ""},
              ${p.depth || 0}, ${p.step_count || 0}, ${p.action_count || 0},
              ${p.wall_clock_seconds || 0}, ${p.cost_total_usd || 0},
              ${Number(p.created_at) || Date.now() / 1000}
            ) ON CONFLICT (session_id) DO UPDATE SET
              status = EXCLUDED.status, output_text = EXCLUDED.output_text,
              cost_total_usd = EXCLUDED.cost_total_usd, step_count = EXCLUDED.step_count`;
          } else if (type === "turn") {
            await sql`INSERT INTO turns (
              session_id, turn_number, model_used, input_tokens, output_tokens,
              latency_ms, llm_content, cost_total_usd,
              tool_calls_json, tool_results_json, errors_json,
              execution_mode, plan_json, reflection_json
            ) VALUES (
              ${p.session_id}, ${p.turn_number || 0}, ${p.model_used || ""},
              ${p.input_tokens || 0}, ${p.output_tokens || 0},
              ${p.latency_ms || 0}, ${p.llm_content || ""}, ${p.cost_total_usd || 0},
              ${p.tool_calls_json || "[]"}, ${p.tool_results_json || "[]"},
              ${p.errors_json || "[]"}, ${p.execution_mode || "sequential"},
              ${p.plan_json || "{}"}, ${p.reflection_json || "{}"}
            )`;
          } else if (type === "episode") {
            await sql`INSERT INTO episodes (session_id, input, output)
              VALUES (${p.session_id}, ${p.input}, ${p.output})`;
          } else if (type === "event") {
            await sql`INSERT INTO otel_events (
              session_id, turn, event_type, action, plan, tier,
              provider, model, tool_name, status, latency_ms, details_json, created_at
            ) VALUES (
              ${p.session_id}, ${p.turn || 0}, ${p.event_type || ""},
              ${p.action || ""}, ${p.plan || ""}, ${p.tier || ""},
              ${p.provider || ""}, ${p.model || ""}, ${p.tool_name || ""},
              ${p.status || ""}, ${p.latency_ms || 0}, ${JSON.stringify(p.details || {})},
              ${Number(p.created_at) || Date.now() / 1000}
            )`;
          }
          msg.ack();
        } catch (err) {
          msg.retry();
        }
      }
    } finally {
      await sql.end();
    }
  },
} satisfies ExportedHandler<Env>;
