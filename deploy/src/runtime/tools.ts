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

const MAX_SANDBOX_TIMEOUT_SECONDS = 120;
const DEFAULT_SANDBOX_TIMEOUT_SECONDS = 30;
const DEFAULT_SANDBOX_MEMORY_LIMIT_MB = 512;
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

async function sandboxExecWithLimits(
  env: RuntimeEnv,
  sessionId: string,
  command: string,
  timeoutSeconds?: number,
): Promise<{ stdout?: string; stderr?: string; exitCode?: number }> {
  const timeout = clampSandboxTimeout(timeoutSeconds);
  const sandbox = getSandbox(env.SANDBOX, `session-${sessionId}`);
  const options: { timeout: number } & Record<string, number> = {
    timeout,
    // Best-effort resource hints; ignored by runtimes that do not support them.
    memoryLimitMb: DEFAULT_SANDBOX_MEMORY_LIMIT_MB,
    cpuLimitMs: timeout * 1000,
  };
  return sandbox.exec(command, options);
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

const BLOCKED_IP_RANGES = [
  /^127\./,                          // loopback
  /^10\./,                           // private class A
  /^172\.(1[6-9]|2\d|3[01])\./,     // private class B
  /^192\.168\./,                     // private class C
  /^169\.254\./,                     // link-local / AWS metadata
  /^0\./,                            // unspecified
  /^fc00:/i, /^fd00:/i, /^fe80:/i,  // IPv6 private
  /^::1$/,                           // IPv6 loopback
];

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata.internal",
  "169.254.169.254",
  "metadata",
]);

function validateUrl(urlStr: string): { valid: boolean; reason?: string } {
  try {
    const url = new URL(urlStr);

    // Block non-http(s) protocols
    if (!["http:", "https:"].includes(url.protocol)) {
      return { valid: false, reason: `Blocked protocol: ${url.protocol}` };
    }

    // Block known dangerous hostnames
    if (BLOCKED_HOSTNAMES.has(url.hostname.toLowerCase())) {
      return { valid: false, reason: `Blocked hostname: ${url.hostname}` };
    }

    // Block private/internal IP ranges
    for (const pattern of BLOCKED_IP_RANGES) {
      if (pattern.test(url.hostname)) {
        return { valid: false, reason: `Blocked IP range: ${url.hostname}` };
      }
    }

    return { valid: true };
  } catch {
    return { valid: false, reason: "Invalid URL" };
  }
}

// ── Circuit Breaker for Tool Calls ───────────────────────────────────

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

function recordSuccess(toolName: string): void {
  const state = getCircuitState(toolName);
  state.successes++;
  
  if (state.state === "half-open" && state.successes >= CIRCUIT_CONFIG.successThreshold) {
    state.state = "closed";
    state.failures = 0;
    state.successes = 0;
    console.log(`[circuit-breaker] ${toolName}: CLOSED (healthy)`);
  }
}

function recordFailure(toolName: string): void {
  const state = getCircuitState(toolName);
  state.failures++;
  state.lastFailureTime = Date.now();
  state.successes = 0;
  
  if (state.state === "closed" && state.failures >= CIRCUIT_CONFIG.failureThreshold) {
    state.state = "open";
    console.warn(`[circuit-breaker] ${toolName}: OPEN (too many failures)`);
  }
}

function canExecute(toolName: string): { allowed: boolean; reason?: string } {
  const state = getCircuitState(toolName);
  const now = Date.now();
  
  if (state.state === "open") {
    const timeSinceFailure = now - state.lastFailureTime;
    
    if (timeSinceFailure > CIRCUIT_CONFIG.resetTimeoutMs) {
      // Transition to half-open
      state.state = "half-open";
      state.successes = 0;
      console.log(`[circuit-breaker] ${toolName}: HALF-OPEN (testing)`);
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
  // Search & web (external API flat fees)
  "web-search":        { flat_usd: 0.005,    per_ms_usd: 0 },          // Brave: $5/1K
  "web-crawl":         { flat_usd: 0.005,    per_ms_usd: 0 },          // Browser Rendering
  "browser-render":    { flat_usd: 0.005,    per_ms_usd: 0 },          // Browser Rendering

  // Multimodal (Workers AI per-request)
  "image-generate":    { flat_usd: 0.001,    per_ms_usd: 0 },
  "text-to-speech":    { flat_usd: 0.001,    per_ms_usd: 0 },
  "speech-to-text":    { flat_usd: 0.001,    per_ms_usd: 0 },

  // Knowledge (embedding + vector ops)
  "knowledge-search":  { flat_usd: 0.0002,   per_ms_usd: 0 },          // Embedding + query
  "store-knowledge":   { flat_usd: 0.0002,   per_ms_usd: 0 },          // Embedding + upsert

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
};

/** Calculate tool cost from flat fee + duration. */
function calculateToolCost(toolName: string, latencyMs: number): number {
  const model = TOOL_COSTS[toolName];
  if (!model) return 0;
  return model.flat_usd + (latencyMs * model.per_ms_usd);
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

/**
 * Execute tool calls — parallel when safe, sequential for sandbox-stateful ops.
 */
/**
 * Execute tool calls — parallel when safe, sequential for sandbox-stateful ops.
 * @param enabledTools - agent's configured tool list; passed to codemode to prevent privilege escalation.
 *   If empty/undefined, codemode tools will only see their scope-filtered subset.
 */
export async function executeTools(
  env: RuntimeEnv,
  toolCalls: ToolCall[],
  sessionId: string,
  parallel: boolean = true,
  enabledTools?: string[],
): Promise<ToolResult[]> {
  if (parallel && toolCalls.length > 1) {
    return Promise.all(
      toolCalls.map((tc) => executeSingleTool(env, tc, sessionId, enabledTools)),
    );
  }
  const results: ToolResult[] = [];
  for (const tc of toolCalls) {
    results.push(await executeSingleTool(env, tc, sessionId, enabledTools));
  }
  return results;
}

async function executeSingleTool(
  env: RuntimeEnv,
  tc: ToolCall,
  sessionId: string,
  enabledTools?: string[],
): Promise<ToolResult> {
  const started = Date.now();
  
  // Check circuit breaker before executing
  const circuitCheck = canExecute(tc.name);
  if (!circuitCheck.allowed) {
    return {
      tool: tc.name,
      tool_call_id: tc.id,
      result: "",
      error: circuitCheck.reason,
      latency_ms: 0,
      cost_usd: 0,
    };
  }
  
  let args: Record<string, any>;
  try {
    args = JSON.parse(tc.arguments || "{}");
  } catch {
    return {
      tool: tc.name,
      tool_call_id: tc.id,
      result: "",
      error: `Invalid JSON arguments: ${tc.arguments?.slice(0, 100)}`,
      latency_ms: Date.now() - started,
    };
  }

  // ── Governance: Domain allowlist check ────────────────────────
  const config = (env as any).__agentConfig as
    | { allowed_domains?: string[]; require_confirmation_for_destructive?: boolean; max_tokens_per_turn?: number }
    | undefined;

  if (config?.allowed_domains && config.allowed_domains.length > 0) {
    const urlTools = new Set(["browse", "http-request", "web-crawl", "browser-render", "a2a-send"]);
    if (urlTools.has(tc.name)) {
      const targetUrl = String(args.url || args.endpoint || "");
      if (targetUrl) {
        try {
          const hostname = new URL(targetUrl).hostname;
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
        } catch { /* invalid URL — SSRF check will catch it */ }
      }
    }
  }

  // ── Governance: Destructive action detection ──────────────────
  if (config?.require_confirmation_for_destructive) {
    const DESTRUCTIVE_KEYWORDS = /\b(delete|drop|remove|destroy|kill|force|truncate|wipe|purge)\b/i;
    const toolArgs = JSON.stringify(args);
    const destructiveTools = new Set(["delete-agent", "bash", "python-exec", "manage-secrets", "manage-retention"]);
    if (destructiveTools.has(tc.name) || DESTRUCTIVE_KEYWORDS.test(toolArgs)) {
      // Check if the tool call looks destructive
      const isDestructive = destructiveTools.has(tc.name) || DESTRUCTIVE_KEYWORDS.test(toolArgs);
      if (isDestructive) {
        return {
          tool: tc.name, tool_call_id: tc.id,
          result: JSON.stringify({
            blocked: true,
            reason: "Destructive action requires human confirmation",
            action: toolArgs.slice(0, 200),
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
    
    // Record success for circuit breaker
    recordSuccess(tc.name);
    
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
      recordFailure(tc.name);
    }
    
    return {
      tool: tc.name,
      tool_call_id: tc.id,
      result: "",
      error: err.message || String(err),
      latency_ms: latencyMs,
      cost_usd: calculateToolCost(tc.name, latencyMs),
    };
  }
}

function isExternalServiceError(err: any): boolean {
  // Network errors, timeouts, 5xx errors from external services
  const msg = String(err.message || err).toLowerCase();
  return (
    msg.includes("timeout") ||
    msg.includes("network") ||
    msg.includes("econnrefused") ||
    msg.includes("5") || // 5xx
    msg.includes("503") ||
    msg.includes("502") ||
    msg.includes("504")
  );
}

async function dispatch(
  env: RuntimeEnv,
  tool: string,
  args: Record<string, any>,
  sessionId: string,
  enabledTools?: string[],
): Promise<string> {
  // Resolve the effective tool list for codemode — uses agent's enabled tools,
  // NOT all tools. This prevents privilege escalation through execute-code.
  const effectiveToolDefs = () => getToolDefinitions(enabledTools || []);
  switch (tool) {
    case "web-search":
      return braveSearch(env, args);

    case "browse":
      return browse(args);

    case "http-request":
      return httpRequest(args);

    case "bash":
      return sandboxExec(env, args.command || "", sessionId, args.timeout_seconds);

    case "python-exec": {
      const code = String(args.code || "");
      const deps = extractPythonImportCandidates(code);
      const missing = await checkMissingPythonModules(env, sessionId, deps);
      if (missing.length > 0) {
        return JSON.stringify({
          stdout: "",
          stderr: pythonMissingModuleError(missing),
          exit_code: 1,
          missing_modules: missing,
        });
      }
      const sandbox = getSandbox(env.SANDBOX, `session-${sessionId}`);
      const tmpFile = `/tmp/exec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.py`;
      await sandbox.writeFile(tmpFile, code);
      try {
        const r = await sandboxExecWithLimits(env, sessionId, `python3 ${tmpFile}`, args.timeout_seconds);
        return JSON.stringify({ stdout: r.stdout || "", stderr: r.stderr || "", exit_code: r.exitCode ?? 0 });
      } finally {
        await sandboxExecWithLimits(env, sessionId, `rm -f ${tmpFile}`, 5).catch(() => {});
      }
    }

    case "read-file": {
      const sandbox = getSandbox(env.SANDBOX, `session-${sessionId}`);
      let readPath = args.path || "";
      if (readPath && !readPath.startsWith("/")) readPath = `/workspace/${readPath}`;
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
      const sandbox = getSandbox(env.SANDBOX, `session-${sessionId}`);
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
      const sandbox = getSandbox(env.SANDBOX, `session-${sessionId}`);
      // Enforce safe default path — always resolve to /workspace/
      let filePath = args.path || "output.txt";
      if (!filePath.startsWith("/")) filePath = `/workspace/${filePath}`;
      if (!filePath.startsWith("/workspace") && !filePath.startsWith("/tmp")) filePath = `/workspace/${filePath.replace(/^\/+/, "")}`;
      // Ensure parent dir exists
      const dir = filePath.substring(0, filePath.lastIndexOf("/"));
      if (dir) await sandbox.exec(`mkdir -p "${dir}"`, { timeout: 5 }).catch(() => {});
      await sandbox.writeFile(filePath, args.content || "");

      // Per-file sync to R2 for durability (non-blocking)
      if (filePath.startsWith("/workspace/") && env.STORAGE) {
        import("./workspace").then(({ syncFileToR2 }) =>
          syncFileToR2(env.STORAGE, args.org_id || "default", args.agent_name || "agent", filePath, args.content || "", sessionId),
        ).catch(() => {});
      }

      return `Written ${(args.content || "").length} bytes to ${filePath}`;
    }

    case "edit-file": {
      const sandbox = getSandbox(env.SANDBOX, `session-${sessionId}`);
      const editPath = args.path || "";
      const read = await sandbox.exec(`cat "${editPath}"`, { timeout: 10 });
      const content = read.stdout || "";
      const oldText = args.old_text || args.old_string || "";
      if (!content.includes(oldText)) return `Error: old_text not found in ${editPath}`;
      const newContent = content.replace(oldText, args.new_text || args.new_string || "");

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

      // Sync edited file to R2 (non-blocking)
      if (editPath.startsWith("/workspace/") && env.STORAGE) {
        import("./workspace").then(({ syncFileToR2 }) =>
          syncFileToR2(env.STORAGE, args.org_id || "default", args.agent_name || "agent", editPath, newContent, sessionId),
        ).catch(() => {});
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
      const sandbox = getSandbox(env.SANDBOX, `session-${sessionId}`);
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
      const sandbox = getSandbox(env.SANDBOX, `session-${sessionId}`);
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
      const sandbox = getSandbox(env.SANDBOX, `session-${sessionId}`);
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
      const sandbox = getSandbox(env.SANDBOX, `session-${sessionId}`);
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

    case "image-generate":
      return imageGenerate(env, args);

    case "text-to-speech":
      return textToSpeech(env, args);

    case "speech-to-text":
      return speechToText(env, args, sessionId);

    case "sandbox_exec":
    case "sandbox-exec":
      return sandboxExec(env, args.command || "", sessionId, args.timeout);

    case "sandbox_file_write":
    case "sandbox-file-write": {
      const sandbox = getSandbox(env.SANDBOX, `session-${sessionId}`);
      await sandbox.writeFile(args.path || "/tmp/file", args.content || "");
      return `Written to ${args.path}`;
    }

    case "sandbox_file_read":
    case "sandbox-file-read": {
      const sandbox = getSandbox(env.SANDBOX, `session-${sessionId}`);
      const r = await sandbox.exec(`cat "${args.path || "/tmp/file"}"`, { timeout: 10 });
      return r.stdout || "";
    }

    case "dynamic-exec":
      return dynamicExec(env, args, sessionId);

    case "web-crawl":
      return webCrawl(env, args);

    case "browser-render":
      return browserRender(env, args);

    case "a2a-send": {
      const targetUrl = args.url || "";
      const urlCheck = validateUrl(targetUrl);
      if (!urlCheck.valid) return `Error: ${urlCheck.reason}`;
      const task = args.task || args.message || "";
      const resp = await fetch(`${targetUrl}/tasks/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", method: "tasks/send", id: crypto.randomUUID(),
          params: { message: { role: "user", parts: [{ type: "text", text: task }] } },
        }),
      });
      return await resp.text();
    }

    case "save-project":
      return saveProject(env, args, sessionId);

    case "load-project":
      return loadProject(env, args, sessionId);

    case "list-project-versions":
      return listProjectVersions(env, args);

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
          title: specObj.info?.title || "API",
          version: specObj.info?.version || "1.0",
          operations_count: operations.length,
          operations: operations.slice(0, 20),
          message:
            `Wrapped OpenAPI spec "${specObj.info?.title || "API"}" with ${operations.length} operations. ` +
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
      const orgId = args.org_id || "";
      if (!agentName || !cronExpr || !taskDesc) {
        return "create-schedule requires agent_name, cron (e.g. '0 9 * * *'), and task description";
      }
      try {
        await sql`
          INSERT INTO schedules (id, agent_name, org_id, task, cron_expression, enabled, run_count, created_at)
          VALUES (${scheduleId}, ${agentName}, ${orgId}, ${taskDesc}, ${cronExpr}, true, 0, ${Date.now() / 1000})
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
          ? await sql`SELECT id, agent_name, task, cron_expression, enabled, run_count, last_run_at FROM schedules WHERE agent_name = ${agentName} AND org_id = ${orgId} ORDER BY created_at DESC LIMIT 20`
          : await sql`SELECT id, agent_name, task, cron_expression, enabled, run_count, last_run_at FROM schedules WHERE org_id = ${orgId} ORDER BY created_at DESC LIMIT 20`;
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
        await sql`DELETE FROM schedules WHERE id = ${scheduleId} AND org_id = ${orgId}`;
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
                ingested_at: Date.now() / 1000,
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
          INSERT INTO user_feedback (id, session_id, turn_number, rating, comment, message_preview, org_id, agent_name, channel, created_at)
          VALUES (${feedbackId}, ${sessionId2}, ${turn}, ${rating}, ${comment}, ${messageContent},
                  ${args.org_id || ""}, ${args.agent_name || ""}, ${args.channel || "api"}, ${Date.now() / 1000})
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
          await tx`SELECT set_config('app.current_org_id', ${orgId}, true)`;
          await tx`SELECT set_config('app.current_user_id', ${userId || "agent"}, true)`;
          await tx`SELECT set_config('app.current_role', 'agent', true)`;

          // Dispatch to query handler (reuse the allowlist logic)
          const p = args.params || {};
          switch (queryId) {
            case "sessions.stats": {
              const an = p.agent_name ? String(p.agent_name) : null;
              const sd = Math.min(Number(p.since_days) || 7, 90);
              const since = Date.now() / 1000 - sd * 86400;
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
              const since = Date.now() / 1000 - sd * 86400;
              return await tx`SELECT COALESCE(SUM(total_cost_usd),0) as total, COALESCE(SUM(input_tokens),0) as input_tokens, COALESCE(SUM(output_tokens),0) as output_tokens FROM billing_records WHERE org_id = ${orgId} AND created_at >= ${since}`;
            }
            case "billing.by_agent": {
              const sd = Math.min(Number(p.since_days) || 30, 365);
              const since = Date.now() / 1000 - sd * 86400;
              return await tx`SELECT agent_name, SUM(total_cost_usd) as cost, COUNT(*) as sessions FROM billing_records WHERE org_id = ${orgId} AND created_at >= ${since} GROUP BY agent_name ORDER BY cost DESC`;
            }
            case "feedback.stats": {
              const sd = Math.min(Number(p.since_days) || 30, 365);
              const since = Date.now() / 1000 - sd * 86400;
              return await tx`SELECT rating, COUNT(*) as count FROM user_feedback WHERE org_id = ${orgId} AND created_at >= ${since} GROUP BY rating`;
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
      const orgId = args.org_id || "";
      const name = String(args.name || "").trim();
      if (!name) return "create-agent requires name";
      const desc = String(args.description || "");
      const systemPrompt = String(args.system_prompt || `You are ${name}. ${desc}`);
      const model = String(args.model || "anthropic/claude-sonnet-4.6");
      const tools = Array.isArray(args.tools) ? args.tools : [];
      const maxTurns = Number(args.max_turns) || 50;
      const toolsJson = JSON.stringify(tools);
      try {
        await sql`
          INSERT INTO agents (name, org_id, description, system_prompt, model, tools_json, max_turns, is_active, created_at)
          VALUES (${name}, ${orgId}, ${desc}, ${systemPrompt}, ${model}, ${toolsJson}, ${maxTurns}, true, ${Date.now() / 1000})
        `;
        return JSON.stringify({ created: true, name, tools_count: tools.length });
      } catch (err: any) {
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
      // Delegate to the runtime's own /run endpoint on the same DO namespace
      const agentName = String(args.agent_name || "");
      const task = String(args.task || "");
      if (!agentName || !task) return "run-agent requires agent_name and task";
      const channel = args.channel || "internal";
      const orgId = args.org_id || "";
      try {
        // Internal fetch to the same worker — the DO namespace routes to the correct agent
        const runtimeUrl = (env as any).RUNTIME_URL || "https://runtime.agentos.workers.dev";
        const resp = await fetch(`${runtimeUrl}/run`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${(env as any).SERVICE_TOKEN || ""}`,
          },
          body: JSON.stringify({ agent_name: agentName, input: task, channel, org_id: orgId }),
        });
        const result = await resp.text();
        return result.slice(0, 10000);
      } catch (err: any) {
        return `Failed to run agent: ${err.message || err}`;
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
          INSERT INTO eval_runs (id, agent_name, org_id, status, trials, created_at)
          VALUES (${runId}, ${agentName}, ${orgId}, 'pending', ${trials}, ${Date.now() / 1000})
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
        const since = Date.now() / 1000 - days * 86400;
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
          INSERT INTO eval_runs (id, agent_name, org_id, status, trials, created_at)
          VALUES (${runId}, ${agentName}, ${orgId}, 'autoresearch_pending', ${maxIter}, ${Date.now() / 1000})
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
          SELECT name, description, model, is_active, created_at
          FROM agents WHERE org_id = ${orgId} AND is_active = true
          ORDER BY created_at DESC LIMIT 100
        `;
        return JSON.stringify(rows);
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
        const agent = await sql`SELECT name, system_prompt, tools_json FROM agents WHERE name = ${agentName} AND org_id = ${orgId} LIMIT 1`;
        if (agent.length === 0) return JSON.stringify({ error: "Agent not found" });
        const config = agent[0];
        const tools = JSON.parse(config.tools_json || "[]");
        // Basic OWASP LLM Top 10 probe checks
        const findings: { probe: string; risk: string; detail: string }[] = [];
        const prompt = String(config.system_prompt || "").toLowerCase();
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
      const since = Date.now() / 1000 - sinceDays * 86400;
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
            ? await sql`SELECT id, agent_name, title, severity, status, created_at FROM issues WHERE org_id = ${orgId} AND agent_name = ${agentName} ORDER BY created_at DESC LIMIT 50`
            : await sql`SELECT id, agent_name, title, severity, status, created_at FROM issues WHERE org_id = ${orgId} ORDER BY created_at DESC LIMIT 50`;
          return JSON.stringify(rows);
        }
        if (action === "create") {
          const issueId = crypto.randomUUID().slice(0, 12);
          const title = String(args.title || "Untitled issue");
          const desc = String(args.description || "");
          const agentName = String(args.agent_name || "");
          await sql`
            INSERT INTO issues (id, org_id, agent_name, title, description, severity, status, created_at)
            VALUES (${issueId}, ${orgId}, ${agentName}, ${title}, ${desc}, 'medium', 'open', ${Date.now() / 1000})
          `;
          return JSON.stringify({ created: true, issue_id: issueId });
        }
        if (action === "auto-fix") {
          const issueId = String(args.issue_id || "");
          if (!issueId) return "auto-fix requires issue_id";
          await sql`UPDATE issues SET status = 'resolved', resolved_at = ${Date.now() / 1000} WHERE id = ${issueId} AND org_id = ${orgId}`;
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
        const agent = await sql`SELECT name, system_prompt, tools_json, governance_json FROM agents WHERE name = ${agentName} AND org_id = ${orgId} LIMIT 1`;
        if (agent.length === 0) return JSON.stringify({ error: "Agent not found" });
        const config = agent[0];
        const governance = JSON.parse(config.governance_json || "{}");
        const checks = {
          has_system_prompt: Boolean(config.system_prompt),
          has_governance: Boolean(governance.budget_limit_usd),
          has_budget_limit: (governance.budget_limit_usd || 0) > 0,
          tools_count: JSON.parse(config.tools_json || "[]").length,
          compliant: Boolean(config.system_prompt) && (governance.budget_limit_usd || 0) > 0,
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
      const since = Date.now() / 1000 - sinceDays * 86400;
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
            VALUES (${releaseId}, ${orgId}, ${agentName}, ${toChannel}, 'latest', ${Date.now() / 1000})
          `;
          return JSON.stringify({ promoted: true, agent_name: agentName, channel: toChannel });
        }
        if (action === "canary") {
          if (!agentName) return "canary requires agent_name";
          const weight = Math.min(Math.max(Number(args.canary_weight) || 0.1, 0), 1);
          await sql`
            INSERT INTO release_channels (id, org_id, agent_name, channel, version, promoted_at)
            VALUES (${crypto.randomUUID().slice(0, 12)}, ${orgId}, ${agentName}, 'canary', ${String(weight)}, ${Date.now() / 1000})
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
          const rows = await sql`SELECT id, agent_name, metric, threshold, created_at FROM slo_definitions WHERE org_id = ${orgId} ORDER BY created_at DESC LIMIT 50`;
          return JSON.stringify(rows);
        }
        if (action === "create") {
          const agentName = String(args.agent_name || "");
          const metric = String(args.metric || "success_rate");
          const threshold = Number(args.threshold) || 0.95;
          const sloId = crypto.randomUUID().slice(0, 12);
          await sql`
            INSERT INTO slo_definitions (id, org_id, agent_name, metric, threshold, created_at)
            VALUES (${sloId}, ${orgId}, ${agentName}, ${metric}, ${threshold}, ${Date.now() / 1000})
          `;
          return JSON.stringify({ created: true, slo_id: sloId, metric, threshold });
        }
        if (action === "check") {
          const agentName = String(args.agent_name || "");
          const slos = await sql`SELECT id, metric, threshold FROM slo_definitions WHERE org_id = ${orgId} AND agent_name = ${agentName}`;
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
      const since = Date.now() / 1000 - sinceDays * 86400;
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
          await sql`
            INSERT INTO secrets (name, org_id, encrypted_value, created_at)
            VALUES (${name}, ${orgId}, ${value}, ${Date.now() / 1000})
            ON CONFLICT (name, org_id) DO UPDATE SET encrypted_value = EXCLUDED.encrypted_value
          `;
          return JSON.stringify({ stored: true, name });
        }
        if (action === "rotate") {
          const name = String(args.name || "");
          const value = String(args.value || "");
          if (!name || !value) return "rotate requires name and new value";
          await sql`UPDATE secrets SET encrypted_value = ${value} WHERE name = ${name} AND org_id = ${orgId}`;
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
        const since = Date.now() / 1000 - 7 * 86400;
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
          const rows = await sql`SELECT id, name, budget_limit_usd, blocked_tools_json, created_at FROM policy_templates WHERE org_id = ${orgId} ORDER BY created_at DESC LIMIT 50`;
          return JSON.stringify(rows);
        }
        if (action === "create") {
          const name = String(args.name || "default");
          const budgetLimit = Number(args.budget_limit_usd) || 10.0;
          const blockedTools = Array.isArray(args.blocked_tools) ? JSON.stringify(args.blocked_tools) : "[]";
          const policyId = crypto.randomUUID().slice(0, 12);
          await sql`
            INSERT INTO policy_templates (id, org_id, name, budget_limit_usd, blocked_tools_json, created_at)
            VALUES (${policyId}, ${orgId}, ${name}, ${budgetLimit}, ${blockedTools}, ${Date.now() / 1000})
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
          const rows = await sql`SELECT id, table_name, retention_days, created_at FROM retention_policies WHERE org_id = ${orgId} ORDER BY table_name`;
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
          const rows = await sql`SELECT id, name, status, steps_json, created_at FROM workflows WHERE org_id = ${orgId} ORDER BY created_at DESC LIMIT 50`;
          return JSON.stringify(rows);
        }
        if (action === "create") {
          const name = String(args.name || "");
          if (!name) return "create requires name";
          const steps = Array.isArray(args.steps) ? JSON.stringify(args.steps) : "[]";
          const wfId = crypto.randomUUID().slice(0, 12);
          await sql`
            INSERT INTO workflows (id, org_id, name, steps_json, status, created_at)
            VALUES (${wfId}, ${orgId}, ${name}, ${steps}, 'draft', ${Date.now() / 1000})
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
          const rows = await sql`SELECT id, name, url, status, created_at FROM mcp_servers WHERE org_id = ${orgId} ORDER BY created_at DESC LIMIT 50`;
          return JSON.stringify(rows);
        }
        if (action === "register") {
          const name = String(args.name || "");
          const url = String(args.url || "");
          if (!name || !url) return "register requires name and url";
          const mcpId = crypto.randomUUID().slice(0, 12);
          await sql`
            INSERT INTO mcp_servers (id, org_id, name, url, status, created_at)
            VALUES (${mcpId}, ${orgId}, ${name}, ${url}, 'active', ${Date.now() / 1000})
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
            VALUES (${gpuId}, ${orgId}, ${modelId}, ${gpuType}, 'provisioning', ${Date.now() / 1000})
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
      const sandbox = getSandbox(env.SANDBOX, `session-${sessionId}`);
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
      const sandbox = getSandbox(env.SANDBOX, `session-${sessionId}`);
      const workDir = args.path || "/workspace";
      const r = await sandbox.exec(`cd "${workDir}" && git status 2>&1`, { timeout: 10 });
      return r.stdout || r.stderr || "Not a git repository";
    }

    case "git-diff": {
      const sandbox = getSandbox(env.SANDBOX, `session-${sessionId}`);
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
      const sandbox = getSandbox(env.SANDBOX, `session-${sessionId}`);
      const workDir = args.path || "/workspace";
      const message = args.message || "checkpoint";
      const r = await sandbox.exec(
        `cd "${workDir}" && git add -A && git commit -m "${message.replace(/"/g, '\\"')}" 2>&1`,
        { timeout: 15 },
      );
      return r.stdout || r.stderr || "Nothing to commit";
    }

    case "git-log": {
      const sandbox = getSandbox(env.SANDBOX, `session-${sessionId}`);
      const workDir = args.path || "/workspace";
      const count = Math.min(30, Number(args.count) || 10);
      const r = await sandbox.exec(
        `cd "${workDir}" && git log --oneline -${count} 2>&1`,
        { timeout: 10 },
      );
      return r.stdout || r.stderr || "No commits yet";
    }

    case "git-branch": {
      const sandbox = getSandbox(env.SANDBOX, `session-${sessionId}`);
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
      const sandbox = getSandbox(env.SANDBOX, `session-${sessionId}`);
      const workDir = args.path || "/workspace";
      const action = args.action || "push";
      const r = await sandbox.exec(`cd "${workDir}" && git stash ${action} 2>&1`, { timeout: 10 });
      return r.stdout || r.stderr || "Stash operation complete";
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

async function braveSearch(env: RuntimeEnv, args: Record<string, any>): Promise<string> {
  const query = args.query || "";
  const maxResults = args.max_results || 5;
  const braveKey = (env as any).BRAVE_SEARCH_KEY || "";
  const accountId = env.CLOUDFLARE_ACCOUNT_ID || "";
  const gatewayId = env.AI_GATEWAY_ID || "";

  if (!braveKey) {
    // Fallback to DuckDuckGo if no Brave key
    return duckDuckGoSearch(query, maxResults);
  }

  // Route through AI Gateway for logging/caching
  const baseUrl = accountId && gatewayId
    ? `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/custom-brave`
    : "https://api.search.brave.com";

  const headers: Record<string, string> = {
    "X-Subscription-Token": braveKey,
    "Accept": "application/json",
  };
  if (accountId && gatewayId && env.AI_GATEWAY_TOKEN) {
    headers["cf-aig-authorization"] = `Bearer ${env.AI_GATEWAY_TOKEN}`;
  }

  try {
    const resp = await fetch(
      `${baseUrl}/res/v1/web/search?q=${encodeURIComponent(query)}&count=${maxResults}`,
      { headers },
    );

    if (!resp.ok) {
      const errText = await resp.text();
      console.error(`[web-search] Brave failed ${resp.status}: ${errText.slice(0, 100)}`);
      return duckDuckGoSearch(query, maxResults);
    }

    const data = await resp.json() as any;
    const results = data.web?.results || [];

    if (results.length === 0) return `No results found for: ${query}`;

    return results.slice(0, maxResults).map((r: any, i: number) =>
      `${i + 1}. ${r.title || "Untitled"}\n   ${r.url || ""}\n   ${(r.description || "").replace(/<[^>]+>/g, "").slice(0, 200)}`,
    ).join("\n\n");
  } catch (err: any) {
    console.error(`[web-search] Brave error: ${err.message}`);
    return duckDuckGoSearch(query, maxResults);
  }
}

// DuckDuckGo fallback (no API key needed)
async function duckDuckGoSearch(query: string, maxResults: number): Promise<string> {
  const resp = await fetch("https://html.duckduckgo.com/html/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "AgentOS/0.2.0" },
    body: `q=${encodeURIComponent(query)}`,
  });
  const html = await resp.text();
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
  return links.map(([url, title], i) =>
    `${i + 1}. ${title}\n   ${url}\n   ${snippets[i] || ""}`,
  ).join("\n\n") || `No results found for: ${query}`;
}

// ── Browse (simple HTTP fetch) ────────────────────────────────

async function browse(args: Record<string, any>): Promise<string> {
  const urlCheck = validateUrl(args.url || "");
  if (!urlCheck.valid) return `Error: ${urlCheck.reason}`;
  const resp = await fetch(args.url || "", {
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
  const query = args.query || "";
  const retrieveK = 20; // Retrieve more candidates for reranking
  const finalK = args.top_k || 5;

  // Step 1: Embed query
  const embedResult = (await env.AI.run("@cf/baai/bge-base-en-v1.5" as keyof AiModels, {
    text: [query],
  })) as any;
  const queryVec = embedResult.data?.[0];
  if (!queryVec) return "Embedding failed";

  // Step 2: Retrieve top-20 candidates from Vectorize
  const filter: Record<string, string> = {};
  if (args.agent_name) filter.agent_name = args.agent_name;
  if (args.org_id) filter.org_id = args.org_id;
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

  // Step 3: Rerank with cross-encoder (Workers AI bge-reranker-base)
  // Fix #1: Use correct API shape — query + texts[] for reranker models
  let reranked = candidates;
  try {
    const rerankerResult = (await env.AI.run(
      "@cf/baai/bge-reranker-base" as keyof AiModels,
      {
        query,
        texts: candidates.map((c: any) => c.text.slice(0, 512)),
      } as any,
    )) as any;

    // Workers AI reranker returns: { data: [{ index, score }] } or [{ score }]
    let scores: number[] = [];
    if (Array.isArray(rerankerResult?.data)) {
      // Sorted by score — map back to original order via index
      const scoreMap = new Map<number, number>();
      for (const item of rerankerResult.data) {
        scoreMap.set(Number(item.index ?? 0), Number(item.score ?? 0));
      }
      scores = candidates.map((_: any, i: number) => scoreMap.get(i) ?? 0);
    } else if (Array.isArray(rerankerResult)) {
      scores = rerankerResult.map((d: any) => Number(d.score ?? d ?? 0));
    }

    if (scores.length === candidates.length) {
      reranked = candidates.map((c: any, i: number) => ({
        ...c,
        rerank_score: scores[i],
        // Combine vector similarity + reranker relevance
        final_score: 0.3 * c.vector_score + 0.7 * scores[i],
      }));
      reranked.sort((a: any, b: any) => b.final_score - a.final_score);
    }
  } catch {
    // Reranker unavailable — fall back to vector score ordering
    reranked.sort((a: any, b: any) => b.vector_score - a.vector_score);
  }

  // Step 4: Return top-K after reranking with metadata
  const topResults = reranked.slice(0, finalK);
  return topResults
    .map((r: any, i: number) => {
      const score = r.final_score !== undefined
        ? `score=${r.final_score.toFixed(3)}`
        : `score=${r.vector_score.toFixed(3)}`;
      const meta: string[] = [];
      if (r.source) meta.push(`source=${r.source}`);
      if (r.pipeline) meta.push(`pipeline=${r.pipeline}`);
      if (r.event_type) meta.push(`type=${r.event_type}`);
      if (r.ingested_at > 0) {
        const ago = Math.round((Date.now() / 1000 - r.ingested_at) / 60);
        meta.push(ago < 60 ? `${ago}m ago` : `${Math.round(ago / 60)}h ago`);
      }
      const metaStr = meta.length > 0 ? ` (${meta.join(", ")})` : "";
      return `${i + 1}. [${score}]${metaStr} ${r.text.slice(0, 300)}`;
    })
    .join("\n\n");
}

// ── Store Knowledge (Vectorize + R2) ──────────────────────────

async function storeKnowledge(env: RuntimeEnv, args: Record<string, any>): Promise<string> {
  const text = args.content || args.text || "";
  const key = args.key || "knowledge";
  const embedResult = (await env.AI.run("@cf/baai/bge-base-en-v1.5" as keyof AiModels, {
    text: [text],
  })) as any;
  const vec = embedResult.data?.[0];
  if (vec) {
    await env.VECTORIZE.upsert([
      {
        id: `knowledge-${Date.now()}`,
        values: vec,
        metadata: {
          text,
          source: key,
          agent_name: args.agent_name || "",
          org_id: args.org_id || "",
        },
      },
    ]);
  }
  return `Stored knowledge: '${key}' (${text.length} chars)`;
}

// ── Image Generate (Workers AI FLUX) ──────────────────────────

async function imageGenerate(env: RuntimeEnv, args: Record<string, any>): Promise<string> {
  const prompt = args.prompt || "";
  const aiResult = (await env.AI.run("@cf/bfl/flux-2-klein-4b" as keyof AiModels, { prompt })) as
    | ReadableStream
    | ArrayBuffer;
  const buf =
    aiResult instanceof ArrayBuffer ? aiResult : await new Response(aiResult).arrayBuffer();
  const key = `images/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`;
  await env.STORAGE.put(key, buf, { customMetadata: { prompt } });
  return JSON.stringify({
    image_key: key,
    format: "png",
    size_bytes: buf.byteLength,
    model: "@cf/bfl/flux-2-klein-4b",
  });
}

// ── TTS (Workers AI Deepgram) ─────────────────────────────────

async function textToSpeech(env: RuntimeEnv, args: Record<string, any>): Promise<string> {
  const text = args.text || "";
  const audioRaw = await env.AI.run("@cf/deepgram/aura-2-en" as keyof AiModels, { text }) as
    | ArrayBuffer
    | Uint8Array
    | ReadableStream
    | string;
  const audioBuffer = audioRaw instanceof ArrayBuffer
    ? audioRaw
    : audioRaw instanceof Uint8Array
      ? audioRaw.buffer.slice(audioRaw.byteOffset, audioRaw.byteOffset + audioRaw.byteLength)
      : await new Response(audioRaw as BodyInit).arrayBuffer();
  const audioResult = new Uint8Array(audioBuffer);
  const key = `audio/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp3`;
  await env.STORAGE.put(key, audioResult, {
    customMetadata: { text: text.slice(0, 200) },
  });
  return JSON.stringify({
    audio_key: key,
    size_bytes: audioResult.byteLength,
    model: "@cf/deepgram/aura-2-en",
  });
}

// ── Speech-to-Text (Workers AI Whisper) ───────────────────────

async function speechToText(env: RuntimeEnv, args: Record<string, any>, sessionId: string): Promise<string> {
  const audioPath = args.audio_path || args.path || "";
  if (!audioPath) return "speech-to-text requires audio_path";
  const sandbox = getSandbox(env.SANDBOX, `session-${sessionId}`);
  const catResult = await sandbox.exec(`base64 "${audioPath}"`, { timeout: 10 });
  if (catResult.exitCode !== 0) return `Could not read audio file: ${catResult.stderr}`;
  const audioBytes = Uint8Array.from(atob(catResult.stdout.trim()), (c) => c.charCodeAt(0));
  const whisperResult = (await env.AI.run("@cf/openai/whisper" as keyof AiModels, {
    audio: [...audioBytes],
  })) as any;
  return JSON.stringify({ text: whisperResult.text || "", language: whisperResult.language || "" });
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
    const sandbox = getSandbox(env.SANDBOX, `session-${sessionId}`);
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
  const startResp = await fetch(`${brBase}/crawl`, {
    method: "POST",
    headers: brAuth,
    body: JSON.stringify({
      url: args.url || "",
      limit: args.max_pages || 10,
      depth: args.max_depth || 2,
      formats: ["markdown"],
      render: true,
    }),
  });
  const startData = (await startResp.json()) as any;
  const jobId = startData.result;
  if (!jobId) return JSON.stringify(startData);
  const maxWaitMs = Math.max(15_000, Math.min(Number(args.timeout_ms || 60_000), 300_000));
  const pollIntervalMs = 5_000;
  const startedAt = Date.now();
  while (Date.now() - startedAt < maxWaitMs) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    const pollResp = await fetch(`${brBase}/crawl/${jobId}?limit=100`, { headers: brAuth });
    const pollData = (await pollResp.json()) as any;
    const status = pollData.result?.status;
    if (status === "completed" || status === "errored" || status?.startsWith("cancelled")) {
      return JSON.stringify(pollData);
    }
  }
  const finalResp = await fetch(`${brBase}/crawl/${jobId}?limit=100`, { headers: brAuth });
  return JSON.stringify(await finalResp.json());
}

// ── Browser Render (CF Browser Rendering) ────────────────────

async function browserRender(env: RuntimeEnv, args: Record<string, any>): Promise<string> {
  const brBase = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/browser-rendering`;
  const brAuth = { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, "Content-Type": "application/json" };
  const actionMap: Record<string, string> = { markdown: "markdown", text: "markdown", html: "content", links: "links", screenshot: "screenshot" };
  const endpoint = actionMap[args.action || "markdown"] || "markdown";
  const payload: Record<string, any> = { url: args.url || "" };
  if (args.wait_for) payload.waitForSelector = args.wait_for;
  const resp = await fetch(`${brBase}/${endpoint}`, { method: "POST", headers: brAuth, body: JSON.stringify(payload) });
  if (endpoint === "screenshot") {
    const buf = await resp.arrayBuffer();
    return JSON.stringify({ screenshot_base64: btoa(String.fromCharCode(...new Uint8Array(buf))), url: args.url });
  }
  return JSON.stringify(await resp.json());
}

// ── Save/Load Project (Sandbox <-> R2) ───────────────────────

async function saveProject(env: RuntimeEnv, args: Record<string, any>, sessionId: string): Promise<string> {
  const workspace = args.workspace || "/workspace";
  // Default org_id and agent_name from session context — agent shouldn't need to specify these
  const orgId = args.org_id || "default";
  const agentName = args.agent_name || sessionId.split("-")[0] || "agent";
  const sandbox = getSandbox(env.SANDBOX, `session-${sessionId}`);
  const tarResult = await sandbox.exec(`cd ${workspace} 2>/dev/null && tar czf /tmp/workspace.tar.gz . 2>/dev/null || echo "__EMPTY__"`, { timeout: 30 });
  if (tarResult.stdout?.includes("__EMPTY__")) return `No files found in ${workspace}`;
  const b64Result = await sandbox.exec(`base64 /tmp/workspace.tar.gz`, { timeout: 30 });
  const b64Data = b64Result.stdout?.trim() || "";
  if (!b64Data) return "Failed to read workspace archive";
  const projectId = args.project_id || "default";
  const r2Key = `workspaces/${orgId}/${projectId}/${agentName}/latest.tar.gz`;
  const versionKey = `workspaces/${orgId}/${projectId}/${agentName}/v${Date.now()}.tar.gz`;
  const bytes = Uint8Array.from(atob(b64Data), (c) => c.charCodeAt(0));
  await env.STORAGE.put(r2Key, bytes, { customMetadata: { org_id: orgId, agent_name: agentName, saved_at: new Date().toISOString() } });
  await env.STORAGE.put(versionKey, bytes, { customMetadata: { org_id: orgId, agent_name: agentName, saved_at: new Date().toISOString() } });
  const countResult = await sandbox.exec(`find ${workspace} -type f | wc -l`, { timeout: 5 });
  return JSON.stringify({ saved: true, r2_key: r2Key, version_key: versionKey, files: parseInt(countResult.stdout?.trim() || "0"), size_bytes: bytes.byteLength });
}

async function loadProject(env: RuntimeEnv, args: Record<string, any>, sessionId: string): Promise<string> {
  const workspace = args.workspace || "/workspace";
  const orgId = args.org_id || "default";
  const agentName = args.agent_name || sessionId.split("-")[0] || "agent";
  const version = args.version || "latest";
  const projectId = args.project_id || "default";
  const r2Key = version === "latest"
    ? `workspaces/${orgId}/${projectId}/${agentName}/latest.tar.gz`
    : `workspaces/${orgId}/${projectId}/${agentName}/${version}.tar.gz`;
  const sandbox = getSandbox(env.SANDBOX, `session-${sessionId}`);
  const obj = await env.STORAGE.get(r2Key);
  if (!obj) return JSON.stringify({ loaded: false, reason: "No saved workspace found." });
  const buf = await obj.arrayBuffer();
  const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
  await sandbox.writeFile("/tmp/workspace.tar.gz.b64", b64);
  await sandbox.exec(`mkdir -p ${workspace}`, { timeout: 5 });
  await sandbox.exec(`base64 -d /tmp/workspace.tar.gz.b64 > /tmp/workspace.tar.gz && cd ${workspace} && tar xzf /tmp/workspace.tar.gz`, { timeout: 30 });
  const countResult = await sandbox.exec(`find ${workspace} -type f | wc -l`, { timeout: 5 });
  return JSON.stringify({ loaded: true, r2_key: r2Key, files: parseInt(countResult.stdout?.trim() || "0"), size_bytes: buf.byteLength });
}

async function listProjectVersions(env: RuntimeEnv, args: Record<string, any>): Promise<string> {
  const orgId = args.org_id || "";
  const agentName = args.agent_name || "";
  if (!orgId || !agentName) return "list-project-versions requires org_id and agent_name";
  const prefix = `workspaces/${orgId}/${args.project_id || "default"}/${agentName}/`;
  const listed = await env.STORAGE.list({ prefix, limit: 50 });
  const versions = listed.objects.map((o: any) => ({ key: o.key.replace(prefix, ""), size: o.size, uploaded: o.uploaded }));
  return JSON.stringify({ versions, count: versions.length });
}

// ── Todo (session-scoped) ────────────────────────────────────

async function todoTool(env: RuntimeEnv, args: Record<string, any>, sessionId: string): Promise<string> {
  const action = args.action || "list";
  const sandbox = getSandbox(env.SANDBOX, `session-${sessionId}`);
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
const ALWAYS_AVAILABLE = new Set(["discover-api"]);

export function getToolDefinitions(enabledTools: string[]): ToolDefinition[] {
  const all = TOOL_CATALOG;
  if (enabledTools.length === 0) return all;
  return all.filter(
    (t) => enabledTools.includes(t.function.name) || ALWAYS_AVAILABLE.has(t.function.name),
  );
}

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
      name: "image-generate",
      description: "Generate an image from a text prompt",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "Image description prompt" },
        },
        required: ["prompt"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "text-to-speech",
      description: "Convert text to audio speech",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "Text to speak" },
        },
        required: ["text"],
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
      name: "a2a-send",
      description: "Send a task to another agent via A2A protocol",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Target agent A2A endpoint URL" },
          task: { type: "string", description: "Task message to send" },
        },
        required: ["url", "task"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "save-project",
      description: "Save the current workspace to persistent storage",
      parameters: {
        type: "object",
        properties: {
          workspace: { type: "string", description: "Workspace path (default /workspace)" },
          org_id: { type: "string", description: "Organization ID" },
          agent_name: { type: "string", description: "Agent name" },
          project_id: { type: "string", description: "Project ID" },
        },
        required: ["org_id", "agent_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "load-project",
      description: "Load a saved workspace from persistent storage",
      parameters: {
        type: "object",
        properties: {
          workspace: { type: "string", description: "Workspace path (default /workspace)" },
          org_id: { type: "string", description: "Organization ID" },
          agent_name: { type: "string", description: "Agent name" },
          project_id: { type: "string", description: "Project ID" },
          version: { type: "string", description: "Version to load (default latest)" },
        },
        required: ["org_id", "agent_name"],
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
        "Create a new agent config in the database. Auto-assigns tools based on the task. " +
        "The system_prompt you write MUST tell the agent what tools it has.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Agent name (unique within org)" },
          description: { type: "string", description: "What this agent does" },
          system_prompt: { type: "string", description: "Full system prompt for the agent" },
          model: { type: "string", description: "Model (OpenRouter format, default anthropic/claude-sonnet-4.6)" },
          tools: { type: "array", items: { type: "string" }, description: "Tool names to enable" },
          max_turns: { type: "number", description: "Max conversation turns (default 50)" },
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
      description: "Delegate a task to another agent. The sub-agent runs independently and returns output.",
      parameters: {
        type: "object",
        properties: {
          agent_name: { type: "string", description: "Agent to run" },
          task: { type: "string", description: "Task/message to send" },
          channel: { type: "string", description: "Channel (default internal)" },
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
];
