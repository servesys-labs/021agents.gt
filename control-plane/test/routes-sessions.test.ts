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

  it("rejects cleanup before_days below minimum 7", async () => {
    const app = buildApp("org-a");
    const res = await app.request("/?before_days=1", { method: "DELETE" }, mockEnv());
    // Zod schema has .min(7), so values < 7 are rejected with 400
    expect(res.status).toBe(400);
  });

  it("accepts cleanup with before_days at minimum 7", async () => {
    let capturedCutoff: string | null = null;
    const mockSql3 = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join("?");
      if (query.includes("DELETE FROM sessions WHERE created_at <")) {
        capturedCutoff = String(values[0]);
        return { count: 0 };
      }
      if (query.includes("DELETE FROM turns WHERE session_id")) return { count: 0 };
      return [];
    }) as any;
    vi.mocked(getDb).mockResolvedValue(mockSql3);
    vi.mocked(getDbForOrg).mockResolvedValue(mockSql3);
    const app = buildApp("org-a");
    const res = await app.request("/?before_days=7", { method: "DELETE" }, mockEnv());
    expect(res.status).toBe(200);
    // The route uses ISO date strings for cutoff, verify it was called
    expect(capturedCutoff).not.toBeNull();
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
      if (query.includes("SELECT turn_number, execution_mode")) {
        return [
          {
            turn_number: 1,
            execution_mode: "sequential",
            plan_artifact: "{\"nodes\":1}",
            reflection: "{\"ok\":true}",
            latency_ms: 120,
            cost_total_usd: 0.01,
          },
        ];
      }
      if (query.includes("SELECT session_id FROM sessions")) return [{ session_id: "sess-1" }];
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

  it("export returns turns with parsed tool calls/results", async () => {
    const mockSql = (async (strings: TemplateStringsArray) => {
      const query = strings.join("?");
      if (query.includes("SELECT * FROM sessions WHERE session_id")) {
        return [{ session_id: "sess-1", org_id: "org-a", agent_name: "a", status: "completed" }];
      }
      if (query.includes("FROM turns WHERE session_id")) {
        return [
          {
            turn_number: 1,
            model_used: "m",
            llm_content: "hello",
            input_tokens: 1,
            output_tokens: 2,
            cost_total_usd: 0.01,
            latency_ms: 10,
            tool_calls_json: "[{\"id\":\"t1\",\"name\":\"grep\"}]",
            tool_results_json: "[{\"tool_call_id\":\"t1\",\"result\":\"ok\"}]",
          },
        ];
      }
      return [];
    }) as any;
    vi.mocked(getDb).mockResolvedValue(mockSql);
    vi.mocked(getDbForOrg).mockResolvedValue(mockSql);

    const app = buildApp("org-a");
    const res = await app.request("/sess-1/export?format=json", { method: "GET" }, mockEnv());
    expect(res.status).toBe(200);
    const payload = await res.json() as { session?: any; turns?: any[] };
    expect(payload.session?.session_id).toBe("sess-1");
    expect(payload.turns?.[0]?.content).toBe("hello");
    expect(Array.isArray(payload.turns?.[0]?.tool_calls)).toBe(true);
    expect(Array.isArray(payload.turns?.[0]?.tool_results)).toBe(true);
  });
});
