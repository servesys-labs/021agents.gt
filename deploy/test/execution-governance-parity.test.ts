/**
 * Phase 4 — parity harness: edge_graph / stream / declarative-executor all attach the same
 * policy envelope and invoke executeTools with the same effective arguments before dispatch.
 *
 * Source call sites (keep in sync when refactoring):
 * - deploy/src/runtime/edge_graph.ts — attachToolPolicyEnvelope + executeTools(..., config.parallel_tool_calls, config.tools)
 * - deploy/src/runtime/stream.ts — same executeTools signature at tool stage
 * - deploy/src/runtime/declarative-executor.ts — executeTools(..., config.parallel_tool_calls ?? true, config.tools)
 */

import { describe, expect, it, vi } from "vitest";

import type { AgentConfig, RuntimeEnv, ToolCall } from "../src/runtime/types";

vi.mock("@cloudflare/sandbox", () => ({
  getSandbox: vi.fn(() => ({
    exec: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
    writeFile: vi.fn(async () => {}),
  })),
}));

import { attachToolPolicyEnvelope, buildToolPolicyEnvelope } from "../src/runtime/policy-envelope";
import { executeTools, getToolDefinitions } from "../src/runtime/tools";

function baseConfig(overrides: Partial<AgentConfig> & { blocked_domains?: string[] } = {}): AgentConfig {
  return {
    agent_name: "parity-agent",
    system_prompt: "test",
    provider: "test",
    model: "test",
    plan: "standard",
    max_turns: 4,
    budget_limit_usd: 1,
    tools: ["http-request", "browse", "bash", "discover-api"],
    blocked_tools: [],
    allowed_domains: [],
    max_tokens_per_turn: 1024,
    require_confirmation_for_destructive: false,
    parallel_tool_calls: true,
    org_id: "org",
    project_id: "proj",
    ...overrides,
  } as AgentConfig;
}

/** Mirrors edge_graph.ts + stream.ts tool stage (no ?? on parallel_tool_calls). */
async function runToolStageEdgeOrStream(
  env: RuntimeEnv,
  config: AgentConfig,
  toolCalls: ToolCall[],
  sessionId: string,
): Promise<ReturnType<typeof executeTools>> {
  attachToolPolicyEnvelope(env, config);
  return executeTools(env, toolCalls, sessionId, config.parallel_tool_calls, config.tools);
}

/** Mirrors declarative-executor.ts executeToolNode. */
async function runToolStageDeclarative(
  env: RuntimeEnv,
  config: AgentConfig,
  toolCalls: ToolCall[],
  sessionId: string,
): Promise<ReturnType<typeof executeTools>> {
  attachToolPolicyEnvelope(env, config);
  return executeTools(env, toolCalls, sessionId, config.parallel_tool_calls ?? true, config.tools);
}

function toolCall(name: string, args: Record<string, unknown>): ToolCall {
  return { id: crypto.randomUUID(), name, arguments: JSON.stringify(args) };
}

/** Stable comparison: latency varies; cost may be derived from latency. */
function governanceSnapshot(rs: Awaited<ReturnType<typeof executeTools>>) {
  return rs.map((r) => ({
    tool: r.tool,
    error: r.error,
    result: r.result,
  }));
}

const PATH_RUNNERS = {
  edge_graph: runToolStageEdgeOrStream,
  stream: runToolStageEdgeOrStream,
  declarative: runToolStageDeclarative,
} as const;

describe("execution path governance parity (edge_graph ~ stream ~ declarative)", () => {
  it("matches on blocked_domains for url-bearing tools", async () => {
    const config = baseConfig({ blocked_domains: ["evil.test"] });

    const calls = [toolCall("http-request", { url: "https://sub.evil.test/path" })];

    const [a, b, c] = await Promise.all([
      PATH_RUNNERS.edge_graph({} as RuntimeEnv, config, calls, "s-edge"),
      PATH_RUNNERS.stream({} as RuntimeEnv, config, calls, "s-stream"),
      PATH_RUNNERS.declarative({} as RuntimeEnv, config, calls, "s-dec"),
    ]);

    const ga = governanceSnapshot(a);
    expect(ga).toEqual(governanceSnapshot(b));
    expect(ga).toEqual(governanceSnapshot(c));
    expect(ga[0]?.error).toMatch(/blocked by governance policy/);
  });

  it("matches on allowed_domains denial before dispatch", async () => {
    const cfg = baseConfig({ allowed_domains: ["only.good"] });
    const calls = [toolCall("browse", { url: "https://other.bad/page" })];

    const [edge, stream, dec] = await Promise.all([
      PATH_RUNNERS.edge_graph({} as RuntimeEnv, cfg, calls, "e1"),
      PATH_RUNNERS.stream({} as RuntimeEnv, cfg, calls, "e2"),
      PATH_RUNNERS.declarative({} as RuntimeEnv, cfg, calls, "e3"),
    ]);

    expect(governanceSnapshot(edge)).toEqual(governanceSnapshot(stream));
    expect(governanceSnapshot(edge)).toEqual(governanceSnapshot(dec));
    expect(governanceSnapshot(edge)[0]?.error).toMatch(/not in allowed domains/);
  });

  it("matches on destructive governance gate (require_confirmation_for_destructive)", async () => {
    const cfg = baseConfig({
      require_confirmation_for_destructive: true,
      tools: ["bash", "discover-api"],
    });

    const calls = [toolCall("bash", { command: "delete all files" })];
    const [edge, stream, dec] = await Promise.all([
      PATH_RUNNERS.edge_graph({} as RuntimeEnv, cfg, calls, "d1"),
      PATH_RUNNERS.stream({} as RuntimeEnv, cfg, calls, "d2"),
      PATH_RUNNERS.declarative({} as RuntimeEnv, cfg, calls, "d3"),
    ]);

    expect(governanceSnapshot(edge)).toEqual(governanceSnapshot(stream));
    expect(governanceSnapshot(edge)).toEqual(governanceSnapshot(dec));
    expect(governanceSnapshot(edge)[0]?.error).toBe("governance:destructive_blocked");
  });

  it("policy envelope maps blocked_domains from agent config", () => {
    const cfg = baseConfig({
      tools: ["browse"],
      blocked_tools: ["web-search"],
      allowed_domains: ["a.example"],
      max_tokens_per_turn: 2048,
      require_confirmation_for_destructive: true,
      blocked_domains: ["evil.test"],
    });

    expect(buildToolPolicyEnvelope(cfg).blocked_domains).toEqual(["evil.test"]);
    expect(buildToolPolicyEnvelope(cfg).enabled_tools).toEqual(["browse"]);
  });
});

describe("tool allowlist / catalog (shared getToolDefinitions contract)", () => {
  it("edge_graph, stream, and declarative all use the same definition selector", () => {
    const config = baseConfig({
      tools: ["web-search", "browse"],
      blocked_tools: ["web-search"],
    });

    const defs = getToolDefinitions(config.tools, config.blocked_tools);
    const names = defs.map((d) => d.function.name).sort();

    expect(names).toContain("browse");
    expect(names).toContain("discover-api");
    expect(names).not.toContain("web-search");
  });

  it("stream activeTools shim does not remove tools beyond getToolDefinitions", () => {
    const config = baseConfig({
      tools: ["bash", "browse"],
      blocked_tools: ["bash"],
    });

    const toolDefs = getToolDefinitions(config.tools, config.blocked_tools);
    const blockedSet = new Set(config.blocked_tools);
    const activeTools = toolDefs.filter((t) => !blockedSet.has(t.function.name));

    expect(activeTools.map((t) => t.function.name).sort()).toEqual(
      toolDefs.map((t) => t.function.name).sort(),
    );
  });

  it("empty enabled list exposes only always-available meta tools", () => {
    const defs = getToolDefinitions([], []);
    expect(defs.map((d) => d.function.name)).toEqual(["discover-api"]);
  });
});

describe("parallel_tool_calls undefined: declarative coerces, edge/stream pass through", () => {
  it("still returns identical governance outcomes for a single tool call", async () => {
    const partial = baseConfig({
      parallel_tool_calls: undefined as unknown as boolean,
      blocked_domains: ["x.test"],
    });

    const calls = [toolCall("http-request", { url: "https://x.test/" })];
    const edge = await runToolStageEdgeOrStream({} as RuntimeEnv, partial, calls, "p1");
    const dec = await runToolStageDeclarative({} as RuntimeEnv, partial, calls, "p2");

    expect(governanceSnapshot(edge)).toEqual(governanceSnapshot(dec));
  });
});
