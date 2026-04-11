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
import { memoryRoutes } from "../src/routes/memory";

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
    mockSql = makeSqlMock({ hasSession: true }) as unknown as MockSqlFn;
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
    mockSql = makeSqlMock({ hasSession: false }) as unknown as MockSqlFn;
    const app = buildApp("org-a");
    const env = mockEnv();

    const res = await app.request("/agent-a/working", { method: "GET" }, env);
    expect(res.status).toBe(200);
    const payload = await res.json() as { working_memory?: Record<string, unknown>; note?: string };
    expect(payload.working_memory || {}).toEqual({});
    expect(payload.note || "").toMatch(/No persisted session data/i);
  });

  it("facts upsert requires key", async () => {
    mockSql = makeSqlMock({ hasSession: true }) as unknown as MockSqlFn;
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
    mockSql = (async (strings: TemplateStringsArray) => {
      const query = String(strings[0] || "");
      if (query.includes("FROM agents WHERE name")) return [];
      return [];
    }) as unknown as MockSqlFn;
    const app = buildApp("org-a");
    const res = await app.request("/agent-a/episodes", { method: "GET" }, mockEnv());
    expect(res.status).toBe(404);
  });

  it("procedures list returns parsed steps and success_rate", async () => {
    mockSql = (async (strings: TemplateStringsArray) => {
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
    }) as unknown as MockSqlFn;
    const app = buildApp("org-a");
    const res = await app.request("/agent-a/procedures", { method: "GET" }, mockEnv());
    expect(res.status).toBe(200);
    const payload = await res.json() as { procedures?: Array<{ steps?: unknown[]; success_rate?: number }>; total?: number };
    expect(payload.total).toBe(1);
    expect(Array.isArray(payload.procedures?.[0]?.steps)).toBe(true);
    expect(payload.procedures?.[0]?.success_rate).toBe(0.75);
  });

  it("facts list returns parsed JSON values", async () => {
    mockSql = (async (strings: TemplateStringsArray) => {
      const query = String(strings[0] || "");
      if (query.includes("FROM agents WHERE name")) return [{ "?column?": 1 }];
      if (query.includes("FROM facts")) {
        return [{ key: "k1", value: "{\"v\":1}", category: null }];
      }
      return [];
    }) as unknown as MockSqlFn;
    const app = buildApp("org-a");
    const res = await app.request("/agent-a/facts", { method: "GET" }, mockEnv());
    expect(res.status).toBe(200);
    const payload = await res.json() as { facts?: Array<{ key?: string; value?: unknown }>; total?: number };
    expect(payload.total).toBe(1);
    expect(payload.facts?.[0]?.key).toBe("k1");
    expect(payload.facts?.[0]?.value).toBe("{\"v\":1}");
  });

  it("memory health returns aggregate counts", async () => {
    mockSql = (async (strings: TemplateStringsArray) => {
      const query = Array.from(strings).join(" ");
      if (query.includes("FROM agents WHERE name")) return [{ "?column?": 1 }];
      if (query.includes("COUNT(*)::int AS count FROM facts WHERE agent_name")) return [{ count: 12 }];
      if (query.includes("COUNT(*)::int AS count FROM episodes WHERE agent_name")) return [{ count: 4 }];
      if (query.includes("COUNT(*)::int AS count FROM procedures WHERE agent_name")) return [{ count: 3 }];
      if (query.includes("INTERVAL '30 days'")) return [{ count: 2 }];
      if (query.includes("MAX(created_at) AS latest FROM facts")) return [{ latest: "2026-04-01T00:00:00.000Z" }];
      if (query.includes("MAX(created_at) AS latest FROM episodes")) return [{ latest: "2026-04-02T00:00:00.000Z" }];
      if (query.includes("MAX(updated_at) AS latest FROM procedures")) return [{ latest: "2026-04-03T00:00:00.000Z" }];
      if (query.includes("FROM curated_memory")) return [{ count: 6 }];
      return [];
    }) as unknown as MockSqlFn;
    const app = buildApp("org-a");
    const res = await app.request("/agent-a/health", { method: "GET" }, mockEnv());
    expect(res.status).toBe(200);
    const payload = await res.json() as {
      semantic_facts_count?: number;
      episodic_entries_count?: number;
      procedures_count?: number;
      curated_entries_count?: number;
      stale_facts_30d_count?: number;
      latest_memory_at?: string | null;
    };
    expect(payload.semantic_facts_count).toBe(12);
    expect(payload.episodic_entries_count).toBe(4);
    expect(payload.procedures_count).toBe(3);
    expect(payload.curated_entries_count).toBe(6);
    expect(payload.stale_facts_30d_count).toBe(2);
    expect(payload.latest_memory_at).toBe("2026-04-03T00:00:00.000Z");
  });
});
