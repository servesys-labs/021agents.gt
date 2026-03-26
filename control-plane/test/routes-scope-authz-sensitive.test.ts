import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import type { Env } from "../src/env";
import type { CurrentUser } from "../src/auth/types";
import { secretRoutes } from "../src/routes/secrets";
import { projectRoutes } from "../src/routes/projects";
import { issueRoutes } from "../src/routes/issues";
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

describe("scope enforcement on secrets/projects/issues routes", () => {
  it("denies secret creation without secrets:write", async () => {
    const app = buildApp(secretRoutes, ["secrets:read"]);
    const res = await app.request(
      "/",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "API_TOKEN", value: "secret" }),
      },
      mockEnv(),
    );
    expect(res.status).toBe(403);
  });

  it("denies project env update without projects:write", async () => {
    const app = buildApp(projectRoutes, ["projects:read"]);
    const res = await app.request(
      "/p1/envs/staging",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: "standard" }),
      },
      mockEnv(),
    );
    expect(res.status).toBe(403);
  });

  it("denies canvas layout update without projects:write", async () => {
    const app = buildApp(projectRoutes, ["projects:read"]);
    const res = await app.request(
      "/p1/canvas-layout",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nodes: [], edges: [] }),
      },
      mockEnv(),
    );
    expect(res.status).toBe(403);
  });

  it("denies issue update without issues:write", async () => {
    const app = buildApp(issueRoutes, ["issues:read"]);
    const res = await app.request(
      "/iss-1",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "triaged" }),
      },
      mockEnv(),
    );
    expect(res.status).toBe(403);
  });

  it("denies issue auto-fix without issues:write", async () => {
    const app = buildApp(issueRoutes, ["issues:read"]);
    const res = await app.request("/iss-1/auto-fix", { method: "POST" }, mockEnv());
    expect(res.status).toBe(403);
  });
});
