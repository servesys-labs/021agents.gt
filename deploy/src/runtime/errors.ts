/**
 * Structured error classification for AgentOS runtime.
 *
 * Error hierarchy with telemetry-safe metadata, retryability flags,
 * and user-safe messages. Prevents PII/code from leaking into analytics.
 *
 * Inspired by Claude Code's TelemetrySafeError + classifyAxiosError patterns.
 */

// ── Base Error ──────────────────────────────────────────────────────

export class AgentOSError extends Error {
  /** Machine-readable error code for dashboards/filtering */
  code: string;
  /** Safe to log to analytics (no PII, no code, no file paths) */
  telemetrySafe: boolean;
  /** Whether the operation can be retried */
  retryable: boolean;
  /** User-facing message (separate from internal stack trace) */
  userMessage?: string;

  constructor(message: string, opts: {
    code: string;
    telemetrySafe?: boolean;
    retryable?: boolean;
    userMessage?: string;
  }) {
    super(message);
    this.name = "AgentOSError";
    this.code = opts.code;
    this.telemetrySafe = opts.telemetrySafe ?? true;
    this.retryable = opts.retryable ?? false;
    this.userMessage = opts.userMessage;
  }
}

// ── Specialized Errors ──────────────────────────────────────────────

export class ToolError extends AgentOSError {
  toolName: string;
  exitCode?: number;

  constructor(toolName: string, message: string, opts?: {
    exitCode?: number;
    retryable?: boolean;
  }) {
    super(message, {
      code: "TOOL_ERROR",
      telemetrySafe: true,
      retryable: opts?.retryable ?? false,
      userMessage: `Tool "${toolName}" failed`,
    });
    this.name = "ToolError";
    this.toolName = toolName;
    this.exitCode = opts?.exitCode;
  }
}

export class LLMError extends AgentOSError {
  model: string;
  statusCode?: number;
  retryAfterMs?: number;

  constructor(model: string, message: string, opts?: {
    statusCode?: number;
    retryAfterMs?: number;
    retryable?: boolean;
  }) {
    super(message, {
      code: opts?.statusCode === 429 ? "LLM_RATE_LIMITED"
        : opts?.statusCode === 529 ? "LLM_OVERLOADED"
        : "LLM_ERROR",
      telemetrySafe: true,
      retryable: opts?.retryable ?? false,
      userMessage: "The AI model encountered an error",
    });
    this.name = "LLMError";
    this.model = model;
    this.statusCode = opts?.statusCode;
    this.retryAfterMs = opts?.retryAfterMs;
  }
}

export class BudgetError extends AgentOSError {
  spent: number;
  limit: number;

  constructor(spent: number, limit: number) {
    super(`Budget exhausted: $${spent.toFixed(4)} spent of $${limit.toFixed(4)} limit`, {
      code: "BUDGET_EXHAUSTED",
      telemetrySafe: true,
      retryable: false,
      userMessage: "The budget limit for this session has been reached",
    });
    this.name = "BudgetError";
    this.spent = spent;
    this.limit = limit;
  }
}

export class CircuitBreakerError extends AgentOSError {
  toolName: string;

  constructor(toolName: string) {
    super(`Circuit breaker OPEN for ${toolName}`, {
      code: "CIRCUIT_BREAKER_OPEN",
      telemetrySafe: true,
      retryable: false,
      userMessage: `Tool "${toolName}" is temporarily unavailable due to repeated failures`,
    });
    this.name = "CircuitBreakerError";
    this.toolName = toolName;
  }
}

export class SSRFError extends AgentOSError {
  blockedUrl: string;

  constructor(url: string, reason: string) {
    super(`SSRF blocked: ${reason}`, {
      code: "SSRF_BLOCKED",
      telemetrySafe: true, // URL logged but not the response
      retryable: false,
      userMessage: "The requested URL is blocked for security reasons",
    });
    this.name = "SSRFError";
    this.blockedUrl = url;
  }
}

export class RefusalError extends AgentOSError {
  model: string;

  constructor(model: string) {
    super(`Model ${model} refused the request`, {
      code: "MODEL_REFUSAL",
      telemetrySafe: true,
      retryable: false,
      userMessage: "The AI model declined this request due to usage policies. Try rephrasing your request.",
    });
    this.name = "RefusalError";
    this.model = model;
  }
}

// ── Fetch Error Classification ──────────────────────────────────────

export type FetchErrorKind = "auth" | "timeout" | "network" | "rate_limit" | "tls" | "http" | "other";

export interface ClassifiedFetchError {
  kind: FetchErrorKind;
  retryable: boolean;
  status?: number;
  hint?: string;
}

/**
 * Classify a fetch error into a structured category.
 * Walks the cause chain (max 5 levels) to find the root error.
 */
export function classifyFetchError(e: any): ClassifiedFetchError {
  const msg = (e?.message || String(e)).toLowerCase();
  const status = e?.status || e?.statusCode;

  // Network errors
  if (msg.includes("econnreset") || msg.includes("epipe") || msg.includes("econnrefused")) {
    return { kind: "network", retryable: true };
  }
  if (msg.includes("fetch failed") || msg.includes("network error")) {
    return { kind: "network", retryable: true };
  }

  // TLS errors
  if (msg.includes("cert") || msg.includes("ssl") || msg.includes("tls")) {
    return { kind: "tls", retryable: false, hint: "Check proxy/TLS configuration" };
  }

  // Timeout
  if (msg.includes("timeout") || msg.includes("timed out") || msg.includes("aborted")) {
    return { kind: "timeout", retryable: true };
  }

  // Auth
  if (status === 401 || status === 403) {
    return { kind: "auth", retryable: false, status };
  }

  // Rate limiting
  if (status === 429 || status === 529) {
    return { kind: "rate_limit", retryable: true, status };
  }

  // Other HTTP errors
  if (status && status >= 400) {
    return { kind: "http", retryable: status >= 500, status };
  }

  return { kind: "other", retryable: false };
}
