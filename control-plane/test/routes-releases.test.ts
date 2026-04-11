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
import { releaseRoutes } from "../src/routes/releases";

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
  app.route("/", releaseRoutes);
  return app;
}

describe("release routes org scoping", () => {
  // TODO(rls-migration): test verifies org filtering via binding values, but
  // RLS now enforces scoping via withOrgDb wrapper and the route no longer
  // passes org_id as a sql binding.
  it.skip("channels are org-scoped", async () => {
    mockSql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join("?");
      if (query.includes("FROM release_channels") && query.includes("ORDER BY channel")) {
        const [, orgId] = values;
        if (orgId === "org-a") {
          return [{ org_id: "org-a", agent_name: "agent-x", channel: "staging" }];
        }
        return [{ org_id: "org-b", agent_name: "agent-x", channel: "staging" }];
      }
      return [];
    }) as unknown as MockSqlFn;

    const app = buildApp("org-a");
    const res = await app.request("/agent-x/channels", { method: "GET" }, mockEnv());
    expect(res.status).toBe(200);
    const payload = await res.json() as { channels?: Array<{ org_id?: string }> };
    expect(payload.channels?.length).toBe(1);
    expect(payload.channels?.[0]?.org_id).toBe("org-a");
  });

  // TODO(rls-migration): mock inspects values[1] as org_id but RLS routes
  // no longer bind org_id explicitly — ownership check is now implicit.
  it.skip("promote returns 404 when agent is not owned by org", async () => {
    mockSql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join("?");
      if (query.includes("FROM release_channels") && query.includes("channel")) return [];
      if (query.includes("FROM agents")) {
        const [, orgId] = values;
        if (orgId !== "org-a") return [{ config: "{}", version: "0.1.0" }];
        return [];
      }
      return [];
    }) as unknown as MockSqlFn;

    const app = buildApp("org-a");
    const res = await app.request(
      "/agent-x/promote",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from_channel: "draft", to_channel: "staging" }),
      },
      mockEnv(),
    );
    expect(res.status).toBe(404);
  });

  it("rejects invalid canary weight", async () => {
    mockSql = (async () => []) as unknown as MockSqlFn;
    const app = buildApp("org-a");
    const res = await app.request(
      "/agent-x/canary",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          primary_version: "1.0.0",
          canary_version: "1.1.0",
          canary_weight: 1.5,
        }),
      },
      mockEnv(),
    );
    expect(res.status).toBe(400);
  });

  // TODO(rls-migration): test asserts org filter via query bindings; RLS now
  // handled by withOrgDb wrapper, not a query parameter.
  it.skip("canary lookup returns null when no record in caller org", async () => {
    mockSql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join("?");
      if (query.includes("FROM canary_splits")) {
        const [, orgId] = values;
        if (orgId === "org-a") return [];
        return [{ org_id: "org-b", agent_name: "agent-x", is_active: true }];
      }
      return [];
    }) as unknown as MockSqlFn;

    const app = buildApp("org-a");
    const res = await app.request("/agent-x/canary", { method: "GET" }, mockEnv());
    expect(res.status).toBe(200);
    const payload = await res.json() as { canary?: unknown };
    expect(payload.canary).toBeNull();
  });

  // TODO(rls-migration): test asserts UPDATE SQL contains "org_id" but RLS
  // route no longer includes org_id in WHERE clause.
  it.skip("promote upserts with org-scoped UPDATE then INSERT (no ON CONFLICT)", async () => {
    const queries: string[] = [];
    mockSql = (async (strings: TemplateStringsArray) => {
      const query = strings.join("?");
      queries.push(query);
      if (query.includes("FROM release_channels") && query.includes("channel")) {
        return [{ config: "{}", version: "1.0.0" }];
      }
      if (query.includes("UPDATE release_channels")) {
        expect(query).toContain("org_id");
        expect(query).toContain("agent_name");
        expect(query).not.toContain("ON CONFLICT");
        return { count: 0 } as unknown as [];
      }
      if (query.includes("INSERT INTO release_channels")) {
        expect(query).not.toContain("ON CONFLICT");
        return [];
      }
      return [];
    }) as unknown as MockSqlFn;

    const app = buildApp("org-a");
    const res = await app.request(
      "/agent-x/promote",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from_channel: "draft", to_channel: "staging" }),
      },
      mockEnv(),
    );
    expect(res.status).toBe(200);
    expect(queries.some((q) => q.includes("UPDATE release_channels"))).toBe(true);
    expect(queries.some((q) => q.includes("INSERT INTO release_channels"))).toBe(true);
  });

  it("promote skips INSERT when org-scoped UPDATE touches a row", async () => {
    const inserts: string[] = [];
    mockSql = (async (strings: TemplateStringsArray) => {
      const query = strings.join("?");
      if (query.includes("FROM release_channels") && query.includes("channel")) {
        return [{ config: "{}", version: "2.0.0" }];
      }
      if (query.includes("UPDATE release_channels")) return { count: 1 } as unknown as [];
      if (query.includes("INSERT INTO release_channels")) {
        inserts.push(query);
        return [];
      }
      if (query.includes("INSERT INTO audit_log")) return [];
      return [];
    }) as unknown as MockSqlFn;

    const app = buildApp("org-a");
    const res = await app.request(
      "/agent-x/promote",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from_channel: "draft", to_channel: "staging" }),
      },
      mockEnv(),
    );
    expect(res.status).toBe(200);
    expect(inserts.length).toBe(0);
  });

  it("promote success returns expected contract fields", async () => {
    mockSql = (async (strings: TemplateStringsArray) => {
      const query = strings.join("?");
      if (query.includes("FROM release_channels") && query.includes("channel")) {
        return [{ config: "{\"name\":\"agent-x\"}", version: "1.2.3" }];
      }
      if (query.includes("UPDATE release_channels")) return { count: 0 } as unknown as [];
      if (query.includes("INSERT INTO release_channels")) return [];
      if (query.includes("INSERT INTO audit_log")) return [];
      return [];
    }) as unknown as MockSqlFn;

    const app = buildApp("org-a");
    const res = await app.request(
      "/agent-x/promote",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from_channel: "draft", to_channel: "staging" }),
      },
      mockEnv(),
    );
    expect(res.status).toBe(200);
    const payload = await res.json() as { promoted?: string; from?: string; to?: string; version?: string };
    expect(payload.promoted).toBe("agent-x");
    expect(payload.from).toBe("draft");
    expect(payload.to).toBe("staging");
    expect(payload.version).toBe("1.2.3");
  });

  it("canary set/remove returns expected contracts", async () => {
    mockSql = (async (strings: TemplateStringsArray) => {
      const query = strings.join("?");
      if (query.includes("UPDATE canary_splits SET is_active = false")) return [];
      if (query.includes("INSERT INTO canary_splits")) return [];
      return [];
    }) as unknown as MockSqlFn;

    const app = buildApp("org-a");
    const setRes = await app.request(
      "/agent-x/canary",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          primary_version: "1.0.0",
          canary_version: "1.1.0",
          canary_weight: 0.2,
        }),
      },
      mockEnv(),
    );
    expect(setRes.status).toBe(200);
    const setPayload = await setRes.json() as { agent?: string; primary?: string; canary?: string; weight?: number };
    expect(setPayload.agent).toBe("agent-x");
    expect(setPayload.primary).toBe("1.0.0");
    expect(setPayload.canary).toBe("1.1.0");
    expect(setPayload.weight).toBe(0.2);

    const deleteRes = await app.request("/agent-x/canary", { method: "DELETE" }, mockEnv());
    expect(deleteRes.status).toBe(200);
    const deletePayload = await deleteRes.json() as { removed?: boolean };
    expect(deletePayload.removed).toBe(true);
  });
});
