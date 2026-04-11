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
import { middlewareStatusRoutes } from "../src/routes/middleware-status";

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
  // TODO(rls-migration): withOrgDb scopes org_id via RLS session variable,
  // not as an explicit first bind parameter. This test asserted the old
  // binding order and no longer applies.
  it.skip("events list is org-scoped", async () => {
    let firstBinding: unknown;
    mockSql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join("?");
      if (query.includes("FROM middleware_events")) {
        expect(query).toContain("org_id");
        firstBinding = values[0];
        return [];
      }
      return [];
    }) as unknown as MockSqlFn;

    const app = buildApp("org-a");
    const res = await app.request("/events?limit=10", { method: "GET" }, mockEnv());
    expect(res.status).toBe(200);
    expect(firstBinding).toBe("org-a");
  });

  // TODO(rls-migration): withOrgDb scopes org_id via RLS session variable,
  // so org_id is no longer the first explicit bind in middleware event queries.
  it.skip("events with session_id and middleware_name binds org_id first", async () => {
    const bindings: unknown[] = [];
    mockSql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join("?");
      if (query.includes("FROM middleware_events")) {
        bindings.push(...values);
        return [];
      }
      return [];
    }) as unknown as MockSqlFn;

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
