/**
 * JWT sign/verify tests — ensures tokens created in TS are compatible
 * with the Python backend (same HS256 algorithm, same secret).
 */
import { describe, it, expect } from "vitest";
import { createToken, verifyToken } from "../src/auth/jwt";

const SECRET = "shared-test-secret-1234";

describe("JWT HS256", () => {
  it("creates and verifies a token round-trip", async () => {
    const token = await createToken(SECRET, "user-1", {
      email: "u@test.com",
      name: "Test User",
      org_id: "org-1",
    });

    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

    const claims = await verifyToken(SECRET, token);
    expect(claims).not.toBeNull();
    expect(claims!.sub).toBe("user-1");
    expect(claims!.email).toBe("u@test.com");
    expect(claims!.name).toBe("Test User");
    expect(claims!.org_id).toBe("org-1");
    expect(claims!.iat).toBeGreaterThan(0);
    expect(claims!.exp).toBeGreaterThan(claims!.iat);
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await createToken("secret-a", "user-1");
    const claims = await verifyToken("secret-b", token);
    expect(claims).toBeNull();
  });

  it("rejects an expired token", async () => {
    const token = await createToken(SECRET, "user-1", { expiry_seconds: -1 });
    const claims = await verifyToken(SECRET, token);
    expect(claims).toBeNull();
  });

  it("rejects a malformed token", async () => {
    expect(await verifyToken(SECRET, "not.a.jwt")).toBeNull();
    expect(await verifyToken(SECRET, "only-one-part")).toBeNull();
    expect(await verifyToken(SECRET, "")).toBeNull();
  });

  it("preserves extra claims", async () => {
    const token = await createToken(SECRET, "user-1", {
      extra: { role: "admin", org_id: "org-x" },
    });
    const claims = await verifyToken(SECRET, token);
    expect(claims!.role).toBe("admin");
    expect(claims!.org_id).toBe("org-x");
  });

  it("defaults expiry to 7 days", async () => {
    const token = await createToken(SECRET, "user-1");
    const claims = await verifyToken(SECRET, token);
    const expectedExpiry = 7 * 24 * 60 * 60;
    expect(claims!.exp - claims!.iat).toBe(expectedExpiry);
  });
});
