/**
 * Compliance checker / drift detection tests.
 */
import { describe, it, expect } from "vitest";
import { detectDrift } from "../src/logic/compliance-checker";

describe("detectDrift", () => {
  it("returns no drifts for identical configs", () => {
    const gold = { model: "gpt-4", max_turns: 10, tools: ["search"] };
    const agent = { model: "gpt-4", max_turns: 10, tools: ["search"] };
    const report = detectDrift(gold, agent);
    expect(report.drifted_fields).toHaveLength(0);
    expect(report.status).toBe("compliant");
  });

  it("detects changed field value", () => {
    const gold = { model: "gpt-4" };
    const agent = { model: "gpt-3.5" };
    const report = detectDrift(gold, agent);
    expect(report.drifted_fields.length).toBeGreaterThan(0);
    expect(report.drifted_fields[0].field).toBe("model");
    expect(report.status).not.toBe("compliant");
  });

  it("detects missing field in agent", () => {
    const gold = { model: "gpt-4", max_turns: 10 };
    const agent = { model: "gpt-4" };
    const report = detectDrift(gold, agent);
    expect(report.drifted_fields.some((d) => d.field === "max_turns")).toBe(true);
  });

  it("detects governance drift as critical", () => {
    const gold = { governance: { budget_limit_usd: 10 } };
    const agent = { governance: { budget_limit_usd: 100 } };
    const report = detectDrift(gold, agent);
    expect(report.drifted_fields.length).toBeGreaterThan(0);
    // Governance fields are critical
    expect(report.status).toBe("critical");
  });
});
