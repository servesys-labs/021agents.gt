import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import type { Env } from "../src/env";
import type { CurrentUser } from "../src/auth/types";
import { billingRoutes } from "../src/routes/billing";
import { stripeRoutes } from "../src/routes/stripe";
import { conversationIntelRoutes } from "../src/routes/conversation-intel";
import { evolveRoutes } from "../src/routes/evolve";
import { agentRoutes } from "../src/routes/agents";
import { componentRoutes } from "../src/routes/components";
import { mockEnv } from "./helpers/test-env";

type AppType = { Bindings: Env; Variables: { user: CurrentUser } };

function makeUser(scopes: string[]): CurrentUser {
  return {
    user_id: "u-1",
    email: "u@test.com",
    name: "User",
    org_id: "org-a",
    project_id: "",
    env: "",
    role: "member",
    scopes,
    auth_method: "api_key",
  };
}

function buildApp(route: Hono<AppType>, scopes: string[]): Hono<AppType> {
  const app = new Hono<AppType>();
  app.use("*", async (c, next) => {
    c.set("user", makeUser(scopes));
    await next();
  });
  app.route("/", route);
  return app;
}

describe("final scope hardening regression checks", () => {
  it("denies billing pricing mutation without billing:write", async () => {
    const app = buildApp(billingRoutes, ["billing:read"]);
    const res = await app.request(
      "/pricing",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resource_type: "inference", operation: "completion", unit: "token" }),
      },
      mockEnv(),
    );
    expect(res.status).toBe(403);
  });

  it("denies stripe checkout without billing:write", async () => {
    const app = buildApp(stripeRoutes, ["billing:read"]);
    const res = await app.request("/checkout", { method: "POST" }, mockEnv());
    expect(res.status).toBe(403);
  });

  it("denies conversation scoring without intelligence:write", async () => {
    const app = buildApp(conversationIntelRoutes, ["intelligence:read"]);
    const res = await app.request("/score/s1", { method: "POST" }, mockEnv());
    expect(res.status).toBe(403);
  });

  it("denies evolve proposal approval without evolve:write", async () => {
    const app = buildApp(evolveRoutes, ["evolve:read"]);
    const res = await app.request("/agent-a/proposals/p1/approve", { method: "POST" }, mockEnv());
    expect(res.status).toBe(403);
  });

  it("denies agent clone without agents:write", async () => {
    const app = buildApp(agentRoutes, ["agents:read"]);
    const res = await app.request(
      "/agent-a/clone",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ new_name: "agent-b" }),
      },
      mockEnv(),
    );
    expect(res.status).toBe(403);
  });

  it("denies component fork without components:write", async () => {
    const app = buildApp(componentRoutes, ["components:read"]);
    const res = await app.request("/c1/fork", { method: "POST" }, mockEnv());
    expect(res.status).toBe(403);
  });
});
