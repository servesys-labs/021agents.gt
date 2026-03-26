import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import type { Env } from "../src/env";
import type { CurrentUser } from "../src/auth/types";
import { evalRoutes } from "../src/routes/eval";
import { mockEnv } from "./helpers/test-env";

vi.mock("../src/db/client", () => ({
  getDb: vi.fn(),
  getDbForOrg: vi.fn(),
}));

import { getDb, getDbForOrg } from "../src/db/client";

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
    const mockSql = (async (strings: TemplateStringsArray) => {
      const query = strings.join("?");
      if (query.includes("FROM eval_runs WHERE id")) return [];
      return [];
    }) as any;
    vi.mocked(getDb).mockResolvedValue(mockSql);
    vi.mocked(getDbForOrg).mockResolvedValue(mockSql);
    const app = buildApp("org-a");
    const res = await app.request("/runs/123", { method: "GET" }, mockEnv());
    expect(res.status).toBe(404);
  });

  it("returns 404 for trials when run is not owned by caller org", async () => {
    const mockSql2 = (async (strings: TemplateStringsArray) => {
      const query = strings.join("?");
      if (query.includes("SELECT id FROM eval_runs")) return [];
      return [];
    }) as any;
    vi.mocked(getDb).mockResolvedValue(mockSql2);
    vi.mocked(getDbForOrg).mockResolvedValue(mockSql2);
    const app = buildApp("org-a");
    const res = await app.request("/runs/123/trials", { method: "GET" }, mockEnv());
    expect(res.status).toBe(404);
  });
});
