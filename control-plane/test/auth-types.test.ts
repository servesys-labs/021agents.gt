/**
 * Auth types — scope and role checking tests.
 */
import { describe, it, expect } from "vitest";
import { hasScope, hasRole, ROLE_HIERARCHY } from "../src/auth/types";
import type { CurrentUser } from "../src/auth/types";

function makeUser(overrides: Partial<CurrentUser> = {}): CurrentUser {
  return {
    user_id: "u1",
    email: "u@test.com",
    name: "Test",
    org_id: "org-1",
    project_id: "",
    env: "",
    role: "member",
    scopes: ["*"],
    auth_method: "jwt",
    ...overrides,
  };
}

describe("hasScope", () => {
  it("wildcard grants everything", () => {
    const user = makeUser({ scopes: ["*"] });
    expect(hasScope(user, "agents:read")).toBe(true);
    expect(hasScope(user, "admin")).toBe(true);
    expect(hasScope(user, "anything:else")).toBe(true);
  });

  it("exact scope match", () => {
    const user = makeUser({ scopes: ["agents:read", "sessions:read"] });
    expect(hasScope(user, "agents:read")).toBe(true);
    expect(hasScope(user, "agents:write")).toBe(false);
    expect(hasScope(user, "sessions:read")).toBe(true);
  });

  it("category wildcard match", () => {
    const user = makeUser({ scopes: ["agents:*"] });
    expect(hasScope(user, "agents:read")).toBe(true);
    expect(hasScope(user, "agents:write")).toBe(true);
    expect(hasScope(user, "sessions:read")).toBe(false);
  });

  it("empty scopes denies everything", () => {
    const user = makeUser({ scopes: [] });
    expect(hasScope(user, "agents:read")).toBe(false);
  });
});

describe("hasRole", () => {
  it("owner outranks all", () => {
    const user = makeUser({ role: "owner" });
    expect(hasRole(user, "owner")).toBe(true);
    expect(hasRole(user, "admin")).toBe(true);
    expect(hasRole(user, "member")).toBe(true);
    expect(hasRole(user, "viewer")).toBe(true);
  });

  it("member cannot access admin", () => {
    const user = makeUser({ role: "member" });
    expect(hasRole(user, "member")).toBe(true);
    expect(hasRole(user, "viewer")).toBe(true);
    expect(hasRole(user, "admin")).toBe(false);
    expect(hasRole(user, "owner")).toBe(false);
  });

  it("viewer is lowest", () => {
    const user = makeUser({ role: "viewer" });
    expect(hasRole(user, "viewer")).toBe(true);
    expect(hasRole(user, "member")).toBe(false);
  });

  it("unknown role gets level 0", () => {
    const user = makeUser({ role: "unknown" });
    expect(hasRole(user, "viewer")).toBe(false);
  });
});

describe("ROLE_HIERARCHY", () => {
  it("has correct ordering", () => {
    expect(ROLE_HIERARCHY.owner).toBeGreaterThan(ROLE_HIERARCHY.admin);
    expect(ROLE_HIERARCHY.admin).toBeGreaterThan(ROLE_HIERARCHY.member);
    expect(ROLE_HIERARCHY.member).toBeGreaterThan(ROLE_HIERARCHY.viewer);
  });
});
