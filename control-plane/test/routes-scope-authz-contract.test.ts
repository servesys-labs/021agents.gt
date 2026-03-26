import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import type { Env } from "../src/env";
import type { CurrentUser } from "../src/auth/types";
import { releaseRoutes } from "../src/routes/releases";
import { scheduleRoutes } from "../src/routes/schedules";
import { webhookRoutes } from "../src/routes/webhooks";
import { jobRoutes } from "../src/routes/jobs";
import { deployRoutes } from "../src/routes/deploy";
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

function buildApp(
  route: Hono<AppType>,
  scopes: string[],
): Hono<AppType> {
  const app = new Hono<AppType>();
  app.use("*", async (c, next) => {
    c.set("user", makeUser(scopes));
    await next();
  });
  app.route("/", route);
  return app;
}

describe("scope enforcement on high-impact mutation routes", () => {
  it("denies release promotion without releases:write", async () => {
    const app = buildApp(releaseRoutes, ["releases:read"]);
    const res = await app.request(
      "/agent-x/promote",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from_channel: "draft", to_channel: "staging" }),
      },
      mockEnv(),
    );
    expect(res.status).toBe(403);
  });

  it("denies schedule creation without schedules:write", async () => {
    const app = buildApp(scheduleRoutes, ["schedules:read"]);
    const res = await app.request(
      "/",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_name: "a", task: "t", cron: "* * * * *" }),
      },
      mockEnv(),
    );
    expect(res.status).toBe(403);
  });

  it("denies webhook creation without webhooks:write", async () => {
    const app = buildApp(webhookRoutes, ["webhooks:read"]);
    const res = await app.request(
      "/",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://example.com/hook", events: ["agent.error"] }),
      },
      mockEnv(),
    );
    expect(res.status).toBe(403);
  });

  it("denies job creation without jobs:write", async () => {
    const app = buildApp(jobRoutes, ["jobs:read"]);
    const res = await app.request(
      "/",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_name: "a", task: "t" }),
      },
      mockEnv(),
    );
    expect(res.status).toBe(403);
  });

  it("denies deploy without deploy:write", async () => {
    const app = buildApp(deployRoutes, ["deploy:read"]);
    const res = await app.request("/agent-x", { method: "POST" }, mockEnv());
    expect(res.status).toBe(403);
  });
});
