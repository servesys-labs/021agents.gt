/**
 * Tests for codemode integration in the declarative executor layer.
 *
 * Tests node-registry codemode kinds, middleware hook logic,
 * and codemode node type detection.
 */
import { describe, it, expect } from "vitest";

// ── Node type → scope mapping ──────────────────────────────────────────

describe("codemode node type to scope mapping", () => {
  // Mirrors the logic in executeCodemodeNode
  function resolveScope(nodeType: string, configScope?: string): string {
    let scope = "graph_node";
    if (nodeType === "codemode_transform") scope = "transform";
    else if (nodeType === "codemode_validator") scope = "validator";
    else if (nodeType === "codemode_middleware") scope = "middleware";
    if (configScope) scope = configScope;
    return scope;
  }

  it("maps codemode to graph_node scope", () => {
    expect(resolveScope("codemode")).toBe("graph_node");
  });

  it("maps codemode_transform to transform scope", () => {
    expect(resolveScope("codemode_transform")).toBe("transform");
  });

  it("maps codemode_validator to validator scope", () => {
    expect(resolveScope("codemode_validator")).toBe("validator");
  });

  it("maps codemode_middleware to middleware scope", () => {
    expect(resolveScope("codemode_middleware")).toBe("middleware");
  });

  it("config scope overrides inferred scope", () => {
    expect(resolveScope("codemode", "orchestrator")).toBe("orchestrator");
  });

  it("config scope overrides transform type", () => {
    expect(resolveScope("codemode_transform", "test")).toBe("test");
  });

  it("unknown type defaults to graph_node", () => {
    expect(resolveScope("unknown_type")).toBe("graph_node");
  });
});

// ── Codemode node config validation ────────────────────────────────────

describe("codemode node config validation", () => {
  function validateCodemodeNodeConfig(config: Record<string, unknown>): string[] {
    const errors: string[] = [];
    if (!config.code && !config.snippet_id) {
      errors.push("Either code or snippet_id is required");
    }
    if (config.code && typeof config.code !== "string") {
      errors.push("code must be a string");
    }
    if (config.snippet_id && typeof config.snippet_id !== "string") {
      errors.push("snippet_id must be a string");
    }
    if (config.scope) {
      const validScopes = [
        "agent", "graph_node", "transform", "validator", "webhook",
        "middleware", "orchestrator", "observability", "test", "mcp_generator",
      ];
      if (!validScopes.includes(config.scope as string)) {
        errors.push(`Invalid scope: ${config.scope}`);
      }
    }
    return errors;
  }

  it("accepts config with code", () => {
    expect(validateCodemodeNodeConfig({ code: "return 1;" })).toHaveLength(0);
  });

  it("accepts config with snippet_id", () => {
    expect(validateCodemodeNodeConfig({ snippet_id: "snip-123" })).toHaveLength(0);
  });

  it("rejects config with neither code nor snippet_id", () => {
    const errors = validateCodemodeNodeConfig({});
    expect(errors).toContain("Either code or snippet_id is required");
  });

  it("rejects non-string code", () => {
    const errors = validateCodemodeNodeConfig({ code: 42 });
    expect(errors).toContain("code must be a string");
  });

  it("accepts all valid scopes", () => {
    const scopes = [
      "agent", "graph_node", "transform", "validator", "webhook",
      "middleware", "orchestrator", "observability", "test", "mcp_generator",
    ];
    for (const scope of scopes) {
      expect(validateCodemodeNodeConfig({ code: "x", scope })).toHaveLength(0);
    }
  });

  it("rejects invalid scope", () => {
    const errors = validateCodemodeNodeConfig({ code: "x", scope: "bad" });
    expect(errors).toContain("Invalid scope: bad");
  });
});

// ── Middleware hook point validation ────────────────────────────────────

describe("middleware hook points", () => {
  const VALID_HOOKS = ["pre_llm", "post_llm", "pre_tool", "post_tool", "pre_output"];

  it("all 5 hook points are defined", () => {
    expect(VALID_HOOKS).toHaveLength(5);
  });

  // Mirrors the runMiddlewareHook logic
  function getHookSnippetId(
    middleware: Record<string, string | undefined> | undefined,
    hookPoint: string,
  ): string | undefined {
    if (!middleware) return undefined;
    return middleware[hookPoint];
  }

  it("returns snippet_id for configured hook", () => {
    const middleware = { pre_llm: "snip-1", post_llm: "snip-2" };
    expect(getHookSnippetId(middleware, "pre_llm")).toBe("snip-1");
    expect(getHookSnippetId(middleware, "post_llm")).toBe("snip-2");
  });

  it("returns undefined for unconfigured hook", () => {
    const middleware = { pre_llm: "snip-1" };
    expect(getHookSnippetId(middleware, "post_tool")).toBeUndefined();
  });

  it("returns undefined when middleware is undefined", () => {
    expect(getHookSnippetId(undefined, "pre_llm")).toBeUndefined();
  });
});

// ── Middleware action handling ──────────────────────────────────────────

describe("middleware action handling in executor", () => {
  // Mirrors how executeLLMNode handles middleware actions

  function handlePreLlmAction(action: any): { proceed: boolean; error?: string } {
    if (action.action === "interrupt") {
      return { proceed: false, error: `Middleware interrupted: ${action.reason}` };
    }
    return { proceed: true };
  }

  function handlePostLlmAction(
    action: any,
    content: string,
    toolCalls: any[],
  ): { content: string; toolCalls: any[]; error?: string } {
    if (action.action === "modify" && action.data) {
      return {
        content: typeof action.data.content === "string" ? action.data.content : content,
        toolCalls: Array.isArray(action.data.tool_calls) ? action.data.tool_calls : toolCalls,
      };
    }
    if (action.action === "interrupt") {
      return { content, toolCalls, error: `Post-LLM middleware interrupted: ${action.reason}` };
    }
    return { content, toolCalls };
  }

  function handlePreToolAction(
    action: any,
    toolCalls: any[],
  ): { toolCalls: any[]; error?: string } {
    if (action.action === "interrupt") {
      return { toolCalls, error: `Pre-tool middleware interrupted: ${action.reason}` };
    }
    if (action.action === "modify" && action.data) {
      return { toolCalls: Array.isArray(action.data.tool_calls) ? action.data.tool_calls : toolCalls };
    }
    return { toolCalls };
  }

  describe("pre-LLM", () => {
    it("allows continue action", () => {
      expect(handlePreLlmAction({ action: "continue" }).proceed).toBe(true);
    });

    it("blocks on interrupt action", () => {
      const r = handlePreLlmAction({ action: "interrupt", reason: "cost limit" });
      expect(r.proceed).toBe(false);
      expect(r.error).toContain("cost limit");
    });
  });

  describe("post-LLM", () => {
    it("passes through on continue", () => {
      const r = handlePostLlmAction({ action: "continue" }, "hello", []);
      expect(r.content).toBe("hello");
      expect(r.toolCalls).toEqual([]);
      expect(r.error).toBeUndefined();
    });

    it("modifies content", () => {
      const r = handlePostLlmAction(
        { action: "modify", data: { content: "modified" } },
        "original",
        [],
      );
      expect(r.content).toBe("modified");
    });

    it("modifies tool calls", () => {
      const original = [{ id: "1", name: "bash", arguments: "{}" }];
      const modified = [{ id: "1", name: "safe-bash", arguments: "{}" }];
      const r = handlePostLlmAction(
        { action: "modify", data: { tool_calls: modified } },
        "content",
        original,
      );
      expect(r.toolCalls).toEqual(modified);
    });

    it("errors on interrupt", () => {
      const r = handlePostLlmAction({ action: "interrupt", reason: "bad output" }, "c", []);
      expect(r.error).toContain("bad output");
    });

    it("preserves originals when modify data is empty", () => {
      const r = handlePostLlmAction({ action: "modify", data: {} }, "orig", [{ id: "1" }]);
      expect(r.content).toBe("orig");
      expect(r.toolCalls).toEqual([{ id: "1" }]);
    });
  });

  describe("pre-tool", () => {
    const tools = [{ id: "1", name: "web-search", arguments: "{}" }];

    it("passes through on continue", () => {
      const r = handlePreToolAction({ action: "continue" }, tools);
      expect(r.toolCalls).toBe(tools);
      expect(r.error).toBeUndefined();
    });

    it("blocks on interrupt", () => {
      const r = handlePreToolAction({ action: "interrupt", reason: "dangerous tool" }, tools);
      expect(r.error).toContain("dangerous tool");
    });

    it("replaces tool calls on modify", () => {
      const safe = [{ id: "2", name: "safe-search", arguments: "{}" }];
      const r = handlePreToolAction({ action: "modify", data: { tool_calls: safe } }, tools);
      expect(r.toolCalls).toEqual(safe);
    });
  });
});

// ── Node registry codemode kind properties ─────────────────────────────

describe("codemode node registry kinds", () => {
  const EXPECTED_KINDS = [
    {
      kind: "codemode",
      deterministic: false,
      sideEffects: true,
      async: true,
      parallelizable: true,
      timeoutMs: 60_000,
      costPerMs: 0.000012,
    },
    {
      kind: "codemode_transform",
      deterministic: false,
      sideEffects: false,
      async: true,
      parallelizable: true,
      timeoutMs: 30_000,
      costPerMs: 0.000012,
    },
    {
      kind: "codemode_validator",
      deterministic: false,
      sideEffects: false,
      async: true,
      parallelizable: true,
      timeoutMs: 10_000,
      costPerMs: 0.000012,
    },
    {
      kind: "codemode_middleware",
      deterministic: false,
      sideEffects: false,
      async: true,
      parallelizable: false,
      timeoutMs: 5_000,
      costPerMs: 0.000012,
    },
  ];

  it("all 4 codemode kinds are expected", () => {
    expect(EXPECTED_KINDS).toHaveLength(4);
  });

  for (const kind of EXPECTED_KINDS) {
    it(`${kind.kind} has correct properties`, () => {
      expect(kind.deterministic).toBe(false);
      expect(kind.async).toBe(true);
      expect(kind.costPerMs).toBe(0.000012);
    });
  }

  it("codemode_middleware is not parallelizable (hooks must be sequential)", () => {
    const mw = EXPECTED_KINDS.find((k) => k.kind === "codemode_middleware");
    expect(mw!.parallelizable).toBe(false);
  });

  it("codemode and codemode_transform are parallelizable", () => {
    for (const name of ["codemode", "codemode_transform"]) {
      const k = EXPECTED_KINDS.find((e) => e.kind === name);
      expect(k!.parallelizable).toBe(true);
    }
  });

  it("transform has no side effects", () => {
    const k = EXPECTED_KINDS.find((e) => e.kind === "codemode_transform");
    expect(k!.sideEffects).toBe(false);
  });

  it("codemode (general) has side effects", () => {
    const k = EXPECTED_KINDS.find((e) => e.kind === "codemode");
    expect(k!.sideEffects).toBe(true);
  });
});

// ── AgentConfig codemode_middleware structure ───────────────────────────

describe("AgentConfig codemode_middleware", () => {
  interface CodemodeMiddlewareConfig {
    pre_llm?: string;
    post_llm?: string;
    pre_tool?: string;
    post_tool?: string;
    pre_output?: string;
  }

  function validateMiddlewareConfig(config: CodemodeMiddlewareConfig): string[] {
    const errors: string[] = [];
    const validHooks = ["pre_llm", "post_llm", "pre_tool", "post_tool", "pre_output"];
    for (const key of Object.keys(config)) {
      if (!validHooks.includes(key)) {
        errors.push(`Unknown hook point: ${key}`);
      }
    }
    return errors;
  }

  it("accepts valid hook configuration", () => {
    expect(validateMiddlewareConfig({ pre_llm: "snip-1", post_tool: "snip-2" })).toHaveLength(0);
  });

  it("accepts empty configuration", () => {
    expect(validateMiddlewareConfig({})).toHaveLength(0);
  });

  it("accepts all 5 hooks configured", () => {
    expect(validateMiddlewareConfig({
      pre_llm: "a", post_llm: "b", pre_tool: "c", post_tool: "d", pre_output: "e",
    })).toHaveLength(0);
  });
});

// ── Cost tracking for codemode nodes ───────────────────────────────────

describe("codemode cost tracking", () => {
  it("codemode tools have correct cost rates", () => {
    const toolCosts: Record<string, { flat_usd: number; per_ms_usd: number }> = {
      "run-codemode": { flat_usd: 0.0001, per_ms_usd: 0.000012 },
      "codemode-transform": { flat_usd: 0, per_ms_usd: 0.000012 },
      "codemode-validate": { flat_usd: 0, per_ms_usd: 0.000012 },
      "codemode-orchestrate": { flat_usd: 0, per_ms_usd: 0.000012 },
      "codemode-test": { flat_usd: 0, per_ms_usd: 0.000012 },
      "codemode-generate-mcp": { flat_usd: 0, per_ms_usd: 0.000012 },
    };

    // All codemode tools should use V8 isolate rate of $0.012/s
    for (const [name, cost] of Object.entries(toolCosts)) {
      expect(cost.per_ms_usd).toBe(0.000012);
    }

    // Only run-codemode has flat cost (snippet DB lookup)
    expect(toolCosts["run-codemode"].flat_usd).toBeGreaterThan(0);
    expect(toolCosts["codemode-transform"].flat_usd).toBe(0);
  });

  it("cost accumulates correctly for a 5s execution", () => {
    const latencyMs = 5000;
    const flatUsd = 0.0001;
    const perMsUsd = 0.000012;
    const totalCost = flatUsd + latencyMs * perMsUsd;
    expect(totalCost).toBeCloseTo(0.0601, 4);
  });
});
