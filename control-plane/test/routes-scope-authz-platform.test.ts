import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import type { Env } from "../src/env";
import type { CurrentUser } from "../src/auth/types";
import { observabilityRoutes } from "../src/routes/observability";
import { graphRoutes } from "../src/routes/graphs";
import { securityRoutes } from "../src/routes/security";
import { guardrailRoutes } from "../src/routes/guardrails";
import { dlpRoutes } from "../src/routes/dlp";
import { goldImageRoutes } from "../src/routes/gold-images";
import { chatPlatformRoutes } from "../src/routes/chat-platforms";
import { mcpControlRoutes } from "../src/routes/mcp-control";
import { gpuRoutes } from "../src/routes/gpu";
import { sandboxRoutes } from "../src/routes/sandbox";
import { autoresearchRoutes } from "../src/routes/autoresearch";
import { compareRoutes } from "../src/routes/compare";
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

describe("platform-family scope enforcement", () => {
  it("denies observability writes without observability:write", async () => {
    const app = buildApp(observabilityRoutes, ["observability:read"]);
    const res = await app.request(
      "/annotations",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trace_id: "t1", note: "x" }),
      },
      mockEnv(),
    );
    expect(res.status).toBe(403);
  });

  it("denies graph run without graphs:write", async () => {
    const app = buildApp(graphRoutes, ["graphs:read"]);
    const res = await app.request(
      "/validate",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ graph: {} }) },
      mockEnv(),
    );
    expect(res.status).toBe(403);
  });

  it("denies security scans without security:write", async () => {
    const app = buildApp(securityRoutes, ["security:read"]);
    const res = await app.request("/scan/agent-a", { method: "POST" }, mockEnv());
    expect(res.status).toBe(403);
  });

  it("denies guardrail policy creation without guardrails:write", async () => {
    const app = buildApp(guardrailRoutes, ["guardrails:read"]);
    const res = await app.request(
      "/policies",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "p1", mode: "block", patterns: [] }),
      },
      mockEnv(),
    );
    expect(res.status).toBe(403);
  });

  it("denies DLP policy updates without dlp:write", async () => {
    const app = buildApp(dlpRoutes, ["dlp:read"]);
    const res = await app.request(
      "/agents/agent-a/policy",
      { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "block" }) },
      mockEnv(),
    );
    expect(res.status).toBe(403);
  });

  it("denies gold image writes without gold_images:write", async () => {
    const app = buildApp(goldImageRoutes, ["gold_images:read"]);
    const res = await app.request(
      "/",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "base" }) },
      mockEnv(),
    );
    expect(res.status).toBe(403);
  });

  it("denies integration writes without integrations:write", async () => {
    const app = buildApp(chatPlatformRoutes, ["integrations:read"]);
    const res = await app.request(
      "/telegram/connect",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bot_token: "x" }) },
      mockEnv(),
    );
    expect(res.status).toBe(403);
  });

  it("denies mcp sync without integrations:write", async () => {
    const app = buildApp(mcpControlRoutes, ["integrations:read"]);
    const res = await app.request("/servers/s1/sync", { method: "POST" }, mockEnv());
    expect(res.status).toBe(403);
  });

  it("denies GPU endpoint writes without gpu:write", async () => {
    const app = buildApp(gpuRoutes, ["gpu:read"]);
    const res = await app.request(
      "/endpoints",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: "x" }) },
      mockEnv(),
    );
    expect(res.status).toBe(403);
  });

  it("denies sandbox create without sandbox:write", async () => {
    const app = buildApp(sandboxRoutes, ["sandbox:read"]);
    const res = await app.request("/create", { method: "POST" }, mockEnv());
    expect(res.status).toBe(403);
  });

  it("denies autoresearch start without autoresearch:write", async () => {
    const app = buildApp(autoresearchRoutes, ["autoresearch:read"]);
    const res = await app.request("/start", { method: "POST" }, mockEnv());
    expect(res.status).toBe(403);
  });

  it("denies compare without compare:read", async () => {
    const app = buildApp(compareRoutes, []);
    const res = await app.request(
      "/",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_name: "a", tasks: [] }),
      },
      mockEnv(),
    );
    expect(res.status).toBe(403);
  });
});
