import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

describe("auth middleware public-webhook contract", () => {
  it("keeps chat and stripe webhooks public for external callbacks", () => {
    const file = path.resolve(__dirname, "../src/middleware/auth.ts");
    const content = readFileSync(file, "utf8");
    expect(content).toContain('"/api/v1/chat/telegram/webhook"');
    expect(content).toContain('"/api/v1/stripe/webhook"');
  });
});
