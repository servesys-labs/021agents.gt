import { describe, it, expect } from "vitest";
import { configHash, configHashAsync } from "../src/logic/compliance-checker";

describe("compliance-checker config hash parity", () => {
  it("is stable across object key ordering", async () => {
    const a = {
      model: "x",
      governance: { budget_limit_usd: 5, blocked_tools: ["a", "b"] },
      tools: ["t1", "t2"],
    };
    const b = {
      tools: ["t1", "t2"],
      governance: { blocked_tools: ["a", "b"], budget_limit_usd: 5 },
      model: "x",
    };
    expect(configHash(a)).toBe(configHash(b));
    expect(await configHashAsync(a)).toBe(await configHashAsync(b));
  });

  it("sync and async helpers match first 16 sha256 chars", async () => {
    const config = { name: "agent", max_turns: 20, nested: { x: 1, y: 2 } };
    expect(configHash(config)).toMatch(/^[0-9a-f]{16}$/);
    expect(configHash(config)).toBe(await configHashAsync(config));
  });
});
