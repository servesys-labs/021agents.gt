import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import type { Env } from "../src/env";
import type { CurrentUser } from "../src/auth/types";
import { mockEnv, buildDbClientMock, type MockSqlFn } from "./helpers/test-env";

// Shared tagged-template sql mock — individual tests replace its
// implementation by assigning mockSql directly.
let mockSql: MockSqlFn = (async () => []) as unknown as MockSqlFn;

vi.mock("../src/db/client", () => buildDbClientMock(() => mockSql));

// Route import MUST come after the vi.mock call so the mocked db/client
// is resolved when the routes file loads.
import { agentRoutes } from "../src/routes/agents";

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
  app.route("/", agentRoutes);
  return app;
}

describe("agents route contracts", () => {
  it("returns 400 on malformed create payload", async () => {
    const app = buildApp();
    const res = await app.request(
      "/",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: "missing required name" }),
      },
      mockEnv(),
    );
    expect(res.status).toBe(400);
  });

  it("returns 410 for runtime-moved endpoint with guidance", async () => {
    const app = buildApp();
    const res = await app.request("/agent-a/run/stream", { method: "POST" }, mockEnv());
    expect(res.status).toBe(410);
    const payload = await res.json() as { error?: string };
    expect(payload.error || "").toMatch(/edge-only/i);
    expect(payload.error || "").toMatch(/runtime-proxy/i);
  });

  it("lists agents with response-shape parity", async () => {
    mockSql = (async (strings: TemplateStringsArray) => {
      const query = strings.join("?");
      if (query.includes("FROM agents") && query.includes("is_active")) {
        return [
          {
            name: "agent-a",
            description: "desc",
            config: JSON.stringify({
              model: "m1",
              tools: ["t1"],
              tags: ["tag"],
              version: "0.1.1",
            }),
          },
        ];
      }
      return [];
    }) as unknown as MockSqlFn;

    const app = buildApp();
    const res = await app.request("/", { method: "GET" }, mockEnv());
    expect(res.status).toBe(200);
    const payload = await res.json() as Array<{
      name?: string;
      description?: string;
      model?: string;
      tools?: unknown[];
      tags?: unknown[];
      version?: string;
    }>;
    expect(Array.isArray(payload)).toBe(true);
    expect(payload[0]?.name).toBe("agent-a");
    expect(typeof payload[0]?.model).toBe("string");
    expect(Array.isArray(payload[0]?.tools)).toBe(true);
    expect(Array.isArray(payload[0]?.tags)).toBe(true);
  });
});
