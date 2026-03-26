import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import type { Env } from "../src/env";
import type { CurrentUser } from "../src/auth/types";
import { middlewareStatusRoutes } from "../src/routes/middleware-status";
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
  app.route("/", middlewareStatusRoutes);
  return app;
}

describe("middleware status routes", () => {
  it("events list is org-scoped", async () => {
    let firstBinding: unknown;
    const mockSql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join("?");
      if (query.includes("FROM middleware_events")) {
        expect(query).toContain("org_id");
        firstBinding = values[0];
        return [];
      }
      return [];
    }) as any;
    vi.mocked(getDb).mockResolvedValue(mockSql);
    vi.mocked(getDbForOrg).mockResolvedValue(mockSql);

    const app = buildApp("org-a");
    const res = await app.request("/events?limit=10", { method: "GET" }, mockEnv());
    expect(res.status).toBe(200);
    expect(firstBinding).toBe("org-a");
  });

  it("events with session_id and middleware_name binds org_id first", async () => {
    const bindings: unknown[] = [];
    const mockSql2 = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join("?");
      if (query.includes("FROM middleware_events")) {
        bindings.push(...values);
        return [];
      }
      return [];
    }) as any;
    vi.mocked(getDb).mockResolvedValue(mockSql2);
    vi.mocked(getDbForOrg).mockResolvedValue(mockSql2);

    const app = buildApp("org-b");
    const res = await app.request(
      "/events?session_id=s1&middleware_name=loop_detection&limit=5",
      { method: "GET" },
      mockEnv(),
    );
    expect(res.status).toBe(200);
    expect(bindings[0]).toBe("org-b");
    expect(bindings[1]).toBe("s1");
    expect(bindings[2]).toBe("loop_detection");
    expect(bindings[3]).toBe(5);
  });
});
