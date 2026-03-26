import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import type { Env } from "../src/env";
import type { CurrentUser } from "../src/auth/types";
import { sessionRoutes } from "../src/routes/sessions";
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
  app.route("/", sessionRoutes);
  return app;
}

describe("sessions route authz and input contracts", () => {
  it("denies session detail for non-owned session", async () => {
    const mockSql = (async (strings: TemplateStringsArray) => {
      const query = strings.join("?");
      if (query.includes("SELECT * FROM sessions WHERE session_id")) return [];
      return [];
    }) as any;
    vi.mocked(getDb).mockResolvedValue(mockSql);
    vi.mocked(getDbForOrg).mockResolvedValue(mockSql);
    const app = buildApp("org-a");
    const res = await app.request("/sess-x", { method: "GET" }, mockEnv());
    expect(res.status).toBe(404);
  });

  it("denies turns for non-owned session", async () => {
    const mockSql2 = (async (strings: TemplateStringsArray) => {
      const query = strings.join("?");
      if (query.includes("SELECT 1 FROM sessions WHERE session_id")) return [];
      return [];
    }) as any;
    vi.mocked(getDb).mockResolvedValue(mockSql2);
    vi.mocked(getDbForOrg).mockResolvedValue(mockSql2);
    const app = buildApp("org-a");
    const res = await app.request("/sess-x/turns", { method: "GET" }, mockEnv());
    expect(res.status).toBe(404);
  });

  it("clamps cleanup before_days to minimum 7", async () => {
    let observedCutoff: number | null = null;
    const mockSql3 = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join("?");
      if (query.includes("DELETE FROM sessions WHERE created_at <")) {
        observedCutoff = Number(values[0]);
        return { count: 0 };
      }
      if (query.includes("DELETE FROM turns WHERE session_id NOT IN")) return { count: 0 };
      return [];
    }) as any;
    vi.mocked(getDb).mockResolvedValue(mockSql3);
    vi.mocked(getDbForOrg).mockResolvedValue(mockSql3);
    const app = buildApp("org-a");
    const start = Date.now() / 1000;
    const res = await app.request("/?before_days=1", { method: "DELETE" }, mockEnv());
    const end = Date.now() / 1000;
    expect(res.status).toBe(200);
    const expectedMax = end - 7 * 86400;
    const expectedMin = start - 7 * 86400 - 2;
    expect(observedCutoff).not.toBeNull();
    expect((observedCutoff as number) <= expectedMax + 2).toBe(true);
    expect((observedCutoff as number) >= expectedMin).toBe(true);
  });

  it("returns trace response contract for owned session", async () => {
    const mockSql4 = (async (strings: TemplateStringsArray) => {
      const query = strings.join("?");
      if (query.includes("SELECT trace_id FROM sessions")) return [{ trace_id: "trace-1" }];
      if (query.includes("SELECT * FROM sessions WHERE trace_id")) {
        return [{ session_id: "sess-1", trace_id: "trace-1", org_id: "org-a" }];
      }
      if (query.includes("FROM billing_records WHERE trace_id")) {
        return [{ total_cost: 1.23, total_input_tokens: 10, total_output_tokens: 20, records: 2 }];
      }
      return [];
    }) as any;
    vi.mocked(getDb).mockResolvedValue(mockSql4);
    vi.mocked(getDbForOrg).mockResolvedValue(mockSql4);
    const app = buildApp("org-a");
    const res = await app.request("/sess-1/trace", { method: "GET" }, mockEnv());
    expect(res.status).toBe(200);
    const payload = await res.json() as {
      trace_id?: string;
      sessions?: unknown[];
      cost_rollup?: { total_cost_usd?: number; billing_records?: number };
    };
    expect(payload.trace_id).toBe("trace-1");
    expect(Array.isArray(payload.sessions)).toBe(true);
    expect(typeof payload.cost_rollup?.total_cost_usd).toBe("number");
    expect(payload.cost_rollup?.billing_records).toBe(2);
  });

  it("returns runtime profile contract for owned session", async () => {
    const mockSql5 = (async (strings: TemplateStringsArray) => {
      const query = strings.join("?");
      if (query.includes("SELECT session_id FROM sessions")) return [{ session_id: "sess-1" }];
      if (query.includes("SELECT turn_number, execution_mode")) {
        return [
          {
            turn_number: 1,
            execution_mode: "sequential",
            plan_json: "{\"nodes\":1}",
            reflection_json: "{\"ok\":true}",
            latency_ms: 120,
            cost_total_usd: 0.01,
          },
        ];
      }
      return [];
    }) as any;
    vi.mocked(getDb).mockResolvedValue(mockSql5);
    vi.mocked(getDbForOrg).mockResolvedValue(mockSql5);
    const app = buildApp("org-a");
    const res = await app.request("/sess-1/runtime", { method: "GET" }, mockEnv());
    expect(res.status).toBe(200);
    const payload = await res.json() as {
      session_id?: string;
      turns?: Array<{ turn_number?: number; execution_mode?: string; plan?: unknown; reflection?: unknown }>;
    };
    expect(payload.session_id).toBe("sess-1");
    expect(Array.isArray(payload.turns)).toBe(true);
    expect(payload.turns?.[0]?.turn_number).toBe(1);
    expect(payload.turns?.[0]?.execution_mode).toBe("sequential");
  });

  it("feedback submission returns contract for owned session", async () => {
    const mockSql6 = (async (strings: TemplateStringsArray) => {
      const query = strings.join("?");
      if (query.includes("SELECT session_id FROM sessions")) return [{ session_id: "sess-1" }];
      if (query.includes("INSERT INTO session_feedback")) return [];
      return [];
    }) as any;
    vi.mocked(getDb).mockResolvedValue(mockSql6);
    vi.mocked(getDbForOrg).mockResolvedValue(mockSql6);
    const app = buildApp("org-a");
    const res = await app.request(
      "/sess-1/feedback",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rating: 5, comment: "great" }),
      },
      mockEnv(),
    );
    expect(res.status).toBe(200);
    const payload = await res.json() as { submitted?: boolean; session_id?: string };
    expect(payload.submitted).toBe(true);
    expect(payload.session_id).toBe("sess-1");
  });
});
