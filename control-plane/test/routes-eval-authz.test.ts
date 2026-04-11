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
import { evalRoutes } from "../src/routes/eval";

type AppType = { Bindings: Env; Variables: { user: CurrentUser } };

function makeUser(orgId = "org-a"): CurrentUser {
  return {
    user_id: "u-1",
    email: "u@test.com",
    name: "User",
    org_id: orgId,
    project_id: "",
    env: "",
    role: "admin",
    scopes: ["*"],
    auth_method: "jwt",
  };
}

function buildApp(orgId = "org-a") {
  const app = new Hono<AppType>();
  app.use("*", async (c, next) => {
    c.set("user", makeUser(orgId));
    await next();
  });
  app.route("/", evalRoutes);
  return app;
}

describe("eval routes authz checks", () => {
  it("returns 404 for run details outside caller org", async () => {
    mockSql = (async (strings: TemplateStringsArray) => {
      const query = strings.join("?");
      if (query.includes("FROM eval_runs WHERE id")) return [];
      return [];
    }) as unknown as MockSqlFn;
    const app = buildApp("org-a");
    const res = await app.request("/runs/123", { method: "GET" }, mockEnv());
    expect(res.status).toBe(404);
  });

  it("returns 404 for trials when run is not owned by caller org", async () => {
    mockSql = (async (strings: TemplateStringsArray) => {
      const query = strings.join("?");
      if (query.includes("SELECT id FROM eval_runs")) return [];
      return [];
    }) as unknown as MockSqlFn;
    const app = buildApp("org-a");
    const res = await app.request("/runs/123/trials", { method: "GET" }, mockEnv());
    expect(res.status).toBe(404);
  });
});
