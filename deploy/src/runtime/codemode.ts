/**
 * Edge Runtime -- Code Mode (Discover + Execute pattern).
 *
 * Full codemode system supporting:
 *   - Scoped execution contexts (graph-node, transform, validator, webhook, middleware, orchestrator)
 *   - Capability-based tool permissions per scope
 *   - Resource limits per execution scope
 *   - Audit trail for every execution
 *   - Snippet registry (load/store reusable code)
 *   - Built-in helper injections (utilities available inside sandbox)
 *
 * Architecture:
 *   1. generateTypesFromJsonSchema() creates TypeScript types from tool schemas
 *   2. Code (LLM-generated or user-stored snippet) runs in isolated V8 isolate
 *   3. DynamicWorkerExecutor manages sandbox lifecycle
 *   4. ToolDispatcher routes tool calls from sandbox -> parent via RPC
 *   5. Parent executes actual tools with full bindings and auth
 *
 * Security:
 *   - globalOutbound: null -> sandbox has zero network access
 *   - env: {} -> sandbox has zero bindings (no secrets, no DB)
 *   - All tool execution goes through ToolDispatcher RPC -> parent worker
 *   - Per-scope tool allowlists prevent privilege escalation
 *   - Execution time + memory bounded per scope
 *   - Concurrency limit prevents resource exhaustion
 */

import {
  DynamicWorkerExecutor,
  generateTypesFromJsonSchema,
  normalizeCode,
  type JsonSchemaToolDescriptors,
  type ExecuteResult,
} from "@cloudflare/codemode";
import type { RuntimeEnv, ToolDefinition, RuntimeEvent } from "./types";
import { executeTools } from "./tools";
import { log } from "./log";
// pushRuntimeEvent removed with edge_graph.ts — no-op stub for codemode audit events
function pushRuntimeEvent(_events: any, _type: string, _turn: number, _data: any) {}

// == Execution Scope ==

/**
 * Defines what context a codemode execution runs in.
 * Each scope has different default tool permissions and resource limits.
 */
export type CodemodeScope =
  | "agent"          // LLM-generated code during agent turn (original behavior)
  | "graph_node"     // Custom graph node logic
  | "transform"      // Data transformation pipeline step
  | "validator"      // Schema/business-rule validation
  | "webhook"        // Webhook payload processing
  | "middleware"      // Pre/post hooks on LLM/tool calls
  | "orchestrator"   // Multi-agent routing/dispatch
  | "observability"  // Telemetry processing/alerting
  | "test"           // Self-test / eval execution
  | "mcp_generator"; // Dynamic MCP server generation

export interface CodemodeScopeConfig {
  /** Which tools the sandbox may call. "*" = all, or explicit allowlist. */
  allowedTools: "*" | string[];
  /** Tools explicitly denied even if "*" is set. */
  blockedTools: string[];
  /** Max wall-clock time in ms. */
  timeoutMs: number;
  /** Max number of tool calls within a single execution. */
  maxToolCalls: number;
  /** Whether the code may call other codemode snippets (prevents recursion bombs). */
  allowNestedCodemode: boolean;
  /** Max nesting depth for nested codemode calls. */
  maxNestingDepth: number;
}

/** Sane defaults per scope. Callers can override individual fields. */
const SCOPE_DEFAULTS: Record<CodemodeScope, CodemodeScopeConfig> = {
  agent: {
    allowedTools: "*",
    blockedTools: ["discover-api", "execute-code"],
    timeoutMs: 30_000,
    maxToolCalls: 50,
    allowNestedCodemode: false,
    maxNestingDepth: 0,
  },
  graph_node: {
    allowedTools: "*",
    blockedTools: ["discover-api", "execute-code"],
    timeoutMs: 60_000,
    maxToolCalls: 100,
    allowNestedCodemode: true,
    maxNestingDepth: 2,
  },
  transform: {
    allowedTools: ["http-request", "knowledge-search", "store-knowledge"],
    blockedTools: [],
    timeoutMs: 30_000,
    maxToolCalls: 20,
    allowNestedCodemode: false,
    maxNestingDepth: 0,
  },
  validator: {
    allowedTools: ["http-request", "knowledge-search"],
    blockedTools: [],
    timeoutMs: 10_000,
    maxToolCalls: 5,
    allowNestedCodemode: false,
    maxNestingDepth: 0,
  },
  webhook: {
    allowedTools: ["http-request", "knowledge-search", "store-knowledge", "web-search"],
    blockedTools: [],
    timeoutMs: 15_000,
    maxToolCalls: 10,
    allowNestedCodemode: false,
    maxNestingDepth: 0,
  },
  middleware: {
    allowedTools: ["knowledge-search"],
    blockedTools: [],
    timeoutMs: 5_000,
    maxToolCalls: 3,
    allowNestedCodemode: false,
    maxNestingDepth: 0,
  },
  orchestrator: {
    allowedTools: "*",
    blockedTools: ["discover-api", "execute-code", "bash", "python-exec"],
    timeoutMs: 60_000,
    maxToolCalls: 100,
    allowNestedCodemode: true,
    maxNestingDepth: 3,
  },
  observability: {
    allowedTools: ["http-request", "knowledge-search"],
    blockedTools: [],
    timeoutMs: 10_000,
    maxToolCalls: 10,
    allowNestedCodemode: false,
    maxNestingDepth: 0,
  },
  test: {
    allowedTools: "*",
    blockedTools: ["discover-api", "execute-code"],
    timeoutMs: 120_000,
    maxToolCalls: 200,
    allowNestedCodemode: true,
    maxNestingDepth: 2,
  },
  mcp_generator: {
    allowedTools: ["http-request"],
    blockedTools: [],
    timeoutMs: 15_000,
    maxToolCalls: 5,
    allowNestedCodemode: false,
    maxNestingDepth: 0,
  },
};

/** Merge user overrides onto scope defaults. */
export function resolveScopeConfig(
  scope: CodemodeScope,
  overrides?: Partial<CodemodeScopeConfig>,
): CodemodeScopeConfig {
  const defaults = SCOPE_DEFAULTS[scope];
  if (!overrides) return { ...defaults };
  return {
    allowedTools: overrides.allowedTools ?? defaults.allowedTools,
    blockedTools: overrides.blockedTools ?? defaults.blockedTools,
    timeoutMs: overrides.timeoutMs ?? defaults.timeoutMs,
    maxToolCalls: overrides.maxToolCalls ?? defaults.maxToolCalls,
    allowNestedCodemode: overrides.allowNestedCodemode ?? defaults.allowNestedCodemode,
    maxNestingDepth: overrides.maxNestingDepth ?? defaults.maxNestingDepth,
  };
}

// == Execution Options ==

export interface CodemodeExecuteOptions {
  scope: CodemodeScope;
  scopeOverrides?: Partial<CodemodeScopeConfig>;
  /** Data injected as `input` variable inside the sandbox. */
  input?: unknown;
  /** Additional variables injected into sandbox global scope. */
  globals?: Record<string, unknown>;
  /** Current nesting depth (for recursion protection). */
  currentDepth?: number;
  traceId?: string;
  orgId?: string;
  snippetId?: string;
  /** Events array to push audit events into. */
  events?: RuntimeEvent[];
}

// == Execution Result ==

export interface CodemodeResult {
  success: boolean;
  result: unknown;
  error?: string;
  logs: string[];
  toolCallCount: number;
  latencyMs: number;
  costUsd: number;
  scope: CodemodeScope;
  snippetId?: string;
}

// == Snippet Types ==

export interface CodemodeSnippet {
  id: string;
  org_id: string;
  name: string;
  description: string;
  code: string;
  scope: CodemodeScope;
  input_schema?: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
  scope_config?: Partial<CodemodeScopeConfig>;
  tags: string[];
  version: number;
  is_template: boolean;
  created_at: number;
  updated_at: number;
}

// == Built-in Helpers (injected into every sandbox) ==

const SANDBOX_HELPERS = `
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function percentile(arr, p) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil(p * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}
function sum(arr) { return arr.reduce((a, b) => a + (Number(b) || 0), 0); }
function unique(arr) { return [...new Set(arr)]; }
function deepClone(obj) { return JSON.parse(JSON.stringify(obj)); }
function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) { const c = str.charCodeAt(i); hash = ((hash << 5) - hash) + c; hash = hash & hash; }
  return Math.abs(hash).toString(36);
}
function formatDuration(ms) {
  if (ms < 1000) return ms + "ms";
  if (ms < 60000) return (ms / 1000).toFixed(1) + "s";
  return (ms / 60000).toFixed(1) + "m";
}
async function retry(fn, maxRetries, baseDelay) {
  maxRetries = maxRetries || 3; baseDelay = baseDelay || 100;
  let lastError;
  for (let i = 0; i <= maxRetries; i++) {
    try { return await fn(); } catch (err) { lastError = err; if (i < maxRetries) await sleep(baseDelay * Math.pow(2, i)); }
  }
  throw lastError;
}
`;

// == Concurrency + Executor Pool ==

let pendingExecutions = 0;
const MAX_CONCURRENT_EXECUTIONS = 10;
let concurrencyRejectionsTotal = 0;
let lastConcurrencyRejectionAtMs = 0;

// == Snippet Cache ==

const SNIPPET_CACHE_TTL_MS = 60_000; // 60s
const SNIPPET_CACHE_MAX = 256;
const snippetCache = new Map<string, { snippet: CodemodeSnippet; ts: number }>();

/** Load a snippet from DB with TTL cache. Returns null if not found. */
export async function loadSnippetCached(
  hyperdrive: Hyperdrive,
  snippetId: string,
  orgId: string,
): Promise<CodemodeSnippet | null> {
  const cacheKey = `${orgId}:${snippetId}`;
  const cached = snippetCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < SNIPPET_CACHE_TTL_MS) {
    return cached.snippet;
  }

  try {
    const { getDb } = await import("./db");
    const sql = await getDb(hyperdrive);
    const rows = await sql`
      SELECT id, org_id, name, description, code, scope,
             input_schema, output_schema, scope_config,
             tags, version, is_template, created_at, updated_at
      FROM codemode_snippets
      WHERE id = ${snippetId} AND org_id = ${orgId}
      LIMIT 1
    `;
    if (rows.length === 0) return null;

    const row = rows[0] as Record<string, unknown>;
    const snippet: CodemodeSnippet = {
      id: String(row.id),
      org_id: String(row.org_id),
      name: String(row.name || ""),
      description: String(row.description || ""),
      code: String(row.code || ""),
      scope: (row.scope as CodemodeScope) || "agent",
      input_schema: safeJsonParse(row.input_schema),
      output_schema: safeJsonParse(row.output_schema),
      scope_config: safeJsonParse(row.scope_config),
      tags: safeJsonParse(row.tags) || [],
      version: Number(row.version || 1),
      is_template: Boolean(row.is_template),
      created_at: Number(row.created_at || 0),
      updated_at: Number(row.updated_at || 0),
    };

    // Evict oldest if at capacity
    if (snippetCache.size >= SNIPPET_CACHE_MAX) {
      let oldestKey: string | null = null;
      let oldestTs = Infinity;
      for (const [k, v] of snippetCache) {
        if (v.ts < oldestTs) { oldestTs = v.ts; oldestKey = k; }
      }
      if (oldestKey) snippetCache.delete(oldestKey);
    }

    snippetCache.set(cacheKey, { snippet, ts: Date.now() });
    return snippet;
  } catch {
    return null;
  }
}

function safeJsonParse(val: unknown): any {
  if (val === null || val === undefined) return undefined;
  if (typeof val === "object") return val;
  try { return JSON.parse(String(val)); } catch { return undefined; }
}

/** Invalidate a cached snippet (call after update/delete). */
export function invalidateSnippetCache(snippetId: string, orgId: string): void {
  snippetCache.delete(`${orgId}:${snippetId}`);
}

/** Clear entire snippet cache. */
export function clearSnippetCache(): void {
  snippetCache.clear();
}

export function getCodeModeStats(): {
  pending_executions: number;
  max_concurrent_executions: number;
  concurrency_rejections_total: number;
  last_concurrency_rejection_at_ms: number;
  snippet_cache_size: number;
} {
  return {
    pending_executions: pendingExecutions,
    max_concurrent_executions: MAX_CONCURRENT_EXECUTIONS,
    concurrency_rejections_total: concurrencyRejectionsTotal,
    last_concurrency_rejection_at_ms: lastConcurrencyRejectionAtMs,
    snippet_cache_size: snippetCache.size,
  };
}

const executorPool = new Map<string, DynamicWorkerExecutor>();

function getExecutor(env: RuntimeEnv, timeoutMs: number): DynamicWorkerExecutor {
  const key = `${timeoutMs}`;
  let executor = executorPool.get(key);
  if (!executor) {
    executor = new DynamicWorkerExecutor({
      loader: env.LOADER,
      timeout: timeoutMs,
      globalOutbound: null,
      // Inject SANDBOX_HELPERS as an ES module via v0.2.1 `modules` option.
      // LLM code can: `import { sleep, retry, percentile } from "helpers.js"`
      modules: { "helpers.js": SANDBOX_HELPERS_MODULE },
    });
    executorPool.set(key, executor);
  }
  return executor;
}

/**
 * SANDBOX_HELPERS as an ES module (v0.2.1 modules injection).
 * Available via `import { sleep, retry, percentile } from "helpers.js"` inside sandbox.
 */
const SANDBOX_HELPERS_MODULE = `
export function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
export function percentile(arr, p) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil(p * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}
export function sum(arr) { return arr.reduce((a, b) => a + (Number(b) || 0), 0); }
export function unique(arr) { return [...new Set(arr)]; }
export function deepClone(obj) { return JSON.parse(JSON.stringify(obj)); }
export function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) { const c = str.charCodeAt(i); hash = ((hash << 5) - hash) + c; hash = hash & hash; }
  return Math.abs(hash).toString(36);
}
export function formatDuration(ms) {
  if (ms < 1000) return ms + "ms";
  if (ms < 60000) return (ms / 1000).toFixed(1) + "s";
  return (ms / 60000).toFixed(1) + "m";
}
export async function retry(fn, maxRetries, baseDelay) {
  maxRetries = maxRetries || 3; baseDelay = baseDelay || 100;
  let lastError;
  for (let i = 0; i <= maxRetries; i++) {
    try { return await fn(); } catch (err) { lastError = err; if (i < maxRetries) await sleep(baseDelay * Math.pow(2, i)); }
  }
  throw lastError;
}
`;

// == Core Execution ==

/**
 * Execute code in a sandboxed V8 isolate with scoped permissions.
 * Main entry point for all codemode executions across the platform.
 */
export async function executeScopedCode(
  env: RuntimeEnv,
  code: string,
  allToolDefs: ToolDefinition[],
  sessionId: string,
  options: CodemodeExecuteOptions,
): Promise<CodemodeResult> {
  const started = Date.now();
  const scopeConfig = resolveScopeConfig(options.scope, options.scopeOverrides);

  // Concurrency guard
  if (pendingExecutions >= MAX_CONCURRENT_EXECUTIONS) {
    concurrencyRejectionsTotal += 1;
    lastConcurrencyRejectionAtMs = Date.now();
    log.warn(
      `[codemode] concurrency limit reached: pending=${pendingExecutions} max=${MAX_CONCURRENT_EXECUTIONS} scope=${options.scope} session=${sessionId}`,
    );
    return {
      success: false, result: null,
      error: `Too many concurrent codemode executions (${MAX_CONCURRENT_EXECUTIONS} max)`,
      logs: [], toolCallCount: 0, latencyMs: Date.now() - started, costUsd: 0,
      scope: options.scope, snippetId: options.snippetId,
    };
  }

  // Recursion guard
  const currentDepth = options.currentDepth || 0;
  if (currentDepth > scopeConfig.maxNestingDepth) {
    return {
      success: false, result: null,
      error: `Codemode nesting depth exceeded (max ${scopeConfig.maxNestingDepth})`,
      logs: [], toolCallCount: 0, latencyMs: Date.now() - started, costUsd: 0,
      scope: options.scope, snippetId: options.snippetId,
    };
  }

  pendingExecutions++;
  try {
    const filteredTools = filterToolsByScope(allToolDefs, scopeConfig);

    let toolCallCount = 0;
    let toolCostUsd = 0;

    // Build tool RPC bridges — register both kebab-case and camelCase aliases
    // so LLMs can call `codemode["web-search"]()` or `codemode.webSearch()`.
    const toolFns: Record<string, (args: any) => Promise<unknown>> = {};
    for (const def of filteredTools) {
      const toolName = def.function.name;
      const handler = async (args: any) => {
        toolCallCount++;
        if (toolCallCount > scopeConfig.maxToolCalls) {
          throw new Error(`Tool call limit exceeded (max ${scopeConfig.maxToolCalls} for scope "${options.scope}")`);
        }
        const results = await executeTools(
          env,
          [{ id: `cm-${options.scope}-${Date.now()}`, name: toolName, arguments: JSON.stringify(args) }],
          sessionId,
          false,
        );
        const result = results[0];
        if (result?.cost_usd) toolCostUsd += result.cost_usd;
        if (result?.error) throw new Error(result.error);
        try { return JSON.parse(result?.result || "null"); } catch { return result?.result || null; }
      };
      toolFns[toolName] = handler;
      // Aliases so LLMs and generated code can use any naming convention:
      //   web-search → webSearch (camelCase) + web_search (snake_case)
      const camel = toolName.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
      if (camel !== toolName) toolFns[camel] = handler;
      const snake = toolName.replace(/-/g, "_");
      if (snake !== toolName) toolFns[snake] = handler;
    }

    // Code size guard — prevent memory exhaustion in V8 isolate
    const MAX_CODE_SIZE = 100_000; // 100KB
    if (code.length > MAX_CODE_SIZE) {
      return {
        success: false, result: null,
        error: `Code exceeds ${MAX_CODE_SIZE} byte limit (${code.length} bytes)`,
        logs: [], toolCallCount, latencyMs: Date.now() - started, costUsd: 0,
        scope: options.scope, snippetId: options.snippetId,
      };
    }

    const wrappedCode = buildWrappedCode(code, options.input, options.globals);
    const normalized = normalizeCode(wrappedCode);

    let execResult: ExecuteResult;
    try {
      execResult = await getExecutor(env, scopeConfig.timeoutMs).execute(normalized, toolFns);
    } catch (err) {
      const latencyMs = Date.now() - started;
      emitCodemodeAuditEvent(options, false, latencyMs, toolCallCount, toolCostUsd, String(err));
      return {
        success: false, result: null,
        error: err instanceof Error ? err.message : String(err),
        logs: [], toolCallCount, latencyMs,
        costUsd: toolCostUsd + computeCodemodeCost(latencyMs),
        scope: options.scope, snippetId: options.snippetId,
      };
    }

    const latencyMs = Date.now() - started;
    const computeCost = computeCodemodeCost(latencyMs);
    const success = !execResult.error;
    emitCodemodeAuditEvent(options, success, latencyMs, toolCallCount, toolCostUsd + computeCost, execResult.error);

    return {
      success, result: execResult.result, error: execResult.error,
      logs: execResult.logs || [], toolCallCount, latencyMs,
      costUsd: toolCostUsd + computeCost,
      scope: options.scope, snippetId: options.snippetId,
    };
  } finally {
    pendingExecutions = Math.max(0, pendingExecutions - 1);
  }
}

/**
 * Original executeCode -- preserved for backward compatibility.
 * Delegates to executeScopedCode with scope="agent".
 */
export async function executeCode(
  env: RuntimeEnv,
  code: string,
  toolDefs: ToolDefinition[],
  sessionId: string,
): Promise<ExecuteResult> {
  const result = await executeScopedCode(env, code, toolDefs, sessionId, { scope: "agent" });
  return { result: result.result, error: result.error, logs: result.logs } as ExecuteResult;
}

/**
 * Get TypeScript type definitions for all available tools.
 */
export function getToolTypeDefinitions(toolDefs: ToolDefinition[]): string {
  const descriptors: JsonSchemaToolDescriptors = {};
  for (const def of toolDefs) {
    descriptors[def.function.name] = {
      description: def.function.description,
      inputSchema: def.function.parameters as any,
    };
  }
  return generateTypesFromJsonSchema(descriptors);
}

/**
 * Get scoped type definitions -- only types for tools the scope allows.
 */
export function getScopedTypeDefinitions(
  toolDefs: ToolDefinition[],
  scope: CodemodeScope,
  overrides?: Partial<CodemodeScopeConfig>,
): string {
  const config = resolveScopeConfig(scope, overrides);
  const filtered = filterToolsByScope(toolDefs, config);
  return getToolTypeDefinitions(filtered);
}

// == Snippet Execution ==

export async function executeSnippet(
  env: RuntimeEnv,
  snippet: CodemodeSnippet,
  allToolDefs: ToolDefinition[],
  sessionId: string,
  input: unknown,
  extraOptions?: Partial<CodemodeExecuteOptions>,
): Promise<CodemodeResult> {
  return executeScopedCode(env, snippet.code, allToolDefs, sessionId, {
    scope: snippet.scope,
    scopeOverrides: snippet.scope_config,
    input,
    snippetId: snippet.id,
    ...extraOptions,
  });
}

// == Transform ==

export async function executeTransform(
  env: RuntimeEnv,
  code: string,
  inputData: unknown,
  allToolDefs: ToolDefinition[],
  sessionId: string,
  overrides?: Partial<CodemodeScopeConfig>,
): Promise<CodemodeResult> {
  return executeScopedCode(env, code, allToolDefs, sessionId, {
    scope: "transform", scopeOverrides: overrides, input: inputData,
  });
}

// == Validator ==

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export async function executeValidator(
  env: RuntimeEnv,
  code: string,
  data: unknown,
  allToolDefs: ToolDefinition[],
  sessionId: string,
  overrides?: Partial<CodemodeScopeConfig>,
): Promise<ValidationResult> {
  const result = await executeScopedCode(env, code, allToolDefs, sessionId, {
    scope: "validator", scopeOverrides: overrides, input: data,
  });
  if (!result.success) {
    return { valid: false, errors: [result.error || "Validator execution failed"], warnings: [] };
  }
  const output = result.result as any;
  if (typeof output === "boolean") {
    return { valid: output, errors: output ? [] : ["Validation failed"], warnings: [] };
  }
  if (typeof output === "object" && output !== null) {
    return {
      valid: Boolean(output.valid),
      errors: output.valid ? [] : [output.error || output.message || "Validation failed"],
      warnings: Array.isArray(output.warnings) ? output.warnings : [],
    };
  }
  return { valid: true, errors: [], warnings: [] };
}

// == Webhook Handler ==

export interface WebhookHandlerResult {
  processed: boolean;
  response?: unknown;
  error?: string;
  routeTo?: string;
}

export async function executeWebhookHandler(
  env: RuntimeEnv,
  code: string,
  payload: unknown,
  headers: Record<string, string>,
  allToolDefs: ToolDefinition[],
  sessionId: string,
  overrides?: Partial<CodemodeScopeConfig>,
): Promise<WebhookHandlerResult> {
  const result = await executeScopedCode(env, code, allToolDefs, sessionId, {
    scope: "webhook", scopeOverrides: overrides, input: payload, globals: { headers },
  });
  if (!result.success) return { processed: false, error: result.error };
  const output = result.result as any;
  if (typeof output === "object" && output !== null) {
    return {
      processed: Boolean(output.processed ?? true),
      response: output.response ?? output,
      error: output.error,
      routeTo: output.routeTo || output.route_to || output.pipeline,
    };
  }
  return { processed: true, response: output };
}

// == Middleware ==

export type MiddlewareAction =
  | { action: "continue" }
  | { action: "modify"; data: unknown }
  | { action: "interrupt"; reason: string; suggestion?: string }
  | { action: "summarize"; summary: string; preserve?: string[] }
  | { action: "redirect"; target: string };

export async function executeMiddleware(
  env: RuntimeEnv,
  code: string,
  context: unknown,
  allToolDefs: ToolDefinition[],
  sessionId: string,
  overrides?: Partial<CodemodeScopeConfig>,
): Promise<MiddlewareAction> {
  const result = await executeScopedCode(env, code, allToolDefs, sessionId, {
    scope: "middleware", scopeOverrides: overrides, input: context,
  });
  if (!result.success) return { action: "continue" };
  const output = result.result as any;
  if (typeof output === "object" && output !== null && output.action) return output as MiddlewareAction;
  return { action: "continue" };
}

// == Observability Processor ==

export interface ObservabilityResult {
  metrics: Record<string, number>;
  anomalies: unknown[];
  alerts: Array<{ severity: string; message: string }>;
}

export async function executeObservabilityProcessor(
  env: RuntimeEnv,
  code: string,
  eventBatch: unknown[],
  allToolDefs: ToolDefinition[],
  sessionId: string,
  overrides?: Partial<CodemodeScopeConfig>,
): Promise<ObservabilityResult> {
  const result = await executeScopedCode(env, code, allToolDefs, sessionId, {
    scope: "observability", scopeOverrides: overrides,
    input: { events: eventBatch, batch_size: eventBatch.length },
  });
  if (!result.success) return { metrics: {}, anomalies: [], alerts: [] };
  const output = result.result as any;
  return {
    metrics: output?.metrics || {},
    anomalies: output?.anomalies || [],
    alerts: output?.alerts || [],
  };
}

// == Orchestrator ==

export interface OrchestrationResult {
  targetAgent: string;
  input: unknown;
  context?: Record<string, unknown>;
  preProcessed?: unknown;
  postProcess?: string;
}

export async function executeOrchestrator(
  env: RuntimeEnv,
  code: string,
  message: string,
  context: Record<string, unknown>,
  allToolDefs: ToolDefinition[],
  sessionId: string,
  overrides?: Partial<CodemodeScopeConfig>,
): Promise<OrchestrationResult> {
  const result = await executeScopedCode(env, code, allToolDefs, sessionId, {
    scope: "orchestrator", scopeOverrides: overrides, input: { message, context },
  });
  if (!result.success) return { targetAgent: "", input: message, context };
  const output = result.result as any;
  return {
    targetAgent: output?.targetAgent || output?.target_agent || output?.agent || "",
    input: output?.input || message,
    context: output?.context || context,
    preProcessed: output?.preProcessed || output?.pre_processed,
    postProcess: output?.postProcess || output?.post_process,
  };
}

// == MCP Generator ==

export interface GeneratedMcpTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handlerCode: string;
}

export async function executeMcpGenerator(
  env: RuntimeEnv,
  code: string,
  apiSpec: unknown,
  allToolDefs: ToolDefinition[],
  sessionId: string,
  overrides?: Partial<CodemodeScopeConfig>,
): Promise<GeneratedMcpTool[]> {
  const result = await executeScopedCode(env, code, allToolDefs, sessionId, {
    scope: "mcp_generator", scopeOverrides: overrides, input: apiSpec,
  });
  if (!result.success || !Array.isArray(result.result)) return [];
  return (result.result as any[]).filter(
    (t) => t && typeof t.name === "string" && typeof t.handlerCode === "string"
  );
}

// == Test Runner ==

export interface CodemodeTestResult {
  passed: number;
  failed: number;
  total: number;
  results: Array<{ name: string; passed: boolean; error?: string; latencyMs: number }>;
}

export async function executeTestRunner(
  env: RuntimeEnv,
  code: string,
  testContext: unknown,
  allToolDefs: ToolDefinition[],
  sessionId: string,
  overrides?: Partial<CodemodeScopeConfig>,
): Promise<CodemodeTestResult> {
  const result = await executeScopedCode(env, code, allToolDefs, sessionId, {
    scope: "test", scopeOverrides: overrides, input: testContext,
  });
  if (!result.success) {
    return { passed: 0, failed: 1, total: 1, results: [{ name: "execution", passed: false, error: result.error, latencyMs: result.latencyMs }] };
  }
  const output = result.result as any;
  if (typeof output === "object" && output !== null && typeof output.total === "number") return output as CodemodeTestResult;
  return { passed: 1, failed: 0, total: 1, results: [{ name: "default", passed: true, latencyMs: result.latencyMs }] };
}

// == Built-in Snippet Templates ==

export const CODEMODE_TEMPLATES: Array<Omit<CodemodeSnippet, "id" | "org_id" | "created_at" | "updated_at">> = [
  {
    name: "sentiment-router", description: "Analyze sentiment and route to different paths based on score",
    code: `const analysis = await codemode.analyzeSentiment ? await codemode.analyzeSentiment({ text: input.text }) : { score: 0.5 };\nreturn { positive: analysis.score > 0.5, confidence: analysis.score, route: analysis.score > 0.5 ? "happy_path" : "escalate" };`,
    scope: "graph_node",
    input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    output_schema: { type: "object", properties: { positive: { type: "boolean" }, confidence: { type: "number" }, route: { type: "string" } } },
    tags: ["sentiment", "routing", "nlp"], version: 1, is_template: true,
  },
  {
    name: "data-enrichment", description: "Enrich records with additional data from knowledge base",
    code: `const enriched = await Promise.all(input.records.map(async (record) => {\n  const extra = await codemode.knowledgeSearch ? await codemode.knowledgeSearch({ query: record.key_field }) : {};\n  return { ...record, ...extra };\n}));\nreturn { records: enriched, count: enriched.length };`,
    scope: "transform",
    input_schema: { type: "object", properties: { records: { type: "array" } }, required: ["records"] },
    tags: ["enrichment", "transform", "pipeline"], version: 1, is_template: true,
  },
  {
    name: "approval-validator", description: "Validate high-value transactions require approval",
    code: `const errors = [];\nif (input.amount > 10000 && !input.approver) errors.push("High-value transactions (>$10k) require an approver");\nif (input.start_date && input.end_date && input.start_date > input.end_date) errors.push("Start date must be before end date");\nreturn { valid: errors.length === 0, errors };`,
    scope: "validator", tags: ["validation", "approval", "business-rules"], version: 1, is_template: true,
  },
  {
    name: "webhook-normalize", description: "Normalize webhook payloads from various providers",
    code: `const provider = headers["x-webhook-source"] || "unknown";\nreturn { processed: true, response: { event_type: input.event_type || input.type || input.action || "unknown", timestamp: input.timestamp || input.created_at || Date.now(), provider, data: input.data || input.payload || input } };`,
    scope: "webhook", tags: ["webhook", "normalization"], version: 1, is_template: true,
  },
  {
    name: "loop-detector", description: "Custom middleware to detect repetitive agent patterns",
    code: `const history = input.turn_history || [];\nconst recent = history.slice(-3);\nif (recent.length >= 3) {\n  const tools = recent.map(t => (t.tool_calls || []).map(tc => tc.name).join(","));\n  if (tools.every(t => t === tools[0]) && tools[0] !== "") return { action: "interrupt", reason: "Detected tool loop: " + tools[0], suggestion: "Try a different approach" };\n}\nreturn { action: "continue" };`,
    scope: "middleware", tags: ["middleware", "loop-detection", "safety"], version: 1, is_template: true,
  },
  {
    name: "intent-router", description: "Route messages to specialist agents based on intent classification",
    code: `const msg = input.message.toLowerCase();\nconst agents = { billing: ["invoice","payment","charge","refund","subscription"], technical: ["error","bug","crash","issue","not working"], sales: ["pricing","plan","upgrade","demo","trial"] };\nlet targetAgent = "general-agent", confidence = 0.3;\nfor (const [cat, kws] of Object.entries(agents)) { const m = kws.filter(kw => msg.includes(kw)).length; if (m > confidence) { confidence = m; targetAgent = cat + "-agent"; } }\nreturn { targetAgent, input: input.message, context: { ...input.context, confidence } };`,
    scope: "orchestrator", tags: ["routing", "multi-agent", "intent"], version: 1, is_template: true,
  },
  {
    name: "latency-monitor", description: "Process telemetry batch and detect latency anomalies",
    code: `const events = input.events || [];\nconst latencies = events.map(e => e.latency_ms || 0).filter(l => l > 0);\nconst p95 = percentile(latencies, 0.95), p50 = percentile(latencies, 0.50);\nconst errorRate = events.filter(e => e.error).length / Math.max(events.length, 1);\nconst anomalies = events.filter(e => (e.latency_ms || 0) > p95 * 2);\nconst alerts = [];\nif (errorRate > 0.05) alerts.push({ severity: "warning", message: "Error rate spike: " + (errorRate * 100).toFixed(1) + "%" });\nif (p95 > 5000) alerts.push({ severity: "warning", message: "P95 latency high: " + formatDuration(p95) });\nreturn { metrics: { p50, p95, error_rate: errorRate, count: events.length }, anomalies, alerts };`,
    scope: "observability", tags: ["observability", "latency", "alerting"], version: 1, is_template: true,
  },
  {
    name: "multi-tool-orchestrator", description: "Chain multiple tool calls in a single turn",
    code: `const searchResults = await codemode.webSearch({ query: input.topic });\nconst summary = await codemode.summarize ? await codemode.summarize({ text: JSON.stringify(searchResults) }) : JSON.stringify(searchResults).slice(0, 500);\nreturn { topic: input.topic, summary, sources: searchResults };`,
    scope: "agent", tags: ["agent", "multi-tool", "orchestration"], version: 1, is_template: true,
  },
];

// == Internal Helpers ==

function filterToolsByScope(allTools: ToolDefinition[], config: CodemodeScopeConfig): ToolDefinition[] {
  const blocked = new Set(config.blockedTools);
  return allTools.filter((t) => {
    const name = t.function.name;
    if (blocked.has(name)) return false;
    if (config.allowedTools === "*") return true;
    return config.allowedTools.includes(name);
  });
}

/** Only valid JS identifiers allowed as global variable names. */
const VALID_JS_IDENTIFIER = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;

function buildWrappedCode(code: string, input?: unknown, globals?: Record<string, unknown>): string {
  // SANDBOX_HELPERS are now injected as an ES module ("helpers") via DynamicWorkerExecutor.modules.
  // We still inline them here for backward compatibility with code that uses them as globals.
  const parts: string[] = [SANDBOX_HELPERS];
  if (input !== undefined) parts.push(`const input = ${JSON.stringify(input)};`);
  if (globals) {
    for (const [key, value] of Object.entries(globals)) {
      if (!VALID_JS_IDENTIFIER.test(key)) {
        throw new Error(`Invalid global variable name: "${key}" — must be a valid JS identifier`);
      }
      parts.push(`const ${key} = ${JSON.stringify(value)};`);
    }
  }
  const trimmed = code.trim();
  if (trimmed.startsWith("async function") || trimmed.startsWith("(async") || trimmed.startsWith("export")) {
    parts.push(trimmed);
  } else {
    parts.push(`(async () => {\n${trimmed}\n})()`);
  }
  return parts.join("\n\n");
}

function computeCodemodeCost(latencyMs: number): number {
  return latencyMs * 0.000012; // $0.012/s
}

function emitCodemodeAuditEvent(
  options: CodemodeExecuteOptions,
  success: boolean,
  latencyMs: number,
  toolCallCount: number,
  costUsd: number,
  error?: string,
): void {
  if (!options.events) return;
  pushRuntimeEvent(options.events, "tool_result", 0, {
    tool_name: `codemode:${options.scope}`,
    session_id: "",
    trace_id: options.traceId || "",
    status: success ? "ok" : "error",
    latency_ms: latencyMs,
    cost_usd: costUsd,
    tool_call_count: toolCallCount,
    snippet_id: options.snippetId || "",
    scope: options.scope,
    org_id: options.orgId || "",
    error: error || "",
  });
}

// ── Harness Code Tool (createCodeTool integration) ─────────────
//
// Uses the new @cloudflare/codemode v0.2.1 createCodeTool() API to collapse
// all tools into a SINGLE code tool. The LLM writes code that chains tools
// instead of making individual tool calls — saves ~85% of tool tokens.

/**
 * Create a single "harness" code tool that wraps all available tools.
 * The LLM gets ONE tool that lets it write code calling any combination
 * of the agent's tools, plus harness helpers (git, lint, search).
 *
 * Token savings: ~6,400 tokens (64 tools) → ~1,000 tokens (1 code tool + types)
 */
export async function createHarnessCodeTool(
  env: RuntimeEnv,
  toolDefs: ToolDefinition[],
  sessionId: string,
  scope: CodemodeScope = "agent",
  scopeOverrides?: Partial<CodemodeScopeConfig>,
): Promise<{
  definition: ToolDefinition;
  execute: (code: string) => Promise<CodemodeResult>;
}> {
  const scopeConfig = resolveScopeConfig(scope, scopeOverrides);
  const filtered = filterToolsByScope(toolDefs, scopeConfig);

  // Build type definitions for all available tools
  const descriptors: JsonSchemaToolDescriptors = {};
  for (const def of filtered) {
    descriptors[def.function.name] = {
      description: def.function.description,
      inputSchema: def.function.parameters as any,
    };
  }
  const toolTypes = generateTypesFromJsonSchema(descriptors);

  // Import harness helper types
  const { HARNESS_TYPE_DEFS, buildSandboxModules } = await import("./harness-modules");

  // Build the codemode tool definition
  const definition: ToolDefinition = {
    type: "function",
    function: {
      name: "codemode",
      description:
        `Write and execute JavaScript code that orchestrates tools. ` +
        `Your code runs in an isolated sandbox with access to all tools via \`codemode.*\` methods. ` +
        `You can also import harness helpers: \`import { safeEdit, gitCheckpoint, findDefinition, navigateTo } from "harness.js"\`.\n\n` +
        `Available tool methods:\n${toolTypes}\n\n` +
        `Harness helpers:\n${HARNESS_TYPE_DEFS}\n\n` +
        `Write an async arrow function: \`async (codemode) => { ... }\``,
      parameters: {
        type: "object",
        properties: {
          code: {
            type: "string",
            description: "JavaScript code to execute. Must be an async arrow function: async (codemode) => { ... }",
          },
        },
        required: ["code"],
      },
    },
  };

  // Build executor with harness modules
  const modules = buildSandboxModules();
  const executor = new DynamicWorkerExecutor({
    loader: env.LOADER,
    timeout: scopeConfig.timeoutMs,
    globalOutbound: null,
    modules,
  });

  // Build the execute function
  const execute = async (code: string): Promise<CodemodeResult> => {
    return executeScopedCode(env, code, toolDefs, sessionId, {
      scope,
      scopeOverrides: {
        ...scopeOverrides,
        // Allow more tool calls in code mode since the LLM chains them
        maxToolCalls: Math.max(scopeConfig.maxToolCalls, 100),
      },
    });
  };

  return { definition, execute };
}

/**
 * Get the code mode tool definitions for an agent.
 * Returns either the full tool catalog (tool mode) or a single codemode tool (code mode).
 */
export async function getHarnessToolDefs(
  env: RuntimeEnv,
  toolDefs: ToolDefinition[],
  sessionId: string,
  useCodeMode: boolean,
): Promise<ToolDefinition[]> {
  if (!useCodeMode) return toolDefs;

  const { definition } = await createHarnessCodeTool(env, toolDefs, sessionId);
  // In code mode, offer the codemode tool + discover-api for introspection
  const discoverApi = toolDefs.find((t) => t.function.name === "discover-api");
  return discoverApi ? [definition, discoverApi] : [definition];
}

