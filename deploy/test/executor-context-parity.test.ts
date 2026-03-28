import { describe, expect, it, vi } from "vitest";

vi.mock("@cloudflare/sandbox", () => ({
  getSandbox: vi.fn(() => ({
    exec: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
    writeFile: vi.fn(async () => {}),
  })),
}));

import { attachDelegationLineage } from "../src/runtime/delegation";
import { buildFreshGraphCtx, buildResumeGraphCtx } from "../src/runtime/edge_graph";
import type { AgentConfig, CheckpointPayload, RunRequest, RuntimeEnv } from "../src/runtime/types";

function baseConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    agent_name: "parity-agent",
    system_prompt: "test",
    provider: "test",
    model: "test",
    plan: "standard",
    max_turns: 4,
    budget_limit_usd: 2,
    tools: ["discover-api"],
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

describe("executor context delegation parity", () => {
  it("fresh graph context attaches parent lineage when delegated", () => {
    const env = {} as RuntimeEnv;
    const config = baseConfig({
      blocked_tools: ["bash", "web-search", "tool-3", "tool-4", "tool-5", "tool-6", "tool-7", "tool-8", "tool-9", "tool-10", "tool-11", "tool-12", "tool-13", "tool-14", "tool-15", "tool-16", "tool-17", "tool-18", "tool-19", "tool-20", "tool-21", "tool-22", "tool-23", "tool-24", "tool-25", "tool-26", "tool-27", "tool-28", "tool-29", "tool-30", "tool-31", "tool-32", "tool-33", "tool-34", "tool-35", "tool-36", "tool-37", "tool-38", "tool-39", "tool-40", "tool-41"],
      allowed_domains: Array.from({ length: 18 }, (_, i) => `allowed-${i}.test`),
    });

    const req: RunRequest = {
      agent_name: "child-agent",
      task: "do work",
      org_id: "org",
      project_id: "proj",
      delegation: {
        parent_session_id: "parent-sess",
        parent_trace_id: "parent-trace",
        parent_agent_name: "root-agent",
        parent_depth: 2,
      },
    };

    buildFreshGraphCtx(env, {} as Hyperdrive, req, config, "child-sess", "child-trace");
    const lineage = (env as unknown as { __delegationLineage?: Record<string, unknown> }).__delegationLineage;

    expect(lineage).toBeDefined();
    expect(lineage?.session_id).toBe("child-sess");
    expect(lineage?.trace_id).toBe("child-trace");
    expect(lineage?.parent_session_id).toBe("parent-sess");
    expect(lineage?.depth).toBe(3);
    expect((lineage?.policy_hints as { blocked_tools: string[] }).blocked_tools).toHaveLength(40);
    expect((lineage?.policy_hints as { allowed_domains: string[] }).allowed_domains).toHaveLength(15);
  });

  it("resume graph context and stream helper derive equivalent lineage fields", () => {
    const envResume = {} as RuntimeEnv;
    const envHelper = {} as RuntimeEnv;
    const config = baseConfig();
    const checkpoint: CheckpointPayload = {
      checkpoint_id: "ckpt",
      session_id: "old-session",
      trace_id: "resume-trace",
      agent_name: "parity-agent",
      messages: [],
      current_turn: 3,
      cumulative_cost_usd: 0.7,
      status: "approved",
      created_at: Date.now(),
    };

    buildResumeGraphCtx(
      envResume,
      {} as Hyperdrive,
      checkpoint,
      "ckpt",
      "resumed-session",
      config,
    );
    const fromResume = (envResume as unknown as { __delegationLineage?: Record<string, unknown> }).__delegationLineage;

    attachDelegationLineage(
      envHelper,
      config,
      { session_id: "resumed-session", trace_id: "resume-trace" },
      { agent_name: checkpoint.agent_name, org_id: config.org_id, project_id: config.project_id },
    );
    const fromHelper = (envHelper as unknown as { __delegationLineage?: Record<string, unknown> }).__delegationLineage;

    expect(fromResume).toEqual(fromHelper);
    expect(fromResume?.parent_session_id).toBeUndefined();
    expect(fromResume?.depth).toBe(0);
  });
});
