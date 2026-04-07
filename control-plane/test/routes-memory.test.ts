import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import type { Env } from "../src/env";
import type { CurrentUser } from "../src/auth/types";
import { memoryRoutes } from "../src/routes/memory";
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
  app.route("/", memoryRoutes);
  return app;
}

function makeSqlMock(options: { hasSession: boolean }) {
  return async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = String(strings[0] || "");
    // Agent ownership check (added by org-scoping fix)
    if (query.includes("FROM agents WHERE name")) {
      return [{ "?column?": 1 }]; // Agent exists and is owned by this org
    }
    if (query.includes("FROM sessions")) {
      if (!options.hasSession) return [];
      return [{ session_id: "sess-1", created_at: 1000 }];
    }
    if (query.includes("FROM turns")) {
      return [
        {
          turn_number: 2,
          llm_content: "second turn",
          tool_calls_json: '[{"name":"tool-a"}]',
          reflection_json: '{"ok":true}',
          plan_json: '{"steps":[1,2]}',
        },
        {
          turn_number: 1,
          llm_content: "first turn",
          tool_calls_json: "[]",
          reflection_json: "{}",
          plan_json: "{}",
        },
      ];
    }
    throw new Error(`Unhandled query in test sql mock: ${query} / ${JSON.stringify(values)}`);
  };
}

describe("memory routes: working snapshot", () => {
  it("returns derived working snapshot from latest session turns", async () => {
    vi.mocked(getDb).mockResolvedValue(makeSqlMock({ hasSession: true }) as any);
    vi.mocked(getDbForOrg).mockResolvedValue(makeSqlMock({ hasSession: true }) as any);
    const app = buildApp("org-a");
    const env = mockEnv();

    const res = await app.request("/agent-a/working", { method: "GET" }, env);
    expect(res.status).toBe(200);
    const payload = await res.json() as {
      working_memory?: { latest_session_id?: string; recent_turns?: Array<{ turn_number: number }> };
    };
    expect(payload.working_memory?.latest_session_id).toBe("sess-1");
    const turns = payload.working_memory?.recent_turns || [];
    expect(turns.length).toBeGreaterThan(0);
    expect(turns[0].turn_number).toBe(1);
  });

  it("returns empty snapshot when no persisted session exists", async () => {
    vi.mocked(getDb).mockResolvedValue(makeSqlMock({ hasSession: false }) as any);
    vi.mocked(getDbForOrg).mockResolvedValue(makeSqlMock({ hasSession: false }) as any);
    const app = buildApp("org-a");
    const env = mockEnv();

    const res = await app.request("/agent-a/working", { method: "GET" }, env);
    expect(res.status).toBe(200);
    const payload = await res.json() as { working_memory?: Record<string, unknown>; note?: string };
    expect(payload.working_memory || {}).toEqual({});
    expect(payload.note || "").toMatch(/No persisted session data/i);
  });

  it("facts upsert requires key", async () => {
    vi.mocked(getDb).mockResolvedValue(makeSqlMock({ hasSession: true }) as any);
    vi.mocked(getDbForOrg).mockResolvedValue(makeSqlMock({ hasSession: true }) as any);
    const app = buildApp("org-a");
    const res = await app.request(
      "/agent-a/facts",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "x" }),
      },
      mockEnv(),
    );
    expect(res.status).toBe(400);
  });

  it("episodes list returns 404 when agent is not owned", async () => {
    const mockSql = (async (strings: TemplateStringsArray) => {
      const query = String(strings[0] || "");
      if (query.includes("FROM agents WHERE name")) return [];
      return [];
    }) as any;
    vi.mocked(getDb).mockResolvedValue(mockSql);
    vi.mocked(getDbForOrg).mockResolvedValue(mockSql);
    const app = buildApp("org-a");
    const res = await app.request("/agent-a/episodes", { method: "GET" }, mockEnv());
    expect(res.status).toBe(404);
  });

  it("procedures list returns parsed steps and success_rate", async () => {
    const mockSql2 = (async (strings: TemplateStringsArray) => {
      const query = String(strings[0] || "");
      if (query.includes("FROM agents WHERE name")) return [{ "?column?": 1 }];
      if (query.includes("FROM procedures WHERE agent_name")) {
        return [
          {
            id: "p1",
            steps_json: "[\"a\",\"b\"]",
            success_count: 3,
            failure_count: 1,
            last_used: 1000,
          },
        ];
      }
      return [];
    }) as any;
    vi.mocked(getDb).mockResolvedValue(mockSql2);
    vi.mocked(getDbForOrg).mockResolvedValue(mockSql2);
    const app = buildApp("org-a");
    const res = await app.request("/agent-a/procedures", { method: "GET" }, mockEnv());
    expect(res.status).toBe(200);
    const payload = await res.json() as { procedures?: Array<{ steps?: unknown[]; success_rate?: number }>; total?: number };
    expect(payload.total).toBe(1);
    expect(Array.isArray(payload.procedures?.[0]?.steps)).toBe(true);
    expect(payload.procedures?.[0]?.success_rate).toBe(0.75);
  });

  it("facts list returns values from semantic_facts", async () => {
    const mockSql3 = (async (strings: TemplateStringsArray) => {
      const query = String(strings[0] || "");
      if (query.includes("FROM agents WHERE name")) return [{ "?column?": 1 }];
      if (query.includes("SELECT key, value") || query.includes("FROM semantic_facts")) {
        return [{ key: "k1", value: "{\"v\":1}", category: "reference" }];
      }
      return [];
    }) as any;
    vi.mocked(getDb).mockResolvedValue(mockSql3);
    vi.mocked(getDbForOrg).mockResolvedValue(mockSql3);
    const app = buildApp("org-a");
    const res = await app.request("/agent-a/facts", { method: "GET" }, mockEnv());
    expect(res.status).toBe(200);
    const payload = await res.json() as { facts?: Array<{ key?: string; value?: unknown }>; total?: number };
    expect(payload.total).toBe(1);
    expect(payload.facts?.[0]?.key).toBe("k1");
    expect(payload.facts?.[0]?.value).toBe("{\"v\":1}");
  });
});
