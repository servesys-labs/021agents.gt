import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import type { Env } from "../src/env";
import type { CurrentUser } from "../src/auth/types";
import { authRoutes } from "../src/routes/auth";
import { createToken } from "../src/auth/jwt";
import { mockEnv } from "./helpers/test-env";

type AppType = { Bindings: Env; Variables: { user: CurrentUser } };

function makeUser(): CurrentUser {
  return {
    user_id: "u-1",
    email: "u@test.com",
    name: "User",
    org_id: "org-1",
    project_id: "",
    env: "",
    role: "admin",
    scopes: ["*"],
    auth_method: "jwt",
  };
}

function buildApp() {
  const app = new Hono<AppType>();
  app.use("*", async (c, next) => {
    c.set("user", makeUser());
    await next();
  });
  app.route("/", authRoutes);
  return app;
}

describe("auth routes: password disable guards", () => {
  it("requires invite code when OPEN_SIGNUPS=false", async () => {
    const app = buildApp();
    const env = mockEnv({
      AUTH_ALLOW_PASSWORD: "true",
      OPEN_SIGNUPS: "false",
    });
    const res = await app.request("/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "invite-required@test.com",
        password: "password123",
        name: "Invite Required",
      }),
    }, env);
    expect(res.status).toBe(403);
    const payload = await res.json() as { code?: string; error?: string };
    expect(payload.code).toBe("invite_required");
    expect(payload.error || "").toMatch(/invite/i);
  });

  it("blocks signup when AUTH_ALLOW_PASSWORD=false", async () => {
    const app = buildApp();
    const env = mockEnv({ AUTH_ALLOW_PASSWORD: "false" });
    const res = await app.request("/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "new@test.com",
        password: "password123",
        name: "New User",
      }),
    }, env);
    expect(res.status).toBe(403);
    const payload = await res.json() as { error?: string };
    expect(payload.error || "").toMatch(/disabled/i);
  });

  it("reports providers with password disabled", async () => {
    const app = buildApp();
    const env = mockEnv({ AUTH_ALLOW_PASSWORD: "false" });
    const res = await app.request("/providers", { method: "GET" }, env);
    expect(res.status).toBe(200);
    const payload = await res.json() as { password_enabled?: boolean; active_provider?: string };
    expect(payload.password_enabled).toBe(false);
    expect(typeof payload.active_provider).toBe("string");
  });

  it("requires Authorization for protected auth endpoints", async () => {
    const app = buildApp();
    const env = mockEnv({ AUTH_JWT_SECRET: "test-secret" });

    const me = await app.request("/me", { method: "GET" }, env);
    expect(me.status).toBe(401);

    const logout = await app.request("/logout", { method: "POST" }, env);
    expect(logout.status).toBe(401);

    const password = await app.request(
      "/password",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ current_password: "x", new_password: "new-password-123" }),
      },
      env,
    );
    expect(password.status).toBe(401);
  });

  it("returns /me contract for valid JWT", async () => {
    const app = buildApp();
    const secret = "test-secret";
    const token = await createToken(secret, "user-1", {
      email: "user@test.com",
      name: "Test User",
      org_id: "org-a",
      extra: { role: "admin" },
    });
    const env = mockEnv({ AUTH_JWT_SECRET: secret });
    const res = await app.request(
      "/me",
      { method: "GET", headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    expect(res.status).toBe(200);
    const payload = await res.json() as {
      user_id?: string;
      email?: string;
      name?: string;
      org_id?: string;
      role?: string;
    };
    expect(payload.user_id).toBe("user-1");
    expect(payload.email).toBe("user@test.com");
    expect(payload.name).toBe("Test User");
    expect(payload.org_id).toBe("org-a");
  });
});
