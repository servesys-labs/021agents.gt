import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import type { Env } from "../src/env";
import type { CurrentUser } from "../src/auth/types";
import { apiKeyRoutes } from "../src/routes/api-keys";
import { policyRoutes } from "../src/routes/policies";
import { workflowRoutes } from "../src/routes/workflows";
import { sessionRoutes } from "../src/routes/sessions";
import { evalRoutes } from "../src/routes/eval";
import { ragRoutes } from "../src/routes/rag";
import { retentionRoutes } from "../src/routes/retention";
import { orgRoutes } from "../src/routes/orgs";
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

describe("expanded scope enforcement regression checks", () => {
  it("denies API key create without api_keys:write", async () => {
    const app = buildApp(apiKeyRoutes, ["api_keys:read"]);
    const res = await app.request(
      "/",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "k1" }),
      },
      mockEnv(),
    );
    expect(res.status).toBe(403);
  });

  it("denies policy delete without policies:write", async () => {
    const app = buildApp(policyRoutes, ["policies:read"]);
    const res = await app.request("/p1", { method: "DELETE" }, mockEnv());
    expect(res.status).toBe(403);
  });

  it("denies workflow cancel without workflows:write", async () => {
    const app = buildApp(workflowRoutes, ["workflows:read"]);
    const res = await app.request("/wf1/runs/r1/cancel", { method: "POST" }, mockEnv());
    expect(res.status).toBe(403);
  });

  it("denies session feedback without sessions:write", async () => {
    const app = buildApp(sessionRoutes, ["sessions:read"]);
    const res = await app.request(
      "/s1/feedback",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rating: 5 }),
      },
      mockEnv(),
    );
    expect(res.status).toBe(403);
  });

  it("denies eval run without eval:run", async () => {
    const app = buildApp(evalRoutes, ["eval:read"]);
    const res = await app.request(
      "/run",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_name: "a", tasks: [{ input: "x" }] }),
      },
      mockEnv(),
    );
    expect(res.status).toBe(403);
  });

  it("denies rag ingest without rag:write", async () => {
    const app = buildApp(ragRoutes, ["rag:read"]);
    const form = new FormData();
    form.append("f", new Blob(["hello"], { type: "text/plain" }), "a.txt");
    const res = await app.request("/agent-a/ingest", { method: "POST", body: form }, mockEnv());
    expect(res.status).toBe(403);
  });

  it("denies retention apply without retention:write", async () => {
    const app = buildApp(retentionRoutes, ["retention:read"]);
    const res = await app.request("/apply", { method: "POST" }, mockEnv());
    expect(res.status).toBe(403);
  });

  it("denies org member invite without orgs:write", async () => {
    const app = buildApp(orgRoutes, ["orgs:read"]);
    const res = await app.request(
      "/org-a/members",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "new@test.com", role: "member" }),
      },
      mockEnv(),
    );
    expect(res.status).toBe(403);
  });
});
