/**
 * API key generation and hashing tests.
 */
import { describe, it, expect } from "vitest";
import { generateApiKey, hashApiKey } from "../src/auth/api-keys";

describe("API Key Generation", () => {
  it("generates keys with ak_ prefix", () => {
    const { key, prefix } = generateApiKey();
    expect(key.startsWith("ak_")).toBe(true);
    expect(prefix).toBe(key.slice(0, 11));
  });

  it("generates unique keys", () => {
    const k1 = generateApiKey();
    const k2 = generateApiKey();
    expect(k1.key).not.toBe(k2.key);
  });
});

describe("API Key Hashing", () => {
  it("produces consistent SHA-256 hex hash", async () => {
    const h1 = await hashApiKey("ak_test12345");
    const h2 = await hashApiKey("ak_test12345");
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/); // 64-char hex
  });

  it("different keys produce different hashes", async () => {
    const h1 = await hashApiKey("ak_aaaaaaaaa");
    const h2 = await hashApiKey("ak_bbbbbbbbb");
    expect(h1).not.toBe(h2);
  });
});
