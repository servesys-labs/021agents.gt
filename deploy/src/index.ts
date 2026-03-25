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
import { McpAgent } from "agents/mcp";
import { getSandbox, type Sandbox } from "@cloudflare/sandbox";

// Re-export Sandbox so Cloudflare can discover the Durable Object class
export { Sandbox as AgentSandbox } from "@cloudflare/sandbox";

// ---------------------------------------------------------------------------
// Environment bindings
// ---------------------------------------------------------------------------

export interface Env {
  AGENTOS_AGENT: AgentNamespace<AgentOSAgent>;
  AGENTOS_MCP: AgentNamespace<AgentOSMcpServer>;
  AI: Ai;
  ASSETS: Fetcher;
  VECTORIZE: VectorizeIndex;
  LOADER: any; // Dynamic Worker Loader — V8 isolate sandbox (JS/TS)
  SANDBOX: DurableObjectNamespace; // Sandbox SDK — full Linux container
  TELEMETRY_QUEUE: Queue; // Queue — guaranteed delivery telemetry pipeline
  HYPERDRIVE: Hyperdrive; // Hyperdrive — accelerated Supabase Postgres
  STORAGE: R2Bucket; // R2 — org/project-scoped file storage
  BROWSER: Fetcher; // Browser Rendering — headless Puppeteer on edge
  DISPATCHER?: any; // Dispatch Namespace — multi-tenant agent isolation
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  GMI_API_KEY?: string;
  E2B_API_KEY?: string;
  AUTH_JWT_SECRET?: string;
  BACKEND_INGEST_URL?: string;
  BACKEND_INGEST_TOKEN?: string;
  EDGE_INGEST_TOKEN?: string;  // alias for BACKEND_INGEST_TOKEN (backend→worker direction)
  BACKEND_PROXY_ONLY?: string;
  WORKER_PROXY_MODE?: string;  // "true" → run() delegates to backend, worker becomes thin proxy
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_API_TOKEN?: string;
  TELEGRAM_BOT_TOKEN?: string;
  DEFAULT_PLAN?: string;
  DEFAULT_PROVIDER: string;
  DEFAULT_MODEL: string;
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
      provider: "gmi",
      model: "deepseek-ai/DeepSeek-V3.2",
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
    // Initialize SQL table for telemetry outbox
    this.sql`CREATE TABLE IF NOT EXISTS ingest_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      endpoint TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      attempts INTEGER DEFAULT 0,
      next_retry_at REAL DEFAULT 0,
      last_error TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`;
  }

  // ── Callable Methods (RPC from client) ──────────────────────────

  private _isProxyMode(): boolean {
    const raw = String(this.env.WORKER_PROXY_MODE ?? "").trim().toLowerCase();
    return raw === "true" || raw === "1" || raw === "on" || raw === "yes";
  }

  /**
   * Proxy run() to backend /runtime-proxy/agent/run.
   * The backend runs the full harness (tools, memory, governance, compliance).
   * The worker just relays the request and formats the response.
   */
  private async _runViaBackend(input: string): Promise<TurnResult[]> {
    const config = this.state.config;
    const base = this._ingestBase();
    const started = Date.now();

    // Timeout: budget-aware (5 min default, up to 10 min for large budgets)
    const timeoutMs = Math.min((config.maxTurns || 50) * 15_000, 600_000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let resp: Response;
    try {
      resp = await this._safeFetch(`${base}/api/v1/runtime-proxy/agent/run`, {
        method: "POST",
        headers: this._ingestHeaders(),
        signal: controller.signal,
        body: JSON.stringify({
          agent_name: config.agentName || "agentos",
          task: input,
          org_id: config.orgId || "",
          project_id: config.projectId || "",
          channel: "worker",
          channel_user_id: this.name || "",
        }),
      });
    } catch (err: any) {
      clearTimeout(timer);
      const isTimeout = err.name === "AbortError";
      return [{
        turn: 1, content: "", toolResults: [], done: true,
        error: isTimeout ? `Backend timeout after ${timeoutMs}ms` : `Backend fetch error: ${err.message}`,
        costUsd: 0, model: config.model,
      }];
    }
    clearTimeout(timer);

    const data = await resp.json() as any;
    const elapsed = Date.now() - started;

    if (!resp.ok) {
      return [{
        turn: 1,
        content: "",
        toolResults: [],
        done: true,
        error: `Backend error (${resp.status}): ${data.detail || "unknown"}`,
        costUsd: 0,
        model: config.model,
      }];
    }

    // Record session locally for observability
    const sessionId = data.session_id || crypto.randomUUID().slice(0, 16);
    this._recordEvent({
      sessionId,
      turn: 0,
      eventType: "session.complete",
      action: "run_proxy",
      plan: normalizePlan(config.plan || this.env.DEFAULT_PLAN),
      status: data.success ? "ok" : "error",
      latencyMs: elapsed,
      costUsd: data.cost_usd || 0,
      details: { turns: data.turns, tool_calls: data.tool_calls, source: "backend_proxy" },
    });

    return [{
      turn: data.turns || 1,
      content: data.output || "",
      toolResults: [],
      done: true,
      error: data.success ? undefined : "Backend reported failure",
      costUsd: data.cost_usd || 0,
      model: config.model,
    }];
  }

  @callable()
  async run(input: string): Promise<TurnResult[]> {
    // Proxy mode: delegate entire run to backend
    if (this._isProxyMode()) {
      return this._runViaBackend(input);
    }

    // Local mode disabled — proxy mode is required in production
    return [{
      turn: 1,
      content: "",
      toolResults: [],
      done: true,
      error: "Local mode disabled",
      costUsd: 0,
      model: "",
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
    for (const key of changedKeys) {
      const oldValue = JSON.stringify((before as Record<string, unknown>)[key] ?? "");
      const newValue = JSON.stringify((updated as Record<string, unknown>)[key] ?? "");
      void this._sendIngest("/api/v1/edge-ingest/config/audit", {
        org_id: updated.orgId || "",
        agent_name: updated.agentName || "agentos",
        action: "config.update",
        field_changed: key,
        old_value: oldValue,
        new_value: newValue,
        change_reason: "worker_config_update",
        changed_by: "worker",
        created_at: Date.now() / 1000,
      });
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

  private async _isAuthorized(request: Request): Promise<boolean> {
    const secret = this.env.AUTH_JWT_SECRET;
    if (!secret) return true;
    const auth = request.headers.get("Authorization") || "";
    if (!auth.startsWith("Bearer ")) return false;
    const token = auth.slice(7).trim();
    return verifyHs256Jwt(token, secret);
  }

  // ── WebSocket (real-time streaming) ─────────────────────────────

  async onConnect(connection: Connection) {
    connection.send(JSON.stringify({ type: "connected", agent: this.state.config.agentName }));
  }

  async onMessage(connection: Connection, message: string | ArrayBuffer) {
    const data = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));

    if (data.type === "run") {
      const results = await this.run(data.input);
      for (const result of results) {
        connection.send(JSON.stringify({ type: "turn", ...result }));
      }
      connection.send(JSON.stringify({ type: "done" }));
    }
  }

  // ── Telemetry & Ingest ─────────────────────────────────────────

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
    this.sql`INSERT INTO otel_events (
      session_id, turn, event_type, action, plan, tier, provider, model, tool_name, status, latency_ms,
      input_tokens, output_tokens, cost_usd, details_json
    ) VALUES (
      ${input.sessionId}, ${turn}, ${input.eventType}, ${action}, ${plan}, ${tier}, ${provider}, ${model}, ${toolName}, ${status}, ${latencyMs},
      ${inputTokens}, ${outputTokens}, ${costUsd}, ${detailsJson}
    )`;

    // Best-effort mirror of event telemetry to backend control plane.
    void this._sendIngest(
      "/api/v1/edge-ingest/events",
      {
        events: [{
          session_id: input.sessionId,
          turn,
          event_type: input.eventType,
          action,
          plan,
          tier,
          provider,
          model,
          tool_name: toolName,
          status,
          latency_ms: latencyMs,
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          cost_usd: costUsd,
          details_json: detailsJson,
          created_at: Date.now() / 1000,
        }],
      },
    );
  }

  private _ingestHeaders(): Record<string, string> {
    const token = this.env.BACKEND_INGEST_TOKEN || "";
    if (!token) return { "Content-Type": "application/json" };
    return {
      "Content-Type": "application/json",
      "X-Edge-Token": token,
      "Authorization": `Bearer ${token}`,
    };
  }

  private _ingestBase(): string {
    return (this.env.BACKEND_INGEST_URL || "").trim().replace(/\/+$/, "");
  }

  private async _safeFetch(input: string, init?: RequestInit): Promise<Response> {
    return fetch(input, init);
  }

  private async _postIngest(endpoint: string, payload: Record<string, unknown>): Promise<void> {
    const base = this._ingestBase();
    if (!base || !this.env.BACKEND_INGEST_TOKEN) {
      throw new Error("backend_ingest_not_configured");
    }
    const resp = await this._safeFetch(`${base}${endpoint}`, {
      method: "POST",
      headers: this._ingestHeaders(),
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      throw new Error(`backend_ingest_http_${resp.status}`);
    }
  }

  private async _enqueueIngest(endpoint: string, payload: Record<string, unknown>, error: string): Promise<void> {
    this.sql`INSERT INTO ingest_outbox (endpoint, payload_json, attempts, next_retry_at, last_error, updated_at)
      VALUES (${endpoint}, ${JSON.stringify(payload)}, ${1}, ${Date.now() / 1000 + 5}, ${error.slice(0, 500)}, ${Date.now() / 1000})`;
  }

  private async _sendIngest(endpoint: string, payload: Record<string, unknown>): Promise<void> {
    // Primary: Cloudflare Queue (guaranteed delivery, non-blocking)
    if (this.env.TELEMETRY_QUEUE) {
      const type = endpoint.includes("/session") ? "session"
        : endpoint.includes("/turn") ? "turn"
        : endpoint.includes("/episode") ? "episode"
        : "event";
      try {
        await this.env.TELEMETRY_QUEUE.send({ type, payload });
        return;
      } catch {
        // Queue send failed — fall through to HTTP backup
      }
    }

    // Fallback: HTTP POST to backend (legacy, fragile)
    const base = this._ingestBase();
    if (!base || !this.env.BACKEND_INGEST_TOKEN) return;
    try {
      await this._postIngest(endpoint, payload);
    } catch (err: any) {
      await this._enqueueIngest(endpoint, payload, String(err?.message || err));
    }
  }

  private async _flushIngestOutbox(limit: number = 50): Promise<void> {
    const base = this._ingestBase();
    if (!base || !this.env.BACKEND_INGEST_TOKEN) return;
    const now = Date.now() / 1000;
    const rows = this.sql<{ id: number; endpoint: string; payload_json: string; attempts: number }>`
      SELECT id, endpoint, payload_json, attempts
      FROM ingest_outbox
      WHERE next_retry_at <= ${now}
      ORDER BY id ASC
      LIMIT ${Math.max(1, Math.min(limit, 500))}
    `;
    for (const row of rows) {
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(row.payload_json || "{}");
      } catch {
        this.sql`DELETE FROM ingest_outbox WHERE id = ${row.id}`;
        continue;
      }
      try {
        await this._postIngest(row.endpoint, payload);
        this.sql`DELETE FROM ingest_outbox WHERE id = ${row.id}`;
      } catch (err: any) {
        const attempts = Math.max(1, Number(row.attempts || 0) + 1);
        const backoffSec = Math.min(300, 2 ** Math.min(attempts, 8));
        this.sql`UPDATE ingest_outbox
          SET attempts = ${attempts},
              next_retry_at = ${now + backoffSec},
              last_error = ${String(err?.message || err).slice(0, 500)},
              updated_at = ${now}
          WHERE id = ${row.id}`;
      }
    }
  }

  private async _mirrorEpisodeToBackend(episodePayload: Record<string, unknown>): Promise<void> {
    await this._sendIngest("/api/v1/edge-ingest/episode", episodePayload);
  }

  private async _mirrorTurnToBackend(sessionId: string, turnPayload: Record<string, unknown>): Promise<void> {
    await this._sendIngest("/api/v1/edge-ingest/turn", {
      session_id: sessionId,
      ...turnPayload,
    });
  }

  private async _mirrorSessionToBackend(sessionId: string, input: string, results: TurnResult[]): Promise<void> {
    const last = results[results.length - 1];
    const output = last?.content || "";
    const status = last?.error ? "error" : "success";
    const totalCost = results.reduce((acc, r) => acc + (r.costUsd || 0), 0);
    const model = last?.model || this.state.config.model || "";
    await this._sendIngest("/api/v1/edge-ingest/session", {
      session_id: sessionId,
      org_id: this.state.config.orgId || "",
      project_id: this.state.config.projectId || "",
      agent_name: this.state.config.agentName || "agentos",
      status,
      input_text: input,
      output_text: output,
      model,
      trace_id: sessionId,
      parent_session_id: "",
      depth: 0,
      step_count: results.length,
      action_count: results.reduce((acc, r) => acc + ((r.toolResults || []).length), 0),
      wall_clock_seconds: 0,
      cost_total_usd: totalCost,
      created_at: Date.now() / 1000,
    });
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
    const signature = base64UrlToBytes(signatureB64);
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

// ---------------------------------------------------------------------------
// MCP Server Agent — exposes tools via Model Context Protocol
// ---------------------------------------------------------------------------

export class AgentOSMcpServer extends McpAgent<Env> {
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

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === "/health") {
      return Response.json({ status: "ok", version: "0.2.0" });
    }

    // ── Dispatch Namespace — multi-tenant agent routing ──
    // MUST run BEFORE routeAgentRequest() which would match /agents/* broadly
    // URL: /agents/dispatch/{org_slug}/{agent_name}
    // Routes to the customer's isolated worker in the dispatch namespace.
    // Routes to the customer's isolated worker in the dispatch namespace.
    // If worker not deployed: returns 503 with a clear error. No silent fallback.
    const dispatchMatch = url.pathname.match(/^\/agents\/dispatch\/([a-z0-9-]+)\/([a-z0-9-]+)/);
    if (dispatchMatch && env.DISPATCHER) {
      const [, orgSlug, agentName] = dispatchMatch;
      const workerName = `agentos-${orgSlug}-${agentName}`;
      const hasBody = ["POST", "PUT", "PATCH"].includes(request.method);
      const bodyText = hasBody ? await request.text().catch(() => "{}") : null;

      try {
        const userWorker = env.DISPATCHER.get(workerName);
        const dispatchReq = new Request(request.url, {
          method: request.method,
          headers: request.headers,
          ...(bodyText !== null ? { body: bodyText } : {}),
        });
        const dispatchResp = await userWorker.fetch(dispatchReq);

        // CF returns 400 "Invalid request" when the script doesn't exist
        if (dispatchResp.status === 400) {
          const respText = await dispatchResp.text();
          if (respText.includes("Invalid request")) {
            return Response.json({
              error: "agent_not_deployed",
              message: `Agent '${agentName}' is not deployed to the edge. Deploy it first via POST /api/v1/deploy/${agentName}, or try again later.`,
              worker_name: workerName,
            }, { status: 503 });
          }
          // Real 400 from the customer worker — pass through
          return new Response(respText, { status: 400, headers: { "Content-Type": "application/json" } });
        }

        return dispatchResp;
      } catch (e: any) {
        return Response.json({
          error: "agent_not_deployed",
          message: `Agent '${agentName}' is not deployed to the edge. Deploy it first via POST /api/v1/deploy/${agentName}, or try again later.`,
          worker_name: workerName,
          detail: e.message || "",
        }, { status: 503 });
      }
    }

    // Route Agents SDK requests: /agents/:agent-name/:instance-name
    // Runs AFTER dispatch routing so /agents/dispatch/* is handled separately
    const agentResponse = await routeAgentRequest(request, env);
    if (agentResponse) return agentResponse;

    // ── Telegram Webhook (edge-native chat) ──
    if (url.pathname === "/chat/telegram/webhook" && request.method === "POST") {
      const botToken = env.TELEGRAM_BOT_TOKEN;
      if (!botToken) return Response.json({ error: "TELEGRAM_BOT_TOKEN not set" }, { status: 503 });

      const payload = await request.json() as any;
      const msg = payload.message || payload.edited_message;
      if (!msg?.text) return Response.json({ ok: true });

      const chatId = msg.chat?.id;
      const text = msg.text || "";
      const messageId = msg.message_id;
      const tgApi = `https://api.telegram.org/bot${botToken}`;

      // Handle commands
      if (text.startsWith("/start")) {
        await fetch(`${tgApi}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text: `👋 Hi! Send me a message and I'll help.\n\nYour chat ID: \`${chatId}\``, parse_mode: "Markdown" }),
        });
        return Response.json({ ok: true });
      }
      if (text === "/myid") {
        await fetch(`${tgApi}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text: `Your chat ID: ${chatId}` }),
        });
        return Response.json({ ok: true });
      }

      // Send typing indicator
      await fetch(`${tgApi}/sendChatAction`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, action: "typing" }),
      });

      // Route to backend — same agent, same tools, same memory.
      // Telegram is just a channel, not a separate agent.
      const agentName = env.TELEGRAM_AGENT_NAME || "my-assistant";
      const backendUrl = env.BACKEND_INGEST_URL || "";
      const edgeToken = env.BACKEND_INGEST_TOKEN || "";
      try {
        const userInput = text.startsWith("/ask ") ? text.slice(5) : text;

        // Call runtime-proxy/agent/run — edge-token auth, full backend harness
        const resp = await fetch(`${backendUrl}/api/v1/runtime-proxy/agent/run`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${edgeToken}`,
          },
          body: JSON.stringify({
            agent_name: agentName,
            task: userInput,
            channel: "telegram",
            channel_user_id: String(chatId),
          }),
        });

        let output = "";
        if (resp.ok) {
          const data = await resp.json() as any;
          output = data.output || data.content || "";
          if (!output && data.turnResults) {
            const last = data.turnResults[data.turnResults.length - 1];
            output = last?.content || "";
          }
        } else {
          const errText = await resp.text();
          output = `Error (${resp.status}): ${errText.slice(0, 200)}`;
        }
        if (!output) output = "I processed your message but have no response.";

        // Send reply (split if > 4096 chars)
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
          body: JSON.stringify({ chat_id: chatId, text: `Sorry, error: ${err.message?.slice(0, 200)}` }),
        });
      }

      return Response.json({ ok: true });
    }

    // ── /cf/* — Cloudflare binding callbacks for backend ────────────
    // The backend calls these when it needs CF-specific resources.
    // Authenticated via edge token (same as backend ingest).

    if (url.pathname.startsWith("/cf/")) {
      const edgeToken = env.EDGE_INGEST_TOKEN || env.BACKEND_INGEST_TOKEN || "";
      if (!edgeToken) {
        return Response.json({ error: "edge_token_not_configured" }, { status: 503 });
      }
      const authHeader = request.headers.get("Authorization") || "";
      const xEdge = request.headers.get("X-Edge-Token") || "";
      const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : xEdge;
      if (token !== edgeToken) {
        return Response.json({ error: "invalid_edge_token" }, { status: 401 });
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
            const loaded = await env.LOADER.load(workerCode);
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeout);
            const result = await loaded.fetch("http://internal/run", { signal: controller.signal });
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

      return Response.json({ error: "unknown /cf endpoint" }, { status: 404 });
    }

    // Serve static assets (portal SPA)
    return env.ASSETS.fetch(request);
  },

  // ── Queue Consumer — writes telemetry to Supabase via Hyperdrive ──
  // Messages flow: Agent DO → TELEMETRY_QUEUE → this consumer → Supabase
  // Guaranteed delivery, batched writes, automatic retries.
  async queue(batch: MessageBatch<{ type: string; payload: Record<string, unknown> }>, env: Env): Promise<void> {
    if (!env.HYPERDRIVE) {
      batch.retryAll();
      return;
    }

    // Connect via Postgres.js + Hyperdrive (Worker-compatible driver)
    const postgres = (await import("postgres")).default;
    const sql = postgres(env.HYPERDRIVE.connectionString, {
      max: 5,
      fetch_types: false,
      prepare: true,
    });

    try {
      for (const msg of batch.messages) {
        const { type, payload: p } = msg.body;
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
              to_timestamp(${Number(p.created_at) || Date.now() / 1000})
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
              session_id, turn_number, event_type, action, plan, tier,
              provider, model, tool_name, status, latency_ms, details_json
            ) VALUES (
              ${p.session_id}, ${p.turn || 0}, ${p.event_type || ""},
              ${p.action || ""}, ${p.plan || ""}, ${p.tier || ""},
              ${p.provider || ""}, ${p.model || ""}, ${p.tool_name || ""},
              ${p.status || ""}, ${p.latency_ms || 0},
              ${JSON.stringify(p.details || {})}
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
