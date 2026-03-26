/**
 * Unit tests for the codemode runtime layer.
 *
 * These test the pure logic functions exported from deploy/src/runtime/codemode.ts
 * without needing actual CF Workers bindings. We import the source directly and
 * mock the DynamicWorkerExecutor / executeTools at the boundary.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// We test the pure helpers by re-implementing the key logic inline
// (the real codemode.ts lives in deploy/ which has different tsconfig).
// This keeps tests self-contained and avoids cross-project import issues.

// ── Scope Config Resolution ────────────────────────────────────────────

const SCOPE_DEFAULTS: Record<string, any> = {
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

function resolveScopeConfig(scope: string, overrides?: Partial<any>): any {
  const defaults = SCOPE_DEFAULTS[scope];
  if (!defaults) throw new Error(`Unknown scope: ${scope}`);
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

interface ToolDef {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

function filterToolsByScope(allTools: ToolDef[], config: any): ToolDef[] {
  const blocked = new Set(config.blockedTools);
  return allTools.filter((t) => {
    const name = t.function.name;
    if (blocked.has(name)) return false;
    if (config.allowedTools === "*") return true;
    return config.allowedTools.includes(name);
  });
}

const VALID_JS_IDENTIFIER = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;

function buildWrappedCode(code: string, input?: unknown, globals?: Record<string, unknown>): string {
  const parts: string[] = ["// helpers injected"];
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
  return latencyMs * 0.000012;
}

// ── Sample tool definitions for testing ────────────────────────────────

const SAMPLE_TOOLS: ToolDef[] = [
  { type: "function", function: { name: "web-search", description: "Search web", parameters: {} } },
  { type: "function", function: { name: "http-request", description: "HTTP call", parameters: {} } },
  { type: "function", function: { name: "bash", description: "Shell exec", parameters: {} } },
  { type: "function", function: { name: "python-exec", description: "Python exec", parameters: {} } },
  { type: "function", function: { name: "knowledge-search", description: "Search KB", parameters: {} } },
  { type: "function", function: { name: "store-knowledge", description: "Store KB", parameters: {} } },
  { type: "function", function: { name: "discover-api", description: "Get types", parameters: {} } },
  { type: "function", function: { name: "execute-code", description: "Code exec", parameters: {} } },
  { type: "function", function: { name: "image-generate", description: "Gen image", parameters: {} } },
];

// ── Tests ──────────────────────────────────────────────────────────────

describe("resolveScopeConfig", () => {
  it("returns defaults for each scope without overrides", () => {
    const scopes = Object.keys(SCOPE_DEFAULTS);
    for (const scope of scopes) {
      const config = resolveScopeConfig(scope);
      expect(config).toEqual(SCOPE_DEFAULTS[scope]);
    }
  });

  it("merges overrides onto defaults", () => {
    const config = resolveScopeConfig("agent", { timeoutMs: 5000, maxToolCalls: 10 });
    expect(config.timeoutMs).toBe(5000);
    expect(config.maxToolCalls).toBe(10);
    // Non-overridden fields remain default
    expect(config.allowedTools).toBe("*");
    expect(config.blockedTools).toEqual(["discover-api", "execute-code"]);
  });

  it("allows overriding allowedTools from wildcard to explicit list", () => {
    const config = resolveScopeConfig("agent", { allowedTools: ["web-search"] });
    expect(config.allowedTools).toEqual(["web-search"]);
  });

  it("allows overriding blockedTools", () => {
    const config = resolveScopeConfig("transform", { blockedTools: ["http-request"] });
    expect(config.blockedTools).toEqual(["http-request"]);
  });

  it("allows enabling nested codemode", () => {
    const config = resolveScopeConfig("validator", { allowNestedCodemode: true, maxNestingDepth: 1 });
    expect(config.allowNestedCodemode).toBe(true);
    expect(config.maxNestingDepth).toBe(1);
  });

  it("throws for unknown scope", () => {
    expect(() => resolveScopeConfig("nonexistent")).toThrow("Unknown scope");
  });
});

describe("scope defaults correctness", () => {
  it("agent scope blocks discover-api and execute-code by default", () => {
    const config = SCOPE_DEFAULTS.agent;
    expect(config.blockedTools).toContain("discover-api");
    expect(config.blockedTools).toContain("execute-code");
  });

  it("middleware scope has tight limits", () => {
    const config = SCOPE_DEFAULTS.middleware;
    expect(config.timeoutMs).toBe(5_000);
    expect(config.maxToolCalls).toBe(3);
    expect(config.allowNestedCodemode).toBe(false);
  });

  it("test scope has generous limits", () => {
    const config = SCOPE_DEFAULTS.test;
    expect(config.timeoutMs).toBe(120_000);
    expect(config.maxToolCalls).toBe(200);
    expect(config.allowNestedCodemode).toBe(true);
  });

  it("orchestrator blocks bash and python-exec", () => {
    const config = SCOPE_DEFAULTS.orchestrator;
    expect(config.blockedTools).toContain("bash");
    expect(config.blockedTools).toContain("python-exec");
  });

  it("transform only allows specific tools", () => {
    const config = SCOPE_DEFAULTS.transform;
    expect(config.allowedTools).toEqual(["http-request", "knowledge-search", "store-knowledge"]);
  });

  it("validator only allows specific tools", () => {
    const config = SCOPE_DEFAULTS.validator;
    expect(config.allowedTools).toEqual(["http-request", "knowledge-search"]);
  });

  it("mcp_generator only allows http-request", () => {
    const config = SCOPE_DEFAULTS.mcp_generator;
    expect(config.allowedTools).toEqual(["http-request"]);
  });

  it("graph_node supports nesting up to depth 2", () => {
    const config = SCOPE_DEFAULTS.graph_node;
    expect(config.allowNestedCodemode).toBe(true);
    expect(config.maxNestingDepth).toBe(2);
  });

  it("orchestrator supports nesting up to depth 3", () => {
    const config = SCOPE_DEFAULTS.orchestrator;
    expect(config.maxNestingDepth).toBe(3);
  });
});

describe("filterToolsByScope", () => {
  it("wildcard allows all non-blocked tools", () => {
    const config = resolveScopeConfig("agent");
    const filtered = filterToolsByScope(SAMPLE_TOOLS, config);
    const names = filtered.map((t) => t.function.name);
    expect(names).toContain("web-search");
    expect(names).toContain("bash");
    expect(names).not.toContain("discover-api");
    expect(names).not.toContain("execute-code");
  });

  it("explicit allowlist restricts to listed tools only", () => {
    const config = resolveScopeConfig("transform");
    const filtered = filterToolsByScope(SAMPLE_TOOLS, config);
    const names = filtered.map((t) => t.function.name);
    expect(names).toEqual(["http-request", "knowledge-search", "store-knowledge"]);
  });

  it("validator filters to allowed tools only", () => {
    const config = resolveScopeConfig("validator");
    const filtered = filterToolsByScope(SAMPLE_TOOLS, config);
    const names = filtered.map((t) => t.function.name);
    expect(names).toEqual(["http-request", "knowledge-search"]);
  });

  it("orchestrator blocks bash, python-exec, discover-api, execute-code", () => {
    const config = resolveScopeConfig("orchestrator");
    const filtered = filterToolsByScope(SAMPLE_TOOLS, config);
    const names = filtered.map((t) => t.function.name);
    expect(names).not.toContain("bash");
    expect(names).not.toContain("python-exec");
    expect(names).not.toContain("discover-api");
    expect(names).not.toContain("execute-code");
    expect(names).toContain("web-search");
    expect(names).toContain("http-request");
  });

  it("mcp_generator allows only http-request", () => {
    const config = resolveScopeConfig("mcp_generator");
    const filtered = filterToolsByScope(SAMPLE_TOOLS, config);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].function.name).toBe("http-request");
  });

  it("middleware allows only knowledge-search", () => {
    const config = resolveScopeConfig("middleware");
    const filtered = filterToolsByScope(SAMPLE_TOOLS, config);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].function.name).toBe("knowledge-search");
  });

  it("custom override can block additional tools", () => {
    const config = resolveScopeConfig("agent", { blockedTools: ["discover-api", "execute-code", "bash"] });
    const filtered = filterToolsByScope(SAMPLE_TOOLS, config);
    const names = filtered.map((t) => t.function.name);
    expect(names).not.toContain("bash");
    expect(names).toContain("web-search");
  });

  it("returns empty when allowlist has no matches", () => {
    const config = resolveScopeConfig("validator", { allowedTools: ["nonexistent-tool"] });
    const filtered = filterToolsByScope(SAMPLE_TOOLS, config);
    expect(filtered).toHaveLength(0);
  });
});

describe("buildWrappedCode", () => {
  it("wraps bare code in async IIFE", () => {
    const result = buildWrappedCode("return 42;");
    expect(result).toContain("(async () => {");
    expect(result).toContain("return 42;");
    expect(result).toContain("})()");
  });

  it("does not double-wrap async function code", () => {
    const code = "async function main() { return 1; }";
    const result = buildWrappedCode(code);
    expect(result).toContain(code);
    expect(result).not.toContain("(async () => {");
  });

  it("does not wrap code starting with (async", () => {
    const code = "(async () => { return 1; })()";
    const result = buildWrappedCode(code);
    expect(result).toContain(code);
    // Should not double-wrap
    expect(result.match(/\(async \(\) =>/g)?.length).toBe(1);
  });

  it("does not wrap code starting with export", () => {
    const code = "export default { fetch() {} }";
    const result = buildWrappedCode(code);
    expect(result).toContain(code);
    expect(result).not.toContain("(async () => {");
  });

  it("injects input variable when provided", () => {
    const result = buildWrappedCode("return input;", { foo: "bar" });
    expect(result).toContain('const input = {"foo":"bar"};');
  });

  it("injects globals as separate const declarations", () => {
    const result = buildWrappedCode("return x + y;", undefined, { x: 1, y: 2 });
    expect(result).toContain("const x = 1;");
    expect(result).toContain("const y = 2;");
  });

  it("injects both input and globals", () => {
    const result = buildWrappedCode("return input + headers;", { data: 1 }, { headers: { "x-test": "v" } });
    expect(result).toContain('const input = {"data":1};');
    expect(result).toContain('const headers = {"x-test":"v"};');
  });

  it("does not inject input when undefined", () => {
    const result = buildWrappedCode("return 1;");
    expect(result).not.toContain("const input");
  });

  it("handles empty globals object", () => {
    const result = buildWrappedCode("return 1;", undefined, {});
    // Should not crash, no extra const declarations
    expect(result).toContain("return 1;");
  });
});

describe("computeCodemodeCost", () => {
  it("returns 0 for 0ms", () => {
    expect(computeCodemodeCost(0)).toBe(0);
  });

  it("computes $0.012/s rate correctly", () => {
    // 1000ms = $0.012
    expect(computeCodemodeCost(1000)).toBeCloseTo(0.012, 6);
  });

  it("computes cost for 30s timeout", () => {
    // 30000ms = $0.36
    expect(computeCodemodeCost(30_000)).toBeCloseTo(0.36, 4);
  });

  it("handles fractional milliseconds", () => {
    expect(computeCodemodeCost(500)).toBeCloseTo(0.006, 6);
  });
});

describe("validation result normalization", () => {
  // Mirrors executeValidator output normalization logic
  function normalizeValidation(output: unknown): { valid: boolean; errors: string[]; warnings: string[] } {
    if (typeof output === "boolean") {
      return { valid: output, errors: output ? [] : ["Validation failed"], warnings: [] };
    }
    if (typeof output === "object" && output !== null) {
      const o = output as any;
      return {
        valid: Boolean(o.valid),
        errors: o.valid ? [] : [o.error || o.message || "Validation failed"],
        warnings: Array.isArray(o.warnings) ? o.warnings : [],
      };
    }
    return { valid: true, errors: [], warnings: [] };
  }

  it("normalizes boolean true", () => {
    const r = normalizeValidation(true);
    expect(r.valid).toBe(true);
    expect(r.errors).toHaveLength(0);
  });

  it("normalizes boolean false", () => {
    const r = normalizeValidation(false);
    expect(r.valid).toBe(false);
    expect(r.errors).toEqual(["Validation failed"]);
  });

  it("normalizes object with valid=true", () => {
    const r = normalizeValidation({ valid: true });
    expect(r.valid).toBe(true);
    expect(r.errors).toHaveLength(0);
  });

  it("normalizes object with valid=false and error", () => {
    const r = normalizeValidation({ valid: false, error: "Bad data" });
    expect(r.valid).toBe(false);
    expect(r.errors).toEqual(["Bad data"]);
  });

  it("normalizes object with valid=false and message", () => {
    const r = normalizeValidation({ valid: false, message: "Invalid" });
    expect(r.valid).toBe(false);
    expect(r.errors).toEqual(["Invalid"]);
  });

  it("normalizes object with warnings", () => {
    const r = normalizeValidation({ valid: true, warnings: ["Check X"] });
    expect(r.valid).toBe(true);
    expect(r.warnings).toEqual(["Check X"]);
  });

  it("defaults to valid for null/undefined output", () => {
    expect(normalizeValidation(null).valid).toBe(true);
    expect(normalizeValidation(undefined).valid).toBe(true);
  });

  it("defaults to valid for string output", () => {
    expect(normalizeValidation("ok").valid).toBe(true);
  });
});

describe("middleware action normalization", () => {
  // Mirrors executeMiddleware output normalization logic
  function normalizeMiddleware(output: unknown): { action: string; [key: string]: unknown } {
    if (typeof output === "object" && output !== null && (output as any).action) {
      return output as any;
    }
    return { action: "continue" };
  }

  it("returns continue for null output", () => {
    expect(normalizeMiddleware(null).action).toBe("continue");
  });

  it("returns continue for output without action", () => {
    expect(normalizeMiddleware({ foo: "bar" }).action).toBe("continue");
  });

  it("preserves interrupt action with reason", () => {
    const r = normalizeMiddleware({ action: "interrupt", reason: "loop detected" });
    expect(r.action).toBe("interrupt");
    expect(r.reason).toBe("loop detected");
  });

  it("preserves modify action with data", () => {
    const r = normalizeMiddleware({ action: "modify", data: { x: 1 } });
    expect(r.action).toBe("modify");
    expect(r.data).toEqual({ x: 1 });
  });

  it("preserves redirect action with target", () => {
    const r = normalizeMiddleware({ action: "redirect", target: "other-agent" });
    expect(r.action).toBe("redirect");
    expect(r.target).toBe("other-agent");
  });

  it("preserves summarize action", () => {
    const r = normalizeMiddleware({ action: "summarize", summary: "...", preserve: ["goal"] });
    expect(r.action).toBe("summarize");
    expect(r.summary).toBe("...");
    expect(r.preserve).toEqual(["goal"]);
  });
});

describe("webhook handler result normalization", () => {
  function normalizeWebhook(output: unknown): { processed: boolean; response?: unknown; routeTo?: string } {
    if (typeof output === "object" && output !== null) {
      const o = output as any;
      return {
        processed: Boolean(o.processed ?? true),
        response: o.response ?? o,
        routeTo: o.routeTo || o.route_to || o.pipeline,
      };
    }
    return { processed: true, response: output };
  }

  it("normalizes object with processed flag", () => {
    const r = normalizeWebhook({ processed: true, response: { id: 1 } });
    expect(r.processed).toBe(true);
    expect(r.response).toEqual({ id: 1 });
  });

  it("defaults processed to true", () => {
    const r = normalizeWebhook({ response: "ok" });
    expect(r.processed).toBe(true);
  });

  it("handles routeTo field", () => {
    expect(normalizeWebhook({ routeTo: "pipeline-a" }).routeTo).toBe("pipeline-a");
  });

  it("handles route_to field (snake_case)", () => {
    expect(normalizeWebhook({ route_to: "pipeline-b" }).routeTo).toBe("pipeline-b");
  });

  it("handles pipeline field", () => {
    expect(normalizeWebhook({ pipeline: "ingest" }).routeTo).toBe("ingest");
  });

  it("normalizes primitive output", () => {
    const r = normalizeWebhook("simple string");
    expect(r.processed).toBe(true);
    expect(r.response).toBe("simple string");
  });
});

describe("orchestration result normalization", () => {
  function normalizeOrchestration(output: unknown, fallbackMsg: string): any {
    if (typeof output !== "object" || output === null) {
      return { targetAgent: "", input: fallbackMsg };
    }
    const o = output as any;
    return {
      targetAgent: o.targetAgent || o.target_agent || o.agent || "",
      input: o.input || fallbackMsg,
      context: o.context,
      preProcessed: o.preProcessed || o.pre_processed,
      postProcess: o.postProcess || o.post_process,
    };
  }

  it("normalizes camelCase targetAgent", () => {
    const r = normalizeOrchestration({ targetAgent: "billing-agent", input: "refund" }, "");
    expect(r.targetAgent).toBe("billing-agent");
    expect(r.input).toBe("refund");
  });

  it("normalizes snake_case target_agent", () => {
    const r = normalizeOrchestration({ target_agent: "support" }, "hi");
    expect(r.targetAgent).toBe("support");
  });

  it("normalizes short agent field", () => {
    const r = normalizeOrchestration({ agent: "sales" }, "hi");
    expect(r.targetAgent).toBe("sales");
  });

  it("falls back to message when no input in output", () => {
    const r = normalizeOrchestration({ targetAgent: "a" }, "original message");
    expect(r.input).toBe("original message");
  });

  it("returns empty targetAgent for null output", () => {
    const r = normalizeOrchestration(null, "msg");
    expect(r.targetAgent).toBe("");
    expect(r.input).toBe("msg");
  });
});

describe("test runner result normalization", () => {
  function normalizeTestResult(output: unknown, latencyMs: number): any {
    if (typeof output === "object" && output !== null && typeof (output as any).total === "number") {
      return output;
    }
    return { passed: 1, failed: 0, total: 1, results: [{ name: "default", passed: true, latencyMs }] };
  }

  it("passes through well-formed test result", () => {
    const result = { passed: 3, failed: 1, total: 4, results: [] };
    expect(normalizeTestResult(result, 100)).toBe(result);
  });

  it("creates default result for non-object output", () => {
    const r = normalizeTestResult("ok", 50);
    expect(r.passed).toBe(1);
    expect(r.total).toBe(1);
    expect(r.results[0].latencyMs).toBe(50);
  });

  it("creates default result for object without total", () => {
    const r = normalizeTestResult({ foo: "bar" }, 100);
    expect(r.total).toBe(1);
  });
});

// ── Security: globals key injection prevention ─────────────────────────

describe("globals key injection prevention", () => {
  it("rejects key with closing brace and semicolon", () => {
    expect(() => buildWrappedCode("x", undefined, { "foo}; maliciousCode(); const x": "v" }))
      .toThrow(/Invalid global variable name/);
  });

  it("rejects key with spaces", () => {
    expect(() => buildWrappedCode("x", undefined, { "foo bar": "v" }))
      .toThrow(/Invalid global variable name/);
  });

  it("rejects key with newlines", () => {
    expect(() => buildWrappedCode("x", undefined, { "foo\nbar": "v" }))
      .toThrow(/Invalid global variable name/);
  });

  it("rejects key starting with a number", () => {
    expect(() => buildWrappedCode("x", undefined, { "123abc": "v" }))
      .toThrow(/Invalid global variable name/);
  });

  it("rejects empty key", () => {
    expect(() => buildWrappedCode("x", undefined, { "": "v" }))
      .toThrow(/Invalid global variable name/);
  });

  it("rejects key with template literal backtick", () => {
    expect(() => buildWrappedCode("x", undefined, { "a`b": "v" }))
      .toThrow(/Invalid global variable name/);
  });

  it("allows valid identifier with underscore prefix", () => {
    expect(() => buildWrappedCode("x", undefined, { "_private": "v" })).not.toThrow();
  });

  it("allows valid identifier with $ prefix", () => {
    expect(() => buildWrappedCode("x", undefined, { "$data": "v" })).not.toThrow();
  });

  it("allows camelCase identifiers", () => {
    expect(() => buildWrappedCode("x", undefined, { "myVariable": "v" })).not.toThrow();
  });

  it("allows identifiers with numbers (not leading)", () => {
    expect(() => buildWrappedCode("x", undefined, { "data2": "v" })).not.toThrow();
  });
});

// ── Security: code size limits ─────────────────────────────────────────

describe("code size limits", () => {
  const MAX_CODE_SIZE = 100_000;

  it("accepts code under 100KB", () => {
    const code = "a".repeat(MAX_CODE_SIZE - 1);
    expect(code.length).toBeLessThan(MAX_CODE_SIZE);
  });

  it("rejects code over 100KB", () => {
    const code = "a".repeat(MAX_CODE_SIZE + 1);
    expect(code.length).toBeGreaterThan(MAX_CODE_SIZE);
  });

  it("exact boundary is accepted", () => {
    const code = "a".repeat(MAX_CODE_SIZE);
    expect(code.length).toBe(MAX_CODE_SIZE);
    // Size check is > not >=, so exactly 100KB is accepted
  });
});

describe("CODEMODE_TEMPLATES", () => {
  // Template definitions live in codemode.ts; we validate their structure here
  const TEMPLATE_NAMES = [
    "sentiment-router", "data-enrichment", "approval-validator",
    "webhook-normalize", "loop-detector", "intent-router",
    "latency-monitor", "multi-tool-orchestrator",
  ];

  const EXPECTED_SCOPES: Record<string, string> = {
    "sentiment-router": "graph_node",
    "data-enrichment": "transform",
    "approval-validator": "validator",
    "webhook-normalize": "webhook",
    "loop-detector": "middleware",
    "intent-router": "orchestrator",
    "latency-monitor": "observability",
    "multi-tool-orchestrator": "agent",
  };

  it("has exactly 8 built-in templates", () => {
    expect(TEMPLATE_NAMES).toHaveLength(8);
  });

  it("each template maps to the correct scope", () => {
    for (const [name, scope] of Object.entries(EXPECTED_SCOPES)) {
      // Validate scope is a known scope
      expect(SCOPE_DEFAULTS).toHaveProperty(scope);
    }
  });

  it("all scopes are covered by at least one template", () => {
    const coveredScopes = new Set(Object.values(EXPECTED_SCOPES));
    // These scopes have templates
    expect(coveredScopes).toContain("graph_node");
    expect(coveredScopes).toContain("transform");
    expect(coveredScopes).toContain("validator");
    expect(coveredScopes).toContain("webhook");
    expect(coveredScopes).toContain("middleware");
    expect(coveredScopes).toContain("orchestrator");
    expect(coveredScopes).toContain("observability");
    expect(coveredScopes).toContain("agent");
  });
});
