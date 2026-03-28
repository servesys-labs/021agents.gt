/**
 * Base error class for all AgentOS SDK errors.
 *
 * Thrown when the API returns a non-2xx response or when a client-side
 * validation failure occurs.
 */
export class AgentOSError extends Error {
  /** HTTP status code returned by the API (0 for client-side errors). */
  readonly status: number;

  /** Machine-readable error code (e.g. "unauthorized", "not_found"). */
  readonly code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = "AgentOSError";
    this.status = status;
    this.code = code;

    // Maintain proper prototype chain for instanceof checks
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when the API request times out.
 */
export class AgentOSTimeoutError extends AgentOSError {
  constructor(timeoutMs: number) {
    super(
      `Request timed out after ${timeoutMs}ms`,
      0,
      "timeout",
    );
    this.name = "AgentOSTimeoutError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when authentication fails (invalid or missing API key).
 */
export class AgentOSAuthError extends AgentOSError {
  constructor(message = "Authentication failed — check your API key") {
    super(message, 401, "unauthorized");
    this.name = "AgentOSAuthError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
