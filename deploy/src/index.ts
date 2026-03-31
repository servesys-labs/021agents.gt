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
} from "agents";
import { getSandbox, Sandbox } from "@cloudflare/sandbox";
// @ts-expect-error — ContainerProxy exists at runtime but may not be in type defs
import { ContainerProxy } from "@cloudflare/containers";
import {
  loadRuntimeEventsPage, replayOtelEventsAtCursor, buildRuntimeRunTree,
  writeEvalRun, writeEvalTrial, listEvalRuns, getEvalRun, listEvalTrialsByRun,
  createWebSocketSendWithBackpressure,
  type RuntimeEnv,
  type TurnResult,
} from "./runtime";
// streamRun removed — all execution goes through Cloudflare Workflows
import { getCircuitStatus } from "./runtime/tools";
import { parseJsonColumn } from "./runtime/parse-json-column";

// ── AgentSandbox — Sandbox with lifecycle hooks + controlled outbound ──
// Sandbox extends Container extends DurableObject.
// Per CF Containers docs: https://developers.cloudflare.com/containers/
//
// Lifecycle hooks give us visibility into OOM kills, crashes, and graceful shutdowns.
// outboundByHost lets sandbox code access platform resources (R2, KV) via HTTP.
// Internet is ENABLED because agents need npm install, pip install, git clone, curl, etc.
// Security: each container runs in its own VM (CF isolation), SSRF blocked by parent Worker.
export class AgentSandbox extends Sandbox<Env> {

  onStart() {
    console.log(`[sandbox] Started: ${this.ctx.id.toString().slice(0, 16)}`);
  }

  async onStop() {
    console.log(`[sandbox] Stopped: ${this.ctx.id.toString().slice(0, 16)}`);
  }

  onError(error: unknown) {
    console.error("[sandbox] Container error:", error);
    // Emit to telemetry queue if available for alerting
    if (this.env.TELEMETRY_QUEUE) {
      this.env.TELEMETRY_QUEUE.send({
        type: "event",
        payload: {
          event_type: "sandbox.error",
          error: String(error).slice(0, 500),
          instance_id: this.ctx.id.toString().slice(0, 16),
          created_at: new Date().toISOString(),
        },
      }).catch(() => {});
    }
  }
}

// Export ContainerProxy so outbound interception works
// (required by CF when using outbound handlers — see docs)
export { ContainerProxy };

// Static outbound handlers — give sandbox code controlled access to platform resources.
// Sandbox code can call http://platform.r2/path or http://platform.kv/key
// and the request is handled by the Worker (with full binding access), not sent to the internet.
(AgentSandbox as any).outboundByHost = {
  // R2 storage access: sandbox code can read/write files via http://platform.r2/{path}
  "platform.r2": async (request: Request, env: Env) => {
    if (!env.STORAGE) return new Response("R2 not configured", { status: 503 });
    const url = new URL(request.url);
    const key = url.pathname.slice(1); // strip leading /
    if (!key) return new Response("Key required", { status: 400 });

    if (request.method === "GET") {
      const obj = await env.STORAGE.get(key);
      if (!obj) return new Response("Not found", { status: 404 });
      return new Response(obj.body, {
        headers: { "Content-Type": obj.httpMetadata?.contentType || "application/octet-stream" },
      });
    }
    if (request.method === "PUT") {
      const body = await request.arrayBuffer();
      await env.STORAGE.put(key, body);
      return new Response("OK", { status: 200 });
    }
    return new Response("Method not allowed", { status: 405 });
  },

  // KV access: sandbox code can read config via http://platform.kv/{key}
  "platform.kv": async (request: Request, env: Env) => {
    if (!env.AGENT_PROGRESS_KV) return new Response("KV not configured", { status: 503 });
    const url = new URL(request.url);
    const key = url.pathname.slice(1);
    if (!key) return new Response("Key required", { status: 400 });

    if (request.method === "GET") {
      const value = await env.AGENT_PROGRESS_KV.get(key);
      if (value === null) return new Response("Not found", { status: 404 });
      return new Response(value);
    }
    return new Response("Method not allowed — KV is read-only from sandbox", { status: 405 });
  },
};

// Re-export Workflow so Cloudflare can discover it
export { AgentRunWorkflow } from "./workflow";
import type { RunOutput } from "./workflow";

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
  WHATSAPP_APP_SECRET?: string;   // Meta HMAC verification for WhatsApp webhooks
  WHATSAPP_VERIFY_TOKEN?: string; // Meta handshake verification token
  SLACK_SIGNING_SECRET?: string;  // Slack request signature verification
  INSTAGRAM_APP_SECRET?: string;  // Meta HMAC verification for Instagram webhooks
  INSTAGRAM_VERIFY_TOKEN?: string;// Meta handshake verification token for Instagram
  FACEBOOK_APP_SECRET?: string;   // Meta HMAC verification for Messenger webhooks
  FACEBOOK_VERIFY_TOKEN?: string; // Meta handshake verification token for Messenger
  ENABLE_LANGCHAIN_TOOLS?: string;
  VAPI_API_KEY?: string;         // Vapi API key (for make-voice-call tool)
  AGENT_RUN_WORKFLOW?: any;      // Cloudflare Workflow for durable agent runs
  AGENT_PROGRESS_KV?: KVNamespace; // KV for workflow progress events
  CONTROL_PLANE?: { fetch: (url: string, init?: RequestInit) => Promise<Response> }; // Service binding to control-plane Worker
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


function normalizePlan(value?: string): string {
  const raw = (value || "").trim().toLowerCase();
  if (!raw) return "standard";
  if (raw === "balanced") return "standard";
  if (raw === "manual") return "manual";
  return ["basic", "standard", "premium", "code", "dedicated", "private"].includes(raw) ? raw : "standard";
}

// ---------------------------------------------------------------------------
// Email helper — build a simple MIME reply message
// ---------------------------------------------------------------------------

function buildMIMEString(opts: { from: string; to: string; subject: string; body: string; inReplyTo?: string }): string {
  const messageId = `<${crypto.randomUUID()}@agentos.dev>`;

  let mime = `From: ${opts.from}\r\n`;
  mime += `To: ${opts.to}\r\n`;
  mime += `Subject: ${opts.subject}\r\n`;
  mime += `Message-ID: ${messageId}\r\n`;
  mime += `Date: ${new Date().toUTCString()}\r\n`;
  if (opts.inReplyTo) {
    mime += `In-Reply-To: ${opts.inReplyTo}\r\n`;
    mime += `References: ${opts.inReplyTo}\r\n`;
  }
  mime += `MIME-Version: 1.0\r\n`;
  mime += `Content-Type: text/plain; charset=UTF-8\r\n`;
  mime += `Content-Transfer-Encoding: 7bit\r\n`;
  mime += `\r\n`;
  mime += opts.body;
  return mime;
}

// ---------------------------------------------------------------------------
// AgentOS Agent — main agent with @callable methods
// ---------------------------------------------------------------------------

export class AgentOSAgent extends Agent<Env, AgentState> {
  // Concurrency guard: prevent overlapping runs from corrupting conversation state.
  // DOs are single-threaded but async yields allow interleaving.
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
    // ── Schema migrations with version tracking ────────────────────
    // blockConcurrencyWhile ensures NO requests interleave during init.
    // All schema changes, hydration, and checkpoint recovery happen atomically.
    // See: https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/

    // Migration tracking table
    this.sql`CREATE TABLE IF NOT EXISTS _sql_schema_migrations (
      id INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`;

    const schemaVersion = this.sql<{ version: number }>`
      SELECT COALESCE(MAX(id), 0) as version FROM _sql_schema_migrations
    `[0]?.version || 0;

    // Phase 1.5: All migrations wrapped in transactions for atomicity.
    // Partial migration = corrupted schema. BEGIN/COMMIT prevents this.

    if (schemaVersion < 1) {
      this.ctx.storage.transactionSync(() => {
        this.sql`CREATE TABLE IF NOT EXISTS conversation_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          channel TEXT NOT NULL DEFAULT '',
          created_at REAL NOT NULL DEFAULT (unixepoch('now'))
        )`;
        this.sql`CREATE INDEX IF NOT EXISTS idx_conv_created_at ON conversation_messages(created_at)`;
        this.sql`CREATE INDEX IF NOT EXISTS idx_conv_role ON conversation_messages(role)`;
        this.sql`INSERT INTO _sql_schema_migrations (id) VALUES (1)`;
      });
    }

    if (schemaVersion < 2) {
      this.ctx.storage.transactionSync(() => {
        this.sql`CREATE INDEX IF NOT EXISTS idx_conv_role_id ON conversation_messages(role, id)`;
        this.sql`INSERT INTO _sql_schema_migrations (id) VALUES (2)`;
      });
    }

    if (schemaVersion < 3) {
      this.ctx.storage.transactionSync(() => {
        // v3: Circuit breaker state — persists across DO restarts so flaky
        // tools stay blocked after redeploy (Phase 1.1 hardening)
        this.sql`CREATE TABLE IF NOT EXISTS circuit_breaker_state (
          tool_name TEXT PRIMARY KEY,
          state TEXT NOT NULL DEFAULT 'closed' CHECK(state IN ('closed','open','half_open')),
          failure_count INTEGER NOT NULL DEFAULT 0,
          success_count INTEGER NOT NULL DEFAULT 0,
          last_failure_at REAL NOT NULL DEFAULT 0,
          updated_at REAL NOT NULL DEFAULT (unixepoch('now'))
        )`;
        this.sql`INSERT INTO _sql_schema_migrations (id) VALUES (3)`;
      });
    }

    if (schemaVersion < 4) {
      // v4: Agent-to-agent mailbox for inter-agent IPC (Phase 6.1)
      const { createMailboxTable } = await import("./runtime/mailbox");
      this.ctx.storage.transactionSync(() => {
        createMailboxTable(this.sql.bind(this));
        this.sql`INSERT INTO _sql_schema_migrations (id) VALUES (4)`;
      });
    }

    // Phase 1.1: Wire DO SQLite for persistent circuit breaker state
    {
      const { setCircuitBreakerSql, preloadCircuitStates } = await import("./runtime/tools");
      const sqlExec = (query: string, ...params: any[]) => {
        return (this.sql as any).exec(query, ...params).toArray();
      };
      setCircuitBreakerSql(sqlExec);

      // P3 Fix: Preload persisted circuit breaker state on cold start.
      // Without this, all tools start as "closed" (healthy) even if they
      // were "open" (blocked) before DO eviction. This causes cascading
      // failures: restart → flaky tool retried → fails 5x → reopens circuit.
      try {
        preloadCircuitStates(sqlExec);
      } catch {}
    }

    // Hydrate from Supabase if DO SQLite is empty (cold start / post-deploy)
    // Load 24 messages — caps memory usage on cold start hydration
    const localCount = this.sql<{ cnt: number }>`SELECT COUNT(*) as cnt FROM conversation_messages`;
    if ((localCount[0]?.cnt || 0) === 0 && this.env.HYPERDRIVE) {
      try {
        const { loadConversationHistory } = await import("./runtime/db");
        const messages = await loadConversationHistory(this.env.HYPERDRIVE, this.name, 24);
        for (const msg of messages) {
          this.sql`INSERT INTO conversation_messages (role, content, channel, created_at)
            VALUES (${msg.role}, ${msg.content.slice(0, 8000)}, ${msg.channel}, ${msg.created_at || new Date().toISOString()})`;
        }
      } catch {}
    }

    // ── Workspace Hibernation Recovery ──────────────────────────────
    // Restore workspace files and working memory from DO SQLite checkpoint.
    // SQLite survives hibernation; R2 is the fallback if DO was fully evicted.
    try {
      const { loadCheckpointFromSQLite, loadFilesFromSQLite, ensureWorkspaceTables } = await import("./runtime/workspace-persistence");
      ensureWorkspaceTables(this.sql);

      // Restore workspace files from SQLite
      const files = loadFilesFromSQLite(this.sql, this.name);
      if (files.length > 0) {
        console.log(`[workspace] Restored ${files.length} files from SQLite checkpoint`);
      }

      // Restore working memory, cost accumulator, and turn count from checkpoint
      const checkpoint = loadCheckpointFromSQLite(this.sql, this.name);
      if (checkpoint) {
        if (checkpoint.working_memory && Object.keys(checkpoint.working_memory).length > 0) {
          this.setState({
            ...this.state,
            working: checkpoint.working_memory,
            totalCostUsd: checkpoint.cumulative_cost_usd,
            turnCount: checkpoint.turn_count,
          });
        }
        console.log(`[workspace] Restored checkpoint: ${checkpoint.turn_count} turns, $${checkpoint.cumulative_cost_usd.toFixed(6)} cost`);
      }
    } catch {}

    // ── Initiate checkpoint schedule ────────────────────────────────
    // Kick off the self-rescheduling checkpoint chain. Without this,
    // checkpointWorkspace() is never called (it relies on being scheduled).
    try {
      await this.schedule(Date.now() + 30_000, "checkpointWorkspace");
    } catch {}
  }

  // ── Hibernation Checkpoint (periodic save) ───────────────────────

  /**
   * Scheduled callback: save workspace + state to DO SQLite every 30 seconds.
   * If the DO hibernates between checkpoints, SQLite retains the last one.
   * Called via `this.schedule(Date.now() + 30_000, "checkpointWorkspace")`.
   */
  async checkpointWorkspace() {
    try {
      const { saveCheckpointToSQLite, saveCheckpointToR2 } = await import("./runtime/workspace-persistence");
      const config = this.state.config;
      const checkpoint = {
        session_id: this.name,
        org_id: config.orgId || "",
        agent_name: config.agentName || "",
        files: [],  // Files already persisted individually via saveFileToSQLite
        working_memory: this.state.working,
        cumulative_cost_usd: this.state.totalCostUsd,
        turn_count: this.state.turnCount,
        last_model: config.model || "",
        conversation_context: this._loadConversationHistory(24),
        created_at: new Date().toISOString(),
      };
      saveCheckpointToSQLite(this.sql, checkpoint);

      // R2 backup (async, non-blocking)
      if (this.env.STORAGE) {
        saveCheckpointToR2(
          this.env.STORAGE,
          config.orgId || "",
          config.agentName || "",
          this.name,
          checkpoint,
        ).catch(() => {});
      }
    } catch {}

    // Re-schedule for next checkpoint (30 seconds)
    try {
      await this.schedule(Date.now() + 30_000, "checkpointWorkspace");
    } catch {}
  }

  // ── Callable Methods (RPC from client) ──────────────────────────

  @callable()
  async run(
    input: string,
    opts?: {
      delegation?: {
        parent_session_id?: string;
        parent_trace_id?: string;
        parent_agent_name?: string;
        parent_depth?: number;
      };
    },
  ): Promise<TurnResult[]> {
    // Always execute on edge runtime.
    return this._runAtEdge(input, opts);
  }

  /**
   * Run the agent via Cloudflare Workflow (durable, crash-safe, parallel tools).
   * Falls back to legacy edgeRun if Workflow bindings unavailable.
   */
  private async _runAtEdge(
    input: string,
    opts?: {
      delegation?: {
        parent_session_id?: string;
        parent_trace_id?: string;
        parent_agent_name?: string;
        parent_depth?: number;
      };
    },
  ): Promise<TurnResult[]> {
    const config = this.state.config;
    const started = Date.now();

    // ── Workflow path (primary) ──
    if (this.env.AGENT_RUN_WORKFLOW) {
      const history = this._loadConversationHistory(24);
      const progressKey = `rpc:${this.name}:${Date.now()}`;
      const instance = await this.env.AGENT_RUN_WORKFLOW.create({
        params: {
          agent_name: config.agentName || "agentos",
          input,
          org_id: config.orgId || "",
          project_id: config.projectId || "",
          channel: "rpc",
          channel_user_id: "",
          history: history.map((m: any) => ({ role: m.role, content: m.content })),
          progress_key: progressKey,
          parent_session_id: opts?.delegation?.parent_session_id,
          parent_depth: opts?.delegation?.parent_depth,
        },
      });

      // Poll for completion
      const maxWait = 300_000;
      const pollStart = Date.now();
      while (Date.now() - pollStart < maxWait) {
        await new Promise(r => setTimeout(r, 2000));
        const status = await instance.status().catch(() => ({ status: "unknown" as const }));
        if (status.status === "complete") {
          const out = (status as any).output as RunOutput | undefined;
          this._appendConversationMessage("user", input, "rpc");
          this._appendConversationMessage("assistant", out?.output || "", "rpc");
          return [{
            output: out?.output || "",
            session_id: out?.session_id || "",
            trace_id: out?.trace_id || "",
            tool_calls: out?.tool_calls || 0,
            cost_usd: out?.cost_usd || 0,
            stop_reason: "complete",
            wall_clock_ms: Date.now() - started,
          }] as any;
        }
        if (status.status === "errored" || status.status === "terminated") {
          throw new Error((status as any).error?.message || "Workflow failed");
        }
      }
      throw new Error("Workflow timed out");
    }

    // Workflow unavailable
    throw new Error("AGENT_RUN_WORKFLOW binding not configured. Deploy with Workflows enabled.");
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
            created_at: new Date().toISOString(),
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

  private _getConversationCount(): number {
    try {
      const rows = this.sql<{ cnt: number }>`SELECT COUNT(*) as cnt FROM conversation_messages`;
      return rows[0]?.cnt || 0;
    } catch {
      return 0;
    }
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
      VALUES (${role}, ${clean.slice(0, 8000)}, ${channel || ""}, ${new Date().toISOString()})`;
    // Prune: keep last 100 messages to prevent unbounded growth
    this.sql`DELETE FROM conversation_messages WHERE id NOT IN (
      SELECT id FROM conversation_messages ORDER BY id DESC LIMIT 100
    )`;
    // 2. Supabase (durable, survives deploys) — retry up to 3 times with backoff
    if (this.env.HYPERDRIVE) {
      const msg = {
        agent_name: this.state.config.agentName || this.name,
        instance_id: this.name,
        role,
        content: clean.slice(0, 8000),
        channel: channel || "",
      };
      const hyperdrive = this.env.HYPERDRIVE;
      (async () => {
        const { writeConversationMessage } = await import("./runtime/db");
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            await writeConversationMessage(hyperdrive, msg);
            return; // success
          } catch (err) {
            if (attempt < 2) {
              // Exponential backoff: 500ms, 1500ms
              await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
            } else {
              console.error("[conversation] Supabase write failed after 3 attempts:", err);
            }
          }
        }
      })().catch(() => {});
    }
  }

  private async _isAuthorized(request: Request): Promise<boolean> {
    const url = new URL(request.url);
    // Internal service binding calls are trusted (CF enforces this)
    if (url.hostname === "internal") return true;

    const auth = request.headers.get("Authorization") || "";
    if (!auth.startsWith("Bearer ")) return false;
    const token = auth.slice(7).trim();
    if (!token) return false;

    // Check SERVICE_TOKEN first
    const serviceToken = String(this.env.SERVICE_TOKEN || "").trim();
    if (serviceToken && token === serviceToken) return true;

    // Check JWT
    const secret = String(this.env.AUTH_JWT_SECRET || "").trim();
    if (secret) return verifyHs256Jwt(token, secret);

    // No valid auth method succeeded — deny access
    return false;
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
    // Use DO name as the source of truth — this.state.config may still be the
    // default initialState if the DO was just created and hasn't run yet.
    const agentName = this.state.config.agentName !== "agentos"
      ? this.state.config.agentName
      : this.name; // DO name encodes org-agent-user, always accurate
    connection.send(JSON.stringify({
      type: "connected",
      agent: agentName,
      instance_id: this.name,
      session_affinity: true,
      history_count: this._getConversationCount(),
    }));
  }

  async onMessage(connection: Connection, message: string | ArrayBuffer) {
    const data = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));

    // ── WebSocket reconnect: replay missed events from KV ──────────
    if (data.type === "reconnect" && typeof data.from_seq === "number") {
      const kv = this.env.AGENT_PROGRESS_KV;
      if (kv && data.progress_key) {
        const raw = await kv.get(data.progress_key);
        if (raw) {
          const events = JSON.parse(raw);
          const missed = events.filter((e: any) => (e._seq || 0) > data.from_seq);
          for (const event of missed) {
            connection.send(JSON.stringify(event));
          }
          connection.send(JSON.stringify({ type: "reconnect_complete", events_sent: missed.length, latest_seq: events.length }));
        }
      }
      return; // Don't process as a regular message
    }

    // ── WebSocket auth: validate token before allowing run commands ──
    if (data.type === "auth") {
      const token = String(data.token || "");
      if (!token) {
        connection.send(JSON.stringify({ type: "error", message: "auth: token required" }));
        return;
      }
      // Validate JWT or API key via control-plane service binding
      try {
        const authResp = await this.env.CONTROL_PLANE?.fetch?.("https://api/api/v1/auth/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        });
        if (!authResp || !authResp.ok) {
          connection.send(JSON.stringify({ type: "error", message: "auth: invalid token", code: "AUTH_FAILED" }));
          connection.close(4001, "Unauthorized");
          return;
        }
        const authData = await authResp.json() as { org_id?: string; user_id?: string };
        (connection as any).__authenticated = true;
        (connection as any).__orgId = authData.org_id || "";
        (connection as any).__userId = authData.user_id || "";
        connection.send(JSON.stringify({ type: "auth_ok", org_id: authData.org_id }));
      } catch {
        // If control-plane unavailable, validate locally via JWT
        // For now, accept token if it looks like a JWT (has 3 dot-separated parts)
        const isJwtShape = token.split(".").length === 3;
        if (isJwtShape) {
          (connection as any).__authenticated = true;
          connection.send(JSON.stringify({ type: "auth_ok" }));
        } else {
          connection.send(JSON.stringify({ type: "error", message: "auth: invalid token format" }));
          connection.close(4001, "Unauthorized");
        }
      }
      return;
    }

    // ── Auth gate: reject commands from unauthenticated connections ──
    if (data.type === "run" && !(connection as any).__authenticated) {
      connection.send(JSON.stringify({ type: "error", message: "Send { type: 'auth', token: '...' } before running commands", code: "AUTH_REQUIRED" }));
      return;
    }

    // ── Twilio ConversationRelay voice handling ──────────────────────
    console.log("[onMessage] Received type:", data.type, "keys:", Object.keys(data).join(","));

    if (data.type === "setup" && data.callSid) {
      // ConversationRelay connected — store call metadata on the connection
      (connection as any).__voiceMode = true;
      (connection as any).__voiceCallSid = data.callSid || "";
      return;
    }

    if (data.type === "prompt" && (connection as any).__voiceMode) {
      const userText = (data.voicePrompt || "").trim();
      if (!userText) return;

      try {
        const config = this.state.config;
        const runtimeEnv: RuntimeEnv = {
          AI: this.env.AI, HYPERDRIVE: this.env.HYPERDRIVE, VECTORIZE: this.env.VECTORIZE,
          STORAGE: this.env.STORAGE, SANDBOX: this.env.SANDBOX, LOADER: this.env.LOADER,
          TELEMETRY_QUEUE: this.env.TELEMETRY_QUEUE, BROWSER: this.env.BROWSER,
          AI_GATEWAY_ID: this.env.AI_GATEWAY_ID, AI_GATEWAY_TOKEN: this.env.AI_GATEWAY_TOKEN,
          BRAVE_SEARCH_KEY: this.env.BRAVE_SEARCH_KEY,
          CLOUDFLARE_ACCOUNT_ID: this.env.CLOUDFLARE_ACCOUNT_ID,
          CLOUDFLARE_API_TOKEN: this.env.CLOUDFLARE_API_TOKEN,
          OPENROUTER_API_KEY: this.env.OPENROUTER_API_KEY,
          DEFAULT_PROVIDER: this.env.DEFAULT_PROVIDER || config.provider || "openrouter",
          DEFAULT_MODEL: this.env.DEFAULT_MODEL || config.model || "openai/gpt-5.4-mini",
          DO_SQL: this.sql.bind(this), DO_SESSION_ID: this.name,
        };

        let response = "I didn't catch that.";
        if (this.env.AGENT_RUN_WORKFLOW) {
          const history = this._loadConversationHistory(12);
          const inst = await this.env.AGENT_RUN_WORKFLOW.create({
            params: {
              agent_name: config.agentName || "agentos", input: userText,
              org_id: config.orgId || "", project_id: config.projectId || "",
              channel: "voice", channel_user_id: "", history: history.map((m: any) => ({ role: m.role, content: m.content })),
              progress_key: `voice:${this.name}:${Date.now()}`,
            },
          });
          // Poll for completion (voice needs faster response — 30s max)
          for (let i = 0; i < 15; i++) {
            await new Promise(r => setTimeout(r, 2000));
            const st = await inst.status().catch(() => ({ status: "unknown" as const }));
            if (st.status === "complete") { response = ((st as any).output?.output || "").trim() || response; break; }
            if (st.status === "errored") break;
          }
          this._appendConversationMessage("user", userText, "voice");
          this._appendConversationMessage("assistant", response, "voice");
        } else {
          response = "Voice processing requires Workflow binding. Please contact support.";
        }
        // Strip markdown for voice
        response = response.replace(/#{1,6}\s*/g, "").replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1")
          .replace(/`{1,3}[^`]*`{1,3}/g, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
          .replace(/^[-*•]\s*/gm, "").replace(/\n/g, " ").trim();

        connection.send(JSON.stringify({ type: "text", token: response, last: true }));
      } catch (err) {
        console.error("[VoiceRelay] Error:", err);
        connection.send(JSON.stringify({ type: "text", token: "Sorry, something went wrong.", last: true }));
      }
      return;
    }

    if (data.type === "interrupt" && (connection as any).__voiceMode) {
      return; // Twilio interruption — no action needed
    }

    // Reset conversation history
    if (data.type === "reset" || data.type === "new") {
      this.sql`DELETE FROM conversation_messages`;
      connection.send(JSON.stringify({ type: "reset", ok: true }));
      return;
    }

    // Auto-register tools on first run if configured
    // }

    if (data.type === "feedback") {
      // P0 Fix: Validate rating input
      const VALID_RATINGS = new Set(["positive", "negative", "neutral"]);
      const rawRating = String(data.rating || "neutral");
      const validatedRating = VALID_RATINGS.has(rawRating) ? rawRating : "neutral";

      // P0 Fix: Client-generated idempotency key prevents duplicates
      const feedbackId = String(data.feedback_id || crypto.randomUUID().slice(0, 12));
      const sessionId = String(data.session_id || "");
      const turnNum = Number(data.turn || 0);
      const comment = String(data.comment || "").slice(0, 2000);
      const messageContent = String(data.message_content || "").slice(0, 2000);
      const userId = String(data.user_id || ""); // P1 Fix: Track user attribution

      if (this.env.HYPERDRIVE) {
        import("./runtime/db").then(async ({ getDb }) => {
          const sql = await getDb(this.env.HYPERDRIVE);
          await sql`
            INSERT INTO user_feedback (id, session_id, turn_number, rating, comment, message_preview, user_id, org_id, agent_name, channel, created_at)
            VALUES (${feedbackId}, ${sessionId}, ${turnNum},
                    ${validatedRating}, ${comment}, ${messageContent},
                    ${userId}, ${data.org_id || ""}, ${data.agent_name || ""}, 'websocket', ${new Date().toISOString()})
            ON CONFLICT (id) DO NOTHING
          `.catch((e: unknown) => console.error("[feedback] Write failed:", e)); // P1 Fix: Log failures
        }).catch((e: unknown) => console.error("[feedback] DB init failed:", e));
      }
      connection.send(JSON.stringify({ type: "feedback_ack", ok: true, feedback_id: feedbackId }));
      return;
    }

    if (data.type === "run") {
      const config = this.state.config;
      const inputText = String(data.input || "");
      const history = this._loadConversationHistory(24);
      const wsAgentName = data.agent_name || config.agentName || "agentos";

      try {
        if (!this.env.AGENT_RUN_WORKFLOW || !this.env.AGENT_PROGRESS_KV) {
          throw new Error("Workflow bindings not configured");
        }

        const progressKey = `ws:${this.name}:${Date.now()}`;
        const instance = await this.env.AGENT_RUN_WORKFLOW.create({
          params: {
            agent_name: wsAgentName, input: inputText,
            org_id: data.org_id || config.orgId || "",
            project_id: data.project_id || config.projectId || "",
            channel: data.channel || "websocket",
            channel_user_id: data.channel_user_id || "",
            history: history.map((m: any) => ({ role: m.role, content: m.content })),
            progress_key: progressKey,
          },
        });

        // Poll KV for progress events → push to WebSocket client in real-time
        let lastIdx = 0;
        let done = false;
        const maxWait = 300_000;
        const pollStart = Date.now();

        while (!done && Date.now() - pollStart < maxWait && connection.readyState === 1) {
          await new Promise(r => setTimeout(r, 500));
          try {
            const raw = await this.env.AGENT_PROGRESS_KV.get(progressKey);
            if (!raw) continue;
            const events = JSON.parse(raw) as any[];
            for (let i = lastIdx; i < events.length; i++) {
              try { connection.send(JSON.stringify(events[i])); } catch { done = true; break; }
              if (events[i].type === "done") {
                done = true;
                this._appendConversationMessage("user", inputText, data.channel || "websocket");
                this._appendConversationMessage("assistant", events[i].output || "", data.channel || "websocket");
                // Billing
                if (this.env.HYPERDRIVE && events[i].cost_usd > 0) {
                  const { writeBillingRecord } = await import("./runtime/db");
                  writeBillingRecord(this.env.HYPERDRIVE, {
                    session_id: events[i].session_id || "", org_id: data.org_id || "",
                    agent_name: wsAgentName, model: "workflow",
                    input_tokens: 0, output_tokens: 0,
                    cost_usd: events[i].cost_usd || 0, plan: "standard",
                    trace_id: events[i].trace_id || "",
                  }).catch(() => {});
                }
              }
              if (events[i].type === "error") done = true;
            }
            lastIdx = events.length;
          } catch {}
          // Check Workflow status
          if (!done) {
            try {
              const st = await instance.status();
              if (st.status === "errored" || st.status === "terminated") {
                connection.send(JSON.stringify({ type: "error", message: (st as any).error?.message || "Run failed" }));
                done = true;
              }
            } catch {}
          }
        }

        // Best-effort cancellation on client disconnect.
        // The workflow is the execution engine; if the client drops, we should avoid continuing to spend tokens/tools.
        // Workflow APIs vary across environments, so we duck-type terminate/cancel if available.
        if (!done && connection.readyState !== 1) {
          try { await (instance as any).terminate?.(); } catch {}
          try { await (instance as any).cancel?.(); } catch {}
        }
      } catch (err) {
        try { connection.send(JSON.stringify({ type: "error", message: String(err) })); } catch {}
        this._appendConversationMessage("user", inputText, data.channel || "websocket");
        this._appendConversationMessage("assistant", "[Error]", data.channel || "websocket");
      }
    }
  }

  // ── Email entrypoint ─────────────────────────────────────────────
  // Receives inbound emails routed via CF Email Routing → agent DO.
  // Parses the email, runs the agent with the email body as input,
  // and replies to the sender with the agent's response.

  async onEmail(email: ForwardableEmailMessage) {
    const from = email.from;
    const to = email.to;
    const subject = email.headers.get("subject") || "(no subject)";
    const messageId = email.headers.get("message-id") || "";

    // Read the email body (text/plain preferred, fall back to raw)
    let body = "";
    try {
      const reader = email.raw.getReader();
      const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }
      const raw = new TextDecoder().decode(
        chunks.reduce((acc, c) => new Uint8Array([...acc, ...c]), new Uint8Array()),
      );
      // Extract text/plain body from raw MIME (simple heuristic)
      const plainMatch = raw.match(/Content-Type:\s*text\/plain[\s\S]*?\r?\n\r?\n([\s\S]*?)(?:\r?\n--|\r?\n\r?\n)/i);
      body = plainMatch ? plainMatch[1].trim() : raw.slice(0, 4000);
    } catch {
      body = `Email from ${from}: ${subject}`;
    }

    const input = `[Email from ${from}]\nSubject: ${subject}\n\n${body}`.slice(0, 8000);

    console.log(`[onEmail] Received from ${from}, subject: "${subject}", body length: ${body.length}`);

    // Run the agent
    try {
      const results = await this.run(input);
      const output = (results[0] as any)?.output || "I received your email but couldn't generate a response.";

      // Reply to sender using raw MIME via email.reply()
      const replyMime = buildMIMEString({
        from: to,
        to: from,
        subject: `Re: ${subject}`,
        body: output,
        inReplyTo: messageId,
      });
      await email.reply(new Response(replyMime) as any);

      // Log to conversation
      this._appendConversationMessage("user", input, "email");
      this._appendConversationMessage("assistant", output, "email");

      // Telemetry
      if (this.env.TELEMETRY_QUEUE) {
        this.env.TELEMETRY_QUEUE.send({
          type: "event",
          payload: {
            event_type: "email.processed",
            agent_name: this.state.config.agentName,
            from_email: from,
            subject,
            cost_usd: (results[0] as any)?.cost_usd || 0,
            created_at: new Date().toISOString(),
          },
        }).catch(() => {});
      }
    } catch (err) {
      console.error(`[onEmail] Agent run failed for email from ${from}:`, err);
      try {
        const errMime = buildMIMEString({
          from: to,
          to: from,
          subject: `Re: ${subject}`,
          body: "I'm sorry, I wasn't able to process your email at this time. Please try again later.",
          inReplyTo: messageId,
        });
        await email.reply(new Response(errMime) as any);
      } catch {}
    }
  }

  // ── P3: Prioritized flush on DO eviction ────────────────────────
  // Cloudflare Agents SDK calls onStop before the DO is evicted.
  // Flush billing > session > telemetry in priority order.
  async onStop() {
    try {
      const { prioritizedFlush, buildFlushTasks } = await import("./runtime/do-lifecycle");
      const tasks = buildFlushTasks(this.env as any, {
        sessionId: this.name,
        orgId: this.state?.config?.orgId || "",
        agentName: this.state?.config?.agentName || "",
        totalCostUsd: this.state?.totalCostUsd || 0,
        turnCount: this.state?.turnCount || 0,
      });
      await prioritizedFlush(tasks);
    } catch {}
  }

  // ── Internal HTTP (async run from REST invoke) ──────────────────
  // Called by the Worker fetch handler via ctx.waitUntil(agent.fetch(...))
  // Runs the agent in the DO context (no timeout) and writes result to Supabase.

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Voice relay — WebSocket upgrade for Twilio ConversationRelay
    if (url.pathname === "/voice/relay") {
      const upgradeHeader = request.headers.get("Upgrade") || "";
      if (upgradeHeader.toLowerCase() === "websocket") {
        return this._handleVoiceRelay(request);
      }
      return Response.json({ error: "WebSocket upgrade required" }, { status: 426 });
    }

    // /run/workflow removed — /run now uses Workflow as primary path


    if (url.pathname === "/run" && request.method === "POST") {
      if (!(await this._isAuthorized(request))) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      const data = await request.json() as any;
      const inputText = String(data.input || "");
      const agentName = data.agent_name || this.state.config.agentName || "agentos";

      // Pre-run credit check — reject early if org has no credits
      const runOrgId = data.org_id || this.state.config.orgId || "";
      if (runOrgId && this.env.HYPERDRIVE) {
        try {
          const { getDb } = await import("./runtime/db");
          const sql = await getDb(this.env.HYPERDRIVE);
          const [bal] = await sql`SELECT balance_usd FROM org_credit_balance WHERE org_id = ${runOrgId}`;
          if (!bal || Number(bal.balance_usd) <= 0) {
            return Response.json({
              error: "Insufficient credits. Purchase credits at https://app.oneshots.co/settings?tab=billing",
              code: "insufficient_credits",
            }, { status: 402 });
          }
        } catch {} // Don't block on credit check failure
      }

      // ── Workflow path (durable, crash-safe) ──
      if (this.env.AGENT_RUN_WORKFLOW && this.env.AGENT_PROGRESS_KV) {
        const history = this._loadConversationHistory(24);
        const progressKey = `run:${this.name}:${Date.now()}`;

        try {
          const instance = await this.env.AGENT_RUN_WORKFLOW.create({
            params: {
              agent_name: agentName,
              input: inputText,
              org_id: data.org_id || this.state.config.orgId || "",
              project_id: data.project_id || this.state.config.projectId || "",
              channel: data.channel || "rest",
              channel_user_id: data.channel_user_id || "",
              history: history.map((m: any) => ({ role: m.role, content: m.content })),
              progress_key: progressKey,
              ...(data.system_prompt_override ? { system_prompt_override: data.system_prompt_override } : {}),
              ...(data.budget_limit_usd_override ? { budget_limit_usd_override: data.budget_limit_usd_override } : {}),
              ...(data.media_urls?.length ? { media_urls: data.media_urls, media_types: data.media_types } : {}),
            },
          });

          // Poll for completion (max 5 min)
          const maxWait = 300_000;
          const start = Date.now();
          let result: any = null;

          while (Date.now() - start < maxWait) {
            await new Promise(r => setTimeout(r, 2000));
            try {
              const status = await instance.status();
              if (status.status === "complete") {
                result = status.output;
                break;
              }
              if (status.status === "errored") {
                return Response.json({
                  status: "error", success: false,
                  error: status.error?.message || "Agent run failed",
                }, { status: 500 });
              }
              if (status.status === "terminated") {
                return Response.json({
                  status: "error", success: false, error: "Run was terminated",
                }, { status: 500 });
              }
            } catch { /* poll retry */ }
          }

          if (result) {
            this._appendConversationMessage("user", inputText, data.channel || "rest");
            this._appendConversationMessage("assistant", result.output || "", data.channel || "rest");

            // Write billing record + session record (critical — without this, runs are free)
            if (this.env.HYPERDRIVE) {
              const { writeBillingRecord, writeSession } = await import("./runtime/db");
              writeBillingRecord(this.env.HYPERDRIVE, {
                session_id: result.session_id || "", org_id: data.org_id || "",
                agent_name: agentName, model: "workflow",
                input_tokens: 0, output_tokens: 0,
                cost_usd: result.cost_usd || 0, plan: "standard",
                trace_id: result.trace_id || "",
                billing_user_id: data.channel_user_id,
                api_key_id: data.api_key_id,
              }).catch(() => {});
              writeSession(this.env.HYPERDRIVE, {
                session_id: result.session_id || "", org_id: data.org_id || "",
                project_id: data.project_id || "", agent_name: agentName,
                status: "success", input_text: inputText,
                output_text: result.output || "", model: "workflow",
                trace_id: result.trace_id || "",
                step_count: result.turns || 1, action_count: result.tool_calls || 0,
                wall_clock_seconds: 0, cost_total_usd: result.cost_usd || 0,
              }).catch(() => {});

              // NOTE: Credit deduction happens in control-plane (runtime-proxy.ts / public-api.ts)
              // DO only writes billing_records + sessions for analytics. Single deduction point
              // prevents double-billing when requests go through control-plane → runtime → DO.
            }

            return Response.json({ status: "completed", success: true, ...result });
          }

          // Still running — return instance ID for client to poll
          return Response.json({
            status: "running", success: true,
            instance_id: instance.id, progress_key: progressKey,
          }, { status: 202 });
        } catch (err: any) {
          return Response.json({
            status: "error", success: false,
            error: `Workflow execution failed: ${err.message}`,
          }, { status: 500 });
        }
      }

      return Response.json({
        status: "error", success: false,
        error: "AGENT_RUN_WORKFLOW binding not configured.",
      }, { status: 501 });
    }
    // POST /run/stream — SSE streaming for REST clients (portal, curl, etc.)
    // Uses Workflow for durable execution + KV polling for SSE events.
    if (url.pathname === "/run/stream" && request.method === "POST") {
      if (!(await this._isAuthorized(request))) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      const data = await request.json() as any;
      const inputText = String(data.input || "");
      const agentName = data.agent_name || this.state.config.agentName || "agentos";

      // ── Workflow SSE path — trigger Workflow, stream progress from KV ──
      if (this.env.AGENT_RUN_WORKFLOW && this.env.AGENT_PROGRESS_KV) {
        const history = this._loadConversationHistory(24);
        const progressKey = `run:${this.name}:${Date.now()}`;

        try {
          const instance = await this.env.AGENT_RUN_WORKFLOW.create({
            params: {
              agent_name: agentName,
              input: inputText,
              org_id: data.org_id || "",
              project_id: data.project_id || "",
              channel: data.channel || "sse",
              channel_user_id: data.channel_user_id || "",
              history: history.map((m: any) => ({ role: m.role, content: m.content })),
              progress_key: progressKey,
              ...(data.plan ? { plan_override: data.plan } : {}),
            },
          });

          // Stream SSE events by polling KV
          const encoder = new TextEncoder();
          let lastEventIndex = 0;
          const self = this;

          const stream = new ReadableStream({
            async pull(controller) {
              const maxWait = 300_000;
              const start = Date.now();
              let done = false;

              let lastActivity = Date.now();
              while (!done && Date.now() - start < maxWait) {
                await new Promise(r => setTimeout(r, 500));

                // Heartbeat every 15s to keep connection alive
                if (Date.now() - lastActivity > 15000) {
                  controller.enqueue(encoder.encode(`: heartbeat\n\n`));
                  lastActivity = Date.now();
                }

                // Read events from KV
                try {
                  const raw = await self.env.AGENT_PROGRESS_KV!.get(progressKey);
                  if (!raw) continue;
                  const events = JSON.parse(raw) as any[];

                  // Send new events since last poll
                  for (let i = lastEventIndex; i < events.length; i++) {
                    const evt = events[i];
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(evt)}\n\n`));
                    lastActivity = Date.now();

                    if (evt.type === "done") {
                      done = true;
                      // Save conversation
                      self._appendConversationMessage("user", inputText, data.channel || "sse");
                      self._appendConversationMessage("assistant", evt.output || "", data.channel || "sse");

                      // Write billing record only — credit deduction happens in control-plane
                      // (avoids double-billing: DO writes record, control-plane deducts)
                      const costUsd = Number(evt.cost_usd) || 0;
                      const orgId = data.org_id || self.state.config?.orgId || "";
                      if (costUsd > 0 && orgId && self.env.HYPERDRIVE) {
                        import("./runtime/db").then(({ writeBillingRecord }) =>
                          writeBillingRecord(self.env.HYPERDRIVE, {
                            session_id: evt.session_id || "", org_id: orgId,
                            agent_name: agentName, model: "workflow",
                            input_tokens: 0, output_tokens: 0,
                            cost_usd: costUsd, plan: "standard",
                            trace_id: evt.trace_id || "",
                          })
                        ).catch((err: any) => console.error("[sse-billing] writeBillingRecord failed:", err.message));

                        // Write session record (for observability / meta-agent)
                        import("./runtime/db").then(({ writeSession }) =>
                          writeSession(self.env.HYPERDRIVE, {
                            session_id: evt.session_id || "", org_id: orgId,
                            project_id: data.project_id || "", agent_name: agentName,
                            status: "success", input_text: inputText,
                            output_text: (evt.output || "").slice(0, 2000),
                            model: "workflow",
                            trace_id: evt.trace_id || "",
                            step_count: Number(evt.turns) || 1,
                            action_count: Number(evt.tool_calls) || 0,
                            wall_clock_seconds: 0,
                            cost_total_usd: costUsd,
                          })
                        ).catch((err: any) => console.error("[sse-session] writeSession failed:", err.message));
                      }
                    }
                    if (evt.type === "error") done = true;
                  }
                  lastEventIndex = events.length;
                } catch { /* KV read failed, retry */ }

                // Also check Workflow status
                try {
                  const status = await instance.status();
                  if (status.status === "errored") {
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "error", message: status.error?.message || "Run failed" })}\n\n`));
                    done = true;
                  }
                  if (status.status === "terminated") {
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "error", message: "Run terminated" })}\n\n`));
                    done = true;
                  }
                } catch {}
              }

              controller.close();
            },
          });

          return new Response(stream, {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              "Connection": "keep-alive",
            },
          });
        } catch (err: any) {
          // Stream error as SSE event
          const enc = new TextEncoder();
          const errStream = new ReadableStream({
            start(c) {
              c.enqueue(enc.encode(`data: ${JSON.stringify({ type: "error", message: err.message || "Workflow failed" })}\n\n`));
              c.close();
            },
          });
          return new Response(errStream, { headers: { "Content-Type": "text/event-stream" }, status: 500 });
        }
      }

      return Response.json({ error: "AGENT_RUN_WORKFLOW binding not configured." }, { status: 501 });
    }

    // POST /reset — clear conversation history (for /new command)
    if (url.pathname === "/reset" && request.method === "POST") {
      this.sql`DELETE FROM conversation_messages`;
      return Response.json({ ok: true, cleared: true });
    }

    return new Response("Not found", { status: 404 });
  }

  // ── Telemetry ────────────────────────────────────────────────────
  // Events are written to DO-local SQLite for real-time queries,
  // and queued to TELEMETRY_QUEUE → Supabase for durable storage.
  // No backend HTTP calls — Supabase is the single source of truth.


  /** Handle voice relay WebSocket — Twilio ConversationRelay sends text, we run agent and reply with text */
  private _handleVoiceRelay(request: Request): Response {
    const url = new URL(request.url);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server);

    // Store voice session state in transient storage
    const agentName = url.searchParams.get("agent") || this.state.config.agentName || "agentos";
    const orgId = url.searchParams.get("org_id") || this.state.config.orgId || "";

    // Use the DO's own webSocketMessage handler for messages
    (server as any).__voiceAgent = agentName;
    (server as any).__voiceOrgId = orgId;
    (server as any).__voiceCallSid = "";
    (server as any).__voiceProcessing = false;

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string): Promise<void> {
    // Only handle voice relay messages (tagged WebSockets)
    if (!(ws as any).__voiceAgent) return;

    let msg: any;
    try { msg = JSON.parse(message); } catch { return; }

    const agentName = (ws as any).__voiceAgent;
    const orgId = (ws as any).__voiceOrgId;

    if (msg.type === "setup") {
      (ws as any).__voiceCallSid = msg.callSid || "";
      return;
    }

    if (msg.type === "prompt") {
      const userText = (msg.voicePrompt || "").trim();
      if (!userText || (ws as any).__voiceProcessing) return;

      (ws as any).__voiceProcessing = true;
      const callSid = (ws as any).__voiceCallSid;

      try {
        const config = this.state.config;
        let response = "I didn't catch that. Could you say that again?";
        if (this.env.AGENT_RUN_WORKFLOW) {
          const voiceHistory = this._loadConversationHistory(12);
          const inst = await this.env.AGENT_RUN_WORKFLOW.create({
            params: {
              agent_name: agentName, input: userText,
              org_id: orgId, project_id: config.projectId || "",
              channel: "voice", channel_user_id: "", history: voiceHistory.map((m: any) => ({ role: m.role, content: m.content })),
              progress_key: `voice:${this.name}:${Date.now()}`,
            },
          });
          let lastStatus: any = { status: "unknown" };
          for (let i = 0; i < 15; i++) {
            await new Promise(r => setTimeout(r, 2000));
            lastStatus = await inst.status().catch(() => ({ status: "unknown" as const }));
            if (lastStatus.status === "complete") { response = ((lastStatus as any).output?.output || "").trim() || response; break; }
            if (lastStatus.status === "errored") break;
          }
          this._appendConversationMessage("user", userText, "voice");
          this._appendConversationMessage("assistant", response, "voice");

          // Billing for voice WebSocket path (direct WS — no control-plane proxy)
          if (this.env.HYPERDRIVE) {
            const voiceResult = (lastStatus as any)?.output || {};
            const voiceCost = Number(voiceResult.cost_usd) || 0;
            const voiceSessionId = voiceResult.session_id || "";
            if (voiceCost > 0 && orgId) {
              (async () => {
                try {
                  const { writeBillingRecord, getDb } = await import("./runtime/db");
                  await writeBillingRecord(this.env.HYPERDRIVE, {
                    session_id: voiceSessionId, org_id: orgId,
                    agent_name: agentName, model: "workflow",
                    input_tokens: 0, output_tokens: 0, cost_usd: voiceCost,
                    plan: "standard", trace_id: voiceResult.trace_id || "",
                  });
                  // Direct WS path must deduct (no control-plane in the loop)
                  const sql = await getDb(this.env.HYPERDRIVE);
                  if (voiceSessionId) {
                    const dup = await sql`SELECT 1 FROM credit_transactions WHERE session_id = ${voiceSessionId} AND type = 'burn' LIMIT 1`;
                    if (dup.length > 0) return;
                  }
                  const now = new Date().toISOString();
                  const updated = await sql`
                    UPDATE org_credit_balance SET balance_usd = balance_usd - ${voiceCost},
                      lifetime_consumed_usd = lifetime_consumed_usd + ${voiceCost},
                      last_deduction_at = ${now}, updated_at = ${now}
                    WHERE org_id = ${orgId} AND balance_usd >= ${voiceCost}
                  `;
                  if (updated.count > 0) {
                    const [bal] = await sql`SELECT balance_usd FROM org_credit_balance WHERE org_id = ${orgId}`;
                    await sql`
                      INSERT INTO credit_transactions (org_id, type, amount_usd, balance_after_usd, description, agent_name, session_id, created_at)
                      VALUES (${orgId}, 'burn', ${-voiceCost}, ${Number(bal.balance_usd)}, ${'Voice run: ' + agentName}, ${agentName}, ${voiceSessionId}, ${now})
                    `;
                  } else {
                    console.error(`[voice-ws-billing] Insufficient credits for org ${orgId}`);
                  }
                } catch (err: any) {
                  console.error("[voice-ws-billing] Billing failed:", err.message);
                }
              })();
            }
          }
        } else {
          response = "Voice processing requires Workflow binding. Please contact support.";
        }

        // Strip markdown for voice
        response = response
          .replace(/#{1,6}\s*/g, "")
          .replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1")
          .replace(/`{1,3}[^`]*`{1,3}/g, "")
          .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
          .replace(/^[-*•]\s*/gm, "")
          .replace(/\n/g, " ")
          .trim();

        ws.send(JSON.stringify({ type: "text", token: response, last: true }));
      } catch (err) {
        console.error("[VoiceRelay DO] Error:", err instanceof Error ? err.message : err);
        try {
          ws.send(JSON.stringify({ type: "text", token: "Sorry, something went wrong.", last: true }));
        } catch {}
      } finally {
        (ws as any).__voiceProcessing = false;
      }
    }

    if (msg.type === "interrupt") {
      (ws as any).__voiceProcessing = false;
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

const DYNAMIC_EXEC_CACHE_LIMIT = 32;
const DYNAMIC_EXEC_CACHE_TTL_MS = 5 * 60_000;
type DynamicExecCacheEntry = { worker: any; expiresAt: number };
const dynamicExecWorkerCache = new Map<string, DynamicExecCacheEntry>();

function clampSandboxTimeoutSeconds(timeoutSeconds: number | undefined): number {
  const t = Number.isFinite(timeoutSeconds) ? Number(timeoutSeconds) : 30;
  return Math.max(1, Math.min(Math.ceil(t), 120));
}

function sandboxExecOptions(timeoutSeconds?: number): { timeout: number } & Record<string, number> {
  const timeout = clampSandboxTimeoutSeconds(timeoutSeconds);
  return {
    timeout,
    // Best-effort limits for runtimes that support these options.
    memoryLimitMb: 512,
    cpuLimitMs: timeout * 1000,
  };
}

function extractPythonImportCandidates(code: string): string[] {
  if (!code || typeof code !== "string") return [];
  const modules = new Set<string>();
  for (const raw of code.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const fromMatch = line.match(/^from\s+([A-Za-z_][\w\.]*)\s+import\s+/);
    if (fromMatch?.[1]) {
      const top = fromMatch[1].split(".")[0];
      if (top) modules.add(top);
      continue;
    }
    const importMatch = line.match(/^import\s+(.+)$/);
    if (!importMatch?.[1]) continue;
    for (const segment of importMatch[1].split(",")) {
      const cleaned = segment.trim().replace(/\s+as\s+.+$/, "");
      const top = cleaned.split(".")[0].trim();
      if (top) modules.add(top);
    }
  }
  return [...modules];
}

async function checkMissingPythonModulesInSandbox(
  env: Env,
  sandboxId: string,
  modules: string[],
): Promise<string[]> {
  if (modules.length === 0) return [];
  const sandbox = getSandbox(env.SANDBOX, sandboxId);
  const payload = JSON.stringify(modules);
  const command = `python3 - <<'PY'
import importlib
import json
mods = json.loads(${JSON.stringify(payload)})
missing = []
for m in mods:
    try:
        importlib.import_module(m)
    except Exception:
        missing.append(m)
print(json.dumps({"missing": missing}))
PY`;
  const result = await sandbox.exec(command, sandboxExecOptions(12));
  const stdout = String(result.stdout || "").trim();
  if (!stdout) return [];
  try {
    const parsed = JSON.parse(stdout) as { missing?: unknown };
    if (!Array.isArray(parsed.missing)) return [];
    return parsed.missing.map((m) => String(m)).filter((m) => m.length > 0);
  } catch {
    return [];
  }
}

function pythonMissingModuleError(missing: string[]): string {
  return [
    "Python dependency check failed.",
    `Missing modules in this sandbox: ${missing.join(", ")}.`,
    "This environment does not allow dynamic package installs (pip/apt).",
    "Use pre-baked sandbox images or ask your admin to add required packages.",
  ].join(" ");
}

async function getCachedDynamicExecWorker(env: Env, workerCode: string): Promise<any> {
  const hash = await sha256Hex(workerCode);
  const key = hash.slice(0, 32);
  const cached = dynamicExecWorkerCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.worker;
  dynamicExecWorkerCache.delete(key);
  const loadedWorker = env.LOADER.load({
    compatibilityDate: "2026-03-01",
    mainModule: "main.js",
    modules: {
      "main.js": { js: workerCode },
    },
    env: {},  // No bindings — isolate cannot access secrets or DB
    globalOutbound: null,  // Block all outbound network from /cf/tool/exec dynamic-exec
  });
  dynamicExecWorkerCache.set(key, {
    worker: loadedWorker,
    expiresAt: Date.now() + DYNAMIC_EXEC_CACHE_TTL_MS,
  });
  if (dynamicExecWorkerCache.size > DYNAMIC_EXEC_CACHE_LIMIT) {
    const oldestKey = dynamicExecWorkerCache.keys().next().value;
    if (oldestKey) dynamicExecWorkerCache.delete(oldestKey);
  }
  return loadedWorker;
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
  if (!token) return Response.json({ error: "unauthorized" }, { status: 401 });

  const serviceToken = String(env.SERVICE_TOKEN || "").trim();
  if (serviceToken && token === serviceToken) return null;

  const jwtSecret = String(env.AUTH_JWT_SECRET || "").trim();
  if (jwtSecret && (await verifyHs256Jwt(token, jwtSecret))) return null;

  return Response.json({ error: "unauthorized" }, { status: 401 });
}

// ---------------------------------------------------------------------------
// MCP Server Agent — exposes tools via Model Context Protocol
// ---------------------------------------------------------------------------

export class AgentOSMcpServer extends Agent<Env> {
  // Cached agent config loaded from Supabase
  private _agentConfig: Record<string, unknown> | null = null;
  private _agentTools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> = [];

  async onStart() {
    // Load agent config from Supabase via Hyperdrive on startup
    await this._loadAgentConfig();
  }

  /**
   * Load agent configuration and tool definitions from Supabase.
   * The agent name is derived from this DO's name (set via idFromName).
   */
  private async _loadAgentConfig(): Promise<void> {
    if (!this.env.HYPERDRIVE) return;
    try {
      const { getDb } = await import("./runtime/db");
      const sql = await getDb(this.env.HYPERDRIVE);
      const agentName = this.name || "default";

      const rows = await sql`
        SELECT config_json, name, description FROM agents
        WHERE name = ${agentName} AND is_active = true
        LIMIT 1
      `;
      if (rows.length === 0) return;

      let config: Record<string, unknown> = {};
      config = parseJsonColumn(rows[0].config_json);
      this._agentConfig = config;

      // Build MCP tool definitions from agent's configured tools
      const configuredTools = Array.isArray(config.tools) ? (config.tools as string[]) : [];
      this._agentTools = [
        // Always include the built-in run-agent tool
        {
          name: "run-agent",
          description: `Run the ${agentName} agent on a task`,
          inputSchema: {
            type: "object",
            properties: {
              agent_name: { type: "string", description: "Agent name (defaults to this agent)" },
              task: { type: "string", description: "Task to execute" },
            },
            required: ["task"],
          },
        },
        // Always include knowledge search
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
        // Expose each configured tool as an MCP tool
        ...configuredTools.map((toolName: string) => ({
          name: toolName,
          description: `Execute the '${toolName}' tool via AgentOS`,
          inputSchema: {
            type: "object" as const,
            properties: {
              input: { type: "string", description: "Input for the tool" },
              parameters: { type: "object", description: "Additional parameters" },
            },
            required: ["input"],
          },
        })),
      ];

      // Load detailed tool schemas from tool_registry if available
      if (configuredTools.length > 0) {
        try {
          const toolRows = await sql`
            SELECT name, description, input_schema_json FROM tool_registry
            WHERE name = ANY(${configuredTools})
          `;
          const schemaMap = new Map<string, { description: string; schema: Record<string, unknown> }>();
          for (const row of toolRows) {
            let schema: Record<string, unknown> = {};
            schema = parseJsonColumn(row.input_schema_json);
            schemaMap.set(String(row.name), {
              description: String(row.description || ""),
              schema,
            });
          }
          // Enrich tool definitions with proper schemas
          for (const tool of this._agentTools) {
            const registered = schemaMap.get(tool.name);
            if (registered) {
              if (registered.description) tool.description = registered.description;
              if (Object.keys(registered.schema).length > 0) tool.inputSchema = registered.schema;
            }
          }
        } catch { /* tool_registry may not exist — use defaults */ }
      }
    } catch (err) {
      console.error("[MCP] Failed to load agent config:", err);
    }
  }

  async onRequest(request: Request): Promise<Response> {
    // MCP JSON-RPC handler
    if (request.method === "POST") {
      const body = await request.json() as any;
      const method = body.method;
      const id = body.id;

      if (method === "initialize") {
        // Reload config on each initialize to pick up changes
        await this._loadAgentConfig();
        return Response.json({
          jsonrpc: "2.0", id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: {
              tools: { listChanged: true },
            },
            serverInfo: {
              name: "agentos-mcp",
              version: "0.2.0",
              agentName: this.name || "default",
            },
          },
        });
      }

      if (method === "tools/list") {
        // Ensure config is loaded
        if (this._agentTools.length === 0) await this._loadAgentConfig();
        return Response.json({
          jsonrpc: "2.0", id,
          result: { tools: this._agentTools },
        });
      }

      if (method === "tools/call") {
        const toolName = body.params?.name;
        const args = body.params?.arguments || {};

        if (toolName === "run-agent") {
          // Delegate to the main agent
          try {
            const targetAgent = args.agent_name || this.name || "default";
            const agentId = this.env.AGENTOS_AGENT.idFromName(targetAgent);
            const agent = this.env.AGENTOS_AGENT.get(agentId);
            const resp = await agent.fetch(new Request("http://internal/run", {
              method: "POST",
              body: JSON.stringify({ input: args.task }),
            }));
            const result = await resp.json();
            return Response.json({
              jsonrpc: "2.0", id,
              result: { content: [{ type: "text", text: JSON.stringify(result) }] },
            });
          } catch (err: any) {
            return Response.json({
              jsonrpc: "2.0", id,
              result: {
                content: [{ type: "text", text: `run-agent failed: ${err?.message || err}` }],
                isError: true,
              },
            });
          }
        }

        if (toolName === "search-knowledge") {
          const query = String(args.query || "");
          if (!query.trim()) {
            return Response.json({
              jsonrpc: "2.0", id,
              result: { content: [{ type: "text", text: "query is required" }], isError: true },
            });
          }
          try {
            const agentId = this.env.AGENTOS_AGENT.idFromName(this.name || "default");
            const agent = this.env.AGENTOS_AGENT.get(agentId);
            const resp = await agent.fetch(new Request("http://internal/run", {
              method: "POST",
              body: JSON.stringify({ input: `Use knowledge search for: ${query}` }),
            }));
            const result = await resp.json();
            return Response.json({
              jsonrpc: "2.0", id,
              result: { content: [{ type: "text", text: JSON.stringify(result) }] },
            });
          } catch (err: any) {
            return Response.json({
              jsonrpc: "2.0", id,
              result: {
                content: [{ type: "text", text: `search-knowledge failed: ${err?.message || err}` }],
                isError: true,
              },
            });
          }
        }

        // Dispatch configured tools via the agent DO
        const configuredTools = Array.isArray(this._agentConfig?.tools) ? (this._agentConfig!.tools as string[]) : [];
        if (configuredTools.includes(toolName)) {
          try {
            const agentId = this.env.AGENTOS_AGENT.idFromName(this.name || "default");
            const agent = this.env.AGENTOS_AGENT.get(agentId);
            const resp = await agent.fetch(new Request("http://internal/run", {
              method: "POST",
              body: JSON.stringify({
                input: `Execute tool '${toolName}' with input: ${args.input || JSON.stringify(args)}`,
                tool_override: toolName,
                tool_args: args,
              }),
            }));
            const result = await resp.json();
            return Response.json({
              jsonrpc: "2.0", id,
              result: { content: [{ type: "text", text: JSON.stringify(result) }] },
            });
          } catch (err: any) {
            return Response.json({
              jsonrpc: "2.0", id,
              result: {
                content: [{ type: "text", text: `Tool '${toolName}' failed: ${err?.message || err}` }],
                isError: true,
              },
            });
          }
        }

        return Response.json({
          jsonrpc: "2.0", id,
          result: { content: [{ type: "text", text: `Unknown tool: ${toolName}` }], isError: true },
        });
      }

      // Unsupported method
      return Response.json({
        jsonrpc: "2.0", id,
        error: { code: -32601, message: `Method not found: ${method}` },
      });
    }

    // GET request — return server info
    return Response.json({
      name: "agentos-mcp",
      version: "0.2.0",
      agent: this.name || "default",
      protocol: "MCP/2024-11-05",
      endpoints: ["initialize", "tools/list", "tools/call"],
    });
  }
}

// ---------------------------------------------------------------------------
// Worker entry point — routes to agents
// ---------------------------------------------------------------------------

/** Markdown-aware message chunking for Telegram (4096 char limit).
 *  Splits at natural boundaries, preserves code blocks. */
function tgChunkMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  let insideCodeBlock = false;
  let codeLang = "";

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) { chunks.push(remaining); break; }
    const reserve = 20;
    let splitAt = maxLen - reserve;
    // Find natural split: double newline > newline > space
    let best = -1;
    const dnl = remaining.lastIndexOf("\n\n", splitAt);
    if (dnl > maxLen * 0.3) best = dnl + 1;
    if (best === -1) { const nl = remaining.lastIndexOf("\n", splitAt); if (nl > maxLen * 0.3) best = nl + 1; }
    if (best === -1) { const sp = remaining.lastIndexOf(" ", splitAt); if (sp > maxLen * 0.3) best = sp + 1; }
    if (best === -1) best = splitAt;

    let chunk = remaining.slice(0, best);
    remaining = remaining.slice(best);
    const fenceCount = (chunk.match(/```/g) || []).length;
    if (insideCodeBlock) chunk = "```" + codeLang + "\n" + chunk;
    const total = (insideCodeBlock ? 1 : 0) + fenceCount;
    if (total % 2 === 1) {
      chunk += "\n```";
      insideCodeBlock = true;
      const lm = chunk.match(/```(\w+)/);
      codeLang = lm ? lm[1] : "";
    } else { insideCodeBlock = false; codeLang = ""; }
    chunks.push(chunk);
  }
  if (chunks.length > 1) return chunks.map((c, i) => `${c}\n(${i + 1}/${chunks.length})`);
  return chunks;
}

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
  opts?: {
    org_id?: string;
    project_id?: string;
    channel?: string;
    channel_user_id?: string;
    api_key_id?: string;
    delegation?: Record<string, unknown>;
    system_prompt_override?: string;
    media_urls?: string[];
    media_types?: string[];
  },
): Promise<{ output: string; success: boolean; error?: string; turns: number; tool_calls: number; cost_usd: number; latency_ms: number; session_id: string; trace_id: string; stop_reason: string; [key: string]: unknown }> {
  // Per-user DO isolation: each user gets their own conversation thread
  // Include org_id to prevent cross-org collision
  const userId = opts?.channel_user_id || "";
  const orgId = opts?.org_id || "";
  const sessionId = (opts as any)?.session_id || "";
  const orgPrefix = orgId ? `${orgId}-` : "";
  const doName = userId
    ? `${orgPrefix}${agentName}-u-${userId}${sessionId ? `-s-${sessionId}` : ""}`
    : `${orgPrefix}${agentName}${sessionId ? `-s-${sessionId}` : ""}`;
  const agentId = env.AGENTOS_AGENT.idFromName(doName);
  const agent = env.AGENTOS_AGENT.get(agentId);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-partykit-namespace": "agentos",
    "x-partykit-room": doName,
  };
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
      api_key_id: opts?.api_key_id || "",
      delegation: opts?.delegation,
      ...(opts?.system_prompt_override ? { system_prompt_override: opts.system_prompt_override } : {}),
      ...(opts?.media_urls?.length ? { media_urls: opts.media_urls, media_types: opts.media_types } : {}),
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

// ═══════════════════════════════════════════════════════════════════════

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

    // Health check — comprehensive runtime status
    if (url.pathname === "/health") {
      const circuits = getCircuitStatus();
      const openCircuits = Object.entries(circuits).filter(([, s]) => s.state === "open");
      const { getCodeModeStats } = await import("./runtime/codemode");
      const codemode = getCodeModeStats();
      const degradedReasons: string[] = [];
      if (openCircuits.length > 0) {
        degradedReasons.push(`open_circuits:${openCircuits.length}`);
      }
      if (codemode.pending_executions >= codemode.max_concurrent_executions) {
        degradedReasons.push("codemode_saturated");
      }
      if (codemode.concurrency_rejections_total > 0) {
        degradedReasons.push("codemode_rejections_observed");
      }
      const degraded = degradedReasons.length > 0;
      
      return Response.json({ 
        status: "ok", 
        version: "0.2.0",
        service: "runtime",
        timestamp: Date.now(),
        circuits: {
          total: Object.keys(circuits).length,
          open: openCircuits.length,
          details: circuits,
        },
        codemode,
        degraded,
        degraded_reasons: degradedReasons,
      }, { status: degraded ? 503 : 200 });
    }
    
    // ── Dream memory consolidation (called by control-plane queue consumer) ──
    if (url.pathname === "/api/v1/memory/consolidate" && request.method === "POST") {
      try {
        const body = await request.json() as { org_id: string; agent_name: string };
        const { consolidateMemory } = await import("./runtime/memory-consolidation");
        const result = await consolidateMemory(env as any, body.org_id, body.agent_name);
        return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
      }
    }

    // ── Workspace file browser (R2-backed) ────────────────────
    if (url.pathname === "/workspace/list" && request.method === "POST") {
      try {
        const body = await request.json() as Record<string, string>;
        const { listWorkspaceFiles } = await import("./runtime/workspace");
        const files = await listWorkspaceFiles(
          env.STORAGE, body.org_id || "default", body.agent_name || "agent", body.user_id,
        );
        return Response.json({ files });
      } catch (err: any) {
        return Response.json({ files: [], error: err.message }, { status: 500 });
      }
    }

    if (url.pathname === "/workspace/read" && request.method === "POST") {
      try {
        const body = await request.json() as Record<string, string>;
        const { readFileFromR2 } = await import("./runtime/workspace");
        const content = await readFileFromR2(
          env.STORAGE, body.org_id || "default", body.agent_name || "agent",
          body.path || "", body.user_id,
        );
        if (content === null) return Response.json({ error: "File not found" }, { status: 404 });
        return Response.json({ path: body.path, content, size: content.length });
      } catch (err: any) {
        return Response.json({ error: err.message }, { status: 500 });
      }
    }

    if (url.pathname === "/workspace/projects" && request.method === "POST") {
      try {
        const body = await request.json() as Record<string, string>;
        const org = body.org_id || "default";
        const agent = body.agent_name || "agent";
        const prefix = `workspaces/${org}/${agent}/projects/`;
        const listed = await env.STORAGE.list({ prefix, limit: 100, delimiter: "/" });
        // Extract project names from common prefixes (directories)
        const projects: Array<{ name: string; last_sync?: string; file_count?: number }> = [];
        for (const p of listed.delimitedPrefixes || []) {
          const name = p.replace(prefix, "").replace(/\/$/, "");
          if (!name) continue;
          // Try to get file count from manifest or latest.tar.gz metadata
          const latest = await env.STORAGE.head(`${prefix}${name}/latest.tar.gz`);
          projects.push({
            name,
            last_sync: latest?.uploaded?.toISOString() || undefined,
          });
        }
        return Response.json({ projects });
      } catch (err: any) {
        return Response.json({ projects: [], error: err.message }, { status: 500 });
      }
    }

    // ── Voice: ConversationRelay WebSocket with ctx.waitUntil for async ──
    if (url.pathname === "/voice/relay") {
      const upgradeHeader = request.headers.get("Upgrade") || "";
      if (upgradeHeader.toLowerCase() !== "websocket") {
        return new Response("Expected WebSocket upgrade", { status: 426 });
      }

      const agentName = url.searchParams.get("agent") || "agentos";
      const orgId = url.searchParams.get("org_id") || "";

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();

      let callSid = "";

      server.addEventListener("message", (event) => {
        let msg: any;
        try { msg = JSON.parse(event.data as string); } catch { return; }

        if (msg.type === "setup") {
          callSid = msg.callSid || "";
          return;
        }

        if (msg.type === "prompt") {
          const userText = (msg.voicePrompt || "").trim();
          if (!userText) return;

          // Full agent pipeline — tools, memory, conversation history, plan routing
          // channel: "voice" triggers voice-optimized system prompt in engine.ts/stream.ts
          ctx.waitUntil((async () => {
            try {
              const result = await runViaAgent(env, agentName, userText, {
                org_id: orgId,
                channel: "voice",
                channel_user_id: `twilio-${callSid}`,
              });

              let response = result.output || "I didn't catch that. Could you say that again?";

              // Strip any markdown that slipped through
              response = response
                .replace(/#{1,6}\s*/g, "")
                .replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1")
                .replace(/`{1,3}[^`]*`{1,3}/g, "")
                .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
                .replace(/^[-*•]\s*/gm, "")
                .replace(/\n/g, " ")
                .trim();

              // Send full response as one piece — Twilio renders smooth TTS
              server.send(JSON.stringify({ type: "text", token: response, last: true }));
            } catch (err) {
              console.error("[VoiceRelay] Error:", err);
              try { server.send(JSON.stringify({ type: "text", token: "Sorry, something went wrong.", last: true })); } catch {}
            }
          })());
        }
      });

      return new Response(null, { status: 101, webSocket: client });
    }

    // POST /run — route to Durable Object for agent execution
    if (url.pathname === "/run" && request.method === "POST") {
      try {
        const body = await request.json() as {
          agent_name?: string;
          input?: string;
          org_id?: string;
          project_id?: string;
          channel?: string;
          channel_user_id?: string;
          api_key_id?: string;
          delegation?: Record<string, unknown>;
          system_prompt_override?: string;
        };
        const result = await runViaAgent(env, body.agent_name || "agentos", body.input || "", {
          org_id: body.org_id,
          project_id: body.project_id,
          channel: body.channel || "api",
          channel_user_id: body.channel_user_id,
          api_key_id: body.api_key_id,
          delegation: body.delegation,
          system_prompt_override: body.system_prompt_override,
        });
        return Response.json(result);
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Run failed" }, { status: 500 });
      }
    }

    // Config cache invalidation endpoint (called by control-plane on agent updates)
    if (url.pathname === "/api/v1/internal/config-invalidate" && request.method === "POST") {
      const serviceToken = env.SERVICE_TOKEN || "";
      if (serviceToken) {
        const authHeader = request.headers.get("Authorization") || "";
        const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
        if (token !== serviceToken) {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }
      }
      
      try {
        const body = await request.json() as { agent_name?: string; version?: string };
        const agentName = body.agent_name || "agentos";
        
        // Note: DOs will reload config on next request naturally
        // This endpoint acknowledges the invalidation
        return Response.json({
          invalidated: true,
          agent_name: agentName,
          version: body.version,
          note: "Config will be reloaded on next request",
        });
      } catch (e: any) {
        return Response.json({ error: e.message }, { status: 400 });
      }
    }

    // POST /api/v1/internal/snippet-cache-invalidate — Invalidate cached codemode snippets
    if (url.pathname === "/api/v1/internal/snippet-cache-invalidate" && request.method === "POST") {
      const serviceToken = env.SERVICE_TOKEN || "";
      if (serviceToken) {
        const authHeader = request.headers.get("Authorization") || "";
        const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
        if (token !== serviceToken) {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }
      }

      try {
        const body = await request.json() as {
          snippet_id?: string;
          org_id?: string;
          clear_all?: boolean;
        };

        const { invalidateSnippetCache, clearSnippetCache } = await import("./runtime/codemode");

        if (body.clear_all) {
          clearSnippetCache();
          return Response.json({ invalidated: true, type: "all" });
        }

        if (body.snippet_id && body.org_id) {
          invalidateSnippetCache(body.snippet_id, body.org_id);
          return Response.json({
            invalidated: true,
            snippet_id: body.snippet_id,
            org_id: body.org_id,
          });
        }

        return Response.json({ error: "snippet_id + org_id or clear_all required" }, { status: 400 });
      } catch (e: any) {
        return Response.json({ error: e.message }, { status: 400 });
      }
    }

    // ── Usage / Billing API ──────────────────────────────────────
    // GET /api/v1/usage?org_id=X&agent_name=Y&cursor=Z&limit=N&from=T&to=T
    // Returns: summary (totals) + cursor-paginated session list with costs
    if (url.pathname === "/api/v1/usage" && request.method === "GET") {
      // Always require authentication
      const authHeader = request.headers.get("Authorization") || "";
      if (!authHeader.startsWith("Bearer ")) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      const token = authHeader.slice(7).trim();
      if (!token) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }

      const serviceToken = String(env.SERVICE_TOKEN || "").trim();
      const jwtSecret = String(env.AUTH_JWT_SECRET || "").trim();
      let jwtOrgId = "";

      if (serviceToken && token === serviceToken) {
        // Service token: allow explicit org_id from query param
        jwtOrgId = url.searchParams.get("org_id") || "default";
      } else if (jwtSecret) {
        // JWT: extract org_id from claims, ignore query param
        try {
          const parts = token.split(".");
          if (parts.length !== 3) return Response.json({ error: "unauthorized" }, { status: 401 });
          const valid = await verifyHs256Jwt(token, jwtSecret);
          if (!valid) return Response.json({ error: "unauthorized" }, { status: 401 });
          const payloadRaw = new TextDecoder().decode(base64UrlToBytes(parts[1]));
          const claims = JSON.parse(payloadRaw) as { org_id?: string };
          jwtOrgId = claims.org_id || url.searchParams.get("org_id") || "default";
        } catch {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }
      } else {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }

      try {
        const { queryUsage } = await import("./runtime/db");
        const result = await queryUsage(env.HYPERDRIVE, {
          org_id: jwtOrgId,
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
        api_key_id?: string;
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
      // Run eval in background — no Worker timeout.
      const agentName = String(body.agent_name || qpAgent || "").trim() || "agentos";
      const evalName = body.eval_name || `edge_eval_${Date.now()}`;
      const evalRunId = `eval-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      // Kick off eval in an eval-specific DO instance (no timeout)
      const evalDoName = `eval-${agentName}-${evalRunId}`;
      const evalAgentId = env.AGENTOS_AGENT.idFromName(evalDoName);
      const evalAgent = env.AGENTOS_AGENT.get(evalAgentId);
      const evalHeaders: Record<string, string> = { "Content-Type": "application/json" };
      if (env.SERVICE_TOKEN) evalHeaders.Authorization = `Bearer ${env.SERVICE_TOKEN}`;

      ctx.waitUntil((async () => {
        try {
          let passCount = 0;
          let errorCount = 0;
          let totalScore = 0;
          let totalLatency = 0;
          let totalCost = 0;
          const trialRows: any[] = [];

          for (const task of tasks) {
            const taskName = String(task?.name || "");
            const expected = String(task?.expected || "");
            const grader = String(task?.grader || "contains");
            const input = String(task?.input || "");
            for (let trial = 1; trial <= trials; trial++) {
              const runResult = await runViaAgent(env, agentName, input, {
                org_id: body.org_id, project_id: body.project_id,
                channel: body.channel, channel_user_id: body.channel_user_id,
                api_key_id: body.api_key_id,
              });
              const grade = gradeEvalOutput(runResult.output, expected, grader);
              if (grade.passed) passCount++;
              if (!runResult.success || runResult.error) errorCount++;
              totalScore += grade.score;
              totalLatency += Number(runResult.latency_ms || 0);
              totalCost += Number(runResult.cost_usd || 0);
              trialRows.push({
                task_name: taskName, trial_number: trial,
                score: grade.score, passed: grade.passed,
                latency_ms: Number(runResult.latency_ms || 0),
                cost_usd: Number(runResult.cost_usd || 0),
                tool_calls: Number(runResult.tool_calls || 0),
                error: String(runResult.error || ""),
                stop_reason: String(runResult.stop_reason || ""),
                session_id: String(runResult.session_id || ""),
                trace_id: String(runResult.trace_id || ""),
                expected, grader, output: runResult.output,
              });
            }
          }

          const totalTrials = trialRows.length;
          const passRate = totalTrials > 0 ? passCount / totalTrials : 0;
          const avgScore = totalTrials > 0 ? totalScore / totalTrials : 0;
          const avgLatency = totalTrials > 0 ? totalLatency / totalTrials : 0;
          const dbEvalRunId = await writeEvalRun(env.HYPERDRIVE, {
            agent_name: agentName, eval_name: evalName,
            total_tasks: tasks.length, total_trials: totalTrials,
            pass_count: passCount, fail_count: Math.max(0, totalTrials - passCount),
            error_count: errorCount, pass_rate: passRate,
            avg_score: avgScore, avg_latency_ms: avgLatency, total_cost_usd: totalCost,
            eval_conditions_json: JSON.stringify({ source: "edge_eval_api", trials_per_task: trials }),
          });
          for (const row of trialRows) {
            await writeEvalTrial(env.HYPERDRIVE, {
              eval_run_id: dbEvalRunId, eval_name: evalName, agent_name: agentName,
              trial_index: row.trial_number, passed: row.passed, score: row.score,
              details_json: JSON.stringify(row),
              trace_id: row.trace_id, session_id: row.session_id,
            });
          }
        } catch (err) {
          console.error("[eval] background eval failed:", err instanceof Error ? err.message : err);
        }
      })());

      // Return immediately — poll GET /api/v1/eval/runs for results
      return Response.json({
        status: "running",
        eval_name: evalName,
        agent_name: agentName,
        message: "Eval started in background. Poll GET /api/v1/eval/runs for results.",
      }, { status: 202 });
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
        api_key_id?: string;
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
          api_key_id: body.api_key_id,
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
        api_key_id?: string;
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
              api_key_id: body.api_key_id,
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

    // ── Real-time SSE streaming (no WebSocket required) ─────────
    // POST /api/v1/runtime-proxy/runnable/stream — proxies to DO /run/stream
    // Returns text/event-stream with token, tool_start, tool_end, turn_end, done events.
    // Portal and REST clients can consume this without a WebSocket connection.
    if (url.pathname === "/api/v1/runtime-proxy/runnable/stream" && request.method === "POST") {
      const serviceToken = env.SERVICE_TOKEN || "";
      if (serviceToken) {
        const authHeader = request.headers.get("Authorization") || "";
        const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
        if (token !== serviceToken) {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }
      }

      try {
        const body = await request.json() as {
          agent_name?: string; task?: string; input?: unknown;
          org_id?: string; project_id?: string; channel?: string; channel_user_id?: string;
          api_key_id?: string; session_id?: string; plan?: string;
        };

        const agentName = body.agent_name || "agentos";
        const task = runnableInputToTask(body.input, body.task);
        const userId = body.channel_user_id || "";
        const orgId = body.org_id || "";
        const sessionId = body.session_id || "";
        const orgPrefix = orgId ? `${orgId}-` : "";
        // Include session_id in DO name so each session gets its own DO instance
        const doName = userId
          ? `${orgPrefix}${agentName}-u-${userId}${sessionId ? `-s-${sessionId}` : ""}`
          : `${orgPrefix}${agentName}${sessionId ? `-s-${sessionId}` : ""}`;
        const agentId = env.AGENTOS_AGENT.idFromName(doName);
        const agent = env.AGENTOS_AGENT.get(agentId);

        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          "x-partykit-namespace": "agentos",
          "x-partykit-room": doName,
        };
        if (env.SERVICE_TOKEN) headers.Authorization = `Bearer ${env.SERVICE_TOKEN}`;

        // Forward to DO /run/stream — returns SSE
        const doResp = await agent.fetch(new Request("http://internal/run/stream", {
          method: "POST",
          headers,
          body: JSON.stringify({
            input: task,
            agent_name: agentName,
            org_id: body.org_id || "",
            project_id: body.project_id || "",
            channel: body.channel || "sse",
            channel_user_id: userId,
            api_key_id: body.api_key_id || "",
            ...(body.plan ? { plan: body.plan } : {}),
          }),
        }));

        if (!doResp.ok) {
          const errText = await doResp.text();
          return Response.json({ error: errText }, { status: doResp.status });
        }

        // Pass through the SSE stream from the DO
        return new Response(doResp.body, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
          },
        });
      } catch (err: any) {
        return Response.json({ error: err.message || String(err) }, { status: 500 });
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


    // --- Codemode Runtime API ---

    // POST /api/v1/codemode/execute — Execute code with scoped permissions
    if (url.pathname === "/api/v1/codemode/execute" && request.method === "POST") {
      const body = await request.json() as {
        code?: string; scope?: string; scope_config?: unknown;
        input?: unknown; globals?: Record<string, unknown>;
        org_id?: string; snippet_id?: string;
      };
      if (!body.code) return Response.json({ error: "code is required" }, { status: 400 });

      const { executeScopedCode } = await import("./runtime/codemode");
      const { getToolDefinitions } = await import("./runtime/tools");
      const runtimeEnv: RuntimeEnv = {
        AI: env.AI, HYPERDRIVE: env.HYPERDRIVE, VECTORIZE: env.VECTORIZE,
        STORAGE: env.STORAGE, SANDBOX: env.SANDBOX, LOADER: env.LOADER,
        TELEMETRY_QUEUE: env.TELEMETRY_QUEUE, BROWSER: env.BROWSER,
        OPENROUTER_API_KEY: env.OPENROUTER_API_KEY,
        AI_GATEWAY_ID: env.AI_GATEWAY_ID, AI_GATEWAY_TOKEN: env.AI_GATEWAY_TOKEN,
        BRAVE_SEARCH_KEY: env.BRAVE_SEARCH_KEY,
        CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID,
        CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN,
        DEFAULT_PROVIDER: env.DEFAULT_PROVIDER, DEFAULT_MODEL: env.DEFAULT_MODEL,
      };
      const allTools = getToolDefinitions([]);
      const sessionId = crypto.randomUUID().slice(0, 16);
      const result = await executeScopedCode(runtimeEnv, body.code, allTools, sessionId, {
        scope: (body.scope as any) || "agent",
        scopeOverrides: body.scope_config as any,
        input: body.input,
        globals: body.globals,
        orgId: body.org_id,
        snippetId: body.snippet_id,
      });
      return Response.json(result);
    }

    // GET /api/v1/codemode/templates — List built-in templates
    if (url.pathname === "/api/v1/codemode/templates" && request.method === "GET") {
      const { CODEMODE_TEMPLATES } = await import("./runtime/codemode");
      return Response.json(CODEMODE_TEMPLATES);
    }

    // GET /api/v1/codemode/types/:scope — Get TypeScript type defs for scope
    if (url.pathname.startsWith("/api/v1/codemode/types/") && request.method === "GET") {
      const scope = url.pathname.split("/").pop() || "agent";
      const { getScopedTypeDefinitions } = await import("./runtime/codemode");
      const { getToolDefinitions } = await import("./runtime/tools");
      const allTools = getToolDefinitions([]);
      const types = getScopedTypeDefinitions(allTools, scope as any);
      return Response.json({ scope, types });
    }

    // GET /api/v1/codemode/stats — Runtime codemode stats
    if (url.pathname === "/api/v1/codemode/stats" && request.method === "GET") {
      const { getCodeModeStats } = await import("./runtime/codemode");
      return Response.json(getCodeModeStats());
    }

    // POST /api/v1/codemode/webhook-handler — Execute webhook handler snippet
    if (url.pathname === "/api/v1/codemode/webhook-handler" && request.method === "POST") {
      const body = await request.json() as {
        snippet_id?: string; org_id?: string;
        payload?: unknown; headers?: Record<string, string>;
      };
      if (!body.snippet_id) return Response.json({ error: "snippet_id is required" }, { status: 400 });

      const { getDb } = await import("./runtime/db");
      const sql = await getDb(env.HYPERDRIVE);
      const rows = await sql`
        SELECT code FROM codemode_snippets WHERE id = ${body.snippet_id} AND org_id = ${body.org_id || ""} LIMIT 1
      `;
      if (rows.length === 0) return Response.json({ error: "Snippet not found" }, { status: 404 });

      const { executeWebhookHandler } = await import("./runtime/codemode");
      const { getToolDefinitions } = await import("./runtime/tools");
      const runtimeEnv: RuntimeEnv = {
        AI: env.AI, HYPERDRIVE: env.HYPERDRIVE, VECTORIZE: env.VECTORIZE,
        STORAGE: env.STORAGE, SANDBOX: env.SANDBOX, LOADER: env.LOADER,
        TELEMETRY_QUEUE: env.TELEMETRY_QUEUE, BROWSER: env.BROWSER,
        OPENROUTER_API_KEY: env.OPENROUTER_API_KEY,
        AI_GATEWAY_ID: env.AI_GATEWAY_ID, AI_GATEWAY_TOKEN: env.AI_GATEWAY_TOKEN,
        BRAVE_SEARCH_KEY: env.BRAVE_SEARCH_KEY,
        CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID,
        CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN,
        DEFAULT_PROVIDER: env.DEFAULT_PROVIDER, DEFAULT_MODEL: env.DEFAULT_MODEL,
      };
      const code = String((rows[0] as Record<string, unknown>).code || "");
      const allTools = getToolDefinitions([]);
      const sessionId = crypto.randomUUID().slice(0, 16);
      const result = await executeWebhookHandler(runtimeEnv, code, body.payload, body.headers || {}, allTools, sessionId);
      return Response.json(result);
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
        api_key_id?: string;
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
          api_key_id: body.api_key_id,
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
        api_key_id?: string;
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
        const batchReq: { inputs: any[] } = {
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
            api_key_id: inp.api_key_id,
          })),
        };
        // Use Workflow for each batch item (parallel Workflow instances)
        let result: any;
        if (env.AGENT_RUN_WORKFLOW) {
          const instances = await Promise.all(batchReq.inputs.map(async (inp: any, i: number) => {
            const inst = await env.AGENT_RUN_WORKFLOW.create({
              params: {
                agent_name: inp.agent_name || "agentos",
                input: inp.task || "",
                org_id: inp.org_id || "", project_id: inp.project_id || "",
                channel: inp.channel || "batch", channel_user_id: inp.channel_user_id || "",
                history: [], progress_key: `batch:${Date.now()}:${i}`,
              },
            });
            return inst;
          }));
          // Poll all instances (max 5 min)
          const results = await Promise.all(instances.map(async (inst: any) => {
            for (let i = 0; i < 150; i++) {
              await new Promise(r => setTimeout(r, 2000));
              const st = await inst.status().catch(() => ({ status: "unknown" }));
              if (st.status === "complete") return { success: true, ...(st as any).output };
              if (st.status === "errored") return { success: false, error: (st as any).error?.message || "failed", output: "" };
            }
            return { success: false, error: "timeout", output: "" };
          }));
          result = { results };
        } else {
          return Response.json({ error: "Batch requires Workflow binding (AGENT_RUN_WORKFLOW)" }, { status: 501 });
        }
        return Response.json({
          outputs: result.results.map((item: any) => ({
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
        api_key_id?: string;
      };

      // If session_id provided, compute breakdown from existing events
      if (body.session_id) {
        try {
          const events = await loadRuntimeEventsPage(env.HYPERDRIVE, {
            session_id: body.session_id, limit: 1000,
          });
          // Simple latency summary from events (computeLatencyBreakdown removed with engine.ts)
          const evts = events.events || [];
          const breakdown = {
            total_events: evts.length,
            first_event_at: evts[0]?.timestamp || null,
            last_event_at: evts[evts.length - 1]?.timestamp || null,
            wall_clock_ms: evts.length >= 2 ? (evts[evts.length - 1].timestamp - evts[0].timestamp) : 0,
          };
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
          api_key_id: body.api_key_id,
        }).catch(() => {}),
      );

      return Response.json({
        status: "running",
        message: "Run started. After completion, call this endpoint again with the session_id to get the breakdown.",
        websocket_url: `/agents/agentos-agent/${doName}`,
      }, { status: 202 });
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
    if ((telegramMatch || url.pathname === "/chat/telegram/webhook" || url.pathname === "/api/v1/chat/telegram/webhook") && request.method === "POST") {
      const agentName = telegramMatch?.[1] || env.TELEGRAM_AGENT_NAME || "my-assistant";

      // Load bot token + org_id: try Supabase first, fall back to env
      let botToken = "";
      let telegramOrgId = "";
      try {
        const { getDb } = await import("./runtime/db");
        const sql = await getDb(env.HYPERDRIVE);
        const agentRows = await sql`
          SELECT org_id FROM agents WHERE name = ${agentName} LIMIT 1
        `;
        telegramOrgId = agentRows[0]?.org_id || "";
        if (telegramOrgId) {
          const tokenRows = await sql`
            SELECT access_token FROM connector_tokens
            WHERE connector_name = 'telegram' AND org_id = ${telegramOrgId}
            LIMIT 1
          `;
          botToken = tokenRows[0]?.access_token || "";
        }
      } catch {}
      if (!botToken) botToken = env.TELEGRAM_BOT_TOKEN || "";
      if (!botToken) return Response.json({ error: "No Telegram bot token configured for agent: " + agentName }, { status: 503 });

      const payload = await request.json() as any;
      const msg = payload.message || payload.edited_message;
      if (!msg) return Response.json({ ok: true });

      const chatId = msg.chat?.id;
      if (!chatId) return Response.json({ ok: true });
      const messageId = msg.message_id;
      const chatType = msg.chat?.type || "private";
      const tgApi = `https://api.telegram.org/bot${botToken}`;

      // ── Parse media ──
      const rawText = msg.text || "";
      const rawCaption = msg.caption || "";
      const contentText = rawText || rawCaption;
      let hasPhoto = false, hasDocument = false, hasVoice = false, hasAudio = false, hasVideo = false;
      let tgFileId = "", tgFileName = "", tgMimeType = "";

      if (msg.photo?.length) { hasPhoto = true; tgFileId = msg.photo[msg.photo.length - 1].file_id; }
      if (msg.document) { hasDocument = true; tgFileId = msg.document.file_id; tgFileName = msg.document.file_name || ""; tgMimeType = msg.document.mime_type || ""; }
      if (msg.voice) { hasVoice = true; tgFileId = msg.voice.file_id; tgMimeType = msg.voice.mime_type || "audio/ogg"; }
      if (msg.audio) { hasAudio = true; tgFileId = msg.audio.file_id; tgFileName = msg.audio.file_name || ""; tgMimeType = msg.audio.mime_type || "audio/mpeg"; }
      if (msg.video) { hasVideo = true; tgFileId = msg.video.file_id; tgMimeType = msg.video.mime_type || "video/mp4"; }

      const hasMedia = hasPhoto || hasDocument || hasVoice || hasAudio || hasVideo;
      if (!contentText && !hasMedia) return Response.json({ ok: true });

      // ── Group mention filtering — only process if addressed to bot ──
      if (chatType === "group" || chatType === "supergroup") {
        if (!contentText.startsWith("/")) {
          let botId = 0, botUsername = "";
          try {
            const meResp = await fetch(`${tgApi}/getMe`);
            const meData = await meResp.json() as any;
            if (meData.ok) { botId = meData.result.id; botUsername = meData.result.username || ""; }
          } catch {}
          let addressed = false;
          if (msg.reply_to_message?.from?.id === botId) addressed = true;
          if (!addressed && botUsername && contentText.toLowerCase().includes(`@${botUsername.toLowerCase()}`)) addressed = true;
          if (!addressed) {
            for (const ent of (msg.entities || msg.caption_entities || [])) {
              if (ent.type === "mention") {
                const mention = contentText.slice(ent.offset, ent.offset + ent.length);
                if (botUsername && mention.toLowerCase() === `@${botUsername.toLowerCase()}`) { addressed = true; break; }
              }
              if (ent.type === "text_mention" && ent.user?.id === botId) { addressed = true; break; }
            }
          }
          if (!addressed) return Response.json({ ok: true });
        }
      }

      // ── Handle commands ──
      if (contentText.startsWith("/start")) {
        await fetch(`${tgApi}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text: `Hi! I'm ${agentName}. Send me a message, photo, voice note, or document and I'll help.\n\nCommands:\n/new — Clear conversation\n/help — Show help`, parse_mode: "Markdown" }),
        });
        return Response.json({ ok: true });
      }

      if (contentText.startsWith("/new")) {
        const tgUserId = String(chatId);
        const tgOrgPrefix = telegramOrgId ? `${telegramOrgId}-` : "";
        const doName = tgUserId ? `${tgOrgPrefix}${agentName}-u-${tgUserId}` : `${tgOrgPrefix}${agentName}`;
        const agId = env.AGENTOS_AGENT.idFromName(doName);
        const agentDo = env.AGENTOS_AGENT.get(agId);
        await agentDo.fetch(new Request("http://internal/reset", { method: "POST" }));
        await fetch(`${tgApi}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text: "Conversation cleared. Send a new message to start fresh.", parse_mode: "Markdown" }),
        });
        return Response.json({ ok: true });
      }

      if (contentText.startsWith("/help")) {
        await fetch(`${tgApi}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text: "I can help with research, code, data analysis, and more.\n\nCommands:\n/new — Clear conversation\n/project — List or load a project\n/project name — Load a project by name\n/save name — Save workspace as project\n/files — Show current workspace files\n/help — Show this message\n\nJust send text, photos, voice notes, or documents!", parse_mode: "Markdown" }),
        });
        return Response.json({ ok: true });
      }

      // /project, /save, /files commands handled below after cleanText is declared

      // ── Message deduplication (2s window) ──
      // Telegram sometimes delivers the same webhook twice, or users send rapid messages.
      // Use KV to deduplicate by message_id.
      if (env.AGENT_PROGRESS_KV) {
        const dedupeKey = `tg-dedup:${chatId}:${messageId}`;
        const existing = await env.AGENT_PROGRESS_KV.get(dedupeKey);
        if (existing) return Response.json({ ok: true }); // Already processing this message
        await env.AGENT_PROGRESS_KV.put(dedupeKey, "1", { expirationTtl: 10 });
      }

      // Typing indicator
      fetch(`${tgApi}/sendChatAction`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, action: "typing" }),
      }).catch(() => {});

      // ── Build agent input with media context ──
      const inputParts: string[] = [];
      const mediaUrls: string[] = [];
      const mediaTypes: string[] = [];

      let cleanText = contentText;
      if (cleanText.startsWith("/ask ")) cleanText = cleanText.slice(5);
      if (chatType !== "private") cleanText = cleanText.replace(/@\w+/g, "").trim();

      // /project [name], /save [name], /files — rewrite to agent-friendly prompts
      if (cleanText.startsWith("/project") || cleanText.startsWith("/save") || cleanText.startsWith("/files")) {
        const cmd = cleanText.split(" ")[0];
        const arg = cleanText.slice(cmd.length).trim();
        if (cmd === "/project" && !arg) cleanText = "List all my saved projects using list-project-versions, and show what's available.";
        else if (cmd === "/project") cleanText = `Load my project "${arg}" into the workspace using load-project, then tell me what files are available.`;
        else if (cmd === "/save" && arg) cleanText = `Save the current workspace as project "${arg}" using save-project.`;
        else if (cmd === "/save") cleanText = "Save the current workspace as a project. Ask me what to name it.";
        else if (cmd === "/files") cleanText = "List all files in my current workspace using load-folder with path='workspace'.";
      }

      if (cleanText) inputParts.push(cleanText);

      if (hasMedia && tgFileId) {
        try {
          const fileResp = await fetch(`${tgApi}/getFile?file_id=${encodeURIComponent(tgFileId)}`);
          const fileData = await fileResp.json() as any;
          if (fileData.ok) {
            const filePath = fileData.result.file_path as string;
            const fileUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`;
            mediaUrls.push(fileUrl);
            if (hasPhoto) { mediaTypes.push("image/jpeg"); inputParts.push("[User sent a photo]"); }
            else if (hasVoice || hasAudio) {
              mediaTypes.push(hasVoice ? "audio/ogg" : (tgMimeType || "audio/mpeg"));
              // Auto-transcribe voice/audio via Whisper STT
              try {
                const audioResp = await fetch(fileUrl);
                const audioBytes = new Uint8Array(await audioResp.arrayBuffer());
                const whisperResult = await env.AI.run("@cf/openai/whisper" as any, { audio: [...audioBytes] }) as any;
                const transcript = whisperResult?.text || "";
                if (transcript) {
                  inputParts.push(`[Voice message transcription]: ${transcript}`);
                } else {
                  inputParts.push(hasVoice ? "[User sent a voice message — transcription failed]" : `[User sent audio${tgFileName ? ": " + tgFileName : ""}]`);
                }
              } catch {
                inputParts.push(hasVoice ? "[User sent a voice message]" : `[User sent audio${tgFileName ? ": " + tgFileName : ""}]`);
              }
            }
            else if (hasDocument) {
              mediaTypes.push(tgMimeType || "application/octet-stream");
              inputParts.push(`[User sent document: ${tgFileName || "file"}]`);
              // Inject text content for readable docs (<100KB)
              if ((tgMimeType?.startsWith("text/") || /\.(txt|md|csv|json|yaml|yml|xml|log|py|js|ts|html|css)$/i.test(tgFileName)) && fileData.result.file_size < 100_000) {
                try { const dlResp = await fetch(fileUrl); inputParts.push(`[Content of ${tgFileName}]:\n${await dlResp.text()}`); } catch {}
              }
            }
            else if (hasVideo) { mediaTypes.push(tgMimeType || "video/mp4"); inputParts.push("[User sent a video]"); }
          }
        } catch {}
      }

      const userInput = inputParts.join("\n");
      if (!userInput) return Response.json({ ok: true });

      // ── Run agent in background — return 200 immediately ──
      ctx.waitUntil((async () => {
        try {
          const typingInterval = setInterval(() => {
            fetch(`${tgApi}/sendChatAction`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ chat_id: chatId, action: "typing" }),
            }).catch(() => {});
          }, 5000);

          const result = await runViaAgent(env, agentName, userInput, {
            org_id: telegramOrgId,
            channel: "telegram",
            channel_user_id: String(chatId),
            ...(mediaUrls.length ? { media_urls: mediaUrls, media_types: mediaTypes } : {}),
          });

          clearInterval(typingInterval);
          let output = result.output || "";
          if (!output && result.error) output = "Sorry, I couldn't process that. Try again.";
          if (!output) output = "No response generated.";

          // Markdown-aware chunking (preserves code blocks)
          const chunks = tgChunkMessage(output, 4096);
          for (let i = 0; i < chunks.length; i++) {
            const sendBody: any = { chat_id: chatId, text: chunks[i], parse_mode: "Markdown" };
            if (i === 0) sendBody.reply_to_message_id = messageId;
            const sendResp = await fetch(`${tgApi}/sendMessage`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(sendBody),
            });
            const sendData = await sendResp.json() as any;
            // Retry without markdown if parse fails
            if (!sendData.ok && String(sendData.description || "").toLowerCase().includes("can't parse")) {
              delete sendBody.parse_mode;
              await fetch(`${tgApi}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(sendBody) }).catch(() => {});
            }
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

    // ── WhatsApp Cloud API Webhook ──────────────────────────────
    // Handles: text, image, document, audio, video, location, contacts
    if ((url.pathname === "/chat/whatsapp/webhook" || url.pathname === "/api/v1/chat/whatsapp/webhook") && request.method === "POST") {
      const rawBody = await request.arrayBuffer();

      // GET = Meta verification handshake
      // (handled below for GET)

      // Signature verification
      const sig = request.headers.get("x-hub-signature-256") ?? "";
      const appSecret = env.WHATSAPP_APP_SECRET ?? "";
      if (appSecret && sig) {
        const expected = sig.startsWith("sha256=") ? sig.slice(7) : sig;
        try {
          const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(appSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
          const mac = await crypto.subtle.sign("HMAC", key, rawBody);
          const hex = [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, "0")).join("");
          if (hex !== expected) return Response.json({ error: "Invalid signature" }, { status: 401 });
        } catch {
          return Response.json({ error: "Signature verification failed" }, { status: 401 });
        }
      }

      let payload: any;
      try { payload = JSON.parse(new TextDecoder().decode(rawBody)); } catch { return Response.json({ ok: true }); }
      if (payload.object !== "whatsapp_business_account") return Response.json({ ok: true });

      const { getDb } = await import("./runtime/db");
      const sql = await getDb(env.HYPERDRIVE);

      for (const entry of payload.entry || []) {
        for (const change of entry.changes || []) {
          if (change.field !== "messages") continue;
          const value = change.value || {};
          const phoneNumberId = value.metadata?.phone_number_id || "";
          const messages = value.messages || [];

          // Resolve org
          let orgId = "";
          try {
            const rows = await sql`SELECT org_id FROM channel_configs WHERE channel = 'whatsapp' AND config->>'phone_number_id' = ${phoneNumberId} AND is_active = true LIMIT 1`;
            if (rows.length > 0) orgId = String(rows[0].org_id);
          } catch {}
          if (!orgId) continue;

          // Get access token
          let waToken = "";
          try {
            const rows = await sql`SELECT value_encrypted FROM secrets WHERE name = 'WHATSAPP_ACCESS_TOKEN' AND org_id = ${orgId} ORDER BY created_at DESC LIMIT 1`;
            if (rows.length > 0) waToken = String(rows[0].value_encrypted);
          } catch {}
          if (!waToken) continue;

          // Resolve agent
          let waAgentName = "";
          try {
            const rows = await sql`SELECT agent_name FROM channel_configs WHERE org_id = ${orgId} AND channel = 'whatsapp' AND is_active = true LIMIT 1`;
            waAgentName = rows[0]?.agent_name || "";
          } catch {}
          if (!waAgentName) {
            try {
              const rows = await sql`SELECT name FROM agents WHERE org_id = ${orgId} AND is_active = true ORDER BY created_at ASC LIMIT 1`;
              waAgentName = rows[0]?.name || "whatsapp-bot";
            } catch {}
          }

          for (const msg of messages) {
            const from = String(msg.from || "");
            const msgId = msg.id || "";
            const msgType = msg.type || "";

            // Mark as read
            if (msgId) {
              fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
                method: "POST",
                headers: { Authorization: `Bearer ${waToken}`, "Content-Type": "application/json" },
                body: JSON.stringify({ messaging_product: "whatsapp", status: "read", message_id: msgId }),
              }).catch(() => {});
            }

            // Build input
            const inputParts: string[] = [];
            const waMediaUrls: string[] = [];
            const waMediaTypes: string[] = [];

            if (msgType === "text" && msg.text?.body) {
              inputParts.push(String(msg.text.body));
            } else if (msgType === "image" && msg.image) {
              if (msg.image.caption) inputParts.push(String(msg.image.caption));
              inputParts.push("[User sent an image]");
              try {
                const mediaResp = await fetch(`https://graph.facebook.com/v21.0/${msg.image.id}`, { headers: { Authorization: `Bearer ${waToken}` } });
                const mediaData = await mediaResp.json() as any;
                if (mediaData.url) { waMediaUrls.push(mediaData.url); waMediaTypes.push(mediaData.mime_type || "image/jpeg"); }
              } catch {}
            } else if (msgType === "document" && msg.document) {
              if (msg.document.caption) inputParts.push(String(msg.document.caption));
              inputParts.push(`[User sent document: ${msg.document.filename || "file"}]`);
              try {
                const mediaResp = await fetch(`https://graph.facebook.com/v21.0/${msg.document.id}`, { headers: { Authorization: `Bearer ${waToken}` } });
                const mediaData = await mediaResp.json() as any;
                if (mediaData.url) { waMediaUrls.push(mediaData.url); waMediaTypes.push(mediaData.mime_type || "application/octet-stream"); }
              } catch {}
            } else if (msgType === "audio" && msg.audio) {
              inputParts.push("[User sent an audio message]");
              try {
                const mediaResp = await fetch(`https://graph.facebook.com/v21.0/${msg.audio.id}`, { headers: { Authorization: `Bearer ${waToken}` } });
                const mediaData = await mediaResp.json() as any;
                if (mediaData.url) { waMediaUrls.push(mediaData.url); waMediaTypes.push(mediaData.mime_type || "audio/ogg"); }
              } catch {}
            } else if (msgType === "video" && msg.video) {
              if (msg.video.caption) inputParts.push(String(msg.video.caption));
              inputParts.push("[User sent a video]");
            } else if (msgType === "location" && msg.location) {
              inputParts.push(`[User shared location: ${msg.location.latitude}, ${msg.location.longitude}${msg.location.name ? " — " + msg.location.name : ""}]`);
            } else if (msgType === "contacts" && msg.contacts?.length) {
              for (const contact of msg.contacts) {
                inputParts.push(`[User shared contact: ${contact.name?.formatted_name || "Unknown"}${contact.phones?.[0]?.phone ? " " + contact.phones[0].phone : ""}]`);
              }
            } else if (msgType === "reaction") {
              continue;
            } else {
              continue;
            }

            const waInput = inputParts.join("\n");
            if (!waInput) continue;

            // Run in background
            ctx.waitUntil((async () => {
              try {
                const result = await runViaAgent(env, waAgentName, waInput, {
                  org_id: orgId,
                  channel: "whatsapp",
                  channel_user_id: from,
                  ...(waMediaUrls.length ? { media_urls: waMediaUrls, media_types: waMediaTypes } : {}),
                });
                let output = result.output || "";
                if (!output && result.error) output = "Sorry, I couldn't process that.";
                if (!output) return;
                // Chunked reply
                const chunks = tgChunkMessage(output, 4096);
                for (let i = 0; i < chunks.length; i++) {
                  const body: any = { messaging_product: "whatsapp", to: from, type: "text", text: { body: chunks[i] } };
                  if (i === 0 && msgId) body.context = { message_id: msgId };
                  await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
                    method: "POST",
                    headers: { Authorization: `Bearer ${waToken}`, "Content-Type": "application/json" },
                    body: JSON.stringify(body),
                  }).catch(() => {});
                }
              } catch {}
            })());
          }
        }
      }
      return Response.json({ ok: true });
    }

    // GET /chat/whatsapp/webhook — Meta verification handshake
    if ((url.pathname === "/chat/whatsapp/webhook" || url.pathname === "/api/v1/chat/whatsapp/webhook") && request.method === "GET") {
      const verifyToken = env.WHATSAPP_VERIFY_TOKEN || "agentos-whatsapp-verify";
      const mode = url.searchParams.get("hub.mode");
      const token = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge");
      if (mode === "subscribe" && token === verifyToken) {
        return new Response(challenge || "", { status: 200, headers: { "Content-Type": "text/plain" } });
      }
      return Response.json({ error: "Verification failed" }, { status: 403 });
    }

    // ── Slack Events API Webhook ──────────────────────────────────
    if ((url.pathname === "/chat/slack/webhook" || url.pathname === "/api/v1/chat/slack/webhook") && request.method === "POST") {
      const rawBody = await request.text();

      // Signature verification
      const slackSigningSecret = env.SLACK_SIGNING_SECRET ?? "";
      if (slackSigningSecret) {
        const ts = request.headers.get("x-slack-request-timestamp") ?? "";
        const slackSig = request.headers.get("x-slack-signature") ?? "";
        const basestring = `v0:${ts}:${rawBody}`;
        try {
          const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(slackSigningSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
          const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(basestring));
          const hex = "v0=" + [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, "0")).join("");
          if (hex !== slackSig) return Response.json({ error: "Invalid signature" }, { status: 401 });
        } catch {}
      }

      let slackPayload: any;
      try { slackPayload = JSON.parse(rawBody); } catch { return Response.json({ ok: true }); }

      // URL verification challenge
      if (slackPayload.type === "url_verification") {
        return Response.json({ challenge: slackPayload.challenge });
      }
      if (slackPayload.type !== "event_callback") return Response.json({ ok: true });

      const slackEvent = slackPayload.event;
      if (!slackEvent) return Response.json({ ok: true });

      const isMsg = slackEvent.type === "message" && !slackEvent.bot_id && !slackEvent.subtype && slackEvent.text;
      const isFileShare = slackEvent.type === "message" && !slackEvent.bot_id && slackEvent.subtype === "file_share";
      const isMention = slackEvent.type === "app_mention" && slackEvent.text;
      if (!isMsg && !isMention && !isFileShare) return Response.json({ ok: true });

      const slackTeamId = slackPayload.team_id || "";
      const slackChannelId = slackEvent.channel || "";
      const slackUserId = slackEvent.user || "";
      const slackThreadTs = slackEvent.thread_ts || slackEvent.ts || "";

      const { getDb } = await import("./runtime/db");
      const sql = await getDb(env.HYPERDRIVE);

      let slackOrgId = "";
      try {
        const rows = await sql`SELECT org_id FROM channel_configs WHERE channel = 'slack' AND config->>'team_id' = ${slackTeamId} AND is_active = true LIMIT 1`;
        if (rows.length > 0) slackOrgId = String(rows[0].org_id);
      } catch {}
      if (!slackOrgId) return Response.json({ ok: true });

      let slackBotToken = "";
      try {
        const rows = await sql`SELECT value_encrypted FROM secrets WHERE name = 'SLACK_BOT_TOKEN' AND org_id = ${slackOrgId} ORDER BY created_at DESC LIMIT 1`;
        if (rows.length > 0) slackBotToken = String(rows[0].value_encrypted);
      } catch {}
      if (!slackBotToken) return Response.json({ ok: true });

      let slackAgentName = "";
      try {
        const rows = await sql`SELECT agent_name FROM channel_configs WHERE org_id = ${slackOrgId} AND channel = 'slack' AND is_active = true LIMIT 1`;
        slackAgentName = rows[0]?.agent_name || "";
      } catch {}
      if (!slackAgentName) {
        try {
          const rows = await sql`SELECT name FROM agents WHERE org_id = ${slackOrgId} AND is_active = true ORDER BY created_at ASC LIMIT 1`;
          slackAgentName = rows[0]?.name || "slack-bot";
        } catch {}
      }

      // Build input
      const slackInputParts: string[] = [];
      const slackMediaUrls: string[] = [];
      const slackMediaTypes: string[] = [];
      const cleanSlackText = String(slackEvent.text || "").replace(/<@[A-Z0-9]+>/g, "").trim();
      if (cleanSlackText) slackInputParts.push(cleanSlackText);

      // Handle file attachments
      if (slackEvent.files?.length) {
        for (const file of slackEvent.files) {
          const mime = file.mimetype || "";
          const fname = file.name || "file";
          if (file.url_private) {
            slackMediaUrls.push(file.url_private);
            slackMediaTypes.push(mime || "application/octet-stream");
            if (mime.startsWith("image/")) slackInputParts.push(`[User shared image: ${fname}]`);
            else slackInputParts.push(`[User shared file: ${fname}]`);

            // Inject text content for readable files
            if ((mime.startsWith("text/") || /^(txt|md|csv|json|yaml|yml|xml|log|py|js|ts|html|css)$/.test(file.filetype || "")) && (file.size || 0) < 100_000) {
              try {
                const dlResp = await fetch(file.url_private, { headers: { Authorization: `Bearer ${slackBotToken}` } });
                if (dlResp.ok) slackInputParts.push(`[Content of ${fname}]:\n${await dlResp.text()}`);
              } catch {}
            }
          }
        }
      }

      const slackInput = slackInputParts.join("\n");
      if (!slackInput) return Response.json({ ok: true });

      // Run in background
      ctx.waitUntil((async () => {
        try {
          const result = await runViaAgent(env, slackAgentName, slackInput, {
            org_id: slackOrgId,
            channel: "slack",
            channel_user_id: slackUserId,
            ...(slackMediaUrls.length ? { media_urls: slackMediaUrls, media_types: slackMediaTypes } : {}),
          });
          let output = result.output || "";
          if (!output && result.error) output = "Sorry, I couldn't process that.";
          if (!output) return;
          const chunks = tgChunkMessage(output, 3000);
          for (const chunk of chunks) {
            await fetch("https://slack.com/api/chat.postMessage", {
              method: "POST",
              headers: { Authorization: `Bearer ${slackBotToken}`, "Content-Type": "application/json" },
              body: JSON.stringify({ channel: slackChannelId, text: chunk, thread_ts: slackThreadTs }),
            }).catch(() => {});
          }
        } catch {}
      })());

      return Response.json({ ok: true });
    }

    // ── Instagram DMs Webhook ──────────────────────────────────
    // Instagram Messaging API (via Meta Graph API) — handles text, images,
    // story replies, story mentions, shared reels, reactions, likes.
    if ((url.pathname === "/chat/instagram/webhook" || url.pathname === "/api/v1/chat/instagram/webhook") && request.method === "POST") {
      const rawBody = await request.arrayBuffer();
      const sig = request.headers.get("x-hub-signature-256") ?? "";
      const appSecret = env.INSTAGRAM_APP_SECRET ?? env.FACEBOOK_APP_SECRET ?? "";
      if (appSecret && sig) {
        const expected = sig.startsWith("sha256=") ? sig.slice(7) : sig;
        try {
          const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(appSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
          const mac = await crypto.subtle.sign("HMAC", key, rawBody);
          const hex = [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, "0")).join("");
          if (hex !== expected) return Response.json({ error: "Invalid signature" }, { status: 401 });
        } catch { return Response.json({ error: "Signature verification failed" }, { status: 401 }); }
      }

      let igPayload: any;
      try { igPayload = JSON.parse(new TextDecoder().decode(rawBody)); } catch { return Response.json({ ok: true }); }
      if (igPayload.object !== "instagram") return Response.json({ ok: true });

      const { getDb } = await import("./runtime/db");
      const sql = await getDb(env.HYPERDRIVE);

      for (const entry of igPayload.entry || []) {
        const igPageUserId = entry.id || "";

        for (const messaging of entry.messaging || []) {
          const senderId = messaging.sender?.id || "";
          const recipientId = messaging.recipient?.id || "";
          if (!senderId || senderId === recipientId) continue;

          // Resolve org
          let igOrgId = "";
          try {
            const rows = await sql`SELECT org_id FROM channel_configs WHERE channel = 'instagram' AND (config->>'page_id' = ${igPageUserId} OR config->>'ig_user_id' = ${recipientId}) AND is_active = true LIMIT 1`;
            if (rows.length > 0) igOrgId = String(rows[0].org_id);
          } catch {}
          if (!igOrgId) continue;

          let igPageToken = "";
          try {
            const rows = await sql`SELECT value_encrypted FROM secrets WHERE name = 'INSTAGRAM_PAGE_TOKEN' AND org_id = ${igOrgId} ORDER BY created_at DESC LIMIT 1`;
            if (rows.length > 0) igPageToken = String(rows[0].value_encrypted);
          } catch {}
          if (!igPageToken) continue;

          // Resolve agent
          let igAgentName = "";
          try {
            const rows = await sql`SELECT agent_name FROM channel_configs WHERE org_id = ${igOrgId} AND channel = 'instagram' AND is_active = true LIMIT 1`;
            igAgentName = rows[0]?.agent_name || "";
          } catch {}
          if (!igAgentName) {
            try {
              const rows = await sql`SELECT name FROM agents WHERE org_id = ${igOrgId} AND is_active = true ORDER BY created_at ASC LIMIT 1`;
              igAgentName = rows[0]?.name || "instagram-bot";
            } catch {}
          }

          // Build input from various IG message types
          const igInputParts: string[] = [];
          const igMediaUrls: string[] = [];
          const igMediaTypes: string[] = [];
          const igMsg = messaging.message;
          const igPostback = messaging.postback;

          if (igMsg) {
            // Text message
            if (igMsg.text) igInputParts.push(String(igMsg.text));

            // Attachments: images, video, audio, files, share (story/reel shares)
            if (igMsg.attachments?.length) {
              for (const att of igMsg.attachments) {
                const attType = att.type || "";
                const attUrl = att.payload?.url || "";
                if (attType === "image" && attUrl) {
                  igMediaUrls.push(attUrl);
                  igMediaTypes.push("image/jpeg");
                  igInputParts.push("[User sent an image]");
                } else if (attType === "video" && attUrl) {
                  igMediaUrls.push(attUrl);
                  igMediaTypes.push("video/mp4");
                  igInputParts.push("[User sent a video]");
                } else if (attType === "audio" && attUrl) {
                  igMediaUrls.push(attUrl);
                  igMediaTypes.push("audio/mp4");
                  igInputParts.push("[User sent a voice message]");
                } else if (attType === "file" && attUrl) {
                  igMediaUrls.push(attUrl);
                  igMediaTypes.push("application/octet-stream");
                  igInputParts.push("[User sent a file]");
                } else if (attType === "share") {
                  // Shared post/reel/story
                  const shareUrl = att.payload?.url || "";
                  if (shareUrl) igInputParts.push(`[User shared a post: ${shareUrl}]`);
                  else igInputParts.push("[User shared a post]");
                } else if (attType === "story_mention") {
                  // User mentioned the business in their story
                  const storyUrl = att.payload?.url || "";
                  igInputParts.push(`[User mentioned you in their story${storyUrl ? ": " + storyUrl : ""}]`);
                  if (storyUrl) { igMediaUrls.push(storyUrl); igMediaTypes.push("image/jpeg"); }
                }
              }
            }

            // Story reply — user replied to a story
            if (igMsg.reply_to?.story) {
              const storyUrl = igMsg.reply_to.story.url || "";
              igInputParts.push(`[This is a reply to your story${storyUrl ? ": " + storyUrl : ""}]`);
              if (storyUrl) { igMediaUrls.push(storyUrl); igMediaTypes.push("image/jpeg"); }
            }

            // Reel reply
            if (igMsg.reply_to?.mid) {
              igInputParts.push("[This is a reply to a previous message]");
            }

            // Quick reply payload
            if (igMsg.quick_reply?.payload) {
              igInputParts.push(`[Quick reply: ${igMsg.quick_reply.payload}]`);
            }

            // Reaction — the user reacted to a message
            if (igMsg.is_deleted) continue; // Skip unsent messages

          } else if (messaging.reaction) {
            // Reaction event (like/emoji on a message) — skip agent invocation
            continue;

          } else if (igPostback) {
            // Postback from ice-breaker buttons or get-started
            igInputParts.push(igPostback.payload || igPostback.title || "Get started");

          } else if (messaging.referral) {
            // Referral — user clicked an ad or link that opens IG DM
            igInputParts.push(`[User arrived via referral${messaging.referral.ref ? ": " + messaging.referral.ref : ""}]`);

          } else {
            continue;
          }

          const igInput = igInputParts.join("\n");
          if (!igInput) continue;

          // Mark as seen (Instagram Messaging API)
          fetch(`https://graph.facebook.com/v21.0/${igPageUserId}/messages`, {
            method: "POST",
            headers: { Authorization: `Bearer ${igPageToken}`, "Content-Type": "application/json" },
            body: JSON.stringify({ recipient: { id: senderId }, sender_action: "mark_seen" }),
          }).catch(() => {});

          // Typing indicator
          fetch(`https://graph.facebook.com/v21.0/${igPageUserId}/messages`, {
            method: "POST",
            headers: { Authorization: `Bearer ${igPageToken}`, "Content-Type": "application/json" },
            body: JSON.stringify({ recipient: { id: senderId }, sender_action: "typing_on" }),
          }).catch(() => {});

          // Run agent in background
          ctx.waitUntil((async () => {
            try {
              const result = await runViaAgent(env, igAgentName, igInput, {
                org_id: igOrgId,
                channel: "instagram",
                channel_user_id: senderId,
                ...(igMediaUrls.length ? { media_urls: igMediaUrls, media_types: igMediaTypes } : {}),
              });
              let output = result.output || "";
              if (!output && result.error) output = "Sorry, I couldn't process that.";
              if (!output) return;

              // IG message limit is 1000 chars
              const chunks = tgChunkMessage(output, 1000);
              for (const chunk of chunks) {
                await fetch(`https://graph.facebook.com/v21.0/${igPageUserId}/messages`, {
                  method: "POST",
                  headers: { Authorization: `Bearer ${igPageToken}`, "Content-Type": "application/json" },
                  body: JSON.stringify({
                    recipient: { id: senderId },
                    message: { text: chunk },
                    messaging_type: "RESPONSE",
                  }),
                }).catch(() => {});
              }
            } catch {}
          })());
        }
      }
      return Response.json({ ok: true });
    }

    // GET /chat/instagram/webhook — Meta verification handshake
    if ((url.pathname === "/chat/instagram/webhook" || url.pathname === "/api/v1/chat/instagram/webhook") && request.method === "GET") {
      const verifyToken = env.INSTAGRAM_VERIFY_TOKEN || env.FACEBOOK_VERIFY_TOKEN || "agentos-meta-verify";
      const mode = url.searchParams.get("hub.mode");
      const token = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge");
      if (mode === "subscribe" && token === verifyToken) {
        return new Response(challenge || "", { status: 200, headers: { "Content-Type": "text/plain" } });
      }
      return Response.json({ error: "Verification failed" }, { status: 403 });
    }

    // ── Facebook Messenger Webhook ───────────────────────────────
    // Handles text, images, video, audio, files, stickers, location,
    // quick replies, postbacks (Get Started, persistent menu), referrals.
    if ((url.pathname === "/chat/messenger/webhook" || url.pathname === "/api/v1/chat/messenger/webhook") && request.method === "POST") {
      const rawBody = await request.arrayBuffer();
      const sig = request.headers.get("x-hub-signature-256") ?? "";
      const appSecret = env.FACEBOOK_APP_SECRET ?? "";
      if (appSecret && sig) {
        const expected = sig.startsWith("sha256=") ? sig.slice(7) : sig;
        try {
          const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(appSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
          const mac = await crypto.subtle.sign("HMAC", key, rawBody);
          const hex = [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, "0")).join("");
          if (hex !== expected) return Response.json({ error: "Invalid signature" }, { status: 401 });
        } catch { return Response.json({ error: "Signature verification failed" }, { status: 401 }); }
      }

      let fbPayload: any;
      try { fbPayload = JSON.parse(new TextDecoder().decode(rawBody)); } catch { return Response.json({ ok: true }); }
      if (fbPayload.object !== "page") return Response.json({ ok: true });

      const { getDb } = await import("./runtime/db");
      const sql = await getDb(env.HYPERDRIVE);

      for (const entry of fbPayload.entry || []) {
        const pageId = entry.id || "";

        for (const messaging of entry.messaging || []) {
          const senderId = messaging.sender?.id || "";
          const recipientId = messaging.recipient?.id || "";
          if (!senderId || senderId === recipientId) continue;

          // Resolve org
          let fbOrgId = "";
          try {
            const rows = await sql`SELECT org_id FROM channel_configs WHERE channel = 'messenger' AND config->>'page_id' = ${pageId} AND is_active = true LIMIT 1`;
            if (rows.length > 0) fbOrgId = String(rows[0].org_id);
          } catch {}
          if (!fbOrgId) continue;

          let fbPageToken = "";
          try {
            const rows = await sql`SELECT value_encrypted FROM secrets WHERE name = 'FACEBOOK_PAGE_TOKEN' AND org_id = ${fbOrgId} ORDER BY created_at DESC LIMIT 1`;
            if (rows.length > 0) fbPageToken = String(rows[0].value_encrypted);
          } catch {}
          if (!fbPageToken) continue;

          // Resolve agent
          let fbAgentName = "";
          try {
            const rows = await sql`SELECT agent_name FROM channel_configs WHERE org_id = ${fbOrgId} AND channel = 'messenger' AND is_active = true LIMIT 1`;
            fbAgentName = rows[0]?.agent_name || "";
          } catch {}
          if (!fbAgentName) {
            try {
              const rows = await sql`SELECT name FROM agents WHERE org_id = ${fbOrgId} AND is_active = true ORDER BY created_at ASC LIMIT 1`;
              fbAgentName = rows[0]?.name || "messenger-bot";
            } catch {}
          }

          // Build input
          const fbInputParts: string[] = [];
          const fbMediaUrls: string[] = [];
          const fbMediaTypes: string[] = [];
          const fbMsg = messaging.message;
          const fbPostback = messaging.postback;

          if (fbMsg) {
            // Skip echo messages (messages sent by the page itself)
            if (fbMsg.is_echo) continue;

            // Text
            if (fbMsg.text) fbInputParts.push(String(fbMsg.text));

            // Attachments: image, video, audio, file, location, fallback (link shares)
            if (fbMsg.attachments?.length) {
              for (const att of fbMsg.attachments) {
                const attType = att.type || "";
                const attUrl = att.payload?.url || "";
                if (attType === "image" && attUrl) {
                  fbMediaUrls.push(attUrl);
                  fbMediaTypes.push("image/jpeg");
                  // Check if sticker
                  if (att.payload?.sticker_id) {
                    fbInputParts.push(`[User sent a sticker (${att.payload.sticker_id})]`);
                  } else {
                    fbInputParts.push("[User sent an image]");
                  }
                } else if (attType === "video" && attUrl) {
                  fbMediaUrls.push(attUrl);
                  fbMediaTypes.push("video/mp4");
                  fbInputParts.push("[User sent a video]");
                } else if (attType === "audio" && attUrl) {
                  fbMediaUrls.push(attUrl);
                  fbMediaTypes.push("audio/mp4");
                  fbInputParts.push("[User sent a voice message]");
                } else if (attType === "file" && attUrl) {
                  fbMediaUrls.push(attUrl);
                  fbMediaTypes.push("application/octet-stream");
                  fbInputParts.push("[User sent a file]");
                } else if (attType === "location" && att.payload) {
                  const lat = att.payload.coordinates?.lat || "";
                  const lng = att.payload.coordinates?.long || "";
                  fbInputParts.push(`[User shared location: ${lat}, ${lng}]`);
                } else if (attType === "fallback") {
                  // Link share / unfurled URL
                  const title = att.title || "";
                  const shareUrl = att.url || attUrl || "";
                  fbInputParts.push(`[User shared a link${title ? ": " + title : ""}${shareUrl ? " " + shareUrl : ""}]`);
                }
              }
            }

            // Quick reply
            if (fbMsg.quick_reply?.payload) {
              fbInputParts.push(`[Quick reply: ${fbMsg.quick_reply.payload}]`);
            }

          } else if (fbPostback) {
            // Postback from Get Started button, persistent menu, or generic template buttons
            fbInputParts.push(fbPostback.payload || fbPostback.title || "Get started");
            if (fbPostback.referral?.ref) {
              fbInputParts.push(`[Referral: ${fbPostback.referral.ref}]`);
            }

          } else if (messaging.referral) {
            // Direct referral (m.me link, ad click, etc.)
            fbInputParts.push(`[User arrived via referral${messaging.referral.ref ? ": " + messaging.referral.ref : ""}]`);

          } else if (messaging.read || messaging.delivery) {
            // Read receipt / delivery confirmation — skip
            continue;

          } else if (messaging.optin) {
            // Plugin opt-in (Send to Messenger, checkbox plugin)
            fbInputParts.push(`[User opted in${messaging.optin.ref ? " with ref: " + messaging.optin.ref : ""}]`);

          } else {
            continue;
          }

          const fbInput = fbInputParts.join("\n");
          if (!fbInput) continue;

          // Mark as seen
          fetch(`https://graph.facebook.com/v21.0/${pageId}/messages`, {
            method: "POST",
            headers: { Authorization: `Bearer ${fbPageToken}`, "Content-Type": "application/json" },
            body: JSON.stringify({ recipient: { id: senderId }, sender_action: "mark_seen" }),
          }).catch(() => {});

          // Typing indicator
          fetch(`https://graph.facebook.com/v21.0/${pageId}/messages`, {
            method: "POST",
            headers: { Authorization: `Bearer ${fbPageToken}`, "Content-Type": "application/json" },
            body: JSON.stringify({ recipient: { id: senderId }, sender_action: "typing_on" }),
          }).catch(() => {});

          // Run agent in background
          ctx.waitUntil((async () => {
            try {
              const result = await runViaAgent(env, fbAgentName, fbInput, {
                org_id: fbOrgId,
                channel: "messenger",
                channel_user_id: senderId,
                ...(fbMediaUrls.length ? { media_urls: fbMediaUrls, media_types: fbMediaTypes } : {}),
              });
              let output = result.output || "";
              if (!output && result.error) output = "Sorry, I couldn't process that.";
              if (!output) return;

              // Messenger limit is 2000 chars per message
              const chunks = tgChunkMessage(output, 2000);
              for (const chunk of chunks) {
                await fetch(`https://graph.facebook.com/v21.0/${pageId}/messages`, {
                  method: "POST",
                  headers: { Authorization: `Bearer ${fbPageToken}`, "Content-Type": "application/json" },
                  body: JSON.stringify({
                    recipient: { id: senderId },
                    message: { text: chunk },
                    messaging_type: "RESPONSE",
                  }),
                }).catch(() => {});
              }
            } catch {}
          })());
        }
      }
      return Response.json({ ok: true });
    }

    // GET /chat/messenger/webhook — Meta verification handshake
    if ((url.pathname === "/chat/messenger/webhook" || url.pathname === "/api/v1/chat/messenger/webhook") && request.method === "GET") {
      const verifyToken = env.FACEBOOK_VERIFY_TOKEN || "agentos-meta-verify";
      const mode = url.searchParams.get("hub.mode");
      const token = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge");
      if (mode === "subscribe" && token === verifyToken) {
        return new Response(challenge || "", { status: 200, headers: { "Content-Type": "text/plain" } });
      }
      return Response.json({ error: "Verification failed" }, { status: 403 });
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

      // /cf/db/query — service-to-service DB query endpoint with query allowlist.
      // Intended for control-plane data-proxy usage (RLS-friendly session context).
      if (url.pathname === "/cf/db/query" && request.method === "POST") {
        const body = await request.json() as {
          query_id?: string;
          context?: { org_id?: string; user_id?: string; role?: string };
          params?: Record<string, unknown>;
        };

        const queryId = String(body.query_id || "").trim();
        const orgId = String(body.context?.org_id || "").trim();
        const userId = String(body.context?.user_id || "").trim();
        const role = String(body.context?.role || "").trim();

        if (!queryId) {
          return Response.json({ error: "query_id is required" }, { status: 400 });
        }
        if (!orgId) {
          return Response.json({ error: "context.org_id is required" }, { status: 400 });
        }
        if (!env.HYPERDRIVE) {
          return Response.json({ error: "hyperdrive_not_configured" }, { status: 503 });
        }

        try {
          const { getDb } = await import("./runtime/db");
          const sql = await getDb(env.HYPERDRIVE);

          const rows = await sql.begin(async (tx: any) => {
            await tx`SELECT set_config('app.current_org_id', ${orgId}, true)`;
            await tx`SELECT set_config('app.current_user_id', ${userId || "system"}, true)`;
            await tx`SELECT set_config('app.current_role', ${role || "service"}, true)`;

            // ── Agent queries ──────────────────────────────────────
            if (queryId === "agents.list_active_by_org") {
              return await tx`
                SELECT name, description, config_json, is_active, created_at, updated_at
                FROM agents
                WHERE org_id = ${orgId} AND is_active = true
                ORDER BY created_at DESC
              `;
            }
            if (queryId === "agents.config") {
              const agentName = String(body.params?.agent_name || "");
              if (!agentName) throw new Error("params.agent_name required");
              return await tx`
                SELECT name, config_json, description FROM agents
                WHERE name = ${agentName} AND org_id = ${orgId} AND is_active = true LIMIT 1
              `;
            }
            if (queryId === "agents.versions") {
              const agentName = String(body.params?.agent_name || "");
              const limit = Math.min(Number(body.params?.limit) || 20, 100);
              return await tx`
                SELECT version, created_by, created_at FROM agent_versions
                WHERE agent_name = ${agentName}
                ORDER BY created_at DESC LIMIT ${limit}
              `;
            }

            // ── Session queries ───────────────────────────────────
            if (queryId === "sessions.list") {
              const limit = Math.min(Number(body.params?.limit) || 50, 500);
              const offset = Math.max(Number(body.params?.offset) || 0, 0);
              const agentName = body.params?.agent_name ? String(body.params.agent_name) : null;
              const status = body.params?.status ? String(body.params.status) : null;
              return agentName && status
                ? await tx`SELECT session_id, agent_name, status, input_text, output_text, cost_total_usd, wall_clock_seconds, step_count, trace_id, created_at FROM sessions WHERE org_id = ${orgId} AND agent_name = ${agentName} AND status = ${status} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`
                : agentName
                  ? await tx`SELECT session_id, agent_name, status, input_text, output_text, cost_total_usd, wall_clock_seconds, step_count, trace_id, created_at FROM sessions WHERE org_id = ${orgId} AND agent_name = ${agentName} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`
                  : status
                    ? await tx`SELECT session_id, agent_name, status, input_text, output_text, cost_total_usd, wall_clock_seconds, step_count, trace_id, created_at FROM sessions WHERE org_id = ${orgId} AND status = ${status} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`
                    : await tx`SELECT session_id, agent_name, status, input_text, output_text, cost_total_usd, wall_clock_seconds, step_count, trace_id, created_at FROM sessions WHERE org_id = ${orgId} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`;
            }
            if (queryId === "sessions.detail") {
              const sessionId = String(body.params?.session_id || "");
              if (!sessionId) throw new Error("params.session_id required");
              return await tx`SELECT * FROM sessions WHERE session_id = ${sessionId} AND org_id = ${orgId} LIMIT 1`;
            }
            if (queryId === "sessions.turns") {
              const sessionId = String(body.params?.session_id || "");
              if (!sessionId) throw new Error("params.session_id required");
              // Verify session belongs to org first
              const check = await tx`SELECT 1 FROM sessions WHERE session_id = ${sessionId} AND org_id = ${orgId}`;
              if (check.length === 0) return [];
              return await tx`SELECT * FROM turns WHERE session_id = ${sessionId} ORDER BY turn_number`;
            }
            if (queryId === "sessions.stats") {
              const agentName = body.params?.agent_name ? String(body.params.agent_name) : null;
              const sinceDays = Math.min(Number(body.params?.since_days) || 7, 90);
              const since = new Date(Date.now() - sinceDays * 86400 * 1000).toISOString();
              return agentName
                ? await tx`SELECT COUNT(*) as total, COALESCE(AVG(cost_total_usd),0) as avg_cost, COALESCE(AVG(wall_clock_seconds),0) as avg_latency, COALESCE(SUM(CASE WHEN status='success' THEN 1 ELSE 0 END)::float/NULLIF(COUNT(*),0),0) as success_rate FROM sessions WHERE org_id = ${orgId} AND agent_name = ${agentName} AND created_at >= ${since}`
                : await tx`SELECT COUNT(*) as total, COALESCE(AVG(cost_total_usd),0) as avg_cost, COALESCE(AVG(wall_clock_seconds),0) as avg_latency, COALESCE(SUM(CASE WHEN status='success' THEN 1 ELSE 0 END)::float/NULLIF(COUNT(*),0),0) as success_rate FROM sessions WHERE org_id = ${orgId} AND created_at >= ${since}`;
            }

            // ── Issue queries ─────────────────────────────────────
            if (queryId === "issues.open") {
              const limit = Math.min(Number(body.params?.limit) || 50, 200);
              const agentName = body.params?.agent_name ? String(body.params.agent_name) : null;
              return agentName
                ? await tx`SELECT * FROM issues WHERE org_id = ${orgId} AND agent_name = ${agentName} AND status = 'open' ORDER BY severity DESC, created_at DESC LIMIT ${limit}`
                : await tx`SELECT * FROM issues WHERE org_id = ${orgId} AND status = 'open' ORDER BY severity DESC, created_at DESC LIMIT ${limit}`;
            }
            if (queryId === "issues.summary") {
              return await tx`SELECT status, severity, COUNT(*) as count FROM issues WHERE org_id = ${orgId} GROUP BY status, severity`;
            }

            // ── Eval queries ──────────────────────────────────────
            if (queryId === "eval.runs") {
              const agentName = String(body.params?.agent_name || "");
              const limit = Math.min(Number(body.params?.limit) || 20, 100);
              return agentName
                ? await tx`SELECT * FROM eval_runs WHERE agent_name = ${agentName} AND org_id = ${orgId} ORDER BY created_at DESC LIMIT ${limit}`
                : await tx`SELECT * FROM eval_runs WHERE org_id = ${orgId} ORDER BY created_at DESC LIMIT ${limit}`;
            }
            if (queryId === "eval.latest_run") {
              const agentName = String(body.params?.agent_name || "");
              if (!agentName) throw new Error("params.agent_name required");
              return await tx`SELECT * FROM eval_runs WHERE agent_name = ${agentName} AND org_id = ${orgId} ORDER BY created_at DESC LIMIT 1`;
            }
            if (queryId === "eval.trials") {
              const runId = Number(body.params?.run_id);
              if (!runId) throw new Error("params.run_id required");
              return await tx`SELECT * FROM eval_trials WHERE eval_run_id = ${runId} ORDER BY trial_index`;
            }

            // ── Billing queries ───────────────────────────────────
            if (queryId === "billing.usage") {
              const sinceDays = Math.min(Number(body.params?.since_days) || 30, 365);
              const since = new Date(Date.now() - sinceDays * 86400 * 1000).toISOString();
              return await tx`SELECT COALESCE(SUM(total_cost_usd),0) as total, COALESCE(SUM(input_tokens),0) as input_tokens, COALESCE(SUM(output_tokens),0) as output_tokens FROM billing_records WHERE org_id = ${orgId} AND created_at >= ${since}`;
            }
            if (queryId === "billing.by_agent") {
              const sinceDays = Math.min(Number(body.params?.since_days) || 30, 365);
              const since = new Date(Date.now() - sinceDays * 86400 * 1000).toISOString();
              return await tx`SELECT agent_name, SUM(total_cost_usd) as cost, COUNT(*) as sessions FROM billing_records WHERE org_id = ${orgId} AND created_at >= ${since} GROUP BY agent_name ORDER BY cost DESC`;
            }
            if (queryId === "billing.by_model") {
              const sinceDays = Math.min(Number(body.params?.since_days) || 30, 365);
              const since = new Date(Date.now() - sinceDays * 86400 * 1000).toISOString();
              return await tx`SELECT model, SUM(total_cost_usd) as cost, COUNT(*) as calls FROM billing_records WHERE org_id = ${orgId} AND created_at >= ${since} GROUP BY model ORDER BY cost DESC`;
            }

            // ── Feedback queries ──────────────────────────────────
            if (queryId === "feedback.recent") {
              const limit = Math.min(Number(body.params?.limit) || 50, 200);
              return await tx`SELECT * FROM user_feedback WHERE org_id = ${orgId} ORDER BY created_at DESC LIMIT ${limit}`;
            }
            if (queryId === "feedback.stats") {
              const sinceDays = Math.min(Number(body.params?.since_days) || 30, 365);
              const since = new Date(Date.now() - sinceDays * 86400 * 1000).toISOString();
              return await tx`SELECT rating, COUNT(*) as count FROM user_feedback WHERE org_id = ${orgId} AND created_at >= ${since} GROUP BY rating`;
            }

            // ── Security queries ──────────────────────────────────
            if (queryId === "security.scans") {
              const limit = Math.min(Number(body.params?.limit) || 20, 100);
              return await tx`SELECT * FROM security_scans WHERE org_id = ${orgId} ORDER BY created_at DESC LIMIT ${limit}`;
            }

            // ── Memory queries ────────────────────────────────────
            if (queryId === "memory.facts") {
              const agentName = String(body.params?.agent_name || "");
              const limit = Math.min(Number(body.params?.limit) || 50, 200);
              return await tx`SELECT * FROM facts WHERE agent_name = ${agentName} AND org_id = ${orgId} LIMIT ${limit}`;
            }
            if (queryId === "memory.episodes") {
              const agentName = String(body.params?.agent_name || "");
              const limit = Math.min(Number(body.params?.limit) || 50, 200);
              return await tx`SELECT * FROM episodes WHERE agent_name = ${agentName} AND org_id = ${orgId} ORDER BY created_at DESC LIMIT ${limit}`;
            }

            throw new Error(`unsupported query_id: ${queryId}`);
          });

          return Response.json({
            query_id: queryId,
            row_count: Array.isArray(rows) ? rows.length : 0,
            rows,
          });
        } catch (err: any) {
          const message = err instanceof Error ? err.message : String(err);
          if (message.startsWith("unsupported query_id:")) {
            return Response.json({ error: message }, { status: 400 });
          }
          return Response.json({ error: message }, { status: 500 });
        }
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
          url: string; limit?: number; depth?: number; formats?: string[]; timeout_ms?: number;
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

          // Poll for results (deadline-bound to avoid hanging indefinitely)
          const jobId = startData.result;
          if (!jobId) return Response.json(startData);
          const maxWaitMs = Math.max(15_000, Math.min(Number(body.timeout_ms || 60_000), 300_000));
          const pollIntervalMs = 5_000;
          const startedAt = Date.now();
          while (Date.now() - startedAt < maxWaitMs) {
            await new Promise(r => setTimeout(r, pollIntervalMs));
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
              const timeout = clampSandboxTimeoutSeconds(args.timeout_seconds);
              const sandboxId = `session-${session_id || "default"}`;
              const sandbox = getSandbox(env.SANDBOX, sandboxId);
              const execResult = await sandbox.exec(command, sandboxExecOptions(timeout));
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
              const timeout = clampSandboxTimeoutSeconds(args.timeout_seconds);
              const sandboxId = `session-${session_id || "default"}`;
              const deps = extractPythonImportCandidates(String(code));
              const missing = await checkMissingPythonModulesInSandbox(env, sandboxId, deps);
              if (missing.length > 0) {
                result = JSON.stringify({
                  stdout: "",
                  stderr: pythonMissingModuleError(missing),
                  exit_code: 1,
                  missing_modules: missing,
                });
                break;
              }
              const sandbox = getSandbox(env.SANDBOX, sandboxId);
              // Write code to temp file and execute (handles multiline, imports, etc.)
              const tmpFile = `/tmp/exec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.py`;
              await sandbox.writeFile(tmpFile, code);
              try {
                const execResult = await sandbox.exec(`python3 ${tmpFile}`, sandboxExecOptions(timeout));
                result = JSON.stringify({
                  stdout: execResult.stdout || "",
                  stderr: execResult.stderr || "",
                  exit_code: execResult.exitCode ?? 0,
                });
              } finally {
                await sandbox.exec(`rm -f ${tmpFile}`, sandboxExecOptions(5)).catch(() => {});
              }
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
              const execResult = await sandbox.exec(command, sandboxExecOptions(args.timeout || 30));
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
              if (language === "javascript") {
                try {
                  const workerCode = `const __o=[],__e=[];console.log=(...a)=>__o.push(a.map(String).join(" "));console.error=(...a)=>__e.push(a.map(String).join(" "));export default{async fetch(){try{${code};return Response.json({stdout:__o.join("\\n"),stderr:__e.join("\\n"),exit_code:0})}catch(e){return Response.json({stdout:__o.join("\\n"),stderr:e.message||String(e),exit_code:1})}}}`;
                  const loaded = await getCachedDynamicExecWorker(env, workerCode);
                  const controller = new AbortController();
                  const timer = setTimeout(() => controller.abort(), timeout);
                  const execResp = await loaded.getEntrypoint().fetch("http://internal/run", { signal: controller.signal });
                  clearTimeout(timer);
                  result = JSON.stringify(await execResp.json());
                } catch (err: any) {
                  result = JSON.stringify({ stdout: "", stderr: err.message, exit_code: 1 });
                }
              } else if (language === "python") {
                try {
                  // Python must run in sandbox container, not V8 isolate.
                  const sandboxId = `session-${session_id || "default"}`;
                  const deps = extractPythonImportCandidates(String(code));
                  const missing = await checkMissingPythonModulesInSandbox(env, sandboxId, deps);
                  if (missing.length > 0) {
                    result = JSON.stringify({
                      stdout: "",
                      stderr: pythonMissingModuleError(missing),
                      exit_code: 1,
                      missing_modules: missing,
                    });
                    break;
                  }
                  const sandbox = getSandbox(env.SANDBOX, sandboxId);
                  const tmpFile = `/tmp/exec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.py`;
                  await sandbox.writeFile(tmpFile, code);
                  try {
                    const execResult = await sandbox.exec(
                      `python3 ${tmpFile}`,
                      sandboxExecOptions(Math.ceil(timeout / 1000)),
                    );
                    result = JSON.stringify({
                      stdout: execResult.stdout || "",
                      stderr: execResult.stderr || "",
                      exit_code: execResult.exitCode ?? 0,
                    });
                  } finally {
                    await sandbox.exec(`rm -f ${tmpFile}`, sandboxExecOptions(5)).catch(() => {});
                  }
                } catch (err: any) {
                  result = JSON.stringify({ stdout: "", stderr: err.message, exit_code: 1 });
                }
              } else {
                // bash/shell — use Sandbox
                const sandboxId = `session-${session_id || "default"}`;
                const sandbox = getSandbox(env.SANDBOX, sandboxId);
                const execResult = await sandbox.exec(code, sandboxExecOptions(Math.ceil(timeout / 1000)));
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
                const maxWaitMs = Math.max(15_000, Math.min(Number(args.timeout_ms || 60_000), 300_000));
                const pollIntervalMs = 5_000;
                const startedAt = Date.now();
                while (Date.now() - startedAt < maxWaitMs) {
                  await new Promise(r => setTimeout(r, pollIntervalMs));
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

    // No matching route
    return Response.json({ error: "Not found", path: url.pathname }, { status: 404 });
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
            const createdAt = p.created_at ? (typeof p.created_at === "string" && p.created_at.includes("T") ? p.created_at : new Date(Number(p.created_at) * 1000).toISOString()) : new Date().toISOString();
            await sql`INSERT INTO sessions (
              session_id, org_id, project_id, agent_name, status,
              input_text, output_text, model, trace_id, parent_session_id,
              depth, step_count, action_count, wall_clock_seconds,
              cost_total_usd, channel,
              detailed_cost_json, feature_flags_json,
              total_cache_read_tokens, total_cache_write_tokens,
              repair_count, compaction_count,
              created_at
            ) VALUES (
              ${p.session_id}, ${p.org_id || ""}, ${p.project_id || ""},
              ${p.agent_name || "agentos"}, ${p.status || "success"},
              ${p.input_text || ""}, ${p.output_text || ""},
              ${p.model || ""}, ${p.trace_id || ""}, ${p.parent_session_id || ""},
              ${p.depth || 0}, ${p.step_count || 0}, ${p.action_count || 0},
              ${p.wall_clock_seconds || 0}, ${p.cost_total_usd || 0},
              ${p.channel || ""},
              ${p.detailed_cost_json || null}, ${p.feature_flags_json || null},
              ${p.total_cache_read_tokens || 0}, ${p.total_cache_write_tokens || 0},
              ${p.repair_count || 0}, ${p.compaction_count || 0},
              ${createdAt}
            ) ON CONFLICT (session_id) DO UPDATE SET
              status = EXCLUDED.status, output_text = EXCLUDED.output_text,
              cost_total_usd = EXCLUDED.cost_total_usd, step_count = EXCLUDED.step_count,
              action_count = EXCLUDED.action_count, wall_clock_seconds = EXCLUDED.wall_clock_seconds,
              detailed_cost_json = EXCLUDED.detailed_cost_json,
              total_cache_read_tokens = EXCLUDED.total_cache_read_tokens,
              total_cache_write_tokens = EXCLUDED.total_cache_write_tokens,
              repair_count = EXCLUDED.repair_count, compaction_count = EXCLUDED.compaction_count`;
          } else if (type === "turn") {
            await sql`INSERT INTO turns (
              session_id, turn_number, model_used, input_tokens, output_tokens,
              latency_ms, llm_latency_ms, llm_content, cost_total_usd,
              tool_calls_json, tool_results_json, errors_json,
              execution_mode, plan_artifact, reflection,
              stop_reason, refusal, cache_read_tokens, cache_write_tokens,
              gateway_log_id
            ) VALUES (
              ${p.session_id}, ${p.turn_number || 0}, ${p.model_used || ""},
              ${p.input_tokens || 0}, ${p.output_tokens || 0},
              ${p.latency_ms || 0}, ${p.llm_latency_ms || p.latency_ms || 0},
              ${p.llm_content || ""}, ${p.cost_total_usd || 0},
              ${p.tool_calls_json || "[]"}, ${p.tool_results_json || "[]"},
              ${p.errors_json || "[]"}, ${p.execution_mode || "sequential"},
              ${p.plan_artifact || p.plan_json || null}, ${p.reflection || p.reflection_json || null},
              ${p.stop_reason || null}, ${p.refusal || false},
              ${p.cache_read_tokens || 0}, ${p.cache_write_tokens || 0},
              ${p.gateway_log_id || null}
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
              ${p.created_at ? (typeof p.created_at === "string" && p.created_at.includes("T") ? p.created_at : new Date(Number(p.created_at) * 1000).toISOString()) : new Date().toISOString()}
            )`;
          } else if (type === "cost_ledger") {
            // Per-session cost breakdown written at session end
            await sql`INSERT INTO cost_ledger (
              session_id, org_id, agent_name, model,
              input_tokens, output_tokens, cost_usd, plan, created_at
            ) VALUES (
              ${p.session_id}, ${p.org_id || ""}, ${p.agent_name || ""},
              ${p.model || ""}, ${p.input_tokens || 0}, ${p.output_tokens || 0},
              ${p.cost_usd || 0}, ${p.plan || ""}, ${p.created_at ? (typeof p.created_at === "string" && p.created_at.includes("T") ? p.created_at : new Date(Number(p.created_at) * 1000).toISOString()) : new Date().toISOString()}
            )`;
          } else if (type === "runtime_event") {
            // Runtime-level events (node executions, graph transitions, errors)
            await sql`INSERT INTO runtime_events (
              trace_id, session_id, org_id, event_type, node_id,
              status, duration_ms, details_json, created_at
            ) VALUES (
              ${p.trace_id || ""}, ${p.session_id || ""}, ${p.org_id || ""},
              ${p.event_type || ""}, ${p.node_id || ""},
              ${p.status || ""}, ${p.duration_ms || 0}, ${JSON.stringify(p.details || {})},
              ${p.created_at ? (typeof p.created_at === "string" && p.created_at.includes("T") ? p.created_at : new Date(Number(p.created_at) * 1000).toISOString()) : new Date().toISOString()}
            )`;
          } else if (type === "middleware_event") {
            // Middleware execution events (loop detection, summarization, etc.)
            await sql`INSERT INTO middleware_events (
              org_id, session_id, middleware_name, event_type,
              details_json, created_at
            ) VALUES (
              ${p.org_id || ""}, ${p.session_id || ""}, ${p.middleware_name || ""},
              ${p.event_type || ""}, ${JSON.stringify(p.details || {})},
              ${p.created_at ? (typeof p.created_at === "string" && p.created_at.includes("T") ? p.created_at : new Date(Number(p.created_at) * 1000).toISOString()) : new Date().toISOString()}
            )`;
          } else if (type === "billing_flush") {
            // DO eviction billing flush — update session cost to prevent undercount
            if (p.session_id && p.cost_usd) {
              await sql`UPDATE sessions SET cost_total_usd = GREATEST(cost_total_usd, ${p.cost_usd}),
                step_count = GREATEST(step_count, ${p.turns || 0})
                WHERE session_id = ${p.session_id}`;
            }
          } else if (type === "skill_activation") {
            // Record skill usage for analytics
            await sql`INSERT INTO audit_log (org_id, actor_id, action, resource_type, resource_name, details, created_at)
              VALUES (${p.org_id || ""}, 'system', 'skill_activation', 'skill', ${p.skill || ""},
                ${JSON.stringify({ session_id: p.session_id, agent_name: p.agent_name })}::jsonb, now())
            `.catch(() => {}); // non-critical
          } else if (type === "loop_detected") {
            // Record loop detection events for diagnostics
            await sql`INSERT INTO audit_log (org_id, actor_id, action, resource_type, resource_name, details, created_at)
              VALUES (${p.org_id || ""}, 'system', 'loop_detected', 'session', ${p.session_id || ""},
                ${JSON.stringify({ tool: p.tool, repeat_count: p.repeat_count, turn: p.turn, agent_name: p.agent_name })}::jsonb, now())
            `.catch(() => {}); // non-critical
          } else if (type === "do_eviction") {
            // DO eviction telemetry — log for capacity planning
            console.log(`[telemetry] DO eviction: session=${p.session_id} org=${p.org_id}`);
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

  // ── Email handler — route inbound emails to the target agent DO ──
  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
    // Determine which agent should handle this email.
    // Convention: emails to agent-name@yourdomain.com route to that agent.
    // e.g., support@agents.oneshots.co → agent "support"
    const toAddress = message.to;
    const agentName = toAddress.split("@")[0].toLowerCase().replace(/[^a-z0-9-]/g, "") || "default";
    const orgId = ""; // Email routing doesn't carry org context — agent resolves from DB

    console.log(`[email] Routing email from ${message.from} to agent "${agentName}"`);

    try {
      // Get or create the agent DO instance
      const agentId = env.AGENTOS_AGENT.idFromName(agentName);
      const agent = env.AGENTOS_AGENT.get(agentId);

      // Forward the email to the agent's onEmail handler
      await (agent as any).onEmail(message);
    } catch (err) {
      console.error(`[email] Failed to route email to agent "${agentName}":`, err);
      // Reply with error
      try {
        const errMime = buildMIMEString({
          from: toAddress,
          to: message.from,
          subject: `Re: ${message.headers.get("subject") || ""}`,
          body: "Sorry, this agent is currently unavailable. Please try again later.",
        });
        await message.reply(new Response(errMime) as any);
      } catch {}
    }
  },
} satisfies ExportedHandler<Env>;
