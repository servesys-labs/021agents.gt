import { describe, expect, it } from "vitest";

import { summarizeCoverage, toMoney, toNumber } from "./adapters";

describe("adapters", () => {
  it("summarizes v1 and legacy coverage", () => {
    const summary = summarizeCoverage(["/api/v1/agents", "/api/v1/jobs", "/run"]);
    expect(summary.total).toBe(3);
    expect(summary.v1).toBe(2);
    expect(summary.legacy).toBe(1);
  });

  it("normalizes numeric values", () => {
    expect(toNumber(5.25)).toBe(5.25);
    expect(toNumber("bad")).toBe(0);
    expect(toMoney(1.23456)).toBe("$1.2346");
  });
});
