import { describe, it, expect } from "vitest";
import { getAllProbes, runConfigProbes } from "../src/logic/security-scanner";

describe("security-scanner LLM03 coverage", () => {
  it("includes LLM03 training data poisoning probe", () => {
    const ids = getAllProbes().map((p) => p.id);
    expect(ids).toContain("LLM03-01");
  });

  it("fails when trusted-source policy is missing", () => {
    const result = runConfigProbes({ governance: {} }).find((p) => p.probe_id === "LLM03-01");
    expect(result).toBeTruthy();
    expect(result?.passed).toBe(false);
  });

  it("passes when trusted sources are configured", () => {
    const result = runConfigProbes({
      rag: { trusted_sources: ["docs.internal.example"] },
      governance: {},
    }).find((p) => p.probe_id === "LLM03-01");
    expect(result).toBeTruthy();
    expect(result?.passed).toBe(true);
  });
});
