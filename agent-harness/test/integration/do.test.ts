/**
 * DO Integration Tests — tests real Durable Object lifecycle.
 *
 * Requires @cloudflare/vitest-pool-workers to run.
 * Tests signal recording, skill overlays, budget persistence,
 * and DO SQLite state management.
 *
 * Each test gets an isolated DO instance via getAgentByName()
 * with a unique name — no state leakage between tests.
 *
 * Run: npx vitest run --config test/integration/vitest.config.ts
 */

import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";

// ═══════════════════════════════════════════════════════════════════
// Signal Pipeline — recording, clustering, threshold detection
// ═══════════════════════════════════════════════════════════════════

describe("Signal Pipeline", () => {
  async function freshSignalAgent(name: string) {
    return getAgentByName(env.TestSignalAgent, name);
  }

  it("records a signal and creates a cluster", async () => {
    const agent = await freshSignalAgent("signal-record-1");
    await agent.recordTestSignal("tool_failure", "web-search", 2);

    const signals = await agent.getSignals();
    expect(signals).toHaveLength(1);
    expect(signals[0].signal_type).toBe("tool_failure");
    expect(signals[0].topic).toBe("web-search");

    const clusters = await agent.getClusters();
    expect(clusters).toHaveLength(1);
    expect(clusters[0].count).toBe(1);
  });

  it("increments cluster count on repeated signals", async () => {
    const agent = await freshSignalAgent("signal-cluster-1");
    await agent.recordTestSignal("tool_failure", "bash", 2);
    await agent.recordTestSignal("tool_failure", "bash", 2);
    await agent.recordTestSignal("tool_failure", "bash", 2);

    const count = await agent.getClusterCount("tool_failure", "bash");
    expect(count).toBe(3);
  });

  it("tracks separate clusters per signal type", async () => {
    const agent = await freshSignalAgent("signal-separate-1");
    await agent.recordTestSignal("tool_failure", "bash", 2);
    await agent.recordTestSignal("loop_detected", "bash", 3);

    const clusters = await agent.getClusters();
    expect(clusters).toHaveLength(2);
  });

  it("tracks separate clusters per topic", async () => {
    const agent = await freshSignalAgent("signal-topics-1");
    await agent.recordTestSignal("tool_failure", "bash", 2);
    await agent.recordTestSignal("tool_failure", "web-search", 2);

    const clusters = await agent.getClusters();
    expect(clusters).toHaveLength(2);
    expect(clusters[0].count).toBe(1);
    expect(clusters[1].count).toBe(1);
  });

  it("persists signals across method calls (same DO instance)", async () => {
    const agent = await freshSignalAgent("signal-persist-1");
    await agent.recordTestSignal("user_correction", "pricing", 2);

    // Second call — still same DO instance
    const signals = await agent.getSignals();
    expect(signals).toHaveLength(1);

    await agent.recordTestSignal("user_correction", "pricing", 2);
    const after = await agent.getSignals();
    expect(after).toHaveLength(2);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Skill Overlays — append, revert, audit trail
// ═══════════════════════════════════════════════════════════════════

describe("Skill Overlays", () => {
  async function freshSkillAgent(name: string) {
    return getAgentByName(env.TestSkillAgent, name);
  }

  it("appends an overlay and records audit", async () => {
    const agent = await freshSkillAgent("skill-append-1");
    const id = await agent.appendOverlay("debug", "Always check logs first");

    expect(id).toBeGreaterThan(0);

    const overlays = await agent.getOverlays("debug");
    expect(overlays).toHaveLength(1);
    expect(overlays[0].rule_text).toBe("Always check logs first");
    expect(overlays[0].source).toBe("human");

    const audit = await agent.getAuditLog("debug");
    expect(audit).toHaveLength(1);
    expect(audit[0].action).toBe("append");
  });

  it("appends multiple overlays in order", async () => {
    const agent = await freshSkillAgent("skill-multi-1");
    await agent.appendOverlay("research", "Use primary sources");
    await agent.appendOverlay("research", "Cross-reference claims");
    await agent.appendOverlay("research", "Include confidence levels");

    const overlays = await agent.getOverlays("research");
    expect(overlays).toHaveLength(3);
    expect(overlays[0].rule_text).toBe("Use primary sources");
    expect(overlays[2].rule_text).toBe("Include confidence levels");
  });

  it("reverts the last overlay", async () => {
    const agent = await freshSkillAgent("skill-revert-1");
    await agent.appendOverlay("debug", "Rule 1");
    await agent.appendOverlay("debug", "Rule 2");

    const reverted = await agent.revertLastOverlay("debug");
    expect(reverted).toBe(true);

    const overlays = await agent.getOverlays("debug");
    expect(overlays).toHaveLength(1);
    expect(overlays[0].rule_text).toBe("Rule 1");

    // Audit should show append, append, revert
    const audit = await agent.getAuditLog("debug");
    expect(audit).toHaveLength(3);
    expect(audit[2].action).toBe("revert");
  });

  it("returns false when reverting with no overlays", async () => {
    const agent = await freshSkillAgent("skill-revert-empty-1");
    const reverted = await agent.revertLastOverlay("debug");
    expect(reverted).toBe(false);
  });

  it("distinguishes human and auto source", async () => {
    const agent = await freshSkillAgent("skill-source-1");
    await agent.appendOverlay("debug", "Human rule", "human");
    await agent.appendOverlay("debug", "Auto rule", "auto");

    const overlays = await agent.getOverlays("debug");
    expect(overlays[0].source).toBe("human");
    expect(overlays[1].source).toBe("auto");
  });

  it("keeps overlays separate per skill", async () => {
    const agent = await freshSkillAgent("skill-separate-1");
    await agent.appendOverlay("debug", "Debug rule");
    await agent.appendOverlay("research", "Research rule");

    expect(await agent.getOverlays("debug")).toHaveLength(1);
    expect(await agent.getOverlays("research")).toHaveLength(1);
    expect(await agent.getOverlays("planning")).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Budget Persistence — cost tracking survives "hibernation"
// ═══════════════════════════════════════════════════════════════════

describe("Budget Persistence", () => {
  async function freshBudgetAgent(name: string) {
    return getAgentByName(env.TestBudgetAgent, name);
  }

  it("starts with zero cost", async () => {
    const agent = await freshBudgetAgent("budget-zero-1");
    expect(await agent.getCost()).toBe(0);
  });

  it("accumulates cost", async () => {
    const agent = await freshBudgetAgent("budget-accum-1");
    await agent.addCost(0.05);
    await agent.addCost(0.03);
    expect(await agent.getCost()).toBeCloseTo(0.08);
  });

  it("persists cost in DO SQLite (survives method boundaries)", async () => {
    const agent = await freshBudgetAgent("budget-persist-1");
    await agent.addCost(1.50);

    // Access the same DO instance — cost should still be there
    const cost = await agent.getCost();
    expect(cost).toBeCloseTo(1.50);
  });

  it("resets cost", async () => {
    const agent = await freshBudgetAgent("budget-reset-1");
    await agent.addCost(5.00);
    expect(await agent.getCost()).toBeCloseTo(5.00);

    await agent.resetCost();
    expect(await agent.getCost()).toBe(0);
  });

  it("handles many small increments", async () => {
    const agent = await freshBudgetAgent("budget-many-1");
    for (let i = 0; i < 100; i++) {
      await agent.addCost(0.001);
    }
    expect(await agent.getCost()).toBeCloseTo(0.1, 2);
  });
});

// ═══════════════════════════════════════════════════════════════════
// DO SQLite — table creation and basic operations
// ═══════════════════════════════════════════════════════════════════

describe("DO SQLite Basics", () => {
  async function freshAgent(name: string) {
    return getAgentByName(env.TestChatAgent, name);
  }

  it("creates SQLite tables on first use", async () => {
    const agent = await freshAgent("sqlite-tables-1");
    const tables = await agent.getSqlTableList();
    // SDK auto-creates cf_agents_* tables
    expect(tables.some((t: string) => t.startsWith("cf_"))).toBe(true);
  });

  it("tracks beforeTurn call count", async () => {
    const agent = await freshAgent("sqlite-turns-1");
    await agent.testChat("Hello");
    const count = await agent.getBeforeTurnCount();
    expect(count).toBeGreaterThanOrEqual(1);
  });
});
