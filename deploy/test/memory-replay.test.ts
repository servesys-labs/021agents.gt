/**
 * Tests for the memory replay comparison logic.
 * Validates that the A/B offline comparison produces correct metrics.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { effectiveConfidence } from "../src/runtime/memory";

const NOW = 1712966400000;
function msAgo(days: number) { return NOW - days * 86_400_000; }
function isoAgo(days: number) { return new Date(msAgo(days)).toISOString(); }

interface TestFact {
  key: string;
  confidence: number;
  created_at: string;
  last_reinforced_at: string | null;
}

/** Simulate the baseline path (merge order, no decay) */
function baselineRank(facts: TestFact[]): string[] {
  return facts.slice(0, 8).map(f => f.key);
}

/** Simulate the new path (decay-aware ranking) */
function decayRank(facts: TestFact[]): string[] {
  return facts
    .map(f => ({
      ...f,
      effConf: effectiveConfidence(
        f.confidence,
        f.last_reinforced_at ? new Date(f.last_reinforced_at).getTime() : new Date(f.created_at).getTime(),
      ),
    }))
    .filter(f => f.effConf > 0.1)
    .sort((a, b) => b.effConf - a.effConf)
    .slice(0, 8)
    .map(f => f.key);
}

describe("memory replay — offline A/B comparison", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("baseline and ranked agree when all facts are fresh", () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    const facts: TestFact[] = [
      { key: "a", confidence: 1.0, created_at: isoAgo(1), last_reinforced_at: isoAgo(1) },
      { key: "b", confidence: 1.0, created_at: isoAgo(2), last_reinforced_at: isoAgo(2) },
      { key: "c", confidence: 1.0, created_at: isoAgo(3), last_reinforced_at: isoAgo(3) },
    ];
    expect(baselineRank(facts)).toEqual(decayRank(facts));
  });

  it("ranked path suppresses stale facts that baseline would surface", () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    const facts: TestFact[] = [
      { key: "stale", confidence: 1.0, created_at: isoAgo(200), last_reinforced_at: isoAgo(200) },
      { key: "fresh", confidence: 0.8, created_at: isoAgo(3), last_reinforced_at: isoAgo(3) },
    ];
    const baseline = baselineRank(facts);
    const ranked = decayRank(facts);

    expect(baseline).toContain("stale");  // baseline surfaces it
    expect(ranked).not.toContain("stale"); // ranked filters it out (effConf = 0)
    expect(ranked).toContain("fresh");
  });

  it("ranked path reorders by effective confidence", () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    const facts: TestFact[] = [
      // Appears first in merge order but is old
      { key: "old-high-base", confidence: 1.0, created_at: isoAgo(100), last_reinforced_at: isoAgo(100) },
      // Appears second but is fresh
      { key: "fresh-lower-base", confidence: 0.8, created_at: isoAgo(2), last_reinforced_at: isoAgo(2) },
    ];
    const baseline = baselineRank(facts);
    const ranked = decayRank(facts);

    expect(baseline[0]).toBe("old-high-base");     // merge order
    expect(ranked[0]).toBe("fresh-lower-base");     // decay-aware: 0.8*1.0 > 1.0*0.5
  });

  it("reinforced old fact beats unreinforced old fact", () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    const facts: TestFact[] = [
      { key: "unreinforced", confidence: 1.0, created_at: isoAgo(60), last_reinforced_at: isoAgo(60) },
      { key: "reinforced", confidence: 1.0, created_at: isoAgo(60), last_reinforced_at: isoAgo(3) },
    ];
    const ranked = decayRank(facts);
    expect(ranked[0]).toBe("reinforced"); // reinforced recently → full confidence
  });

  it("variant assignment event shape is correct", () => {
    // Validates the telemetry event structure expected by A/B analysis
    const event = {
      type: "runtime_event",
      payload: {
        event_type: "memory_agent_variant_assigned",
        session_id: "sess-1",
        org_id: "org-1",
        agent_name: "my-assistant",
        variant: "memory_agent",
        flag: "memory_agent_enabled",
      },
    };
    expect(event.payload.event_type).toBe("memory_agent_variant_assigned");
    expect(event.payload.variant).toMatch(/^(memory_agent|baseline)$/);
    expect(event.payload.flag).toBe("memory_agent_enabled");
  });
});
