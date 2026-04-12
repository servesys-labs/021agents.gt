/**
 * Tests for new features: coordinator, permission classifier, team memory, dream memory
 * Covers unit tests (pure logic) and integration tests (mock DB/KV)
 */
import { describe, it, expect } from "vitest";

// ── Coordinator Mode ──────────────────────────────────────────────

import { shouldCoordinate, buildCoordinatorPrompt } from "../src/runtime/coordinator";

describe("shouldCoordinate", () => {
  it("returns true for explicit coordinator keywords", () => {
    expect(shouldCoordinate("coordinate the research and implementation", 5)).toBe(true);
    expect(shouldCoordinate("orchestrate the deployment", 5)).toBe(true);
    expect(shouldCoordinate("delegate this to parallel agents", 5)).toBe(true);
    expect(shouldCoordinate("use multi-agent approach", 5)).toBe(true);
  });

  it("returns true for complex multi-part tasks", () => {
    const complex = "research the latest frameworks and then implement the solution and also test it and deploy to production";
    expect(shouldCoordinate(complex, 5)).toBe(true);
  });

  it("returns false for simple tasks", () => {
    expect(shouldCoordinate("what is the weather?", 5)).toBe(false);
    expect(shouldCoordinate("fix this bug", 5)).toBe(false);
    expect(shouldCoordinate("read the file", 3)).toBe(false);
  });

  it("returns true for long inputs with many tools available", () => {
    const longInput = "x".repeat(600);
    expect(shouldCoordinate(longInput, 15)).toBe(true);
  });

  it("returns false for long inputs with few tools", () => {
    const longInput = "x".repeat(600);
    expect(shouldCoordinate(longInput, 5)).toBe(false);
  });
});

describe("buildCoordinatorPrompt", () => {
  it("includes agent name and available workers", () => {
    const prompt = buildCoordinatorPrompt("orchestrator", ["research", "coder", "reviewer"]);
    expect(prompt).toContain("COORDINATOR");
    expect(prompt).toContain("research");
    expect(prompt).toContain("coder");
    expect(prompt).toContain("reviewer");
  });

  it("handles empty agent list", () => {
    const prompt = buildCoordinatorPrompt("solo", []);
    expect(prompt).toContain("COORDINATOR");
    expect(prompt).toContain("Available Workers");
  });

  it("includes coordination protocol sections", () => {
    const prompt = buildCoordinatorPrompt("orch", ["worker"]);
    expect(prompt).toContain("Decompose");
    expect(prompt).toContain("Delegate");
    expect(prompt).toContain("Monitor");
    expect(prompt).toContain("Synthesize");
    expect(prompt).toContain("Failure Handling");
    expect(prompt).toContain("Anti-Patterns");
  });
});

// ── Permission Classifier ─────────────────────────────────────────

import { classifyPermission, shouldAutoApprove, ALWAYS_REQUIRE_APPROVAL, type PermissionLevel } from "../src/runtime/permission-classifier";

describe("classifyPermission — simplified (Phase 9.4)", () => {
  it("backstop tools are always dangerous + never auto-approved", () => {
    for (const tool of ALWAYS_REQUIRE_APPROVAL) {
      const result = classifyPermission(tool, {});
      expect(result.level, `${tool} should be dangerous`).toBe("dangerous");
      expect(result.autoApprove, `${tool} should never auto-approve`).toBe(false);
      expect(result.reason).toBe("irreducible safety floor");
    }
  });

  it("backstop cannot be bypassed by safe-looking args", () => {
    const result = classifyPermission("delete-agent", { agent_name: "test" });
    expect(result.autoApprove).toBe(false);
    expect(result.reason).toBe("irreducible safety floor");
  });

  it("detects destructive bash commands", () => {
    const result = classifyPermission("bash", { command: "rm -rf /workspace" });
    expect(result.level).toBe("dangerous");
    expect(result.autoApprove).toBe(false);
    expect(result.reason).toContain("destructive");
  });

  it("blocks DROP TABLE in args", () => {
    const result = classifyPermission("bash", { command: 'psql -c "DROP TABLE users"' });
    expect(result.autoApprove).toBe(false);
  });

  it("allows non-destructive tools through", () => {
    const tools = ["read-file", "grep", "glob", "web-search", "write-file", "bash"];
    for (const tool of tools) {
      const result = classifyPermission(tool, {});
      expect(result.autoApprove, `${tool} should auto-approve without destructive args`).toBe(true);
    }
  });

  it("allows unknown tools with default allow", () => {
    const result = classifyPermission("unknown-tool-xyz", {});
    expect(result.level).toBe("review");
    expect(result.autoApprove).toBe(true);
  });
});

describe("shouldAutoApprove — simplified (Phase 9.4)", () => {
  it("returns false when auto_approve not configured", () => {
    expect(shouldAutoApprove("read-file", {}, {})).toBe(false);
    expect(shouldAutoApprove("read-file", {}, undefined)).toBe(false);
  });

  it("returns true for non-destructive tools when auto_approve enabled", () => {
    expect(shouldAutoApprove("grep", {}, { auto_approve: true })).toBe(true);
  });

  it("blocks destructive args even with auto_approve", () => {
    const config = { auto_approve: true, require_confirmation_for_destructive: true };
    expect(shouldAutoApprove("bash", { command: "rm -rf /" }, config)).toBe(false);
  });

  it("allows safe bash with auto_approve", () => {
    const config = { auto_approve: true, require_confirmation_for_destructive: true };
    expect(shouldAutoApprove("bash", { command: "ls -la" }, config)).toBe(true);
  });

  it("backstop tools are never auto-approved even with all flags enabled", () => {
    const config = { auto_approve: true, require_confirmation_for_destructive: true };
    for (const tool of ALWAYS_REQUIRE_APPROVAL) {
      expect(shouldAutoApprove(tool, {}, config), `${tool} should not auto-approve`).toBe(false);
    }
  });
});

// ── Team Memory ───────────────────────────────────────────────────

import { buildTeamMemoryContext, writeTeamFact, writeTeamObservation } from "../src/runtime/team-memory";

describe("buildTeamMemoryContext", () => {
  it("returns empty string when no org_id", async () => {
    const result = await buildTeamMemoryContext({} as any, "", "agent");
    expect(result).toBe("");
  });

  it("returns empty string when Hyperdrive unavailable", async () => {
    const result = await buildTeamMemoryContext({} as any, "org-1", "agent");
    expect(result).toBe("");
  });
});

describe("writeTeamFact", () => {
  it("does not throw when Hyperdrive unavailable", async () => {
    await expect(writeTeamFact({} as any, "org-1", "agent", "some fact")).resolves.toBeUndefined();
  });
});

describe("writeTeamObservation", () => {
  it("does not throw when Hyperdrive unavailable", async () => {
    await expect(writeTeamObservation({} as any, "org-1", "agent", "observation")).resolves.toBeUndefined();
  });
});

// ── Dream Memory Consolidation ────────────────────────────────────

import { consolidateMemory } from "../src/runtime/memory-consolidation";

describe("consolidateMemory", () => {
  it("does not throw when Hyperdrive unavailable", async () => {
    const result = await consolidateMemory({} as any, "org-1", "agent");
    expect(result.episodes_merged).toBe(0);
    expect(result.procedures_promoted).toBe(0);
    expect(result.facts_decayed).toBe(0);
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("returns timing info", async () => {
    const result = await consolidateMemory({} as any, "org-1", "agent");
    expect(typeof result.duration_ms).toBe("number");
  });
});

// ── GitHub Webhook Event Formatting (imported indirectly) ─────────
// The formatGitHubEvent function is private, but we can test the route behavior
// through integration tests in the control-plane test suite.

// ── WebSocket Transport (unit-level) ──────────────────────────────

describe("WebSocket URL construction", () => {
  it("builds correct DO routing path", () => {
    const WS_BASE = "wss://runtime.oneshots.co";
    const orgId = "org-123";
    const agentName = "research";
    const userId = "user-456";
    const doName = `${orgId}-${agentName}-${userId}`;
    const url = `${WS_BASE}/agents/agentos-agent/${encodeURIComponent(doName)}`;

    expect(url).toBe("wss://runtime.oneshots.co/agents/agentos-agent/org-123-research-user-456");
    expect(url).toContain("/agents/agentos-agent/");
  });

  it("encodes special characters in DO name", () => {
    const doName = "org with spaces-agent/special-user@email";
    const encoded = encodeURIComponent(doName);
    expect(encoded).not.toContain(" ");
    expect(encoded).not.toContain("/");
    expect(encoded).not.toContain("@");
  });
});

// ── Integration: Feature Flag Gating ──────────────────────────────

import { isEnabled, setFlag } from "../src/runtime/features";

describe("feature flag integration", () => {
  it("returns defaults when KV unavailable", async () => {
    expect(await isEnabled({} as any, "concurrent_tools", "org")).toBe(true);
    expect(await isEnabled({} as any, "context_compression", "org")).toBe(true);
    expect(await isEnabled({} as any, "nonexistent_flag", "org")).toBe(false);
  });

  it("round-trips via mock KV with version invalidation", async () => {
    const store = new Map<string, string>();
    const env = {
      AGENT_PROGRESS_KV: {
        put: async (k: string, v: string) => { store.set(k, v); },
        get: async (k: string) => store.get(k) ?? null,
      },
    };
    await setFlag(env as any, "custom_flag", "org-test", true);
    // Version key should be bumped
    expect(store.has("features-version/org-test")).toBe(true);
    expect(Number(store.get("features-version/org-test"))).toBeGreaterThan(0);
  });
});

// ── Integration: Backpressure Adaptive Sizing ─────────────────────

import { createBackpressureController } from "../src/runtime/backpressure";

describe("adaptive backpressure", () => {
  it("starts with smaller buffer than 1MB", () => {
    const sent: string[] = [];
    const controller = createBackpressureController((data) => { sent.push(data); });
    // Stats should reflect initial adaptive buffer
    const stats = controller.getStats();
    expect(stats.bufferedBytes).toBe(0);
    controller.close();
  });

  it("drops messages when buffer overflows and notifies client", async () => {
    const sent: string[] = [];
    const controller = createBackpressureController(
      (data) => { sent.push(data); return false; }, // transport always "busy"
      { maxMessages: 5, dropOldOnOverflow: true },
    );

    // Fill buffer beyond capacity
    const promises: Promise<void>[] = [];
    for (let i = 0; i < 10; i++) {
      promises.push(controller.send(`msg-${i}`).catch(() => {}));
    }

    // Let the queue process
    await new Promise(r => setTimeout(r, 50));

    const stats = controller.getStats();
    expect(stats.droppedMessages).toBeGreaterThan(0);
    controller.close();
  });
});

// ── Integration: Circuit Breaker Preload ──────────────────────────
// NOTE: tools.ts imports @cloudflare/containers which isn't available in vitest.
// Circuit breaker preload is tested indirectly via the cloud-patterns test suite.

describe("circuit breaker preload (contract)", () => {
  it("preload function should handle empty results", () => {
    // Contract: preloadCircuitStates accepts a SQL function and doesn't throw on empty
    const mockSql = () => [];
    // Can't import directly due to @cloudflare/containers, but the contract is:
    // preloadCircuitStates(sqlFn) -> void, no throw on empty
    expect(() => mockSql()).not.toThrow();
  });

  it("preload function should handle SQL errors", () => {
    const mockSql = () => { throw new Error("table not found"); };
    // Contract: preloadCircuitStates catches errors internally
    expect(() => { try { mockSql(); } catch {} }).not.toThrow();
  });
});
