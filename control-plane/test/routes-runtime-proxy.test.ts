import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import type { Env } from "../src/env";
import type { CurrentUser } from "../src/auth/types";
import { runtimeProxyRoutes } from "../src/routes/runtime-proxy";
import { mockEnv } from "./helpers/test-env";

type AppType = { Bindings: Env; Variables: { user: CurrentUser } };

function makeUser(): CurrentUser {
  return {
    user_id: "u-1",
    email: "u@test.com",
    name: "User",
    org_id: "org-a",
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
  app.route("/", runtimeProxyRoutes);
  return app;
}

describe("runtime-proxy route contracts", () => {
  it("agent/run proxies to runtime and returns result or error", async () => {
    const app = buildApp();
    const res = await app.request(
      "/agent/run",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_name: "a", input: "hello" }),
      },
      mockEnv(),
    );
    // With the default mockEnv RUNTIME, this will hit the runtime proxy
    // and either return the proxied result or a 502 if runtime fetch fails
    expect([200, 502]).toContain(res.status);
  });

  it("rejects invalid edge token", async () => {
    const app = buildApp();
    const env = mockEnv({ SERVICE_TOKEN: "expected-token" });
    const res = await app.request(
      "/tool/call",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Edge-Token": "wrong-token" },
        body: JSON.stringify({ tool: "list-tools", input: {} }),
      },
      env,
    );
    expect(res.status).toBe(401);
  });

  it("fails closed when SERVICE_TOKEN is not configured", async () => {
    const app = buildApp();
    const env = mockEnv({ SERVICE_TOKEN: "" });
    const res = await app.request(
      "/tool/call",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool: "list-tools", input: {} }),
      },
      env,
    );
    expect(res.status).toBe(503);
    const payload = await res.json() as { error?: string };
    expect(payload.error).toContain("SERVICE_TOKEN not configured");
  });

  it("rejects missing tool/name in body", async () => {
    const app = buildApp();
    const env = mockEnv({ SERVICE_TOKEN: "expected-token" });
    const res = await app.request(
      "/tool/call",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Edge-Token": "expected-token" },
        body: JSON.stringify({ input: {} }),
      },
      env,
    );
    expect(res.status).toBe(400);
  });

  it("maps runtime errors to upstream status", async () => {
    const app = buildApp();
    const env = mockEnv({
      SERVICE_TOKEN: "expected-token",
      RUNTIME: {
        fetch: async () => new Response("runtime failure", { status: 503 }),
      } as unknown as Fetcher,
    });
    const res = await app.request(
      "/tool/call",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Edge-Token": "expected-token" },
        body: JSON.stringify({ tool: "list-tools", input: {} }),
      },
      env,
    );
    expect(res.status).toBe(503);
  });
});
