/**
 * Edge Runtime — tool executor with circuit breaker protection.
 *
 * Dispatches tool calls to CF bindings directly (no HTTP hop to /cf/tool/exec).
 * Same tool set as the worker's /cf/tool/exec switch, but callable in-process.
 * 
 * Circuit breaker pattern prevents cascading failures when external tools degrade.
 */

import { getSandbox } from "@cloudflare/sandbox";
import type { ToolCall, ToolResult, ToolDefinition, RuntimeEnv } from "./types";
import { validateUrl as ssrfValidateUrl } from "./ssrf";
import { scratchWrite, scratchRead, scratchList } from "./scratch";
import { retrieveToolResult, cleanupSessionResults } from "./result-storage";
import { writeToMailbox } from "./mailbox";
import { ToolError, CircuitBreakerError, classifyFetchError } from "./errors";
import { createChildAbortController, createSiblingGroup } from "./abort";
import { parseJsonColumn } from "./parse-json-column";
import { uint8ArrayToBase64 } from "./binary-enc";

const MAX_SANDBOX_TIMEOUT_SECONDS = 300; // 5 min — npm install/build on basic instance needs time
const DEFAULT_SANDBOX_TIMEOUT_SECONDS = 30;
const TOOL_FETCH_TIMEOUT_MS = 30_000; // 30s max for external API calls (must complete before 90s Workflow idle limit)

/** Fetch with AbortSignal timeout — prevents tool calls from hanging indefinitely */
function fetchWithTimeout(url: string | URL, init?: RequestInit, timeoutMs = TOOL_FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}
const DEFAULT_SANDBOX_MEMORY_LIMIT_MB = 512;

// ── Browser session reuse (per Worker isolate, keyed by workflow/session id) ──
const BROWSER_IDLE_MS = 120_000;
const BROWSER_POOL_MAX = 32;
type PooledBrowser = { browser: any; lastUsed: number };
const browserPool = new Map<string, PooledBrowser>();
const browserOpChains = new Map<string, Promise<unknown>>();

function pruneBrowserPoolIfNeeded(): void {
  if (browserPool.size <= BROWSER_POOL_MAX) return;
  const entries = [...browserPool.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
  const victim = entries[0];
  if (victim) {
    const [key, v] = victim;
    browserPool.delete(key);
    void v.browser?.close?.().catch(() => {});
  }
}

async function getPooledBrowser(env: RuntimeEnv, sessionKey: string): Promise<any> {
  const now = Date.now();
  const hit = browserPool.get(sessionKey);
  if (hit?.browser && now - hit.lastUsed < BROWSER_IDLE_MS) {
    hit.lastUsed = now;
    return hit.browser;
  }
  if (hit?.browser) {
    try {
      await hit.browser.close();
    } catch {}
    browserPool.delete(sessionKey);
  }
  pruneBrowserPoolIfNeeded();
  const puppeteer = await import("@cloudflare/puppeteer");
  const browser = await puppeteer.default.launch(env.BROWSER);
  browserPool.set(sessionKey, { browser, lastUsed: now });
  return browser;
}

/** Close pooled browser for a session (workflow cleanup). */
export function evictBrowserPoolEntry(sessionKey: string): void {
  const hit = browserPool.get(sessionKey);
  if (!hit) return;
  browserPool.delete(sessionKey);
  void hit.browser?.close?.().catch(() => {});
}

/** Drop idle browsers (cron / scheduled). */
export function pruneStaleBrowserSessions(): void {
  const now = Date.now();
  for (const [key, v] of [...browserPool.entries()]) {
    if (now - v.lastUsed > BROWSER_IDLE_MS) {
      browserPool.delete(key);
      void v.browser?.close?.().catch(() => {});
    }
  }
}

/** Serialize Puppeteer use per session to avoid races on shared browser. */
function runBrowserSerialized<T>(sessionKey: string, fn: () => Promise<T>): Promise<T> {
  const prev = browserOpChains.get(sessionKey) || Promise.resolve();
  const run = prev.then(() => fn());
  browserOpChains.set(
    sessionKey,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

function browserSessionKey(env: RuntimeEnv | undefined, sessionId: string | undefined): string {
  return String(env?.DO_SESSION_ID || sessionId || "anon");
}

/* ── Per-session tool rate limiter (bounded, LRU eviction) ────── */
const RATE_LIMIT_MAX_ENTRIES = 2000;
const toolRateLimits = new Map<string, number>();

function checkToolRateLimit(toolName: string, sessionId: unknown, maxCalls: number): boolean {
  const key = `${toolName}:${sessionId || "unknown"}`;
  const count = toolRateLimits.get(key) ?? 0;
  if (count >= maxCalls) return true; // rate limited
  toolRateLimits.set(key, count + 1);
  // LRU eviction: if map grows too large, delete oldest 25%
  if (toolRateLimits.size > RATE_LIMIT_MAX_ENTRIES) {
    const keys = [...toolRateLimits.keys()];
    const toRemove = Math.floor(keys.length / 4);
    for (let i = 0; i < toRemove; i++) toolRateLimits.delete(keys[i]);
  }
  return false;
}
// Phase 10.5: Per-session file mtime cache for staleness detection
// Tracks last-known mtime per file path to detect concurrent modifications
const FILE_STATE_CACHE_MAX = 1000;
const fileStateCache = new Map<string, string>();
function fileStateCacheSet(key: string, value: string) {
  if (fileStateCache.size >= FILE_STATE_CACHE_MAX) {
    const firstKey = fileStateCache.keys().next().value;
    if (firstKey !== undefined) fileStateCache.delete(firstKey);
  }
  fileStateCache.set(key, value);
}

const DYNAMIC_WORKER_CACHE_LIMIT = 32;
const DYNAMIC_WORKER_CACHE_TTL_MS = 5 * 60_000;
type DynamicWorkerCacheEntry = { worker: any; expiresAt: number };
const dynamicWorkerCache = new Map<string, DynamicWorkerCacheEntry>();

function extractPythonImportCandidates(code: string): string[] {
  if (!code || typeof code !== "string") return [];
  const modules = new Set<string>();
  const lines = code.split("\n");
  for (const raw of lines) {
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

async function checkMissingPythonModules(
  env: RuntimeEnv,
  sessionId: string,
  modules: string[],
): Promise<string[]> {
  if (modules.length === 0) return [];
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
  const result = await sandboxExecWithLimits(env, sessionId, command, 12);
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

async function hashCode(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .slice(0, 16)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function clampSandboxTimeout(timeoutSeconds?: number): number {
  const fallback = Number.isFinite(timeoutSeconds) ? Number(timeoutSeconds) : DEFAULT_SANDBOX_TIMEOUT_SECONDS;
  return Math.max(1, Math.min(Math.ceil(fallback), MAX_SANDBOX_TIMEOUT_SECONDS));
}

/** Max time (ms) to wait for a container to become available before giving up. */
const SANDBOX_ACQUIRE_TIMEOUT_MS = 30_000;

/**
 * Race a promise against a timeout. Rejects with a user-friendly capacity
 * error if the timeout fires first.
 */
function withSandboxTimeout<T>(promise: Promise<T>, sandboxId: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(
        `Sandbox unavailable — no container could be allocated within 30 seconds. ` +
        `This usually means all sandbox capacity is in use. Please try again in a moment. ` +
        `(sandbox: ${sandboxId})`
      ));
    }, SANDBOX_ACQUIRE_TIMEOUT_MS);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/**
 * Get a sandbox instance with a cold-start guard.
 * Wraps exec() and writeFile() so they never hang indefinitely — if the
 * container takes more than 30s to start, the call rejects instead of blocking
 * the entire DO request.
 */
// Track which sandbox IDs have been initialized (warm) in this isolate lifetime
const _warmSandboxes = new Set<string>();

function getSafeSandbox(env: RuntimeEnv, sandboxId: string) {
  // getSandbox returns immediately — container only starts on first operation.
  // Same sandboxId = same container = warm after first call.
  // Per CF Containers docs: https://developers.cloudflare.com/containers/
  const raw = getSandbox(env.SANDBOX, sandboxId, {
    sleepAfter: "30m",
    // Internet enabled: sandbox needs network for npm install, pip install, git clone, etc.
    // Security is provided by: VM isolation (each container is its own VM per CF docs),
    // SSRF protection (blocked private IPs/metadata endpoints in validateUrl),
    // and ephemeral disk (no persistent secrets to exfiltrate).
  } as any);

  const isCold = !_warmSandboxes.has(sandboxId);

  return {
    exec: async (cmd: string, opts?: any): Promise<{ stdout?: string; stderr?: string; exitCode?: number }> => {
      const execStart = Date.now();
      try {
        const result = await withSandboxTimeout<any>(raw.exec(cmd, opts), sandboxId);
        // Emit cold/warm start telemetry on first exec (P0-4)
        if (isCold && !_warmSandboxes.has(sandboxId)) {
          _warmSandboxes.add(sandboxId);
          emitSandboxStartEvent((env as any).TELEMETRY_QUEUE, sandboxId, true, Date.now() - execStart, (env as any).ORG_ID);
        }
        return result;
      } catch (err: any) {
        console.error(`[sandbox] exec failed (${sandboxId}): ${err.message?.slice(0, 200)}`);
        if (isCold && !_warmSandboxes.has(sandboxId)) {
          _warmSandboxes.add(sandboxId);
          emitSandboxStartEvent((env as any).TELEMETRY_QUEUE, sandboxId, true, Date.now() - execStart, (env as any).ORG_ID, "error");
        }
        throw err;
      }
    },
    writeFile: async (path: string, content: string): Promise<void> => {
      try {
        return await withSandboxTimeout<any>(raw.writeFile(path, content), sandboxId);
      } catch (err: any) {
        console.error(`[sandbox] writeFile failed (${sandboxId}): ${err.message?.slice(0, 200)}`);
        throw err;
      }
    },
    readFile: (path: string): Promise<string> =>
      withSandboxTimeout<any>(
        (raw as any).readFile?.(path) ?? raw.exec(`cat "${path}"`, { timeout: 10 }).then((r: any) => r.stdout || ""),
        sandboxId,
      ),
  };
}

/** Emit sandbox cold/warm start telemetry */
function emitSandboxStartEvent(queue: any, sandboxId: string, cold: boolean, latencyMs: number, orgId?: string, status = "success") {
  if (!queue?.send) return;
  queue.send({
    type: "runtime_event",
    event_type: "sandbox_start",
    session_id: "",
    org_id: orgId || "",
    node_id: sandboxId,
    status,
    duration_ms: latencyMs,
    details: { cold, sandbox_id: sandboxId },
  }).catch(() => {});
}

/**
 * Resolve a stable sandbox ID for container reuse.
 * Prefers DO_SESSION_ID (the DO's name, e.g. "org-agent-user") so the same
 * container is reused across multiple Workflow runs for the same user/agent.
 * Falls back to session ID for non-DO contexts (e.g., eval runs).
 */
function stableSandboxId(env: RuntimeEnv, sessionId: string): string {
  return (env as any).DO_SESSION_ID || `session-${sessionId}`;
}

async function sandboxExecWithLimits(
  env: RuntimeEnv,
  sessionId: string,
  command: string,
  timeoutSeconds?: number,
  stdin?: string,
): Promise<{ stdout?: string; stderr?: string; exitCode?: number }> {
  const timeout = clampSandboxTimeout(timeoutSeconds);
  const sandbox = getSafeSandbox(env, stableSandboxId(env, sessionId));
  return sandbox.exec(command, {
    timeout,
    ...(stdin !== undefined ? { stdin } : {}),
  } as any);
}

async function getCachedDynamicWorker(env: RuntimeEnv, workerCode: string): Promise<any> {
  const key = await hashCode(workerCode);
  const cached = dynamicWorkerCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.worker;
  dynamicWorkerCache.delete(key);
  const loadedWorker = env.LOADER.load({
    compatibilityDate: "2026-03-01",
    mainModule: "agent.js",
    modules: { "agent.js": workerCode },
    env: {},              // Zero bindings — no HYPERDRIVE, STORAGE, VECTORIZE, secrets
    globalOutbound: null, // Fully blocked — fetch() and connect() throw in isolate
  });
  dynamicWorkerCache.set(key, {
    worker: loadedWorker,
    expiresAt: Date.now() + DYNAMIC_WORKER_CACHE_TTL_MS,
  });
  if (dynamicWorkerCache.size > DYNAMIC_WORKER_CACHE_LIMIT) {
    const oldestKey = dynamicWorkerCache.keys().next().value;
    if (oldestKey) dynamicWorkerCache.delete(oldestKey);
  }
  return loadedWorker;
}

// ── SSRF Protection ──────────────────────────────────────────────────────
// Delegated to shared ssrf.ts module (covers IPv4, IPv6, metadata endpoints,
// protocol restrictions). Re-export for backwards compatibility.
const validateUrl = ssrfValidateUrl;

// ── Circuit Breaker for Tool Calls ───────────────────────────────────
// State persisted to DO SQLite when available (survives worker restarts).
// Falls back to in-memory Map for non-DO contexts.

interface CircuitState {
  failures: number;
  successes: number;
  lastFailureTime: number;
  state: "closed" | "open" | "half-open";
}

const circuitStates = new Map<string, CircuitState>();

const CIRCUIT_CONFIG = {
  failureThreshold: 5,        // Open after 5 failures
  successThreshold: 3,        // Close after 3 successes in half-open
  timeoutMs: 60_000,          // 1 minute cooldown
  resetTimeoutMs: 30_000,     // Try half-open after 30s
};

// ── Persistent circuit breaker (DO SQLite-backed) ──
// `sqlExec` is set by the DO Agent class during onStart() to wire up
// persistent storage. In Workflow steps (which run in isolated contexts),
// this falls back to in-memory — the DO reads persistent state on cold start
// and shares it with tools via setCircuitBreakerSql().
let _circuitBreakerSql: ((query: string, ...params: any[]) => any) | null = null;

/**
 * Wire DO SQLite for persistent circuit breaker state.
 * Call from DO's onStart() after migration v3 creates the table.
 */
export function setCircuitBreakerSql(sqlFn: typeof _circuitBreakerSql): void {
  _circuitBreakerSql = sqlFn;
}

/**
 * Preload all persisted circuit breaker states from DO SQLite on cold start.
 * Ensures flaky tools stay blocked across DO restarts instead of resetting to "closed".
 */
export function preloadCircuitStates(sqlFn: typeof _circuitBreakerSql): void {
  if (!sqlFn) return;
  try {
    const rows = sqlFn(`SELECT tool_name, state, failure_count, success_count, last_failure_at FROM circuit_breaker_state`);
    if (!rows) return;
    for (const r of rows) {
      const state: CircuitState = {
        state: r.state === "half_open" ? "half-open" : r.state,
        failures: r.failure_count || 0,
        successes: r.success_count || 0,
        lastFailureTime: (r.last_failure_at || 0) * 1000,
      };
      circuitStates.set(r.tool_name, state);
    }
  } catch { /* table may not exist yet */ }
}

function loadCircuitState(toolName: string): CircuitState {
  if (_circuitBreakerSql) {
    try {
      const rows = _circuitBreakerSql(
        `SELECT state, failure_count, success_count, last_failure_at FROM circuit_breaker_state WHERE tool_name = ?`,
        toolName,
      );
      if (rows && rows.length > 0) {
        const r = rows[0];
        const state: CircuitState = {
          state: r.state === "half_open" ? "half-open" : r.state,
          failures: r.failure_count,
          successes: r.success_count,
          lastFailureTime: r.last_failure_at * 1000, // stored as epoch seconds
        };
        circuitStates.set(toolName, state);
        return state;
      }
    } catch { /* fall through to in-memory */ }
  }
  return getCircuitState(toolName);
}

function persistCircuitState(toolName: string, state: CircuitState): void {
  if (!_circuitBreakerSql) return;
  try {
    const dbState = state.state === "half-open" ? "half_open" : state.state;
    _circuitBreakerSql(
      `INSERT INTO circuit_breaker_state (tool_name, state, failure_count, success_count, last_failure_at, updated_at)
       VALUES (?, ?, ?, ?, ?, unixepoch('now'))
       ON CONFLICT(tool_name) DO UPDATE SET
         state = excluded.state,
         failure_count = excluded.failure_count,
         success_count = excluded.success_count,
         last_failure_at = excluded.last_failure_at,
         updated_at = excluded.updated_at`,
      toolName, dbState, state.failures, state.successes, state.lastFailureTime / 1000,
    );
  } catch { /* best-effort persistence */ }
}

function getCircuitState(toolName: string): CircuitState {
  if (!circuitStates.has(toolName)) {
    circuitStates.set(toolName, {
      failures: 0,
      successes: 0,
      lastFailureTime: 0,
      state: "closed",
    });
  }
  return circuitStates.get(toolName)!;
}

function recordSuccess(toolName: string, telemetryQueue?: any): void {
  const state = loadCircuitState(toolName);
  state.successes++;
  const prevState = state.state;

  if (state.state === "half-open" && state.successes >= CIRCUIT_CONFIG.successThreshold) {
    state.state = "closed";
    state.failures = 0;
    state.successes = 0;
    console.log(`[circuit-breaker] ${toolName}: CLOSED (healthy)`);
    telemetryQueue?.send?.({ type: "circuit_breaker", tool_name: toolName, from_state: prevState, to_state: "closed", failure_count: 0, timestamp: Date.now() });
  }
  persistCircuitState(toolName, state);
}

function recordFailure(toolName: string, telemetryQueue?: any): void {
  const state = loadCircuitState(toolName);
  state.failures++;
  state.lastFailureTime = Date.now();
  state.successes = 0;
  const prevState = state.state;

  if (state.state === "closed" && state.failures >= CIRCUIT_CONFIG.failureThreshold) {
    state.state = "open";
    console.warn(`[circuit-breaker] ${toolName}: OPEN (too many failures)`);
    telemetryQueue?.send?.({ type: "circuit_breaker", tool_name: toolName, from_state: prevState, to_state: "open", failure_count: state.failures, timestamp: Date.now() });
  }
  persistCircuitState(toolName, state);
}

function canExecute(toolName: string, telemetryQueue?: any): { allowed: boolean; reason?: string } {
  const state = loadCircuitState(toolName);
  const now = Date.now();

  if (state.state === "open") {
    const timeSinceFailure = now - state.lastFailureTime;

    if (timeSinceFailure > CIRCUIT_CONFIG.resetTimeoutMs) {
      const prevState = state.state;
      state.state = "half-open";
      state.successes = 0;
      console.log(`[circuit-breaker] ${toolName}: HALF-OPEN (testing)`);
      telemetryQueue?.send?.({ type: "circuit_breaker", tool_name: toolName, from_state: prevState, to_state: "half-open", failure_count: state.failures, timestamp: Date.now() });
      persistCircuitState(toolName, state);
      return { allowed: true };
    }

    return {
      allowed: false,
      reason: `Circuit breaker OPEN for ${toolName}. Retry after ${Math.ceil((CIRCUIT_CONFIG.resetTimeoutMs - timeSinceFailure) / 1000)}s`
    };
  }

  return { allowed: true };
}

// Expose circuit status for observability
export function getCircuitStatus(): Record<string, { state: string; failures: number; successes: number }> {
  const status: Record<string, { state: string; failures: number; successes: number }> = {};
  for (const [tool, state] of circuitStates.entries()) {
    status[tool] = { state: state.state, failures: state.failures, successes: state.successes };
  }
  return status;
}

/**
 * Estimate tool execution cost based on the tool cost model.
 * Used for pre-execution budget checks (Phase 1.2).
 */
export function estimateToolCost(toolName: string): number {
  const model = TOOL_COSTS[toolName];
  if (!model) return 0.001; // Unknown tools: assume minimal cost
  // Use flat fee + estimated 5s duration for time-based tools
  return model.flat_usd + (model.per_ms_usd * 5000);
}

/**
 * Tool cost model — combines per-invocation fees + duration-based compute.
 *
 * Two cost components:
 *   1. flat_usd — per-call cost (API fees, external services)
 *   2. per_ms_usd — duration-based cost (compute time)
 *
 * Total: flat_usd + (latency_ms * per_ms_usd)
 *
 * Pricing sources:
 *   - Brave Search: $5/1K requests
 *   - CF Browser Rendering: ~$0.005/page render
 *   - CF Sandbox containers: ~$0.000025/GB-s ≈ $0.0000125/s for 512MB
 *   - CF Dynamic Workers: ~$0.000012/ms CPU (Workers Paid)
 *   - Workers AI: per-token pricing (handled separately in LLM layer)
 *   - Vectorize: $0.01/1K queries, $0.005/1K mutations
 *   - R2: $0.0036/1K writes, $0.00036/1K reads
 */
interface ToolCostModel {
  flat_usd: number;    // Per-invocation fee
  per_ms_usd: number;  // Duration-based compute cost per millisecond
}

const TOOL_COSTS: Record<string, ToolCostModel> = {
  // Search & web — $0 when LOCAL_SEARCH_URL is set (self-hosted SearXNG + Gemma 4),
  // otherwise Brave/Perplexity rates apply. Cost is set to 0 here since the local
  // pipeline is the primary path; paid fallbacks are charged at the provider level.
  "web-search":        { flat_usd: 0,        per_ms_usd: 0 },          // Local SearXNG (free) or Brave fallback
  "web-crawl":         { flat_usd: 0,        per_ms_usd: 0 },          // Local Playwright or CF Browser Rendering
  "browser-render":    { flat_usd: 0,        per_ms_usd: 0 },          // Local Playwright or CF Browser Rendering

  // Multimodal (Workers AI per-request)
  "image-generate":    { flat_usd: 0.001,    per_ms_usd: 0 },
  "text-to-speech":    { flat_usd: 0.001,    per_ms_usd: 0 },
  "speech-to-text":    { flat_usd: 0.001,    per_ms_usd: 0 },

  // Knowledge (embedding + vector ops)
  "knowledge-search":  { flat_usd: 0.0002,   per_ms_usd: 0 },          // Embedding + query
  "store-knowledge":   { flat_usd: 0.0002,   per_ms_usd: 0 },          // Embedding + upsert
  "ingest-document":   { flat_usd: 0,        per_ms_usd: 0 },          // Self-hosted OCR + embedding (GPU cost only)

  // R2 persistence
  "save-project":      { flat_usd: 0.001,    per_ms_usd: 0 },          // R2 PUTs
  "load-project":      { flat_usd: 0.0005,   per_ms_usd: 0 },          // R2 GET

  // Sandbox containers (duration-based compute)
  "bash":              { flat_usd: 0,         per_ms_usd: 0.0000125 },  // ~$0.0125/s container
  "python-exec":       { flat_usd: 0,         per_ms_usd: 0.0000125 },  // ~$0.0125/s container

  // V8 isolates (lighter compute)
  "dynamic-exec":      { flat_usd: 0,         per_ms_usd: 0.000012 },   // ~$0.012/s isolate
  "execute-code":      { flat_usd: 0,         per_ms_usd: 0.000012 },   // Codemode isolate

  // File ops (sandbox exec + R2 sync)
  "write-file":        { flat_usd: 0.0000045, per_ms_usd: 0 },          // R2 Class A PUT ($4.50/M)
  "edit-file":         { flat_usd: 0.0000045, per_ms_usd: 0 },          // R2 Class A PUT ($4.50/M)
  "read-file":         { flat_usd: 0,         per_ms_usd: 0 },          // Sandbox only
  "grep":              { flat_usd: 0,         per_ms_usd: 0.0000125 },  // Container exec
  "glob":              { flat_usd: 0,         per_ms_usd: 0.0000125 },  // Container exec

  // Pipelines (R2 reads/writes + Hyperdrive queries)
  "query-pipeline":    { flat_usd: 0.00001,   per_ms_usd: 0 },          // DB query + R2 read
  "send-to-pipeline":  { flat_usd: 0.00005, per_ms_usd: 0.0000001 },     // R2 PUT + Workers AI embed + Vectorize write

  // Codemode extended tools (V8 isolate compute + tool call costs)
  "run-codemode":          { flat_usd: 0.0001,  per_ms_usd: 0.000012 },  // Snippet load + isolate
  "codemode-transform":    { flat_usd: 0,        per_ms_usd: 0.000012 },  // Isolate only
  "codemode-validate":     { flat_usd: 0,        per_ms_usd: 0.000012 },  // Isolate only
  "codemode-orchestrate":  { flat_usd: 0,        per_ms_usd: 0.000012 },  // Isolate only
  "codemode-test":         { flat_usd: 0,        per_ms_usd: 0.000012 },  // Isolate only
  "codemode-generate-mcp": { flat_usd: 0,        per_ms_usd: 0.000012 },  // Isolate only
  "mcp-wrap":              { flat_usd: 0.001,    per_ms_usd: 0 },         // Spec parsing + R2 write

  // Self-awareness (DB queries)
  "self-check":           { flat_usd: 0.00005,  per_ms_usd: 0 },          // DB query
  "adapt-strategy":       { flat_usd: 0.00005,  per_ms_usd: 0 },          // DB query

  // Scratch pad (KV)
  "scratch-write":     { flat_usd: 0.0000004, per_ms_usd: 0 },     // KV write
  "scratch-read":      { flat_usd: 0.0000004, per_ms_usd: 0 },     // KV read
  "scratch-list":      { flat_usd: 0.0000004, per_ms_usd: 0 },     // KV list

  // Result retrieval (R2 GET)
  "retrieve-result":   { flat_usd: 0.00000036, per_ms_usd: 0 },  // R2 GET

  // Inter-agent messaging (DO SQLite write)
  "send-message":      { flat_usd: 0.000001,   per_ms_usd: 0 },  // DO SQLite write

  // Team memory (Hyperdrive queries)
  "team-fact-write":   { flat_usd: 0.00005,    per_ms_usd: 0 },  // DB write
  "team-observation":  { flat_usd: 0.00005,    per_ms_usd: 0 },  // DB write

  // Curated memory (DB + sandbox file)
  "sync-workspace-memory": { flat_usd: 0.00001, per_ms_usd: 0.0000125 }, // Hyperdrive + container write
};

/** Calculate tool cost from flat fee + duration. */
function calculateToolCost(toolName: string, latencyMs: number): number {
  const model = TOOL_COSTS[toolName];
  if (!model) return 0;
  const baseCost = model.flat_usd + (latencyMs * model.per_ms_usd);
  // Apply platform margin (same multiplier as LLM costs)
  return baseCost * 1.4; // MARGIN_MULTIPLIER from pricing.ts
}

/**
 * Infrastructure cost rates for CF primitives.
 * Used by the engine to calculate per-session overhead costs.
 *
 * These are NOT per-tool — they're per-session/per-query infrastructure costs
 * that accumulate during a run and get added to the session total.
 */
export const INFRA_COSTS = {
  // Durable Objects: $0.15/million requests + $12.50/million GB-s duration
  // Math: $12.50/1M GB-s × 0.256GB = $0.0000032/s = $0.0000000032/ms
  do_request_usd: 0.00000015,            // Per DO request ($0.15/million)
  do_duration_per_ms_usd: 0.0000000032,  // Per ms @ 256MB ($12.50/M GB-s)

  // Hyperdrive: $0.05/million queries (estimated, not officially published)
  hyperdrive_query_usd: 0.00000005,      // Per query

  // Queue: $0.40/million operations
  queue_message_usd: 0.0000004,          // Per message

  // DO SQLite: $0.001/million rows read, $1.00/million rows written
  do_sql_read_usd: 0.000000001,          // Per row read ($0.001/M)
  do_sql_write_usd: 0.000001,            // Per row written ($1.00/M) ← 1000x fix

  // Vectorize: $0.01/million queried dimensions, $0.05/100M stored dimensions
  // Per query with 768-dim embedding: $0.01/1M × 768 = $0.00000768
  vectorize_query_usd: 0.0000077,        // Per query (768-dim)
  vectorize_mutation_usd: 0.0000004,     // Per upsert (768 dims × $0.05/100M)

  // Supabase: Per-query amortized from Pro plan ($25/month base)
  supabase_query_usd: 0.00001,           // Per DB query
  supabase_write_usd: 0.00002,           // Per DB write

  // R2: $4.50/million Class A (writes), $0.36/million Class B (reads)
  r2_write_usd: 0.0000045,              // Per write ($4.50/M)
  r2_read_usd: 0.00000036,              // Per read ($0.36/M)
};

/**
 * Calculate infrastructure overhead cost for a completed session.
 *
 * This accounts for CF primitives that aren't per-tool:
 *   - DO wall clock time
 *   - Hyperdrive queries (config load, session/turn/event writes)
 *   - Queue messages (telemetry events)
 *   - DO SQLite operations (conversation history)
 *   - Supabase writes (session, turns, events, billing)
 *   - Vectorize queries (memory search per turn)
 */
export function calculateInfraCost(session: {
  wall_clock_ms: number;
  turns: number;
  tool_calls: number;
  events_count: number;
  had_memory_search: boolean;
  had_file_writes: boolean;
}): {
  total_usd: number;
  breakdown: Record<string, number>;
} {
  const c = INFRA_COSTS;

  // DO: 1 request + wall clock duration
  const doCost = c.do_request_usd + (session.wall_clock_ms * c.do_duration_per_ms_usd);

  // Hyperdrive: config load (1) + session write (1) + turn writes + event writes + billing (1)
  const dbQueries = 1; // config load
  const dbWrites = 1 + session.turns + session.events_count + 1; // session + turns + events + billing
  const hyperCost = (dbQueries * c.hyperdrive_query_usd) + (dbWrites * c.hyperdrive_query_usd);

  // Supabase: same queries via Hyperdrive
  const supabaseCost = (dbQueries * c.supabase_query_usd) + (dbWrites * c.supabase_write_usd);

  // Queue: 1 message per event
  const queueCost = session.events_count * c.queue_message_usd;

  // DO SQLite: conversation history reads/writes (2 per message — read history + write new)
  const sqlCost = (session.turns * 2 * c.do_sql_read_usd) + (session.turns * 2 * c.do_sql_write_usd);

  // Vectorize: memory search per turn (if enabled)
  const vecCost = session.had_memory_search
    ? session.turns * c.vectorize_query_usd
    : 0;

  // R2: per-file sync writes (if any file operations)
  const r2Cost = session.had_file_writes ? session.tool_calls * c.r2_write_usd : 0;

  const total = doCost + hyperCost + supabaseCost + queueCost + sqlCost + vecCost + r2Cost;

  return {
    total_usd: total,
    breakdown: {
      durable_object: doCost,
      hyperdrive: hyperCost,
      supabase: supabaseCost,
      queue: queueCost,
      do_sqlite: sqlCost,
      vectorize: vecCost,
      r2: r2Cost,
    },
  };
}

// ── Phase 3.1: Concurrency Safety Classification ──────────────────────
// Read-only / isolated tools can run in parallel. Stateful tools run serially.
const CONCURRENT_SAFE_TOOLS = new Set([
  "read-file", "grep", "glob",                       // Read-only filesystem
  "web-search", "web-crawl", "browser-render",        // External APIs (isolated)
  "knowledge-search", "store-knowledge", "ingest-document", // Vector ops (isolated)
  "http-request",                                     // External HTTP (isolated)
  "image-generate", "text-to-speech", "speech-to-text", // AI services (isolated)
  "self-check", "adapt-strategy",                     // DB reads (no mutations)
  "load-project",                                     // R2 reads
  "discover-tools",                                   // Pure logic
]);

function isConcurrentSafe(toolName: string): boolean {
  return CONCURRENT_SAFE_TOOLS.has(toolName);
}

/**
 * Execute tool calls — concurrent-safe tools run in parallel, unsafe tools run serially.
 *
 * Phase 3.1: Inspired by Claude Code's StreamingToolExecutor which classifies each
 * tool as concurrent-safe and executes safe tools in parallel while serializing
 * unsafe ones. Results are returned in original tool_call order regardless of
 * execution order.
 *
 * @param enabledTools - agent's configured tool list; passed to codemode to prevent privilege escalation.
 */
export async function executeTools(
  env: RuntimeEnv,
  toolCalls: ToolCall[],
  sessionId: string,
  parallel: boolean = true,
  enabledTools?: string[],
  parentAbort?: AbortController,
): Promise<ToolResult[]> {
  const envelope = (env as any).__agentConfig as { enabled_tools?: string[] } | undefined;
  const effectiveEnabledTools = enabledTools ?? envelope?.enabled_tools;

  if (parallel && toolCalls.length > 1) {
    // Partition into concurrent-safe and unsafe
    const safe = toolCalls.filter(tc => isConcurrentSafe(tc.name));
    const unsafe = toolCalls.filter(tc => !isConcurrentSafe(tc.name));

    // Phase 3.3: Abort hierarchy — create sibling group so if one parallel
    // tool fails critically, others are cancelled (saves budget + latency).
    // Parent abort propagates down; child aborts don't propagate up to parent.
    const turnAbort = parentAbort || new AbortController();
    const siblingControllers = safe.length > 1
      ? createSiblingGroup(turnAbort, safe.length)
      : safe.map(() => createChildAbortController(turnAbort));

    // Execute safe tools in parallel with abort support
    const safeResults = safe.length > 0
      ? await Promise.all(safe.map((tc, i) =>
          executeSingleTool(env, tc, sessionId, effectiveEnabledTools, siblingControllers[i]?.signal)
        ))
      : [];

    // Execute unsafe tools serially (each gets its own child abort)
    const unsafeResults: ToolResult[] = [];
    for (const tc of unsafe) {
      const childAbort = createChildAbortController(turnAbort);
      unsafeResults.push(await executeSingleTool(env, tc, sessionId, effectiveEnabledTools, childAbort.signal));
    }

    // Merge results in original tool_call order
    const resultMap = new Map<string, ToolResult>();
    for (const r of [...safeResults, ...unsafeResults]) {
      resultMap.set(r.tool_call_id, r);
    }
    return toolCalls.map(tc => resultMap.get(tc.id) || {
      tool: tc.name, tool_call_id: tc.id, name: tc.name, result: "", error: "Result missing", latency_ms: 0, cost_usd: 0,
    });
  }
  const results: ToolResult[] = [];
  for (const tc of toolCalls) {
    results.push(await executeSingleTool(env, tc, sessionId, effectiveEnabledTools));
  }
  return results;
}

// Re-export abort utilities for use in workflow.ts and index.ts
export { createChildAbortController, createSiblingGroup } from "./abort";

async function executeSingleTool(
  env: RuntimeEnv,
  tc: ToolCall,
  sessionId: string,
  enabledTools?: string[],
  signal?: AbortSignal,
): Promise<ToolResult> {
  const started = Date.now();
  // Normalize tool name: LLMs often convert hyphens to underscores
  tc = { ...tc, name: tc.name.replace(/_/g, "-") };

  // Phase 3.3: Check abort signal before execution
  if (signal?.aborted) {
    return {
      tool: tc.name,
      tool_call_id: tc.id,
      result: "",
      error: `Tool execution cancelled: ${signal.reason || "aborted"}`,
      latency_ms: 0,
      cost_usd: 0,
    };
  }

  // Check circuit breaker before executing
  const circuitCheck = canExecute(tc.name, (env as any).TELEMETRY_QUEUE);
  if (!circuitCheck.allowed) {
    const cbErr = new CircuitBreakerError(tc.name);
    return {
      tool: tc.name,
      tool_call_id: tc.id,
      result: "",
      error: cbErr.userMessage || circuitCheck.reason,
      latency_ms: 0,
      cost_usd: 0,
    };
  }
  
  let args: Record<string, any>;
  try {
    args = JSON.parse(tc.arguments || "{}");
  } catch {
    // LLMs sometimes emit literal newlines/tabs inside JSON strings — fix and retry
    try {
      const sanitized = (tc.arguments || "{}")
        .replace(/[\x00-\x1f]/g, (ch: string) => {
          if (ch === "\n") return "\\n";
          if (ch === "\r") return "\\r";
          if (ch === "\t") return "\\t";
          return "";
        });
      args = JSON.parse(sanitized);
    } catch {
      return {
        tool: tc.name,
        tool_call_id: tc.id,
        result: "",
        error: `Invalid JSON arguments: ${tc.arguments?.slice(0, 200)}`,
        latency_ms: Date.now() - started,
      };
    }
  }

  // ── Governance: Domain allowlist check ────────────────────────
  const config = (env as any).__agentConfig as
    | {
      allowed_domains?: string[];
      blocked_domains?: string[];
      enabled_tools?: string[];
      require_confirmation_for_destructive?: boolean;
      max_tokens_per_turn?: number;
    }
    | undefined;

  const urlTools = new Set(["browse", "http-request", "web-crawl", "browser-render", "a2a-send"]);
  if (urlTools.has(tc.name)) {
    const targetUrl = String(args.url || args.endpoint || "");
    if (targetUrl) {
      try {
        const hostname = new URL(targetUrl).hostname;
        if (config?.blocked_domains && config.blocked_domains.length > 0) {
          const blocked = config.blocked_domains.some(
            (d) => hostname === d || hostname.endsWith(`.${d}`),
          );
          if (blocked) {
            return {
              tool: tc.name, tool_call_id: tc.id, result: "",
              error: `Domain '${hostname}' is blocked by governance policy`,
              latency_ms: Date.now() - started,
            };
          }
        }
        if (config?.allowed_domains && config.allowed_domains.length > 0) {
          const allowed = config.allowed_domains.some(
            (d) => hostname === d || hostname.endsWith(`.${d}`),
          );
          if (!allowed) {
            return {
              tool: tc.name, tool_call_id: tc.id, result: "",
              error: `Domain '${hostname}' not in allowed domains: ${config.allowed_domains.join(", ")}`,
              latency_ms: Date.now() - started,
            };
          }
        }
      } catch { /* invalid URL — SSRF check will catch it */ }
    }
  }

  // ── Governance: Permission auto-classification ───────────────
  if (config?.require_confirmation_for_destructive) {
    const { shouldAutoApprove, classifyPermission } = await import("./permission-classifier");
    const classification = classifyPermission(tc.name, args, { agentConfig: config });

    if (classification.level === "dangerous" && !classification.autoApprove) {
      // Check if auto-approve is configured
      if (!shouldAutoApprove(tc.name, args, config as any)) {
        return {
          tool: tc.name, tool_call_id: tc.id,
          result: JSON.stringify({
            blocked: true,
            reason: classification.reason,
            level: classification.level,
            action: JSON.stringify(args).slice(0, 200),
            tool: tc.name,
          }),
          error: "governance:destructive_blocked",
          latency_ms: Date.now() - started,
        };
      }
    }
  }

  try {
    const result = await dispatch(env, tc.name, args, sessionId, enabledTools);
    const latencyMs = Date.now() - started;

    // Record success for circuit breaker (with telemetry)
    recordSuccess(tc.name, (env as any).TELEMETRY_QUEUE);

    // Emit per-tool latency telemetry (P0-3)
    emitToolExecEvent((env as any).TELEMETRY_QUEUE, tc.name, latencyMs, "success", sessionId, (env as any).ORG_ID);

    return {
      tool: tc.name,
      tool_call_id: tc.id,
      result: typeof result === "string" ? result : JSON.stringify(result),
      latency_ms: latencyMs,
      cost_usd: calculateToolCost(tc.name, latencyMs),
    };
  } catch (err: any) {
    const latencyMs = Date.now() - started;

    // Record failure for circuit breaker (only for external service errors, not arg errors)
    if (isExternalServiceError(err)) {
      recordFailure(tc.name, (env as any).TELEMETRY_QUEUE);
    }

    // Emit per-tool latency telemetry (P0-3)
    emitToolExecEvent((env as any).TELEMETRY_QUEUE, tc.name, latencyMs, "error", sessionId, (env as any).ORG_ID);

    // Wrap raw errors in structured ToolError for telemetry-safe reporting
    const toolErr = err instanceof ToolError ? err : new ToolError(tc.name, err.message || String(err), {
      retryable: isExternalServiceError(err),
    });

    return {
      tool: tc.name,
      tool_call_id: tc.id,
      result: "",
      error: toolErr.userMessage || toolErr.message,
      latency_ms: latencyMs,
      cost_usd: calculateToolCost(tc.name, latencyMs),
    };
  }
}

/** Emit per-tool execution telemetry to the queue for persistence in runtime_events */
function emitToolExecEvent(queue: any, toolName: string, latencyMs: number, status: string, sessionId: string, orgId?: string) {
  if (!queue?.send) return;
  queue.send({
    type: "runtime_event",
    event_type: "tool_exec",
    session_id: sessionId,
    org_id: orgId || "",
    node_id: toolName,
    status,
    duration_ms: latencyMs,
    details: { tool: toolName },
  }).catch(() => {});
}

function isExternalServiceError(err: any): boolean {
  // Use structured error classification instead of fragile string matching.
  // classifyFetchError handles network, timeout, TLS, rate-limit, and HTTP errors.
  const classified = classifyFetchError(err);
  return classified.kind === "network"
    || classified.kind === "timeout"
    || classified.kind === "rate_limit"
    || (classified.kind === "http" && (classified.status ?? 0) >= 500);
}

async function dispatch(
  env: RuntimeEnv,
  tool: string,
  args: Record<string, any>,
  sessionId: string,
  enabledTools?: string[],
): Promise<string> {
  // Normalize tool name: LLMs often convert hyphens to underscores (web_search → web-search)
  const normalizedTool = tool.replace(/_/g, "-");
  // Resolve the effective tool list for codemode — uses agent's enabled tools,
  // NOT all tools. This prevents privilege escalation through execute-code.
  const effectiveToolDefs = () => getToolDefinitions(enabledTools || []);
  switch (normalizedTool) {
    case "web-search":
      return perplexitySearch(env, args);

    case "browse":
      return browse(args, env, sessionId);

    case "http-request":
      return httpRequest(args);

    case "bash": {
      const cmd = String(args.command || "");
      // Sandbox egress control: block commands that access private/metadata URLs.
      // This is defense-in-depth — the sandbox VM provides network isolation,
      // and SSRF validation catches direct URLs. This layer catches obvious patterns
      // but CANNOT catch all bypass techniques (base64, eval, variable expansion).
      // For production: use CF Container network policies when available.

      // Block direct private IP access patterns
      const BLOCKED_PATTERNS = [
        /169\.254\.169\.254/,                         // AWS metadata
        /metadata\.google\.internal/,                  // GCP metadata
        /100\.100\.100\.200/,                         // Azure metadata
        /\blocalhost\b/,                              // localhost
        /127\.0\.0\.1/,                               // loopback
        /\[::1\]/,                                    // IPv6 loopback
        /0\.0\.0\.0/,                                 // any interface
        /10\.\d+\.\d+\.\d+/,                         // RFC1918
        /172\.(1[6-9]|2\d|3[01])\.\d+\.\d+/,        // RFC1918
        /192\.168\.\d+\.\d+/,                        // RFC1918
        /base64\s+(-d|--decode)/i,                    // base64 decode (bypass attempt)
        /\$\(.*curl.*\)/,                             // command substitution with curl
        /`.*curl.*`/,                                 // backtick substitution with curl
        /eval\s+.*http/i,                             // eval with http
      ];
      for (const pattern of BLOCKED_PATTERNS) {
        if (pattern.test(cmd)) {
          return JSON.stringify({ stdout: "", stderr: `Egress blocked: command matches restricted pattern`, exit_code: 1 });
        }
      }

      // Also check extracted URLs via SSRF validator
      const urlPattern = /(?:curl|wget|fetch|http\.get|requests\.get)\s+['"]?(https?:\/\/[^\s'"]+)/gi;
      let urlMatch: RegExpExecArray | null;
      while ((urlMatch = urlPattern.exec(cmd)) !== null) {
        const check = validateUrl(urlMatch[1]);
        if (!check.valid) {
          return JSON.stringify({ stdout: "", stderr: `Egress blocked: ${check.reason}`, exit_code: 1 });
        }
      }

      try {
        const r = await sandboxExecWithLimits(env, sessionId, cmd, args.timeout_seconds);
        return JSON.stringify({ stdout: r.stdout || "", stderr: r.stderr || "", exit_code: r.exitCode ?? 0 });
      } catch (err: any) {
        return JSON.stringify({ stdout: "", stderr: `Sandbox error: ${err.message || err}`, exit_code: 1 });
      }
    }

    case "python-exec": {
      const code = String(args.code || "");
      // Validate URLs in Python HTTP calls
      const pyUrlPattern = /(?:requests\.(?:get|post|put|delete|patch)|urlopen|urllib\.request)\s*\(\s*['"]?(https?:\/\/[^\s'")\]]+)/gi;
      let pyMatch: RegExpExecArray | null;
      while ((pyMatch = pyUrlPattern.exec(code)) !== null) {
        const check = validateUrl(pyMatch[1]);
        if (!check.valid) {
          return JSON.stringify({ stdout: "", stderr: `Egress blocked: ${check.reason}`, exit_code: 1 });
        }
      }

      // Standard Python execution (no in-process tool bridge — use execute-code + /workspace files, then python-exec)
      try {
        const sandbox = getSafeSandbox(env, stableSandboxId(env, sessionId));
        const tmpFile = `/tmp/py_${Date.now()}.py`;
        await sandbox.writeFile(tmpFile, code);
        const timeout = clampSandboxTimeout(args.timeout_seconds);
        const r = await sandbox.exec(`python3 ${tmpFile}`, { timeout });
        sandbox.exec(`rm -f ${tmpFile}`, { timeout: 5 }).catch(() => {});
        return JSON.stringify({ stdout: r.stdout || "", stderr: r.stderr || "", exit_code: r.exitCode ?? 0 });
      } catch (err: any) {
        return JSON.stringify({ stdout: "", stderr: `Python sandbox error: ${err.message || err}`, exit_code: 1 });
      }
    }

    case "read-file": {
      const sandbox = getSafeSandbox(env, stableSandboxId(env, sessionId));
      let readPath = args.path || "";
      if (readPath && !readPath.startsWith("/")) readPath = `/workspace/${readPath}`;

      // Phase 9.5: Binary file detection — check for null bytes in first 8KB
      const binCheck = await sandbox.exec(
        `head -c 8192 "${readPath}" 2>/dev/null | tr -d '\\0' | wc -c`,
        { timeout: 5 },
      ).catch(() => ({ stdout: "0" }));
      const rawCheck = await sandbox.exec(
        `head -c 8192 "${readPath}" 2>/dev/null | wc -c`,
        { timeout: 5 },
      ).catch(() => ({ stdout: "0" }));
      const cleanBytes = parseInt((binCheck.stdout || "0").trim()) || 0;
      const rawBytes = parseInt((rawCheck.stdout || "0").trim()) || 0;
      if (rawBytes > 0 && cleanBytes < rawBytes * 0.9) {
        // >10% null bytes → binary file
        const ext = readPath.split(".").pop() || "unknown";
        const sizeCheck = await sandbox.exec(`stat -c%s "${readPath}" 2>/dev/null || stat -f%z "${readPath}" 2>/dev/null`, { timeout: 5 }).catch(() => ({ stdout: "?" }));
        return `[Binary file — ${(sizeCheck.stdout || "?").trim()} bytes, type: .${ext}]`;
      }

      const offset = Math.max(1, Number(args.offset) || 1);
      const limit = Math.min(200, Math.max(1, Number(args.limit) || 100));
      const endLine = offset + limit - 1;
      const r = await sandbox.exec(
        `sed -n '${offset},${endLine}p' "${readPath}" 2>/dev/null | cat -n | sed 's/^ *\\([0-9]*\\)\\t/'"$((offset-1))"'+\\1\\t/' 2>/dev/null || cat -n "${readPath}" 2>&1 | sed -n '${offset},${endLine}p'`,
        { timeout: 10 },
      );
      if (!r.stdout && r.stderr) return r.stderr;
      // Report total line count so agent knows file size
      const wcr = await sandbox.exec(`wc -l < "${readPath}" 2>/dev/null`, { timeout: 5 }).catch(() => ({ stdout: "?" }));
      const totalLines = (wcr.stdout || "?").trim();
      return `[Showing lines ${offset}-${Math.min(offset + limit - 1, Number(totalLines) || 99999)} of ${totalLines} total]\n${r.stdout || "File not found or empty"}`;
    }

    case "view-file": {
      // Stateful file viewer (SWE-agent ACI pattern) — 100-line window with cursor
      const sandbox = getSafeSandbox(env, stableSandboxId(env, sessionId));
      let viewPath = args.path || "";
      if (viewPath && !viewPath.startsWith("/")) viewPath = `/workspace/${viewPath}`;
      const line = Math.max(1, Number(args.line) || 1);
      const window = Math.min(200, Math.max(10, Number(args.window) || 100));
      const half = Math.floor(window / 2);
      const startLine = Math.max(1, line - half);
      const endLine = startLine + window - 1;
      const r = await sandbox.exec(`awk 'NR>=${startLine} && NR<=${endLine} { printf "%6d\\t%s\\n", NR, $0 }' "${viewPath}" 2>&1`, { timeout: 10 });
      const wcr = await sandbox.exec(`wc -l < "${viewPath}" 2>/dev/null`, { timeout: 5 }).catch(() => ({ stdout: "?" }));
      const total = (wcr.stdout || "?").trim();
      return `[${viewPath} | lines ${startLine}-${Math.min(endLine, Number(total) || endLine)} of ${total} | cursor at line ${line}]\n${r.stdout || "File not found or empty"}`;
    }

    case "write-file": {
      const sandbox = getSafeSandbox(env, stableSandboxId(env, sessionId));
      // Enforce safe default path — always resolve to /workspace/
      let filePath = args.path || "output.txt";
      if (!filePath.startsWith("/")) filePath = `/workspace/${filePath}`;
      if (!filePath.startsWith("/workspace") && !filePath.startsWith("/tmp")) filePath = `/workspace/${filePath.replace(/^\/+/, "")}`;
      // Ensure parent dir exists
      const dir = filePath.substring(0, filePath.lastIndexOf("/"));
      if (dir) await sandbox.exec(`mkdir -p "${dir}"`, { timeout: 5 }).catch(() => {});

      // Phase 9.5: Encoding preservation — detect and preserve BOM + line endings
      let writeContent = args.content || "";
      const existingContent = await sandbox.exec(`cat "${filePath}" 2>/dev/null`, { timeout: 5 }).catch(() => ({ stdout: "" }));
      if (existingContent.stdout) {
        // Preserve CRLF if original uses it
        const hasCRLF = existingContent.stdout.includes("\r\n");
        if (hasCRLF && !writeContent.includes("\r\n")) {
          writeContent = writeContent.replace(/\n/g, "\r\n");
        }
        // Preserve UTF-8 BOM if original has it
        if (existingContent.stdout.charCodeAt(0) === 0xFEFF && writeContent.charCodeAt(0) !== 0xFEFF) {
          writeContent = "\uFEFF" + writeContent;
        }
      }

      await sandbox.writeFile(filePath, writeContent);

      // Per-file sync to R2 for durability (non-blocking, user-scoped)
      if (filePath.startsWith("/workspace/") && env.STORAGE) {
        const r2Org = (env as any).__agentConfig?.orgId || (env as any).__agentConfig?.org_id || "default";
        const r2Agent = (env as any).__agentConfig?.agent_name || (env as any).__agentConfig?.agentName || (env as any).__agentConfig?.name || "agent";
        const r2UserId = (env as any).__channelUserId || "";
        import("./workspace").then(({ syncFileToR2 }) =>
          syncFileToR2(env.STORAGE, r2Org, r2Agent, filePath, writeContent, sessionId, r2UserId),
        ).catch(() => {});
      }

      // Persist to DO SQLite for hibernation safety
      if (filePath.startsWith("/workspace/") && env.DO_SQL) {
        try {
          const { saveFileToSQLite, hashContent } = await import("./workspace-persistence");
          const hash = await hashContent(writeContent);
          saveFileToSQLite(env.DO_SQL, env.DO_SESSION_ID || sessionId, {
            path: filePath,
            content: writeContent,
            encoding: "utf-8",
            size: writeContent.length,
            hash,
            modified_at: new Date().toISOString(),
          });
        } catch {}
      }

      return `Written ${writeContent.length} bytes to ${filePath}`;
    }

    case "edit-file": {
      const sandbox = getSafeSandbox(env, stableSandboxId(env, sessionId));
      const editPath = args.path || "";
      const read = await sandbox.exec(`cat "${editPath}"`, { timeout: 10 });
      const content = read.stdout || "";

      // Phase 10.5: Staleness detection — check if file was modified since last read
      const mtimeCheck = await sandbox.exec(`stat -c%Y "${editPath}" 2>/dev/null || stat -f%m "${editPath}" 2>/dev/null`, { timeout: 5 }).catch(() => ({ stdout: "0" }));
      const currentMtime = (mtimeCheck.stdout || "0").trim();
      const cacheKey = `${sessionId}:${editPath}`;
      const lastKnownMtime = fileStateCache.get(cacheKey);
      if (lastKnownMtime && lastKnownMtime !== currentMtime) {
        // File changed since we last read it — warn the agent
        return `Warning: ${editPath} was modified since it was last read (mtime ${lastKnownMtime} → ${currentMtime}). Re-read the file before editing to avoid overwriting changes.`;
      }
      // Update cache with current mtime (will be updated again after write)
      fileStateCacheSet(cacheKey, currentMtime);

      const oldText = args.old_text || args.old_string || "";
      if (!content.includes(oldText)) return `Error: old_text not found in ${editPath}`;
      const newContent = args.replace_all
        ? content.replaceAll(oldText, args.new_text || args.new_string || "")
        : content.replace(oldText, args.new_text || args.new_string || "");

      // Lint-on-edit: run syntax validation BEFORE applying (SWE-agent ACI pattern)
      // Detects language from file extension and runs appropriate linter
      const ext = editPath.split(".").pop()?.toLowerCase() || "";
      let lintError = "";
      if (["py"].includes(ext)) {
        const tmpLint = `/tmp/lint_${Date.now()}.py`;
        await sandbox.writeFile(tmpLint, newContent);
        const lint = await sandbox.exec(`python3 -c "import ast; ast.parse(open('${tmpLint}').read())" 2>&1`, { timeout: 10 }).catch(() => ({ stdout: "", stderr: "lint timeout", exitCode: 1 }));
        await sandbox.exec(`rm -f ${tmpLint}`, { timeout: 5 }).catch(() => {});
        if (lint.exitCode && lint.exitCode !== 0) lintError = (lint.stderr || lint.stdout || "").trim();
      } else if (["js", "ts", "jsx", "tsx", "mjs"].includes(ext)) {
        const tmpLint = `/tmp/lint_${Date.now()}.${ext}`;
        await sandbox.writeFile(tmpLint, newContent);
        const lint = await sandbox.exec(`node --check "${tmpLint}" 2>&1 || true`, { timeout: 10 }).catch(() => ({ stdout: "", stderr: "", exitCode: 0 }));
        await sandbox.exec(`rm -f ${tmpLint}`, { timeout: 5 }).catch(() => {});
        if (lint.stderr && lint.stderr.includes("SyntaxError")) lintError = lint.stderr.trim();
      } else if (["json"].includes(ext)) {
        try { JSON.parse(newContent); } catch (e: any) { lintError = `JSON syntax error: ${e.message}`; }
      }

      if (lintError) {
        // Reject the edit — return error with original + failed edit context
        const oldLines = oldText.split("\n").length;
        const newLines = (args.new_text || args.new_string || "").split("\n").length;
        return `Edit REJECTED — syntax error detected:\n${lintError}\n\nYour edit would have replaced ${oldLines} lines with ${newLines} lines in ${editPath}.\nFix the syntax and try again.`;
      }

      await sandbox.writeFile(editPath, newContent);

      // Phase 10.5: Update mtime cache after successful write
      const newMtime = await sandbox.exec(`stat -c%Y "${editPath}" 2>/dev/null || stat -f%m "${editPath}" 2>/dev/null`, { timeout: 5 }).catch(() => ({ stdout: "0" }));
      fileStateCacheSet(cacheKey, (newMtime.stdout || "0").trim());

      // Sync edited file to R2 (non-blocking, user-scoped)
      if (editPath.startsWith("/workspace/") && env.STORAGE) {
        const r2Org = (env as any).__agentConfig?.orgId || (env as any).__agentConfig?.org_id || "default";
        const r2Agent = (env as any).__agentConfig?.agent_name || (env as any).__agentConfig?.agentName || (env as any).__agentConfig?.name || "agent";
        const r2UserId = (env as any).__channelUserId || "";
        import("./workspace").then(({ syncFileToR2 }) =>
          syncFileToR2(env.STORAGE, r2Org, r2Agent, editPath, newContent, sessionId, r2UserId),
        ).catch(() => {});
      }

      // Persist to DO SQLite for hibernation safety
      if (editPath.startsWith("/workspace/") && env.DO_SQL) {
        try {
          const { saveFileToSQLite, hashContent } = await import("./workspace-persistence");
          const hash = await hashContent(newContent);
          saveFileToSQLite(env.DO_SQL, env.DO_SESSION_ID || sessionId, {
            path: editPath,
            content: newContent,
            encoding: "utf-8",
            size: newContent.length,
            hash,
            modified_at: new Date().toISOString(),
          });
        } catch {}
      }

      // Return unified diff so agent sees exactly what changed (SWE-agent ACI pattern)
      const oldLines = oldText.split("\n");
      const newLines = (args.new_text || args.new_string || "").split("\n");
      const diffPreview = oldLines.length <= 20 && newLines.length <= 20
        ? `\n--- a/${editPath}\n+++ b/${editPath}\n` +
          oldLines.map((l: string) => `- ${l}`).join("\n") + "\n" +
          newLines.map((l: string) => `+ ${l}`).join("\n")
        : "";
      return `Edited ${editPath}: replaced ${oldText.length} chars with ${(args.new_text || args.new_string || "").length} chars (lint: ok)${diffPreview}`;
    }

    case "grep": {
      // Smart search with refinement forcing (SWE-agent ACI pattern)
      const sandbox = getSafeSandbox(env, stableSandboxId(env, sessionId));
      const maxResults = Math.min(50, Number(args.max_results) || 20);
      const escapedPattern = (args.pattern || "").replace(/"/g, '\\"');
      const searchPath = args.path || ".";
      // First check total match count
      const countR = await sandbox.exec(
        `grep -rn "${escapedPattern}" "${searchPath}" 2>/dev/null | wc -l`,
        { timeout: 15 },
      );
      const totalMatches = Number((countR.stdout || "0").trim()) || 0;
      if (totalMatches > maxResults) {
        // Force refinement: tell the agent there are too many results
        const preview = await sandbox.exec(
          `grep -rn "${escapedPattern}" "${searchPath}" 2>/dev/null | head -${maxResults}`,
          { timeout: 15 },
        );
        return `[${totalMatches} matches found — showing first ${maxResults}. Narrow your search pattern for better results.]\n${preview.stdout || ""}`;
      }
      const r = await sandbox.exec(
        `grep -rn "${escapedPattern}" "${searchPath}" 2>/dev/null | head -${maxResults}`,
        { timeout: 15 },
      );
      return r.stdout || "No matches found";
    }

    case "glob": {
      // Smart file search with capping (SWE-agent ACI pattern)
      const sandbox = getSafeSandbox(env, stableSandboxId(env, sessionId));
      const searchPath = args.path || ".";
      const escapedPattern = (args.pattern || "*").replace(/"/g, '\\"');
      // Count total first
      const countR = await sandbox.exec(
        `find "${searchPath}" -name "${escapedPattern}" -type f 2>/dev/null | wc -l`,
        { timeout: 10 },
      );
      const totalFiles = Number((countR.stdout || "0").trim()) || 0;
      if (totalFiles > 50) {
        const preview = await sandbox.exec(
          `find "${searchPath}" -name "${escapedPattern}" -type f 2>/dev/null | head -50`,
          { timeout: 10 },
        );
        return `[${totalFiles} files match — showing first 50. Use a more specific pattern or path to narrow results.]\n${preview.stdout || ""}`;
      }
      const r = await sandbox.exec(
        `find "${searchPath}" -name "${escapedPattern}" -type f 2>/dev/null | head -50`,
        { timeout: 10 },
      );
      return r.stdout || "No files found";
    }

    case "search-file": {
      // Search within a specific file (SWE-agent ACI pattern)
      const sandbox = getSafeSandbox(env, stableSandboxId(env, sessionId));
      let filePath = args.path || "";
      if (filePath && !filePath.startsWith("/")) filePath = `/workspace/${filePath}`;
      const term = (args.term || args.pattern || "").replace(/"/g, '\\"');
      const r = await sandbox.exec(
        `grep -n "${term}" "${filePath}" 2>/dev/null | head -50`,
        { timeout: 10 },
      );
      if (!r.stdout) return `No matches for "${args.term || args.pattern}" in ${filePath}`;
      const lines = (r.stdout || "").split("\n").filter((l: string) => l.trim());
      return `[${lines.length} matches in ${filePath}]\n${r.stdout}`;
    }

    case "find-file": {
      // Find a file by name (SWE-agent ACI pattern)
      const sandbox = getSafeSandbox(env, stableSandboxId(env, sessionId));
      const name = (args.name || args.filename || "").replace(/"/g, '\\"');
      const searchPath = args.path || "/workspace";
      const r = await sandbox.exec(
        `find "${searchPath}" -name "*${name}*" -type f 2>/dev/null | head -30`,
        { timeout: 10 },
      );
      return r.stdout || `No files matching "${name}" found in ${searchPath}`;
    }

    case "knowledge-search":
      return knowledgeSearch(env, args);

    case "store-knowledge":
      return storeKnowledge(env, args);

    case "ingest-document":
      return ingestDocument(env, args);

    case "image-generate":
      return imageGenerate(env, args);

    case "vision-analyze":
      return visionAnalyze(env, args);

    case "memory-save":
      return memorySave(env, args);

    case "memory-recall":
      return memoryRecall(env, args);

    case "memory-delete":
      return memoryDelete(env, args);

    case "sync-workspace-memory":
      return syncWorkspaceMemory(env, sessionId);

    case "team-fact-write": {
      const content = String(args.content || "");
      const category = String(args.category || "general");
      if (!content) return "team-fact-write requires content";
      const orgId = (env as any).__agentConfig?.org_id || "";
      const agentName = (env as any).__agentConfig?.name || "";
      const { writeTeamFact } = await import("./team-memory");
      await writeTeamFact(env, orgId, agentName, content, category);
      return `Team fact recorded: ${content.slice(0, 100)}`;
    }

    case "team-observation": {
      const content = String(args.content || "");
      const target = String(args.target_agent || "");
      if (!content) return "team-observation requires content";
      const orgId = (env as any).__agentConfig?.org_id || "";
      const agentName = (env as any).__agentConfig?.name || "";
      const { writeTeamObservation } = await import("./team-memory");
      await writeTeamObservation(env, orgId, agentName, content, target || undefined);
      return `Observation recorded${target ? ` about ${target}` : ""}`;
    }

    case "mcp-call": {
      // Call a tool on a registered MCP server
      const serverName = String(args.server || args.server_name || "");
      const toolName = String(args.tool || args.tool_name || "");
      if (!serverName || !toolName) return "mcp-call requires server (name) and tool (tool name)";

      const apiBase = (env as any).CONTROL_PLANE_URL || "https://api.oneshots.co/api/v1";
      const serviceToken = (env as any).SERVICE_TOKEN || "";
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (serviceToken) headers.Authorization = `Bearer ${serviceToken}`;

      try {
        // 1. Look up MCP server URL from control-plane
        const serversResp = await fetchWithTimeout(`${apiBase}/mcp/servers`, { headers });
        if (!serversResp.ok) return `MCP server lookup failed: ${serversResp.status}`;
        const { servers } = (await serversResp.json()) as { servers: any[] };
        const server = servers.find((s: any) => s.name === serverName || s.server_id === serverName);
        if (!server) return `MCP server "${serverName}" not found. Available: ${servers.map((s: any) => s.name).join(", ")}`;

        // 2. Call the tool on the MCP server (JSON-RPC over HTTP)
        const mcpHeaders: Record<string, string> = { "Content-Type": "application/json" };
        if (server.auth_token) mcpHeaders.Authorization = `Bearer ${server.auth_token}`;

        const mcpResp = await fetchWithTimeout(server.url.replace(/\/+$/, "") + "/tools/call", {
          method: "POST",
          headers: mcpHeaders,
          body: JSON.stringify({
            jsonrpc: "2.0",
            method: "tools/call",
            id: crypto.randomUUID(),
            params: { name: toolName, arguments: args.arguments || args.params || {} },
          }),
          signal: AbortSignal.timeout(30000),
        });
        return await mcpResp.text();
      } catch (err: any) {
        return `MCP call failed: ${err.message}`;
      }
    }

    case "text-to-speech":
      return textToSpeech(env, args);

    case "speech-to-text":
      return speechToText(env, args, sessionId);

    case "sandbox_exec":
    case "sandbox-exec":
      return sandboxExec(env, args.command || "", sessionId, args.timeout);

    case "sandbox_file_write":
    case "sandbox-file-write": {
      const sandbox = getSafeSandbox(env, stableSandboxId(env, sessionId));
      await sandbox.writeFile(args.path || "/tmp/file", args.content || "");
      return `Written to ${args.path}`;
    }

    case "sandbox_file_read":
    case "sandbox-file-read": {
      const sandbox = getSafeSandbox(env, stableSandboxId(env, sessionId));
      const r = await sandbox.exec(`cat "${args.path || "/tmp/file"}"`, { timeout: 10 });
      return r.stdout || "";
    }

    case "dynamic-exec":
      return dynamicExec(env, args, sessionId);

    case "web-crawl":
      return webCrawl(env, args);

    case "browser-render":
      return browserRender(env, args, sessionId);

    case "marketplace-search": {
      // Search the agent marketplace for agents that can help with a task
      const query = String(args.query || "");
      if (!query) return "marketplace-search requires a query";
      const apiBase = (env as any).CONTROL_PLANE_URL || "https://api.oneshots.co/api/v1";
      try {
        const params = new URLSearchParams({ q: query, limit: String(args.limit || 5) });
        if (args.category) params.set("category", String(args.category));
        if (args.max_price) params.set("max_price", String(args.max_price));
        const serviceToken = (env as any).SERVICE_TOKEN || "";
        const resp = await fetchWithTimeout(`${apiBase}/marketplace/search?${params}`, {
          headers: {
            "Content-Type": "application/json",
            ...(serviceToken ? { Authorization: `Bearer ${serviceToken}` } : {}),
          },
        });
        return await resp.text();
      } catch (err: any) {
        return `Marketplace search failed: ${err.message}`;
      }
    }

    case "share-artifact": {
      // Upload artifact to R2 and record in a2a_artifacts for cross-agent file sharing
      const artifactName = String(args.name || "artifact");
      const content = String(args.content || "");
      if (!content) return "share-artifact requires content";

      const lineage = (env as any).__delegationLineage;
      const taskId = args.task_id || lineage?.task_id || crypto.randomUUID();
      const senderOrg = lineage?.org_id || args.org_id || "";
      const senderAgent = (env as any).__agentConfig?.name || "unknown";
      const receiverOrg = args.receiver_org_id || lineage?.caller_org_id || senderOrg;
      const receiverAgent = args.receiver_agent || lineage?.caller_agent || "";

      // Detect MIME type from extension
      const ext = artifactName.split(".").pop()?.toLowerCase() || "";
      const mimeMap: Record<string, string> = {
        md: "text/markdown", txt: "text/plain", html: "text/html", css: "text/css",
        js: "application/javascript", ts: "application/typescript", json: "application/json",
        py: "text/x-python", pdf: "application/pdf", zip: "application/zip",
        png: "image/png", jpg: "image/jpeg", svg: "image/svg+xml", csv: "text/csv",
      };
      const mimeType = args.mime_type || mimeMap[ext] || "application/octet-stream";

      // Upload to R2
      const storageKey = `artifacts/${taskId}/${artifactName}`;
      try {
        const r2 = (env as any).R2 || (env as any).ARTIFACTS_BUCKET;
        if (!r2) return JSON.stringify({ error: "R2 storage not configured" });

        const isBase64 = args.encoding === "base64";
        const body = isBase64
          ? Uint8Array.from(atob(content), (c) => c.charCodeAt(0))
          : new TextEncoder().encode(content);

        await r2.put(storageKey, body, {
          httpMetadata: { contentType: mimeType },
          customMetadata: { taskId, senderOrg, senderAgent, receiverOrg, receiverAgent },
        });

        const sizeBytes = body.byteLength;

        // Record in DB for traceability
        if ((env as any).HYPERDRIVE) {
          try {
            const { getDb } = await import("./db");
            const sql = await getDb((env as any).HYPERDRIVE);
            await sql`
              INSERT INTO a2a_artifacts (task_id, sender_org_id, sender_agent, receiver_org_id, receiver_agent,
                name, mime_type, size_bytes, description, storage_key, status)
              VALUES (${taskId}, ${senderOrg}, ${senderAgent}, ${receiverOrg}, ${receiverAgent},
                ${artifactName}, ${mimeType}, ${sizeBytes}, ${args.description || ''}, ${storageKey}, 'available')
            `.catch(() => {}); // non-blocking — R2 upload is the source of truth
          } catch {}
        }

        return JSON.stringify({
          artifact: artifactName,
          storage_key: storageKey,
          mime_type: mimeType,
          size_bytes: sizeBytes,
          task_id: taskId,
          receiver_org_id: receiverOrg,
          receiver_agent: receiverAgent,
          message: `Artifact "${artifactName}" shared successfully. The receiving agent can retrieve it via the storage key.`,
        });
      } catch (err: any) {
        return JSON.stringify({ error: `Failed to share artifact: ${err.message}` });
      }
    }

    case "feed-post": {
      // Post to the public agent feed (card, offer, milestone, update)
      const title = String(args.title || "");
      const body = String(args.body || args.content || "");
      if (!title || !body) return "feed-post requires title and body";
      const agentName = String(args.agent_name || (env as any).__agentConfig?.name || "unknown");
      const postType = String(args.post_type || "update");
      const apiBase = (env as any).CONTROL_PLANE_URL || "https://api.oneshots.co/api/v1";
      const serviceToken = (env as any).SERVICE_TOKEN || "";
      try {
        const resp = await fetch(`${apiBase}/feed/post`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(serviceToken ? { Authorization: `Bearer ${serviceToken}` } : {}),
          },
          body: JSON.stringify({
            agent_name: agentName,
            post_type: postType,
            title,
            body,
            tags: args.tags || [],
            image_url: args.image_url || undefined,
            cta_text: args.cta_text || undefined,
            cta_url: args.cta_url || undefined,
            offer_discount_pct: args.offer_discount_pct || undefined,
            offer_price_usd: args.offer_price_usd || undefined,
            offer_expires_at: args.offer_expires_at || undefined,
          }),
        });
        return await resp.text();
      } catch (err: any) {
        return `Feed post failed: ${err.message}`;
      }
    }

    case "a2a-send": {
      const targetUrl = args.url || "";
      const urlCheck = validateUrl(targetUrl);
      if (!urlCheck.valid) return `Error: ${urlCheck.reason}`;
      const task = args.task || args.message || "";
      const authToken = args.auth_token || (env as any).SERVICE_TOKEN || "";

      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (authToken) headers["Authorization"] = `Bearer ${authToken}`;

      const payload = {
        jsonrpc: "2.0", method: "SendMessage", id: crypto.randomUUID(),
        params: {
          message: { role: "user", parts: [{ type: "text", text: task }] },
          agentName: args.agent_name || "",
        },
      };

      // First attempt
      let resp = await fetch(`${targetUrl}`, { method: "POST", headers, body: JSON.stringify(payload) });

      // x-402 Payment Required — auto-pay via credit transfer and retry
      if (resp.status === 402) {
        const price = resp.headers.get("x-402-price");
        const paymentAddress = resp.headers.get("x-402-payment-address");

        if (price && paymentAddress && (env as any).HYPERDRIVE) {
          try {
            const { getDb } = await import("./db");
            const sql = await getDb((env as any).HYPERDRIVE);
            const lineage = (env as any).__delegationLineage;
            const fromOrg = lineage?.org_id || args.org_id || "";

            if (fromOrg && fromOrg !== paymentAddress) {
              // Use the proper transferCredits function — includes platform fee + referral payouts
              const { transferCredits } = await import("./db").then(async () => {
                // transferCredits is in the control-plane logic, but we can replicate
                // the core transfer here using the same SQL pattern
                return { transferCredits: null };
              });

              // Direct DB transfer with platform fee (10%)
              const amountUsd = Number(price);
              const platformFeeRate = 0.10;
              const platformFee = Math.round(amountUsd * platformFeeRate * 1_000_000) / 1_000_000;
              const receiverAmount = amountUsd - platformFee;
              const transferId = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
              const now = new Date().toISOString();

              // Deduct full amount from sender
              const deducted = await sql`
                UPDATE org_credit_balance SET balance_usd = balance_usd - ${amountUsd},
                  lifetime_consumed_usd = lifetime_consumed_usd + ${amountUsd}, updated_at = ${now}
                WHERE org_id = ${fromOrg} AND balance_usd >= ${amountUsd}
              `;

              if (deducted.count > 0) {
                // Credit receiver (minus platform fee)
                await sql`
                  INSERT INTO org_credit_balance (org_id, balance_usd, lifetime_purchased_usd, lifetime_consumed_usd, updated_at)
                  VALUES (${paymentAddress}, ${receiverAmount}, ${receiverAmount}, 0, ${now})
                  ON CONFLICT (org_id) DO UPDATE SET balance_usd = org_credit_balance.balance_usd + ${receiverAmount}, updated_at = ${now}
                `;

                // Audit trail — sender
                await sql`
                  INSERT INTO credit_transactions (org_id, type, amount_usd, balance_after_usd, description, reference_id, reference_type, created_at)
                  VALUES (${fromOrg}, 'transfer_out', ${-amountUsd}, 0, ${'A2A payment: ' + (args.agent_name || targetUrl)}, ${transferId}, 'a2a_payment', ${now})
                `.catch(() => {});

                // Audit trail — receiver
                await sql`
                  INSERT INTO credit_transactions (org_id, type, amount_usd, balance_after_usd, description, reference_id, reference_type, created_at)
                  VALUES (${paymentAddress}, 'transfer_in', ${receiverAmount}, 0, ${'A2A earning: ' + (args.agent_name || '')}, ${transferId}, 'a2a_payment', ${now})
                `.catch(() => {});

                // Platform fee
                if (platformFee > 0) {
                  await sql`
                    INSERT INTO credit_transactions (org_id, type, amount_usd, balance_after_usd, description, reference_id, reference_type, created_at)
                    VALUES ('platform', 'transfer_in', ${platformFee}, 0, ${'Platform fee: A2A'}, ${transferId}, 'marketplace_fee', ${now})
                  `.catch(() => {});
                }

                // Referral payouts (best-effort)
                try {
                  // @ts-expect-error — referrals module may not exist in all deployments
                  const { distributeReferralEarnings } = await import("../logic/referrals").catch(() => ({ distributeReferralEarnings: null }));
                  if (distributeReferralEarnings) {
                    await distributeReferralEarnings(sql, paymentAddress, amountUsd, transferId);
                  }
                } catch {}

                // Retry with payment receipt
                const retryPayload = {
                  ...payload,
                  params: { ...payload.params, payment_receipt: { transfer_id: transferId } },
                };
                resp = await fetch(`${targetUrl}`, { method: "POST", headers, body: JSON.stringify(retryPayload) });
              }
            }
          } catch {}
        }

        if (resp.status === 402) {
          return JSON.stringify({
            error: "payment_required",
            price: resp.headers.get("x-402-price"),
            currency: resp.headers.get("x-402-currency"),
            accepts: resp.headers.get("x-402-accepts"),
            message: "Target agent requires payment but auto-pay failed. Ensure your org has sufficient credits.",
          });
        }
      }

      // Parse A2A response and extract artifacts if present
      const respText = await resp.text();
      try {
        const parsed = JSON.parse(respText);
        const task = parsed?.result || parsed;
        const artifacts = task?.artifacts || [];
        if (artifacts.length > 0 && (env as any).HYPERDRIVE) {
          // Record artifact references from the responding agent
          try {
            const { getDb: getDbForArtifacts } = await import("./db");
            const sqlArt = await getDbForArtifacts((env as any).HYPERDRIVE);
            const lineage = (env as any).__delegationLineage;
            const receiverOrg = lineage?.org_id || args.org_id || "";
            const receiverAgent = (env as any).__agentConfig?.name || "";
            const taskIdForArt = task?.id || crypto.randomUUID();

            for (const art of artifacts) {
              const parts = art.parts || [];
              const textPart = parts.find((p: any) => p.type === "text" || p.text);
              const filePart = parts.find((p: any) => p.type === "file" || p.storage_key);
              if (filePart?.storage_key) {
                await sqlArt`
                  INSERT INTO a2a_artifacts (task_id, sender_org_id, sender_agent, receiver_org_id, receiver_agent,
                    name, mime_type, description, storage_key, status)
                  VALUES (${taskIdForArt}, ${args.agent_name || 'unknown'}, ${args.agent_name || ''},
                    ${receiverOrg}, ${receiverAgent},
                    ${art.name || filePart.storage_key.split('/').pop() || 'artifact'},
                    ${filePart.mime_type || 'application/octet-stream'},
                    ${textPart?.text || art.description || ''},
                    ${filePart.storage_key}, 'available')
                `.catch(() => {});
              }
            }
          } catch {}
        }
        return respText;
      } catch {
        return respText;
      }
    }

    case "save-project":
      return saveProject(env, args, sessionId);

    case "load-project":
      return loadProject(env, args, sessionId);

    case "list-project-versions":
      return listProjectVersions(env, args);

    case "load-folder": {
      // Load files from an R2 folder prefix into the agent's context
      if (!env.STORAGE) return "R2 storage not configured";
      const { loadFolderToContext } = await import("./workspace");
      const orgId = (env as any).__agentConfig?.orgId || (env as any).__agentConfig?.org_id || "default";
      const agentName = (env as any).__agentConfig?.name || "agent";
      const userId = (env as any).__channelUserId || "";

      let prefix = args.path || args.prefix || "";
      // Shortcuts: "workspace" loads the user's workspace, "project:name" loads a named project
      if (prefix === "workspace" || !prefix) {
        prefix = `workspaces/${orgId}/${agentName}/u/${userId || "shared"}/files/`;
      } else if (prefix.startsWith("project:")) {
        const projectName = prefix.slice(8);
        prefix = `workspaces/${orgId}/${agentName}/projects/${projectName}/files/`;
      }

      const content = await loadFolderToContext(env.STORAGE, prefix, {
        maxFiles: args.max_files || 20,
        maxSizePerFile: args.max_size_per_file || 50_000,
      });
      return content;
    }

    case "todo":
      return todoTool(env, args, sessionId);

    case "connector": {
      // Connector tool — reads OAuth tokens from Supabase, calls Pipedream API
      const { executeConnector } = await import("./connectors");
      const connectorName = args.connector_name || args.tool_name || "";
      const orgId = args.org_id || "";
      if (!connectorName) return "connector requires connector_name";
      return executeConnector(
        (env as any).HYPERDRIVE, orgId, connectorName,
        args.tool_name || connectorName, args.arguments || args,
      );
    }

    case "discover-api": {
      // Returns TypeScript type definitions for all available tools
      const { getToolTypeDefinitions } = await import("./codemode");
      const allTools = effectiveToolDefs();
      return getToolTypeDefinitions(allTools);
    }

    case "execute-code": {
      // Run LLM-generated JS in sandboxed Dynamic Worker with tool access via RPC
      const { executeCode } = await import("./codemode");
      const allTools = effectiveToolDefs();
      // Filter out discover-api and execute-code to prevent recursion
      const executableTools = allTools.filter(
        (t) => t.function.name !== "discover-api" && t.function.name !== "execute-code",
      );
      const result = await executeCode(env, args.code || "", executableTools, sessionId);
      if (result.error) return JSON.stringify({ error: result.error, logs: result.logs });
      return typeof result.result === "string"
        ? result.result
        : JSON.stringify({ result: result.result, logs: result.logs });
    }

    // ── Codemode Extended Tools ─────────────────────────────────
    case "run-codemode": {
      const { executeScopedCode, loadSnippetCached } = await import("./codemode");
      const snippetId = args.snippet_id || "";
      if (!snippetId) return "run-codemode requires snippet_id";
      const snippet = await loadSnippetCached((env as any).HYPERDRIVE, snippetId, args.org_id || "");
      if (!snippet) return JSON.stringify({ error: "Snippet not found" });
      const allToolsForSnippet = effectiveToolDefs();
      const cmResult = await executeScopedCode(env, snippet.code, allToolsForSnippet, sessionId, {
        scope: snippet.scope || "agent",
        scopeOverrides: args.scope_config || snippet.scope_config,
        input: args.input,
        snippetId,
      });
      return JSON.stringify({ success: cmResult.success, result: cmResult.result, error: cmResult.error, logs: cmResult.logs, toolCallCount: cmResult.toolCallCount, latencyMs: cmResult.latencyMs, costUsd: cmResult.costUsd });
    }

    case "codemode-transform": {
      const { executeTransform } = await import("./codemode");
      const allToolsForTransform = effectiveToolDefs();
      const transformResult = await executeTransform(env, args.code || "", args.data, allToolsForTransform, sessionId);
      return JSON.stringify({ success: transformResult.success, result: transformResult.result, error: transformResult.error, logs: transformResult.logs });
    }

    case "codemode-validate": {
      const { executeValidator } = await import("./codemode");
      const allToolsForValidate = effectiveToolDefs();
      const valResult = await executeValidator(env, args.code || "", args.data, allToolsForValidate, sessionId);
      return JSON.stringify(valResult);
    }

    case "codemode-orchestrate": {
      const { executeOrchestrator } = await import("./codemode");
      const allToolsForOrch = effectiveToolDefs();
      const orchResult = await executeOrchestrator(env, args.code || "", args.message || "", args.context || {}, allToolsForOrch, sessionId);
      return JSON.stringify(orchResult);
    }

    case "codemode-test": {
      const { executeTestRunner } = await import("./codemode");
      const allToolsForTest = effectiveToolDefs();
      const testResult = await executeTestRunner(env, args.code || "", args.test_context || {}, allToolsForTest, sessionId);
      return JSON.stringify(testResult);
    }

    case "codemode-generate-mcp": {
      const { executeMcpGenerator } = await import("./codemode");
      const allToolsForMcp = effectiveToolDefs();
      const mcpResult = await executeMcpGenerator(env, args.code || "", args.api_spec, allToolsForMcp, sessionId);
      return JSON.stringify({ tools: mcpResult, count: mcpResult.length });
    }

    case "mcp-wrap": {
      // Wrap an OpenAPI spec into a single codemode tool using @cloudflare/codemode/mcp.
      // This replaces manual MCP generation for most flows — point at a spec, get a tool.
      const spec = args.spec || args.openapi_spec || "";
      if (!spec) return "mcp-wrap requires an OpenAPI spec (JSON string or URL)";

      try {
        let specObj: Record<string, unknown>;
        if (typeof spec === "string" && (spec.startsWith("http://") || spec.startsWith("https://"))) {
          // Fetch spec from URL
          const resp = await fetch(spec);
          specObj = await resp.json() as Record<string, unknown>;
        } else if (typeof spec === "string") {
          specObj = JSON.parse(spec);
        } else {
          specObj = spec;
        }

        // Use the v0.2.1 openApiMcpServer to create search + execute tools
        const { DynamicWorkerExecutor } = await import("@cloudflare/codemode");
        const executor = new DynamicWorkerExecutor({ loader: env.LOADER, timeout: 30000, globalOutbound: null });

        // Extract operation summaries for the response
        const paths = (specObj.paths || {}) as Record<string, Record<string, any>>;
        const operations: Array<{ method: string; path: string; summary: string }> = [];
        for (const [path, methods] of Object.entries(paths)) {
          for (const [method, op] of Object.entries(methods)) {
            if (typeof op === "object" && op !== null) {
              operations.push({
                method: method.toUpperCase(),
                path,
                summary: op.summary || op.operationId || "",
              });
            }
          }
        }

        // Store the spec in R2 for later use by the agent
        const specId = `mcp-spec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        if (env.STORAGE) {
          try {
            await env.STORAGE.put(
              `mcp-specs/${args.org_id || "default"}/${specId}.json`,
              JSON.stringify(specObj),
            );
          } catch { /* best-effort */ }
        }

        return JSON.stringify({
          success: true,
          spec_id: specId,
          title: (specObj.info as any)?.title || "API",
          version: (specObj.info as any)?.version || "1.0",
          operations_count: operations.length,
          operations: operations.slice(0, 20),
          message:
            `Wrapped OpenAPI spec "${(specObj.info as any)?.title || "API"}" with ${operations.length} operations. ` +
            `The spec is stored as ${specId}. Use codemode to call these APIs — ` +
            `each operation is available as a typed method.`,
        });
      } catch (err: any) {
        return JSON.stringify({ error: `Failed to wrap spec: ${err.message}` });
      }
    }

    case "create-schedule": {
      // Agent can schedule itself or another agent for recurring runs
      const hyperdrive = (env as any).HYPERDRIVE;
      if (!hyperdrive) return "Schedule creation requires database access";
      const { getDb } = await import("./db");
      const sql = await getDb(hyperdrive);
      const scheduleId = crypto.randomUUID().slice(0, 12);
      const agentName = args.agent_name || args.self_agent_name || "";
      const cronExpr = args.cron || args.schedule || "";
      const taskDesc = args.task || args.description || "";
      const orgId = args.org_id || (env as any).__agentConfig?.org_id || "";
      if (!agentName || !cronExpr || !taskDesc) {
        return "create-schedule requires agent_name, cron (e.g. '0 9 * * *'), and task description";
      }
      try {
        await sql`
          INSERT INTO schedules (schedule_id, agent_name, org_id, task, cron, enabled, run_count, created_at)
          VALUES (${scheduleId}, ${agentName}, ${orgId}, ${taskDesc}, ${cronExpr}, true, 0, ${new Date().toISOString()})
        `;
        return JSON.stringify({ created: true, schedule_id: scheduleId, agent_name: agentName, cron: cronExpr, task: taskDesc });
      } catch (err: any) {
        return `Failed to create schedule: ${err.message || err}`;
      }
    }

    case "list-schedules": {
      const hyperdrive = (env as any).HYPERDRIVE;
      if (!hyperdrive) return "[]";
      const { getDb } = await import("./db");
      const sql = await getDb(hyperdrive);
      const agentName = args.agent_name || "";
      const orgId = args.org_id || "";
      try {
        const rows = agentName
          ? await sql`SELECT schedule_id, agent_name, task, cron, is_enabled, run_count, last_run_at FROM schedules WHERE agent_name = ${agentName} AND org_id = ${orgId} ORDER BY created_at DESC LIMIT 20`
          : await sql`SELECT schedule_id, agent_name, task, cron, is_enabled, run_count, last_run_at FROM schedules WHERE org_id = ${orgId} ORDER BY created_at DESC LIMIT 20`;
        return JSON.stringify(rows);
      } catch {
        return "[]";
      }
    }

    case "delete-schedule": {
      const hyperdrive = (env as any).HYPERDRIVE;
      if (!hyperdrive) return "Schedule deletion requires database access";
      const { getDb } = await import("./db");
      const sql = await getDb(hyperdrive);
      const scheduleId = args.schedule_id || args.id || "";
      const orgId = args.org_id || "";
      if (!scheduleId) return "delete-schedule requires schedule_id";
      try {
        await sql`DELETE FROM schedules WHERE schedule_id = ${scheduleId} AND org_id = ${orgId}`;
        return JSON.stringify({ deleted: true, schedule_id: scheduleId });
      } catch (err: any) {
        return `Failed to delete schedule: ${err.message || err}`;
      }
    }

    case "query-pipeline": {
      // Read recent data from a pipeline's R2 sink.
      // Supports: filter by field values, limit, and time range.
      // NOTE: This reads JSONL files from R2, NOT SQL. For semantic search use knowledge-search.
      const pipelineName = args.pipeline_name || "";
      const limit = Math.min(args.limit || 100, 1000);
      const filterField = args.filter_field || "";
      const filterValue = args.filter_value ?? "";
      const sinceMinutes = Number(args.since_minutes) || 0;
      if (!pipelineName) return "query-pipeline requires pipeline_name";

      const storage = (env as any).STORAGE as R2Bucket;
      if (!storage) return "Pipeline query requires R2 storage access";

      try {
        // List recent data files (sorted by key = timestamp)
        const listResult = await storage.list({
          prefix: `pipelines/${pipelineName}/`,
          limit: 50, // Read up to 50 recent files
        });
        if (!listResult.objects.length) return `No data found in pipeline '${pipelineName}'`;

        // Read and merge records from recent files
        let allRecords: Record<string, unknown>[] = [];
        const cutoffTs = sinceMinutes > 0 ? Date.now() - sinceMinutes * 60 * 1000 : 0;

        // Read from newest files first
        const sortedObjects = [...listResult.objects].reverse();
        for (const obj of sortedObjects) {
          if (allRecords.length >= limit) break;

          // Parse timestamp from filename: pipelines/{name}/{timestamp}.jsonl
          const fileTs = Number(obj.key.split("/").pop()?.replace(".jsonl", "") || 0);
          if (cutoffTs > 0 && fileTs < cutoffTs) continue;

          const file = await storage.get(obj.key);
          if (!file) continue;

          const text = await file.text();
          const lines = text.trim().split("\n");
          for (const line of lines) {
            if (allRecords.length >= limit) break;
            try {
              const record = JSON.parse(line) as Record<string, unknown>;
              // Apply field filter if specified
              if (filterField && String(record[filterField] ?? "") !== String(filterValue)) continue;
              allRecords.push(record);
            } catch { /* skip malformed lines */ }
          }
        }

        return JSON.stringify({
          pipeline: pipelineName,
          records_count: allRecords.length,
          files_scanned: Math.min(sortedObjects.length, 50),
          filter: filterField ? { field: filterField, value: filterValue } : null,
          data: allRecords,
        });
      } catch (err: any) {
        return `Pipeline read failed: ${err.message || err}`;
      }
    }

    case "send-to-pipeline": {
      // Send events to a pipeline: R2 (structured) + optional Vectorize (semantic)
      const pipelineName = args.pipeline_name || "";
      const events = args.events;
      const embedForRag = args.embed !== false; // Default: also embed for RAG search
      const textField = args.text_field || "text"; // Which field to embed
      if (!pipelineName) return "send-to-pipeline requires pipeline_name";
      if (!Array.isArray(events) || events.length === 0) return "send-to-pipeline requires a non-empty events array";

      const storage = (env as any).STORAGE as R2Bucket;
      if (!storage) return "Pipeline ingest requires R2 storage access";

      try {
        // 1. Write to R2 (structured sink — always)
        const key = `pipelines/${pipelineName}/${Date.now()}.jsonl`;
        const data = events.map((e: unknown) => JSON.stringify(e)).join("\n");
        await storage.put(key, data);

        // 2. Embed into Vectorize (semantic sink — when enabled)
        let embedded = 0;
        if (embedForRag && env.VECTORIZE && env.AI) {
          const textsToEmbed: { text: string; metadata: Record<string, unknown> }[] = [];
          for (const event of events) {
            const e = event as Record<string, unknown>;
            // Extract text to embed: use text_field, fall back to content, then stringify
            const raw = e[textField] ?? e.content ?? e.text ?? e.body ?? e.description ?? "";
            const text = typeof raw === "string" ? raw : JSON.stringify(raw);
            if (text.length < 10) continue; // Skip tiny entries

            textsToEmbed.push({
              text: text.slice(0, 8000), // Embedding model max input
              metadata: {
                text: text.slice(0, 2000), // Store searchable snippet
                source: `pipeline:${pipelineName}`,
                pipeline: pipelineName,
                agent_name: args.agent_name || e.agent_name || "",
                org_id: args.org_id || e.org_id || "",
                event_type: String(e.event_type || e.type || ""),
                ingested_at: new Date().toISOString(),
              },
            });
          }

          if (textsToEmbed.length > 0) {
            // Content-hash function for dedup: same text → same ID → upsert updates
            async function contentHashId(pipeline: string, text: string): Promise<string> {
              const data = new TextEncoder().encode(`${pipeline}:${text}`);
              const hash = await crypto.subtle.digest("SHA-256", data);
              const hex = [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
              return `pipeline-${pipeline}-${hex.slice(0, 16)}`;
            }

            // Batch embed (up to 100 at a time)
            for (let i = 0; i < textsToEmbed.length; i += 100) {
              const batch = textsToEmbed.slice(i, i + 100);
              try {
                const embedResult = (await env.AI.run(
                  "@cf/baai/bge-base-en-v1.5" as keyof AiModels,
                  { text: batch.map((b) => b.text) },
                )) as any;
                const vectors = embedResult.data || [];
                // Fix #3+#4: Content-based IDs for dedup (same content → same ID → upsert)
                const upserts = await Promise.all(
                  vectors.map(async (vec: number[], idx: number) => ({
                    id: await contentHashId(pipelineName, batch[idx].text),
                    values: vec,
                    metadata: batch[idx].metadata,
                  })),
                );
                if (upserts.length > 0) {
                  await env.VECTORIZE.upsert(upserts);
                  embedded += upserts.length;
                }
              } catch {
                // Embedding failure is non-fatal — R2 write already succeeded
              }
            }
          }
        }

        return JSON.stringify({
          sent: true,
          pipeline: pipelineName,
          count: events.length,
          r2_key: key,
          embedded_for_rag: embedded,
        });
      } catch (err: any) {
        return `Pipeline ingest failed: ${err.message || err}`;
      }
    }

    case "submit-feedback": {
      const hyperdrive = (env as any).HYPERDRIVE;
      if (!hyperdrive) return "Feedback requires database access";
      const { getDb } = await import("./db");
      const sql = await getDb(hyperdrive);
      const feedbackId = crypto.randomUUID().slice(0, 12);
      const rating = args.rating; // "positive" | "negative" | "neutral"
      const comment = String(args.comment || "");
      const sessionId2 = args.session_id || "";
      const turn = Number(args.turn || 0);
      const messageContent = String(args.message_content || "").slice(0, 2000);

      try {
        await sql`
          INSERT INTO session_feedback (id, session_id, turn_number, rating, comment, message_preview, org_id, agent_name, channel, created_at)
          VALUES (${feedbackId}, ${sessionId2}, ${turn}, ${rating}, ${comment}, ${messageContent},
                  ${args.org_id || ""}, ${args.agent_name || ""}, ${args.channel || "api"}, ${new Date().toISOString()})
        `;
        return JSON.stringify({ submitted: true, feedback_id: feedbackId });
      } catch (err: any) {
        return `Feedback submission failed: ${err.message || err}`;
      }
    }

    case "route-to-agent": {
      // P1 Fix: Use cached agent capabilities instead of DB query per call
      const { classifyIntent, decomposeIntents, getAgentCapabilitiesCached } = await import("./intent-router");
      const routeInput = args.input || args.query || "";
      if (!routeInput) return "route-to-agent requires input text";

      const intents = decomposeIntents(routeInput);

      // Load agent capabilities (cached for 60s)
      const hyperdrive = (env as any).HYPERDRIVE;
      const orgId = args.org_id || "";
      const capabilities = hyperdrive
        ? await getAgentCapabilitiesCached(hyperdrive, orgId)
        : [];

      const results = intents.map((i) => {
        const cls = classifyIntent(i.subtask, capabilities);
        return {
          ...i,
          suggested_agent: cls.suggested_agent,
          all_intents: cls.all_intents,
          reasoning: cls.reasoning,
        };
      });

      return JSON.stringify({ routing: results, agent_count: capabilities.length });
    }

    // ── DB Query Tools (codemode-safe, templated) ─────────────────
    // These use the /cf/db/query allowlist — no raw SQL, always org-scoped.

    case "db-query": {
      // Execute a single templated DB query
      const queryId = String(args.query_id || "");
      if (!queryId) return "db-query requires query_id (e.g., 'sessions.list', 'issues.open', 'eval.runs')";

      const orgId = args.org_id || "";
      const userId = args.user_id || "";

      // Call our own /cf/db/query endpoint (same worker, internal)
      try {
        const body = JSON.stringify({
          query_id: queryId,
          context: { org_id: orgId, user_id: userId, role: "agent" },
          params: args.params || {},
        });

        // Self-call via internal fetch if HYPERDRIVE available, else error
        const hyperdrive = (env as any).HYPERDRIVE;
        if (!hyperdrive) return "db-query requires database access";

        const { getDb } = await import("./db");
        const sql = await getDb(hyperdrive);

        // Execute with RLS context
        const rows = await sql.begin(async (tx: any) => {
          await tx`SELECT set_config('app.current_user_id', ${userId || "agent"}, true)`;
          await tx`SELECT set_config('app.current_role', 'agent', true)`;

          // Dispatch to query handler (reuse the allowlist logic)
          const p = args.params || {};
          switch (queryId) {
            case "sessions.stats": {
              const an = p.agent_name ? String(p.agent_name) : null;
              const sd = Math.min(Number(p.since_days) || 7, 90);
              const since = new Date(Date.now() - sd * 86400 * 1000).toISOString();
              return an
                ? await tx`SELECT COUNT(*) as total, COALESCE(AVG(cost_total_usd),0) as avg_cost, COALESCE(AVG(wall_clock_seconds),0) as avg_latency, COALESCE(SUM(CASE WHEN status='success' THEN 1 ELSE 0 END)::float/NULLIF(COUNT(*),0),0) as success_rate FROM sessions WHERE org_id = ${orgId} AND agent_name = ${an} AND created_at >= ${since}`
                : await tx`SELECT COUNT(*) as total, COALESCE(AVG(cost_total_usd),0) as avg_cost, COALESCE(AVG(wall_clock_seconds),0) as avg_latency, COALESCE(SUM(CASE WHEN status='success' THEN 1 ELSE 0 END)::float/NULLIF(COUNT(*),0),0) as success_rate FROM sessions WHERE org_id = ${orgId} AND created_at >= ${since}`;
            }
            case "issues.summary":
              return await tx`SELECT status, severity, COUNT(*) as count FROM issues WHERE org_id = ${orgId} GROUP BY status, severity`;
            case "eval.latest_run": {
              const an = String(p.agent_name || "");
              return await tx`SELECT * FROM eval_runs WHERE agent_name = ${an} AND org_id = ${orgId} ORDER BY created_at DESC LIMIT 1`;
            }
            case "billing.usage": {
              const sd = Math.min(Number(p.since_days) || 30, 365);
              const since = new Date(Date.now() - sd * 86400 * 1000).toISOString();
              return await tx`SELECT COALESCE(SUM(total_cost_usd),0) as total, COALESCE(SUM(input_tokens),0) as input_tokens, COALESCE(SUM(output_tokens),0) as output_tokens FROM billing_records WHERE org_id = ${orgId} AND created_at >= ${since}`;
            }
            case "billing.by_agent": {
              const sd = Math.min(Number(p.since_days) || 30, 365);
              const since = new Date(Date.now() - sd * 86400 * 1000).toISOString();
              return await tx`SELECT agent_name, SUM(total_cost_usd) as cost, COUNT(*) as sessions FROM billing_records WHERE org_id = ${orgId} AND created_at >= ${since} GROUP BY agent_name ORDER BY cost DESC`;
            }
            case "feedback.stats": {
              const sd = Math.min(Number(p.since_days) || 30, 365);
              const since = new Date(Date.now() - sd * 86400 * 1000).toISOString();
              return await tx`SELECT rating, COUNT(*) as count FROM session_feedback WHERE org_id = ${orgId} AND created_at >= ${since} GROUP BY rating`;
            }
            default:
              throw new Error(`Unknown query_id: ${queryId}. Available: sessions.stats, issues.summary, eval.latest_run, billing.usage, billing.by_agent, feedback.stats`);
          }
        });

        return JSON.stringify({ query_id: queryId, rows, row_count: Array.isArray(rows) ? rows.length : 0 });
      } catch (err: any) {
        return `db-query failed: ${err.message || err}`;
      }
    }

    case "db-batch": {
      // Execute multiple queries in one call — saves tokens vs multiple tool calls
      const queries = args.queries;
      if (!Array.isArray(queries) || queries.length === 0) return "db-batch requires queries array";
      if (queries.length > 10) return "db-batch max 10 queries per batch";

      const orgId = args.org_id || "";
      const hyperdrive = (env as any).HYPERDRIVE;
      if (!hyperdrive) return "db-batch requires database access";

      try {
        // Execute all queries via recursive tool call (reuse db-query logic)
        const results = await Promise.all(
          queries.map(async (q: { query_id: string; params?: Record<string, unknown> }) => {
            const result = await dispatch(
              env, "db-query",
              { query_id: q.query_id, params: q.params || {}, org_id: orgId },
              sessionId,
            );
            try { return JSON.parse(result); } catch { return { query_id: q.query_id, error: result }; }
          }),
        );
        return JSON.stringify({ batch: true, count: results.length, results });
      } catch (err: any) {
        return `db-batch failed: ${err.message || err}`;
      }
    }

    case "db-report": {
      // Pre-built composite reports — agent health, org overview
      const reportId = String(args.report_id || "");
      const orgId = args.org_id || "";
      if (!reportId) return "db-report requires report_id (e.g., 'agent_health', 'org_overview')";

      try {
        if (reportId === "agent_health") {
          const agentName = String(args.agent_name || "");
          if (!agentName) return "agent_health report requires agent_name";
          // Batch 4 queries for a single agent
          const batchResult = await dispatch(env, "db-batch", {
            org_id: orgId,
            queries: [
              { query_id: "sessions.stats", params: { agent_name: agentName, since_days: 7 } },
              { query_id: "issues.summary", params: {} },
              { query_id: "eval.latest_run", params: { agent_name: agentName } },
              { query_id: "feedback.stats", params: { since_days: 7 } },
            ],
          }, sessionId);
          const parsed = JSON.parse(batchResult);
          return JSON.stringify({
            report: "agent_health",
            agent_name: agentName,
            sessions: parsed.results?.[0]?.rows?.[0] || {},
            issues: parsed.results?.[1]?.rows || [],
            eval: parsed.results?.[2]?.rows?.[0] || null,
            feedback: parsed.results?.[3]?.rows || [],
          });
        }

        if (reportId === "org_overview") {
          const batchResult = await dispatch(env, "db-batch", {
            org_id: orgId,
            queries: [
              { query_id: "sessions.stats", params: { since_days: 7 } },
              { query_id: "issues.summary", params: {} },
              { query_id: "billing.usage", params: { since_days: 30 } },
              { query_id: "billing.by_agent", params: { since_days: 30 } },
            ],
          }, sessionId);
          const parsed = JSON.parse(batchResult);
          return JSON.stringify({
            report: "org_overview",
            sessions: parsed.results?.[0]?.rows?.[0] || {},
            issues: parsed.results?.[1]?.rows || [],
            billing: parsed.results?.[2]?.rows?.[0] || {},
            billing_by_agent: parsed.results?.[3]?.rows || [],
          });
        }

        return `Unknown report_id: ${reportId}. Available: agent_health, org_overview`;
      } catch (err: any) {
        return `db-report failed: ${err.message || err}`;
      }
    }

    // ── Agent Lifecycle Tools ──────────────────────────────────────

    case "create-agent": {
      const hyperdrive = (env as any).HYPERDRIVE;
      if (!hyperdrive) return "create-agent requires database access";
      const { getDb } = await import("./db");
      const sql = await getDb(hyperdrive);

      // Enforce org_id from delegation lineage (not raw args) to prevent cross-org creation
      const lineage = (env as any).__delegationLineage;
      const orgId = lineage?.org_id || args.org_id || "";

      const name = String(args.name || "").trim();
      if (!name) return "create-agent requires name";
      if (name.length > 128) return "Agent name must be 128 characters or less";
      if (!/^[a-zA-Z0-9_-]+$/.test(name)) return "Agent name must contain only letters, numbers, hyphens, dashes";

      const desc = String(args.description || "").slice(0, 2000);
      // Generate a useful system prompt that tells the agent about its tools
      const defaultPrompt = (() => {
        const toolList = (Array.isArray(args.tools) ? args.tools : []).filter((t: string) => getValidToolNames().has(t));
        const toolDesc = toolList.length > 0
          ? `\n\nYou have access to these tools and MUST use them when relevant:\n${toolList.map((t: string) => `- ${t}`).join("\n")}\n\nAlways use your tools to get real data. Never guess or make up information when you can search or compute.`
          : "\n\nYou have access to tools including web search, code execution, and file operations. Use them proactively to help the user.";
        return `You are ${name}${desc ? ` — ${desc}` : ""}. You are a helpful AI assistant.${toolDesc}`;
      })();
      const systemPrompt = String(args.system_prompt || defaultPrompt).slice(0, 50000);
      // Don't set a default model — let plan-based routing select the right model at runtime.
      // Only set model if the user explicitly provides one.
      const model = args.model ? String(args.model) : "";
      const plan = String(args.plan || "standard");
      const maxTurns = Math.max(1, Math.min(Number(args.max_turns) || 50, 1000));
      const budgetLimitUsd = Math.max(0, Math.min(Number(args.budget_limit_usd) ?? 10, 10000));

      // Validate tools against catalog — drop unknown tools and warn
      const validToolNames = getValidToolNames();
      const requestedTools = Array.isArray(args.tools) ? args.tools.map(String) : [];
      const invalidTools = requestedTools.filter((t: string) => !validToolNames.has(t));
      const validTools = requestedTools.filter((t: string) => validToolNames.has(t));

      // Enforce org agent limit
      if (orgId) {
        try {
          const countRows = await sql`SELECT COUNT(*)::int as cnt FROM agents WHERE org_id = ${orgId} AND is_active = true`;
          const current = countRows[0]?.cnt || 0;
          const limitRows = await sql`SELECT (limits->>'max_agents')::int as max_agents FROM org_settings WHERE org_id = ${orgId} LIMIT 1`.catch(() => []);
          const maxAgents = limitRows[0]?.max_agents || 50;
          if (current >= maxAgents) {
            return JSON.stringify({ error: `Org has reached agent limit (${maxAgents}). Delete unused agents or upgrade plan.` });
          }
        } catch {} // non-blocking — don't fail creation if limit check fails
      }

      const agentId = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
      const now = new Date().toISOString();
      const reasoningStrategy = args.reasoning_strategy ? String(args.reasoning_strategy) : undefined;
      const configJson = JSON.stringify({
        system_prompt: systemPrompt,
        ...(model ? { model } : {}),
        tools: validTools,
        max_turns: maxTurns,
        plan,
        ...(reasoningStrategy ? { reasoning_strategy: reasoningStrategy } : {}),
        governance: { budget_limit_usd: budgetLimitUsd },
        version: "0.1.0",
      });
      try {
        await sql`
          INSERT INTO agents (agent_id, name, org_id, project_id, config, description, is_active, created_at, updated_at)
          VALUES (${agentId}, ${name}, ${orgId}, ${''}, ${configJson}, ${desc}, 1, ${now}, ${now})
        `;
        const warnings: string[] = [];
        if (invalidTools.length > 0) warnings.push(`Unknown tools dropped: ${invalidTools.join(", ")}`);
        return JSON.stringify({
          created: true, name, agent_id: agentId,
          tools_count: validTools.length,
          model, plan, max_turns: maxTurns, budget_limit_usd: budgetLimitUsd,
          ...(warnings.length > 0 ? { warnings } : {}),
        });
      } catch (err: any) {
        if (String(err.message || err).includes("unique") || String(err.message || err).includes("duplicate")) {
          return JSON.stringify({ error: `Agent '${name}' already exists in this org. Use a different name or update the existing agent.` });
        }
        return `Failed to create agent: ${err.message || err}`;
      }
    }

    case "delete-agent": {
      const hyperdrive = (env as any).HYPERDRIVE;
      if (!hyperdrive) return "delete-agent requires database access";
      const { getDb } = await import("./db");
      const sql = await getDb(hyperdrive);
      const orgId = args.org_id || "";
      const agentName = String(args.agent_name || "");
      if (!agentName) return "delete-agent requires agent_name";
      if (!args.confirm) return "delete-agent requires confirm=true as safety check";
      try {
        await sql`UPDATE agents SET is_active = false WHERE name = ${agentName} AND org_id = ${orgId}`;
        // Cascade: soft-delete related sessions, schedules
        await sql`UPDATE sessions SET status = 'archived' WHERE agent_name = ${agentName} AND org_id = ${orgId}`;
        await sql`DELETE FROM schedules WHERE agent_name = ${agentName} AND org_id = ${orgId}`;
        return JSON.stringify({ deleted: true, agent_name: agentName, mode: "soft" });
      } catch (err: any) {
        return `Failed to delete agent: ${err.message || err}`;
      }
    }

    case "run-agent": {
      // Delegate to a sub-agent via child Workflow (parallel, crash-safe, KV state sharing)
      const agentName = String(args.agent_name || "");
      const task = String(args.task || "");
      if (!agentName || !task) return "run-agent requires agent_name and task";

      const lineage = (env as any).__delegationLineage as Record<string, any> | undefined;
      const orgId = String(args.org_id || lineage?.org_id || "");
      const parentDepth = Number(lineage?.depth) || 0;
      const MAX_DELEGATION_DEPTH = 6;
      if (parentDepth >= MAX_DELEGATION_DEPTH) {
        return JSON.stringify({ output: "", error: "delegation_depth_exceeded", max_depth: MAX_DELEGATION_DEPTH });
      }

      const workflow = (env as any).AGENT_RUN_WORKFLOW;
      const kv = (env as any).AGENT_PROGRESS_KV;

      if (!workflow) {
        return JSON.stringify({ output: "", error: "AGENT_RUN_WORKFLOW binding not available for delegation" });
      }

      try {
        // Spawn child Workflow — runs independently with its own agent config
        const childProgressKey = `child:${sessionId}:${agentName}:${Date.now()}`;
        // If caller specified tools, scope the sub-agent to only those tools
        const toolsOverride = Array.isArray(args.tools) && args.tools.length > 0
          ? args.tools.map(String)
          : undefined;

        const instance = await workflow.create({
          params: {
            agent_name: agentName,
            input: task,
            org_id: orgId,
            project_id: lineage?.project_id || "",
            channel: "delegation",
            channel_user_id: "",
            history: [], // child starts fresh — no parent context
            progress_key: childProgressKey,
            parent_session_id: lineage?.session_id || sessionId,
            parent_depth: parentDepth + 1,
            ...(toolsOverride ? { tools_override: toolsOverride } : {}),
          },
        });

        // Poll for child completion (max 5 min)
        let childOutput = "";
        let childSessionId = "";
        let childCostUsd = 0;
        for (let i = 0; i < 150; i++) {
          await new Promise(r => setTimeout(r, 2000));
          try {
            const st = await instance.status();
            if (st.status === "complete") {
              const out = (st as any).output;
              childOutput = out?.output || "";
              childSessionId = out?.session_id || "";
              childCostUsd = out?.cost_usd || 0;
              break;
            }
            if (st.status === "errored") {
              childOutput = `[Sub-agent error: ${(st as any).error?.message || "unknown"}]`;
              break;
            }
            if (st.status === "terminated") {
              childOutput = "[Sub-agent was terminated]";
              break;
            }
          } catch {}
        }

        const correlationId = crypto.randomUUID().slice(0, 12);
        const parentSessionId = lineage?.session_id || sessionId;
        const parentAgentName = lineage?.agent_name || "unknown";
        const status = childOutput.startsWith("[Sub-agent error") || childOutput.startsWith("[Sub-agent was") ? "failed" : "completed";

        // Write delegation event to DB for observability + audit
        if ((env as any).HYPERDRIVE) {
          try {
            const { getDb } = await import("./db");
            const sql = await getDb((env as any).HYPERDRIVE);
            await sql`
              INSERT INTO delegation_events (parent_session_id, child_session_id, parent_agent_name, child_agent_name, org_id, depth, correlation_id, status, child_cost_usd, input_preview, output_preview, created_at, completed_at)
              VALUES (${parentSessionId}, ${childSessionId}, ${parentAgentName}, ${agentName}, ${orgId}, ${parentDepth + 1}, ${correlationId}, ${status}, ${childCostUsd}, ${task.slice(0, 500)}, ${childOutput.slice(0, 500)}, now(), ${(status as string) !== "running" ? "now()" : null})
            `;
          } catch {} // non-blocking
        }

        return JSON.stringify({
          output: childOutput.slice(0, 9500),
          delegation_trace: {
            parent_session_id: parentSessionId,
            child_session_id: childSessionId,
            parent_agent_name: parentAgentName,
            child_agent_name: agentName,
            child_depth: parentDepth + 1,
            child_cost_usd: childCostUsd,
            correlation_id: correlationId,
            status,
          },
        });
      } catch (err: any) {
        // Write failed delegation event
        if ((env as any).HYPERDRIVE) {
          try {
            const { getDb } = await import("./db");
            const sql = await getDb((env as any).HYPERDRIVE);
            await sql`
              INSERT INTO delegation_events (parent_session_id, child_session_id, parent_agent_name, child_agent_name, org_id, depth, status, error, input_preview, created_at, completed_at)
              VALUES (${lineage?.session_id || sessionId}, '', ${lineage?.agent_name || "unknown"}, ${agentName}, ${orgId}, ${parentDepth + 1}, 'failed', ${(err.message || String(err)).slice(0, 500)}, ${task.slice(0, 500)}, now(), now())
            `;
          } catch {}
        }
        return JSON.stringify({ output: "", error: `Delegation failed: ${err.message || err}` });
      }
    }

    case "eval-agent": {
      const hyperdrive = (env as any).HYPERDRIVE;
      if (!hyperdrive) return "eval-agent requires database access";
      const { getDb } = await import("./db");
      const sql = await getDb(hyperdrive);
      const orgId = args.org_id || "";
      const agentName = String(args.agent_name || "");
      if (!agentName) return "eval-agent requires agent_name";
      const runId = crypto.randomUUID().slice(0, 12);
      const trials = Number(args.trials) || 1;
      try {
        await sql`
          INSERT INTO eval_runs (eval_run_id, agent_name, org_id, status, config, results, pass_rate, total_trials, passed_trials, created_at)
          VALUES (
            ${runId}, ${agentName}, ${orgId}, ${"pending"},
            ${JSON.stringify({ source: "tool:eval-agent" })}, ${JSON.stringify({})},
            ${0}, ${trials}, ${0}, ${new Date().toISOString()}
          )
        `;
        return JSON.stringify({ eval_run_id: runId, agent_name: agentName, status: "pending", trials });
      } catch (err: any) {
        return `Failed to create eval run: ${err.message || err}`;
      }
    }

    case "evolve-agent": {
      // Runs the full evolution analyzer on recent sessions and returns
      // a report + ranked proposals. This is the same logic as POST /evolve/:agent/analyze
      // but callable directly as a meta-agent tool.
      const hyperdrive = (env as any).HYPERDRIVE;
      if (!hyperdrive) return "evolve-agent requires database access";
      const { getDb } = await import("./db");
      const sql = await getDb(hyperdrive);
      const orgId = args.org_id || "";
      const agentName = String(args.agent_name || "");
      if (!agentName) return "evolve-agent requires agent_name";
      const days = Math.min(90, Number(args.days) || 7);
      try {
        // Call the control-plane analyze endpoint which runs the full FailureAnalyzer.
        // The control-plane is a separate CF Worker — call via service binding if available,
        // otherwise fall back to basic stats from direct DB queries.
        const controlPlane = (env as any).CONTROL_PLANE;
        if (controlPlane) {
          const resp = await controlPlane.fetch(
            `https://internal/api/v1/evolve/${agentName}/analyze`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json", "Authorization": "Bearer service-token" },
              body: JSON.stringify({ days }),
            },
          );
          if (resp.ok) {
            const result = await resp.json() as Record<string, unknown>;
            return JSON.stringify({
              agent_name: agentName,
              sessions_analyzed: result.sessions_analyzed || 0,
              report_summary: {
                success_rate: (result.report as any)?.success_rate,
                avg_cost_usd: (result.report as any)?.avg_cost_usd,
                avg_turns: (result.report as any)?.avg_turns,
                recommendations: (result.report as any)?.recommendations,
                failure_clusters: ((result.report as any)?.failure_clusters || []).slice(0, 5),
                unused_tools: (result.report as any)?.unused_tools,
              },
              proposals: ((result.proposals || []) as any[]).map((p: any) => ({
                title: p.title, category: p.category, priority: p.priority,
              })),
              message: "Analysis complete. Proposals stored — review them in the Evolve tab.",
            });
          }
        }

        // Fallback: basic stats from direct DB query
        const since = new Date(Date.now() - days * 86400 * 1000).toISOString();
        const stats = await sql`
          SELECT COUNT(*) as total, COALESCE(AVG(cost_total_usd),0) as avg_cost,
                 COALESCE(SUM(CASE WHEN status='success' THEN 1 ELSE 0 END)::float/NULLIF(COUNT(*),0),0) as success_rate
          FROM sessions WHERE org_id = ${orgId} AND agent_name = ${agentName} AND created_at >= ${since}
        `;
        return JSON.stringify({
          agent_name: agentName, stats: stats[0] || {}, days,
          message: `Basic stats for ${stats[0]?.total || 0} sessions. For full analysis with proposals, use POST /api/v1/evolve/${agentName}/analyze from the portal or control-plane API.`,
        });
      } catch (err: any) {
        return `Failed to analyze agent: ${err.message || err}`;
      }
    }

    case "autoresearch": {
      const hyperdrive = (env as any).HYPERDRIVE;
      if (!hyperdrive) return "autoresearch requires database access";
      const { getDb } = await import("./db");
      const sql = await getDb(hyperdrive);
      const orgId = args.org_id || "";
      const agentName = String(args.agent_name || "");
      if (!agentName) return "autoresearch requires agent_name";
      const runId = crypto.randomUUID().slice(0, 12);
      const maxIter = Number(args.max_iterations) || 10;
      const timeBudget = Number(args.time_budget) || 300;
      try {
        await sql`
          INSERT INTO eval_runs (eval_run_id, agent_name, org_id, status, config, results, pass_rate, total_trials, passed_trials, created_at)
          VALUES (
            ${runId}, ${agentName}, ${orgId}, ${"pending"},
            ${JSON.stringify({ source: "tool:autoresearch" })}, ${JSON.stringify({})},
            ${0}, ${maxIter}, ${0}, ${new Date().toISOString()}
          )
        `;
        return JSON.stringify({ run_id: runId, agent_name: agentName, max_iterations: maxIter, time_budget_seconds: timeBudget, status: "pending" });
      } catch (err: any) {
        return `Failed to start autoresearch: ${err.message || err}`;
      }
    }

    case "list-agents": {
      const hyperdrive = (env as any).HYPERDRIVE;
      if (!hyperdrive) return "[]";
      const { getDb } = await import("./db");
      const sql = await getDb(hyperdrive);
      const orgId = args.org_id || "";
      try {
        const rows = await sql`
          SELECT name, description, config, is_active, created_at
          FROM agents WHERE org_id = ${orgId} AND is_active = true
          ORDER BY created_at DESC LIMIT 100
        `;
        // Extract model from config for display
        const enriched = rows.map((r: any) => {
          const cfg = parseJsonColumn(r.config);
          return { name: r.name, description: r.description, model: cfg.model || "default", is_active: r.is_active, created_at: r.created_at };
        });
        return JSON.stringify(enriched);
      } catch {
        return "[]";
      }
    }

    case "list-tools": {
      const allTools = effectiveToolDefs();
      const summary = allTools.map((t) => ({
        name: t.function.name,
        description: t.function.description,
      }));
      return JSON.stringify(summary);
    }

    // ── Platform Operations Tools ───────────────────────────────────

    case "security-scan": {
      const hyperdrive = (env as any).HYPERDRIVE;
      if (!hyperdrive) return "security-scan requires database access";
      const { getDb } = await import("./db");
      const sql = await getDb(hyperdrive);
      const orgId = args.org_id || "";
      const agentName = String(args.agent_name || "");
      if (!agentName) return "security-scan requires agent_name";
      try {
        const agent = await sql`SELECT name, config FROM agents WHERE name = ${agentName} AND org_id = ${orgId} LIMIT 1`;
        if (agent.length === 0) return JSON.stringify({ error: "Agent not found" });
        const cfg = parseJsonColumn(agent[0].config);
        const tools = Array.isArray(cfg.tools) ? cfg.tools : [];
        // Basic OWASP LLM Top 10 probe checks
        const findings: { probe: string; risk: string; detail: string }[] = [];
        const prompt = String(cfg.system_prompt || cfg.systemPrompt || "").toLowerCase();
        if (prompt.includes("ignore previous") || prompt.includes("ignore all"))
          findings.push({ probe: "prompt_injection_susceptibility", risk: "high", detail: "System prompt may be vulnerable to injection override" });
        if (tools.includes("bash") || tools.includes("python-exec"))
          findings.push({ probe: "code_execution_enabled", risk: "medium", detail: "Agent has code execution tools — ensure sandbox isolation" });
        if (!prompt.includes("do not") && !prompt.includes("never") && !prompt.includes("refuse"))
          findings.push({ probe: "missing_guardrails", risk: "medium", detail: "System prompt lacks explicit refusal instructions" });
        if (tools.length > 20)
          findings.push({ probe: "excessive_tools", risk: "low", detail: `Agent has ${tools.length} tools — consider reducing attack surface` });
        const riskScore = findings.reduce((s, f) => s + (f.risk === "high" ? 3 : f.risk === "medium" ? 2 : 1), 0);
        return JSON.stringify({ agent_name: agentName, risk_score: riskScore, findings, tools_count: tools.length });
      } catch (err: any) {
        return `Security scan failed: ${err.message || err}`;
      }
    }

    case "conversation-intel": {
      const hyperdrive = (env as any).HYPERDRIVE;
      if (!hyperdrive) return "conversation-intel requires database access";
      const { getDb } = await import("./db");
      const sql = await getDb(hyperdrive);
      const orgId = args.org_id || "";
      const sinceDays = Math.min(Number(args.since_days) || 7, 90);
      const since = new Date(Date.now() - sinceDays * 86400 * 1000).toISOString();
      const agentName = args.agent_name ? String(args.agent_name) : null;
      try {
        const rows = agentName
          ? await sql`SELECT COUNT(*) as sessions, COALESCE(AVG(cost_total_usd),0) as avg_cost, COALESCE(AVG(wall_clock_seconds),0) as avg_latency, COALESCE(SUM(CASE WHEN status='success' THEN 1 ELSE 0 END)::float/NULLIF(COUNT(*),0),0) as success_rate FROM sessions WHERE org_id = ${orgId} AND agent_name = ${agentName} AND created_at >= ${since}`
          : await sql`SELECT COUNT(*) as sessions, COALESCE(AVG(cost_total_usd),0) as avg_cost, COALESCE(AVG(wall_clock_seconds),0) as avg_latency, COALESCE(SUM(CASE WHEN status='success' THEN 1 ELSE 0 END)::float/NULLIF(COUNT(*),0),0) as success_rate FROM sessions WHERE org_id = ${orgId} AND created_at >= ${since}`;
        return JSON.stringify({ agent_name: agentName, since_days: sinceDays, ...(rows[0] || {}) });
      } catch (err: any) {
        return `Conversation intel failed: ${err.message || err}`;
      }
    }

    case "manage-issues": {
      const hyperdrive = (env as any).HYPERDRIVE;
      if (!hyperdrive) return "manage-issues requires database access";
      const { getDb } = await import("./db");
      const sql = await getDb(hyperdrive);
      const orgId = args.org_id || "";
      const action = String(args.action || "list");
      try {
        if (action === "list") {
          const agentName = args.agent_name ? String(args.agent_name) : null;
          const rows = agentName
            ? await sql`SELECT issue_id, agent_name, title, severity, status, created_at FROM issues WHERE org_id = ${orgId} AND agent_name = ${agentName} ORDER BY created_at DESC LIMIT 50`
            : await sql`SELECT issue_id, agent_name, title, severity, status, created_at FROM issues WHERE org_id = ${orgId} ORDER BY created_at DESC LIMIT 50`;
          return JSON.stringify(rows);
        }
        if (action === "create") {
          const issueId = crypto.randomUUID().slice(0, 12);
          const title = String(args.title || "Untitled issue");
          const desc = String(args.description || "");
          const agentName = String(args.agent_name || "");
          await sql`
            INSERT INTO issues (issue_id, org_id, agent_name, title, description, severity, status, created_at)
            VALUES (${issueId}, ${orgId}, ${agentName}, ${title}, ${desc}, 'medium', 'open', ${new Date().toISOString()})
          `;
          return JSON.stringify({ created: true, issue_id: issueId });
        }
        if (action === "auto-fix") {
          const issueId = String(args.issue_id || "");
          if (!issueId) return "auto-fix requires issue_id";
          await sql`UPDATE issues SET status = 'resolved', resolved_at = ${new Date().toISOString()} WHERE issue_id = ${issueId} AND org_id = ${orgId}`;
          return JSON.stringify({ resolved: true, issue_id: issueId });
        }
        return `Unknown action: ${action}. Use list, create, or auto-fix.`;
      } catch (err: any) {
        return `manage-issues failed: ${err.message || err}`;
      }
    }

    case "compliance": {
      const hyperdrive = (env as any).HYPERDRIVE;
      if (!hyperdrive) return "compliance requires database access";
      const { getDb } = await import("./db");
      const sql = await getDb(hyperdrive);
      const orgId = args.org_id || "";
      const agentName = String(args.agent_name || "");
      if (!agentName) return "compliance requires agent_name";
      try {
        const agent = await sql`SELECT name, config FROM agents WHERE name = ${agentName} AND org_id = ${orgId} LIMIT 1`;
        if (agent.length === 0) return JSON.stringify({ error: "Agent not found" });
        const cfg = parseJsonColumn(agent[0].config);
        const governance = cfg.governance || {};
        const checks = {
          has_system_prompt: Boolean(cfg.system_prompt || cfg.systemPrompt),
          has_governance: Boolean(governance.budget_limit_usd),
          has_budget_limit: (governance.budget_limit_usd || 0) > 0,
          tools_count: (Array.isArray(cfg.tools) ? cfg.tools : []).length,
          compliant: Boolean(cfg.system_prompt || cfg.systemPrompt) && (governance.budget_limit_usd || 0) > 0,
        };
        return JSON.stringify({ agent_name: agentName, compliance: checks });
      } catch (err: any) {
        return `Compliance check failed: ${err.message || err}`;
      }
    }

    case "view-costs": {
      const hyperdrive = (env as any).HYPERDRIVE;
      if (!hyperdrive) return "view-costs requires database access";
      const { getDb } = await import("./db");
      const sql = await getDb(hyperdrive);
      const orgId = args.org_id || "";
      const sinceDays = Math.min(Number(args.since_days) || 30, 365);
      const since = new Date(Date.now() - sinceDays * 86400 * 1000).toISOString();
      const agentName = args.agent_name ? String(args.agent_name) : null;
      try {
        if (agentName) {
          const rows = await sql`SELECT COALESCE(SUM(total_cost_usd),0) as total, COUNT(*) as sessions FROM billing_records WHERE org_id = ${orgId} AND agent_name = ${agentName} AND created_at >= ${since}`;
          return JSON.stringify({ agent_name: agentName, since_days: sinceDays, ...(rows[0] || {}) });
        }
        const rows = await sql`SELECT agent_name, SUM(total_cost_usd) as cost, COUNT(*) as sessions FROM billing_records WHERE org_id = ${orgId} AND created_at >= ${since} GROUP BY agent_name ORDER BY cost DESC`;
        return JSON.stringify({ since_days: sinceDays, by_agent: rows });
      } catch (err: any) {
        return `view-costs failed: ${err.message || err}`;
      }
    }

    case "view-traces": {
      const hyperdrive = (env as any).HYPERDRIVE;
      if (!hyperdrive) return "view-traces requires database access";
      const { getDb } = await import("./db");
      const sql = await getDb(hyperdrive);
      const orgId = args.org_id || "";
      const limit = Math.min(Number(args.limit) || 20, 100);
      const agentName = args.agent_name ? String(args.agent_name) : null;
      const statusFilter = args.status ? String(args.status) : null;
      try {
        let rows;
        if (agentName && statusFilter) {
          rows = await sql`SELECT session_id, agent_name, status, cost_total_usd, wall_clock_seconds, created_at FROM sessions WHERE org_id = ${orgId} AND agent_name = ${agentName} AND status = ${statusFilter} ORDER BY created_at DESC LIMIT ${limit}`;
        } else if (agentName) {
          rows = await sql`SELECT session_id, agent_name, status, cost_total_usd, wall_clock_seconds, created_at FROM sessions WHERE org_id = ${orgId} AND agent_name = ${agentName} ORDER BY created_at DESC LIMIT ${limit}`;
        } else if (statusFilter) {
          rows = await sql`SELECT session_id, agent_name, status, cost_total_usd, wall_clock_seconds, created_at FROM sessions WHERE org_id = ${orgId} AND status = ${statusFilter} ORDER BY created_at DESC LIMIT ${limit}`;
        } else {
          rows = await sql`SELECT session_id, agent_name, status, cost_total_usd, wall_clock_seconds, created_at FROM sessions WHERE org_id = ${orgId} ORDER BY created_at DESC LIMIT ${limit}`;
        }
        return JSON.stringify(rows);
      } catch (err: any) {
        return `view-traces failed: ${err.message || err}`;
      }
    }

    case "manage-releases": {
      const hyperdrive = (env as any).HYPERDRIVE;
      if (!hyperdrive) return "manage-releases requires database access";
      const { getDb } = await import("./db");
      const sql = await getDb(hyperdrive);
      const orgId = args.org_id || "";
      const action = String(args.action || "list");
      const agentName = String(args.agent_name || "");
      try {
        if (action === "list") {
          const rows = await sql`SELECT agent_name, channel, version, promoted_at FROM release_channels WHERE org_id = ${orgId} ${agentName ? sql`AND agent_name = ${agentName}` : sql``} ORDER BY promoted_at DESC LIMIT 50`;
          return JSON.stringify(rows);
        }
        if (action === "promote") {
          if (!agentName) return "promote requires agent_name";
          const toChannel = String(args.to_channel || "staging");
          const releaseId = crypto.randomUUID().slice(0, 12);
          await sql`
            INSERT INTO release_channels (id, org_id, agent_name, channel, version, promoted_at)
            VALUES (${releaseId}, ${orgId}, ${agentName}, ${toChannel}, 'latest', ${new Date().toISOString()})
          `;
          return JSON.stringify({ promoted: true, agent_name: agentName, channel: toChannel });
        }
        if (action === "canary") {
          if (!agentName) return "canary requires agent_name";
          const weight = Math.min(Math.max(Number(args.canary_weight) || 0.1, 0), 1);
          await sql`
            INSERT INTO release_channels (id, org_id, agent_name, channel, version, promoted_at)
            VALUES (${crypto.randomUUID().slice(0, 12)}, ${orgId}, ${agentName}, 'canary', ${String(weight)}, ${new Date().toISOString()})
          `;
          return JSON.stringify({ canary: true, agent_name: agentName, weight });
        }
        return `Unknown action: ${action}. Use list, promote, or canary.`;
      } catch (err: any) {
        return `manage-releases failed: ${err.message || err}`;
      }
    }

    case "manage-slos": {
      const hyperdrive = (env as any).HYPERDRIVE;
      if (!hyperdrive) return "manage-slos requires database access";
      const { getDb } = await import("./db");
      const sql = await getDb(hyperdrive);
      const orgId = args.org_id || "";
      const action = String(args.action || "list");
      try {
        if (action === "list") {
          const rows = await sql`SELECT slo_id, agent_name, metric, threshold, created_at FROM slo_definitions WHERE org_id = ${orgId} ORDER BY created_at DESC LIMIT 50`;
          return JSON.stringify(rows);
        }
        if (action === "create") {
          const agentName = String(args.agent_name || "");
          const metric = String(args.metric || "success_rate");
          const threshold = Number(args.threshold) || 0.95;
          const sloId = crypto.randomUUID().slice(0, 12);
          await sql`
            INSERT INTO slo_definitions (slo_id, org_id, agent_name, metric, threshold, created_at)
            VALUES (${sloId}, ${orgId}, ${agentName}, ${metric}, ${threshold}, ${new Date().toISOString()})
          `;
          return JSON.stringify({ created: true, slo_id: sloId, metric, threshold });
        }
        if (action === "check") {
          const agentName = String(args.agent_name || "");
          const slos = await sql`SELECT slo_id, metric, threshold FROM slo_definitions WHERE org_id = ${orgId} AND agent_name = ${agentName}`;
          return JSON.stringify({ agent_name: agentName, slos, message: "Compare thresholds against session stats from view-traces or db-query" });
        }
        return `Unknown action: ${action}. Use list, create, or check.`;
      } catch (err: any) {
        return `manage-slos failed: ${err.message || err}`;
      }
    }

    case "view-audit": {
      const hyperdrive = (env as any).HYPERDRIVE;
      if (!hyperdrive) return "view-audit requires database access";
      const { getDb } = await import("./db");
      const sql = await getDb(hyperdrive);
      const orgId = args.org_id || "";
      const sinceDays = Math.min(Number(args.since_days) || 7, 90);
      const since = new Date(Date.now() - sinceDays * 86400 * 1000).toISOString();
      const actionFilter = args.action_filter ? String(args.action_filter) : null;
      try {
        const rows = actionFilter
          ? await sql`SELECT user_id, action, resource_type, resource_id, created_at FROM audit_log WHERE org_id = ${orgId} AND action ILIKE ${"%" + actionFilter + "%"} AND created_at >= ${since} ORDER BY created_at DESC LIMIT 100`
          : await sql`SELECT user_id, action, resource_type, resource_id, created_at FROM audit_log WHERE org_id = ${orgId} AND created_at >= ${since} ORDER BY created_at DESC LIMIT 100`;
        return JSON.stringify(rows);
      } catch (err: any) {
        return `view-audit failed: ${err.message || err}`;
      }
    }

    case "manage-secrets": {
      const hyperdrive = (env as any).HYPERDRIVE;
      if (!hyperdrive) return "manage-secrets requires database access";
      const { getDb } = await import("./db");
      const sql = await getDb(hyperdrive);
      const orgId = args.org_id || "";
      const action = String(args.action || "list");
      try {
        if (action === "list") {
          // Never return values
          const rows = await sql`SELECT name, created_at FROM secrets WHERE org_id = ${orgId} ORDER BY name`;
          return JSON.stringify(rows);
        }
        if (action === "create" || action === "set") {
          const name = String(args.name || "");
          const value = String(args.value || "");
          if (!name || !value) return "create requires name and value";
          // Encrypt value using pgcrypto — ENCRYPTION_KEY must be set in env
          const encKey = (env as any).SECRETS_ENCRYPTION_KEY || "";
          if (!encKey) return "Server misconfiguration: SECRETS_ENCRYPTION_KEY not set. Cannot store secrets securely.";
          await sql`
            INSERT INTO secrets (name, org_id, encrypted_value, created_at)
            VALUES (${name}, ${orgId}, pgp_sym_encrypt(${value}, ${encKey}), ${new Date().toISOString()})
            ON CONFLICT (name, org_id) DO UPDATE SET encrypted_value = pgp_sym_encrypt(EXCLUDED.encrypted_value::text, ${encKey})
          `;
          return JSON.stringify({ stored: true, name });
        }
        if (action === "rotate") {
          const name = String(args.name || "");
          const value = String(args.value || "");
          if (!name || !value) return "rotate requires name and new value";
          const encKey = (env as any).SECRETS_ENCRYPTION_KEY || "";
          if (!encKey) return "Server misconfiguration: SECRETS_ENCRYPTION_KEY not set.";
          await sql`UPDATE secrets SET encrypted_value = pgp_sym_encrypt(${value}, ${encKey}) WHERE name = ${name} AND org_id = ${orgId}`;
          return JSON.stringify({ rotated: true, name });
        }
        if (action === "delete") {
          const name = String(args.name || "");
          if (!name) return "delete requires name";
          await sql`DELETE FROM secrets WHERE name = ${name} AND org_id = ${orgId}`;
          return JSON.stringify({ deleted: true, name });
        }
        return `Unknown action: ${action}. Use list, create, rotate, or delete.`;
      } catch (err: any) {
        return `manage-secrets failed: ${err.message || err}`;
      }
    }

    case "compare-agents": {
      const hyperdrive = (env as any).HYPERDRIVE;
      if (!hyperdrive) return "compare-agents requires database access";
      const { getDb } = await import("./db");
      const sql = await getDb(hyperdrive);
      const orgId = args.org_id || "";
      const agentA = String(args.agent_a || "");
      const agentB = String(args.agent_b || "");
      if (!agentA || !agentB) return "compare-agents requires agent_a and agent_b";
      try {
        const since = new Date(Date.now() - 7 * 86400 * 1000).toISOString();
        const statsA = await sql`SELECT COUNT(*) as total, COALESCE(AVG(cost_total_usd),0) as avg_cost, COALESCE(SUM(CASE WHEN status='success' THEN 1 ELSE 0 END)::float/NULLIF(COUNT(*),0),0) as success_rate FROM sessions WHERE org_id = ${orgId} AND agent_name = ${agentA} AND created_at >= ${since}`;
        const statsB = await sql`SELECT COUNT(*) as total, COALESCE(AVG(cost_total_usd),0) as avg_cost, COALESCE(SUM(CASE WHEN status='success' THEN 1 ELSE 0 END)::float/NULLIF(COUNT(*),0),0) as success_rate FROM sessions WHERE org_id = ${orgId} AND agent_name = ${agentB} AND created_at >= ${since}`;
        return JSON.stringify({ agent_a: { name: agentA, ...(statsA[0] || {}) }, agent_b: { name: agentB, ...(statsB[0] || {}) } });
      } catch (err: any) {
        return `compare-agents failed: ${err.message || err}`;
      }
    }

    case "manage-rag": {
      const action = String(args.action || "status");
      const agentName = String(args.agent_name || "");
      if (!agentName) return "manage-rag requires agent_name";
      const storage = (env as any).STORAGE as R2Bucket;
      if (!storage) return "manage-rag requires R2 storage access";
      try {
        const listResult = await storage.list({ prefix: `rag/${agentName}/`, limit: 50 });
        const docs = listResult.objects.map((o: any) => ({ key: o.key, size: o.size, uploaded: o.uploaded }));
        return JSON.stringify({ agent_name: agentName, document_count: docs.length, documents: docs });
      } catch (err: any) {
        return `manage-rag failed: ${err.message || err}`;
      }
    }

    case "manage-policies": {
      const hyperdrive = (env as any).HYPERDRIVE;
      if (!hyperdrive) return "manage-policies requires database access";
      const { getDb } = await import("./db");
      const sql = await getDb(hyperdrive);
      const orgId = args.org_id || "";
      const action = String(args.action || "list");
      try {
        if (action === "list") {
          const rows = await sql`SELECT policy_id, name, policy, created_at FROM policy_templates WHERE org_id = ${orgId} ORDER BY created_at DESC LIMIT 50`;
          return JSON.stringify(rows);
        }
        if (action === "create") {
          const name = String(args.name || "default");
          const budgetLimit = Number(args.budget_limit_usd) || 10.0;
          const blockedTools = Array.isArray(args.blocked_tools) ? args.blocked_tools : [];
          const policyJson = JSON.stringify({ budget_limit_usd: budgetLimit, blocked_tools: blockedTools });
          const policyId = crypto.randomUUID().slice(0, 12);
          await sql`
            INSERT INTO policy_templates (policy_id, org_id, name, policy, created_at)
            VALUES (${policyId}, ${orgId}, ${name}, ${policyJson}, ${new Date().toISOString()})
          `;
          return JSON.stringify({ created: true, policy_id: policyId, name, budget_limit_usd: budgetLimit });
        }
        return `Unknown action: ${action}. Use list or create.`;
      } catch (err: any) {
        return `manage-policies failed: ${err.message || err}`;
      }
    }

    case "manage-retention": {
      const hyperdrive = (env as any).HYPERDRIVE;
      if (!hyperdrive) return "manage-retention requires database access";
      const { getDb } = await import("./db");
      const sql = await getDb(hyperdrive);
      const orgId = args.org_id || "";
      const action = String(args.action || "list");
      try {
        if (action === "list") {
          const rows = await sql`SELECT policy_id, resource_type, retention_days, created_at FROM retention_policies WHERE org_id = ${orgId} ORDER BY resource_type`;
          return JSON.stringify(rows);
        }
        if (action === "apply") {
          return JSON.stringify({ message: "Retention policies are applied automatically by the background worker." });
        }
        return `Unknown action: ${action}. Use list or apply.`;
      } catch (err: any) {
        return `manage-retention failed: ${err.message || err}`;
      }
    }

    case "manage-workflows": {
      const hyperdrive = (env as any).HYPERDRIVE;
      if (!hyperdrive) return "manage-workflows requires database access";
      const { getDb } = await import("./db");
      const sql = await getDb(hyperdrive);
      const orgId = args.org_id || "";
      const action = String(args.action || "list");
      try {
        if (action === "list") {
          const rows = await sql`SELECT workflow_id, name, status, steps, created_at FROM workflows WHERE org_id = ${orgId} ORDER BY created_at DESC LIMIT 50`;
          return JSON.stringify(rows);
        }
        if (action === "create") {
          const name = String(args.name || "");
          if (!name) return "create requires name";
          const steps = Array.isArray(args.steps) ? JSON.stringify(args.steps) : "[]";
          const wfId = crypto.randomUUID().slice(0, 12);
          await sql`
            INSERT INTO workflows (workflow_id, org_id, name, steps, status, created_at)
            VALUES (${wfId}, ${orgId}, ${name}, ${steps}, 'draft', ${new Date().toISOString()})
          `;
          return JSON.stringify({ created: true, workflow_id: wfId, name });
        }
        if (action === "validate") {
          const steps = Array.isArray(args.steps) ? args.steps : [];
          const valid = steps.length > 0 && steps.every((s: any) => s.agent_name || s.tool);
          return JSON.stringify({ valid, step_count: steps.length, message: valid ? "Workflow is valid" : "Each step needs agent_name or tool" });
        }
        return `Unknown action: ${action}. Use list, create, or validate.`;
      } catch (err: any) {
        return `manage-workflows failed: ${err.message || err}`;
      }
    }

    case "manage-projects": {
      const hyperdrive = (env as any).HYPERDRIVE;
      if (!hyperdrive) return "manage-projects requires database access";
      const { getDb } = await import("./db");
      const sql = await getDb(hyperdrive);
      const orgId = args.org_id || "";
      try {
        const rows = await sql`SELECT project_id, name, slug, description, default_plan, created_at FROM projects WHERE org_id = ${orgId} ORDER BY created_at DESC LIMIT 50`;
        return JSON.stringify(rows);
      } catch (err: any) {
        return `manage-projects failed: ${err.message || err}`;
      }
    }

    case "manage-mcp": {
      const hyperdrive = (env as any).HYPERDRIVE;
      if (!hyperdrive) return "manage-mcp requires database access";
      const { getDb } = await import("./db");
      const sql = await getDb(hyperdrive);
      const orgId = args.org_id || "";
      const action = String(args.action || "list");
      try {
        if (action === "list") {
          const rows = await sql`SELECT server_id, name, url, status, created_at FROM mcp_servers WHERE org_id = ${orgId} ORDER BY created_at DESC LIMIT 50`;
          return JSON.stringify(rows);
        }
        if (action === "register") {
          const name = String(args.name || "");
          const url = String(args.url || "");
          if (!name || !url) return "register requires name and url";
          const mcpId = crypto.randomUUID().slice(0, 12);
          await sql`
            INSERT INTO mcp_servers (server_id, org_id, name, url, status, created_at)
            VALUES (${mcpId}, ${orgId}, ${name}, ${url}, 'active', ${new Date().toISOString()})
          `;
          return JSON.stringify({ registered: true, mcp_id: mcpId, name, url });
        }
        return `Unknown action: ${action}. Use list or register.`;
      } catch (err: any) {
        return `manage-mcp failed: ${err.message || err}`;
      }
    }

    case "manage-voice": {
      const hyperdrive = (env as any).HYPERDRIVE;
      if (!hyperdrive) return "manage-voice requires database access";
      const { getDb } = await import("./db");
      const sql = await getDb(hyperdrive);
      const orgId = args.org_id || "";
      const action = String(args.action || "list");
      try {
        if (action === "list") {
          const rows = await sql`SELECT * FROM voice_calls WHERE org_id = ${orgId} ORDER BY created_at DESC LIMIT 20`.catch(() => []);
          return JSON.stringify({ calls: rows, count: rows.length });
        }
        return `Unknown action: ${action}. Use list.`;
      } catch (err: any) {
        return `manage-voice failed: ${err.message || err}`;
      }
    }

    case "make-voice-call": {
      const hyperdrive = (env as any).HYPERDRIVE;
      if (!hyperdrive) return "make-voice-call requires database access";
      const { getDb } = await import("./db");
      const sql = await getDb(hyperdrive);
      const orgId = args.org_id || "";
      const customerPhone = String(args.phone_number || "").trim();
      const agentName = String(args.agent_name || "").trim();
      const firstMessage = String(args.first_message || "").trim() || undefined;

      if (!customerPhone) return "phone_number is required (E.164 format, e.g. +15551234567)";

      try {
        // Look up the agent's voice config for Vapi IDs
        const agentRows = await sql`
          SELECT config FROM agents
          WHERE name = ${agentName} AND org_id = ${orgId} LIMIT 1
        `.catch(() => []);
        if (agentRows.length === 0) return `Agent '${agentName}' not found or no voice config`;

        const config = typeof agentRows[0].config === "string"
          ? JSON.parse(agentRows[0].config)
          : agentRows[0].config ?? {};
        const voiceCfg = config.voice || {};
        const assistantId = String(voiceCfg.vapi_assistant_id || "");
        const phoneNumberId = String(voiceCfg.vapi_phone_number_id || "");

        if (!assistantId || !phoneNumberId) {
          return "Agent does not have a Vapi assistant and phone number linked. Set up voice first.";
        }

        // Call control-plane's outbound call endpoint via Hyperdrive
        // We construct the Vapi API call directly since we're in the runtime
        const vapiKey = (env as any).VAPI_API_KEY || "";
        if (!vapiKey) return "VAPI_API_KEY not configured on runtime";

        const vapiBody: Record<string, unknown> = {
          assistantId,
          phoneNumberId,
          customer: { number: customerPhone },
        };
        if (firstMessage) {
          vapiBody.assistantOverrides = { firstMessage };
        }

        const resp = await fetch("https://api.vapi.ai/call", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${vapiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(vapiBody),
        });

        if (!resp.ok) {
          const errText = await resp.text().catch(() => "");
          return `Vapi API error (${resp.status}): ${errText.slice(0, 200)}`;
        }

        const data = await resp.json() as Record<string, unknown>;
        const callId = String(data.id ?? "");

        // Record the call
        if (callId) {
          await sql`
            INSERT INTO voice_calls (call_id, platform, org_id, agent_name, phone_number, direction, status, platform_agent_id, started_at)
            VALUES (${callId}, 'vapi', ${orgId}, ${agentName}, ${customerPhone}, 'outbound', 'pending', ${assistantId}, now())
            ON CONFLICT (call_id) DO UPDATE SET status = 'pending', phone_number = ${customerPhone}
          `.catch(() => {});
        }

        return JSON.stringify({
          success: true,
          call_id: callId,
          phone_number: customerPhone,
          message: `Outbound call initiated to ${customerPhone}`,
        });
      } catch (err: any) {
        return `make-voice-call failed: ${err.message || err}`;
      }
    }

    case "manage-gpu": {
      const hyperdrive = (env as any).HYPERDRIVE;
      if (!hyperdrive) return "manage-gpu requires database access";
      const { getDb } = await import("./db");
      const sql = await getDb(hyperdrive);
      const orgId = args.org_id || "";
      const action = String(args.action || "list");
      try {
        if (action === "list") {
          const rows = await sql`SELECT * FROM gpu_endpoints WHERE org_id = ${orgId} ORDER BY created_at DESC`.catch(() => []);
          return JSON.stringify({ endpoints: rows, count: rows.length });
        }
        if (action === "provision") {
          const gpuType = String(args.gpu_type || "h100");
          const modelId = String(args.model_id || "");
          const gpuId = crypto.randomUUID().slice(0, 12);
          await sql`
            INSERT INTO gpu_endpoints (id, org_id, model_id, gpu_type, status, created_at)
            VALUES (${gpuId}, ${orgId}, ${modelId}, ${gpuType}, 'provisioning', ${new Date().toISOString()})
          `;
          return JSON.stringify({ provisioned: true, gpu_id: gpuId, gpu_type: gpuType });
        }
        if (action === "terminate") {
          const gpuId = String(args.gpu_id || "");
          if (!gpuId) return "terminate requires gpu_id";
          await sql`UPDATE gpu_endpoints SET status = 'terminated' WHERE id = ${gpuId} AND org_id = ${orgId}`;
          return JSON.stringify({ terminated: true, gpu_id: gpuId });
        }
        return `Unknown action: ${action}. Use list, provision, or terminate.`;
      } catch (err: any) {
        return `manage-gpu failed: ${err.message || err}`;
      }
    }

    // ── Git Tools (SWE-agent ACI pattern: version control for deployed agents) ──
    // All git tools check for git availability first and return a helpful error if not installed.

    case "git-init": {
      const sandbox = getSafeSandbox(env, stableSandboxId(env, sessionId));
      const gitCheck = await sandbox.exec("which git 2>/dev/null", { timeout: 5 }).catch(() => ({ stdout: "" }));
      if (!gitCheck.stdout?.trim()) return "Error: git is not installed in this sandbox. Ask your admin to add git to the sandbox base image.";
      const workDir = args.path || "/workspace";
      const r = await sandbox.exec(
        `cd "${workDir}" && git init && git add -A && git commit -m "initial commit" --allow-empty 2>&1`,
        { timeout: 15 },
      );
      return r.stdout || r.stderr || "Git initialized";
    }

    case "git-status": {
      const sandbox = getSafeSandbox(env, stableSandboxId(env, sessionId));
      const workDir = args.path || "/workspace";
      const r = await sandbox.exec(`cd "${workDir}" && git status 2>&1`, { timeout: 10 });
      return r.stdout || r.stderr || "Not a git repository";
    }

    case "git-diff": {
      const sandbox = getSafeSandbox(env, stableSandboxId(env, sessionId));
      const workDir = args.path || "/workspace";
      const target = args.target || "";
      const r = await sandbox.exec(
        `cd "${workDir}" && git diff ${target} 2>&1 | head -500`,
        { timeout: 15 },
      );
      if (!r.stdout?.trim()) return "No changes detected";
      const lines = (r.stdout || "").split("\n");
      if (lines.length >= 500) return `[Diff truncated at 500 lines — use a more specific path]\n${r.stdout}`;
      return r.stdout;
    }

    case "git-commit": {
      const sandbox = getSafeSandbox(env, stableSandboxId(env, sessionId));
      const workDir = args.path || "/workspace";
      const message = args.message || "checkpoint";
      const r = await sandbox.exec(
        `cd "${workDir}" && git add -A && git commit -m "${message.replace(/"/g, '\\"')}" 2>&1`,
        { timeout: 15 },
      );
      return r.stdout || r.stderr || "Nothing to commit";
    }

    case "git-log": {
      const sandbox = getSafeSandbox(env, stableSandboxId(env, sessionId));
      const workDir = args.path || "/workspace";
      const count = Math.min(30, Number(args.count) || 10);
      const r = await sandbox.exec(
        `cd "${workDir}" && git log --oneline -${count} 2>&1`,
        { timeout: 10 },
      );
      return r.stdout || r.stderr || "No commits yet";
    }

    case "git-branch": {
      const sandbox = getSafeSandbox(env, stableSandboxId(env, sessionId));
      const workDir = args.path || "/workspace";
      const action = args.action || "list";
      const name = args.name || "";
      if (action === "create" && name) {
        const r = await sandbox.exec(`cd "${workDir}" && git checkout -b "${name.replace(/"/g, '\\"')}" 2>&1`, { timeout: 10 });
        return r.stdout || r.stderr || `Created branch ${name}`;
      }
      if (action === "switch" && name) {
        const r = await sandbox.exec(`cd "${workDir}" && git checkout "${name.replace(/"/g, '\\"')}" 2>&1`, { timeout: 10 });
        return r.stdout || r.stderr || `Switched to ${name}`;
      }
      const r = await sandbox.exec(`cd "${workDir}" && git branch -a 2>&1`, { timeout: 10 });
      return r.stdout || r.stderr || "No branches";
    }

    case "git-stash": {
      const sandbox = getSafeSandbox(env, stableSandboxId(env, sessionId));
      const workDir = args.path || "/workspace";
      const action = args.action || "push";
      const r = await sandbox.exec(`cd "${workDir}" && git stash ${action} 2>&1`, { timeout: 10 });
      return r.stdout || r.stderr || "Stash operation complete";
    }

    case "self-check": {
      // Rate limit: max 10 self-check calls per session (bounded LRU map)
      if (checkToolRateLimit("self-check", args.session_id, 10)) {
        return "self-check rate limit reached (max 10 per session). Use the information you already have.";
      }

      const hyperdrive = (env as any).HYPERDRIVE;
      if (!hyperdrive) return "self-check requires database access";
      const { getDb } = await import("./db");
      const sql = await getDb(hyperdrive);
      const orgId = args.org_id || "";
      const agentName = String(args.agent_name || "");
      if (!agentName) return "self-check requires agent_name";
      const check = String(args.check || "health");
      const ALLOWED_CHECKS = ["performance", "slo", "proposals", "health"];
      if (!ALLOWED_CHECKS.includes(check)) {
        return `Invalid check type: ${check}. Allowed: ${ALLOWED_CHECKS.join(", ")}`;
      }

      try {
        // Helper: query performance from last 20 sessions
        const queryPerformance = async () => {
          const rows = await sql`
            SELECT
              COUNT(*) as total_sessions,
              COALESCE(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END)::float / NULLIF(COUNT(*), 0), 0) as success_rate,
              COALESCE(AVG(cost_total_usd), 0) as avg_cost,
              COALESCE(AVG(step_count), 0) as avg_turns,
              COALESCE(AVG(wall_clock_seconds), 0) as avg_latency,
              COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0) as error_count
            FROM (
              SELECT status, cost_total_usd, step_count, wall_clock_seconds
              FROM sessions
              WHERE org_id = ${orgId} AND agent_name = ${agentName}
              ORDER BY created_at DESC
              LIMIT 20
            ) recent
          `;
          return rows[0] || { total_sessions: 0, success_rate: 0, avg_cost: 0, avg_turns: 0, avg_latency: 0, error_count: 0 };
        };

        // Helper: query SLO breach status
        const querySlos = async () => {
          const slos = await sql`
            SELECT slo_id, metric, threshold FROM slo_definitions
            WHERE org_id = ${orgId} AND agent_name = ${agentName}
          `;
          if (slos.length === 0) return { slos: [], breaches: [] };
          // Get actual metrics to compare against
          const since = Date.now() / 1000 - 7 * 86400;
          const metrics = await sql`
            SELECT
              COALESCE(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END)::float / NULLIF(COUNT(*), 0), 0) as success_rate,
              COALESCE(AVG(cost_total_usd), 0) as avg_cost,
              COALESCE(AVG(wall_clock_seconds), 0) as avg_latency,
              COALESCE(PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY wall_clock_seconds), 0) as latency_p99
            FROM sessions
            WHERE org_id = ${orgId} AND agent_name = ${agentName} AND created_at >= ${since}
          `;
          const actual = metrics[0] || {};
          const breaches: any[] = [];
          for (const slo of slos) {
            const metricValue = Number(actual[slo.metric] ?? 0);
            const threshold = Number(slo.threshold);
            // For rate-type metrics (success_rate), actual should be >= threshold
            // For cost/latency metrics, actual should be <= threshold
            const isRateMetric = String(slo.metric).includes("rate");
            const breached = isRateMetric ? metricValue < threshold : metricValue > threshold;
            breaches.push({
              slo_id: slo.id,
              metric: slo.metric,
              threshold,
              actual: metricValue,
              breached,
            });
          }
          return { slos: breaches, breaches: breaches.filter((b: any) => b.breached) };
        };

        // Helper: query pending evolution proposals
        const queryProposals = async () => {
          const rows = await sql`
            SELECT id, title, priority, created_at
            FROM evolution_proposals
            WHERE org_id = ${orgId} AND agent_name = ${agentName} AND status = 'pending'
            ORDER BY priority DESC, created_at DESC
            LIMIT 10
          `;
          return rows;
        };

        if (check === "performance") {
          const perf = await queryPerformance();
          return JSON.stringify({ check: "performance", agent_name: agentName, ...perf });
        }

        if (check === "slo") {
          const sloStatus = await querySlos();
          return JSON.stringify({ check: "slo", agent_name: agentName, ...sloStatus });
        }

        if (check === "proposals") {
          const proposals = await queryProposals();
          return JSON.stringify({ check: "proposals", agent_name: agentName, pending_count: proposals.length, proposals });
        }

        // health: combined view
        const [perf, sloStatus, proposals] = await Promise.all([
          queryPerformance(),
          querySlos(),
          queryProposals(),
        ]);

        // Recent error patterns
        const errorRows = await sql`
          SELECT error, COUNT(*) as count
          FROM sessions
          WHERE org_id = ${orgId} AND agent_name = ${agentName} AND status = 'error'
            AND created_at >= ${Date.now() / 1000 - 7 * 86400}
          GROUP BY error
          ORDER BY count DESC
          LIMIT 5
        `;

        return JSON.stringify({
          check: "health",
          agent_name: agentName,
          performance: perf,
          slo_status: sloStatus,
          pending_proposals: proposals.length,
          recent_error_patterns: errorRows,
        });
      } catch (err: any) {
        return `self-check failed: ${err.message || err}`;
      }
    }

    case "adapt-strategy": {
      // Rate limit: max 3 strategy switches per session
      if (checkToolRateLimit("adapt-strategy", args.session_id, 3)) {
        return "Strategy switch limit reached (max 3 per session). Commit to your current approach.";
      }

      const strategy = String(args.strategy || "");
      const reason = String(args.reason || "");
      const ALLOWED_STRATEGIES = ["step-back", "chain-of-thought", "plan-then-execute", "verify-then-respond", "decompose"];
      if (!ALLOWED_STRATEGIES.includes(strategy)) {
        return `Invalid strategy: ${strategy}. Allowed: ${ALLOWED_STRATEGIES.join(", ")}`;
      }
      if (!reason) return "adapt-strategy requires a reason explaining why you are switching strategies";

      const strategyPrompts: Record<string, string> = {
        "step-back": "Take a step back before answering. First identify the high-level concept or principle involved, then reason from that principle to the specific case. Avoid jumping to conclusions.",
        "chain-of-thought": "Think step by step. Break your reasoning into numbered steps, showing your work at each stage. Verify each step before proceeding to the next.",
        "plan-then-execute": "Before taking any action, create an explicit plan with numbered steps. State the plan, then execute each step in order. After each step, check if the plan needs revision.",
        "verify-then-respond": "Before giving any answer, generate a candidate answer, then systematically verify it by checking for errors, edge cases, and counterexamples. Only return the answer after verification passes.",
        "decompose": "Break this complex problem into smaller, independent sub-problems. Solve each sub-problem separately, then combine the results into a final answer.",
      };

      // The injected system message will be picked up by the runtime and appended
      // to the conversation context for subsequent turns
      return JSON.stringify({
        adapted: true,
        strategy,
        reason,
        _system_inject: `[STRATEGY ADAPTATION] You have switched your reasoning strategy to "${strategy}". Reason: ${reason}\n\nNew instruction: ${strategyPrompts[strategy]}`,
        confirmation: `Strategy switched to "${strategy}". Reason: ${reason}. This will guide your reasoning for subsequent turns in this session.`,
      });
    }

    // ── Swarm / Batch Orchestration ─────────────────────────────
    case "swarm": {
      const swarmMode = String(args.mode || "auto");
      const swarmTasks = args.tasks as Array<{ input: string; tools?: string[] }>;
      const swarmStrategy = String(args.strategy || "parallel");

      if (!Array.isArray(swarmTasks) || swarmTasks.length === 0) {
        return JSON.stringify({ error: "swarm requires a non-empty 'tasks' array" });
      }
      if (swarmTasks.length > 20) {
        return JSON.stringify({ error: `swarm supports max 20 tasks, got ${swarmTasks.length}` });
      }

      // Auto-detect mode based on task characteristics
      const resolvedMode = (() => {
        if (swarmMode !== "auto") return swarmMode;
        const allBashLike = swarmTasks.every(t => {
          const tools = t.tools || [];
          return tools.includes("bash") || tools.includes("python-exec") ||
            /^(run|exec|sh |bash |python |pip |npm |git |ls |cat |grep |find )/.test(t.input.trim().toLowerCase());
        });
        if (allBashLike) return "parallel-exec";
        // Default to codemode — cheapest, fastest
        return "codemode";
      })();

      const swarmStarted = Date.now();

      if (resolvedMode === "codemode") {
        // V8 isolate fan-out: generate a single JS script that parallelizes tool calls
        const { executeScopedCode } = await import("./codemode");
        const allToolsForSwarm = effectiveToolDefs();

        const CODEMODE_CONCURRENCY = 10;
        // Build a JS script that fans out all tasks using Promise.all with concurrency cap
        const taskEntries = swarmTasks.map((t, i) => {
          const toolHint = (t.tools && t.tools.length > 0) ? t.tools[0] : "web-search";
          // Escape backticks and backslashes in input for template literal safety
          const safeInput = t.input.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$/g, "\\$");
          return `  { index: ${i}, input: \`${safeInput}\`, tool: "${toolHint}" }`;
        });

        const generatedCode = `
// Swarm fan-out: ${swarmTasks.length} tasks, concurrency cap ${CODEMODE_CONCURRENCY}
const tasks = [
${taskEntries.join(",\n")}
];

async function runWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

const results = await runWithConcurrency(tasks, ${CODEMODE_CONCURRENCY}, async (task, i) => {
  const start = Date.now();
  try {
    let output;
    if (task.tool === "web-search") {
      output = await codemode.web_search({ query: task.input });
    } else if (task.tool === "browse") {
      output = await codemode.browse({ url: task.input });
    } else if (task.tool === "http-request") {
      output = await codemode.http_request({ url: task.input });
    } else if (task.tool === "knowledge-search") {
      output = await codemode.knowledge_search({ query: task.input });
    } else {
      // Default: web-search for any unrecognized tool hint
      output = await codemode.web_search({ query: task.input });
    }
    return { index: i, status: "pass", output: typeof output === "string" ? output : JSON.stringify(output), latency_ms: Date.now() - start };
  } catch (err) {
    return { index: i, status: "fail", output: "", error: String(err), latency_ms: Date.now() - start };
  }
});

return { mode: "codemode", total_tasks: tasks.length, results };
`;

        const cmResult = await executeScopedCode(env, generatedCode, allToolsForSwarm, sessionId, {
          scope: "orchestrator",
          scopeOverrides: { maxToolCalls: 100, timeoutMs: 60_000 },
          input: { tasks: swarmTasks },
        });

        if (!cmResult.success) {
          return JSON.stringify({
            mode: "codemode",
            error: cmResult.error,
            logs: cmResult.logs,
            latency_ms: Date.now() - swarmStarted,
          });
        }

        return JSON.stringify({
          mode: "codemode",
          ...(cmResult.result as object),
          latency_ms: Date.now() - swarmStarted,
          cost_usd: cmResult.costUsd,
          tool_calls_total: cmResult.toolCallCount,
        });
      }

      if (resolvedMode === "parallel-exec") {
        // Same container, multiple exec() calls in parallel
        const sandbox = getSafeSandbox(env, stableSandboxId(env, sessionId));
        const EXEC_CONCURRENCY = 5;

        // Execute tasks with concurrency cap
        const taskResults: Array<{ index: number; status: string; output: string; error?: string; latency_ms: number }> = [];
        let idx = 0;

        async function execWorker() {
          while (idx < swarmTasks.length) {
            const i = idx++;
            if (i >= swarmTasks.length) break;
            const task = swarmTasks[i];
            const taskStart = Date.now();
            try {
              const command = task.input;
              const timeout = 30; // 30s per task
              const result = await sandbox.exec(command, { timeout });
              taskResults.push({
                index: i,
                status: (result as any).exitCode === 0 ? "pass" : "fail",
                output: ((result as any).stdout || "").slice(0, 4000),
                error: (result as any).stderr || undefined,
                latency_ms: Date.now() - taskStart,
              });
            } catch (err) {
              taskResults.push({
                index: i,
                status: "fail",
                output: "",
                error: String(err),
                latency_ms: Date.now() - taskStart,
              });
            }
          }
        }

        if (swarmStrategy === "sequential") {
          for (let i = 0; i < swarmTasks.length; i++) {
            const task = swarmTasks[i];
            const taskStart = Date.now();
            try {
              const result = await sandbox.exec(task.input, { timeout: 30 });
              taskResults.push({
                index: i,
                status: (result as any).exitCode === 0 ? "pass" : "fail",
                output: ((result as any).stdout || "").slice(0, 4000),
                error: (result as any).stderr || undefined,
                latency_ms: Date.now() - taskStart,
              });
            } catch (err) {
              taskResults.push({
                index: i,
                status: "fail",
                output: "",
                error: String(err),
                latency_ms: Date.now() - taskStart,
              });
            }
          }
        } else {
          const workers = Array.from(
            { length: Math.min(EXEC_CONCURRENCY, swarmTasks.length) },
            () => execWorker(),
          );
          await Promise.all(workers);
        }

        // Sort results by index for consistent ordering
        taskResults.sort((a, b) => a.index - b.index);

        return JSON.stringify({
          mode: "parallel-exec",
          total_tasks: swarmTasks.length,
          results: taskResults,
          latency_ms: Date.now() - swarmStarted,
        });
      }

      if (resolvedMode === "agent") {
        // Agent mode: delegate to run-agent for each task
        // Instead of implementing full Workflow fan-out here, we tell the LLM
        // to use run-agent multiple times. This keeps the implementation lean.
        return JSON.stringify({
          mode: "agent",
          note: "For full agent reasoning per task, call run-agent individually for each task. The swarm tool does not spawn Workflow instances directly — use run-agent with different agent_name/task pairs for parallel agent delegation.",
          tasks: swarmTasks.map((t, i) => ({
            index: i,
            suggested_call: { tool: "run-agent", args: { agent_name: "personal-assistant", task: t.input } },
          })),
        });
      }

      return JSON.stringify({ error: `Unknown swarm mode: ${resolvedMode}. Use auto, codemode, parallel-exec, or agent.` });
    }

    case "mixture-of-agents":
      return mixtureOfAgents(env, args);

    case "parallel-web-search":
      return parallelWebSearch(env, args);

    case "session-search":
      return sessionSearch(env, args);

    case "user-profile-save":
      return userProfileSave(env, args);

    case "user-profile-load":
      return userProfileLoad(env, args);

    case "scratch-write": {
      const traceId = (env as any).__traceId || "";
      if (!traceId) return "scratch-write requires a trace context (only available in delegated runs)";
      await scratchWrite(env, traceId, String(args.key || ""), String(args.value || ""));
      return `Written to scratch: ${args.key}`;
    }

    case "scratch-read": {
      const traceId = (env as any).__traceId || "";
      if (!traceId) return "scratch-read requires a trace context (only available in delegated runs)";
      const val = await scratchRead(env, traceId, String(args.key || ""));
      return val ?? "(key not found)";
    }

    case "scratch-list": {
      const traceId = (env as any).__traceId || "";
      if (!traceId) return "scratch-list requires a trace context (only available in delegated runs)";
      const keys = await scratchList(env, traceId);
      return keys.length > 0 ? keys.join("\n") : "(scratch is empty)";
    }

    case "retrieve-result": {
      const key = String(args.key || "");
      if (!key) return "retrieve-result requires a key (provided in truncated tool results)";
      const content = await retrieveToolResult(env, key);
      return content ?? "Result not found or expired (results are retained for 7 days).";
    }

    case "send-message": {
      const to = String(args.to || "");
      const message = String(args.message || "");
      if (!to || !message) return "send-message requires 'to' (session ID) and 'message'";
      const doSql = (env as any).DO_SQL;
      if (!doSql) return "Mailbox not available (not running in a Durable Object context)";
      try {
        writeToMailbox(doSql, sessionId, to, "text", message);
        return `Message sent to ${to}`;
      } catch (e: any) {
        return `Failed to send message: ${e.message}`;
      }
    }

    default:
      throw new Error(`Tool '${tool}' not available on edge runtime`);
  }
}

// ── Web Search (Brave Search via AI Gateway) ─────────────────
//
// Route: Worker → AI Gateway (custom-brave) → Brave Search API
// Auth: X-Subscription-Token from worker secret, cf-aig-authorization for gateway
// Gateway provides: logging, caching, rate limiting, analytics

// ── Web Search via Perplexity Sonar (through AI Gateway → OpenRouter) ──
// Returns rich, cited, synthesized search results in one call.
// No separate search API + browse + synthesize — Sonar does it all.

async function perplexitySearch(env: RuntimeEnv, args: Record<string, any>): Promise<string> {
  const query = args.query || "";
  if (!query) return "web-search requires a query";

  // ── MVP: Local search ONLY — no paid fallbacks ──
  // Fails loud so we can fix issues. No Perplexity, no Brave, no DuckDuckGo.
  // TODO: Re-enable paid fallbacks when we have paying users.
  const localSearchUrl = (env as any).LOCAL_SEARCH_URL;
  if (!localSearchUrl) {
    return "ERROR: LOCAL_SEARCH_URL not configured. Set it in wrangler.jsonc vars to point to search.oneshots.co";
  }

  try {
    const resp = await fetchWithTimeout(`${localSearchUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "search-gemma4",
        messages: [{ role: "user", content: query }],
      }),
    }, 90_000);

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      return `ERROR: Local search failed (HTTP ${resp.status}). URL: ${localSearchUrl}. Response: ${errText.slice(0, 200)}`;
    }

    const data = (await resp.json()) as any;
    const content = data.choices?.[0]?.message?.content || "";
    if (!content) {
      return `ERROR: Local search returned empty content. Raw response: ${JSON.stringify(data).slice(0, 300)}`;
    }

    return content;
  } catch (err: any) {
    return `ERROR: Local search failed — ${err.message}. Is search.oneshots.co running? Check SearXNG + llama.cpp on your home server.`;
  }
}

// ── Brave / DuckDuckGo removed — MVP uses LOCAL_SEARCH_URL only ──

// ── Mixture of Agents — multi-model parallel reasoning + aggregation ──

async function mixtureOfAgents(env: RuntimeEnv, args: Record<string, any>): Promise<string> {
  const question = String(args.question || args.query || args.task || "").trim();
  if (!question) return "mixture-of-agents requires a question/task";

  const { callLLM } = await import("./llm");

  // Reference models — MVP: multiple Gemma runs with different temperatures for diversity
  const referenceModels = [
    { model: "gemma-4-31b", label: "Gemma Dense (precise)" },
    { model: "gemma-4-26b-moe", label: "Gemma MoE (creative)" },
    { model: "gemma-4-31b", label: "Gemma Dense (exploratory)" },
  ];

  const userMsg = [
    { role: "system" as const, content: "You are a helpful expert. Provide a thorough, well-reasoned answer." },
    { role: "user" as const, content: question },
  ];

  // Phase 1: Query all reference models in parallel
  const referenceResults = await Promise.allSettled(
    referenceModels.map(async (rm) => {
      try {
        const resp = await callLLM(env, userMsg, [], {
          model: rm.model,
          max_tokens: 2000,
          temperature: 0.7,
        });
        return { label: rm.label, content: resp.content || "" };
      } catch (err: any) {
        return { label: rm.label, content: `[Error: ${err.message?.slice(0, 100)}]` };
      }
    }),
  );

  const responses = referenceResults
    .filter((r): r is PromiseFulfilledResult<{ label: string; content: string }> => r.status === "fulfilled")
    .map((r) => r.value)
    .filter((r) => r.content && !r.content.startsWith("[Error:"));

  if (responses.length === 0) return "All reference models failed. Try again later.";

  // Phase 2: Aggregator synthesizes the best answer
  const aggregatorPrompt = [
    { role: "system" as const, content:
      "You are a synthesis expert. Multiple AI models have answered the same question. " +
      "Review their responses, identify the strongest reasoning and most accurate information from each, " +
      "then produce a single authoritative answer that combines the best insights. " +
      "Resolve any contradictions by favoring well-reasoned arguments with evidence." },
    { role: "user" as const, content:
      `Question: ${question}\n\n` +
      responses.map((r, i) => `--- Response ${i + 1} (${r.label}) ---\n${r.content}`).join("\n\n") +
      "\n\n--- Your synthesized answer ---" },
  ];

  try {
    const aggregated = await callLLM(env, aggregatorPrompt, [], {
      model: "gemma-4-31b",
      max_tokens: 3000,
      temperature: 0.3,
    });
    return JSON.stringify({
      answer: aggregated.content || "",
      models_consulted: responses.map((r) => r.label),
      model_count: responses.length,
    });
  } catch (err: any) {
    // Fallback: return the best individual response
    return JSON.stringify({
      answer: responses[0].content,
      models_consulted: [responses[0].label],
      model_count: 1,
      note: "Aggregation failed, returning best individual response",
    });
  }
}

// ── Parallel Web Search — multiple queries simultaneously ────

async function parallelWebSearch(env: RuntimeEnv, args: Record<string, any>): Promise<string> {
  const queries = args.queries || [];
  if (!Array.isArray(queries) || queries.length === 0) return "parallel-web-search requires queries (array of strings)";

  const maxPerQuery = args.max_results || 3;
  const capped = queries.slice(0, 5); // Max 5 parallel queries

  const results = await Promise.allSettled(
    capped.map((q: string) => perplexitySearch(env, { query: String(q), max_results: maxPerQuery })),
  );

  const output = capped.map((q: string, i: number) => {
    const result = results[i];
    const text = result.status === "fulfilled" ? result.value : `[Error: ${(result as any).reason?.message || "unknown"}]`;
    return `### Query: "${q}"\n${text}`;
  });

  return output.join("\n\n---\n\n");
}

// ── Session Search — full-text search across past conversations ──

async function sessionSearch(env: RuntimeEnv, args: Record<string, any>): Promise<string> {
  const query = String(args.query || "").trim();
  if (!query) return "session-search requires a query";
  const limit = Math.min(args.limit || 10, 20);

  try {
    const { getDb } = await import("./db");
    const sql = await getDb(env.HYPERDRIVE);
    const agentName = (env as any).__agentConfig?.name || "";
    const orgId = (env as any).__agentConfig?.orgId || "";

    // Search across sessions input/output text
    const keywords = query.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 5);
    const likePattern = `%${keywords[0]}%`;

    const rows = await sql`
      SELECT session_id, input_text, output_text, status, created_at,
             cost_total_usd, turns_count
      FROM sessions
      WHERE org_id = ${orgId}
        AND (${agentName} = '' OR agent_name = ${agentName})
        AND (LOWER(input_text) LIKE ${likePattern} OR LOWER(output_text) LIKE ${likePattern})
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;

    if (!rows.length) return `No sessions found matching "${query}"`;

    // Score and rank by keyword overlap
    const scored = rows.map((r: any) => {
      const text = `${r.input_text || ""} ${r.output_text || ""}`.toLowerCase();
      const score = keywords.reduce((s: number, kw: string) => s + (text.includes(kw) ? 1 : 0), 0);
      return { ...r, score };
    }).sort((a: any, b: any) => b.score - a.score);

    return scored.map((r: any, i: number) =>
      `${i + 1}. [${r.session_id}] ${new Date(r.created_at).toISOString().slice(0, 10)} — ${r.status}\n` +
      `   Input: ${(r.input_text || "").slice(0, 150)}...\n` +
      `   Output: ${(r.output_text || "").slice(0, 150)}...\n` +
      `   Turns: ${r.turns_count || 0} | Cost: $${(r.cost_total_usd || 0).toFixed(4)}`,
    ).join("\n\n");
  } catch (err: any) {
    return `Session search failed: ${err.message}`;
  }
}

// ── User Profile Memory — persistent per-user learning ──────

async function userProfileSave(env: RuntimeEnv, args: Record<string, any>): Promise<string> {
  const userId = String(args.user_id || (env as any).__channelUserId || "").trim();
  if (!userId) return "user-profile-save requires user_id";

  const key = String(args.key || "").trim();
  const value = String(args.value || "").trim();
  if (!key || !value) return "user-profile-save requires key and value";

  const agentName = (env as any).__agentConfig?.name || "my-assistant";
  const orgId = (env as any).__agentConfig?.orgId || "";

  try {
    const { getDb } = await import("./db");
    const sql = await getDb(env.HYPERDRIVE);

    // Upsert user profile with JSONB merge
    await sql`
      INSERT INTO user_profiles (id, org_id, agent_name, end_user_id, profile_data, updated_at, created_at)
      VALUES (
        ${`${orgId}-${agentName}-${userId}`},
        ${orgId}, ${agentName}, ${userId},
        jsonb_build_object(${key}, ${value}),
        now(), now()
      )
      ON CONFLICT (org_id, agent_name, end_user_id) DO UPDATE
      SET profile_data = user_profiles.profile_data || jsonb_build_object(${key}, ${value}),
          updated_at = now()
    `;

    return JSON.stringify({ saved: true, user_id: userId, key, preview: value.slice(0, 100) });
  } catch (err: any) {
    return `User profile save failed: ${err.message}`;
  }
}

async function userProfileLoad(env: RuntimeEnv, args: Record<string, any>): Promise<string> {
  const userId = String(args.user_id || (env as any).__channelUserId || "").trim();
  if (!userId) return "user-profile-load requires user_id";

  const agentName = (env as any).__agentConfig?.name || "my-assistant";
  const orgId = (env as any).__agentConfig?.orgId || "";

  try {
    const { getDb } = await import("./db");
    const sql = await getDb(env.HYPERDRIVE);

    const rows = await sql`
      SELECT profile_data, preferences, metadata, updated_at
      FROM user_profiles
      WHERE org_id = ${orgId} AND agent_name = ${agentName} AND end_user_id = ${userId}
      LIMIT 1
    `;

    if (!rows.length) return JSON.stringify({ user_id: userId, profile: {}, note: "No profile found — this is a new user" });

    const row = rows[0];
    return JSON.stringify({
      user_id: userId,
      profile: row.profile_data || {},
      preferences: row.preferences || {},
      metadata: row.metadata || {},
      last_updated: row.updated_at,
    });
  } catch (err: any) {
    return `User profile load failed: ${err.message}`;
  }
}

// ── Browse (simple HTTP fetch) ────────────────────────────────

async function browse(args: Record<string, any>, env?: RuntimeEnv, sessionId?: string): Promise<string> {
  const urlCheck = validateUrl(args.url || "");
  if (!urlCheck.valid) return `Error: ${urlCheck.reason}`;

  // Use Puppeteer Browser binding for full JS-rendered pages (headless Chrome on CF edge)
  if (env?.BROWSER) {
    const sk = browserSessionKey(env, sessionId);
    try {
      return await runBrowserSerialized(sk, async () => {
        const browser = await getPooledBrowser(env, sk);
        const page = await browser.newPage();
        try {
          await page.goto(args.url || "", { waitUntil: "networkidle0", timeout: 20000 });
          if (args.wait_for) {
            try { await page.waitForSelector(args.wait_for, { timeout: 5000 }); } catch {}
          }
          const text = await page.evaluate(new Function("return document.body?.innerText || ''") as () => string);
          return text.trim().slice(0, 10000) || "Empty page";
        } finally {
          try { await page.close(); } catch {}
        }
      });
    } catch (err: any) {
      console.error(`[browse] Puppeteer failed, falling back to fetch: ${err.message?.slice(0, 100)}`);
    }
  }

  // Fallback 1: Self-hosted Playwright browse via search server
  const localSearchUrl = (env as any)?.LOCAL_SEARCH_URL;
  if (localSearchUrl) {
    try {
      const browseResp = await fetchWithTimeout(`${localSearchUrl}/v1/browse`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: args.url, extract_text: true }),
      });
      if (browseResp.ok) {
        const data = (await browseResp.json()) as any;
        const text = data.text || data.content || "";
        if (text.length > 50) return text.slice(0, 10000);
      }
    } catch {}
  }

  // Fallback 2: simple fetch + tag stripping (no JS execution)
  const resp = await fetchWithTimeout(args.url || "", {
    headers: { "User-Agent": "AgentOS/0.2.0" },
    redirect: "follow",
  });
  const html = await resp.text();
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 10000) || "Empty page";
}

// ── HTTP Request ──────────────────────────────────────────────

async function httpRequest(args: Record<string, any>): Promise<string> {
  const urlCheck = validateUrl(args.url || "");
  if (!urlCheck.valid) return JSON.stringify({ error: urlCheck.reason });
  const method = (args.method || "GET").toUpperCase();
  const timeout = args.timeout_seconds || 30;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout * 1000);
  try {
    const resp = await fetch(args.url || "", {
      method,
      headers: args.headers || {},
      ...(method !== "GET" && method !== "HEAD" && args.body ? { body: args.body } : {}),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const body = await resp.text();
    return JSON.stringify({
      status: resp.status,
      headers: Object.fromEntries(resp.headers.entries()),
      body: body.slice(0, 10000),
    });
  } catch (err: any) {
    clearTimeout(timer);
    return JSON.stringify({ error: err.message });
  }
}

// ── Sandbox Exec ──────────────────────────────────────────────

async function sandboxExec(
  env: RuntimeEnv,
  command: string,
  sessionId: string,
  timeoutSeconds?: number,
): Promise<string> {
  const r = await sandboxExecWithLimits(env, sessionId, command, timeoutSeconds);
  return JSON.stringify({
    stdout: r.stdout || "",
    stderr: r.stderr || "",
    exit_code: r.exitCode ?? 0,
  });
}

// ── Knowledge Search (Vectorize) ──────────────────────────────

async function knowledgeSearch(env: RuntimeEnv, args: Record<string, any>): Promise<string> {
  const { rewriteQuery, dedupResults } = await import("./rag-transforms");
  const { embedForQuery } = await import("./embeddings");
  const rawQuery = args.query || "";
  const finalK = args.top_k || 5;
  const maxRetries = 2; // Up to 2 retrieval attempts (original + 1 refinement)

  let bestResults: any[] = [];
  let queriesAttempted: string[] = [];

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    // On first attempt: use rewritten query. On retry: use LLM-refined query.
    let query: string;
    if (attempt === 0) {
      query = rewriteQuery(rawQuery, { agentName: (env as any).__agentConfig?.name });
    } else {
      // Refine query based on what we found (or didn't find)
      query = await refineQuery(env, rawQuery, bestResults);
      if (!query || queriesAttempted.includes(query)) break; // No useful refinement
    }
    queriesAttempted.push(query);

    const retrieveK = 20;
    let queryVec: number[];
    try {
      const embResult = await embedForQuery(query, env);
      queryVec = embResult.vector;
    } catch {
      if (attempt === 0) return "Embedding failed — both GPU box and Workers AI unavailable";
      break;
    }

  // Step 2: Retrieve top-20 candidates from Vectorize
  const configOrgId = (env as any).__agentConfig?.org_id || "";
  const configAgentName = (env as any).__agentConfig?.name || "";
  const filter: Record<string, string> = {};
  if (args.agent_name || configAgentName) filter.agent_name = args.agent_name || configAgentName;
  if (args.org_id || configOrgId) filter.org_id = args.org_id || configOrgId;
  const matches = await env.VECTORIZE.query(queryVec, {
    topK: retrieveK,
    returnMetadata: "all",
    filter: Object.keys(filter).length > 0 ? filter : undefined,
  });

  // Fix #6: Include rich metadata from pipeline events
  const candidates = (matches.matches || []).map((m: any) => ({
    vector_score: m.score,
    text: String(m.metadata?.text || ""),
    source: String(m.metadata?.source || ""),
    chunk_index: Number(m.metadata?.chunk_index ?? 0),
    event_type: String(m.metadata?.event_type || ""),
    pipeline: String(m.metadata?.pipeline || ""),
    ingested_at: Number(m.metadata?.ingested_at ?? 0),
    agent_name: String(m.metadata?.agent_name || ""),
  }));

  if (candidates.length === 0) {
    return `No relevant knowledge found for: ${query}`;
  }

  // Step 3: Rerank with GPU box reranker (Jina v3 primary, BGE fallback)
  const { rerank } = await import("./rag-rerank");
  let reranked = candidates;
  try {
    const rerankResults = await rerank(query, candidates.map((c: any) => c.text), env);
    if (rerankResults.length > 0) {
      reranked = rerankResults.map((rr) => {
        const c = candidates[rr.index];
        return {
          ...c,
          rerank_score: rr.score,
          final_score: 0.3 * c.vector_score + 0.7 * rr.score,
        };
      });
      reranked.sort((a: any, b: any) => b.final_score - a.final_score);
    }
  } catch {
    reranked.sort((a: any, b: any) => b.vector_score - a.vector_score);
  }

    // Step 4: Dedup and collect results
    const deduped = dedupResults(
      reranked.map((r: any) => ({ ...r, id: r.source + "-" + r.chunk_index, score: r.final_score ?? r.vector_score })),
      { maxPerSource: 3 },
    );

    // Merge with previous attempts (keep higher-scored version of each chunk)
    for (const _r of deduped) {
      const r = _r as any;
      const existing = bestResults.find((br: any) => br.id === r.id);
      if (!existing) {
        bestResults.push(r);
      } else if ((r.final_score ?? r.vector_score) > (existing.final_score ?? existing.vector_score)) {
        Object.assign(existing, r);
      }
    }

    // Evaluate: if top result has a good score, no need to retry
    const topScore = bestResults[0]?.final_score ?? bestResults[0]?.vector_score ?? 0;
    if (topScore > 0.5 || bestResults.length >= finalK * 2) {
      break; // Good enough — stop searching
    }
    // Otherwise: loop will refine the query and try again
  }

  if (bestResults.length === 0) {
    return `No relevant knowledge found for: ${rawQuery}` +
      (queriesAttempted.length > 1 ? ` (tried ${queriesAttempted.length} query variants)` : "");
  }

  // Sort and return top-K
  bestResults.sort((a: any, b: any) => (b.final_score ?? b.vector_score) - (a.final_score ?? a.vector_score));
  const topResults = bestResults.slice(0, finalK);
  return topResults
    .map((r: any, i: number) => {
      const score = r.final_score !== undefined
        ? `score=${r.final_score.toFixed(3)}`
        : `score=${r.vector_score.toFixed(3)}`;
      const meta: string[] = [];
      if (r.source) meta.push(`source=${r.source}`);
      if (r.pipeline) meta.push(`pipeline=${r.pipeline}`);
      if (r.event_type) meta.push(`type=${r.event_type}`);
      if (r.ingested_at) {
        const ingestedMs = typeof r.ingested_at === "string" ? new Date(r.ingested_at).getTime() : Number(r.ingested_at) * 1000;
        const ago = Math.round((Date.now() - ingestedMs) / 60000);
        meta.push(ago < 60 ? `${ago}m ago` : `${Math.round(ago / 60)}h ago`);
      }
      const metaStr = meta.length > 0 ? ` (${meta.join(", ")})` : "";
      return `${i + 1}. [${score}]${metaStr} ${r.text.slice(0, 300)}`;
    })
    .join("\n\n") +
    (queriesAttempted.length > 1 ? `\n\n[Searched with ${queriesAttempted.length} query variants]` : "");
}

/**
 * Refine a query when the first retrieval pass returned low-relevance results.
 * Uses the MoE to analyze what was found and suggest a better search.
 */
async function refineQuery(
  env: RuntimeEnv,
  originalQuery: string,
  currentResults: any[],
): Promise<string> {
  const llmUrl = "https://fast.oneshots.co";
  const serviceToken = (env as any).SERVICE_TOKEN || "";
  const authHeaders: Record<string, string> = serviceToken ? { Authorization: `Bearer ${serviceToken}` } : {};

  const resultSummary = currentResults.slice(0, 3)
    .map((r: any) => `[${r.source}] ${(r.text || "").slice(0, 100)}`)
    .join("\n");

  try {
    const resp = await fetch(`${llmUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify({
        messages: [{
          role: "user",
          content: `Original search query: "${originalQuery}"\n\nTop results found (may not be relevant):\n${resultSummary || "(no results)"}\n\nThe results don't seem to answer the query well. Generate ONE improved search query that would find more relevant documents. Return ONLY the query string, nothing else.`,
        }],
        max_tokens: 50,
        temperature: 0.3,
        chat_template_kwargs: { enable_thinking: false },
      }),
    });
    if (!resp.ok) return "";
    const result = await resp.json() as any;
    const refined = (result?.choices?.[0]?.message?.content || "").trim().replace(/^["']|["']$/g, "");
    return refined;
  } catch {
    return "";
  }
}

// ── Store Knowledge (Vectorize + R2) ──────────────────────────

async function storeKnowledge(env: RuntimeEnv, args: Record<string, any>): Promise<string> {
  const text = args.content || args.text || "";
  const key = args.key || "knowledge";
  const { embedSingle } = await import("./embeddings");
  let vec: number[] | null = null;
  try {
    const embResult = await embedSingle(text, env);
    vec = embResult.vector;
  } catch { /* embedding failed */ }
  if (vec) {
    await env.VECTORIZE.upsert([
      {
        id: `knowledge-${Date.now()}`,
        values: vec,
        metadata: {
          text,
          source: key,
          agent_name: args.agent_name || (env as any).__agentConfig?.name || "",
          org_id: args.org_id || (env as any).__agentConfig?.org_id || "",
        },
      },
    ]);
  }
  return `Stored knowledge: '${key}' (${text.length} chars)`;
}

// ── Ingest Document (OCR → RAG pipeline) ──────────────────────

async function ingestDocument(env: RuntimeEnv, args: Record<string, any>): Promise<string> {
  const imageUrl = args.image_url || args.url || "";
  const source = args.source || "document";
  if (!imageUrl) return "ERROR: image_url is required";

  const ocrUrl = ((env as any).OCR_ENDPOINT_URL || "").trim();
  if (!ocrUrl) return "ERROR: OCR_ENDPOINT_URL not configured";

  const agentName = (env as any).__agentConfig?.name || "";
  const orgId = (env as any).__agentConfig?.org_id || "";

  // SSRF protection: validate URL before fetching
  const { validateUrl } = await import("./ssrf");
  const ssrfCheck = validateUrl(imageUrl);
  if (!ssrfCheck.valid) return `ERROR: Blocked URL (SSRF): ${ssrfCheck.reason}`;

  // Fetch the image/document
  const imgResp = await fetch(imageUrl);
  if (!imgResp.ok) return `ERROR: Failed to fetch document from ${imageUrl}: ${imgResp.status}`;
  const imgBytes = await imgResp.arrayBuffer();
  const mimeType = imgResp.headers.get("Content-Type") || "image/png";

  // Store raw in R2
  const r2RawKey = `rag/${orgId || "global"}/${source}-${Date.now()}.raw`;
  await env.STORAGE.put(r2RawKey, imgBytes, {
    customMetadata: { source, org_id: orgId, agent_name: agentName, mime_type: mimeType },
  });

  // Convert to base64 data URL for vision model
  // Safe base64 for large buffers (avoids stack overflow from spread)
  const imgU8 = new Uint8Array(imgBytes);
  let binary = "";
  for (let i = 0; i < imgU8.length; i += 8192) {
    const chunk = imgU8.subarray(i, Math.min(i + 8192, imgU8.length));
    for (let j = 0; j < chunk.length; j++) binary += String.fromCharCode(chunk[j]);
  }
  const base64 = btoa(binary);
  const dataUrl = `data:${mimeType};base64,${base64}`;
  const ocrPrompt = "Extract all text from this document. Return the full text content preserving structure, headings, lists, and tables as markdown.";
  const serviceToken = (env as any).SERVICE_TOKEN || "";
  const authHeaders: Record<string, string> = serviceToken ? { Authorization: `Bearer ${serviceToken}` } : {};

  // Try GLM-OCR first (fast, specialized), fallback to Gemma 4 31B vision
  let extractedText = "";
  const ocrBody = JSON.stringify({
    messages: [{
      role: "user",
      content: [
        { type: "text", text: ocrPrompt },
        { type: "image_url", image_url: { url: dataUrl } },
      ],
    }],
    max_tokens: 4096,
    temperature: 0.1,
  });

  try {
    const ocrResp = await fetch(`${ocrUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: ocrBody,
    });
    if (ocrResp.ok) {
      const result = await ocrResp.json() as any;
      extractedText = result?.choices?.[0]?.message?.content || "";
    }
  } catch { /* fall through to fallback */ }

  // Fallback: Gemma 4 31B vision
  if (!extractedText.trim()) {
    try {
      const gemmaResp = await fetch("https://gemma4.oneshots.co/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: ocrBody,
      });
      if (gemmaResp.ok) {
        const result = await gemmaResp.json() as any;
        extractedText = result?.choices?.[0]?.message?.content || "";
      }
    } catch { /* both endpoints failed */ }
  }
  if (!extractedText.trim()) return "ERROR: OCR returned empty text — document may be blank or unsupported format";

  // Chunk and embed
  const words = extractedText.split(/\s+/);
  const chunks: string[] = [];
  for (let i = 0; i < words.length; i += 400) {
    chunks.push(words.slice(i, i + 512).join(" "));
  }

  const embedResult = (await env.AI.run("@cf/baai/bge-base-en-v1.5" as keyof AiModels, { text: chunks })) as any;
  const vectors = embedResult.data || [];

  const vecInserts = vectors.map((vec: number[], idx: number) => ({
    id: `ocr-${source}-${Date.now()}-${idx}`,
    values: vec,
    metadata: {
      text: chunks[idx],
      source,
      pipeline: "ocr",
      org_id: orgId,
      agent_name: agentName,
      chunk_index: idx,
      ingested_at: new Date().toISOString(),
    },
  }));

  if (vecInserts.length > 0) {
    await env.VECTORIZE.upsert(vecInserts);
  }

  return JSON.stringify({
    source,
    extracted_text_length: extractedText.length,
    chunks: chunks.length,
    vectors: vecInserts.length,
    r2_key: r2RawKey,
    preview: extractedText.slice(0, 300),
  });
}

// ── Image Generate (Workers AI FLUX) ──────────────────────────

async function imageGenerate(env: RuntimeEnv, args: Record<string, any>): Promise<string> {
  const prompt = args.prompt || "";
  const aiResult = (await env.AI.run("@cf/bfl/flux-2-klein-4b" as keyof AiModels, { prompt })) as
    | ReadableStream
    | ArrayBuffer;
  const buf =
    aiResult instanceof ArrayBuffer ? aiResult : await new Response(aiResult).arrayBuffer();
  const orgId = (env as any).__agentConfig?.orgId || (env as any).__agentConfig?.org_id || "default";
  const key = `workspaces/${orgId}/images/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`;
  await env.STORAGE.put(key, buf, { customMetadata: { prompt } });
  return JSON.stringify({
    image_key: key,
    format: "png",
    size_bytes: buf.byteLength,
    model: "@cf/bfl/flux-2-klein-4b",
  });
}

// ── Vision / Image Analysis (Gemini via CF AI Gateway) ───────

async function visionAnalyze(env: RuntimeEnv, args: Record<string, any>): Promise<string> {
  const imageUrl = args.image_url || args.url || "";
  const prompt = args.prompt || args.question || "Describe this image in detail.";
  if (!imageUrl) return "vision-analyze requires image_url";

  try {
    const { callLLM } = await import("./llm");
    const { resolvePlanRouting } = await import("./db");

    // Resolve vision model from agent's plan (standard → gpt-5.4, premium → gemini-3.1-pro)
    const agentConfig = (env as any).__agentConfig || {};
    const routing = resolvePlanRouting(agentConfig.plan || "standard", agentConfig.routing);
    const visionRoute = routing?.multimodal?.vision || { model: "google/gemini-3.1-pro-preview", provider: "openrouter" };

    const response = await callLLM(
      env,
      [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: imageUrl } },
            { type: "text", text: prompt },
          ] as any,
        },
      ],
      [],
      { model: visionRoute.model, max_tokens: 2000 },
    );
    return response.content || "Vision analysis returned no result";
  } catch (err: any) {
    return `Vision analysis failed: ${err.message}`;
  }
}

// ── Curated Persistent Memory (episodic + semantic via control-plane) ──
// Categories align with Claude Code memory taxonomy (user / feedback / project / reference).

const MEMORY_CATEGORY_PRIMARY = new Set(["user", "feedback", "project", "reference"]);

function normalizeMemoryCategory(raw: unknown): string {
  const c = String(raw || "").toLowerCase().trim();
  if (MEMORY_CATEGORY_PRIMARY.has(c)) return c;
  const legacy: Record<string, string> = {
    general: "reference",
    preferences: "user",
    preference: "user",
    knowledge: "user",
    goal: "user",
    behavior: "feedback",
    contacts: "user",
    process: "project",
    architecture: "project",
    convention: "feedback",
    decision: "project",
    context: "reference",
  };
  return legacy[c] || "reference";
}

async function memorySave(env: RuntimeEnv, args: Record<string, any>): Promise<string> {
  const content = String(args.content || args.value || "").trim();
  const memoryType = String(args.type || "semantic").trim();
  const key = String(args.key || args.name || "").trim();
  if (!content) return "memory-save requires content";

  const agentName = (env as any).__agentConfig?.name || "my-assistant";
  const orgId = (env as any).__agentConfig?.org_id || (env as any).__delegationLineage?.org_id || "";
  const hyperdrive = (env as any).HYPERDRIVE;

  if (!hyperdrive) return "Memory not available (no database)";

  const category = normalizeMemoryCategory(args.category);

  try {
    const { getDb } = await import("./db");
    const sql = await getDb(hyperdrive);
    const now = new Date().toISOString();
    const id = crypto.randomUUID().replace(/-/g, "").slice(0, 16);

    if (memoryType === "episodic") {
      await sql`
        INSERT INTO episodes (id, agent_name, org_id, content, source, metadata, created_at)
        VALUES (${id}, ${agentName}, ${orgId}, ${content}, 'agent', ${JSON.stringify(key ? { key, category } : { category })}, ${now})
      `;
      return JSON.stringify({ saved: true, type: "episodic", id });
    } else {
      const factKey = key || content.slice(0, 50);
      await sql`
        INSERT INTO facts (id, agent_name, org_id, key, value, category, created_at)
        VALUES (${id}, ${agentName}, ${orgId}, ${factKey}, ${content}, ${category}, ${now})
        ON CONFLICT (agent_name, org_id, key) DO UPDATE SET value = ${content}, category = ${category}
      `;
      return JSON.stringify({ saved: true, type: "semantic", id, key: factKey, category });
    }
  } catch (err: any) {
    return `Memory save failed: ${err.message}`;
  }
}

const MEMORY_MD_MAX_LINES = 200;
const MEMORY_MD_MAX_BYTES = 25_000;

async function syncWorkspaceMemory(env: RuntimeEnv, sessionId: string): Promise<string> {
  const agentName = (env as any).__agentConfig?.name || "my-assistant";
  const orgId = (env as any).__agentConfig?.org_id || (env as any).__delegationLineage?.org_id || "";
  const hyperdrive = (env as any).HYPERDRIVE;
  if (!hyperdrive) return JSON.stringify({ ok: false, error: "no database" });

  try {
    const { getDb } = await import("./db");
    const sql = await getDb(hyperdrive);
    const rows = await sql`
      SELECT key, value, category, created_at
      FROM facts
      WHERE agent_name = ${agentName} AND org_id = ${orgId}
      ORDER BY category ASC, created_at DESC
      LIMIT 150
    `;

    const byCat: Record<string, string[]> = { user: [], feedback: [], project: [], reference: [] };
    for (const r of rows as any[]) {
      const cat = normalizeMemoryCategory(r.category);
      const line = `- **${r.key || "note"}**: ${String(r.value || "").replace(/\n/g, " ")}`;
      if (!byCat[cat]) byCat[cat] = [];
      byCat[cat].push(line);
    }

    let body = `---\ntype: workspace-memory\nsynced: ${new Date().toISOString()}\nagent: ${agentName}\n---\n\n`;
    body += `# MEMORY (synced from persistent store)\n\n`;
    body += `> OneShots mirrors curated semantic facts here for Claude Code–style file workflows. `;
    body += `Re-run sync-workspace-memory after saving new facts. Do not store secrets.\n\n`;

    for (const section of ["user", "feedback", "project", "reference"] as const) {
      const items = byCat[section] || [];
      if (items.length === 0) continue;
      body += `## ${section}\n\n${items.join("\n")}\n\n`;
    }

    const lines = body.split("\n");
    if (lines.length > MEMORY_MD_MAX_LINES) {
      body = lines.slice(0, MEMORY_MD_MAX_LINES).join("\n") + `\n\n> Truncated at ${MEMORY_MD_MAX_LINES} lines.\n`;
    }
    if (body.length > MEMORY_MD_MAX_BYTES) {
      body = body.slice(0, MEMORY_MD_MAX_BYTES) + `\n\n> Truncated at ${MEMORY_MD_MAX_BYTES} bytes.\n`;
    }

    const sandbox = getSafeSandbox(env, stableSandboxId(env, sessionId));
    const path = "/workspace/MEMORY.md";
    await sandbox.writeFile(path, body);
    return JSON.stringify({
      ok: true,
      path,
      entries: (rows as any[]).length,
      categories: Object.keys(byCat).filter((k) => (byCat[k] || []).length > 0),
    });
  } catch (err: any) {
    return JSON.stringify({ ok: false, error: err.message || String(err) });
  }
}

async function memoryRecall(env: RuntimeEnv, args: Record<string, any>): Promise<string> {
  const query = String(args.query || args.key || "").trim();
  const memoryType = String(args.type || "all").trim();
  const agentName = (env as any).__agentConfig?.name || "my-assistant";
  const orgId = (env as any).__agentConfig?.org_id || "";
  const hyperdrive = (env as any).HYPERDRIVE;
  if (!hyperdrive) return "Memory not available";

  try {
    const { getDb } = await import("./db");
    const sql = await getDb(hyperdrive);
    const results: any[] = [];

    if (memoryType === "all" || memoryType === "semantic") {
      const rows = query
        ? await sql`SELECT key, value, category FROM facts WHERE agent_name = ${agentName} AND org_id = ${orgId} AND (key ILIKE ${'%' + query + '%'} OR value ILIKE ${'%' + query + '%'}) ORDER BY created_at DESC LIMIT 20`
        : await sql`SELECT key, value, category FROM facts WHERE agent_name = ${agentName} AND org_id = ${orgId} ORDER BY created_at DESC LIMIT 20`;
      results.push(...rows.map((r: any) => ({ type: "semantic", key: r.key, value: r.value, category: r.category })));
    }

    if (memoryType === "all" || memoryType === "episodic") {
      const rows = query
        ? await sql`SELECT content, created_at FROM episodes WHERE agent_name = ${agentName} AND org_id = ${orgId} AND content ILIKE ${'%' + query + '%'} ORDER BY created_at DESC LIMIT 20`
        : await sql`SELECT content, created_at FROM episodes WHERE agent_name = ${agentName} AND org_id = ${orgId} ORDER BY created_at DESC LIMIT 20`;
      results.push(...rows.map((r: any) => ({ type: "episodic", content: r.content, created: r.created_at })));
    }

    if (results.length === 0) return "No memories found" + (query ? ` matching "${query}"` : "");
    return JSON.stringify(results);
  } catch (err: any) {
    return `Memory recall failed: ${err.message}`;
  }
}

async function memoryDelete(env: RuntimeEnv, args: Record<string, any>): Promise<string> {
  const memoryType = String(args.type || "semantic").trim();
  const agentName = (env as any).__agentConfig?.name || "my-assistant";
  const orgId = (env as any).__agentConfig?.org_id || "";
  const hyperdrive = (env as any).HYPERDRIVE;
  if (!hyperdrive) return "Memory not available";

  try {
    const { getDb } = await import("./db");
    const sql = await getDb(hyperdrive);
    if (memoryType === "semantic" && (args.fact_id || args.key)) {
      if (args.fact_id) {
        await sql`DELETE FROM facts WHERE id = ${args.fact_id} AND agent_name = ${agentName} AND org_id = ${orgId}`;
      } else {
        await sql`DELETE FROM facts WHERE key = ${args.key} AND agent_name = ${agentName} AND org_id = ${orgId}`;
      }
      return JSON.stringify({ deleted: true, type: "semantic" });
    }
    return "memory-delete requires type and fact_id or key";
  } catch (err: any) {
    return `Memory delete failed: ${err.message}`;
  }
}

// ── TTS (Workers AI Deepgram) ─────────────────────────────────

async function textToSpeech(env: RuntimeEnv, args: Record<string, any>): Promise<string> {
  const text = args.text || "";
  const provider = String(args.provider || "deepgram").toLowerCase();
  let audioBuffer: ArrayBuffer;
  let modelUsed = "";

  if (provider === "edge" || provider === "edge-tts") {
    // Edge TTS — free, uses Microsoft Cognitive Services via edge-tts proxy
    // Voice list: https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list
    const voice = args.voice || "en-US-AriaNeural";
    try {
      // Use the CF Workers AI TTS as primary, Edge TTS as concept
      // Edge TTS requires a server-side library; fall through to Deepgram on Workers
      const audioRaw = await env.AI.run("@cf/deepgram/aura-2-en" as keyof AiModels, { text }) as any;
      audioBuffer = audioRaw instanceof ArrayBuffer ? audioRaw
        : audioRaw instanceof Uint8Array ? (audioRaw.buffer as ArrayBuffer).slice(audioRaw.byteOffset, audioRaw.byteOffset + audioRaw.byteLength)
        : await new Response(audioRaw as BodyInit).arrayBuffer();
      modelUsed = "@cf/deepgram/aura-2-en (edge fallback)";
    } catch {
      return "Edge TTS failed — falling back unavailable in serverless environment";
    }
  } else {
    // Default: Deepgram Aura via Workers AI (free)
    const audioRaw = await env.AI.run("@cf/deepgram/aura-2-en" as keyof AiModels, { text }) as any;
    audioBuffer = audioRaw instanceof ArrayBuffer ? audioRaw
      : audioRaw instanceof Uint8Array ? (audioRaw.buffer as ArrayBuffer).slice(audioRaw.byteOffset, audioRaw.byteOffset + audioRaw.byteLength)
      : await new Response(audioRaw as BodyInit).arrayBuffer();
    modelUsed = "@cf/deepgram/aura-2-en";
  }

  const audioResult = new Uint8Array(audioBuffer);
  const key = `audio/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp3`;
  await env.STORAGE.put(key, audioResult, {
    customMetadata: { text: text.slice(0, 200), provider: modelUsed },
  });
  return JSON.stringify({
    audio_key: key,
    size_bytes: audioResult.byteLength,
    model: modelUsed,
  });
}

// ── Speech-to-Text (Workers AI Whisper) ───────────────────────

async function speechToText(env: RuntimeEnv, args: Record<string, any>, sessionId: string): Promise<string> {
  const audioPath = args.audio_path || args.path || "";
  const audioUrl = args.audio_url || args.url || "";
  const provider = String(args.provider || "whisper").toLowerCase();

  if (!audioPath && !audioUrl) return "speech-to-text requires audio_path or audio_url";

  // Get audio bytes — from URL or sandbox file
  let audioBytes: Uint8Array;
  if (audioUrl) {
    try {
      const resp = await fetch(audioUrl);
      if (!resp.ok) return `Could not download audio: HTTP ${resp.status}`;
      audioBytes = new Uint8Array(await resp.arrayBuffer());
    } catch (err: any) {
      return `Audio download failed: ${err.message}`;
    }
  } else {
    const sandbox = getSafeSandbox(env, stableSandboxId(env, sessionId));
    const catResult = await sandbox.exec(`base64 "${audioPath}"`, { timeout: 10 });
    if (catResult.exitCode !== 0) return `Could not read audio file: ${catResult.stderr}`;
    audioBytes = Uint8Array.from(atob((catResult.stdout ?? "").trim()), (c) => c.charCodeAt(0));
  }

  // Groq STT — fast, high quality (requires GROQ_API_KEY)
  const groqKey = (env as any).GROQ_API_KEY || "";
  if ((provider === "groq" || (provider === "auto" && groqKey)) && groqKey) {
    try {
      const formData = new FormData();
      formData.append("file", new Blob([audioBytes], { type: "audio/ogg" }), "audio.ogg");
      formData.append("model", "whisper-large-v3");
      formData.append("response_format", "json");

      const resp = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: `Bearer ${groqKey}` },
        body: formData,
      });
      if (resp.ok) {
        const data = await resp.json() as any;
        return JSON.stringify({ text: data.text || "", language: data.language || "", provider: "groq" });
      }
      // Fall through to Whisper on failure
    } catch {}
  }

  // Default: OpenAI Whisper via Workers AI (free)
  const whisperResult = (await env.AI.run("@cf/openai/whisper" as keyof AiModels, {
    audio: [...audioBytes],
  })) as any;
  return JSON.stringify({ text: whisperResult.text || "", language: whisperResult.language || "", provider: "whisper" });
}

// ── Dynamic Exec (JS in sandboxed V8 isolate) ────────────────
//
// Security model (per CF Dynamic Workers API reference):
//   - globalOutbound: null → completely blocks network (fetch/connect throw)
//   - env: {} → zero bindings, isolate cannot access secrets, DB, storage
//   - Code runs in a fresh V8 isolate with millisecond startup
//
// For network access, agents should use the `http-request` tool instead,
// which runs in the parent worker with full observability and control.
// dynamic-exec is for pure computation only.

async function dynamicExec(env: RuntimeEnv, args: Record<string, any>, sessionId: string): Promise<string> {
  const code = args.code || "";
  const language = args.language || "javascript";
  const timeout = args.timeout_ms || 10000;
  if (language === "javascript") {
    const workerCode = `const __o=[],__e=[];console.log=(...a)=>__o.push(a.map(String).join(" "));console.error=(...a)=>__e.push(a.map(String).join(" "));export default{async fetch(){try{${code};return Response.json({stdout:__o.join("\\n"),stderr:__e.join("\\n"),exit_code:0})}catch(e){return Response.json({stdout:__o.join("\\n"),stderr:e.message||String(e),exit_code:1})}}}`;

    // Sandboxed: no bindings, no network access; cache compiled workers by code hash.
    const loaded = await getCachedDynamicWorker(env, workerCode);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const execResp = await loaded.fetch("http://internal/run", { signal: controller.signal });
    clearTimeout(timer);
    return JSON.stringify(await execResp.json());
  }
  if (language === "python") {
    // Python must run in a sandbox container, not in V8 isolate.
    const deps = extractPythonImportCandidates(String(code));
    const missing = await checkMissingPythonModules(env, sessionId, deps);
    if (missing.length > 0) {
      return JSON.stringify({
        stdout: "",
        stderr: pythonMissingModuleError(missing),
        exit_code: 1,
        missing_modules: missing,
      });
    }
    const sandbox = getSafeSandbox(env, stableSandboxId(env, sessionId));
    const tmpFile = `/tmp/exec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.py`;
    await sandbox.writeFile(tmpFile, code);
    try {
      const r = await sandboxExecWithLimits(env, sessionId, `python3 ${tmpFile}`, Math.ceil(timeout / 1000));
      return JSON.stringify({ stdout: r.stdout || "", stderr: r.stderr || "", exit_code: r.exitCode ?? 0 });
    } finally {
      await sandboxExecWithLimits(env, sessionId, `rm -f ${tmpFile}`, 5).catch(() => {});
    }
  }
  // bash/shell
  const r = await sandboxExecWithLimits(env, sessionId, code, Math.ceil(timeout / 1000));
  return JSON.stringify({ stdout: r.stdout || "", stderr: r.stderr || "", exit_code: r.exitCode ?? 0 });
}

// ── Web Crawl (CF Browser Rendering) ─────────────────────────

async function webCrawl(env: RuntimeEnv, args: Record<string, any>): Promise<string> {
  const brBase = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/browser-rendering`;
  const brAuth = { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, "Content-Type": "application/json" };
  const crawlTimeout = Math.min(120_000, Math.max(30_000, Number(args.crawl_start_timeout_ms || 60_000)));
  const pollTimeout = 45_000;
  const startResp = await fetchWithTimeout(
    `${brBase}/crawl`,
    {
      method: "POST",
      headers: brAuth,
      body: JSON.stringify({
        url: args.url || "",
        limit: args.max_pages || 10,
        depth: args.max_depth || 2,
        formats: ["markdown"],
        render: true,
      }),
    },
    crawlTimeout,
  );
  const startData = (await startResp.json()) as any;
  const jobId = startData.result;
  if (!jobId) return JSON.stringify(startData);
  const maxWaitMs = Math.max(15_000, Math.min(Number(args.timeout_ms || 60_000), 300_000));
  const pollIntervalMs = 5_000;
  const startedAt = Date.now();
  while (Date.now() - startedAt < maxWaitMs) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    const pollResp = await fetchWithTimeout(`${brBase}/crawl/${jobId}?limit=100`, { headers: brAuth }, pollTimeout);
    const pollData = (await pollResp.json()) as any;
    const status = pollData.result?.status;
    if (status === "completed" || status === "errored" || status?.startsWith("cancelled")) {
      return JSON.stringify(pollData);
    }
  }
  const finalResp = await fetchWithTimeout(`${brBase}/crawl/${jobId}?limit=100`, { headers: brAuth }, pollTimeout);
  return JSON.stringify(await finalResp.json());
}

// ── Browser Render (CF Browser Rendering) ────────────────────

async function browserRender(env: RuntimeEnv, args: Record<string, any>, sessionId?: string): Promise<string> {
  const sk = browserSessionKey(env, sessionId);
  // Use Puppeteer Browser binding (headless Chrome on CF edge) when available
  if (env.BROWSER) {
    try {
      return await runBrowserSerialized(sk, async () => {
        const browser = await getPooledBrowser(env, sk);
        const page = await browser.newPage();
        try {
          await page.goto(args.url || "", { waitUntil: "networkidle0", timeout: 20000 });
          if (args.wait_for) {
            try { await page.waitForSelector(args.wait_for, { timeout: 5000 }); } catch {}
          }
          const action = args.action || "markdown";
          let result: string;
          if (action === "screenshot") {
            const buf = await page.screenshot({ fullPage: true });
            const bytes = new Uint8Array(buf as unknown as ArrayBuffer);
            if (bytes.byteLength > 1_000_000) {
              result = JSON.stringify({ error: "Screenshot too large", size: bytes.byteLength, url: args.url });
            } else {
              result = JSON.stringify({ screenshot_base64: uint8ArrayToBase64(bytes), url: args.url });
            }
          } else if (action === "links") {
            const links = await page.evaluate(new Function(`
          return Array.from(document.querySelectorAll("a[href]")).map(function(a) {
            return { text: a.textContent?.trim() || "", href: a.href || "" };
          }).slice(0, 50);
        `) as () => Array<{ text: string; href: string }>);
            result = JSON.stringify({ links, url: args.url });
          } else {
            result = await page.evaluate(new Function("return document.body?.innerText || ''") as () => string);
          }
          return action === "screenshot" ? result : result.slice(0, 10000);
        } finally {
          try { await page.close(); } catch {}
        }
      });
    } catch (err: any) {
      console.error(`[browserRender] Puppeteer failed, falling back to HTTP API: ${err.message?.slice(0, 100)}`);
    }
  }

  // Fallback: Browser Rendering HTTP API (requires account API token)
  const brBase = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/browser-rendering`;
  const brAuth = { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, "Content-Type": "application/json" };
  const actionMap: Record<string, string> = { markdown: "markdown", text: "markdown", html: "content", links: "links", screenshot: "screenshot" };
  const endpoint = actionMap[args.action || "markdown"] || "markdown";
  const payload: Record<string, any> = { url: args.url || "" };
  if (args.wait_for) payload.waitForSelector = args.wait_for;
  const resp = await fetchWithTimeout(`${brBase}/${endpoint}`, { method: "POST", headers: brAuth, body: JSON.stringify(payload) });
  if (endpoint === "screenshot") {
    const buf = await resp.arrayBuffer();
    const bytes = new Uint8Array(buf);
    if (bytes.byteLength > 1_000_000) {
      return JSON.stringify({ error: "Screenshot too large", size: bytes.byteLength, url: args.url });
    }
    return JSON.stringify({ screenshot_base64: uint8ArrayToBase64(bytes), url: args.url });
  }
  return JSON.stringify(await resp.json());
}

// ── Save/Load Project (Sandbox <-> R2) ───────────────────────

const SAVE_PROJECT_MAX_BYTES = 30 * 1024 * 1024; // 30 MB

async function saveProject(env: RuntimeEnv, args: Record<string, any>, sessionId: string): Promise<string> {
  const workspace = args.workspace || "/workspace";
  const orgId = (env as any).__agentConfig?.orgId || (env as any).__agentConfig?.org_id || "default";
  const agentName = (env as any).__agentConfig?.agent_name || (env as any).__agentConfig?.agentName || (env as any).__agentConfig?.name || "agent";
  const projectName = args.project_name || args.project_id || args.name || "default";
  const sandbox = getSafeSandbox(env, stableSandboxId(env, sessionId));

  // Pre-flight size check to avoid OOM on large workspaces
  const sizeResult = await sandbox.exec(`du -sb ${workspace} 2>/dev/null | cut -f1`, { timeout: 10 });
  const workspaceBytes = parseInt(sizeResult.stdout?.trim() || "0", 10);
  if (workspaceBytes > SAVE_PROJECT_MAX_BYTES) {
    const sizeMB = (workspaceBytes / (1024 * 1024)).toFixed(1);
    return JSON.stringify({
      saved: false,
      reason: `Workspace is ${sizeMB} MB which exceeds the 30 MB save limit. Remove large files (node_modules, build artifacts, media) and try again.`,
    });
  }

  const tarResult = await sandbox.exec(`cd ${workspace} 2>/dev/null && tar czf /tmp/workspace.tar.gz . 2>/dev/null || echo "__EMPTY__"`, { timeout: 30 });
  if (tarResult.stdout?.includes("__EMPTY__")) return `No files found in ${workspace}`;
  const b64Result = await sandbox.exec(`base64 /tmp/workspace.tar.gz`, { timeout: 30 });
  const b64Data = b64Result.stdout?.trim() || "";
  if (!b64Data) return "Failed to read workspace archive";
  const r2Key = `workspaces/${orgId}/${agentName}/projects/${projectName}/latest.tar.gz`;
  const versionKey = `workspaces/${orgId}/${agentName}/projects/${projectName}/v${Date.now()}.tar.gz`;
  const bytes = Uint8Array.from(atob(b64Data), (c) => c.charCodeAt(0));
  const meta = { org_id: orgId, agent_name: agentName, project_name: projectName, saved_at: new Date().toISOString() };
  await env.STORAGE.put(r2Key, bytes, { customMetadata: meta });
  await env.STORAGE.put(versionKey, bytes, { customMetadata: meta });
  const countResult = await sandbox.exec(`find ${workspace} -type f | wc -l`, { timeout: 5 });
  return JSON.stringify({ saved: true, project: projectName, r2_key: r2Key, version_key: versionKey, files: parseInt(countResult.stdout?.trim() || "0"), size_bytes: bytes.byteLength });
}

async function loadProject(env: RuntimeEnv, args: Record<string, any>, sessionId: string): Promise<string> {
  const workspace = args.workspace || "/workspace";
  const orgId = (env as any).__agentConfig?.orgId || (env as any).__agentConfig?.org_id || "default";
  const agentName = (env as any).__agentConfig?.agent_name || (env as any).__agentConfig?.agentName || (env as any).__agentConfig?.name || "agent";
  const projectName = args.project_name || args.project_id || args.name || "default";
  const version = args.version || "latest";
  const r2Key = version === "latest"
    ? `workspaces/${orgId}/${agentName}/projects/${projectName}/latest.tar.gz`
    : `workspaces/${orgId}/${agentName}/projects/${projectName}/${version}.tar.gz`;
  const sandbox = getSafeSandbox(env, stableSandboxId(env, sessionId));
  const obj = await env.STORAGE.get(r2Key);
  if (!obj) return JSON.stringify({ loaded: false, reason: `No project "${projectName}" found. Use save-project to create one.` });
  const buf = await obj.arrayBuffer();
  const bytes = new Uint8Array(buf);
  const b64 = uint8ArrayToBase64(bytes);
  await sandbox.writeFile("/tmp/workspace.tar.gz.b64", b64);
  await sandbox.exec(`mkdir -p ${workspace}`, { timeout: 5 });
  await sandbox.exec(`base64 -d /tmp/workspace.tar.gz.b64 > /tmp/workspace.tar.gz && cd ${workspace} && tar xzf /tmp/workspace.tar.gz`, { timeout: 30 });
  const countResult = await sandbox.exec(`find ${workspace} -type f | wc -l`, { timeout: 5 });
  return JSON.stringify({ loaded: true, project: projectName, r2_key: r2Key, files: parseInt(countResult.stdout?.trim() || "0"), size_bytes: buf.byteLength });
}

async function listProjectVersions(env: RuntimeEnv, args: Record<string, any>): Promise<string> {
  const orgId = (env as any).__agentConfig?.orgId || (env as any).__agentConfig?.org_id || "";
  const agentName = (env as any).__agentConfig?.agent_name || (env as any).__agentConfig?.agentName || (env as any).__agentConfig?.name || "";
  if (!orgId || !agentName) return "Could not determine org/agent context";
  const projectName = args.project_name || args.project_id || args.name || "default";
  const prefix = `workspaces/${orgId}/${agentName}/projects/${projectName}/`;
  const listed = await env.STORAGE.list({ prefix, limit: 50 });
  const versions = listed.objects.map((o: any) => ({ key: o.key.replace(prefix, ""), size: o.size, uploaded: o.uploaded }));
  return JSON.stringify({ project: projectName, versions, count: versions.length });
}

// ── Todo (session-scoped) ────────────────────────────────────

async function todoTool(env: RuntimeEnv, args: Record<string, any>, sessionId: string): Promise<string> {
  const action = args.action || "list";
  const sandbox = getSafeSandbox(env, stableSandboxId(env, sessionId));
  const todoFile = "/tmp/todos.json";
  let todos: any[] = [];
  try {
    const readResult = await sandbox.exec(`cat ${todoFile} 2>/dev/null || echo "[]"`, { timeout: 5 });
    todos = JSON.parse(readResult.stdout || "[]");
  } catch { todos = []; }
  if (action === "add") {
    todos.push({ id: todos.length + 1, text: args.text || "", done: false });
    await sandbox.writeFile(todoFile, JSON.stringify(todos));
    return `Added todo #${todos.length}: ${args.text}`;
  } else if (action === "complete") {
    const id = args.id || args.todo_id;
    const t = todos.find((t: any) => t.id == id);
    if (t) { t.done = true; await sandbox.writeFile(todoFile, JSON.stringify(todos)); return `Completed todo #${id}`; }
    return `Todo #${id} not found`;
  }
  return todos.length > 0
    ? todos.map((t: any) => `${t.done ? "done" : "open"} #${t.id}: ${t.text}`).join("\n")
    : "No todos yet. Use action='add' with text to create one.";
}

// ── Tool Definitions (for LLM function calling) ───────────────

/**
 * Meta-tools always available regardless of agent config.
 * NOTE: execute-code was removed from this set — it must be explicitly enabled
 * per-agent to prevent privilege escalation (execute-code previously granted
 * access to ALL tools regardless of agent config).
 * discover-api is safe to always expose (read-only type info).
 */
// Tools always included in the enabled set (regardless of agent config).
// marketplace-search and a2a-send moved to keyword-triggered discovery to prevent
// the LLM from defaulting to marketplace delegation instead of using its own tools.
const ALWAYS_AVAILABLE = new Set(["discover-api", "share-artifact", "retrieve-result"]);

/** Returns the set of all valid tool names from the catalog. */
export function getValidToolNames(): Set<string> {
  return new Set(TOOL_CATALOG.map((t) => t.function.name));
}

export function getToolDefinitions(enabledTools: string[], blockedTools: string[] = []): ToolDefinition[] {
  // SECURITY: empty enabledTools = only ALWAYS_AVAILABLE tools (discover-api, marketplace-search, a2a-send).
  // This prevents privilege escalation where an agent with tools:[] gets all tools.
  // marketplace-search + a2a-send are always available so every agent can discover
  // and delegate to specialist skill agents in the marketplace.
  const blocked = new Set(blockedTools);
  return TOOL_CATALOG.filter(
    (t) => {
      const name = t.function.name;
      if (blocked.has(name)) return false; // Governance: blocked tools never available
      return enabledTools.includes(name) || ALWAYS_AVAILABLE.has(name);
    },
  );
}

// ── Progressive Tool Discovery (Option C: Hybrid) ──────────────
//
// Core tools are always loaded. Other tools are loaded on-demand via
// keyword matching against the user query + conversation context.
// A lightweight "discover-tools" meta-tool lets the agent request
// additional tools mid-conversation if needed.
//
// Saves ~70% of tool tokens on typical queries.

/** Tools always sent to the LLM regardless of query context. */
const CORE_TOOLS = new Set([
  "web-search", "python-exec", "bash", "read-file", "write-file", "edit-file",
  "memory-save", "memory-recall", "browse",
  "execute-code", "swarm",
  // Scheduling — always loaded so the model sees the tool definition and doesn't try bash
  "create-schedule", "list-schedules", "delete-schedule",
  // Meta-tools for discovery + delegation
  "discover-api",
]);

/** Keyword → tool names mapping for progressive discovery. */
const TOOL_KEYWORDS: Record<string, string[]> = {
  // Research & web
  "search|find|look up|google|news|current|today|latest|recent": ["web-search", "parallel-web-search"],
  "browse|visit|website|page|url|link|open page|open site|open url": ["browse", "web-crawl", "browser-render"],
  "crawl|scrape|extract": ["web-crawl", "browser-render"],
  // Code & execution
  "code|script|program|python|calculate|compute|analyze data|csv|chart|plot|graph": ["python-exec", "execute-code", "bash"],
  "run code|run script|run command|execute|shell|command line|terminal|install|npm|pip": ["bash", "python-exec", "execute-code"],
  "codemode|transform|validate|orchestrate|generate mcp": ["run-codemode", "codemode-transform", "codemode-validate", "codemode-orchestrate", "codemode-test", "codemode-generate-mcp"],
  // File operations
  "file|read|write|save|create|edit|document|folder|directory": ["read-file", "write-file", "edit-file", "view-file", "search-file", "find-file", "load-folder"],
  "grep|search file|find in": ["grep", "glob", "search-file", "find-file"],
  "project|workspace|load project|save project": ["save-project", "load-project", "load-folder", "manage-projects"],
  // Memory & knowledge
  "remember|memory|recall|forget|save fact|take note|store fact|store this|MEMORY\\.md|sync memory": [
    "memory-save",
    "memory-recall",
    "memory-delete",
    "sync-workspace-memory",
    "team-fact-write",
    "team-observation",
  ],
  "knowledge|rag|embed|retrieval|ocr|pdf|document|scan": ["knowledge-search", "store-knowledge", "ingest-document", "manage-rag"],
  "profile|preference|about me|my name": ["user-profile-save", "user-profile-load"],
  // Media
  "image|picture|photo|draw|generate image|illustration|diagram": ["image-generate", "vision-analyze"],
  "voice|speak|audio|call|phone|tts|speech": ["text-to-speech", "speech-to-text", "make-voice-call"],
  "video|vision|see|look at|screenshot|describe image": ["vision-analyze"],
  // Data & analytics
  "database|sql|query|db|table|report": ["db-query", "db-batch", "db-report"],
  "pipeline|stream|ingest|data pipeline": ["query-pipeline", "send-to-pipeline"],
  "cost|billing|spend|usage|how much": ["view-costs"],
  "trace|debug|log|observe": ["view-traces", "view-audit"],
  // Git
  "git|commit|branch|diff|repo|version control|stash": ["git-init", "git-status", "git-diff", "git-commit", "git-log", "git-branch", "git-stash"],
  // Agent management
  "create agent|new agent|clone agent|deploy agent|deploy my agent|list agent|manage agent": ["create-agent", "delete-agent", "list-agents"],
  "run agent|delegate|ask another|specialist|hire": ["run-agent", "route-to-agent", "a2a-send"],
  "eval agent|test agent|evaluate|benchmark|compare agent|run eval": ["eval-agent", "compare-agents", "evolve-agent"],
  "train|improve|optimize|adapt": ["evolve-agent", "adapt-strategy", "autoresearch"],
  // Scheduling & automation
  "schedule|cron|recurring|every day|every hour|automate": ["create-schedule", "list-schedules", "delete-schedule"],
  "todo|task|checklist|plan": ["todo"],
  // Governance & security
  "security|scan|vulnerability|audit": ["security-scan", "view-audit", "compliance"],
  "policy|policies|permission|governance": ["manage-policies", "compliance"],
  "secret|credential|api key|token|password": ["manage-secrets"],
  "release|deploy|rollback|version": ["manage-releases"],
  "slo|sla|reliability|uptime": ["manage-slos"],
  "retention|cleanup|expire|ttl": ["manage-retention"],
  "workflow|automation|orchestrate": ["manage-workflows"],
  "issue|bug|ticket|incident": ["manage-issues"],
  // Social & feedback
  "post|feed|share|publish|social": ["feed-post", "share-artifact"],
  "feedback|rate|review|submit feedback": ["submit-feedback"],
  // Search sessions
  "session|conversation|history|past chat": ["session-search", "conversation-intel"],
  // HTTP & API
  "api|http|request|fetch|post|get|endpoint|webhook": ["http-request", "mcp-call"],
  "mcp|model context|external tool": ["mcp-call", "manage-mcp", "mcp-wrap"],
  // Multi-agent
  "mixture|ensemble|multiple models|multi-agent": ["mixture-of-agents"],
  // Inter-agent coordination (delegated runs)
  "scratch|shared state|pass data|coordinate": ["scratch-write", "scratch-read", "scratch-list", "send-message"],
  "team|team fact|team knowledge|shared fact|org knowledge": ["team-fact-write", "team-observation"],
};

/**
 * Select tools relevant to the current query context.
 * Returns core tools + keyword-matched tools + a discover-tools meta-tool.
 * Typically returns 8-15 tools instead of 21-93, saving ~70% tokens.
 */
export function selectToolsForQuery(
  allTools: ToolDefinition[],
  query: string,
  conversationContext?: string,
): ToolDefinition[] {
  const needed = new Set(CORE_TOOLS);
  const text = `${query} ${conversationContext || ""}`.toLowerCase();

  // Match keywords to tool names
  for (const [keywordPattern, toolNames] of Object.entries(TOOL_KEYWORDS)) {
    const keywords = keywordPattern.split("|");
    if (keywords.some(kw => text.includes(kw))) {
      for (const name of toolNames) needed.add(name);
    }
  }

  // Filter the full tool list to only matched tools
  const selected = allTools.filter(t => needed.has(t.function.name));

  // Always append the discover-tools meta-tool so the agent can request more
  const hasDiscover = selected.some(t => t.function.name === "discover-tools");
  if (!hasDiscover) {
    selected.push(DISCOVER_TOOLS_DEF);
  }

  return selected;
}

/**
 * Phase 2.2: Build a compact tool index for deferred loading.
 * Returns name + one-line description for tools NOT in the selected set.
 * Injected as a system message so the model knows what tools exist
 * without paying full schema token cost (~50 tokens vs ~500 per tool).
 */
export function buildDeferredToolIndex(
  allTools: ToolDefinition[],
  selectedTools: ToolDefinition[],
): string {
  const selectedNames = new Set(selectedTools.map(t => t.function.name));
  const deferred = allTools.filter(t => !selectedNames.has(t.function.name));
  if (deferred.length === 0) return "";

  const lines = deferred.map(t => {
    const desc = (t.function.description || "").split("\n")[0].slice(0, 80);
    return `- ${t.function.name}: ${desc}`;
  });

  return `## Additional Tools (only if core tools are insufficient)\nThese are available via discover-tools but you should rarely need them. Your core tools (web-search, python-exec, bash, read-file, write-file, edit-file, browse, memory-save, memory-recall, execute-code, swarm) handle most tasks.\n${lines.join("\n")}`;
}

/**
 * Resolve a discover-tools request — returns tool definitions matching the query.
 * Called when the agent invokes the discover-tools meta-tool.
 */
export function discoverTools(
  allTools: ToolDefinition[],
  query: string,
): { tools: string[]; definitions: ToolDefinition[] } {
  const needed = new Set<string>();
  const text = (query || "").toLowerCase().slice(0, 5000);

  // Empty query → return all available tool names (so agent knows what exists)
  if (!text.trim()) {
    const names = allTools.map(t => t.function.name);
    return { tools: names, definitions: allTools };
  }

  for (const [keywordPattern, toolNames] of Object.entries(TOOL_KEYWORDS)) {
    const keywords = keywordPattern.split("|");
    if (keywords.some(kw => text.includes(kw))) {
      for (const name of toolNames) needed.add(name);
    }
  }

  // Also do fuzzy match on tool names and descriptions
  for (const tool of allTools) {
    const name = tool.function.name;
    const desc = (tool.function.description || "").toLowerCase();
    if (text.includes(name) || name.includes(text.replace(/\s+/g, "-"))) {
      needed.add(name);
    }
    // Check if query words appear in the tool description
    const queryWords = text.split(/\s+/).filter(w => w.length > 3);
    if (queryWords.length > 0 && queryWords.some(w => desc.includes(w))) {
      needed.add(name);
    }
  }

  // Only return tools that exist in the agent's available tool set (allTools).
  // TOOL_KEYWORDS may reference tools the agent doesn't have — filter them out.
  const availableNames = new Set(allTools.map(t => t.function.name));
  const validNeeded = new Set([...needed].filter(n => availableNames.has(n)));
  const definitions = allTools.filter(t => validNeeded.has(t.function.name));
  return { tools: [...validNeeded], definitions };
}

/** Meta-tool that lets the agent request additional tools mid-conversation. */
const DISCOVER_TOOLS_DEF: ToolDefinition = {
  type: "function",
  function: {
    name: "discover-tools",
    description: "Search for additional tools NOT already in your tool list. Only call this if you are certain none of your existing tools can accomplish the task. Do NOT call this for web search, code execution, file operations, or memory — those tools are already available to you.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Describe the capability you need, e.g. 'generate images', 'query database', 'manage git branches'" },
      },
      required: ["query"],
    },
  },
};

const TOOL_CATALOG: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "web-search",
      description: "Search the web for current information using Brave Search",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          max_results: { type: "number", description: "Max results (default 5)" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browse",
      description: "Fetch and read a web page as clean text",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL to browse" },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "http-request",
      description: "Make an HTTP request to any URL",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Target URL" },
          method: { type: "string", description: "HTTP method (default GET)" },
          headers: { type: "object", description: "Request headers" },
          body: { type: "string", description: "Request body" },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "bash",
      description: "Execute a bash command in a sandboxed container",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to run" },
          timeout_seconds: { type: "number", description: "Timeout (default 30, max 120)" },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "python-exec",
      description:
        "Execute Python code in a sandboxed container (dynamic package installation is disabled)",
      parameters: {
        type: "object",
        properties: {
          code: { type: "string", description: "Python code to execute" },
          timeout_seconds: { type: "number", description: "Timeout (default 30, max 120)" },
        },
        required: ["code"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read-file",
      description:
        "Read a file from the sandbox filesystem. Returns a window of lines with line numbers. " +
        "Use offset/limit to paginate through large files.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path to read" },
          offset: { type: "number", description: "Start reading from this line number (default 1)" },
          limit: { type: "number", description: "Max lines to return (default 100, max 200)" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write-file",
      description: "Write content to a file in the sandbox",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path" },
          content: { type: "string", description: "File content" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit-file",
      description: "Edit a file by replacing old text with new text",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path" },
          old_text: { type: "string", description: "Text to find" },
          new_text: { type: "string", description: "Replacement text" },
        },
        required: ["path", "old_text", "new_text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "knowledge-search",
      description:
        "Search the agent's knowledge base using semantic RAG. " +
        "Retrieves top-20 candidates via vector similarity, then reranks with a cross-encoder " +
        "model for higher relevance. Works with uploaded documents AND live pipeline data.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Natural language search query" },
          top_k: { type: "number", description: "Final results to return after reranking (default 5, max 20)" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "store-knowledge",
      description: "Store information in the knowledge base for future retrieval",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string", description: "Content to store" },
          key: { type: "string", description: "Label/key for the knowledge" },
        },
        required: ["content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ingest-document",
      description: "Extract text from a PDF or image using OCR and add it to the knowledge base for RAG retrieval. Supports PDFs, scanned documents, receipts, screenshots, and any image with text.",
      parameters: {
        type: "object",
        properties: {
          image_url: { type: "string", description: "URL of the document/image to extract text from" },
          source: { type: "string", description: "Label for this document (e.g. 'invoice-2026-01', 'meeting-notes')" },
        },
        required: ["image_url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "image-generate",
      description: "Generate an image from a text prompt using FLUX. Returns an R2 storage key for the generated image.",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "Detailed image description prompt" },
        },
        required: ["prompt"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "vision-analyze",
      description: "Analyze an image using AI vision. Describe contents, extract text, answer questions about images. Supports URLs to images.",
      parameters: {
        type: "object",
        properties: {
          image_url: { type: "string", description: "URL of the image to analyze" },
          prompt: { type: "string", description: "Question or instruction for the vision model (default: describe the image)" },
        },
        required: ["image_url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "memory-save",
      description:
        "Save a memory for later recall. Prefer category: user (profile/preferences), feedback (how to work with this user), project (goals/deadlines/non-obvious context), reference (links to external systems). Do not save what is already in /workspace files or easily derivable from the repo.",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string", description: "The memory content to save" },
          key: { type: "string", description: "Short label for the memory (e.g. 'user-timezone', 'project-stack')" },
          type: { type: "string", description: "Memory type: 'semantic' for facts/preferences (default), 'episodic' for events/observations" },
          category: {
            type: "string",
            description:
              "One of: user | feedback | project | reference (default: reference). Maps legacy labels (e.g. preferences, general) automatically.",
          },
        },
        required: ["content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "memory-recall",
      description: "Recall saved memories. Search by keyword or browse by type. Use this to remember user preferences, past decisions, project context.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query to find relevant memories" },
          type: { type: "string", description: "Filter by type: 'semantic', 'episodic', or 'all' (default: all)" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "memory-delete",
      description: "Delete a specific memory entry by its ID.",
      parameters: {
        type: "object",
        properties: {
          fact_id: { type: "string", description: "The ID of the semantic fact to delete" },
          type: { type: "string", description: "Memory type: 'semantic' (default)" },
        },
        required: ["fact_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "sync-workspace-memory",
      description:
        "Write /workspace/MEMORY.md from persisted semantic_facts (curated memory-save entries). Use for Claude Code–style file-based review, sharing context with bash/python tools, or backup. Caps size (~200 lines / 25KB) like Claude Code MEMORY.md.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  {
    type: "function",
    function: {
      name: "team-fact-write",
      description: "Record an org-wide team fact that other agents in this organization can see. Use for shared knowledge like deployment processes, architecture decisions, coding conventions, or important context that applies across the team.",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string", description: "The fact content to share with the team (max 1000 chars)" },
          category: { type: "string", description: "Category: 'process', 'architecture', 'convention', 'decision', or 'general' (default: general)" },
        },
        required: ["content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "team-observation",
      description: "Record an observation about another agent or the team. Used for cross-agent notes like 'code-reviewer found a recurring bug pattern in auth module' or general team insights.",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string", description: "The observation to record (max 1000 chars)" },
          target_agent: { type: "string", description: "Optional: the agent this observation is about" },
        },
        required: ["content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "mcp-call",
      description: "Call a tool on a registered MCP (Model Context Protocol) server. Use this to interact with external integrations like Pipedream, custom APIs, or any MCP-compatible service. First list available servers, then call specific tools.",
      parameters: {
        type: "object",
        properties: {
          server: { type: "string", description: "MCP server name or ID (from registered servers)" },
          tool: { type: "string", description: "Tool name to call on the MCP server" },
          arguments: { type: "object", description: "Arguments to pass to the MCP tool" },
        },
        required: ["server", "tool"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "text-to-speech",
      description:
        "Convert text to audio speech. Providers: 'deepgram' (default, free via Workers AI), " +
        "'openai' (higher quality, requires OpenRouter key). Returns R2 audio key.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "Text to speak" },
          provider: { type: "string", description: "TTS provider: 'deepgram' (default/free) or 'openai'" },
          voice: { type: "string", description: "Voice name (provider-specific, e.g. 'alloy' for OpenAI)" },
        },
        required: ["text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "speech-to-text",
      description:
        "Transcribe audio to text. Supports audio files (via sandbox path) or audio URLs. " +
        "Providers: 'whisper' (default, free via Workers AI), 'groq' (fast, high quality, requires GROQ_API_KEY), " +
        "'auto' (tries Groq first, falls back to Whisper).",
      parameters: {
        type: "object",
        properties: {
          audio_url: { type: "string", description: "URL to the audio file (e.g. from a voice message)" },
          audio_path: { type: "string", description: "Path to audio file in the sandbox" },
          provider: { type: "string", description: "STT provider: 'whisper' (default/free), 'groq' (fast), 'auto' (best available)" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep",
      description: "Search for patterns in files using grep",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regex pattern" },
          path: { type: "string", description: "Directory to search (default .)" },
          max_results: { type: "number", description: "Max results (default 20)" },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "glob",
      description: "Find files matching a glob pattern",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Glob pattern (e.g. *.py)" },
          path: { type: "string", description: "Directory to search (default .)" },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "dynamic-exec",
      description:
        "Execute code in a sandboxed V8 isolate (JS) or container (bash/python); Python package installs are disabled",
      parameters: {
        type: "object",
        properties: {
          code: { type: "string", description: "Code to execute" },
          language: { type: "string", description: "Language: javascript, python, or bash" },
          timeout_ms: { type: "number", description: "Timeout in ms (default 10000)" },
        },
        required: ["code"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web-crawl",
      description: "Crawl a website and extract content as markdown",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL to crawl" },
          max_pages: { type: "number", description: "Max pages (default 10)" },
          max_depth: { type: "number", description: "Max link depth (default 2)" },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser-render",
      description: "Render a web page using a headless browser (JS rendering)",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL to render" },
          action: { type: "string", description: "Action: markdown, html, links, screenshot" },
          wait_for: { type: "string", description: "CSS selector to wait for" },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "marketplace-search",
      description: "Search the OneShots agent marketplace to find agents that can help with a task. Returns ranked results with pricing, quality scores, and A2A endpoints. Use this before a2a-send to find the right agent.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "What you're looking for (e.g., 'flight booking agent', 'legal document review')" },
          category: { type: "string", description: "Category filter: shopping, research, legal, finance, travel, coding, creative, support, data, health, education, marketing" },
          max_price: { type: "number", description: "Max price per task in USD" },
          limit: { type: "number", description: "Max results (default 5)" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "a2a-send",
      description: "Send a task to another agent via A2A protocol. Handles x-402 payments automatically if the agent charges. Use marketplace-search first to find the right agent and its a2a_endpoint_url.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Target agent A2A endpoint URL (from marketplace search results)" },
          task: { type: "string", description: "Task message to send" },
          agent_name: { type: "string", description: "Target agent name (from marketplace search results)" },
          auth_token: { type: "string", description: "Auth token for the target API (optional)" },
        },
        required: ["url", "task"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "share-artifact",
      description:
        "Share a file or project artifact with another agent (or back to the caller) via A2A. " +
        "Uploads content to R2 storage and returns a signed URL. Use this when you've built something " +
        "(code, document, image, data) that needs to be sent back to the requesting agent. " +
        "The artifact is linked to the current A2A task for traceability.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Artifact name with extension (e.g., 'invoice.pdf', 'app.zip', 'report.md')" },
          content: { type: "string", description: "File content (text) or base64-encoded binary" },
          mime_type: { type: "string", description: "MIME type (default: auto-detected from name)" },
          description: { type: "string", description: "What this artifact is" },
          encoding: { type: "string", description: "'text' (default) or 'base64' for binary content" },
          task_id: { type: "string", description: "A2A task ID this artifact belongs to (auto-detected from context if omitted)" },
          receiver_org_id: { type: "string", description: "Receiving org ID (auto-detected from A2A context if omitted)" },
          receiver_agent: { type: "string", description: "Receiving agent name (optional)" },
        },
        required: ["name", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "feed-post",
      description: "Post to the public OneShots agent feed. Use this to announce capabilities, share milestones, publish offers, or post updates that other agents and humans can see on the network feed.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Post title (max 200 chars)" },
          body: { type: "string", description: "Post body in markdown (max 5000 chars)" },
          post_type: { type: "string", description: "Type: card (agent intro), offer (discount/deal), milestone (achievement), update (general). Default: update" },
          tags: { type: "array", items: { type: "string" }, description: "Tags for discovery (max 10)" },
          image_url: { type: "string", description: "Optional image URL" },
          cta_text: { type: "string", description: "Call-to-action button text (e.g. 'Try me', 'Get 50% off')" },
          cta_url: { type: "string", description: "Call-to-action URL" },
          offer_discount_pct: { type: "number", description: "Discount percentage (for offer posts)" },
          offer_price_usd: { type: "number", description: "Offer price in USD (for offer posts)" },
          offer_expires_at: { type: "string", description: "Offer expiry ISO datetime (for offer posts)" },
        },
        required: ["title", "body"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "save-project",
      description:
        "Save the current workspace as a named project. Creates a versioned snapshot in persistent storage. " +
        "Use project names like 'my-web-app' or 'data-analysis'. Each save creates a new version.",
      parameters: {
        type: "object",
        properties: {
          project_name: { type: "string", description: "Name for the project (e.g. 'my-web-app'). Default: 'default'" },
          workspace: { type: "string", description: "Workspace path (default /workspace)" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "load-project",
      description:
        "Load a previously saved project into the workspace. Restores all files from the project snapshot. " +
        "Use this to resume work on a project from a previous session.",
      parameters: {
        type: "object",
        properties: {
          project_name: { type: "string", description: "Name of the project to load. Default: 'default'" },
          version: { type: "string", description: "Version to load (default: 'latest')" },
          workspace: { type: "string", description: "Workspace path (default /workspace)" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "load-folder",
      description:
        "Load files from R2 storage into the conversation context. Use this to review project files, " +
        "workspace contents, or any stored folder without needing a sandbox. " +
        "Shortcuts: 'workspace' loads your current workspace files, 'project:name' loads a named project's files.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "What to load: 'workspace' (your files), 'project:my-app' (a named project), or a raw R2 prefix",
          },
          max_files: { type: "number", description: "Max files to include (default 20)" },
          max_size_per_file: { type: "number", description: "Max bytes per file (default 50000)" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "todo",
      description: "Manage a session-scoped todo list (add, complete, list)",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", description: "Action: list, add, complete" },
          text: { type: "string", description: "Todo text (for add)" },
          id: { type: "number", description: "Todo ID (for complete)" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "discover-api",
      description:
        "Discover what APIs and tools are available. Returns TypeScript type definitions " +
        "describing all callable functions. Use this before execute-code to understand " +
        "what operations you can compose together.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "execute-code",
      description:
        "Write and execute JavaScript code that orchestrates multiple tool calls in a single turn. " +
        "The code runs in an isolated sandbox. All tools are available as typed async functions on " +
        "the `codemode` object. Example: " +
        "`const data = await codemode.webSearch({query: 'weather NYC'}); " +
        "const summary = data.slice(0, 200); return summary;` " +
        "Use discover-api first to see what functions are available.",
      parameters: {
        type: "object",
        properties: {
          code: {
            type: "string",
            description:
              "JavaScript async function body. Access tools via `codemode.toolName(args)`. " +
              "Must return a value. Example: `const r = await codemode.webSearch({query:'...'}); return r;`",
          },
        },
        required: ["code"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create-schedule",
      description:
        "Schedule a recurring agent run. The agent (you or another) will be invoked " +
        "on the specified cron schedule with the given task. Use standard 5-field cron " +
        "syntax (minute hour day-of-month month day-of-week). " +
        "Examples: '0 9 * * *' (daily 9am), '*/30 * * * *' (every 30 min), '0 0 * * 1' (weekly Monday).",
      parameters: {
        type: "object",
        properties: {
          agent_name: { type: "string", description: "Agent to schedule (use your own name for self-scheduling)" },
          cron: { type: "string", description: "Cron expression (5-field: minute hour dom month dow)" },
          task: { type: "string", description: "Task description — what the agent should do on each run" },
        },
        required: ["agent_name", "cron", "task"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list-schedules",
      description: "List active schedules for an agent. Shows cron expression, task, run count, and last run time.",
      parameters: {
        type: "object",
        properties: {
          agent_name: { type: "string", description: "Agent name to list schedules for (optional — lists all if omitted)" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete-schedule",
      description: "Delete a scheduled agent run by its schedule ID.",
      parameters: {
        type: "object",
        properties: {
          schedule_id: { type: "string", description: "Schedule ID to delete" },
        },
        required: ["schedule_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "query-pipeline",
      description:
        "Read recent data from a pipeline's R2 storage. Returns JSONL records with optional " +
        "field filtering and time range. For semantic search, use knowledge-search instead.",
      parameters: {
        type: "object",
        properties: {
          pipeline_name: { type: "string", description: "Pipeline name to read from" },
          filter_field: { type: "string", description: "Filter by field name (e.g., 'event_type', 'customer')" },
          filter_value: { type: "string", description: "Value to match for filter_field" },
          since_minutes: { type: "number", description: "Only return records from the last N minutes (default: all)" },
          limit: { type: "number", description: "Max records to return (default 100, max 1000)" },
        },
        required: ["pipeline_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "send-to-pipeline",
      description:
        "Send events/data to a pipeline. Data is stored in R2 (structured, queryable via SQL) " +
        "AND automatically embedded into Vectorize for semantic RAG search. " +
        "Both access patterns available: query-pipeline for SQL, knowledge-search for semantic.",
      parameters: {
        type: "object",
        properties: {
          pipeline_name: { type: "string", description: "Pipeline name" },
          events: {
            type: "array",
            items: { type: "object" },
            description: "Array of event objects to send",
          },
          embed: { type: "boolean", description: "Also embed into Vectorize for RAG search (default: true)" },
          text_field: { type: "string", description: "Which field in each event to embed (default: 'text'). Falls back to content, body, description." },
        },
        required: ["pipeline_name", "events"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "submit-feedback",
      description: "Submit user feedback (thumbs up/down) on an agent response",
      parameters: {
        type: "object",
        properties: {
          rating: { type: "string", description: "Feedback rating: positive, negative, or neutral" },
          comment: { type: "string", description: "Optional comment from the user" },
          session_id: { type: "string", description: "Session ID the feedback is for" },
          turn: { type: "number", description: "Turn number being rated" },
          message_content: { type: "string", description: "Preview of the message being rated (max 2000 chars)" },
          org_id: { type: "string", description: "Organization ID" },
          agent_name: { type: "string", description: "Agent name" },
          channel: { type: "string", description: "Channel: api, websocket, portal, etc." },
        },
        required: ["rating"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "route-to-agent",
      description:
        "Classify user intent and route to the best-matching agent. " +
        "Supports compound requests (e.g. 'deploy the API and show me the logs') " +
        "by decomposing into sub-tasks with separate intent classifications.",
      parameters: {
        type: "object",
        properties: {
          input: { type: "string", description: "User input text to classify and route" },
          org_id: { type: "string", description: "Organization ID (to look up available agents)" },
        },
        required: ["input"],
      },
    },
  },
  // ── DB Query Tools (codemode-safe, templated) ─────────────────
  {
    type: "function",
    function: {
      name: "db-query",
      description:
        "Execute a templated database query. Uses predefined query IDs (no raw SQL). " +
        "Always org-scoped. Available queries: sessions.stats, issues.summary, eval.latest_run, " +
        "billing.usage, billing.by_agent, feedback.stats. More efficient than multiple API calls.",
      parameters: {
        type: "object",
        properties: {
          query_id: { type: "string", description: "Query template ID (e.g., 'sessions.stats', 'billing.by_agent')" },
          params: {
            type: "object",
            description: "Query parameters (varies by query_id). Common: agent_name, since_days, limit.",
          },
        },
        required: ["query_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "db-batch",
      description:
        "Execute multiple templated queries in one call. Saves tokens vs multiple db-query calls. Max 10 queries per batch.",
      parameters: {
        type: "object",
        properties: {
          queries: {
            type: "array",
            items: {
              type: "object",
              properties: {
                query_id: { type: "string" },
                params: { type: "object" },
              },
              required: ["query_id"],
            },
            description: "Array of {query_id, params} objects",
          },
        },
        required: ["queries"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "db-report",
      description:
        "Generate a pre-built composite report. Combines multiple queries into a structured result. " +
        "Available reports: 'agent_health' (sessions + issues + eval + feedback for one agent), " +
        "'org_overview' (sessions + issues + billing across all agents).",
      parameters: {
        type: "object",
        properties: {
          report_id: { type: "string", description: "Report ID: 'agent_health' or 'org_overview'" },
          agent_name: { type: "string", description: "Agent name (required for agent_health report)" },
        },
        required: ["report_id"],
      },
    },
  },
  // ── Codemode Extended Tools ───────────────────────────────────
  {
    type: "function",
    function: {
      name: "run-codemode",
      description:
        "Execute a stored codemode snippet by ID with given input. " +
        "Runs in sandboxed V8 isolate with scoped tool permissions.",
      parameters: {
        type: "object",
        properties: {
          snippet_id: { type: "string", description: "ID of the stored codemode snippet" },
          input: { description: "Input data passed to the snippet as `input` variable" },
          scope_config: { type: "object", description: "Override scope config (timeoutMs, maxToolCalls, etc.)" },
        },
        required: ["snippet_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "codemode-transform",
      description:
        "Run a data transformation using inline JavaScript code. " +
        "Input data is available as `input` in the sandbox. Return the transformed data.",
      parameters: {
        type: "object",
        properties: {
          code: { type: "string", description: "JavaScript transform code" },
          data: { description: "Input data to transform" },
        },
        required: ["code", "data"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "codemode-validate",
      description:
        "Run a custom validation on data using JavaScript code. " +
        "Code should return {valid: boolean, error?: string}.",
      parameters: {
        type: "object",
        properties: {
          code: { type: "string", description: "JavaScript validation code" },
          data: { description: "Data to validate" },
        },
        required: ["code", "data"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "codemode-orchestrate",
      description:
        "Run multi-agent orchestration code. Input includes a message and context. " +
        "Code should return {targetAgent, input, context}.",
      parameters: {
        type: "object",
        properties: {
          code: { type: "string", description: "JavaScript orchestration code" },
          message: { type: "string", description: "User message to route" },
          context: { type: "object", description: "Additional routing context" },
        },
        required: ["code", "message"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "codemode-test",
      description:
        "Run self-test code against an agent configuration. " +
        "Returns {passed, failed, total, results[]}.",
      parameters: {
        type: "object",
        properties: {
          code: { type: "string", description: "JavaScript test code" },
          test_context: { type: "object", description: "Test context (agent config, test data, etc.)" },
        },
        required: ["code"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "codemode-generate-mcp",
      description:
        "Generate MCP tool definitions from an API specification. " +
        "Returns array of {name, description, parameters, handlerCode}.",
      parameters: {
        type: "object",
        properties: {
          code: { type: "string", description: "JavaScript code that processes API spec into tool definitions" },
          api_spec: { description: "API specification (OpenAPI, custom JSON, etc.)" },
        },
        required: ["code", "api_spec"],
      },
    },
  },
  // ── Agent Lifecycle Tools ───────────────────────────────────────
  {
    type: "function",
    function: {
      name: "create-agent",
      description:
        "Create a new agent. Only 'name' is required — all other fields have sensible defaults. " +
        "Call this immediately with just the name and description; do NOT ask the user for optional fields. " +
        "Tools are validated against the catalog (invalid names dropped with warning). " +
        "If no system_prompt is provided, one is auto-generated that tells the agent about its tools.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Agent name (letters, numbers, hyphens, underscores only, max 128 chars)" },
          description: { type: "string", description: "What this agent does (max 2000 chars)" },
          system_prompt: { type: "string", description: "Full system prompt for the agent" },
          model: { type: "string", description: "Model in provider/name format (optional — leave empty to use plan-based routing)" },
          plan: { type: "string", enum: ["basic", "standard", "premium"], description: "Pricing plan tier (default: standard)" },
          tools: { type: "array", items: { type: "string" }, description: "Tool names to enable (validated against catalog)" },
          max_turns: { type: "number", description: "Max conversation turns, 1-1000 (default: 50)" },
          budget_limit_usd: { type: "number", description: "Max cost per session in USD (default: 10)" },
          reasoning_strategy: { type: "string", enum: ["", "chain-of-thought", "plan-then-execute", "step-back", "decompose", "verify-then-respond"], description: "Reasoning strategy (empty = auto-select)" },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete-agent",
      description: "Soft-delete an agent and cascade-clean all associated resources. Requires confirm=true.",
      parameters: {
        type: "object",
        properties: {
          agent_name: { type: "string", description: "Agent name to delete" },
          confirm: { type: "boolean", description: "Safety check — must be true" },
        },
        required: ["agent_name", "confirm"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run-agent",
      description:
        "Delegate a task to another agent via a child Workflow. The sub-agent runs in parallel with its own " +
        "config, tools, and reasoning strategy. Returns the sub-agent's output and cost. " +
        "Use this for tasks that need a specialist (e.g., delegate research to a research-bot). " +
        "Max delegation depth: 6. Each child runs crash-safe via Cloudflare Workflows. " +
        "Optionally pass 'tools' to scope the sub-agent to only specific tools for this run.",
      parameters: {
        type: "object",
        properties: {
          agent_name: { type: "string", description: "Agent to run" },
          task: { type: "string", description: "Task/message to send" },
          tools: { type: "array", items: { type: "string" }, description: "Optional: scope sub-agent to only these tools for this run (e.g. [\"web-search\", \"browse\"]). If omitted, agent uses its full configured tool set." },
          channel: { type: "string", description: "Channel (default internal)" },
          org_id: { type: "string", description: "Org id (optional if same as caller)" },
        },
        required: ["agent_name", "task"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "eval-agent",
      description: "Run evaluation tasks against an agent. Creates an eval run record.",
      parameters: {
        type: "object",
        properties: {
          agent_name: { type: "string", description: "Agent to evaluate" },
          eval_file: { type: "string", description: "Path to eval dataset" },
          trials: { type: "number", description: "Number of trials per task (default 1)" },
        },
        required: ["agent_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "evolve-agent",
      description:
        "Run the evolution analyzer on an agent's recent sessions. " +
        "Discovers failure patterns, cost anomalies, tool performance issues, " +
        "and generates ranked improvement proposals with evidence. " +
        "Proposals are stored and visible in the Evolve tab for human review.",
      parameters: {
        type: "object",
        properties: {
          agent_name: { type: "string", description: "Agent to analyze" },
          days: { type: "number", description: "Analysis window in days (default 7, max 90)" },
        },
        required: ["agent_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "autoresearch",
      description:
        "Start an autonomous self-improvement loop. Proposes config changes, " +
        "evaluates them on tasks, and keeps winners.",
      parameters: {
        type: "object",
        properties: {
          agent_name: { type: "string", description: "Agent to improve" },
          max_iterations: { type: "number", description: "Max iterations (default 10)" },
          time_budget: { type: "number", description: "Time budget in seconds (default 300)" },
        },
        required: ["agent_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list-agents",
      description: "List all active agents for the current org.",
      parameters: {
        type: "object",
        properties: {
          org_id: { type: "string", description: "Organization ID" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list-tools",
      description: "List all available tool names and their descriptions.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  // ── Platform Operations Tools ──────────────────────────────────
  {
    type: "function",
    function: {
      name: "security-scan",
      description:
        "Run OWASP LLM Top 10 probes against an agent config. " +
        "Returns risk score and findings.",
      parameters: {
        type: "object",
        properties: {
          agent_name: { type: "string", description: "Agent to scan" },
        },
        required: ["agent_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "conversation-intel",
      description: "Get session quality/sentiment summary for an agent or the entire org.",
      parameters: {
        type: "object",
        properties: {
          agent_name: { type: "string", description: "Agent name (optional — all agents if omitted)" },
          since_days: { type: "number", description: "Lookback window in days (default 7, max 90)" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "manage-issues",
      description: "Create, list, or auto-fix agent issues. Actions: list, create, auto-fix.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", description: "Action: list, create, auto-fix" },
          agent_name: { type: "string", description: "Agent name (for list/create)" },
          issue_id: { type: "string", description: "Issue ID (for auto-fix)" },
          title: { type: "string", description: "Issue title (for create)" },
          description: { type: "string", description: "Issue description (for create)" },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "compliance",
      description: "Check agent compliance against governance policies and gold images.",
      parameters: {
        type: "object",
        properties: {
          agent_name: { type: "string", description: "Agent to check" },
        },
        required: ["agent_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "view-costs",
      description: "Get billing summary by agent or for the entire org.",
      parameters: {
        type: "object",
        properties: {
          since_days: { type: "number", description: "Lookback window (default 30, max 365)" },
          agent_name: { type: "string", description: "Agent name (optional — all agents if omitted)" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "view-traces",
      description: "Get recent sessions and traces. Filter by agent, status, and limit.",
      parameters: {
        type: "object",
        properties: {
          agent_name: { type: "string", description: "Agent name (optional)" },
          limit: { type: "number", description: "Max results (default 20, max 100)" },
          status: { type: "string", description: "Filter by status (success, error, etc.)" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "manage-releases",
      description:
        "Promote agents through release channels (draft -> staging -> production) " +
        "or configure canary traffic splits. Actions: list, promote, canary.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", description: "Action: list, promote, canary" },
          agent_name: { type: "string", description: "Agent name" },
          from_channel: { type: "string", description: "Source channel" },
          to_channel: { type: "string", description: "Target channel (for promote)" },
          canary_weight: { type: "number", description: "Canary traffic weight 0-1 (for canary)" },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "manage-slos",
      description: "Create or check SLO (Service Level Objective) status. Actions: list, create, check.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", description: "Action: list, create, check" },
          agent_name: { type: "string", description: "Agent name (for create/check)" },
          metric: { type: "string", description: "Metric name (e.g., success_rate, latency_p99)" },
          threshold: { type: "number", description: "Threshold value (e.g., 0.95)" },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "view-audit",
      description: "Read audit log entries. Filter by time range and action type.",
      parameters: {
        type: "object",
        properties: {
          since_days: { type: "number", description: "Lookback window (default 7, max 90)" },
          action_filter: { type: "string", description: "Filter by action type (e.g., agent.create)" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "manage-secrets",
      description:
        "Manage the secrets vault. List only returns names (never values). " +
        "Actions: list, create, rotate, delete.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", description: "Action: list, create, rotate, delete" },
          name: { type: "string", description: "Secret name" },
          value: { type: "string", description: "Secret value (for create/rotate)" },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "compare-agents",
      description: "A/B compare two agent versions using session stats over the last 7 days.",
      parameters: {
        type: "object",
        properties: {
          agent_a: { type: "string", description: "First agent name" },
          agent_b: { type: "string", description: "Second agent name" },
          eval_file: { type: "string", description: "Optional eval file for head-to-head" },
        },
        required: ["agent_a", "agent_b"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "manage-rag",
      description: "List RAG knowledge base documents for an agent. Reads from R2 storage.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", description: "Action: list, status" },
          agent_name: { type: "string", description: "Agent name" },
        },
        required: ["agent_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "manage-policies",
      description: "Create or list governance policy templates. Actions: list, create.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", description: "Action: list, create" },
          name: { type: "string", description: "Policy name (for create)" },
          budget_limit_usd: { type: "number", description: "Budget limit in USD (for create)" },
          blocked_tools: { type: "array", items: { type: "string" }, description: "Tools to block (for create)" },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "manage-retention",
      description: "List or apply data retention policies. Actions: list, apply.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", description: "Action: list, apply" },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "manage-workflows",
      description: "List, create, or validate multi-agent workflows. Actions: list, create, validate.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", description: "Action: list, create, validate" },
          name: { type: "string", description: "Workflow name (for create)" },
          steps: { type: "array", items: { type: "object" }, description: "Workflow steps (for create/validate)" },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "manage-projects",
      description: "List all projects for the current org.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "manage-mcp",
      description: "List or register MCP (Model Context Protocol) servers. Actions: list, register.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", description: "Action: list, register" },
          name: { type: "string", description: "MCP server name (for register)" },
          url: { type: "string", description: "MCP server URL (for register)" },
        },
        required: ["action"],
      },
    },
  },

  // ── MCP Wrapper (v0.2.1 codemode/mcp integration) ──────────────

  {
    type: "function",
    function: {
      name: "mcp-wrap",
      description:
        "Wrap an OpenAPI specification into codemode-ready tools. " +
        "Point at a spec URL or provide the JSON directly — each API operation " +
        "becomes a typed method callable from codemode. Replaces manual MCP generation.",
      parameters: {
        type: "object",
        properties: {
          spec: { type: "string", description: "OpenAPI spec: URL (https://...) or JSON string" },
          org_id: { type: "string", description: "Organization ID for storage" },
        },
        required: ["spec"],
      },
    },
  },

  // ── ACI Tools (SWE-agent harness patterns) ─────────────────────

  {
    type: "function",
    function: {
      name: "view-file",
      description:
        "View a file with a scrollable window centered on a line number. " +
        "Shows 100 lines by default with line numbers. Use this instead of read-file " +
        "when you need to navigate a large file incrementally.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path" },
          line: { type: "number", description: "Center the view on this line number (default 1)" },
          window: { type: "number", description: "Number of lines to show (default 100, max 200)" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search-file",
      description: "Search for a pattern within a specific file. Returns matching lines with line numbers.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path to search" },
          term: { type: "string", description: "Search term or regex pattern" },
        },
        required: ["path", "term"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find-file",
      description: "Find files by name (partial match). Use when you know the filename but not the path.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Filename or partial name to search for" },
          path: { type: "string", description: "Directory to search in (default /workspace)" },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git-init",
      description: "Initialize a git repository in the workspace and create an initial commit.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory path (default /workspace)" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git-status",
      description: "Show the working tree status — modified, staged, and untracked files.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Repository path (default /workspace)" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git-diff",
      description: "Show changes between commits, working tree, or staged files. Returns unified diff.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Repository path (default /workspace)" },
          target: { type: "string", description: "Diff target: empty for unstaged, --staged, HEAD~1, or a commit hash" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git-commit",
      description: "Stage all changes and create a commit with a descriptive message.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Repository path (default /workspace)" },
          message: { type: "string", description: "Commit message" },
        },
        required: ["message"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git-log",
      description: "Show recent commit history (one line per commit).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Repository path (default /workspace)" },
          count: { type: "number", description: "Number of commits to show (default 10, max 30)" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git-branch",
      description: "List, create, or switch branches. Actions: list (default), create, switch.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Repository path (default /workspace)" },
          action: { type: "string", description: "Action: list, create, switch" },
          name: { type: "string", description: "Branch name (for create/switch)" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git-stash",
      description: "Stash or restore uncommitted changes. Actions: push (default), pop, list.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Repository path (default /workspace)" },
          action: { type: "string", description: "Action: push, pop, list" },
        },
        required: [],
      },
    },
  },
  // ── Self-Awareness Tools ────────────────────────────────────────
  {
    type: "function",
    function: {
      name: "self-check",
      description:
        "Check your own performance metrics, SLO status, and pending improvement proposals. " +
        "Use this when you're unsure if your approach is working or want to understand your recent track record.",
      parameters: {
        type: "object",
        properties: {
          check: {
            type: "string",
            description:
              "What to check: 'performance' (success rate, cost, latency from last 20 sessions), " +
              "'slo' (SLO breach status), 'proposals' (pending evolution proposals), " +
              "'health' (combined view of all)",
          },
        },
        required: ["check"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "adapt-strategy",
      description:
        "Switch your reasoning strategy mid-session. Use when you realize the current approach " +
        "isn't working (e.g., switch from direct answering to step-back analysis for a complex " +
        "debug task).",
      parameters: {
        type: "object",
        properties: {
          strategy: {
            type: "string",
            description:
              "Reasoning strategy to adopt: 'step-back' (reason from principles), " +
              "'chain-of-thought' (numbered step-by-step), 'plan-then-execute' (plan first, then act), " +
              "'verify-then-respond' (generate then verify before answering), " +
              "'decompose' (break into sub-problems)",
          },
          reason: {
            type: "string",
            description: "Why you are switching strategies (e.g., 'direct approach failed, need to decompose the problem')",
          },
        },
        required: ["strategy", "reason"],
      },
    },
  },

  // ── Voice / Telephony ─────────────────────────────────────────────

  {
    type: "function",
    function: {
      name: "make-voice-call",
      description:
        "Initiate an outbound voice call via the agent's linked phone number. " +
        "The call connects to the agent's voice assistant so the recipient speaks with the AI agent. " +
        "Requires the agent to have a Vapi phone number and assistant linked.",
      parameters: {
        type: "object",
        properties: {
          phone_number: {
            type: "string",
            description: "Destination phone number in E.164 format (e.g. +15551234567)",
          },
          first_message: {
            type: "string",
            description: "Optional custom greeting for this call (overrides default)",
          },
        },
        required: ["phone_number"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "mixture-of-agents",
      description:
        "Query multiple AI models in parallel and synthesize their answers into one authoritative response. " +
        "Use for complex questions where diverse perspectives improve accuracy. " +
        "Consults 3 different models (Claude, Gemini, DeepSeek) then aggregates the best reasoning.",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "The question or task to send to all models" },
        },
        required: ["question"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "parallel-web-search",
      description:
        "Run multiple web search queries simultaneously and return combined results. " +
        "More efficient than sequential searches for research tasks requiring multiple angles.",
      parameters: {
        type: "object",
        properties: {
          queries: {
            type: "array",
            items: { type: "string" },
            description: "Array of search queries to run in parallel (max 5)",
          },
          max_results: { type: "number", description: "Results per query (default 3)" },
        },
        required: ["queries"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "session-search",
      description:
        "Search across past conversation sessions by keyword. " +
        "Finds previous interactions matching the query, showing input, output, cost, and date. " +
        "Useful for recalling past discussions, finding prior answers, or tracking patterns.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search keywords to match against past session content" },
          limit: { type: "number", description: "Max results to return (default 10, max 20)" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "user-profile-save",
      description:
        "Save a preference, fact, or observation about the current user to their persistent profile. " +
        "Use this to remember user preferences, communication style, expertise areas, or recurring needs. " +
        "The profile persists across conversations so you can personalize future interactions.",
      parameters: {
        type: "object",
        properties: {
          user_id: { type: "string", description: "User identifier (auto-detected from channel if omitted)" },
          key: { type: "string", description: "Profile key (e.g. 'preferred_language', 'expertise', 'communication_style')" },
          value: { type: "string", description: "Value to store" },
        },
        required: ["key", "value"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "user-profile-load",
      description:
        "Load the persistent profile for the current user. " +
        "Returns all saved preferences, facts, and observations about this user. " +
        "Call this at the start of a conversation to personalize your responses.",
      parameters: {
        type: "object",
        properties: {
          user_id: { type: "string", description: "User identifier (auto-detected from channel if omitted)" },
        },
        required: [],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "retrieve-result",
      description: "Retrieve the full content of a previously truncated tool result. Use when a tool result was too large and was persisted to storage with a reference key.",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string", description: "The storage key provided in the truncated result message" },
        },
        required: ["key"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "send-message",
      description: "Send a message to another agent session (parent or sibling). Only available during delegated runs.",
      parameters: {
        type: "object",
        properties: {
          to: { type: "string", description: "Target session ID (parent_session_id or sibling session)" },
          message: { type: "string", description: "Message content to send" },
        },
        required: ["to", "message"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "scratch-write",
      description: "Write a value to the shared scratch space. Available during delegated runs for cross-agent communication.",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string", description: "Key name for the scratch entry" },
          value: { type: "string", description: "Value to store" },
        },
        required: ["key", "value"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "scratch-read",
      description: "Read a value from the shared scratch space written by another agent in the same delegation chain.",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string", description: "Key name to read" },
        },
        required: ["key"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "scratch-list",
      description: "List all keys in the shared scratch space for the current delegation chain.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "swarm",
      description:
        "Fan out multiple independent tasks in parallel. Uses V8 isolates for research/tool work, " +
        "shared container for scripts, or full agent instances for complex reasoning. " +
        "Much faster than executing tasks one at a time.",
      parameters: {
        type: "object",
        properties: {
          tasks: {
            type: "array",
            items: {
              type: "object",
              properties: {
                input: {
                  type: "string",
                  description: "The task description or command to execute",
                },
                tools: {
                  type: "array",
                  items: { type: "string" },
                  description: "Optional: specific tools to use (e.g. ['web-search'], ['bash'])",
                },
              },
              required: ["input"],
            },
            description: "Array of independent tasks to execute in parallel",
          },
          mode: {
            type: "string",
            enum: ["auto", "codemode", "parallel-exec", "agent"],
            description:
              "Execution mode. auto = smart selection (default). " +
              "codemode = V8 isolates with tool access (fastest, cheapest — best for research/search). " +
              "parallel-exec = same container bash/python (best for scripts, tests, file processing). " +
              "agent = full LLM reasoning per task (slowest, most capable — returns guidance to use run-agent).",
          },
          strategy: {
            type: "string",
            enum: ["parallel", "sequential"],
            description: "Execution strategy. Default: parallel.",
          },
        },
        required: ["tasks"],
      },
    },
  },
];
