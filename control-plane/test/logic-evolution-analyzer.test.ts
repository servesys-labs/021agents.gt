/**
 * Evolution Analyzer — unit tests for pure analysis functions.
 */
import { describe, it, expect } from "vitest";
import {
  analyzeSessionRecords,
  generateProposals,
  type SessionRecord,
} from "../src/logic/evolution-analyzer";

function makeSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    session_id: `sess-${Math.random().toString(36).slice(2, 8)}`,
    agent_name: "test-agent",
    status: "success",
    stop_reason: "end_turn",
    cost_total_usd: 0.005,
    wall_clock_seconds: 10,
    step_count: 3,
    action_count: 2,
    created_at: Date.now() / 1000,
    tool_calls: [],
    errors: [],
    ...overrides,
  };
}

describe("analyzeSessionRecords", () => {
  it("returns empty report for no sessions", () => {
    const report = analyzeSessionRecords("test-agent", [], [], 7);
    expect(report.session_count).toBe(0);
    expect(report.success_rate).toBe(0);
    expect(report.recommendations).toContain("No sessions found in the analysis window.");
  });

  it("calculates success rate correctly", () => {
    const records = [
      makeSession({ status: "success" }),
      makeSession({ status: "success" }),
      makeSession({ status: "error" }),
    ];
    const report = analyzeSessionRecords("test-agent", records, [], 7);
    expect(report.session_count).toBe(3);
    expect(report.success_rate).toBeCloseTo(0.6667, 2);
  });

  it("calculates average cost", () => {
    const records = [
      makeSession({ cost_total_usd: 0.01 }),
      makeSession({ cost_total_usd: 0.03 }),
    ];
    const report = analyzeSessionRecords("test-agent", records, [], 7);
    expect(report.avg_cost_usd).toBeCloseTo(0.02, 4);
  });

  it("clusters failures by source and tool", () => {
    const records = [
      makeSession({
        status: "error",
        errors: [
          { source: "tool", message: "timeout", tool_name: "web-search", turn_number: 1, recoverable: true },
          { source: "tool", message: "timeout", tool_name: "web-search", turn_number: 2, recoverable: true },
        ],
      }),
      makeSession({
        status: "error",
        errors: [
          { source: "tool", message: "not found", tool_name: "web-search", turn_number: 1, recoverable: true },
        ],
      }),
      makeSession({
        status: "error",
        errors: [
          { source: "llm", message: "rate limit", turn_number: 1, recoverable: false },
        ],
      }),
    ];
    const report = analyzeSessionRecords("test-agent", records, [], 7);
    expect(report.failure_clusters.length).toBeGreaterThan(0);

    const webSearchCluster = report.failure_clusters.find((c) => c.pattern === "tool:web-search");
    expect(webSearchCluster).toBeDefined();
    expect(webSearchCluster!.count).toBe(3);

    const llmCluster = report.failure_clusters.find((c) => c.pattern === "llm");
    expect(llmCluster).toBeDefined();
    expect(llmCluster!.count).toBe(1);
  });

  it("detects cost anomalies (>3x average)", () => {
    const records = [
      makeSession({ cost_total_usd: 0.01 }),
      makeSession({ cost_total_usd: 0.01 }),
      makeSession({ cost_total_usd: 0.01 }),
      makeSession({ cost_total_usd: 0.10 }), // 10x average
    ];
    const report = analyzeSessionRecords("test-agent", records, [], 7);
    expect(report.cost_anomalies.length).toBe(1);
    expect(report.cost_anomalies[0].deviation_factor).toBeGreaterThan(3);
  });

  it("analyzes tool performance", () => {
    const records = [
      makeSession({
        tool_calls: [
          { tool_name: "web-search", success: true, latency_ms: 200, turn_number: 1 },
          { tool_name: "web-search", success: false, error: "timeout", latency_ms: 5000, turn_number: 2 },
          { tool_name: "bash", success: true, latency_ms: 100, turn_number: 3 },
        ],
      }),
    ];
    const report = analyzeSessionRecords("test-agent", records, ["web-search", "bash", "grep"], 7);

    const webSearch = report.tool_analysis.find((t) => t.tool_name === "web-search");
    expect(webSearch).toBeDefined();
    expect(webSearch!.call_count).toBe(2);
    expect(webSearch!.failure_rate).toBe(0.5);

    const bash = report.tool_analysis.find((t) => t.tool_name === "bash");
    expect(bash).toBeDefined();
    expect(bash!.failure_rate).toBe(0);
  });

  it("detects unused tools", () => {
    const records = [
      makeSession({
        tool_calls: [
          { tool_name: "web-search", success: true, latency_ms: 200, turn_number: 1 },
        ],
      }),
    ];
    const report = analyzeSessionRecords("test-agent", records, ["web-search", "bash", "grep", "glob"], 7);
    expect(report.unused_tools).toContain("bash");
    expect(report.unused_tools).toContain("grep");
    expect(report.unused_tools).toContain("glob");
    expect(report.unused_tools).not.toContain("web-search");
  });

  it("ranks error sources by frequency", () => {
    const records = [
      makeSession({
        status: "error",
        errors: [
          { source: "tool", message: "fail", tool_name: "bash", turn_number: 1, recoverable: true },
          { source: "tool", message: "fail", tool_name: "bash", turn_number: 2, recoverable: true },
          { source: "llm", message: "rate limit", turn_number: 3, recoverable: false },
        ],
      }),
    ];
    const report = analyzeSessionRecords("test-agent", records, [], 7);
    expect(report.top_error_sources[0].source).toBe("tool:bash");
    expect(report.top_error_sources[0].count).toBe(2);
  });

  it("generates recommendations for low success rate", () => {
    const records = Array.from({ length: 10 }, () =>
      makeSession({ status: "error", errors: [{ source: "llm", message: "fail", turn_number: 1, recoverable: false }] }),
    );
    const report = analyzeSessionRecords("test-agent", records, [], 7);
    expect(report.recommendations.some((r) => r.includes("success rate"))).toBe(true);
  });

  it("integrates quality scores from conversation intelligence", () => {
    const records = [
      makeSession({ quality_score: 0.4 }),
      makeSession({ quality_score: 0.6 }),
    ];
    const report = analyzeSessionRecords("test-agent", records, [], 7);
    expect(report.avg_quality_score).toBeCloseTo(0.5, 2);
  });
});

describe("generateProposals", () => {
  it("proposes removing unused tools when >= 3 unused", () => {
    const report = analyzeSessionRecords("test-agent", [
      makeSession({ tool_calls: [{ tool_name: "web-search", success: true, latency_ms: 100, turn_number: 1 }] }),
    ], ["web-search", "bash", "grep", "glob", "python-exec"], 7);

    const proposals = generateProposals(report, { tools: ["web-search", "bash", "grep", "glob", "python-exec"] });
    const unusedProposal = proposals.find((p) => p.title.includes("unused tools"));
    expect(unusedProposal).toBeDefined();
    expect(unusedProposal!.category).toBe("tools");
    expect((unusedProposal!.modification.tools as any).remove).toContain("bash");
  });

  it("proposes tool failure guidance for high-failure tools", () => {
    const records = Array.from({ length: 10 }, () =>
      makeSession({
        tool_calls: [
          { tool_name: "web-search", success: false, error: "timeout", latency_ms: 5000, turn_number: 1 },
          { tool_name: "web-search", success: false, error: "timeout", latency_ms: 5000, turn_number: 2 },
        ],
        errors: [
          { source: "tool", message: "timeout", tool_name: "web-search", turn_number: 1, recoverable: true },
        ],
      }),
    );
    const report = analyzeSessionRecords("test-agent", records, ["web-search"], 7);
    const proposals = generateProposals(report, { tools: ["web-search"] });
    const guidanceProposal = proposals.find((p) => p.title.includes("failure guidance"));
    expect(guidanceProposal).toBeDefined();
    expect(guidanceProposal!.category).toBe("prompt");
  });

  it("proposes prompt review when success rate < 50%", () => {
    const records = Array.from({ length: 12 }, (_, i) =>
      makeSession({ status: i < 4 ? "success" : "error" }),
    );
    const report = analyzeSessionRecords("test-agent", records, [], 7);
    const proposals = generateProposals(report, {});
    const promptProposal = proposals.find((p) => p.title.includes("system prompt"));
    expect(promptProposal).toBeDefined();
    expect(promptProposal!.priority).toBeGreaterThanOrEqual(0.9);
  });

  it("proposes cheaper model when success rate > 85%", () => {
    const records = Array.from({ length: 20 }, () =>
      makeSession({ status: "success", cost_total_usd: 0.10 }),
    );
    const report = analyzeSessionRecords("test-agent", records, [], 7);
    const proposals = generateProposals(report, {});
    const modelProposal = proposals.find((p) => p.title.includes("cheaper model"));
    expect(modelProposal).toBeDefined();
  });

  it("proposes code mode for agents with many tools", () => {
    const tools = Array.from({ length: 20 }, (_, i) => `tool-${i}`);
    const report = analyzeSessionRecords("test-agent", [makeSession()], tools, 7);
    const proposals = generateProposals(report, { tools, use_code_mode: false });
    const codeModeProposal = proposals.find((p) => p.title.includes("code mode"));
    expect(codeModeProposal).toBeDefined();
    expect(codeModeProposal!.modification.use_code_mode).toBe(true);
  });

  it("sorts proposals by priority descending", () => {
    const records = Array.from({ length: 15 }, (_, i) =>
      makeSession({
        status: i < 3 ? "success" : "error",
        cost_total_usd: i === 14 ? 1.0 : 0.005, // cost anomaly
        tool_calls: [
          { tool_name: "web-search", success: false, error: "fail", latency_ms: 100, turn_number: 1 },
        ],
        errors: [{ source: "tool", message: "fail", tool_name: "web-search", turn_number: 1, recoverable: true }],
      }),
    );
    const report = analyzeSessionRecords("test-agent", records, ["web-search", "a", "b", "c"], 7);
    const proposals = generateProposals(report, { tools: ["web-search", "a", "b", "c"] });
    for (let i = 1; i < proposals.length; i++) {
      expect(proposals[i].priority).toBeLessThanOrEqual(proposals[i - 1].priority);
    }
  });

  it("caps proposals at 10", () => {
    // Create conditions that trigger many proposals
    const records = Array.from({ length: 20 }, () =>
      makeSession({
        status: "error",
        cost_total_usd: 0.50,
        step_count: 30,
        tool_calls: Array.from({ length: 10 }, (_, i) => ({
          tool_name: `tool-${i}`,
          success: false,
          error: "fail",
          latency_ms: 100,
          turn_number: i,
        })),
        errors: Array.from({ length: 5 }, (_, i) => ({
          source: "tool" as const,
          message: "fail",
          tool_name: `tool-${i}`,
          turn_number: i,
          recoverable: true,
        })),
        quality_score: 0.3,
      }),
    );
    const tools = Array.from({ length: 25 }, (_, i) => `tool-${i}`);
    const report = analyzeSessionRecords("test-agent", records, tools, 7);
    const proposals = generateProposals(report, { tools, max_turns: 50 });
    expect(proposals.length).toBeLessThanOrEqual(10);
  });
});
