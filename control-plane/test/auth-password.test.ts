/**
 * PBKDF2 password hashing tests.
 */
import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword } from "../src/auth/password";

describe("PBKDF2 Password Hashing", () => {
  it("hashes and verifies a password", async () => {
    const hash = await hashPassword("correct-horse-battery-staple");
    expect(hash).toContain(":"); // salt:hash format
    expect(await verifyPassword("correct-horse-battery-staple", hash)).toBe(true);
  });

  it("rejects wrong password", async () => {
    const hash = await hashPassword("correct-password");
    expect(await verifyPassword("wrong-password", hash)).toBe(false);
  });

  it("produces different hashes for same password (unique salt)", async () => {
    const h1 = await hashPassword("same-password");
    const h2 = await hashPassword("same-password");
    expect(h1).not.toBe(h2); // Different salts
    // But both verify
    expect(await verifyPassword("same-password", h1)).toBe(true);
    expect(await verifyPassword("same-password", h2)).toBe(true);
  });

  it("rejects malformed stored hash", async () => {
    expect(await verifyPassword("any", "no-colon-here")).toBe(false);
    expect(await verifyPassword("any", "")).toBe(false);
  });
});
