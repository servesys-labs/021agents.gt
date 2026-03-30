import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

describe("rate-limit parity contract", () => {
  it("keeps Python-compatible JWT prefix slice and well-known bypass", () => {
    const file = path.resolve(__dirname, "../src/middleware/rate-limit.ts");
    const content = readFileSync(file, "utf8");
    expect(content).toContain("auth.slice(7, 20)");
    expect(content).toContain('"/.well-known/agent.json"');
  });
});
