/**
 * AIVSS scoring formula tests.
 */
import { describe, it, expect } from "vitest";
import { calculateAivss, defaultVector } from "../src/logic/aivss";

describe("AIVSS Scoring", () => {
  it("computes a score between 0 and 10", () => {
    const score = calculateAivss(defaultVector({
      confidentiality_impact: "high",
      integrity_impact: "high",
      availability_impact: "high",
      scope: "changed",
    }));
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(10);
  });

  it("returns 0 for no impact", () => {
    const score = calculateAivss(defaultVector({
      attack_vector: "physical",
      attack_complexity: "high",
      privileges_required: "high",
    }));
    // All impacts default to "none" → impact = 0
    expect(score).toBe(0);
  });

  it("high severity for max impact", () => {
    const score = calculateAivss(defaultVector({
      attack_vector: "network",
      attack_complexity: "low",
      privileges_required: "none",
      scope: "changed",
      confidentiality_impact: "high",
      integrity_impact: "high",
      availability_impact: "high",
    }));
    expect(score).toBeGreaterThan(4); // Max impact with high exploitability
  });
});
