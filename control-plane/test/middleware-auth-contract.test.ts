import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

describe("auth middleware public-webhook contract", () => {
  // After the April 2026 auth middleware refactor, the public-route list
  // lives in middleware/auth/public-routes.ts instead of inlined inside
  // middleware/auth.ts. The contract stays the same: external webhook
  // callbacks (Telegram, Stripe) must stay in the public list.
  it("keeps chat and stripe webhooks public for external callbacks", () => {
    const file = path.resolve(__dirname, "../src/middleware/auth/public-routes.ts");
    const content = readFileSync(file, "utf8");
    expect(content).toContain('"/api/v1/chat/telegram/webhook"');
    expect(content).toContain('"/api/v1/stripe/webhook"');
  });
});
