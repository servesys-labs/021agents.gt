/**
 * Tests for deploy/src/runtime/errors.ts
 * Phase 7.1: Structured error classification
 */
import { describe, it, expect } from "vitest";
import {
  AgentOSError, ToolError, LLMError, BudgetError,
  CircuitBreakerError, SSRFError, RefusalError,
  classifyFetchError,
} from "../src/runtime/errors";

describe("Error hierarchy", () => {
  it("AgentOSError has code, telemetrySafe, retryable, userMessage", () => {
    const err = new AgentOSError("test", { code: "TEST", telemetrySafe: true, retryable: false, userMessage: "User msg" });
    expect(err.code).toBe("TEST");
    expect(err.telemetrySafe).toBe(true);
    expect(err.retryable).toBe(false);
    expect(err.userMessage).toBe("User msg");
    expect(err instanceof Error).toBe(true);
    expect(err.name).toBe("AgentOSError");
  });

  it("ToolError captures tool name and exit code", () => {
    const err = new ToolError("bash", "command not found", { exitCode: 127 });
    expect(err.toolName).toBe("bash");
    expect(err.exitCode).toBe(127);
    expect(err.code).toBe("TOOL_ERROR");
    expect(err.userMessage).toContain("bash");
  });

  it("LLMError classifies rate limiting vs overloaded", () => {
    const rateLimited = new LLMError("gpt-5", "too many requests", { statusCode: 429, retryable: true });
    expect(rateLimited.code).toBe("LLM_RATE_LIMITED");
    expect(rateLimited.retryable).toBe(true);

    const overloaded = new LLMError("claude", "overloaded", { statusCode: 529 });
    expect(overloaded.code).toBe("LLM_OVERLOADED");
  });

  it("BudgetError includes spent and limit", () => {
    const err = new BudgetError(9.50, 10.00);
    expect(err.spent).toBe(9.50);
    expect(err.limit).toBe(10.00);
    expect(err.code).toBe("BUDGET_EXHAUSTED");
    expect(err.retryable).toBe(false);
  });

  it("CircuitBreakerError is not retryable", () => {
    const err = new CircuitBreakerError("web-search");
    expect(err.toolName).toBe("web-search");
    expect(err.retryable).toBe(false);
  });

  it("SSRFError captures blocked URL", () => {
    const err = new SSRFError("http://127.0.0.1", "Blocked IP");
    expect(err.blockedUrl).toBe("http://127.0.0.1");
    expect(err.code).toBe("SSRF_BLOCKED");
  });

  it("RefusalError captures model name", () => {
    const err = new RefusalError("claude-sonnet");
    expect(err.model).toBe("claude-sonnet");
    expect(err.code).toBe("MODEL_REFUSAL");
    expect(err.userMessage).toContain("usage policies");
  });
});

describe("classifyFetchError", () => {
  it("classifies ECONNRESET as retryable network error", () => {
    const r = classifyFetchError(new Error("connect ECONNRESET"));
    expect(r.kind).toBe("network");
    expect(r.retryable).toBe(true);
  });

  it("classifies timeout errors as retryable", () => {
    const r = classifyFetchError(new Error("Request timed out"));
    expect(r.kind).toBe("timeout");
    expect(r.retryable).toBe(true);
  });

  it("classifies SSL/TLS errors as non-retryable with hint", () => {
    const r = classifyFetchError(new Error("SSL certificate error"));
    expect(r.kind).toBe("tls");
    expect(r.retryable).toBe(false);
    expect(r.hint).toContain("proxy");
  });

  it("classifies 401 as auth error", () => {
    const r = classifyFetchError({ message: "unauthorized", status: 401 });
    expect(r.kind).toBe("auth");
    expect(r.retryable).toBe(false);
  });

  it("classifies 429 as rate limit", () => {
    const r = classifyFetchError({ message: "too many", status: 429 });
    expect(r.kind).toBe("rate_limit");
    expect(r.retryable).toBe(true);
  });

  it("classifies 500+ as retryable HTTP error", () => {
    const r = classifyFetchError({ message: "server error", status: 502 });
    expect(r.kind).toBe("http");
    expect(r.retryable).toBe(true);
  });

  it("classifies 400 as non-retryable HTTP error", () => {
    const r = classifyFetchError({ message: "bad request", status: 400 });
    expect(r.kind).toBe("http");
    expect(r.retryable).toBe(false);
  });

  it("classifies unknown errors as 'other'", () => {
    const r = classifyFetchError(new Error("something weird"));
    expect(r.kind).toBe("other");
    expect(r.retryable).toBe(false);
  });
});
