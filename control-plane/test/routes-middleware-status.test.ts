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
  it("events list query no longer references org_id (RLS scopes it)", async () => {
    // Post-RLS: the /events route drops `WHERE org_id = $1` from the
    // middleware_events query because the RLS policy handles it via
    // current_org_id(). This test verifies the negative — if someone
    // adds `org_id` back as an explicit bind in the future (which
    // would be a bug, since the RLS policy already covers it), this
    // assertion fires.
    let sawMiddlewareEventsQuery = false;
    let queryText = "";
    mockSql = (async (strings: TemplateStringsArray) => {
      const query = strings.join("?");
      if (query.includes("FROM middleware_events")) {
        sawMiddlewareEventsQuery = true;
        queryText = query;
        return [];
      }
      return [];
    }) as unknown as MockSqlFn;

    const app = buildApp("org-a");
    const res = await app.request("/events?limit=10", { method: "GET" }, mockEnv());
    expect(res.status).toBe(200);
    expect(sawMiddlewareEventsQuery).toBe(true);
    // RLS invariant: the events query MUST NOT carry an explicit
    // `org_id` filter — that's what the policy is for.
    expect(queryText).not.toMatch(/\borg_id\s*=/);
  });

  it("events with session_id + middleware_name passes only those binds (no org_id)", async () => {
    // Expected bind order under RLS: [sessionId, middlewareName, limit].
    // The original test expected org_id in position 0 which is gone.
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
    expect(bindings).toEqual(["s1", "loop_detection", 5]);
    // Extra sanity: the org_id should never appear in the bind list.
    expect(bindings).not.toContain("org-b");
  });
});
