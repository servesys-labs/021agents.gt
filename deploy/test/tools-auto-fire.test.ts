/**
 * Phase 6.5.3 — integration test for evolve-agent auto-fire wiring.
 *
 * Proves tools.ts's evolve-agent case:
 *   1. Calls detectEvolveFeedback with the analyzer report + agent name
 *   2. Awaits fireSkillFeedback when proposals are produced
 *   3. Returns the analyzer JSON unchanged (proposals are a side-effect)
 *   4. Fail-open: a throw from the detector does not break the response
 *
 * The detector and fire helper are mocked at module load so the test
 * exercises the tools.ts wiring without re-testing the pure-function
 * logic (that's skill-feedback.test.ts) or the round-trip through the
 * control-plane route (that's routes-skills-admin.test.ts).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Spies installed BEFORE the tools.ts import so the dynamic import()
// inside the evolve-agent case resolves to these stubs.
const detectSpy = vi.fn();
const fireSpy = vi.fn();

vi.mock("../src/runtime/skill-feedback", () => ({
  detectEvolveFeedback: (...args: unknown[]) => detectSpy(...args),
  fireSkillFeedback: (...args: unknown[]) => fireSpy(...args),
}));

// Stub getDb so evolve-agent's unconditional sql acquisition succeeds.
// The CONTROL_PLANE.fetch branch takes precedence over the fallback so
// this sql is never actually queried on the happy path.
vi.mock("../src/runtime/db", () => ({
  getDb: async () => ((() => {}) as any),
}));

import { executeTools } from "../src/runtime/tools";

function buildEnv(options: {
  analyzeResponse?: unknown;
  analyzeStatus?: number;
}): any {
  const analyzeBody = options.analyzeResponse ?? {
    sessions_analyzed: 42,
    report: {
      success_rate: 0.7,
      avg_cost_usd: 0.12,
      failure_clusters: [
        { pattern: "tool:web-search", count: 5, severity: 0.8, example_errors: [], affected_sessions: [] },
        { pattern: "llm:rate_limit", count: 3, severity: 0.4, example_errors: [], affected_sessions: [] },
      ],
    },
    proposals: [],
  };
  return {
    HYPERDRIVE: {},
    SERVICE_TOKEN: "test-service-token",
    CONTROL_PLANE: {
      fetch: async (url: string) => {
        if (url.includes("/evolve/") && url.includes("/analyze")) {
          return new Response(JSON.stringify(analyzeBody), {
            status: options.analyzeStatus ?? 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        // Any other internal fetch (e.g., /append-rule from fireSpy) is
        // transparently not hit because fireSkillFeedback is mocked.
        return new Response(null, { status: 404 });
      },
    },
  };
}

function makeToolCall(args: Record<string, unknown>) {
  return {
    id: "tc-1",
    name: "evolve-agent",
    arguments: JSON.stringify(args),
  };
}

beforeEach(() => {
  detectSpy.mockReset();
  fireSpy.mockReset();
  // Default: detector returns 2 proposals matching the default analyze report
  detectSpy.mockReturnValue([
    { skillName: "improve", ruleText: "rule A", source: "auto-fire:evolve", reason: "failure_cluster pattern=tool:web-search count=5 severity=0.8 agent=foo-bot" },
    { skillName: "improve", ruleText: "rule B", source: "auto-fire:evolve", reason: "failure_cluster pattern=llm:rate_limit count=3 severity=0.4 agent=foo-bot" },
  ]);
  fireSpy.mockResolvedValue(undefined);
});

describe("evolve-agent auto-fire wiring — happy path", () => {
  it("invokes detectEvolveFeedback with the analyzer report and agentName", async () => {
    const env = buildEnv({});
    await executeTools(
      env,
      [makeToolCall({ agent_name: "foo-bot", org_id: "org-x", days: 7 })],
      "session-1",
      false,
    );
    expect(detectSpy).toHaveBeenCalledTimes(1);
    const [reportArg, agentArg] = detectSpy.mock.calls[0];
    // The report arg is the parsed analyzer JSON's .report field.
    expect((reportArg as any)?.failure_clusters).toHaveLength(2);
    expect(agentArg).toBe("foo-bot");
  });

  it("awaits fireSkillFeedback with env, ctx, and detector proposals", async () => {
    const env = buildEnv({});
    await executeTools(
      env,
      [makeToolCall({ agent_name: "foo-bot", org_id: "org-x" })],
      "session-1",
      false,
    );
    expect(fireSpy).toHaveBeenCalledTimes(1);
    const [envArg, ctxArg, proposalsArg] = fireSpy.mock.calls[0];
    expect(envArg).toBe(env);
    expect((ctxArg as any).orgId).toBe("org-x");
    expect((proposalsArg as any)).toHaveLength(2);
    expect((proposalsArg as any)[0].skillName).toBe("improve");
  });

  it("skips fireSkillFeedback when detector returns no proposals", async () => {
    detectSpy.mockReturnValue([]);
    const env = buildEnv({});
    await executeTools(
      env,
      [makeToolCall({ agent_name: "foo-bot", org_id: "org-x" })],
      "session-1",
      false,
    );
    expect(detectSpy).toHaveBeenCalledTimes(1);
    expect(fireSpy).not.toHaveBeenCalled();
  });

  it("returns the analyzer response JSON unchanged (auto-fire is a side effect)", async () => {
    const env = buildEnv({});
    const results = await executeTools(
      env,
      [makeToolCall({ agent_name: "foo-bot", org_id: "org-x" })],
      "session-1",
      false,
    );
    expect(results).toHaveLength(1);
    const parsed = JSON.parse(results[0].result);
    expect(parsed.agent_name).toBe("foo-bot");
    expect(parsed.sessions_analyzed).toBe(42);
    expect(parsed.message).toContain("Analysis complete");
  });
});

describe("evolve-agent auto-fire wiring — fail-open", () => {
  it("returns the analyzer response unchanged when detectEvolveFeedback throws", async () => {
    detectSpy.mockImplementation(() => {
      throw new Error("detector blew up");
    });
    const env = buildEnv({});
    const results = await executeTools(
      env,
      [makeToolCall({ agent_name: "foo-bot", org_id: "org-x" })],
      "session-1",
      false,
    );
    // Analyzer response still returns — the whole point of fail-open.
    expect(results).toHaveLength(1);
    const parsed = JSON.parse(results[0].result);
    expect(parsed.agent_name).toBe("foo-bot");
    expect(parsed.sessions_analyzed).toBe(42);
    // fireSkillFeedback must not be called if the detector threw.
    expect(fireSpy).not.toHaveBeenCalled();
  });

  it("returns the analyzer response unchanged when fireSkillFeedback throws", async () => {
    fireSpy.mockRejectedValue(new Error("append-rule unreachable"));
    const env = buildEnv({});
    const results = await executeTools(
      env,
      [makeToolCall({ agent_name: "foo-bot", org_id: "org-x" })],
      "session-1",
      false,
    );
    // Response shape is preserved even though the background fire threw.
    expect(results).toHaveLength(1);
    const parsed = JSON.parse(results[0].result);
    expect(parsed.agent_name).toBe("foo-bot");
  });
});
