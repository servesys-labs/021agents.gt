/**
 * Phase 9.1 — integration test for the governance permission gate.
 *
 * Exercises the full executeTools → classifyPermission → block/allow
 * path at tools.ts:1193-1215. The unit tests in new-features.test.ts
 * verify classifyPermission and shouldAutoApprove in isolation; this
 * test proves the wiring: that executeTools actually calls the
 * classifier and blocks dangerous operations when
 * require_confirmation_for_destructive is enabled.
 */
import { describe, it, expect, vi } from "vitest";

// Stub getDb so dispatch doesn't crash on tools that need SQL
vi.mock("../src/runtime/db", () => ({
  getDb: async () => ((() => {}) as any),
}));

import { executeTools } from "../src/runtime/tools";

function buildEnv(agentConfig?: Record<string, unknown>): any {
  return {
    HYPERDRIVE: null,
    __agentConfig: agentConfig,
  };
}

function makeToolCall(name: string, args: Record<string, unknown> = {}) {
  return {
    id: `tc-${name}`,
    name,
    arguments: JSON.stringify(args),
  };
}

// ── Governance gate: destructive blocking ────────────────────────

describe("governance permission gate — executeTools integration", () => {
  it("blocks destructive bash when require_confirmation_for_destructive is true", async () => {
    const env = buildEnv({ require_confirmation_for_destructive: true });
    const results = await executeTools(
      env,
      [makeToolCall("bash", { command: "rm -rf /workspace" })],
      "test-session",
      false,
    );

    expect(results).toHaveLength(1);
    expect(results[0].error).toBe("governance:destructive_blocked");
    const parsed = JSON.parse(results[0].result);
    expect(parsed.blocked).toBe(true);
    expect(parsed.reason).toContain("destructive");
    expect(parsed.level).toBe("dangerous");
  });

  it("blocks DROP TABLE in bash args", async () => {
    const env = buildEnv({ require_confirmation_for_destructive: true });
    const results = await executeTools(
      env,
      [makeToolCall("bash", { command: 'psql -c "DROP TABLE users"' })],
      "test-session",
      false,
    );

    expect(results).toHaveLength(1);
    expect(results[0].error).toBe("governance:destructive_blocked");
  });

  it("blocks dangerous tools without safe patterns (delete-agent)", async () => {
    const env = buildEnv({ require_confirmation_for_destructive: true });
    const results = await executeTools(
      env,
      [makeToolCall("delete-agent", { agent_name: "victim" })],
      "test-session",
      false,
    );

    expect(results).toHaveLength(1);
    expect(results[0].error).toBe("governance:destructive_blocked");
  });

  it("allows safe bash patterns through the gate", async () => {
    const env = buildEnv({ require_confirmation_for_destructive: true });
    const results = await executeTools(
      env,
      [makeToolCall("bash", { command: "ls -la" })],
      "test-session",
      false,
    );

    // Safe bash passes the governance gate — may fail in dispatch
    // (no sandbox env), but the error should NOT be governance:destructive_blocked
    expect(results).toHaveLength(1);
    expect(results[0].error).not.toBe("governance:destructive_blocked");
  });

  it("does not block when require_confirmation_for_destructive is false/absent", async () => {
    const env = buildEnv({});
    const results = await executeTools(
      env,
      [makeToolCall("bash", { command: "rm -rf /workspace" })],
      "test-session",
      false,
    );

    // Without the governance flag, even destructive bash is not blocked
    // at the governance layer (may fail downstream for other reasons)
    expect(results).toHaveLength(1);
    expect(results[0].error).not.toBe("governance:destructive_blocked");
  });

  it("does not block safe read-only tools", async () => {
    const env = buildEnv({ require_confirmation_for_destructive: true });
    const results = await executeTools(
      env,
      [makeToolCall("grep", { pattern: "TODO", path: "/workspace" })],
      "test-session",
      false,
    );

    expect(results).toHaveLength(1);
    expect(results[0].error).not.toBe("governance:destructive_blocked");
  });

  it("blocks multiple dangerous tools in a single batch", async () => {
    const env = buildEnv({ require_confirmation_for_destructive: true });
    const results = await executeTools(
      env,
      [
        makeToolCall("bash", { command: "rm -rf /" }),
        makeToolCall("dynamic-exec", { code: "process.exit(1)" }),
      ],
      "test-session",
      false,
    );

    expect(results).toHaveLength(2);
    expect(results[0].error).toBe("governance:destructive_blocked");
    expect(results[1].error).toBe("governance:destructive_blocked");
  });
});
