import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import type { Env } from "../src/env";
import type { CurrentUser } from "../src/auth/types";
import { edgeIngestRoutes } from "../src/routes/edge-ingest";
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
  app.route("/", edgeIngestRoutes);
  return app;
}

describe("edge-ingest auth hardening", () => {
  it("fails closed when SERVICE_TOKEN is not configured", async () => {
    const app = buildApp();
    const env = mockEnv({ SERVICE_TOKEN: "" });
    const res = await app.request(
      "/sessions",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: "s-1" }),
      },
      env,
    );
    expect(res.status).toBe(503);
    const payload = await res.json() as { error?: string };
    expect(payload.error).toContain("SERVICE_TOKEN not configured");
  });

  it("rejects invalid ingest token", async () => {
    const app = buildApp();
    const env = mockEnv({ SERVICE_TOKEN: "expected-token" });
    const res = await app.request(
      "/sessions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Edge-Token": "wrong-token",
        },
        body: JSON.stringify({ session_id: "s-1" }),
      },
      env,
    );
    expect(res.status).toBe(401);
  });
});
