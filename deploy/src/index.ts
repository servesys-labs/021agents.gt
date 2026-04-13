/**
 * AgentOS — Cloudflare Agents Deployment
 *
 * Aligned with Cloudflare Agents SDK patterns:
 *   - @callable() methods for type-safe RPC
 *   - McpAgent for MCP protocol support
 *   - this.scheduleEvery() for recurring job orchestration
 *   - this.sql`` for persistent state
 *   - this.keepAliveWhile() to prevent mid-operation eviction
 *   - isAutoReplyEmail() for email safety
 *   - routeAgentRequest for URL-based agent dispatch
 */

import {
  Agent,
  AgentNamespace,
  Connection,
  callable,
  routeAgentRequest,
} from "agents";
import { isAutoReplyEmail, createAddressBasedEmailResolver } from "agents/email";
import { getSandbox, Sandbox } from "@cloudflare/sandbox";
// @ts-expect-error — ContainerProxy exists at runtime but may not be in type defs
import { ContainerProxy } from "@cloudflare/containers";
import type { RuntimeEventType } from "./runtime/events";
import {
  loadRuntimeEventsPage, replayOtelEventsAtCursor, buildRuntimeRunTree,
  writeEvalRun, writeEvalTrial, listEvalRuns, getEvalRun, listEvalTrialsByRun,
  createWebSocketSendWithBackpressure,
  type RuntimeEnv,
  type TurnResult,
} from "./runtime";
// streamRun removed — all execution goes through Cloudflare Workflows
import { getCircuitStatus, getToolsBreakerSummary } from "./runtime/tools";
import { parseJsonColumn } from "./runtime/parse-json-column";
import { isEnabled } from "./runtime/features";
import {
  buildSignalCoordinatorKey,
  deriveSignalEnvelopes,
  getQueuePayload,
  signalEnvelopeMessage,
  type SignalEnvelope,
} from "./runtime/signals";

// ── Input size limit ──
// Reject user messages exceeding 50 KB to avoid wasting LLM tokens.
const MAX_INPUT_BYTES = 50_000;

// ── Sandbox timeout helper ──
// Prevents bare getSandbox().exec() calls from hanging indefinitely when all
// container capacity is exhausted. Wraps every operation with a 30s deadline.
const SANDBOX_ACQUIRE_TIMEOUT_MS = 30_000;

// ── /cf/sandbox/exec warm pool leasing ──
// Avoid random sandbox IDs per request, which causes frequent cold starts.
// We keep a small deterministic lane pool and lease lanes briefly to spread load.
const _cfExecLaneLeases = new Map<string, number>(); // lane -> lease expiry (ms)

function _hashString(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0);
}

function _intFromEnv(raw: unknown, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  const v = Math.floor(n);
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

function _cfExecPoolSize(env: Env): number {
  return _intFromEnv((env as any).CF_EXEC_POOL_SIZE, 16, 2, 128);
}

function _cfExecLeaseMs(env: Env): number {
  return _intFromEnv((env as any).CF_EXEC_LEASE_MS, 20_000, 2_000, 120_000);
}

function _cfExecWaitMs(env: Env): number {
  return _intFromEnv((env as any).CF_EXEC_WAIT_MS, 5_000, 500, 30_000);
}

async function _acquireCfExecLane(
  env: Env,
  affinityKey: string,
): Promise<{ lane: string; sandboxId: string }> {
  const poolSize = _cfExecPoolSize(env);
  const leaseMs = _cfExecLeaseMs(env);
  const waitMs = _cfExecWaitMs(env);
  const seed = _hashString(affinityKey) % poolSize;
  const start = Date.now();

  while (true) {
    const now = Date.now();

    // Deterministic probe order keeps request affinity while still allowing spillover.
    for (let offset = 0; offset < poolSize; offset++) {
      const idx = (seed + offset) % poolSize;
      const lane = `lane-${idx}`;
      const until = _cfExecLaneLeases.get(lane) || 0;
      if (until <= now) {
        _cfExecLaneLeases.set(lane, now + leaseMs);
        return { lane, sandboxId: `cf-exec-${lane}` };
      }
    }

    if (now - start > waitMs) {
      // If all lanes are busy beyond wait budget, force-take earliest expiring lane.
      let bestLane = "lane-0";
      let bestUntil = Number.POSITIVE_INFINITY;
      for (let i = 0; i < poolSize; i++) {
        const lane = `lane-${i}`;
        const until = _cfExecLaneLeases.get(lane) || 0;
        if (until < bestUntil) {
          bestUntil = until;
          bestLane = lane;
        }
      }
      _cfExecLaneLeases.set(bestLane, now + leaseMs);
      return { lane: bestLane, sandboxId: `cf-exec-${bestLane}` };
    }

    await new Promise((r) => setTimeout(r, 50 + Math.random() * 50));
  }
}

function _releaseCfExecLane(lane: string): void {
  const now = Date.now();
  const until = _cfExecLaneLeases.get(lane) || 0;
  if (until > now) _cfExecLaneLeases.set(lane, now);
}

function getTimedSandbox(namespace: any, sandboxId: string, opts?: any) {
  const raw = getSandbox(namespace, sandboxId, opts);
  const wrap = <T>(p: Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(
          `Sandbox unavailable — no container could be allocated within 30 seconds. ` +
          `This usually means all sandbox capacity is in use. Please try again in a moment. ` +
          `(sandbox: ${sandboxId})`
        ));
      }, SANDBOX_ACQUIRE_TIMEOUT_MS);
      p.then(
        (v) => { clearTimeout(timer); resolve(v); },
        (e) => { clearTimeout(timer); reject(e); },
      );
    });
  // CRITICAL: @cloudflare/sandbox 0.7+ takes `timeout` in MILLISECONDS.
  // Callers in this file pass seconds (the original convention), so we
  // convert at this single choke point. Heuristic: any value <= 600 is
  // treated as seconds (10 min cap is well above any reasonable
  // per-command limit; real ms values would be much larger).
  function normalizeOpts(o?: any): any {
    if (!o || typeof o.timeout !== "number") return o;
    if (o.timeout > 600) return o; // already in ms
    return { ...o, timeout: o.timeout * 1000 };
  }
  return {
    exec: (cmd: string, execOpts?: any) => wrap(raw.exec(cmd, normalizeOpts(execOpts))),
    writeFile: (path: string, content: string) => wrap(raw.writeFile(path, content)),
    readFile: (path: string) =>
      wrap((raw as any).readFile?.(path) ?? raw.exec(`cat "${path}"`, { timeout: 10_000 }).then((r: any) => r.stdout || "")),
  };
}

// ── AgentSandbox — Sandbox with lifecycle hooks + controlled outbound ──
// Sandbox extends Container extends DurableObject.
// Per CF Containers docs: https://developers.cloudflare.com/containers/
//
// Lifecycle hooks give us visibility into OOM kills, crashes, and graceful shutdowns.
// outboundByHost lets sandbox code access platform resources (R2, KV) via HTTP.
// Internet is ENABLED because agents need npm install, pip install, git clone, curl, etc.
// Security: each container runs in its own VM (CF isolation), SSRF blocked by parent Worker.
// ── Sandbox org registry — maps DO ID → org_id for outbound scoping ──
// Populated by AgentSandbox.registerOrg() at sandbox creation time and
// by onStart() reading from DO persistent storage.  Used by outbound
// handlers to enforce org-level isolation on R2/KV access.
const _sandboxOrgRegistry = new Map<string, string>();

export class AgentSandbox extends Sandbox<Env> {

  /** Persist org_id for this sandbox so outbound handlers can scope access. */
  static async registerOrg(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sandboxNamespace: any,
    sandboxId: string,
    orgId: string,
  ): Promise<void> {
    // Derive the stable DO hex ID from the sandbox name and register both.
    const doIdObj = sandboxNamespace.idFromName(sandboxId);
    const doIdStr = doIdObj.toString();
    _sandboxOrgRegistry.set(doIdStr, orgId);
    _sandboxOrgRegistry.set(sandboxId, orgId); // also index by name for convenience
    // Persist to DO storage so onStart() can recover after eviction.
    try {
      const stub = sandboxNamespace.get(doIdObj);
      await stub.fetch("http://internal/__set_org", {
        method: "POST",
        body: orgId,
      });
    } catch {
      // Best-effort — the in-memory registry is the primary path.
    }
  }

  async onStart() {
    console.log(`[sandbox] Started: ${this.ctx.id.toString().slice(0, 16)}`);
    // Recover org_id from persistent storage into the in-memory registry.
    const stored = await this.ctx.storage.get<string>("__org_id");
    if (stored) {
      _sandboxOrgRegistry.set(this.ctx.id.toString(), stored);
    }
  }

  async fetch(request: Request): Promise<Response> {
    // Handle internal org registration RPC from registerOrg().
    const url = new URL(request.url);
    if (url.pathname === "/__set_org" && request.method === "POST") {
      const orgId = await request.text();
      if (orgId) {
        await this.ctx.storage.put("__org_id", orgId);
        _sandboxOrgRegistry.set(this.ctx.id.toString(), orgId);
      }
      return new Response("OK");
    }
    return super.fetch(request);
  }

  async onStop() {
    console.log(`[sandbox] Stopped: ${this.ctx.id.toString().slice(0, 16)}`);
    _sandboxOrgRegistry.delete(this.ctx.id.toString());
  }

  onError(error: unknown) {
    console.error("[sandbox] Container error:", error);
    // Emit to telemetry queue if available for alerting
    if (this.env.TELEMETRY_QUEUE) {
      this.env.TELEMETRY_QUEUE.send({
        type: "event",
        payload: {
          event_type: "sandbox.error" satisfies RuntimeEventType,
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

// ── Org-scoped outbound helpers ──

/** Resolve the org_id for an outbound request. Checks the in-memory registry
 *  using the CF-injected container header, then falls back to a unique match. */
function _resolveOrgForOutbound(request: Request): string | undefined {
  // Primary: CF runtime may inject the DO id as a header.
  const doId = request.headers.get("cf-container-id")
    || request.headers.get("cf-do-id");
  if (doId) return _sandboxOrgRegistry.get(doId);

  // Fallback: if exactly one sandbox is registered, use it.
  // This is safe because each isolate typically hosts one active container.
  if (_sandboxOrgRegistry.size === 1) {
    return _sandboxOrgRegistry.values().next().value as string;
  }

  return undefined; // ambiguous or none — fail closed
}

/** Validate that an R2/KV key belongs to the given org's namespace. */
function _assertOrgOwnsKey(orgId: string, key: string): Response | null {
  // R2 keys follow: workspaces/{orgId}/...
  // Reject path traversal and keys outside the org's prefix.
  const normalized = key.replace(/\.\.\//g, "");
  const expectedPrefix = `workspaces/${orgId}/`;
  if (!normalized.startsWith(expectedPrefix)) {
    return new Response(
      `Forbidden — sandbox may only access keys under ${expectedPrefix}`,
      { status: 403 },
    );
  }
  return null; // OK
}

// Static outbound handlers — give sandbox code controlled access to platform resources.
// Sandbox code can call http://platform.r2/path or http://platform.kv/key
// and the request is handled by the Worker (with full binding access), not sent to the internet.
//
// SECURITY: Every handler resolves the calling sandbox's org_id and validates
// that the requested key falls within that org's namespace.  If the org cannot
// be determined, access is denied (fail-closed).
(AgentSandbox as any).outboundByHost = {
  // R2 storage access: sandbox code can read/write files via http://platform.r2/{path}
  "platform.r2": async (request: Request, env: Env) => {
    if (!env.STORAGE) return new Response("R2 not configured", { status: 503 });
    const url = new URL(request.url);
    const key = url.pathname.slice(1); // strip leading /
    if (!key) return new Response("Key required", { status: 400 });

    // ── Org scoping: resolve caller's org and validate key ──
    const orgId = _resolveOrgForOutbound(request);
    if (!orgId) {
      return new Response("Forbidden — sandbox org_id could not be determined", { status: 403 });
    }
    const denied = _assertOrgOwnsKey(orgId, key);
    if (denied) return denied;

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

    // ── Org scoping: resolve caller's org and validate key ──
    const orgId = _resolveOrgForOutbound(request);
    if (!orgId) {
      return new Response("Forbidden — sandbox org_id could not be determined", { status: 403 });
    }
    const denied = _assertOrgOwnsKey(orgId, key);
    if (denied) return denied;

    if (request.method === "GET") {
      const value = await env.AGENT_PROGRESS_KV.get(key);
      if (value === null) return new Response("Not found", { status: 404 });
      return new Response(value);
    }
    return new Response("Method not allowed — KV is read-only from sandbox", { status: 405 });
  },
};

// Re-export Workflow and DOs so Cloudflare can discover them
export { AgentRunWorkflow } from "./workflow";
export { SessionCounterDO } from "./runtime/session-counter-do";
export { SignalCoordinatorDO } from "./runtime/signal-coordinator-do";
import type { RunOutput } from "./workflow";

// ---------------------------------------------------------------------------
// Environment bindings
// ---------------------------------------------------------------------------

export interface Env extends Cloudflare.Env {
  AUTH_JWT_SECRET?: string;      // End-user JWT auth (portal, API clients)
  SERVICE_TOKEN?: string;        // Service-to-service auth (dispatch workers → main worker)
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_API_TOKEN?: string;
  AI_GATEWAY_ID?: string;        // CF AI Gateway slug (e.g. "one-shots")
  AI_GATEWAY_TOKEN?: string;     // Dedicated gateway token (least-privilege)
  GPU_SERVICE_KEY?: string;      // Auth key for GPU box auth proxy
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
  // AGENT_RUN_WORKFLOW — provided by Cloudflare.Env from wrangler.jsonc workflows binding
  // AGENT_PROGRESS_KV — provided by Cloudflare.Env from wrangler.jsonc KV binding
  SIGNAL_QUEUE?: Queue;
  SIGNAL_COORDINATOR?: DurableObjectNamespace<any>;
  SIGNAL_ANALYTICS?: AnalyticsEngineDataset;
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
  /** Mirrors config.harness.enable_checkpoints — false disables DO workspace checkpoint chain. */
  enableWorkspaceCheckpoints?: boolean;
}


function normalizePlan(value?: string, fallback: string = "free"): string {
  const raw = (value || "").trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === "balanced") return "standard";
  if (raw === "manual") return "manual";
  return ["free", "basic", "standard", "premium", "code", "dedicated", "private"].includes(raw) ? raw : fallback;
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
  // Enable hibernation so idle DOs are evicted from memory (cost savings at scale).
  // Per-connection state (__authenticated, __orgId, etc.) is stored via connection.setState()
  // which the SDK persists across hibernation. Voice relay WS state uses serializeAttachment().
  // In-memory _activeRun/_activeWorkflow are rebuilt from SQLite active_workflows on wake.
  static options = { hibernate: true };

  // Concurrency guard: prevent overlapping runs from corrupting conversation state.
  // DOs are single-threaded but async yields allow interleaving.
  // These in-memory caches are rebuilt from SQLite active_workflows on hibernation wake.
  private _activeRun: boolean = false;
  private _activeWorkflow: { instance: any; progressKey: string; abortPoll: boolean } | null = null;

  // ── Hibernation-safe connection state helpers ──────────────────────
  // The Agents SDK persists connection.state across hibernation via
  // serializeAttachment/deserializeAttachment. These helpers provide a
  // typed interface over the opaque state object.
  private _getConnState(connection: Connection): { authenticated?: boolean; orgId?: string; userId?: string; voiceMode?: boolean; voiceCallSid?: string; voiceProcessing?: boolean } {
    return (connection.state as any) || {};
  }
  private _setConnState(connection: Connection, patch: Record<string, unknown>) {
    const current = this._getConnState(connection);
    connection.setState({ ...current, ...patch });
  }

  initialState: AgentState = {
    config: {
      plan: "free",
      provider: "custom-gemma4-fast",
      model: "gemma-4-26b-moe",
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

    if (schemaVersion < 5) {
      // v5: Track active Workflow instances so DO can resume polling after restart/deploy
      this.ctx.storage.transactionSync(() => {
        this.sql`CREATE TABLE IF NOT EXISTS active_workflows (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          workflow_instance_id TEXT NOT NULL,
          progress_key TEXT NOT NULL,
          channel TEXT NOT NULL DEFAULT 'websocket',
          created_at REAL NOT NULL DEFAULT (unixepoch('now'))
        )`;
        this.sql`INSERT INTO _sql_schema_migrations (id) VALUES (5)`;
      });
    }

    if (schemaVersion < 6) {
      // v6: Add correlation_id to mailbox for approval protocol (harness hardening Phase 1)
      // Note: createMailboxTable() (v4) now includes correlation_id in CREATE TABLE,
      // so new DOs already have the column. ALTER is only needed for DOs that ran
      // v4 with the old schema. We check column existence to make this idempotent.
      this.ctx.storage.transactionSync(() => {
        const cols = this.sql`PRAGMA table_info(mailbox)`;
        const hasCorrelationId = (cols as any[]).some((c: any) => c.name === "correlation_id");
        if (!hasCorrelationId) {
          this.sql`ALTER TABLE mailbox ADD COLUMN correlation_id TEXT`;
        }
        this.sql`CREATE INDEX IF NOT EXISTS idx_mailbox_correlation ON mailbox(to_session, correlation_id, read_at)`;
        this.sql`INSERT INTO _sql_schema_migrations (id) VALUES (6)`;
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
      } catch (err) {
        console.warn(`[DO:onStart] preloadCircuitStates failed: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Hydrate from Supabase if DO SQLite is empty (cold start / post-deploy)
    // MUST have a timeout — if Hyperdrive hangs, blockConcurrencyWhile blocks ALL messages
    const localCount = this.sql<{ cnt: number }>`SELECT COUNT(*) as cnt FROM conversation_messages`;
    if ((localCount[0]?.cnt || 0) === 0 && this.env.HYPERDRIVE) {
      try {
        const { loadConversationHistory } = await import("./runtime/db");
        const messages = await Promise.race([
          loadConversationHistory(this.env.HYPERDRIVE, this.name, 24),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("hydration timeout")), 5000)),
        ]);
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
      const { loadCheckpointFromSQLite, loadFilesFromSQLite, saveFileToSQLite, ensureWorkspaceTables } = await import("./runtime/workspace-persistence");
      ensureWorkspaceTables(this.sql);

      // Restore workspace files from SQLite
      const files = loadFilesFromSQLite(this.sql, this.name);
      if (files.length > 0) {
        console.log(`[workspace] Restored ${files.length} files from SQLite checkpoint`);
      }

      // R2 fallback: if SQLite has no files (DO was fully evicted), try R2
      if (files.length === 0 && this.env.STORAGE) {
        try {
          const { loadCheckpointFromR2 } = await import("./runtime/workspace-persistence");
          const r2Checkpoint = await Promise.race([
            loadCheckpointFromR2(this.env.STORAGE, this.state.config.orgId || "default", this.state.config.agentName || "agent", this.name),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
          ]);
          if (r2Checkpoint?.files?.length) {
            console.log(`[workspace] Restored ${r2Checkpoint.files.length} files from R2 fallback`);
            for (const f of r2Checkpoint.files) {
              saveFileToSQLite(this.sql, this.name, f);
            }
          }
        } catch {}
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
    } catch (err) {
      console.warn(`[DO:onStart] workspace recovery failed: ${err instanceof Error ? err.message : err}`);
    }

    // ── Initiate recurring checkpoint schedule ──────────────────────
    // SDK scheduleEvery() creates a recurring schedule that survives hibernation.
    // Replaces the self-rescheduling chain (this.schedule → callback → this.schedule)
    // which was fragile: if the callback threw, the chain broke silently.
    if (this.state.config.enableWorkspaceCheckpoints !== false) {
      try {
        await this.scheduleEvery(30, "checkpointWorkspace");
      } catch {}
    }

    // ── Workflow Recovery: resume polling orphaned workflows after DO restart ──
    // When a DO restarts (deploy, crash, hibernation wake), in-flight Workflow
    // instances keep running but the DO loses its in-memory polling loop.
    // Check SQLite for any active workflow records and poll them to completion
    // so results are captured (conversation history, billing) even if the
    // original WebSocket client has disconnected.
    if (this.env.AGENT_RUN_WORKFLOW && this.env.AGENT_PROGRESS_KV) {
      try {
        const orphaned = this.sql<{ id: number; workflow_instance_id: string; progress_key: string; channel: string }>`
          SELECT id, workflow_instance_id, progress_key, channel FROM active_workflows
        `;
        if (orphaned.length > 0) {
          // Rebuild in-memory concurrency guard from persisted state
          this._activeRun = true;
        }
        for (const row of orphaned) {
          // Fire-and-forget: recover each workflow without blocking onStart
          this._recoverOrphanedWorkflow(row.id, row.workflow_instance_id, row.progress_key, row.channel).catch(() => {});
        }
      } catch {}
    }
  }

  // ── Hibernation Checkpoint (periodic save) ───────────────────────

  /**
   * Scheduled callback: save workspace + state to DO SQLite every 30 seconds.
   * If the DO hibernates between checkpoints, SQLite retains the last one.
   * Called every 30s via `this.scheduleEvery(30, "checkpointWorkspace")` from onStart().
   */
  async checkpointWorkspace() {
    if (this.state.config.enableWorkspaceCheckpoints === false) {
      return;
    }
    try {
      const { saveCheckpointToSQLite, saveCheckpointToR2, saveFileToSQLite, hashContent, loadFilesFromSQLite } = await import("./runtime/workspace-persistence");
      const config = this.state.config;

      // P2-17: Scan sandbox for files not yet tracked in SQLite (e.g. bash-created).
      // This ensures `rm`, `echo >`, `mv`, python scripts, etc. are captured.
      if (this.env.SANDBOX) {
        try {
          const sandbox = getTimedSandbox(this.env.SANDBOX, this.name);
          // List all files in /workspace (limit to 500 to avoid huge scans)
          const lsResult = await sandbox.exec(
            `find /workspace -type f -not -path '*/node_modules/*' -not -path '*/.git/*' -not -name '*.pyc' 2>/dev/null | head -500`,
            { timeout: 10 },
          );
          const sandboxPaths = new Set(
            (lsResult.stdout || "").split("\n").map((p: string) => p.trim()).filter(Boolean),
          );

          // Get already-tracked paths from SQLite
          const trackedFiles = loadFilesFromSQLite(this.sql, this.name);
          const trackedPaths = new Set(trackedFiles.map((f: any) => f.path));

          // Persist any untracked files (bash-created, python-created, etc.)
          for (const filePath of sandboxPaths) {
            if (trackedPaths.has(filePath)) continue;
            try {
              const catResult = await sandbox.exec(`cat "${filePath}"`, { timeout: 5 });
              const content = catResult.stdout ?? "";
              // Skip very large files (>512KB) to avoid blowing up SQLite
              if (content.length > 512_000) continue;
              const hash = await hashContent(content);
              saveFileToSQLite(this.sql, this.name, {
                path: filePath,
                content,
                encoding: "utf-8",
                size: content.length,
                hash,
                modified_at: new Date().toISOString(),
              });
            } catch {}
          }
        } catch (scanErr: any) {
          console.error(`[checkpoint] sandbox scan failed: ${scanErr.message?.slice(0, 200)}`);
        }
      }

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
    } catch (err) {
      console.warn(`[DO:alarm] checkpoint failed: ${err instanceof Error ? err.message : err}`);
    }

    // No manual re-scheduling needed — scheduleEvery() in onStart() handles recurrence.
  }

  /** Load harness.enable_checkpoints from Supabase and update DO state. Cached 5 minutes. */
  private _checkpointFlagCachedAt = 0;
  private async _syncCheckpointFlagFromDb(agentDbName: string, orgId?: string): Promise<void> {
    if (Date.now() - this._checkpointFlagCachedAt < 300_000) return; // 5-min TTL
    if (!this.env.HYPERDRIVE || !String(agentDbName || "").trim()) return;
    try {
      const { loadAgentConfig } = await import("./runtime/db");
      const cfg = await loadAgentConfig(this.env.HYPERDRIVE, agentDbName.trim(), {
        provider: this.env.DEFAULT_PROVIDER || "openrouter",
        model: this.env.DEFAULT_MODEL || "openai/gpt-5.4-mini",
        plan: this.env.DEFAULT_PLAN || "free",
      }, orgId || this.state.config.orgId || undefined);
      const on = cfg.enable_workspace_checkpoints !== false;
      this.setState({
        ...this.state,
        config: { ...this.state.config, enableWorkspaceCheckpoints: on },
      });
      this._checkpointFlagCachedAt = Date.now();
    } catch {
      /* keep existing flag */
    }
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

    // Set RLS org context for all DB calls during this agent run
    if (config.orgId) {
      const { setDbOrgContext } = await import("./runtime/db");
      setDbOrgContext(config.orgId);
    }

    await this._syncCheckpointFlagFromDb(config.agentName || "agentos");
    const started = Date.now();

    // ── Workflow path (primary) ──
    if (this.env.AGENT_RUN_WORKFLOW) {
      // SDK keepAliveWhile(): prevent eviction during RPC-initiated workflow poll
      const keepAlivePromise = this.keepAliveWhile(async () => {
        await new Promise(r => setTimeout(r, 300_000)); // max 5 min
      }).catch(() => {});
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
          do_session_id: this.name,
          parent_session_id: opts?.delegation?.parent_session_id,
          parent_depth: opts?.delegation?.parent_depth,
          ...(config.systemPrompt && config.systemPrompt.length > 100 && !config.systemPrompt.startsWith("You are a helpful AI assistant") ? {
            preloaded_config: {
              system_prompt: config.systemPrompt,
              model: config.model,
              provider: config.provider || this.env.DEFAULT_PROVIDER || "openrouter",
              plan: config.plan,
              tools: config.tools,
              blocked_tools: config.blockedTools || [],
              max_turns: config.maxTurns || 50,
              budget_limit_usd: config.budgetLimitUsd || 10,
              parallel_tool_calls: true,
              enable_workspace_checkpoints: config.enableWorkspaceCheckpoints !== false,
            },
          } : {}),
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
            event_type: "config.update" satisfies RuntimeEventType,
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

    // ── Deliver missed run result on reconnect ──────────────────────
    // If the user closed their tab while a run was completing, the done
    // event was stored in KV. Send it now so the client can display it.
    if (this.env.AGENT_PROGRESS_KV) {
      try {
        const lastResultKey = `last-result:${this.name}`;
        const raw = await this.env.AGENT_PROGRESS_KV.get(lastResultKey);
        if (raw) {
          const missedResult = JSON.parse(raw);
          connection.send(JSON.stringify({ ...missedResult, recovered: true }));
          // One-time delivery — delete after sending
          await this.env.AGENT_PROGRESS_KV.delete(lastResultKey);
        }
      } catch {}
    }
  }

  async onMessage(connection: Connection, message: string | ArrayBuffer) {
    let data: any;
    try {
      data = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));
    } catch {
      connection.send(JSON.stringify({ type: "error", error: "invalid_json", message: "Message must be valid JSON" }));
      return;
    }
    if (!data || typeof data !== "object") {
      connection.send(JSON.stringify({ type: "error", error: "invalid_message", message: "Message must be a JSON object" }));
      return;
    }

    // ── WebSocket reconnect: replay missed events from KV ──────────
    if (data.type === "reconnect" && typeof data.from_seq === "number") {
      const kv = this.env.AGENT_PROGRESS_KV;
      const ALLOWED_PREFIXES = ["ws:", "rpc:", "voice:", "batch:"];
      const keyStr = typeof data.progress_key === "string" ? data.progress_key : "";
      const prefixOk = ALLOWED_PREFIXES.some((p) => keyStr.startsWith(p));
      const ownerOk = keyStr.includes(this.name);
      if (kv && keyStr && prefixOk && ownerOk) {
        const raw = await kv.get(keyStr);
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
      // Validate JWT locally using shared AUTH_JWT_SECRET
      const jwtSecret = String(this.env.AUTH_JWT_SECRET || "").trim();
      if (jwtSecret) {
        const valid = await verifyHs256Jwt(token, jwtSecret);
        if (valid) {
          // Decode payload to extract org_id/user_id
          try {
            const payload = JSON.parse(atob(token.split(".")[1]));
            this._setConnState(connection, { authenticated: true, orgId: payload.org_id || "", userId: payload.sub || "" });
            connection.send(JSON.stringify({ type: "auth_ok", org_id: payload.org_id }));
          } catch {
            this._setConnState(connection, { authenticated: true });
            connection.send(JSON.stringify({ type: "auth_ok" }));
          }
        } else {
          connection.send(JSON.stringify({ type: "error", message: "auth: invalid token", code: "AUTH_FAILED" }));
          connection.close(4001, "Unauthorized");
        }
      } else {
        // No JWT secret configured — reject all connections.
        // In development, set AUTH_JWT_SECRET to any value to enable auth.
        console.error("[auth] AUTH_JWT_SECRET is not configured — rejecting connection");
        connection.send(JSON.stringify({ type: "error", message: "auth: server misconfigured (no signing secret)", code: "AUTH_MISCONFIGURED" }));
        connection.close(4001, "Unauthorized");
      }
      return;
    }

    // ── Auth gate: reject commands from unauthenticated connections ──
    if (data.type === "run" && !this._getConnState(connection).authenticated) {
      connection.send(JSON.stringify({ type: "error", message: "Send { type: 'auth', token: '...' } before running commands", code: "AUTH_REQUIRED" }));
      return;
    }

    // ── Twilio ConversationRelay voice handling ──────────────────────
    console.log("[onMessage] Received type:", data.type, "keys:", Object.keys(data).join(","));

    if (data.type === "setup" && data.callSid) {
      // ConversationRelay connected — store call metadata (hibernation-safe)
      this._setConnState(connection, { voiceMode: true, voiceCallSid: data.callSid || "" });
      return;
    }

    if (data.type === "prompt" && this._getConnState(connection).voiceMode) {
      const userText = (data.voicePrompt || "").trim();
      if (!userText) return;

      try {
        const config = this.state.config;
        const runtimeEnv: RuntimeEnv = {
          AI: this.env.AI, HYPERDRIVE: this.env.HYPERDRIVE, HYPERDRIVE_ADMIN: this.env.HYPERDRIVE_ADMIN, VECTORIZE: this.env.VECTORIZE,
          STORAGE: this.env.STORAGE, SANDBOX: this.env.SANDBOX, LOADER: this.env.LOADER,
          TELEMETRY_QUEUE: this.env.TELEMETRY_QUEUE, BROWSER: this.env.BROWSER,
          AI_GATEWAY_ID: this.env.AI_GATEWAY_ID, AI_GATEWAY_TOKEN: this.env.AI_GATEWAY_TOKEN,
          CLOUDFLARE_ACCOUNT_ID: this.env.CLOUDFLARE_ACCOUNT_ID,
          CLOUDFLARE_API_TOKEN: this.env.CLOUDFLARE_API_TOKEN,
          DEFAULT_PROVIDER: this.env.DEFAULT_PROVIDER || config.provider || "custom-gemma4-fast",
          DEFAULT_MODEL: this.env.DEFAULT_MODEL || config.model || "gemma-4-26b-moe",
          DO_SQL: this.sql.bind(this), DO_SESSION_ID: this.name,
        };

        let response = "I didn't catch that.";
        if (this.env.AGENT_RUN_WORKFLOW) {
          const history = this._loadConversationHistory(12);
          const inst = await this.env.AGENT_RUN_WORKFLOW.create({
            params: {
              agent_name: config.agentName || "agentos", input: userText,
              org_id: config.orgId || "", project_id: config.projectId || "",
              channel: "voice", channel_user_id: "",
              history: history.map((m: any) => ({ role: m.role, content: m.content })),
              progress_key: `voice:${this.name}:${Date.now()}`,
              do_session_id: this.name,
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

    if (data.type === "interrupt" && this._getConnState(connection).voiceMode) {
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
            INSERT INTO session_feedback (id, session_id, turn_number, rating, comment, message_preview, user_id, org_id, agent_name, channel, created_at)
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
      // Concurrency guard: only one run at a time per session
      if (this._activeRun) {
        connection.send(JSON.stringify({ type: "error", message: "A run is already in progress. Please wait for it to complete.", code: "RUN_IN_PROGRESS" }));
        return;
      }

      // Input size guard
      const rawInput = String(data.input || "");
      if (new TextEncoder().encode(rawInput).byteLength > MAX_INPUT_BYTES) {
        connection.send(JSON.stringify({ type: "error", message: "Message too large. Please keep your message under 50 KB.", code: "INPUT_TOO_LARGE" }));
        return;
      }

      this._activeRun = true;

      // SDK keepAliveWhile(): prevent DO eviction during the entire run.
      // Without this, a long-running workflow poll can be interrupted by
      // hibernation, requiring the complex orphaned-workflow recovery path.
      this.keepAliveWhile(async () => {
        // Wait for _activeRun to flip false (set in onClose, run completion, or error)
        while (this._activeRun) {
          await new Promise(r => setTimeout(r, 5000));
        }
      }).catch(() => {}); // non-blocking — just prevents eviction

      const config = this.state.config;
      const inputText = rawInput;
      const wsAgentName = data.agent_name || config.agentName || "agentos";

      // Pre-run credit check — reject early if org has no credits
      const wsOrgId = data.org_id || config.orgId || "";
      if (wsOrgId && this.env.HYPERDRIVE) {
        try {
          const { getDb } = await import("./runtime/db");
          const sql = await getDb(this.env.HYPERDRIVE);
          const [bal] = await sql`SELECT balance_usd FROM org_credit_balance WHERE org_id = ${wsOrgId}`;
          if (!bal || Number(bal.balance_usd) <= 0) {
            connection.send(JSON.stringify({
              type: "error",
              message: "Insufficient credits. Purchase credits at https://app.021agents.ai/settings?tab=billing",
              code: "insufficient_credits",
            }));
            this._activeRun = false;
            return;
          }
        } catch (err) {
          console.error("[ws-run] Credit check failed, denying run:", err);
          try {
            connection.send(JSON.stringify({
              type: "error",
              message: "Unable to verify credits. Please try again shortly.",
              code: "credit_check_failed",
            }));
          } catch { /* socket may be closed */ }
          this._activeRun = false;
          return;
        }
      }

      await this._syncCheckpointFlagFromDb(wsAgentName, wsOrgId || undefined);

      // Persist user message IMMEDIATELY (before workflow starts)
      // so it survives even if the DO crashes mid-run
      this._appendConversationMessage("user", inputText, data.channel || "websocket");

      // Use DO SQLite history (primary) — falls back to client-sent history
      // when SQLite is empty (after crash/redeploy before hydration completes)
      let history = this._loadConversationHistory(24);
      if (history.length === 0 && Array.isArray(data.history) && data.history.length > 0) {
        history = data.history
          .filter((m: any) => m.role === "user" || m.role === "assistant")
          .map((m: any) => ({ role: m.role, content: String(m.content || "") }))
          .slice(-24);
        // Backfill SQLite from client history so subsequent turns have context
        for (const msg of history) {
          this.sql`INSERT INTO conversation_messages (role, content, channel, created_at)
            VALUES (${msg.role}, ${msg.content.slice(0, 8000)}, 'websocket', ${new Date().toISOString()})`;
        }
      }

      let progressKey: string | null = null;
      try {
        if (!this.env.AGENT_RUN_WORKFLOW || !this.env.AGENT_PROGRESS_KV) {
          throw new Error("Workflow bindings not configured");
        }

        // ── Latency fix 2: Pre-warm sandbox container (non-blocking, in parallel with Workflow creation) ──
        // The same sandbox ID will be used by tools in the Workflow. Firing a no-op
        // triggers the container to boot so it's warm by the time the first tool runs.
        if (this.env.SANDBOX) {
          try {
            // Warm-up no-op — uses ms (5000) since this bypasses the
            // getTimedSandbox proxy that does the seconds→ms conversion.
            const sandbox = getSandbox(this.env.SANDBOX, this.name, { sleepAfter: "30m" } as any);
            sandbox.exec("true", { timeout: 5000 }).catch(() => {});
          } catch { /* non-blocking — ignore errors */ }
        }

        // UI plan selection overrides DB config (user picked basic/standard/premium in the UI)
        const effectivePlan = data.plan || config.plan;

        progressKey = `ws:${this.name}:${Date.now()}`;
        const instance = await this.env.AGENT_RUN_WORKFLOW.create({
          params: {
            agent_name: wsAgentName, input: inputText,
            org_id: data.org_id || config.orgId || "",
            project_id: data.project_id || config.projectId || "",
            channel: data.channel || "websocket",
            channel_user_id: data.channel_user_id || "",
            history: history.map((m: any) => ({ role: m.role, content: m.content })),
            progress_key: progressKey,
            do_session_id: this.name,
            // UI plan override — user can switch plans per-message
            ...(data.plan ? { plan_override: data.plan } : {}),
            // ── Latency fix 1: Pass pre-loaded config to skip bootstrap DB query (saves 200-800ms) ──
            // Only send if DO has loaded config from DB (non-default system prompt).
            // Fresh DOs have the generic default — let bootstrap load from DB instead.
            ...(config.systemPrompt && config.systemPrompt.length > 100 && !config.systemPrompt.startsWith("You are a helpful AI assistant") ? {
              preloaded_config: {
                system_prompt: config.systemPrompt,
                model: config.model,
                provider: config.provider || this.env.DEFAULT_PROVIDER || "openrouter",
                plan: effectivePlan,
                tools: config.tools,
                blocked_tools: config.blockedTools || [],
                max_turns: config.maxTurns || 50,
                budget_limit_usd: config.budgetLimitUsd || 10,
                parallel_tool_calls: true,
                enable_workspace_checkpoints: config.enableWorkspaceCheckpoints !== false,
              },
            } : {}),
          },
        });

        // Track active workflow for disconnect cleanup (GAP 6)
        this._activeWorkflow = { instance, progressKey, abortPoll: false };

        // Persist to SQLite so we can resume polling after DO restart/deploy
        this._trackWorkflow(instance.id, progressKey, data.channel || "websocket");

        // Poll KV for progress events → push to WebSocket client in real-time
        let lastIdx = 0;
        let done = false;
        let doneSent = false; // Guard against sending duplicate done events
        const maxWait = 300_000;
        const pollStart = Date.now();
        let pollCount = 0;
        let kvConsecutiveFailures = 0;
        let kvDegradedNotified = false;

        while (!done && Date.now() - pollStart < maxWait && connection.readyState === 1 && !this._activeWorkflow?.abortPoll) {
          // Fast poll for first 30s (250ms), then slow down (1s)
          const pollInterval = Date.now() - pollStart < 30_000 ? 250 : 1000;
          await new Promise(r => setTimeout(r, pollInterval));
          pollCount++;

          try {
            const raw = await this.env.AGENT_PROGRESS_KV.get(progressKey);
            kvConsecutiveFailures = 0; // reset on successful read
            if (raw) {
              const events = JSON.parse(raw) as any[];
              for (let i = lastIdx; i < events.length; i++) {
                // Skip KV done if we already synthesized one from Workflow status
                if (events[i].type === "done" && doneSent) { done = true; break; }
                try { connection.send(JSON.stringify(events[i])); } catch { done = true; break; }
                if (events[i].type === "done") {
                  done = true;
                  doneSent = true;
                  // User message already saved before workflow started
                  this._appendConversationMessage("assistant", events[i].output || "", data.channel || "websocket");
                  this._storeLastResult(events[i]);
                  // Billing
                  if (this.env.HYPERDRIVE && events[i].cost_usd > 0) {
                    const { writeBillingRecord } = await import("./runtime/db");
                    writeBillingRecord(this.env.HYPERDRIVE, {
                      session_id: events[i].session_id || "", org_id: data.org_id || "",
                      agent_name: wsAgentName,
                      model: String(events[i].model || events[i].model_used || this.state?.config?.model || "unknown"),
                      provider: String(events[i].provider || this.state?.config?.provider || this.env.DEFAULT_PROVIDER || ""),
                      input_tokens: events[i].input_tokens || 0,
                      output_tokens: events[i].output_tokens || 0,
                      cost_usd: events[i].cost_usd || 0, plan: this.state?.config?.plan || this.env.DEFAULT_PLAN || "free",
                      trace_id: events[i].trace_id || "",
                    }, this.env.AGENT_PROGRESS_KV).catch(() => {});
                  }
                }
                if (events[i].type === "error") done = true;
              }
              lastIdx = events.length;
            }
          } catch (kvErr) {
            kvConsecutiveFailures++;
            console.error("[ws-poll] KV read failed:", kvErr instanceof Error ? kvErr.message : kvErr);
            if (kvConsecutiveFailures >= 3 && !kvDegradedNotified) {
              try {
                connection.send(JSON.stringify({
                  type: "status",
                  message: "Live updates temporarily unavailable, your request is still processing",
                  ts: Date.now(),
                }));
              } catch {}
              kvDegradedNotified = true;
            }
          }

          // ── Consolidated workflow-status fallback ──
          // KV eventual consistency can delay the done event by 1-60s.
          // Poll workflow.status() periodically as a safety net. Cadence
          // is faster before we've seen any KV events (5x) and slower once
          // events are flowing (10x), so early detection of completion
          // doesn't have to wait on KV propagation. Single entry point —
          // previously three separate blocks synthesized done from three
          // different code paths and could race.
          if (!done) {
            const fallbackEvery = lastIdx === 0 ? 5 : 10;
            if (pollCount % fallbackEvery === 0) {
              try {
                const st = await instance.status();
                if (st.status === "complete") {
                  if (!doneSent) {
                    // Re-read KV one last time in case the done event just landed
                    // while we were awaiting status — avoid double-sending.
                    let kvHasDone = false;
                    try {
                      const kvRaw = await this.env.AGENT_PROGRESS_KV.get(progressKey);
                      if (kvRaw) {
                        const kvEvents = JSON.parse(kvRaw) as any[];
                        kvHasDone = kvEvents.some((ev: any) => ev.type === "done");
                      }
                    } catch { /* best-effort */ }
                    if (!kvHasDone) {
                      const out = (st as any).output as { output?: string; session_id?: string; trace_id?: string; cost_usd?: number; tool_calls?: number; input_tokens?: number; output_tokens?: number; turns?: number; latency_ms?: number; termination_reason?: string } | undefined;
                      const doneEvt = this._buildDoneEvent(out, { source: "workflow_status_fallback", seq: lastIdx + 1 });
                      try { connection.send(JSON.stringify(doneEvt)); } catch {}
                      this._appendConversationMessage("assistant", String(doneEvt.output || ""), data.channel || "websocket");
                      this._storeLastResult(doneEvt);
                      doneSent = true;
                    }
                  }
                  done = true;
                } else if (st.status === "errored" || st.status === "terminated") {
                  try { connection.send(JSON.stringify({ type: "error", message: (st as any).error?.message || "Run failed" })); } catch {}
                  done = true;
                }
              } catch { /* best-effort — status API can fail transiently */ }
            }
          }
        }

        // Emit KV poll loop telemetry (P0-5)
        if (this.env.TELEMETRY_QUEUE) {
          this.env.TELEMETRY_QUEUE.send({
            type: "runtime_event",
            event_type: "kv_poll_loop" satisfies RuntimeEventType,
            session_id: data.session_id || "",
            org_id: data.org_id || "",
            node_id: progressKey,
            status: done ? "complete" : (connection.readyState !== 1 ? "client_disconnect" : "timeout"),
            duration_ms: Date.now() - pollStart,
            details: { poll_count: pollCount, kv_failures: kvConsecutiveFailures, degraded_notified: kvDegradedNotified },
          }).catch(() => {});
        }

        // Best-effort cancellation on client disconnect.
        // The workflow is the execution engine; if the client drops, we should avoid continuing to spend tokens/tools.
        // Workflow APIs vary across environments, so we duck-type terminate/cancel if available.
        if (!done && connection.readyState !== 1) {
          try { await (instance as any).terminate?.(); } catch {}
          try { await (instance as any).cancel?.(); } catch {}
        }

        // Clear run state + SQLite tracking record
        if (progressKey) this._untrackWorkflow(progressKey);
        this._activeRun = false;
        this._activeWorkflow = null;
      } catch (err) {
        if (progressKey) this._untrackWorkflow(progressKey);
        this._activeRun = false;
        this._activeWorkflow = null;
        // Log the raw error internally with a correlation id. User-facing
        // payload is a sanitized generic message — never stack traces.
        const errId = crypto.randomUUID().slice(0, 8);
        console.error(`[ws-run] workflow failed (err_id=${errId}):`, err);
        const userFacing =
          err instanceof Error && /workflow bindings not configured/i.test(err.message)
            ? "This deployment is missing a required binding. Please contact support."
            : `Sorry, I couldn't run your request. Please try again in a moment. (ref: ${errId})`;
        try { connection.send(JSON.stringify({ type: "error", message: userFacing, err_id: errId })); } catch {}
        // NOTE: do NOT re-append the user message here — it was already
        // persisted above (line ~1334) before the workflow was created.
        // The previous code double-wrote the user turn on every failure.
        this._appendConversationMessage(
          "assistant",
          `Sorry, I couldn't complete that request. Please try again. (ref: ${errId})`,
          data.channel || "websocket",
        );
      }
    }
  }

  // ── WebSocket disconnect cleanup ──────────────────────────────
  // Stop polling loop and attempt to terminate the active workflow
  // to avoid wasting tokens when the client disconnects.
  async onClose(connection: Connection, code: number, reason: string, wasClean: boolean) {
    if (this._activeWorkflow) {
      this._activeWorkflow.abortPoll = true;
      try { await (this._activeWorkflow.instance as any).terminate?.(); } catch {}
      try { await (this._activeWorkflow.instance as any).cancel?.(); } catch {}
      // Clean up SQLite record for the active workflow
      if (this._activeWorkflow.progressKey) {
        try { this.sql`DELETE FROM active_workflows WHERE progress_key = ${this._activeWorkflow.progressKey}`; } catch {}
      }
      this._activeWorkflow = null;
    }
    this._activeRun = false;
  }

  // ── Workflow SQLite tracking helpers ──────────────────────────────
  // Persist workflow instance references so they survive DO restarts.

  private _trackWorkflow(workflowInstanceId: string, progressKey: string, channel: string = "websocket") {
    try {
      this.sql`INSERT INTO active_workflows (workflow_instance_id, progress_key, channel)
        VALUES (${workflowInstanceId}, ${progressKey}, ${channel})`;
    } catch {}
  }

  private _untrackWorkflow(progressKey: string) {
    try {
      this.sql`DELETE FROM active_workflows WHERE progress_key = ${progressKey}`;
    } catch {}
  }

  // ── Last result persistence for tab-close recovery ────────────────
  // Store the done event in KV so a reconnecting client can retrieve it.
  // TTL of 1 hour — after that, the result is only in conversation history.
  private async _storeLastResult(doneEvt: Record<string, unknown>) {
    if (!this.env.AGENT_PROGRESS_KV) return;
    try {
      const key = `last-result:${this.name}`;
      await this.env.AGENT_PROGRESS_KV.put(key, JSON.stringify(doneEvt), { expirationTtl: 3600 });
    } catch {}
  }

  // Build a normalized done event for fallback/recovery paths.
  private _buildDoneEvent(
    out: {
      output?: string;
      session_id?: string;
      trace_id?: string;
      cost_usd?: number;
      tool_calls?: number;
      input_tokens?: number;
      output_tokens?: number;
      turns?: number;
      latency_ms?: number;
      termination_reason?: string;
      run_phase?: string;
      run_phase_history?: string[];
      artifact_schema?: string;
      artifact_schema_validated?: boolean;
    } | undefined,
    opts?: { source?: string; seq?: number },
  ): Record<string, unknown> {
    const doneEvt: Record<string, unknown> = {
      type: "done",
      output: out?.output || "",
      session_id: out?.session_id || "",
      trace_id: out?.trace_id || "",
      cost_usd: out?.cost_usd || 0,
      tool_calls: out?.tool_calls || 0,
      input_tokens: out?.input_tokens || 0,
      output_tokens: out?.output_tokens || 0,
      turns: out?.turns || 0,
      latency_ms: out?.latency_ms || 0,
      termination_reason: out?.termination_reason || "completed",
      run_phase: out?.run_phase || undefined,
      run_phase_history: out?.run_phase_history || undefined,
      artifact_schema: out?.artifact_schema || undefined,
      artifact_schema_validated: typeof out?.artifact_schema_validated === "boolean"
        ? out.artifact_schema_validated
        : undefined,
      source: opts?.source || "workflow_status_fallback",
      ts: Date.now(),
      _eid: crypto.randomUUID().slice(0, 12),
    };
    if (opts?.seq && Number.isFinite(opts.seq)) doneEvt._seq = opts.seq;
    return doneEvt;
  }

  // ── Orphaned Workflow Recovery ───────────────────────────────────
  // Called from onStart() for each workflow that was in-flight when the DO restarted.
  // Reconnects to the Workflow instance via .get(), polls to completion, and
  // saves the result to conversation history. No WebSocket push (client is gone).

  private async _recoverOrphanedWorkflow(rowId: number, workflowInstanceId: string, progressKey: string, channel: string) {
    try {
      const instance = await this.env.AGENT_RUN_WORKFLOW.get(workflowInstanceId);
      const maxWait = 300_000; // 5 min max recovery wait
      const start = Date.now();

      while (Date.now() - start < maxWait) {
        await new Promise(r => setTimeout(r, 3000));
        try {
          const st = await instance.status();
          if (st.status === "complete") {
            const out = (st as any).output as { output?: string; session_id?: string; trace_id?: string; cost_usd?: number; tool_calls?: number; input_tokens?: number; output_tokens?: number } | undefined;
            // Save assistant response to conversation history
            if (out?.output) {
              this._appendConversationMessage("assistant", out.output, channel);
            }
            // Billing
            if (this.env.HYPERDRIVE && out?.cost_usd && out.cost_usd > 0) {
              try {
                const { writeBillingRecord } = await import("./runtime/db");
                await writeBillingRecord(this.env.HYPERDRIVE, {
                  session_id: out.session_id || "", org_id: this.state.config.orgId || "",
                  agent_name: this.state.config.agentName || "agentos",
                  model: String((out as any).model || (out as any).model_used || this.state?.config?.model || "unknown"),
                  provider: String((out as any).provider || this.state?.config?.provider || this.env.DEFAULT_PROVIDER || ""),
                  input_tokens: out.input_tokens || 0,
                  output_tokens: out.output_tokens || 0,
                  cost_usd: out.cost_usd, plan: this.state?.config?.plan || this.env.DEFAULT_PLAN || "free",
                  trace_id: out.trace_id || "",
                }, this.env.AGENT_PROGRESS_KV).catch(() => {});
              } catch {}
            }
            // Store result for tab-close recovery
            this._storeLastResult(this._buildDoneEvent(out, { source: "workflow_recovery" }));
            console.log(`[workflow-recovery] Recovered completed workflow ${workflowInstanceId}`);
            break;
          }
          if (st.status === "errored" || st.status === "terminated") {
            console.log(`[workflow-recovery] Workflow ${workflowInstanceId} ended with status: ${st.status}`);
            break;
          }
          // Still running — keep polling
        } catch {
          // Instance may not exist anymore — bail
          console.log(`[workflow-recovery] Could not reach workflow ${workflowInstanceId}, giving up`);
          break;
        }
      }
    } catch {
      console.log(`[workflow-recovery] Failed to reconnect to workflow ${workflowInstanceId}`);
    } finally {
      // Always clean up the SQLite record
      try { this.sql`DELETE FROM active_workflows WHERE id = ${rowId}`; } catch {}
    }
  }

  // ── Email entrypoint ─────────────────────────────────────────────
  // Receives inbound emails routed via CF Email Routing → agent DO.
  // Parses the email, runs the agent with the email body as input,
  // and replies to the sender with the agent's response.

  async onEmail(email: ForwardableEmailMessage) {
    // SDK safety: reject auto-reply emails (OOO, vacation, mailing-list) to prevent infinite loops
    if (isAutoReplyEmail(email.headers)) {
      console.log(`[onEmail] Skipping auto-reply from ${email.from}`);
      return;
    }

    await this._syncCheckpointFlagFromDb(this.name);
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
            event_type: "email.processed" satisfies RuntimeEventType,
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
      if (!(await this._isAuthorized(request))) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
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

      // Extract org_id from JWT if not supplied in body (mirrors WS auth at line 1026)
      if (!data.org_id) {
        try {
          const authToken = (request.headers.get("Authorization") || "").slice(7).trim();
          if (authToken && authToken.includes(".")) {
            const payload = JSON.parse(atob(authToken.split(".")[1]));
            if (payload.org_id) data.org_id = payload.org_id;
          }
        } catch {}
      }

      // Input size guard
      if (new TextEncoder().encode(inputText).byteLength > MAX_INPUT_BYTES) {
        return Response.json({ error: "Message too large. Please keep your message under 50 KB.", code: "INPUT_TOO_LARGE" }, { status: 413 });
      }

      const agentName = data.agent_name || this.state.config.agentName || "agentos";
      await this._syncCheckpointFlagFromDb(agentName);

      // Pre-run credit check — reject early if org has no credits
      const runOrgId = data.org_id || this.state.config.orgId || "";
      if (runOrgId && this.env.HYPERDRIVE) {
        try {
          const { getDb } = await import("./runtime/db");
          const sql = await getDb(this.env.HYPERDRIVE);
          const [bal] = await sql`SELECT balance_usd FROM org_credit_balance WHERE org_id = ${runOrgId}`;
          if (!bal || Number(bal.balance_usd) <= 0) {
            return Response.json({
              error: "Insufficient credits. Purchase credits at https://app.021agents.ai/settings?tab=billing",
              code: "insufficient_credits",
            }, { status: 402 });
          }
        } catch (err) {
          console.error("Credit check failed, denying run:", err);
          return Response.json({
            error: "Unable to verify credits. Please try again shortly.",
            code: "credit_check_failed",
          }, { status: 503 });
        }
      }

      // ── Workflow path (durable, crash-safe) ──
      if (this.env.AGENT_RUN_WORKFLOW && this.env.AGENT_PROGRESS_KV) {
        const history = this._loadConversationHistory(24);
        const progressKey = `run:${this.name}:${Date.now()}`;

        try {
          const restConfig = this.state.config;
          const instance = await this.env.AGENT_RUN_WORKFLOW.create({
            params: {
              agent_name: agentName,
              input: inputText,
              org_id: data.org_id || restConfig.orgId || "",
              project_id: data.project_id || restConfig.projectId || "",
              channel: data.channel || "rest",
              channel_user_id: data.channel_user_id || "",
              history: history.map((m: any) => ({ role: m.role, content: m.content })),
              progress_key: progressKey,
              do_session_id: this.name,
              ...(data.plan ? { plan_override: data.plan } : {}),
              ...(data.system_prompt_override ? { system_prompt_override: data.system_prompt_override } : {}),
              ...(data.budget_limit_usd_override ? { budget_limit_usd_override: data.budget_limit_usd_override } : {}),
              ...(data.media_urls?.length ? { media_urls: data.media_urls, media_types: data.media_types } : {}),
              ...(restConfig.systemPrompt && restConfig.systemPrompt.length > 100 && !restConfig.systemPrompt.startsWith("You are a helpful AI assistant") ? {
                preloaded_config: {
                  system_prompt: restConfig.systemPrompt,
                  model: restConfig.model,
                  provider: restConfig.provider || this.env.DEFAULT_PROVIDER || "openrouter",
                  plan: data.plan || restConfig.plan,
                  tools: restConfig.tools,
                  blocked_tools: restConfig.blockedTools || [],
                  max_turns: restConfig.maxTurns || 50,
                  budget_limit_usd: restConfig.budgetLimitUsd || 10,
                  parallel_tool_calls: true,
                  enable_workspace_checkpoints: restConfig.enableWorkspaceCheckpoints !== false,
                },
              } : {}),
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
              const resultModel = String(result.model || result.model_used || this.state?.config?.model || "unknown");
              const resultProvider = String(result.provider || this.state?.config?.provider || this.env.DEFAULT_PROVIDER || "");
              writeBillingRecord(this.env.HYPERDRIVE, {
                session_id: result.session_id || "", org_id: runOrgId,
                agent_name: agentName, model: resultModel, provider: resultProvider,
                input_tokens: result.input_tokens || 0,
                output_tokens: result.output_tokens || 0,
                cost_usd: result.cost_usd || 0, plan: this.state?.config?.plan || this.env.DEFAULT_PLAN || "free",
                trace_id: result.trace_id || "",
                billing_user_id: data.channel_user_id,
                api_key_id: data.api_key_id,
              }, this.env.AGENT_PROGRESS_KV).catch(() => {});
              writeSession(this.env.HYPERDRIVE, {
                session_id: result.session_id || "", org_id: runOrgId,
                project_id: data.project_id || "", agent_name: agentName,
                status: "success", input_text: inputText,
                output_text: result.output || "", model: resultModel,
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

      // Extract org_id from JWT if not supplied in body
      if (!data.org_id) {
        try {
          const authToken = (request.headers.get("Authorization") || "").slice(7).trim();
          if (authToken && authToken.includes(".")) {
            const payload = JSON.parse(atob(authToken.split(".")[1]));
            if (payload.org_id) data.org_id = payload.org_id;
          }
        } catch {}
      }

      // Input size guard
      if (new TextEncoder().encode(inputText).byteLength > MAX_INPUT_BYTES) {
        return Response.json({ error: "Message too large. Please keep your message under 50 KB.", code: "INPUT_TOO_LARGE" }, { status: 413 });
      }

      const agentName = data.agent_name || this.state.config.agentName || "agentos";

      // ── Workflow SSE path — trigger Workflow, stream progress from KV ──
      if (this.env.AGENT_RUN_WORKFLOW && this.env.AGENT_PROGRESS_KV) {
        const history = this._loadConversationHistory(24);
        const progressKey = `run:${this.name}:${Date.now()}`;

        try {
          const sseConfig = this.state.config;
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
              do_session_id: this.name,
              ...(data.plan ? { plan_override: data.plan } : {}),
              ...(sseConfig.systemPrompt && sseConfig.systemPrompt.length > 100 && !sseConfig.systemPrompt.startsWith("You are a helpful AI assistant") ? {
                preloaded_config: {
                  system_prompt: sseConfig.systemPrompt,
                  model: sseConfig.model,
                  provider: sseConfig.provider || this.env.DEFAULT_PROVIDER || "openrouter",
                  plan: data.plan || sseConfig.plan,
                  tools: sseConfig.tools,
                  blocked_tools: sseConfig.blockedTools || [],
                  max_turns: sseConfig.maxTurns || 50,
                  budget_limit_usd: sseConfig.budgetLimitUsd || 10,
                  parallel_tool_calls: true,
                  enable_workspace_checkpoints: sseConfig.enableWorkspaceCheckpoints !== false,
                },
              } : {}),
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
              let sseKvConsecutiveFailures = 0;
              let sseKvDegradedNotified = false;

              let lastActivity = Date.now();
              while (!done && Date.now() - start < maxWait) {
                // Match WebSocket behavior: poll faster in the first 30s.
                const pollInterval = Date.now() - start < 30_000 ? 250 : 1000;
                await new Promise(r => setTimeout(r, pollInterval));

                // Heartbeat every 15s to keep connection alive
                if (Date.now() - lastActivity > 15000) {
                  controller.enqueue(encoder.encode(`: heartbeat\n\n`));
                  lastActivity = Date.now();
                }

                // Read events from KV
                try {
                  const raw = await self.env.AGENT_PROGRESS_KV!.get(progressKey);
                  sseKvConsecutiveFailures = 0; // reset on successful read
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
                            input_tokens: evt.input_tokens || 0,
                            output_tokens: evt.output_tokens || 0,
                            cost_usd: costUsd, plan: (self as any).state?.config?.plan || self.env.DEFAULT_PLAN || "free",
                            trace_id: evt.trace_id || "",
                          }, self.env.AGENT_PROGRESS_KV)
                        ).catch((err: any) => console.error("[sse-billing] writeBillingRecord failed:", err.message));

                        // Write session record (for observability / meta-agent)
                        import("./runtime/db").then(({ writeSession }) =>
                          writeSession(self.env.HYPERDRIVE, {
                            session_id: evt.session_id || "", org_id: orgId,
                            project_id: data.project_id || "", agent_name: agentName,
                            status: "success", input_text: inputText,
                            output_text: String(evt.output || ""),
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
                } catch (kvErr) {
                  sseKvConsecutiveFailures++;
                  console.error("[sse-poll] KV read failed:", kvErr instanceof Error ? kvErr.message : kvErr);
                  if (sseKvConsecutiveFailures >= 3 && !sseKvDegradedNotified) {
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify({
                      type: "status",
                      message: "Live updates temporarily unavailable, your request is still processing",
                      ts: Date.now(),
                    })}\n\n`));
                    sseKvDegradedNotified = true;
                  }
                }

                // Also check Workflow status — handles KV eventual consistency lag
                try {
                  const status = await instance.status();
                  if (status.status === "complete" && !done) {
                    const out = (status as any).output as { output?: string; session_id?: string; trace_id?: string; cost_usd?: number; tool_calls?: number; input_tokens?: number; output_tokens?: number; turns?: number; latency_ms?: number; termination_reason?: string } | undefined;
                    const doneEvt = self._buildDoneEvent(out, { source: "workflow_status_fallback", seq: lastEventIndex + 1 });
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(doneEvt)}\n\n`));
                    self._appendConversationMessage("user", inputText, data.channel || "sse");
                    self._appendConversationMessage("assistant", String(doneEvt.output || ""), data.channel || "sse");
                    done = true;
                  }
                  if (status.status === "errored") {
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "error", message: (status as any).error?.message || "Run failed" })}\n\n`));
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

    // Persist voice session state via serializeAttachment (survives hibernation)
    server.serializeAttachment({ voiceAgent: agentName, voiceOrgId: orgId, voiceCallSid: "", voiceProcessing: false });

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string): Promise<void> {
    // Read hibernation-safe voice session state from attachment
    const att = ws.deserializeAttachment() as { voiceAgent?: string; voiceOrgId?: string; voiceCallSid?: string; voiceProcessing?: boolean; __pk?: unknown } | null;
    // Non-voice connections: delegate to SDK/partyserver bridge → onMessage
    if (!att?.voiceAgent) return super.webSocketMessage(ws, message);

    let msg: any;
    try { msg = JSON.parse(message); } catch { return; }

    const agentName = att.voiceAgent;
    const orgId = att.voiceOrgId || "";

    if (msg.type === "setup") {
      ws.serializeAttachment({ ...att, voiceCallSid: msg.callSid || "" });
      return;
    }

    if (msg.type === "prompt") {
      const userText = (msg.voicePrompt || "").trim();
      if (!userText || att.voiceProcessing) return;

      ws.serializeAttachment({ ...att, voiceProcessing: true });
      const callSid = att.voiceCallSid || "";

      try {
        const config = this.state.config;
        let response = "I didn't catch that. Could you say that again?";
        if (this.env.AGENT_RUN_WORKFLOW) {
          const voiceHistory = this._loadConversationHistory(12);
          const inst = await this.env.AGENT_RUN_WORKFLOW.create({
            params: {
              agent_name: agentName, input: userText,
              org_id: orgId, project_id: config.projectId || "",
              channel: "voice", channel_user_id: "",
              history: voiceHistory.map((m: any) => ({ role: m.role, content: m.content })),
              progress_key: `voice:${this.name}:${Date.now()}`,
              do_session_id: this.name,
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
                    agent_name: agentName,
                    model: String(voiceResult.model || voiceResult.model_used || this.state?.config?.model || "unknown"),
                    provider: String(voiceResult.provider || this.state?.config?.provider || this.env.DEFAULT_PROVIDER || ""),
                    input_tokens: voiceResult.input_tokens || 0,
                    output_tokens: voiceResult.output_tokens || 0,
                    cost_usd: voiceCost,
                    plan: this.state?.config?.plan || this.env.DEFAULT_PLAN || "free", trace_id: voiceResult.trace_id || "",
                  }, this.env.AGENT_PROGRESS_KV);
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
        const cur = ws.deserializeAttachment() as Record<string, unknown> | null;
        ws.serializeAttachment({ ...cur, voiceProcessing: false });
      }
    }

    if (msg.type === "interrupt") {
      const cur = ws.deserializeAttachment() as Record<string, unknown> | null;
      ws.serializeAttachment({ ...cur, voiceProcessing: false });
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    const att = ws.deserializeAttachment() as { voiceAgent?: string } | null;
    if (!att?.voiceAgent) return super.webSocketClose(ws, code, reason, wasClean);
    // Voice relay: just close
    ws.close(code, reason);
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    const att = ws.deserializeAttachment() as { voiceAgent?: string } | null;
    if (!att?.voiceAgent) return super.webSocketError(ws, error);
    // Voice relay: log and close
    console.error("[AgentOSAgent] Voice WebSocket error:", error instanceof Error ? error.message : error);
    ws.close(1011, "WebSocket error");
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
  const sandbox = getTimedSandbox(env.SANDBOX, sandboxId);
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
//
// Uses SDK's McpAgent base class for full MCP protocol compliance:
// - SSE + HTTP streaming transports (handled by SDK)
// - Proper capability negotiation
// - Resources + prompts support (beyond just tools)
// - Lifecycle management (initialize, notifications)
// ---------------------------------------------------------------------------

import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export class AgentOSMcpServer extends McpAgent<Env, {}, {}> {
  // Cached agent config loaded from Supabase
  private _agentConfig: Record<string, unknown> | null = null;
  private _orgId: string = "";

  server = new McpServer({
    name: "agentos-mcp",
    version: "0.2.0",
  });

  async init() {
    // Load agent config from Supabase to discover tools
    await this._loadAgentConfig();

    // ── Core tools: always available ──

    this.server.tool(
      "run-agent",
      "Run an AgentOS agent on a task. Returns the agent's output.",
      { task: z.string().describe("Task to execute"), agent_name: z.string().optional().describe("Agent name (defaults to this agent)") },
      async ({ task, agent_name }) => {
        const targetAgent = agent_name || this.name || "default";
        const orgPrefix = this._orgId ? `${this._orgId}-` : "";
        const agentId = this.env.AGENTOS_AGENT.idFromName(`${orgPrefix}${targetAgent}`);
        const agent = this.env.AGENTOS_AGENT.get(agentId);
        const resp = await agent.fetch(new Request("http://internal/run", {
          method: "POST",
          body: JSON.stringify({ input: task }),
        }));
        const result = await resp.json() as Record<string, unknown>;
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      },
    );

    this.server.tool(
      "search-knowledge",
      "Search the agent's knowledge base for relevant information.",
      { query: z.string().min(1).describe("Search query") },
      async ({ query }) => {
        const orgPrefix = this._orgId ? `${this._orgId}-` : "";
        const agentId = this.env.AGENTOS_AGENT.idFromName(`${orgPrefix}${this.name || "default"}`);
        const agent = this.env.AGENTOS_AGENT.get(agentId);
        const resp = await agent.fetch(new Request("http://internal/run", {
          method: "POST",
          body: JSON.stringify({ input: `Use knowledge search for: ${query}` }),
        }));
        const result = await resp.json() as Record<string, unknown>;
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      },
    );

    // ── Dynamic tools: loaded from agent config ──

    const configuredTools = Array.isArray(this._agentConfig?.tools)
      ? (this._agentConfig!.tools as string[])
      : [];

    // Load tool schemas from registry for richer definitions
    const schemaMap = await this._loadToolSchemas(configuredTools);

    for (const toolName of configuredTools) {
      const registered = schemaMap.get(toolName);
      const description = registered?.description || `Execute the '${toolName}' tool via AgentOS`;

      this.server.tool(
        toolName,
        description,
        { input: z.string().describe("Input for the tool"), parameters: z.record(z.unknown()).optional().describe("Additional parameters") },
        async ({ input, parameters }) => {
          const orgPrefix = this._orgId ? `${this._orgId}-` : "";
          const agentId = this.env.AGENTOS_AGENT.idFromName(`${orgPrefix}${this.name || "default"}`);
          const agent = this.env.AGENTOS_AGENT.get(agentId);
          const resp = await agent.fetch(new Request("http://internal/run", {
            method: "POST",
            body: JSON.stringify({
              input: `Execute tool '${toolName}' with input: ${input}`,
              tool_override: toolName,
              tool_args: { input, ...parameters },
            }),
          }));
          const result = await resp.json() as Record<string, unknown>;
          return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
        },
      );
    }

    // ── Resources: expose agent info ──

    this.server.resource(
      "agent-config",
      "agentos://agent/config",
      async (uri) => ({
        contents: [{
          uri: uri.href,
          text: JSON.stringify({
            name: this.name || "default",
            org_id: this._orgId,
            tools: configuredTools,
            config: this._agentConfig,
          }, null, 2),
          mimeType: "application/json",
        }],
      }),
    );
  }

  /**
   * Load agent configuration from Supabase.
   */
  private async _loadAgentConfig(orgId?: string): Promise<void> {
    if (orgId) this._orgId = orgId;
    if (!this.env.HYPERDRIVE) return;
    try {
      const { getDb } = await import("./runtime/db");
      const sql = await getDb(this.env.HYPERDRIVE);
      const agentName = this.name || "default";
      const effectiveOrgId = orgId || this._orgId;

      const rows = effectiveOrgId
        ? await sql`
            SELECT config, name, description, org_id FROM agents
            WHERE name = ${agentName} AND org_id = ${effectiveOrgId} AND is_active = true
            LIMIT 1
          `
        : await sql`
            SELECT config, name, description, org_id FROM agents
            WHERE name = ${agentName} AND is_active = true
            LIMIT 1
          `;
      if (rows.length === 0) return;

      this._agentConfig = parseJsonColumn(rows[0].config);
      const dbOrgId = rows[0].org_id || "";
      if (dbOrgId) this._orgId = dbOrgId;
    } catch (err) {
      console.error("[MCP] Failed to load agent config:", err);
    }
  }

  /**
   * Load tool schemas from tool_registry for richer MCP tool definitions.
   */
  private async _loadToolSchemas(toolNames: string[]): Promise<Map<string, { description: string; schema: Record<string, unknown> }>> {
    const map = new Map<string, { description: string; schema: Record<string, unknown> }>();
    if (toolNames.length === 0 || !this.env.HYPERDRIVE) return map;
    try {
      const { getDb } = await import("./runtime/db");
      const sql = await getDb(this.env.HYPERDRIVE);
      const rows = await sql`
        SELECT name, description, schema FROM tool_registry
        WHERE name IN ${sql(toolNames)}
      `;
      for (const row of rows) {
        map.set(String(row.name), {
          description: String(row.description || ""),
          schema: parseJsonColumn(row.schema),
        });
      }
    } catch { /* tool_registry may not exist */ }
    return map;
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
  const shortOrg = orgId.length > 12 ? orgId.slice(-8) : orgId;
  const shortUser = userId.length > 12 ? userId.slice(-8) : userId;
  const orgPrefix = shortOrg ? `${shortOrg}-` : "";
  let doName = shortUser
    ? `${orgPrefix}${agentName}-u-${shortUser}`
    : `${orgPrefix}${agentName}`;
  if (doName.length > 63) doName = doName.slice(0, 63);
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
  if (!resp.ok) {
    const text = await resp.text();
    return { output: "", success: false, error: `Runtime DO error (${resp.status}): ${text.slice(0, 500)}`, turns: 0, tool_calls: 0, cost_usd: 0, latency_ms: 0, session_id: "", trace_id: "", stop_reason: "error" };
  }
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

    // ── Circuit breaker snapshot for the canvas LiveStatsPanel ──
    // Aggregates the DB + LLM + tools breakers into a three-lane summary
    // the frontend can render as green/amber/red dots without re-deriving.
    //
    // Shape:
    //   { db: { state, failures, opened_at },
    //     llm: { state, failures, opened_at, last_error },
    //     tools: { state, open_count, half_open_count, worst_tools: [...] },
    //     timestamp }
    //
    // All three breakers are real now — no more inferred signals. The LLM
    // breaker lives in runtime/llm.ts and trips on 5 consecutive upstream
    // failures (AI Gateway / OpenRouter / Workers AI), failing fast for
    // 30 seconds before probing half-open.
    if (url.pathname === "/api/v1/runtime/breakers" && request.method === "GET") {
      const { getCircuitBreakerState } = await import("./runtime/db");
      const { getLlmBreakerState } = await import("./runtime/llm");
      const db = getCircuitBreakerState();
      const llm = getLlmBreakerState();
      const tools = getToolsBreakerSummary();

      return Response.json({
        db: {
          state: db.open ? "open" : db.failures > 0 ? "half-open" : "closed",
          failures: db.failures,
          opened_at: db.openedAt || null,
        },
        llm: {
          state: llm.state,
          failures: llm.failures,
          opened_at: llm.openedAt || null,
          last_failure_at: llm.lastFailureAt || null,
          last_error: llm.lastError,
        },
        tools,
        timestamp: Date.now(),
      }, {
        headers: {
          "Cache-Control": "no-store",
          "Access-Control-Allow-Origin": "*",
        },
      });
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
    // SECURITY NOTE: These runtime endpoints are called by the control-plane
    // service binding, which ALWAYS injects org_id from the authenticated session.
    // The runtime trusts org_id/agent_name as pre-validated by the control-plane.
    // Direct external access to the runtime worker should be blocked by Cloudflare
    // Access policies or service-binding-only routing.
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
        const filePath = (body.path || "").replace(/^\/+/, "").replace(/\/\//g, "/");
        if (filePath.includes("..")) {
          return Response.json({ error: "Invalid path: no '..' allowed" }, { status: 400 });
        }
        const { readFileFromR2 } = await import("./runtime/workspace");
        const content = await readFileFromR2(
          env.STORAGE, body.org_id || "default", body.agent_name || "agent",
          filePath, body.user_id,
        );
        if (content === null) return Response.json({ error: "File not found" }, { status: 404 });
        const ext = filePath.split(".").pop()?.toLowerCase() || "";
        const mimeMap: Record<string, string> = {
          ts: "text/typescript", js: "application/javascript", json: "application/json",
          md: "text/markdown", txt: "text/plain", html: "text/html", css: "text/css",
          py: "text/x-python", rs: "text/x-rust", go: "text/x-go",
          png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
          svg: "image/svg+xml", webp: "image/webp", pdf: "application/pdf",
          wav: "audio/wav", mp3: "audio/mpeg", csv: "text/csv", xml: "text/xml",
        };
        const mimeType = mimeMap[ext] || "application/octet-stream";
        return Response.json({ path: body.path, content, size: content.length, mime_type: mimeType });
      } catch (err: any) {
        return Response.json({ error: err.message }, { status: 500 });
      }
    }

    // ── Workspace file write (R2-backed) ──────────────────────
    if (url.pathname === "/workspace/files/write" && request.method === "POST") {
      try {
        const body = await request.json() as { org_id: string; agent_name: string; path: string; content: string; user_id?: string };
        const filePath = (body.path || "").replace(/^\/+/, "").replace(/\/\//g, "/");
        if (!filePath || filePath.includes("..")) {
          return Response.json({ error: "Invalid path: must be relative, no '..' allowed" }, { status: 400 });
        }
        const orgId = body.org_id || "default";
        const agentName = body.agent_name || "agent";
        const userId = body.user_id || undefined;
        const { syncFileToR2 } = await import("./runtime/workspace");
        await syncFileToR2(env.STORAGE, orgId, agentName, filePath, body.content, "api", userId);
        const key = `workspaces/${orgId}/${agentName}/u/${userId || "shared"}/files/${filePath}`;
        return Response.json({ ok: true, key, size_bytes: body.content.length });
      } catch (err: any) {
        return Response.json({ error: err.message }, { status: 500 });
      }
    }

    // ── Workspace file delete (R2-backed) ────────────────────
    if (url.pathname === "/workspace/files/delete" && request.method === "POST") {
      try {
        const body = await request.json() as { org_id: string; agent_name: string; path: string; user_id?: string };
        const filePath = (body.path || "").replace(/^\/+/, "").replace(/\/\//g, "/");
        if (!filePath || filePath.includes("..")) {
          return Response.json({ error: "Invalid path: must be relative, no '..' allowed" }, { status: 400 });
        }
        const orgId = body.org_id || "default";
        const agentName = body.agent_name || "agent";
        const userId = body.user_id || undefined;
        const { deleteFileFromR2 } = await import("./runtime/workspace");
        await deleteFileFromR2(env.STORAGE, orgId, agentName, filePath, userId);
        return Response.json({ ok: true });
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

    // ── Voice: Twilio Media Stream — raw audio via GPU STT/TTS ──────────
    if (url.pathname === "/voice/stream") {
      const upgradeHeader = request.headers.get("Upgrade") || "";
      if (upgradeHeader.toLowerCase() !== "websocket") {
        return new Response("Expected WebSocket upgrade", { status: 426 });
      }

      const agentName = url.searchParams.get("agent") || "agentos";
      const orgId = url.searchParams.get("org_id") || "";
      const serviceToken = String(env.SERVICE_TOKEN || "");

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();

      // Load agent voice config for TTS engine/voice preferences
      const ttsEngine = url.searchParams.get("tts_engine") || "kokoro";
      const ttsVoice = url.searchParams.get("voice") || "af_heart";
      const sttEngine = url.searchParams.get("stt_engine") || "whisper-gpu";

      const { createVoiceRelay } = await import("./runtime/voice-relay");

      const relay = createVoiceRelay(server, {
        ttsEngine,
        ttsVoice,
        sttEngine,
        greeting: "",  // greeting already played via TwiML <Say>
        agentName,
        serviceToken,
        speed: 1.0,
      }, async (transcript: string) => {
        // Fast agent path — sub-5s latency, escalates to full pipeline if needed
        try {
          const { fastAgentTurn } = await import("./runtime/fast-agent");
          const fastResult = await fastAgentTurn(env, agentName, transcript, {
            org_id: orgId,
            channel: "voice",
          });
          if (fastResult.escalated) {
            const fullResult = await runViaAgent(env, agentName, transcript, {
              org_id: orgId,
              channel: "voice-stream",
            });
            return fullResult?.output || "I didn't catch that.";
          }
          return fastResult?.output || "I didn't catch that.";
        } catch {
          return "Sorry, I encountered an error.";
        }
      });

      server.addEventListener("message", (event) => {
        relay.handleMessage(event.data as string);
      });

      server.addEventListener("close", () => {
        console.log(`[voice-stream] WebSocket closed for ${agentName}`);
      });

      return new Response(null, { status: 101, webSocket: client });
    }

    // ── Voice: Browser Test Call — simpler WebSocket for in-browser voice testing ──
    if (url.pathname === "/voice/test") {
      const upgradeHeader = request.headers.get("Upgrade") || "";
      if (upgradeHeader.toLowerCase() !== "websocket") {
        return new Response("Expected WebSocket upgrade", { status: 426 });
      }

      const agentName = url.searchParams.get("agent") || "agentos";
      const orgId = url.searchParams.get("org_id") || "";
      const serviceToken = String(env.SERVICE_TOKEN || "");
      const authHeaders: Record<string, string> = serviceToken
        ? { Authorization: `Bearer ${serviceToken}` }
        : {};

      // Voice config from query params (set by the UI from current settings)
      const ttsEngine = url.searchParams.get("tts_engine") || "kokoro";
      const ttsVoice = url.searchParams.get("voice") || "af_heart";
      const sttEngine = url.searchParams.get("stt_engine") || "whisper-gpu";
      const greetingText = url.searchParams.get("greeting") || "";
      const ttsSpeed = parseFloat(url.searchParams.get("speed") || "1.0") || 1.0;

      const TTS_URLS: Record<string, string> = {
        kokoro: "https://tts.oneshots.co/v1/audio/speech",
        chatterbox: "https://tts-clone.oneshots.co/v1/audio/speech",
        sesame: "https://tts-voice.oneshots.co/v1/audio/speech",
      };

      const STT_URLS: Record<string, string> = {
        "whisper-gpu": "https://stt.oneshots.co/v1/audio/transcriptions",
        groq: "https://stt.oneshots.co/v1/audio/transcriptions",
      };

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();

      let closed = false;
      let processing = false;  // Lock: only one audio chunk processed at a time
      let lastTranscript = ""; // Dedup: skip if same text as last
      let conversationHistory: Array<{ role: string; content: string }> = []; // Cross-turn memory

      function safeSend(data: string) {
        if (!closed && server.readyState === WebSocket.OPEN) {
          try { server.send(data); } catch { /* ignore */ }
        }
      }

      // Chunked base64 encoding to avoid call stack overflow with large audio buffers
      function arrayBufferToBase64(buffer: ArrayBuffer): string {
        const bytes = new Uint8Array(buffer);
        let binary = "";
        const chunkSize = 8192;
        for (let i = 0; i < bytes.length; i += chunkSize) {
          binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
        }
        return btoa(binary);
      }

      // Send greeting TTS on connect if configured
      if (greetingText.trim()) {
        (async () => {
          try {
            safeSend(JSON.stringify({ type: "transcript", speaker: "agent", text: greetingText }));
            const ttsUrl = TTS_URLS[ttsEngine] || TTS_URLS.kokoro;
            const ttsResp = await fetch(ttsUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json", ...authHeaders },
              body: JSON.stringify({ input: greetingText, voice: ttsVoice, model: ttsEngine, speed: ttsSpeed }),
            });
            if (ttsResp.ok) {
              const audioBuffer = await ttsResp.arrayBuffer();
              const audioB64 = arrayBufferToBase64(audioBuffer);
              safeSend(JSON.stringify({ type: "audio", data: audioB64 }));
            }
          } catch (err) {
            console.error("[voice-test] Greeting TTS failed:", err);
          }
        })();
      }

      server.addEventListener("message", async (event) => {
        let msg: { type: string; data?: string };
        try {
          msg = JSON.parse(event.data as string);
        } catch {
          return;
        }

        if (msg.type === "audio" && msg.data) {
          // Process in background with ctx.waitUntil to avoid Worker timeout
          ctx.waitUntil((async () => {
            // Lock: skip if already processing another chunk
            if (processing) {
              safeSend(JSON.stringify({ type: "status", step: "stt", message: "Still processing previous message..." }));
              return;
            }
            processing = true;

            try {
              safeSend(JSON.stringify({ type: "status", step: "stt", message: "Transcribing..." }));

              // 1. Decode base64 audio from browser (WebM format)
              const audioBytes = Uint8Array.from(atob(msg.data!), (c) => c.charCodeAt(0));

              // Server-side silence check: skip tiny audio (< 2KB likely silence)
              if (audioBytes.length < 2000) {
                processing = false;
                return;
              }

              // 2. Send to STT (Whisper handles WebM natively)
              const formData = new FormData();
              formData.append("file", new Blob([audioBytes], { type: "audio/webm" }), "audio.webm");
              formData.append("response_format", "json");

              const sttUrl = STT_URLS[sttEngine] || STT_URLS["whisper-gpu"];
              const sttResp = await fetch(sttUrl, {
                method: "POST",
                headers: authHeaders,
                body: formData,
              });

              if (!sttResp.ok) {
                const errText = await sttResp.text().catch(() => "");
                safeSend(JSON.stringify({ type: "error", message: `STT failed (${sttResp.status}): ${errText.slice(0, 200)}` }));
                return;
              }

              const sttData = (await sttResp.json()) as { text?: string };
              const transcript = (sttData.text || "").trim();

              // Filter Whisper hallucinations on silence/noise
              const isHallucination = /^\W+$/.test(transcript)
                || /^(\*+|\.\.\.|…|\.+|,+|;+)$/.test(transcript)
                || /thank you|thanks for watching|please subscribe/i.test(transcript)
                || /\[BLANK_AUDIO\]|\(silence\)|\(music\)|\(applause\)/i.test(transcript)
                || /subtitles by|amara\.org|copyright/i.test(transcript)
                || /^(you|the|a|an|um|uh|hmm|oh|ah|okay|ok|bye|hey|hi|hello|yes|no|yeah|nah|sure|right|so)\s*[.!?]?$/i.test(transcript)
                || transcript.length < 5; // very short = probably noise

              // Skip empty/noise/hallucinated transcripts
              if (!transcript || transcript.length < 5 || isHallucination) {
                safeSend(JSON.stringify({ type: "status", step: "stt", message: "No speech detected. Try again." }));
                processing = false;
                return;
              }

              // Dedup: skip if same text as the last transcript
              if (transcript === lastTranscript) {
                safeSend(JSON.stringify({ type: "status", step: "stt", message: "Duplicate detected, skipping." }));
                processing = false;
                return;
              }
              lastTranscript = transcript;

              // 3. Send user transcript to browser
              safeSend(JSON.stringify({ type: "transcript", speaker: "user", text: transcript }));
              safeSend(JSON.stringify({ type: "status", step: "agent", message: "Agent thinking..." }));

              // 4. Fast conversational agent with STREAMING TTS
              // Strategy: get full LLM response, split into sentences,
              // send first sentence to TTS immediately while showing full transcript.
              // This cuts perceived latency by ~50%.

              const { fastAgentTurn } = await import("./runtime/fast-agent");
              const agentResult = await fastAgentTurn(env, agentName, transcript, {
                org_id: orgId,
                channel: "voice",
                history: conversationHistory,
              });

              let responseText: string;
              if (agentResult.escalated) {
                safeSend(JSON.stringify({ type: "transcript", speaker: "agent", text: "Let me work on that. I'll have the answer in a moment." }));
                // Generate TTS for the interim message immediately
                const interimTts = await fetch(TTS_URLS[ttsEngine] || TTS_URLS.kokoro, {
                  method: "POST",
                  headers: { "Content-Type": "application/json", ...authHeaders },
                  body: JSON.stringify({ input: "Let me work on that. I'll have the answer in a moment.", voice: ttsVoice, model: ttsEngine }),
                });
                if (interimTts.ok) {
                  safeSend(JSON.stringify({ type: "audio", data: arrayBufferToBase64(await interimTts.arrayBuffer()) }));
                }
                const fullResult = await runViaAgent(env, agentName, transcript, { org_id: orgId, channel: "voice" });
                responseText = fullResult?.output || "I didn't catch that.";
              } else {
                responseText = agentResult?.output || "I didn't catch that.";
              }

              // Strip markdown + tool call tokens + thinking tags
              responseText = responseText
                .replace(/<\|?tool_call\|?>[\s\S]*?<\|?\/?tool_call\|?>/g, "") // tool call blocks
                .replace(/<\|?tool\|?>[\s\S]*?<\|?\/?tool\|?>/g, "")           // tool definition blocks
                .replace(/<\|?tool_response\|?>[\s\S]*?<\|?\/?tool_response\|?>/g, "") // tool responses
                .replace(/<\|channel>thought[\s\S]*?<channel\|>/g, "")          // thinking blocks
                .replace(/<\|think\|>[\s\S]*?<\|\/think\|>/g, "")              // think tags
                .replace(/call:[a-z_-]+\{[^}]*\}/g, "")                        // call:tool{} inline
                .replace(/#{1,6}\s*/g, "").replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1")
                .replace(/`{1,3}[^`]*`{1,3}/g, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
                .replace(/^[-*•]\s*(\[[ x]\]\s*)?/gm, "").replace(/^\d+\.\s*/gm, "")
                .replace(/^>\s*/gm, "").replace(/---+/g, "")
                .replace(/\n{2,}/g, ". ").replace(/\n/g, " ").replace(/\s{2,}/g, " ").trim();

              // Save to conversation history for context continuity
              conversationHistory.push({ role: "user", content: transcript });
              conversationHistory.push({ role: "assistant", content: responseText });
              if (conversationHistory.length > 40) conversationHistory = conversationHistory.slice(-40);

              // Send full transcript to browser
              safeSend(JSON.stringify({ type: "transcript", speaker: "agent", text: responseText }));

              // 5. Sentence-by-sentence streaming TTS
              // Split response into sentences, TTS each one, send audio as it's ready
              const sentences = responseText.match(/[^.!?]+[.!?]+/g) || [responseText];
              const ttsUrl = TTS_URLS[ttsEngine] || TTS_URLS.kokoro;

              for (const sentence of sentences) {
                const trimmed = sentence.trim();
                if (trimmed.length < 3) continue;

                const ttsResp = await fetch(ttsUrl, {
                  method: "POST",
                  headers: { "Content-Type": "application/json", ...authHeaders },
                  body: JSON.stringify({ input: trimmed, voice: ttsVoice, model: ttsEngine, speed: ttsSpeed }),
                });

                if (ttsResp.ok) {
                  const audioBuffer = await ttsResp.arrayBuffer();
                  safeSend(JSON.stringify({ type: "audio", data: arrayBufferToBase64(audioBuffer) }));
                }
              }
            } catch (err) {
              safeSend(JSON.stringify({ type: "error", message: `Processing error: ${String(err)}` }));
            } finally {
              processing = false;
            }
          })());
        }
      });

      server.addEventListener("close", () => {
        closed = true;
        console.log(`[voice-test] WebSocket closed for ${agentName}`);
      });

      server.addEventListener("error", () => {
        closed = true;
      });

      return new Response(null, { status: 101, webSocket: client });
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

          // Fast conversational agent — sub-5s latency, escalates to full pipeline if needed
          ctx.waitUntil((async () => {
            try {
              const { fastAgentTurn } = await import("./runtime/fast-agent");
              const fastResult = await fastAgentTurn(env, agentName, userText, {
                org_id: orgId,
                channel: "voice",
                session_id: `twilio-${callSid}`,
              });

              let response: string;
              if (fastResult.escalated) {
                // Complex task — fall back to full pipeline
                const fullResult = await runViaAgent(env, agentName, userText, {
                  org_id: orgId,
                  channel: "voice",
                  channel_user_id: `twilio-${callSid}`,
                });
                response = fullResult.output || "I didn't catch that. Could you say that again?";
              } else {
                response = fastResult.output || "I didn't catch that. Could you say that again?";
              }

              // Strip tool call tokens, thinking tags, markdown — everything non-spoken
              response = response
                .replace(/<\|?tool_call\|?>[\s\S]*?<\|?\/?tool_call\|?>/g, "")
                .replace(/<\|?tool\|?>[\s\S]*?<\|?\/?tool\|?>/g, "")
                .replace(/<\|?tool_response\|?>[\s\S]*?<\|?\/?tool_response\|?>/g, "")
                .replace(/<\|channel>thought[\s\S]*?<channel\|>/g, "")
                .replace(/<\|think\|>[\s\S]*?<\|\/think\|>/g, "")
                .replace(/call:[a-z_-]+\{[^}]*\}/g, "")
                .replace(/<[^>]+>/g, "")  // strip any remaining HTML/XML tags
                .replace(/#{1,6}\s*/g, "")
                .replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1")
                .replace(/`{1,3}[^`]*`{1,3}/g, "")
                .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
                .replace(/^[-*•]\s*(\[[ x]\]\s*)?/gm, "")
                .replace(/^\d+\.\s*/gm, "")
                .replace(/^>\s*/gm, "")
                .replace(/---+/g, "")
                .replace(/\n{2,}/g, ". ")
                .replace(/\n/g, " ")
                .replace(/\s{2,}/g, " ")
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
        // Extract org_id from JWT when not provided in body
        if (!body.org_id) {
          try {
            const authToken = (request.headers.get("Authorization") || "").slice(7).trim();
            if (authToken && authToken.includes(".")) {
              const payload = JSON.parse(atob(authToken.split(".")[1]));
              if (payload.org_id) body.org_id = payload.org_id;
            }
          } catch {}
        }
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
      const serviceToken = String(env.SERVICE_TOKEN || "").trim();
      if (!serviceToken) {
        return Response.json({ error: "service_token_not_configured" }, { status: 503 });
      }
      const authHeader = request.headers.get("Authorization") || "";
      const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
      if (token !== serviceToken) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
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
      const serviceToken = String(env.SERVICE_TOKEN || "").trim();
      if (!serviceToken) {
        return Response.json({ error: "service_token_not_configured" }, { status: 503 });
      }
      const authHeader = request.headers.get("Authorization") || "";
      const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
      if (token !== serviceToken) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
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

      // Set RLS org context from JWT claims
      {
        const { setDbOrgContext } = await import("./runtime/db");
        setDbOrgContext(jwtOrgId);
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
      const serviceToken = String(env.SERVICE_TOKEN || "").trim();
      if (!serviceToken) {
        return Response.json({ error: "service_token_not_configured" }, { status: 503 });
      }
      const authHeader = request.headers.get("Authorization") || "";
      const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
      if (token !== serviceToken) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
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
                input,
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
          const orgId = body.org_id || "";
          const dbEvalRunId = await writeEvalRun(env.HYPERDRIVE, {
            agent_name: agentName, org_id: orgId, eval_name: evalName,
            total_tasks: tasks.length, total_trials: totalTrials,
            pass_count: passCount, fail_count: Math.max(0, totalTrials - passCount),
            error_count: errorCount, pass_rate: passRate,
            avg_score: avgScore, avg_latency_ms: avgLatency, total_cost_usd: totalCost,
            eval_conditions_json: JSON.stringify({ source: "edge_eval_api", trials_per_task: trials }),
          });
          for (const row of trialRows) {
            await writeEvalTrial(env.HYPERDRIVE, {
              eval_run_id: dbEvalRunId, agent_name: agentName, org_id: orgId,
              task_name: row.task_name, input: String(row.input || ""),
              expected: row.expected, actual: String(row.output || ""),
              passed: row.passed, score: row.score,
              reasoning: row.error ? `Error: ${row.error}` : (row.passed ? "passed" : "failed"),
              latency_ms: Number(row.latency_ms || 0), cost_usd: Number(row.cost_usd || 0),
              grader: row.grader || "contains",
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
      const serviceToken = String(env.SERVICE_TOKEN || "").trim();
      if (!serviceToken) {
        return Response.json({ error: "service_token_not_configured" }, { status: 503 });
      }
      const authHeader = request.headers.get("Authorization") || "";
      const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
      if (token !== serviceToken) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
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
    const evalRunMatch = url.pathname.match(/^\/api\/v1\/eval\/runs\/([^/]+)$/);
    if (evalRunMatch && request.method === "GET") {
      const serviceToken = String(env.SERVICE_TOKEN || "").trim();
      if (!serviceToken) {
        return Response.json({ error: "service_token_not_configured" }, { status: 503 });
      }
      const authHeader = request.headers.get("Authorization") || "";
      const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
      if (token !== serviceToken) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      try {
        const runId = decodeURIComponent(String(evalRunMatch[1] || ""));
        const run = await getEvalRun(env.HYPERDRIVE, runId);
        if (!run) return Response.json({ error: "Eval run not found" }, { status: 404 });
        const trials = await listEvalTrialsByRun(env.HYPERDRIVE, runId);
        return Response.json({ ...run, trials });
      } catch (err: any) {
        return Response.json({ error: err.message || String(err) }, { status: 500 });
      }
    }
    const evalTrialsMatch = url.pathname.match(/^\/api\/v1\/eval\/runs\/([^/]+)\/trials$/);
    if (evalTrialsMatch && request.method === "GET") {
      const serviceToken = String(env.SERVICE_TOKEN || "").trim();
      if (!serviceToken) {
        return Response.json({ error: "service_token_not_configured" }, { status: 503 });
      }
      const authHeader = request.headers.get("Authorization") || "";
      const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
      if (token !== serviceToken) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      try {
        const runId = decodeURIComponent(String(evalTrialsMatch[1] || ""));
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
      const serviceToken = String(env.SERVICE_TOKEN || "").trim();
      if (!serviceToken) {
        return Response.json({ error: "service_token_not_configured" }, { status: 503 });
      }
      const authHeader = request.headers.get("Authorization") || "";
      const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
      if (token !== serviceToken) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
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

      // DO name for WebSocket connection — must include org_id for tenant isolation
      // Truncate UUIDs to stay within 63-char Sandbox limit
      const shortOrg2 = body.org_id && body.org_id.length > 12 ? body.org_id.slice(-8) : (body.org_id || "");
      const shortUser2 = userId.length > 12 ? userId.slice(-8) : userId;
      const orgPrefix = shortOrg2 ? `${shortOrg2}-` : "";
      let doName = shortUser2 ? `${orgPrefix}${agentName}-u-${shortUser2}` : `${orgPrefix}${agentName}`;
      if (doName.length > 63) doName = doName.slice(0, 63);

      return Response.json({
        status: "running",
        agent_name: agentName,
        websocket_url: `/agents/agentos-agent/${doName}`,
        message: "Run started. Connect via WebSocket for streaming, or poll GET /api/v1/runs/{run_id}.",
      }, { status: 202 });
    }

    if (url.pathname === "/api/v1/runtime-proxy/runnable/stream-events" && request.method === "POST") {
      const serviceToken = String(env.SERVICE_TOKEN || "").trim();
      if (!serviceToken) {
        return Response.json({ error: "service_token_not_configured" }, { status: 503 });
      }
      const authHeader = request.headers.get("Authorization") || "";
      const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
      if (token !== serviceToken) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
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
          const seOrgPrefix = body.org_id ? `${body.org_id}-` : "";
          const doName = userId ? `${seOrgPrefix}${agentName}-u-${userId}` : `${seOrgPrefix}${agentName}`;
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
      const serviceToken = String(env.SERVICE_TOKEN || "").trim();
      if (!serviceToken) {
        return Response.json({ error: "service_token_not_configured" }, { status: 503 });
      }
      const authHeader = request.headers.get("Authorization") || "";
      const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
      if (token !== serviceToken) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }

      try {
        const body = await request.json() as {
          agent_name?: string; task?: string; input?: unknown;
          org_id?: string; project_id?: string; channel?: string; channel_user_id?: string;
          api_key_id?: string; session_id?: string; plan?: string;
          conversation_id?: string;
        };

        const agentName = body.agent_name || "agentos";
        const task = runnableInputToTask(body.input, body.task);
        const userId = body.channel_user_id || "";
        const orgId = body.org_id || "";
        let conversationId = body.conversation_id || "";
        const sessionId = body.session_id || "";
        // Build DO name within 63-char Sandbox limit.
        // Hash long org/user IDs to keep the name short while maintaining uniqueness.
        const shortOrg = orgId.length > 12 ? orgId.slice(-8) : orgId;
        const shortUser = userId.length > 12 ? userId.slice(-8) : userId;
        const orgPrefix = shortOrg ? `${shortOrg}-` : "";
        let doName = shortUser
          ? `${orgPrefix}${agentName}-u-${shortUser}`
          : `${orgPrefix}${agentName}`;
        // Ensure ≤63 chars (Cloudflare Sandbox/Container name limit)
        if (doName.length > 63) doName = doName.slice(0, 63);
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
            session_id: sessionId || undefined,
            conversation_id: conversationId || undefined,
            history: (body as any).history || undefined,
            ...(body.plan ? { plan: body.plan } : {}),
          }),
        }));

        if (!doResp.ok) {
          const errText = await doResp.text();
          return Response.json({ error: errText }, { status: doResp.status });
        }

        // ── Conversation persistence: wrap SSE stream ──────────
        // Intercept the SSE stream to:
        //   1. Create conversation if none provided (on first message)
        //   2. Write user + assistant messages to conversation_messages after done
        //   3. Include conversation_id in the done event
        const { readable, writable } = new TransformStream();
        const writer = writable.getWriter();
        const sseDecoder = new TextDecoder();
        const sseEncoder = new TextEncoder();

        // Helper: generate title from first user message
        function generateTitle(input: string): string {
          if (!input) return "New conversation";
          // Trim at word boundary within 50 chars
          const trimmed = input.slice(0, 60);
          if (trimmed.length <= 50) return trimmed;
          const lastSpace = trimmed.lastIndexOf(" ", 50);
          return lastSpace > 20 ? trimmed.slice(0, lastSpace) : trimmed.slice(0, 50);
        }

        ctx.waitUntil((async () => {
          const reader = doResp.body!.getReader();
          let fullAssistantContent = "";
          let doneEventData: Record<string, unknown> | null = null;
          let sseBuffer = "";

          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              const chunk = sseDecoder.decode(value, { stream: true });
              sseBuffer += chunk;
              let sep = sseBuffer.indexOf("\n\n");
              while (sep >= 0) {
                const frame = sseBuffer.slice(0, sep);
                sseBuffer = sseBuffer.slice(sep + 2);
                sep = sseBuffer.indexOf("\n\n");
                if (!frame.trim()) continue;

                const dataLines = frame
                  .split("\n")
                  .filter((line) => line.startsWith("data:"))
                  .map((line) => line.slice(5).trim());
                if (dataLines.length === 0) {
                  await writer.write(sseEncoder.encode(`${frame}\n\n`));
                  continue;
                }

                const payload = dataLines.join("\n");
                try {
                  const parsed = JSON.parse(payload) as Record<string, unknown>;
                  if (parsed.type === "token") {
                    fullAssistantContent += String(parsed.content || parsed.text || "");
                  }
                  if (parsed.type === "done") {
                    doneEventData = parsed;
                    if (conversationId) parsed.conversation_id = conversationId;
                  }
                  await writer.write(sseEncoder.encode(`data: ${JSON.stringify(parsed)}\n\n`));
                } catch {
                  await writer.write(sseEncoder.encode(`${frame}\n\n`));
                }
              }
            }

            if (sseBuffer.trim()) {
              await writer.write(sseEncoder.encode(sseBuffer));
            }

            // ── After stream completes: persist conversation ──
            if (orgId && task) {
              try {
                const pg = (await import("postgres")).default;
                const sql = pg((env as any).HYPERDRIVE.connectionString, {
                  max: 1, fetch_types: false, prepare: false, connect_timeout: 5,
                });

                // Create conversation if not provided
                if (!conversationId) {
                  const title = generateTitle(task);
                  const [conv] = await sql`
                    INSERT INTO conversations (org_id, user_id, agent_name, channel, title)
                    VALUES (${orgId}, ${userId}, ${agentName}, ${"sse"}, ${title})
                    RETURNING id
                  `;
                  conversationId = String(conv.id);
                }

                const doneSessionId = doneEventData ? String(doneEventData.session_id || "") : "";
                const doneCostUsd = doneEventData ? Number(doneEventData.cost_usd || 0) : 0;

                // Write user message + assistant response
                await sql`
                  INSERT INTO conversation_messages (conversation_id, role, content, session_id)
                  VALUES (${conversationId}, 'user', ${task}, ${doneSessionId || null})
                `;
                await sql`
                  INSERT INTO conversation_messages (conversation_id, role, content, model, cost_usd, session_id)
                  VALUES (
                    ${conversationId}, 'assistant',
                    ${fullAssistantContent || (doneEventData?.output as string) || ""},
                    ${doneEventData ? String(doneEventData.model || "") : null},
                    ${doneCostUsd},
                    ${doneSessionId || null}
                  )
                `;

                // Update conversation stats
                await sql`
                  UPDATE conversations SET
                    message_count = (SELECT COUNT(*) FROM conversation_messages WHERE conversation_id = ${conversationId}),
                    total_cost_usd = (SELECT COALESCE(SUM(cost_usd), 0) FROM conversation_messages WHERE conversation_id = ${conversationId}),
                    updated_at = NOW()
                  WHERE id = ${conversationId}
                `;

                await sql.end();
              } catch (convErr: any) {
                console.error(`[conversation-persist] Error: ${convErr.message}`);
              }
            }
          } catch {} finally {
            try { await writer.close(); } catch {}
          }
        })());

        return new Response(readable, {
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
      const serviceToken = String(env.SERVICE_TOKEN || "").trim();
      if (!serviceToken) {
        return Response.json({ error: "service_token_not_configured" }, { status: 503 });
      }
      const authHeader = request.headers.get("Authorization") || "";
      const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
      if (token !== serviceToken) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
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
      const serviceToken = String(env.SERVICE_TOKEN || "").trim();
      if (!serviceToken) {
        return Response.json({ error: "service_token_not_configured" }, { status: 503 });
      }
      const authHeader = request.headers.get("Authorization") || "";
      const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
      if (token !== serviceToken) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
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
      const serviceToken = String(env.SERVICE_TOKEN || "").trim();
      if (!serviceToken) {
        return Response.json({ error: "service_token_not_configured" }, { status: 503 });
      }
      const authHeader = request.headers.get("Authorization") || "";
      const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
      if (token !== serviceToken) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
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
        AI: env.AI, HYPERDRIVE: env.HYPERDRIVE, HYPERDRIVE_ADMIN: env.HYPERDRIVE_ADMIN, VECTORIZE: env.VECTORIZE,
        STORAGE: env.STORAGE, SANDBOX: env.SANDBOX, LOADER: env.LOADER,
        TELEMETRY_QUEUE: env.TELEMETRY_QUEUE, BROWSER: env.BROWSER,
        AI_GATEWAY_ID: env.AI_GATEWAY_ID, AI_GATEWAY_TOKEN: env.AI_GATEWAY_TOKEN,
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
        AI: env.AI, HYPERDRIVE: env.HYPERDRIVE, HYPERDRIVE_ADMIN: env.HYPERDRIVE_ADMIN, VECTORIZE: env.VECTORIZE,
        STORAGE: env.STORAGE, SANDBOX: env.SANDBOX, LOADER: env.LOADER,
        TELEMETRY_QUEUE: env.TELEMETRY_QUEUE, BROWSER: env.BROWSER,
        AI_GATEWAY_ID: env.AI_GATEWAY_ID, AI_GATEWAY_TOKEN: env.AI_GATEWAY_TOKEN,
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
      const serviceToken = String(env.SERVICE_TOKEN || "").trim();
      if (!serviceToken) {
        return Response.json({ error: "service_token_not_configured" }, { status: 503 });
      }
      const authHeader = request.headers.get("Authorization") || "";
      const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
      if (token !== serviceToken) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }

      const body = await request.json() as {
        agent_name?: string; task?: string;
        org_id?: string; project_id?: string; channel?: string; channel_user_id?: string;
        api_key_id?: string;
      };

      const agentName = body.agent_name || "agentos";
      const userId = body.channel_user_id || "";
      const runOrgPrefix = body.org_id ? `${body.org_id}-` : "";
      const doName = userId ? `${runOrgPrefix}${agentName}-u-${userId}` : `${runOrgPrefix}${agentName}`;

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
      const serviceToken = String(env.SERVICE_TOKEN || "").trim();
      if (!serviceToken) {
        return Response.json({ error: "service_token_not_configured" }, { status: 503 });
      }
      const authHeader = request.headers.get("Authorization") || "";
      const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
      if (token !== serviceToken) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }

      const body = await request.json() as { inputs: Array<{
        agent_name?: string; task?: string; input?: unknown;
        org_id?: string; project_id?: string; channel?: string; channel_user_id?: string;
        api_key_id?: string;
        config?: Record<string, unknown>;
      }> };

      const runtimeEnv: RuntimeEnv = {
        AI: env.AI, HYPERDRIVE: env.HYPERDRIVE, HYPERDRIVE_ADMIN: env.HYPERDRIVE_ADMIN, VECTORIZE: env.VECTORIZE,
        STORAGE: env.STORAGE, SANDBOX: env.SANDBOX, LOADER: env.LOADER,
        TELEMETRY_QUEUE: env.TELEMETRY_QUEUE, BROWSER: env.BROWSER,
        AI_GATEWAY_ID: env.AI_GATEWAY_ID,
        AI_GATEWAY_TOKEN: env.AI_GATEWAY_TOKEN,
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
      const serviceToken = String(env.SERVICE_TOKEN || "").trim();
      if (!serviceToken) {
        return Response.json({ error: "service_token_not_configured" }, { status: 503 });
      }
      const authHeader = request.headers.get("Authorization") || "";
      const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
      if (token !== serviceToken) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
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
      const bdOrgPrefix = body.org_id ? `${body.org_id}-` : "";
      const doName = userId ? `${bdOrgPrefix}${agentName}-u-${userId}` : `${bdOrgPrefix}${agentName}`;

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
      const serviceToken = String(env.SERVICE_TOKEN || "").trim();
      if (!serviceToken) {
        return Response.json({ error: "service_token_not_configured" }, { status: 503 });
      }
      const authHeader = request.headers.get("Authorization") || "";
      const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
      if (token !== serviceToken) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
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
            const rows = await sql`SELECT encrypted_value FROM secrets WHERE name = 'WHATSAPP_ACCESS_TOKEN' AND org_id = ${orgId} ORDER BY created_at DESC LIMIT 1`;
            if (rows.length > 0) waToken = String(rows[0].encrypted_value);
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
        const rows = await sql`SELECT encrypted_value FROM secrets WHERE name = 'SLACK_BOT_TOKEN' AND org_id = ${slackOrgId} ORDER BY created_at DESC LIMIT 1`;
        if (rows.length > 0) slackBotToken = String(rows[0].encrypted_value);
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
            const rows = await sql`SELECT encrypted_value FROM secrets WHERE name = 'INSTAGRAM_PAGE_TOKEN' AND org_id = ${igOrgId} ORDER BY created_at DESC LIMIT 1`;
            if (rows.length > 0) igPageToken = String(rows[0].encrypted_value);
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
            const rows = await sql`SELECT encrypted_value FROM secrets WHERE name = 'FACEBOOK_PAGE_TOKEN' AND org_id = ${fbOrgId} ORDER BY created_at DESC LIMIT 1`;
            if (rows.length > 0) fbPageToken = String(rows[0].encrypted_value);
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

      // Set RLS org context from X-Org-Id header (service-to-service calls)
      const cfOrgId = request.headers.get("X-Org-Id") || url.searchParams.get("org_id") || "";
      if (cfOrgId) {
        const { setDbOrgContext } = await import("./runtime/db");
        setDbOrgContext(cfOrgId);
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
            await tx`SELECT set_config('app.current_user_id', ${userId || "system"}, true)`;
            await tx`SELECT set_config('app.current_role', ${role || "service"}, true)`;

            // ── Agent queries ──────────────────────────────────────
            if (queryId === "agents.list_active_by_org") {
              return await tx`
                SELECT agent_id, handle, display_name, name, description, config, is_active, created_at, updated_at
                FROM agents
                WHERE org_id = ${orgId}
                  AND is_active = true
                  AND COALESCE(config->>'internal', 'false') <> 'true'
                  AND COALESCE(config->>'hidden', 'false') <> 'true'
                  AND COALESCE(config->>'parent_agent', '') = ''
                ORDER BY created_at DESC
              `;
            }
            if (queryId === "agents.config") {
              const agentIdentifier = String(body.params?.agent_id || body.params?.agent_handle || body.params?.agent_name || "");
              if (!agentIdentifier) throw new Error("params.agent_id or params.agent_handle required");
              return await tx`
                SELECT agent_id, handle, display_name, name, config, description
                FROM agents
                WHERE (
                  agent_id = ${agentIdentifier}
                  OR handle = ${agentIdentifier}
                  OR name = ${agentIdentifier}
                ) AND org_id = ${orgId} AND is_active = true LIMIT 1
              `;
            }
            if (queryId === "agents.versions") {
              const agentId = String(body.params?.agent_id || "");
              const agentName = String(body.params?.agent_handle || body.params?.agent_name || "");
              const limit = Math.min(Number(body.params?.limit) || 20, 100);
              return await tx`
                SELECT version, created_by, created_at FROM agent_versions
                WHERE (
                  (${agentId} != '' AND agent_id = ${agentId})
                  OR (${agentName} != '' AND (agent_handle = ${agentName} OR agent_name = ${agentName}))
                )
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
              const runId = String(body.params?.run_id || "");
              if (!runId) throw new Error("params.run_id required");
              return await tx`SELECT * FROM eval_trials WHERE eval_run_id = ${runId} ORDER BY created_at`;
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
              return await tx`SELECT * FROM session_feedback WHERE org_id = ${orgId} ORDER BY created_at DESC LIMIT ${limit}`;
            }
            if (queryId === "feedback.stats") {
              const sinceDays = Math.min(Number(body.params?.since_days) || 30, 365);
              const since = new Date(Date.now() - sinceDays * 86400 * 1000).toISOString();
              return await tx`SELECT rating, COUNT(*) as count FROM session_feedback WHERE org_id = ${orgId} AND created_at >= ${since} GROUP BY rating`;
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
        const body = await request.json() as {
          code: string;
          language?: string;
          timeoutMs?: number;
          org_id?: string;
          session_id?: string;
        };
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
          const orgId = String(body.org_id || request.headers.get("X-Org-Id") || "");
          const sessionId = String(body.session_id || "");
          const affinityKey = `${orgId || "global"}:${sessionId || _hashString(code).toString(16)}`;
          const runWithLease = async (lease: { lane: string; sandboxId: string }) => {
            if (orgId) {
              // Best effort: keep outbound access scoped when org context is known.
              AgentSandbox.registerOrg(env.SANDBOX, lease.sandboxId, orgId).catch(() => {});
            }
            const sandbox = getTimedSandbox(env.SANDBOX, lease.sandboxId, { sleepAfter: "20m" } as any);
            return sandbox.exec(code, { timeout: Math.ceil(timeout / 1000) });
          };

          const lease = await _acquireCfExecLane(env, affinityKey);
          try {
            let result: any;
            try {
              result = await runWithLease(lease);
            } catch (firstErr: any) {
              // Lane can become unhealthy/stuck; retry once on a different affinity key.
              const retryLease = await _acquireCfExecLane(env, `${affinityKey}:retry:${crypto.randomUUID().slice(0, 8)}`);
              try {
                result = await runWithLease(retryLease);
              } finally {
                _releaseCfExecLane(retryLease.lane);
              }
              if (!result) throw firstErr;
            }
            return Response.json({ stdout: result.stdout || "", stderr: result.stderr || "", exit_code: result.exitCode ?? 0 });
          } catch (err: any) {
            return Response.json({ stdout: "", stderr: err.message, exit_code: 1 });
          } finally {
            _releaseCfExecLane(lease.lane);
          }
        }

        return Response.json({ error: `unsupported language: ${language}` }, { status: 400 });
      }

      // /cf/ai/embed — embed text via Workers AI
      if (url.pathname === "/cf/ai/embed" && request.method === "POST") {
        const body = await request.json() as { texts: string[] };
        try {
          const { embed: embedTexts } = await import("./runtime/embeddings");
          const result = await embedTexts(body.texts, env);
          return Response.json({ vectors: result.vectors, model: result.model, dimensions: result.dimensions });
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
        const inferredProvider = model.startsWith("@cf/") ? "workers-ai" : "custom-gemma4-fast";
        const provider = String(body.provider || inferredProvider);

        try {
          const { callLLM } = await import("./runtime/llm");
          const llm = await callLLM(
            {
              AI: env.AI,
              CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID,
              AI_GATEWAY_ID: env.AI_GATEWAY_ID,
              AI_GATEWAY_TOKEN: env.AI_GATEWAY_TOKEN,
              CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN,
              GPU_SERVICE_KEY: env.GPU_SERVICE_KEY,
            } as any,
            (body.messages || []).map((m: any) => ({
              role: m.role,
              content: String(m.content || ""),
            })),
            [],
            {
              model,
              provider,
              max_tokens: body.max_tokens || 1024,
              temperature: body.temperature || 0,
            },
          );

          return Response.json({
            content: llm.content || "",
            model: llm.model || model,
            provider,
            tool_calls: llm.tool_calls || [],
            input_tokens: llm.usage?.input_tokens || 0,
            output_tokens: llm.usage?.output_tokens || 0,
            cost_usd: llm.cost_usd || 0,
            latency_ms: llm.latency_ms || 0,
            stop_reason: llm.stop_reason || null,
          });
        } catch (err: any) {
          return Response.json({ error: err.message, model, provider }, { status: 500 });
        }
      }

      // /cf/rag/query — semantic search via Vectorize with query rewriting + dedup
      if (url.pathname === "/cf/rag/query" && request.method === "POST") {
        const body = await request.json() as { query: string; topK?: number; org_id?: string; agent_name?: string; pipeline?: string; source?: string; dedup?: boolean };
        try {
          const { rewriteQuery, dedupResults } = await import("./runtime/rag-transforms");
          const { bm25Search, reciprocalRankFusion } = await import("./runtime/rag-hybrid");

          // Step 1: Rewrite query + generate multi-query variants
          const expandedQuery = rewriteQuery(body.query, { agentName: body.agent_name });
          const { generateMultiQuery } = await import("./runtime/rag-hybrid");
          const llmUrl = "https://fast.oneshots.co";
          const authHdrs = env.SERVICE_TOKEN ? { Authorization: `Bearer ${env.SERVICE_TOKEN}` } : {};
          let queryVariants = [expandedQuery];
          try {
            queryVariants = await generateMultiQuery(llmUrl, expandedQuery, authHdrs as Record<string, string>);
          } catch { /* single query fallback */ }

          const filter: Record<string, string> = {};
          if (body.org_id) filter.org_id = body.org_id;
          if (body.agent_name) filter.agent_name = body.agent_name;
          if (body.pipeline) filter.pipeline = body.pipeline;
          if (body.source) filter.source = body.source;

          const retrieveK = Math.min((body.topK || 10) * 2, 30);

          // Step 2: Embed all query variants + run vector search for each + BM25 for primary
          const { embedForQuery } = await import("./runtime/embeddings");
          const allVectorResults: Array<{ id: string; score: number; text: string; source: string; pipeline: string; chunk_type: string; chunk_index: number }> = [];

          // Embed and search all query variants in parallel
          const variantSearches = queryVariants.map(async (q) => {
            try {
              const embResult = await embedForQuery(q, env);
              const matches = await env.VECTORIZE.query(embResult.vector, {
                topK: retrieveK,
                filter: Object.keys(filter).length > 0 ? filter : undefined,
                returnMetadata: "all",
              });
              return (matches.matches || []).map((m: any) => ({
                id: m.id, score: m.score,
                text: m.metadata?.text || "", source: m.metadata?.source || "",
                pipeline: m.metadata?.pipeline || "", chunk_type: m.metadata?.chunk_type || "",
                chunk_index: m.metadata?.chunk_index || 0,
              }));
            } catch { return []; }
          });

          const bm25Promise = env.HYPERDRIVE
            ? bm25Search(env.HYPERDRIVE, expandedQuery, { org_id: body.org_id, source: body.source, limit: retrieveK })
            : Promise.resolve([]);

          const [variantResults, bm25Matches] = await Promise.all([
            Promise.all(variantSearches),
            bm25Promise,
          ]);

          // Merge all variant results — deduplicate by ID, keep highest score
          const seenIds = new Map<string, typeof allVectorResults[0]>();
          for (const results of variantResults) {
            for (const r of results) {
              const existing = seenIds.get(r.id);
              if (!existing || r.score > existing.score) {
                seenIds.set(r.id, r);
              }
            }
          }
          const vectorResults = Array.from(seenIds.values())
            .sort((a, b) => b.score - a.score);

          // Step 3: Fuse results with Reciprocal Rank Fusion
          let results: any[];
          if (bm25Matches.length > 0) {
            const fused = reciprocalRankFusion(vectorResults, bm25Matches);
            results = fused.map(r => ({
              id: r.id,
              score: r.rrf_score,
              text: r.context_prefix ? `${r.context_prefix}\n\n${r.text}` : r.text,
              source: r.source,
              pipeline: r.pipeline,
              chunk_type: r.chunk_type,
              chunk_index: r.chunk_index,
              search_method: r.vector_score && r.bm25_rank ? "hybrid" : r.bm25_rank ? "bm25" : "vector",
            }));
          } else {
            // No BM25 results — fall back to vector-only
            results = vectorResults.map((r: any) => ({
              ...r,
              search_method: "vector",
            }));
          }

          // Step 4: Deduplicate
          if (body.dedup !== false) {
            results = dedupResults(results as any, { maxPerSource: 3 }) as typeof results;
          }

          // Step 5: Return top-K
          results = results.slice(0, body.topK || 10);
          return Response.json({
            results,
            query_expanded: expandedQuery !== body.query ? expandedQuery : undefined,
            search_methods: bm25Matches.length > 0 ? ["vector", "bm25", "rrf"] : ["vector"],
            query_variants: queryVariants.length > 1 ? queryVariants : undefined,
          });
        } catch (err: any) {
          return Response.json({ error: err.message }, { status: 500 });
        }
      }

      // /cf/rag/evaluate — RAGAS-style evaluation of RAG quality
      if (url.pathname === "/cf/rag/evaluate" && request.method === "POST") {
        const body = await request.json() as {
          query: string;
          answer: string;
          contexts: string[];
          ground_truth?: string;
        };
        if (!body.query || !body.answer || !body.contexts?.length) {
          return Response.json({ error: "query, answer, and contexts are required" }, { status: 400 });
        }
        try {
          const { evaluateRAG } = await import("./runtime/rag-eval");
          const llmUrl = "https://fast.oneshots.co";
          const authHdrs = env.SERVICE_TOKEN ? { Authorization: `Bearer ${env.SERVICE_TOKEN}` } : {};
          const result = await evaluateRAG(body, llmUrl, authHdrs as Record<string, string>);

          // Store eval result in telemetry queue for tracking over time
          if (env.TELEMETRY_QUEUE) {
            try {
              await env.TELEMETRY_QUEUE.send({
                type: "event",
                payload: {
                  event_type: "rag_eval" satisfies RuntimeEventType,
                  query: body.query.slice(0, 200),
                  overall_score: result.overall,
                  context_precision: result.context_precision,
                  faithfulness: result.faithfulness,
                  created_at: new Date().toISOString(),
                },
              });
            } catch { /* telemetry is best-effort */ }
          }

          return Response.json(result);
        } catch (err: any) {
          return Response.json({ error: err.message }, { status: 500 });
        }
      }

      // /cf/rag/ingest — smart chunk, validate, embed, store in Vectorize + R2
      if (url.pathname === "/cf/rag/ingest" && request.method === "POST") {
        const body = await request.json() as { text: string; source?: string; org_id?: string; agent_name?: string };
        try {
          const { smartChunk, validateChunk } = await import("./runtime/rag-transforms");
          const rawChunks = smartChunk(body.text);
          const seenHashes = new Set<string>();
          const validChunks = rawChunks.filter(c => validateChunk(c.text, seenHashes).valid);
          const chunkTexts = validChunks.map(c => c.text);
          const rejected = rawChunks.length - validChunks.length;

          if (chunkTexts.length === 0) {
            return Response.json({ error: "All chunks failed validation (binary content or duplicates)", rejected }, { status: 422 });
          }

          const { embed: embedChunks } = await import("./runtime/embeddings");
          const embedResult = await embedChunks(chunkTexts, env);
          const vectors = embedResult.vectors;

          const vecInserts = vectors.map((vec: number[], idx: number) => ({
            id: `${body.source || "text"}-${Date.now()}-${idx}`,
            values: vec,
            metadata: {
              text: chunkTexts[idx],
              source: body.source || "api",
              pipeline: "text",
              org_id: body.org_id || "",
              agent_name: body.agent_name || "",
              chunk_index: idx,
              chunk_type: validChunks[idx]?.type || "prose",
              ingested_at: new Date().toISOString(),
            },
          }));

          if (vecInserts.length > 0) {
            await env.VECTORIZE.upsert(vecInserts);
          }

          // Store chunks in Postgres for BM25 hybrid search
          let bm25Stored = 0;
          if (env.HYPERDRIVE) {
            try {
              const { storeChunksForBM25 } = await import("./runtime/rag-hybrid");
              bm25Stored = await storeChunksForBM25(env.HYPERDRIVE, vecInserts.map((v: any) => ({
                id: v.id,
                source: body.source || "api",
                pipeline: "text",
                org_id: body.org_id || "",
                agent_name: body.agent_name || "",
                chunk_index: v.metadata.chunk_index,
                chunk_type: v.metadata.chunk_type || "prose",
                text: v.metadata.text,
                context_prefix: "",
              })));
            } catch { /* BM25 is best-effort */ }
          }

          const r2Key = `rag/${body.org_id || "global"}/${body.source || "text"}-${Date.now()}.txt`;
          await env.STORAGE.put(r2Key, body.text, {
            customMetadata: { source: body.source || "api", org_id: body.org_id || "", agent_name: body.agent_name || "" },
          });

          return Response.json({ chunks: chunkTexts.length, vectors: vecInserts.length, bm25: bm25Stored, rejected, r2_key: r2Key });
        } catch (err: any) {
          return Response.json({ error: err.message }, { status: 500 });
        }
      }

      // /cf/rag/ingest-document — OCR-powered document ingestion pipeline
      // Accepts: multipart/form-data with file (PDF/image) OR JSON with { image_url, image_base64 }
      // Flow: upload → R2 → (PDF? render pages) → OCR (GPU, with fallback) → chunk → embed → Vectorize
      if (url.pathname === "/cf/rag/ingest-document" && request.method === "POST") {
        const ocrUrl = ((env as any).OCR_ENDPOINT_URL || "").trim();

        try {
          let fileBytes: ArrayBuffer | null = null;
          let fileName = "document";
          let mimeType = "application/octet-stream";
          let orgId = "";
          let agentName = "";
          let source = "";

          const ct = request.headers.get("Content-Type") || "";
          if (ct.includes("multipart/form-data")) {
            const form = await request.formData();
            const file = form.get("file") as File | null;
            if (!file) return Response.json({ error: "file field required" }, { status: 400 });
            fileBytes = await file.arrayBuffer();
            fileName = file.name || "document";
            mimeType = file.type || "application/octet-stream";
            orgId = String(form.get("org_id") || "");
            agentName = String(form.get("agent_name") || "");
            source = String(form.get("source") || fileName);
          } else {
            const body = await request.json() as {
              image_url?: string; image_base64?: string; mime_type?: string;
              org_id?: string; agent_name?: string; source?: string; file_name?: string;
            };
            if (body.image_base64) {
              const raw = body.image_base64.replace(/^data:[^;]+;base64,/, "");
              fileBytes = Uint8Array.from(atob(raw), c => c.charCodeAt(0)).buffer;
              mimeType = body.mime_type || "image/png";
            } else if (body.image_url) {
              // SSRF protection: validate URL before fetching
              const { validateUrl } = await import("./runtime/ssrf");
              const ssrfCheck = validateUrl(body.image_url);
              if (!ssrfCheck.valid) {
                return Response.json({ error: `Blocked URL (SSRF): ${ssrfCheck.reason}` }, { status: 403 });
              }
              const resp = await fetch(body.image_url);
              if (!resp.ok) return Response.json({ error: `Failed to fetch image: ${resp.status}` }, { status: 502 });
              fileBytes = await resp.arrayBuffer();
              mimeType = resp.headers.get("Content-Type") || "image/png";
            } else {
              return Response.json({ error: "file, image_url, or image_base64 required" }, { status: 400 });
            }
            orgId = body.org_id || "";
            agentName = body.agent_name || "";
            source = body.source || body.file_name || "document";
            fileName = body.file_name || "document";
          }

          // Step 1: Store raw file in R2
          const r2RawKey = `rag/${orgId || "global"}/${source}-${Date.now()}.raw`;
          await env.STORAGE.put(r2RawKey, fileBytes, {
            customMetadata: { source, org_id: orgId, agent_name: agentName, mime_type: mimeType, file_name: fileName },
          });

          // Step 2: Convert pages to images (PDF → render via sandbox, images → pass through)
          const isPdf = mimeType === "application/pdf" || fileName.toLowerCase().endsWith(".pdf");
          const pageImages: Array<{ base64: string; mimeType: string; page: number }> = [];

          // Safe base64 encoder for large buffers (avoids stack overflow from spread operator)
          function arrayBufferToBase64(buf: ArrayBuffer): string {
            const bytes = new Uint8Array(buf);
            let binary = "";
            const chunkSize = 8192;
            for (let i = 0; i < bytes.length; i += chunkSize) {
              const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
              for (let j = 0; j < chunk.length; j++) binary += String.fromCharCode(chunk[j]);
            }
            return btoa(binary);
          }

          if (isPdf) {
            const pdfB64 = arrayBufferToBase64(fileBytes);
            let rendered = false;

            // Primary: GPU box pdf.oneshots.co (fast, no cold start, no payload limits)
            const pdfRenderUrl = ((env as any).PDF_RENDER_URL || "https://pdf.oneshots.co").trim();
            try {
              const renderResp = await fetch(`${pdfRenderUrl}/render`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  ...((env as any).GPU_SERVICE_KEY || env.SERVICE_TOKEN ? { Authorization: `Bearer ${(env as any).GPU_SERVICE_KEY || env.SERVICE_TOKEN}` } : {}),
                },
                body: JSON.stringify({ pdf_base64: pdfB64, dpi: 150 }),
              });
              if (renderResp.ok) {
                const renderData = await renderResp.json() as { pages?: string[]; page_count?: number };
                if (renderData.pages?.length) {
                  for (let i = 0; i < renderData.pages.length; i++) {
                    pageImages.push({ base64: renderData.pages[i], mimeType: "image/png", page: i + 1 });
                  }
                  rendered = true;
                }
              }
            } catch { /* GPU box unreachable — fall through to sandbox */ }

            // Fallback: CF container sandbox with pypdfium2
            if (!rendered) {
              try {
                const sandboxId = `pdf-render-${Date.now()}`;
                const sandbox = getTimedSandbox(env.SANDBOX, sandboxId);
                await sandbox.writeFile("/tmp/_pdf.b64", pdfB64);
                const renderResult = await sandbox.exec([
                  `python3 -c "`,
                  `import pypdfium2, base64, json, io;`,
                  `pdf_bytes = base64.b64decode(open('/tmp/_pdf.b64').read().strip());`,
                  `pdf = pypdfium2.PdfDocument(pdf_bytes);`,
                  `pages = [];`,
                  `[pages.append(base64.b64encode((lambda buf: (pdf[i].render(scale=150/72).to_pil().save(buf, format='PNG'), buf)[1].getvalue())(io.BytesIO())).decode()) for i in range(min(len(pdf), 20))];`,
                  `print(json.dumps(pages))`,
                  `"`,
                ].join(""), { timeout: 60 });

                if (renderResult.exitCode === 0 && renderResult.stdout) {
                  const pngList = JSON.parse(String(renderResult.stdout).trim()) as string[];
                  for (let i = 0; i < pngList.length; i++) {
                    pageImages.push({ base64: pngList[i], mimeType: "image/png", page: i + 1 });
                  }
                  rendered = true;
                }
              } catch { /* sandbox also failed */ }
            }

            if (!rendered) {
              return Response.json({
                error: "PDF rendering failed — both GPU box (pdf.oneshots.co) and container sandbox unavailable.",
              }, { status: 422 });
            }
          } else {
            // Single image — pass through directly
            const imgB64 = arrayBufferToBase64(fileBytes);
            pageImages.push({ base64: imgB64, mimeType, page: 1 });
          }

          // Step 3: OCR each page with fallback chain: GLM-OCR → Gemma 4 31B → error
          // Self-hosted GPU box accepts GPU_SERVICE_KEY; SERVICE_TOKEN is only a dev fallback.
          const ocrServiceToken = (env as any).GPU_SERVICE_KEY || env.SERVICE_TOKEN || "";
          const allExtractedText: string[] = [];

          for (const page of pageImages) {
            let extractedText = "";
            const dataUrl = `data:${page.mimeType};base64,${page.base64}`;
            const ocrPrompt = "Extract all text from this document. Return the full text content preserving structure, headings, lists, and tables as markdown.";

            // Try GLM-OCR first (fast, specialized)
            if (ocrUrl) {
              try {
                const ocrResp = await fetch(`${ocrUrl}/v1/chat/completions`, {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    ...(ocrServiceToken ? { "Authorization": `Bearer ${ocrServiceToken}` } : {}),
                  },
                  body: JSON.stringify({
                    messages: [{
                      role: "user",
                      content: [
                        { type: "text", text: ocrPrompt },
                        { type: "image_url", image_url: { url: dataUrl } },
                      ],
                    }],
                    max_tokens: 4096,
                    temperature: 0.1,
                  }),
                });
                if (ocrResp.ok) {
                  const result = await ocrResp.json() as any;
                  extractedText = result?.choices?.[0]?.message?.content || "";
                }
              } catch { /* fall through to fallback */ }
            }

            // Fallback: Gemma 4 31B vision (slower but available)
            if (!extractedText.trim()) {
              const gemmaUrl = "https://gemma4.oneshots.co";
              try {
                const gemmaResp = await fetch(`${gemmaUrl}/v1/chat/completions`, {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    ...(ocrServiceToken ? { "Authorization": `Bearer ${ocrServiceToken}` } : {}),
                  },
                  body: JSON.stringify({
                    messages: [{
                      role: "user",
                      content: [
                        { type: "text", text: ocrPrompt },
                        { type: "image_url", image_url: { url: dataUrl } },
                      ],
                    }],
                    max_tokens: 4096,
                    temperature: 0.1,
                  }),
                });
                if (gemmaResp.ok) {
                  const result = await gemmaResp.json() as any;
                  extractedText = result?.choices?.[0]?.message?.content || "";
                }
              } catch { /* both OCR endpoints failed */ }
            }

            if (extractedText.trim()) {
              allExtractedText.push(page.page > 1 ? `\n---\n## Page ${page.page}\n\n${extractedText}` : extractedText);
            }
          }

          const fullText = allExtractedText.join("\n");
          if (!fullText.trim()) {
            return Response.json({ error: "OCR returned empty text from all pages — document may be blank or all OCR endpoints are down" }, { status: 422 });
          }

          // Step 4: Smart chunking with validation (rejects binary garbage, keeps structure)
          const { smartChunk, validateChunk } = await import("./runtime/rag-transforms");
          const rawChunks = smartChunk(fullText);
          const seenHashes = new Set<string>();
          const validChunks = rawChunks.filter(c => validateChunk(c.text, seenHashes).valid);
          const chunks = validChunks.map(c => c.text);

          if (chunks.length === 0) {
            return Response.json({ error: "All chunks failed validation", pages: pageImages.length }, { status: 422 });
          }

          // Step 5: Embed all chunks via Qwen3-Embedding (GPU box primary, Workers AI fallback)
          const { embed: embedOcrChunks } = await import("./runtime/embeddings");
          const ocrEmbedResult = await embedOcrChunks(chunks, env);
          const vectors = ocrEmbedResult.vectors;

          // Step 6: Upsert to Vectorize
          const vecInserts = vectors.map((vec: number[], idx: number) => ({
            id: `ocr-${source}-${Date.now()}-${idx}`,
            values: vec,
            metadata: {
              text: chunks[idx],
              source,
              pipeline: "ocr",
              org_id: orgId,
              chunk_type: validChunks[idx]?.type || "prose",
              agent_name: agentName,
              chunk_index: idx,
              ingested_at: new Date().toISOString(),
            },
          }));

          if (vecInserts.length > 0) {
            await env.VECTORIZE.upsert(vecInserts);
          }

          // Step 6b: Store chunks in Postgres for BM25 + generate contextual prefixes
          let bm25Stored = 0;
          if (env.HYPERDRIVE) {
            try {
              const { storeChunksForBM25, generateDocSummary, generateContextPrefix } = await import("./runtime/rag-hybrid");
              const llmUrl = "https://fast.oneshots.co";
              const authHdrs = env.SERVICE_TOKEN ? { Authorization: `Bearer ${env.SERVICE_TOKEN}` } : {};

              // Generate doc summary for contextual enrichment (one LLM call for the whole doc)
              const docSummary = await generateDocSummary(
                llmUrl,
                fullText,
                fileName,
                authHdrs as Record<string, string>,
              );

              // Generate context prefix per chunk (parallel, capped at 3 concurrent to avoid GPU slowdown)
              const chunkRecords: Array<{ id: string; source: string; pipeline: string; org_id: string; agent_name: string; chunk_index: number; chunk_type: string; text: string; context_prefix: string }> = [];
              const batchSize = 3;
              for (let b = 0; b < vecInserts.length; b += batchSize) {
                const batch = vecInserts.slice(b, b + batchSize);
                const prefixes = await Promise.all(
                  batch.map((v: any, bi: number) =>
                    generateContextPrefix(llmUrl, docSummary, v.metadata.text, b + bi + 1, authHdrs as Record<string, string>)
                      .catch(() => "")
                  )
                );
                for (let i = 0; i < batch.length; i++) {
                  chunkRecords.push({
                    id: batch[i].id,
                    source,
                    pipeline: "ocr",
                    org_id: orgId,
                    agent_name: agentName,
                    chunk_index: batch[i].metadata.chunk_index,
                    chunk_type: batch[i].metadata.chunk_type || "prose",
                    text: batch[i].metadata.text,
                    context_prefix: prefixes[i] || "",
                  });
                }
              }
              bm25Stored = await storeChunksForBM25(env.HYPERDRIVE, chunkRecords);
            } catch (err) {
              console.error(`[rag-hybrid] BM25+contextual store failed: ${err instanceof Error ? err.message : err}`);
            }
          }

          // Step 7: Store extracted text in R2
          const r2TextKey = `rag/${orgId || "global"}/${source}-${Date.now()}.md`;
          await env.STORAGE.put(r2TextKey, fullText, {
            customMetadata: { source, org_id: orgId, agent_name: agentName, pipeline: "ocr", file_name: fileName },
          });

          return Response.json({
            source,
            file_name: fileName,
            pages: pageImages.length,
            extracted_text_length: fullText.length,
            chunks: chunks.length,
            vectors: vecInserts.length,
            r2_raw_key: r2RawKey,
            r2_text_key: r2TextKey,
          });
        } catch (err: any) {
          return Response.json({ error: err.message }, { status: 500 });
        }
      }

      // ── Auth gate for /cf/storage/* — require SERVICE_TOKEN ──────────
      if (url.pathname.startsWith("/cf/storage/")) {
        const authHeader = request.headers.get("Authorization") || "";
        const serviceToken = String(env.SERVICE_TOKEN || "");
        if (!serviceToken || !authHeader.includes(serviceToken)) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }
        // Validate that the key contains an org scope (prevent unscoped access)
        const key = url.searchParams.get("key") || "";
        if (key && !key.includes("/")) {
          return Response.json({ error: "Key must be scoped (contain at least one /)" }, { status: 400 });
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
          const { embedForQuery: embedAgent } = await import("./runtime/embeddings");
          const embResult = await embedAgent(agentName, env);
          const queryVec = embResult.vector;
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
              const sandbox = getTimedSandbox(env.SANDBOX, sandboxId);
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
              const sandbox = getTimedSandbox(env.SANDBOX, sandboxId);
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
              const sandbox = getTimedSandbox(env.SANDBOX, sandboxId);
              const execResult = await sandbox.exec(`cat -n "${path}" 2>&1 | head -2000`, { timeout: 10 });
              result = execResult.stdout || execResult.stderr || "File not found or empty";
              break;
            }

            case "write-file": {
              const path = args.path || "";
              const content = args.content || "";
              const sandboxId = `session-${session_id || "default"}`;
              const sandbox = getTimedSandbox(env.SANDBOX, sandboxId);
              await sandbox.writeFile(path, content);
              result = `Written ${content.length} bytes to ${path}`;
              break;
            }

            case "edit-file": {
              const path = args.path || "";
              const oldText = args.old_text || args.old_string || "";
              const newText = args.new_text || args.new_string || "";
              const sandboxId = `session-${session_id || "default"}`;
              const sandbox = getTimedSandbox(env.SANDBOX, sandboxId);
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
              const sandbox = getTimedSandbox(env.SANDBOX, sandboxId);
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
              const sandbox = getTimedSandbox(env.SANDBOX, sandboxId);
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
              const sandbox = getTimedSandbox(env.SANDBOX, sandboxId);
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
              const sandbox = getTimedSandbox(env.SANDBOX, sandboxId);
              await sandbox.writeFile(args.path || "/tmp/file", args.content || "");
              result = `Written to ${args.path}`;
              break;
            }

            case "sandbox_file_read": {
              const sandboxId = `session-${session_id || args.sandbox_id || "default"}`;
              const sandbox = getTimedSandbox(env.SANDBOX, sandboxId);
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
              const sandbox = getTimedSandbox(env.SANDBOX, sandboxId);
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
              const sandbox = getTimedSandbox(env.SANDBOX, sandboxId);
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
                  const sandbox = getTimedSandbox(env.SANDBOX, sandboxId);
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
                const sandbox = getTimedSandbox(env.SANDBOX, sandboxId);
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
                const { embedSingle: embedKnowledge } = await import("./runtime/embeddings");
                const embResult = await embedKnowledge(text, env);
                await env.VECTORIZE.upsert([{
                  id: `knowledge-${Date.now()}`,
                  values: embResult.vector,
                  metadata: { text, source: key, agent_name: args.agent_name || "", org_id: args.org_id || "" },
                }]);
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
                const { embedForQuery: embedKnowledgeQuery } = await import("./runtime/embeddings");
                const embResult = await embedKnowledgeQuery(query, env);
                const queryVec = embResult.vector;
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
                result = `Image gen failed: ${err.message}`;
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
                const sandbox = getTimedSandbox(env.SANDBOX, sandboxId);
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
              const sandbox = getTimedSandbox(env.SANDBOX, sandboxId);
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
  // At-least-once delivery. Per-message ack/retry. Permanent failures acked to avoid poison loops.
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    const queueName = String((batch as any).queue || "");
    const isSignalBatch = queueName === "agentos-signals";
    // ── Helpers ──
    /** Safe JSON parse — never throws, returns fallback on malformed input */
    function jp(input: unknown, fallback: any = {}): any {
      if (input == null) return fallback;
      if (typeof input !== "string") return input; // already parsed
      try { return JSON.parse(input); } catch { return fallback; }
    }
    /** Resolve created_at from various formats */
    function ts(v: unknown): string {
      if (!v) return new Date().toISOString();
      if (typeof v === "string" && v.includes("T")) return v;
      const n = Number(v);
      return n > 1e12 ? new Date(n).toISOString() // ms epoch
        : n > 1e9 ? new Date(n * 1000).toISOString() // s epoch
        : new Date().toISOString();
    }
    /** Classify DB errors: permanent (schema/constraint) vs transient (connection/timeout) */
    function isPermanent(err: any): boolean {
      const m = err?.message || "";
      // FK violation, NOT NULL, check constraint, unique violation, column doesn't exist,
      // data type mismatch, syntax error — retrying will never fix these
      return /violates (foreign key|not-null|check|unique)|does not exist|invalid input syntax|column.*of relation/i.test(m);
    }
    /** Retry with exponential backoff capped at 5 min */
    function retryWithBackoff(msg: any) {
      const delay = Math.min(30 * Math.pow(2, (msg.attempts || 1) - 1), 300);
      msg.retry({ delaySeconds: delay });
    }

    const KNOWN_TYPES = new Set([
      "session", "turn", "episode", "event",
      "runtime_event", "middleware_event", "billing_flush",
      "skill_activation", "skill_auto_activation", "loop_detected", "do_eviction",
      "artifact_manifest", "signal_envelope",
    ]);
    const messagesNeedDb = batch.messages.some((msg) => {
      const body = (msg.body || {}) as Record<string, unknown>;
      const type = String(body.type || "");
      return !isSignalBatch && type && type !== "signal_envelope";
    });
    if (messagesNeedDb && !env.HYPERDRIVE) {
      batch.retryAll();
      return;
    }

    const flagCache = new Map<string, Promise<{ substrate: boolean; passiveMemory: boolean }>>();
    async function getSignalFlags(orgId: string): Promise<{ substrate: boolean; passiveMemory: boolean }> {
      const key = orgId || "global";
      if (!flagCache.has(key)) {
        flagCache.set(key, (async () => ({
          substrate: await isEnabled(env as any, "signal_substrate_enabled", orgId),
          passiveMemory: await isEnabled(env as any, "memory_passive_signals_enabled", orgId),
        }))());
      }
      return flagCache.get(key)!;
    }

    async function emitSignalDrop(
      eventType: "signal_envelope_dropped",
      p: Record<string, any>,
      details: Record<string, unknown>,
    ): Promise<void> {
      await env.TELEMETRY_QUEUE?.send?.({
        type: "runtime_event",
        payload: {
          event_type: eventType,
          org_id: p.org_id || "",
          agent_name: p.agent_name || "",
          session_id: p.session_id || "",
          node_id: "signal-ingestion",
          status: "dropped",
          duration_ms: 0,
          created_at: Date.now(),
          details,
        },
      }).catch(() => {});
    }

    async function fanOutSignals(type: string, p: Record<string, any>): Promise<void> {
      if (!env.SIGNAL_QUEUE) return;
      const orgId = String(p.org_id || "").trim();
      const flags = await getSignalFlags(orgId);
      if (!flags.substrate) return;
      const envelopes = deriveSignalEnvelopes(type, p).filter((envelope) => {
        if (envelope.feature !== "memory") return true;
        return flags.passiveMemory;
      });
      if (!envelopes.length) return;
      // Send in parallel — avoids serial ~10ms/send penalty with 3-4 envelopes per turn
      await Promise.all(envelopes.map((envelope) =>
        env.SIGNAL_QUEUE!.send(signalEnvelopeMessage(envelope)),
      ));
    }

    async function ingestSignalEnvelope(envelope: SignalEnvelope): Promise<void> {
      if (!env.SIGNAL_COORDINATOR) return;
      const doName = buildSignalCoordinatorKey(envelope.feature, envelope.org_id, envelope.agent_name);
      const doId = (env.SIGNAL_COORDINATOR as any).idFromName(doName);
      const stub = (env.SIGNAL_COORDINATOR as any).get(doId);
      await (stub as any).ingest(envelope);
    }

    let sql: any = null;
    const tableColumns = new Map<string, Set<string>>();
    if (messagesNeedDb) {
      const postgres = (await import("postgres")).default;
      sql = postgres(env.HYPERDRIVE.connectionString, {
        max: 5,
        fetch_types: false,
        prepare: false,  // Hyperdrive requires prepare:false (transaction-mode pooling)
        idle_timeout: 20,
        connect_timeout: 10,
      });
      try {
        const schemaRows = await sql<{ table_name: string; column_name: string }[]>`
          SELECT table_name, column_name
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name IN ('otel_events', 'runtime_events')
        `;
        for (const row of schemaRows) {
          if (!tableColumns.has(row.table_name)) tableColumns.set(row.table_name, new Set<string>());
          tableColumns.get(row.table_name)!.add(String(row.column_name || ""));
        }
      } catch (schemaErr: any) {
        console.warn("[queue] schema introspection failed:", schemaErr?.message || String(schemaErr));
      }
    }
    const otelCols = tableColumns.get("otel_events") || new Set<string>();
    const runtimeCols = tableColumns.get("runtime_events") || new Set<string>();
    const otelUsesEventData = otelCols.has("event_data");
    const runtimeUsesEventData = runtimeCols.has("event_data");

    try {
      for (const msg of batch.messages) {
        const body = (msg.body || {}) as Record<string, unknown>;
        const type = String(body.type || "");
        const p = getQueuePayload(body) as Record<string, any>;

        // Unknown message types — ack to prevent infinite retry, log for investigation
        if (!type || !KNOWN_TYPES.has(type)) {
          console.warn(`[queue] unknown message type="${type}" — acking to prevent poison loop`);
          msg.ack();
          continue;
        }

        try {
          if (type === "signal_envelope") {
            await ingestSignalEnvelope(p as SignalEnvelope);
            msg.ack();
            continue;
          }
          if (isSignalBatch) {
            console.warn(`[queue] unexpected type="${type}" on signal queue — acking`);
            msg.ack();
            continue;
          }

          // Set RLS org context per message (scoped to this transaction via SET LOCAL)
          const msgOrgId = String(p.org_id || "").trim();
          if (msgOrgId && sql) {
            await sql.unsafe(`SELECT set_config('app.current_org_id', $1, true)`, [msgOrgId]);
          }

          if (type === "session") {
            // sessions.org_id has FK → orgs(org_id). Empty string violates it.
            // If org_id is missing/empty, skip the insert — the direct write path (DO) handles it.
            if (!p.session_id) { msg.ack(); continue; }
            if (!p.org_id) {
              console.warn(`[queue] session ${p.session_id} has no org_id — skipping (FK would fail)`);
              msg.ack();
              continue;
            }
            await sql`INSERT INTO sessions (
              session_id, org_id, project_id, agent_name, status,
              input_text, output_text, model, trace_id, parent_session_id,
              depth, step_count, action_count, wall_clock_seconds,
              cost_total_usd,
              detailed_cost, feature_flags,
              total_cache_read_tokens, total_cache_write_tokens,
              repair_count, compaction_count,
              termination_reason,
              created_at
            ) VALUES (
              ${p.session_id}, ${p.org_id}, ${p.project_id || ""},
              ${p.agent_name || "agentos"}, ${p.status || "success"},
              ${p.input_text || ""}, ${p.output_text || ""},
              ${p.model || ""}, ${p.trace_id || ""}, ${p.parent_session_id || ""},
              ${p.depth || 0}, ${p.step_count || 0}, ${p.action_count || 0},
              ${p.wall_clock_seconds || 0}, ${p.cost_total_usd || 0},
              ${jp(p.detailed_cost, null)},
              ${jp(p.feature_flags, null)},
              ${p.total_cache_read_tokens || 0}, ${p.total_cache_write_tokens || 0},
              ${p.repair_count || 0}, ${p.compaction_count || 0},
              ${p.termination_reason || null},
              ${ts(p.created_at)}
            ) ON CONFLICT (session_id) DO UPDATE SET
              status = EXCLUDED.status, output_text = EXCLUDED.output_text,
              cost_total_usd = EXCLUDED.cost_total_usd, step_count = EXCLUDED.step_count,
              action_count = EXCLUDED.action_count, wall_clock_seconds = EXCLUDED.wall_clock_seconds,
              detailed_cost = COALESCE(EXCLUDED.detailed_cost, sessions.detailed_cost),
              total_cache_read_tokens = EXCLUDED.total_cache_read_tokens,
              total_cache_write_tokens = EXCLUDED.total_cache_write_tokens,
              repair_count = EXCLUDED.repair_count, compaction_count = EXCLUDED.compaction_count,
              termination_reason = COALESCE(EXCLUDED.termination_reason, sessions.termination_reason)`;

          } else if (type === "turn") {
            if (!p.session_id) { msg.ack(); continue; }
            let queueDelayMs = 0;
            if (p.created_at !== undefined && p.created_at !== null) {
              const parsedMs = typeof p.created_at === "number"
                ? Number(p.created_at)
                : Date.parse(String(p.created_at));
              if (Number.isFinite(parsedMs)) {
                queueDelayMs = Math.max(0, Date.now() - parsedMs);
              }
            }
            // plan and reflection are NOT NULL DEFAULT '{}' — never pass null
            await sql`INSERT INTO turns (
              session_id, turn_number, model_used, input_tokens, output_tokens,
              latency_ms, llm_latency_ms, ttft_ms, pre_llm_ms, tool_exec_ms,
              llm_retry_count, llm_cost_usd, tool_cost_usd, tokens_per_sec, queue_delay_ms,
              compaction_triggered, messages_dropped,
              output_text, cost_usd,
              tool_calls, tool_results, errors,
              execution_mode, plan, reflection,
              stop_reason, refusal, cache_read_tokens, cache_write_tokens,
              gateway_log_id
            ) VALUES (
              ${p.session_id}, ${p.turn_number || 0}, ${p.model_used || ""},
              ${p.input_tokens || 0}, ${p.output_tokens || 0},
              ${p.latency_ms || 0}, ${p.llm_latency_ms || p.latency_ms || 0},
              ${p.ttft_ms ?? null},
              ${p.pre_llm_ms ?? null}, ${p.tool_exec_ms ?? null},
              ${p.llm_retry_count || 0},
              ${p.llm_cost_usd || 0}, ${p.tool_cost_usd || 0},
              ${p.tokens_per_sec ?? null}, ${queueDelayMs},
              ${Boolean(p.compaction_triggered)}, ${p.messages_dropped || 0},
              ${p.llm_content || p.output_text || ""}, ${p.cost_total_usd || p.cost_usd || 0},
              ${jp(p.tool_calls, [])},
              ${jp(p.tool_results, [])},
              ${jp(p.errors, [])},
              ${p.execution_mode || "sequential"},
              ${jp(p.plan_artifact || p.plan, {})},
              ${jp(p.reflection || p.reflection, {})},
              ${p.stop_reason || "end_turn"}, ${p.refusal || false},
              ${p.cache_read_tokens || 0}, ${p.cache_write_tokens || 0},
              ${p.gateway_log_id || null}
            ) ON CONFLICT (session_id, turn_number) DO UPDATE SET
              cost_usd = EXCLUDED.cost_usd,
              input_tokens = EXCLUDED.input_tokens,
              output_tokens = EXCLUDED.output_tokens,
              ttft_ms = EXCLUDED.ttft_ms,
              pre_llm_ms = EXCLUDED.pre_llm_ms,
              tool_exec_ms = EXCLUDED.tool_exec_ms,
              llm_retry_count = EXCLUDED.llm_retry_count,
              llm_cost_usd = EXCLUDED.llm_cost_usd,
              tool_cost_usd = EXCLUDED.tool_cost_usd,
              tokens_per_sec = EXCLUDED.tokens_per_sec,
              queue_delay_ms = EXCLUDED.queue_delay_ms,
              compaction_triggered = EXCLUDED.compaction_triggered,
              messages_dropped = EXCLUDED.messages_dropped,
              tool_calls = EXCLUDED.tool_calls,
              tool_results = EXCLUDED.tool_results`;

          } else if (type === "episode") {
            await sql`INSERT INTO episodes (org_id, agent_name, session_id, title, summary, content, source, created_at)
              VALUES (${p.org_id || ""}, ${p.agent_name || ""}, ${p.session_id || ""},
                      ${p.title || "Session episode"}, ${p.summary || p.input || ""},
                      ${p.content || p.output || ""}, ${"queue"}, ${ts(p.created_at)})`;

          } else if (type === "event") {
            if (otelUsesEventData) {
              const eventData = {
                ...(jp(p.details, {}) || {}),
                session_id: p.session_id || "",
                trace_id: p.trace_id || "",
                turn: Number(p.turn || 0),
                action: p.action || "",
                plan: p.plan || "",
                tier: p.tier || "",
                provider: p.provider || "",
                model: p.model || "",
                tool_name: p.tool_name || "",
                status: p.status || "",
                latency_ms: Number(p.latency_ms || 0),
                source: p.source || "queue_event",
              };
              await sql`INSERT INTO otel_events (
                org_id, agent_name, session_id, trace_id, event_type, event_data, created_at
              ) VALUES (
                ${p.org_id || ""}, ${p.agent_name || ""}, ${p.session_id || ""},
                ${p.trace_id || ""}, ${p.event_type || ""}, ${jp(eventData, {})},
                ${ts(p.created_at)}
              )`;
            } else {
              await sql`INSERT INTO otel_events (
                org_id, agent_name, session_id, trace_id, event_type, event_data, created_at
              ) VALUES (
                ${p.org_id || ""}, ${p.agent_name || ""}, ${p.session_id || ""},
                ${p.trace_id || ""}, ${p.event_type || ""},
                ${jp({
                  turn: p.turn || 0, action: p.action || "", plan: p.plan || "",
                  tier: p.tier || "", provider: p.provider || "", model: p.model || "",
                  tool_name: p.tool_name || "", status: p.status || "",
                  latency_ms: p.latency_ms || 0, ...jp(p.details, {}),
                }, {})},
                ${ts(p.created_at)}
              )`;
            }

          } else if (type === "runtime_event") {
            if (runtimeUsesEventData) {
              const eventData = {
                ...(jp(p.details, {}) || {}),
                trace_id: p.trace_id || "",
                session_id: p.session_id || "",
                node_id: p.node_id || "",
                status: p.status || "",
                duration_ms: Number(p.duration_ms || 0),
                source: p.source || "queue_runtime_event",
              };
              await sql`INSERT INTO runtime_events (
                org_id, agent_name, event_type, event_data, created_at
              ) VALUES (
                ${p.org_id || ""}, ${p.agent_name || ""}, ${p.event_type || ""},
                ${jp(eventData, {})}, ${ts(p.created_at)}
              )`;
            } else {
              await sql`INSERT INTO runtime_events (
                org_id, agent_name, event_type, event_data, created_at
              ) VALUES (
                ${p.org_id || ""}, ${p.agent_name || ""}, ${p.event_type || ""},
                ${jp({
                  trace_id: p.trace_id || "", session_id: p.session_id || "",
                  node_id: p.node_id || "", status: p.status || "",
                  duration_ms: Number(p.duration_ms || 0), ...jp(p.details, {}),
                }, {})},
                ${ts(p.created_at)}
              )`;
            }

          } else if (type === "middleware_event") {
            await sql`INSERT INTO middleware_events (
              org_id, agent_name, middleware_name, event_type,
              payload, created_at
            ) VALUES (
              ${p.org_id || ""}, ${p.agent_name || ""},
              ${p.middleware_name || ""},
              ${p.event_type || p.action || ""},
              ${jp({ session_id: p.session_id, turn_number: p.turn_number || p.turn, ...jp(p.details, {}) }, {})},
              ${ts(p.created_at)}
            )`;

          } else if (type === "billing_flush") {
            if (p.session_id && p.cost_usd) {
              await sql`UPDATE sessions SET cost_total_usd = GREATEST(cost_total_usd, ${p.cost_usd}),
                step_count = GREATEST(step_count, ${p.turns || 0})
                WHERE session_id = ${p.session_id}`;
            }

          } else if (type === "skill_activation" || type === "skill_auto_activation") {
            await sql`INSERT INTO audit_log (org_id, actor_id, action, resource_type, resource_name, details, created_at)
              VALUES (${p.org_id || ""}, 'system', ${type}, 'skill', ${p.skill || ""},
                ${JSON.stringify({ session_id: p.session_id, agent_name: p.agent_name, trigger: p.trigger || (type === "skill_auto_activation" ? "auto" : "user") })}::jsonb, now())
            `;

          } else if (type === "loop_detected") {
            await sql`INSERT INTO audit_log (org_id, actor_id, action, resource_type, resource_name, details, created_at)
              VALUES (${p.org_id || ""}, 'system', 'loop_detected', 'session', ${p.session_id || ""},
                ${JSON.stringify({ tool: p.tool, repeat_count: p.repeat_count, turn: p.turn, agent_name: p.agent_name })}::jsonb, now())
            `;

          } else if (type === "do_eviction") {
            console.log(`[telemetry] DO eviction: session=${p.session_id} org=${p.org_id}`);
            if (runtimeUsesEventData) {
              await sql`INSERT INTO runtime_events (
                org_id, agent_name, event_type, event_data, created_at
              ) VALUES (
                ${p.org_id || ""}, ${p.agent_name || ""}, ${"do_eviction" satisfies RuntimeEventType},
                ${jp({
                  trace_id: p.trace_id || "",
                  session_id: p.session_id || "",
                  status: "evicted",
                  duration_ms: Number(p.uptime_ms || 0),
                  turns: p.turns || 0,
                  cost_usd: p.cost_usd || 0,
                  reason: p.reason || "unknown",
                  source: p.source || "queue_do_eviction",
                }, {})},
                ${new Date().toISOString()}
              )`;
            } else {
              await sql`INSERT INTO runtime_events (
                org_id, agent_name, event_type, event_data, created_at
              ) VALUES (
                ${p.org_id || ""}, ${p.agent_name || ""}, 'do_eviction',
                ${jp({
                  trace_id: p.trace_id || "", session_id: p.session_id || "",
                  status: "evicted", duration_ms: Number(p.uptime_ms || 0),
                  turns: p.turns || 0, cost_usd: p.cost_usd || 0,
                  reason: p.reason || "unknown",
                }, {})},
                ${new Date().toISOString()}
              )`;
            }
          } else if (type === "artifact_manifest") {
            if (!p.session_id || !p.artifact_name) { msg.ack(); continue; }
            await sql`INSERT INTO run_artifacts (
              session_id, org_id, agent_name, turn_number,
              artifact_name, artifact_kind, mime_type, size_bytes,
              storage_key, source_tool, source_event, schema_version,
              status, metadata, created_at
            ) VALUES (
              ${p.session_id || ""}, ${p.org_id || ""}, ${p.agent_name || ""},
              ${Number(p.turn_number || 0)},
              ${p.artifact_name || "artifact"}, ${p.artifact_kind || "generic"},
              ${p.mime_type || "application/octet-stream"}, ${Number(p.size_bytes || 0)},
              ${p.storage_key || ""}, ${p.source_tool || ""}, ${p.source_event || ""},
              ${p.schema_version || null}, ${p.status || "available"},
              ${jp(p.metadata, {})}, ${ts(p.created_at)}
            ) ON CONFLICT (session_id, artifact_name, storage_key) DO UPDATE SET
              status = EXCLUDED.status,
              metadata = COALESCE(EXCLUDED.metadata, run_artifacts.metadata),
              size_bytes = GREATEST(COALESCE(run_artifacts.size_bytes, 0), COALESCE(EXCLUDED.size_bytes, 0)),
              updated_at = now()`;
          }
          if (!isSignalBatch) {
            try {
              await fanOutSignals(type, p);
            } catch (signalErr: any) {
              await emitSignalDrop("signal_envelope_dropped", p, {
                source_type: type,
                reason: signalErr?.message || String(signalErr),
              });
            }
          }
          msg.ack();
        } catch (err: any) {
          const errMsg = err?.message || String(err);
          if (isPermanent(err)) {
            // Schema/constraint errors will never self-heal — ack to prevent poison loop
            console.error(`[queue] PERMANENT FAILURE type=${type} session=${p?.session_id || '?'}: ${errMsg.slice(0, 300)}`);
            msg.ack();
          } else {
            // Transient errors (connection, timeout) — retry with backoff
            console.error(`[queue] TRANSIENT FAILURE type=${type} session=${p?.session_id || '?'} attempt=${msg.attempts}: ${errMsg.slice(0, 200)}`);
            retryWithBackoff(msg);
          }
        }
      }
    } finally {
      if (sql) {
        try { await sql.end(); } catch (e) {
          console.error("[queue] sql.end() failed:", e instanceof Error ? e.message : e);
        }
      }
    }
  },

  // ── Email handler — route inbound emails to the target agent DO ──
  // Uses SDK auto-reply detection to prevent infinite loops, then resolves
  // agent via address-based sub-addressing (e.g. support-bot.d8ec4cf7@oneshots.co).
  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
    // SDK safety: reject auto-reply emails (OOO, vacation, mailing-list bounces)
    if (isAutoReplyEmail(message.headers)) {
      console.log(`[email] Skipping auto-reply from ${message.from}`);
      return;
    }

    // Parse agent name from email address: {agent_name}.{org_short}@oneshots.co
    // SDK's createAddressBasedEmailResolver uses sub-addressing, but we need
    // the dot-based org hint pattern, so we keep custom parsing here.
    const toAddress = message.to;
    const localPart = toAddress.split("@")[0].toLowerCase().replace(/[^a-z0-9.-]/g, "");

    const dotIdx = localPart.lastIndexOf(".");
    const hasOrgHint = dotIdx > 0 && localPart.length - dotIdx <= 9;
    const agentName = hasOrgHint ? localPart.slice(0, dotIdx) : localPart;
    const orgHint = hasOrgHint ? localPart.slice(dotIdx + 1) : "";

    let orgId = "";
    try {
      const { getDb } = await import("./runtime/db");
      const sql = await getDb(env.HYPERDRIVE);
      let rows: any[] = [];
      if (orgHint) {
        rows = await sql`SELECT org_id FROM agents WHERE name = ${agentName} AND org_id LIKE ${"%" + orgHint} AND is_active = true LIMIT 1`;
      }
      if (!rows.length) {
        rows = await sql`SELECT org_id FROM agents WHERE name = ${agentName} AND is_active = true LIMIT 1`;
      }
      orgId = rows[0]?.org_id || "";
    } catch {}

    const orgPrefix = orgId ? `${orgId}-` : "";

    console.log(`[email] Routing email from ${message.from} to agent "${agentName}" org="${orgId}"`);

    try {
      // Get or create the agent DO instance — prefix with org_id to prevent cross-org collision
      const doName = `${orgPrefix}${agentName}`;
      const agentId = env.AGENTOS_AGENT.idFromName(doName);
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

  // ── Cron: prune idle pooled Browser Rendering sessions ───────────
  async scheduled(_event: ScheduledController, _env: Env, _ctx: ExecutionContext): Promise<void> {
    const { pruneStaleBrowserSessions } = await import("./runtime/tools");
    pruneStaleBrowserSessions();

    // Replay failed billing records from KV dead-letter queue
    if (_env.AGENT_PROGRESS_KV && _env.HYPERDRIVE) {
      try {
        const { replayBillingDLQ } = await import("./runtime/db");
        await replayBillingDLQ(_env.HYPERDRIVE, _env.AGENT_PROGRESS_KV);
      } catch (err) {
        console.error("[scheduled] billing DLQ replay failed:", err);
      }
    }
  },
} satisfies ExportedHandler<Env>;
