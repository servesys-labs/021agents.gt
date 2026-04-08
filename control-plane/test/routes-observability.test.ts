import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import type { Env } from "../src/env";
import type { CurrentUser } from "../src/auth/types";
import { observabilityRoutes } from "../src/routes/observability";
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
  app.route("/", observabilityRoutes);
  return app;
}

describe("observability ownership and maintenance contracts", () => {
  it("meta-proposals listing denies non-owned agents", async () => {
    const mockSql = (async (strings: TemplateStringsArray) => {
      const query = strings.join("?");
      if (query.includes("COUNT(*) as cnt FROM sessions")) return [{ cnt: 0 }];
      if (query.includes("COUNT(*) as cnt FROM agents")) return [{ cnt: 0 }];
      return [];
    }) as any;
    vi.mocked(getDb).mockResolvedValue(mockSql);
    vi.mocked(getDbForOrg).mockResolvedValue(mockSql);

    const app = buildApp("org-a");
    const res = await app.request("/agents/agent-x/meta-proposals", { method: "GET" }, mockEnv());
    expect(res.status).toBe(404);
  });

  it("maintenance dry_run keeps persisted=false even when persist_proposals=true", async () => {
    const mockSql2 = (async (strings: TemplateStringsArray) => {
      const query = strings.join("?");
      if (query.includes("COUNT(*) as cnt FROM sessions")) return [{ cnt: 1 }];
      if (query.includes("COUNT(*) as cnt FROM agents")) return [{ cnt: 1 }];
      return [];
    }) as any;
    vi.mocked(getDb).mockResolvedValue(mockSql2);
    vi.mocked(getDbForOrg).mockResolvedValue(mockSql2);

    const app = buildApp("org-a");
    const res = await app.request(
      "/agents/agent-x/autonomous-maintenance-run",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dry_run: true, persist_proposals: true }),
      },
      mockEnv(),
    );
    expect(res.status).toBe(200);
    const payload = await res.json() as {
      proposals?: { persisted?: boolean };
      dry_run?: boolean;
    };
    expect(payload.dry_run).toBe(true);
    expect(payload.proposals?.persisted).toBe(false);
  });

  it("meta-control-plane returns expected contract sections", async () => {
    const mockSql3 = (async (strings: TemplateStringsArray) => {
      const query = strings.join("?");
      if (query.includes("FROM sessions WHERE agent_name")) {
        return [{ total: 2, avg_turns: 4, success_rate: 0.5, avg_cost: 0.2 }];
      }
      if (query.includes("FROM eval_runs")) {
        return [{ pass_rate: 0.8, total_trials: 10 }];
      }
      return [];
    }) as any;
    vi.mocked(getDb).mockResolvedValue(mockSql3);
    vi.mocked(getDbForOrg).mockResolvedValue(mockSql3);

    const app = buildApp("org-a");
    const res = await app.request("/agents/agent-x/meta-control-plane", { method: "GET" }, mockEnv());
    expect(res.status).toBe(200);
    const payload = await res.json() as {
      agent_name?: string;
      signals?: Record<string, unknown>;
      entrypoints?: Record<string, unknown>;
    };
    expect(payload.agent_name).toBe("agent-x");
    expect(typeof payload.signals).toBe("object");
    expect(typeof payload.entrypoints).toBe("object");
    expect(payload.entrypoints && "agent_crud" in payload.entrypoints).toBe(true);
  });

  it("annotations validates required fields", async () => {
    vi.mocked(getDb).mockResolvedValue((async () => []) as any);
    vi.mocked(getDbForOrg).mockResolvedValue((async () => []) as any);
    const app = buildApp("org-a");
    const missingTrace = await app.request(
      "/annotations",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "hello" }),
      },
      mockEnv(),
    );
    expect(missingTrace.status).toBe(400);

    const missingMessage = await app.request(
      "/annotations",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trace_id: "trace-1" }),
      },
      mockEnv(),
    );
    expect(missingMessage.status).toBe(400);
  });

  it("summary returns numeric observability metrics contract", async () => {
    const mockSql4 = (async (strings: TemplateStringsArray) => {
      const query = strings.join("?");
      if (query.includes("FROM sessions WHERE org_id")) {
        return [{ total: 5, cost: 1.2, avg_latency: 2.3, success_rate: 0.8 }];
      }
      if (query.includes("FROM billing_records WHERE org_id")) {
        return [{ total_cost: 3.4, input_tokens: 100, output_tokens: 200 }];
      }
      return [];
    }) as any;
    vi.mocked(getDb).mockResolvedValue(mockSql4);
    vi.mocked(getDbForOrg).mockResolvedValue(mockSql4);

    const app = buildApp("org-a");
    const res = await app.request("/summary?since_days=14", { method: "GET" }, mockEnv());
    expect(res.status).toBe(200);
    const payload = await res.json() as Record<string, unknown>;
    expect(typeof payload.total_sessions).toBe("number");
    expect(typeof payload.total_cost_usd).toBe("number");
    expect(typeof payload.avg_latency_seconds).toBe("number");
    expect(typeof payload.success_rate).toBe("number");
    expect(typeof payload.total_input_tokens).toBe("number");
    expect(typeof payload.total_output_tokens).toBe("number");
    expect(payload.since_days).toBe(14);
  });

  it("trace returns sessions and events for owned trace", async () => {
    const mockSql5 = (async (strings: TemplateStringsArray) => {
      const query = strings.join("?");
      if (query.includes("COUNT(*) as cnt FROM sessions WHERE trace_id")) return [{ cnt: 1 }];
      if (query.includes("SELECT * FROM sessions WHERE trace_id")) {
        return [{ session_id: "sess-1", trace_id: "trace-1", org_id: "org-a" }];
      }
      if (query.includes("SELECT * FROM runtime_events WHERE trace_id")) {
        return [{ event_id: "evt-1", trace_id: "trace-1", org_id: "org-a" }];
      }
      return [];
    }) as any;
    vi.mocked(getDb).mockResolvedValue(mockSql5);
    vi.mocked(getDbForOrg).mockResolvedValue(mockSql5);

    const app = buildApp("org-a");
    const res = await app.request("/trace/trace-1", { method: "GET" }, mockEnv());
    expect(res.status).toBe(200);
    const payload = await res.json() as { trace_id?: string; sessions?: unknown[]; events?: unknown[] };
    expect(payload.trace_id).toBe("trace-1");
    expect(Array.isArray(payload.sessions)).toBe(true);
    expect(Array.isArray(payload.events)).toBe(true);
    expect(payload.sessions?.length).toBe(1);
  });

  it("trace integrity reports lifecycle mismatch and missing billing in strict mode", async () => {
    const oldTs = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const mockSql6 = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join("?");
      if (query.includes("FROM sessions") && query.includes("trace_id")) {
        return [{ session_id: "sess-1", status: "success", created_at: oldTs }];
      }
      if (query.includes("COUNT(*) as cnt FROM turns") && query.includes("GROUP BY")) return [{ session_id: "sess-1", cnt: 1 }];
      if (query.includes("COUNT(*) as cnt FROM runtime_events") && query.includes("GROUP BY")) return [{ session_id: "sess-1", cnt: 2 }];
      if (query.includes("COUNT(*) as cnt FROM billing_records") && query.includes("GROUP BY")) return [];
      if (query.includes("SUM(CASE WHEN event_type = 'turn_start'")) {
        return [{ session_id: "sess-1", turn_start: 2, turn_end: 1, session_end: 0 }];
      }
      if (query.includes("INSERT INTO audit_log")) return [];
      void values;
      return [];
    }) as any;
    vi.mocked(getDb).mockResolvedValue(mockSql6);
    vi.mocked(getDbForOrg).mockResolvedValue(mockSql6);

    const app = buildApp("org-a");
    const res = await app.request("/trace/trace-1/integrity?strict=true", { method: "GET" }, mockEnv());
    expect(res.status).toBe(200);
    const payload = await res.json() as {
      complete: boolean;
      warnings: string[];
      missing: { billing_records?: string[]; lifecycle_mismatch?: string[] };
    };
    expect(payload.complete).toBe(false);
    expect(payload.missing.billing_records).toEqual(["sess-1"]);
    expect(payload.missing.lifecycle_mismatch).toEqual(["sess-1"]);
    expect(payload.warnings.some((w) => w.includes("lifecycle event mismatch"))).toBe(true);
  });

  it("trace integrity can emit audit alert on breach", async () => {
    let auditLogged = false;
    const oldTs = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const mockSql7 = (async (strings: TemplateStringsArray) => {
      const query = strings.join("?");
      if (query.includes("FROM sessions") && query.includes("trace_id")) {
        return [{ session_id: "sess-1", status: "success", created_at: oldTs }];
      }
      if (query.includes("COUNT(*) as cnt FROM turns") && query.includes("GROUP BY")) return [];
      if (query.includes("COUNT(*) as cnt FROM runtime_events") && query.includes("GROUP BY")) return [];
      if (query.includes("COUNT(*) as cnt FROM billing_records") && query.includes("GROUP BY")) return [];
      if (query.includes("SUM(CASE WHEN event_type = 'turn_start'")) {
        return [];
      }
      if (query.includes("INSERT INTO audit_log")) {
        auditLogged = true;
        return [];
      }
      return [];
    }) as any;
    vi.mocked(getDb).mockResolvedValue(mockSql7);
    vi.mocked(getDbForOrg).mockResolvedValue(mockSql7);

    const app = buildApp("org-a");
    const res = await app.request(
      "/trace/trace-1/integrity?strict=true&alert_on_breach=true",
      { method: "GET" },
      mockEnv(),
    );
    expect(res.status).toBe(200);
    expect(auditLogged).toBe(true);
  });

  it("trace integrity keeps billing warning relaxed for very recent traces unless strict", async () => {
    const recentTs = new Date().toISOString();
    const mockSql8 = (async (strings: TemplateStringsArray) => {
      const query = strings.join("?");
      if (query.includes("FROM sessions") && query.includes("trace_id")) {
        return [{ session_id: "sess-1", status: "success", created_at: recentTs }];
      }
      if (query.includes("COUNT(*) as cnt FROM turns") && query.includes("GROUP BY")) return [{ session_id: "sess-1", cnt: 1 }];
      if (query.includes("COUNT(*) as cnt FROM runtime_events") && query.includes("GROUP BY")) return [{ session_id: "sess-1", cnt: 2 }];
      if (query.includes("COUNT(*) as cnt FROM billing_records") && query.includes("GROUP BY")) return [];
      if (query.includes("SUM(CASE WHEN event_type = 'turn_start'")) {
        return [{ session_id: "sess-1", turn_start: 1, turn_end: 1, session_end: 1 }];
      }
      return [];
    }) as any;
    vi.mocked(getDb).mockResolvedValue(mockSql8);
    vi.mocked(getDbForOrg).mockResolvedValue(mockSql8);

    const app = buildApp("org-a");
    const relaxed = await app.request("/trace/trace-1/integrity", { method: "GET" }, mockEnv());
    expect(relaxed.status).toBe(200);
    const relaxedPayload = await relaxed.json() as { complete: boolean; warnings: string[] };
    expect(relaxedPayload.complete).toBe(true);
    expect(relaxedPayload.warnings.length).toBe(0);

    const strict = await app.request("/trace/trace-1/integrity?strict=true", { method: "GET" }, mockEnv());
    expect(strict.status).toBe(200);
    const strictPayload = await strict.json() as { complete: boolean; warnings: string[] };
    expect(strictPayload.complete).toBe(false);
    expect(strictPayload.warnings.some((w) => w.includes("billing records"))).toBe(true);
  });

  it("integrity breaches endpoint returns aggregated breach summary", async () => {
    const mockSql9 = (async (strings: TemplateStringsArray) => {
      const query = strings.join("?");
      if (query.includes("FROM audit_log") && query.includes("trace.integrity_breach")) {
        return [
          {
            resource_id: "trace-1",
            user_id: "u-1",
            created_at: "2026-03-27T00:00:00.000Z",
            changes_json: JSON.stringify({
              strict: true,
              missing_turns: 1,
              missing_runtime_events: 0,
              missing_billing_records: 1,
              lifecycle_mismatch: 1,
              warnings: ["1 sessions have no billing records"],
            }),
          },
          {
            resource_id: "trace-1",
            user_id: "u-1",
            created_at: "2026-03-27T00:01:00.000Z",
            changes_json: JSON.stringify({
              strict: false,
              missing_turns: 0,
              missing_runtime_events: 1,
              missing_billing_records: 0,
              lifecycle_mismatch: 0,
              warnings: ["1 sessions have no runtime events"],
            }),
          },
          {
            resource_id: "trace-2",
            user_id: "u-2",
            created_at: "2026-03-27T00:02:00.000Z",
            changes_json: "{}",
          },
        ];
      }
      return [];
    }) as any;
    vi.mocked(getDb).mockResolvedValue(mockSql9);
    vi.mocked(getDbForOrg).mockResolvedValue(mockSql9);

    const app = buildApp("org-a");
    const res = await app.request("/integrity/breaches?limit=10", { method: "GET" }, mockEnv());
    expect(res.status).toBe(200);
    const payload = await res.json() as {
      total_breaches: number;
      strict_breaches: number;
      hottest_traces: Array<{ trace_id: string; breaches: number }>;
      entries: Array<{ trace_id: string }>;
    };
    expect(payload.total_breaches).toBe(3);
    expect(payload.strict_breaches).toBe(1);
    expect(payload.hottest_traces[0]).toEqual({ trace_id: "trace-1", breaches: 2 });
    expect(payload.entries.length).toBe(3);
    expect((payload.entries[0] as { severity?: string }).severity).toBe("critical");
  });

  it("integrity breaches endpoint supports trace filter", async () => {
    const mockSql10 = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join("?");
      if (query.includes("resource_id =")) {
        expect(values.some((v) => String(v) === "trace-filtered")).toBe(true);
      }
      if (query.includes("FROM audit_log") && query.includes("trace.integrity_breach")) {
        return [{
          resource_id: "trace-filtered",
          user_id: "u-1",
          created_at: "2026-03-27T00:00:00.000Z",
          changes_json: JSON.stringify({ strict: true }),
        }];
      }
      return [];
    }) as any;
    vi.mocked(getDb).mockResolvedValue(mockSql10);
    vi.mocked(getDbForOrg).mockResolvedValue(mockSql10);

    const app = buildApp("org-a");
    const res = await app.request(
      "/integrity/breaches?trace_id=trace-filtered",
      { method: "GET" },
      mockEnv(),
    );
    expect(res.status).toBe(200);
    const payload = await res.json() as { entries: Array<{ trace_id: string }> };
    expect(payload.entries[0]?.trace_id).toBe("trace-filtered");
  });

  it("incidents endpoint aggregates integrity, loop, and circuit signals", async () => {
    const mockSqlIncidents = (async (strings: TemplateStringsArray) => {
      const query = strings.join("?");
      if (query.includes("FROM audit_log") && query.includes("created_at >=")) {
        return [
          {
            resource_id: "trace-inc",
            user_id: "u-1",
            created_at: "2026-03-27T12:00:00.000Z",
            changes_json: JSON.stringify({
              strict: false,
              missing_runtime_events: 1,
              missing_turns: 0,
              lifecycle_mismatch: 0,
              missing_billing_records: 0,
              warnings: [],
            }),
          },
        ];
      }
      if (query.includes("FROM middleware_events")) {
        return [
          {
            session_id: "sess-loop",
            event_type: "loop_halt",
            details_json: JSON.stringify({ message: "halt", turn: 2 }),
            created_at: "2026-03-27T12:05:00.000Z",
            trace_id: "trace-loop",
          },
        ];
      }
      if (query.includes("FROM runtime_events")) {
        return [
          {
            trace_id: "trace-circ",
            session_id: "sess-circ",
            event_type: "turn_completed",
            details_json: JSON.stringify({ error: "Circuit breaker OPEN for browse. Retry after 12s" }),
            created_at: "2026-03-27T12:06:00.000Z",
          },
        ];
      }
      return [];
    }) as any;
    vi.mocked(getDb).mockResolvedValue(mockSqlIncidents);
    vi.mocked(getDbForOrg).mockResolvedValue(mockSqlIncidents);

    const app = buildApp("org-a");
    const res = await app.request("/incidents?limit=20&dedupe_window_sec=0", { method: "GET" }, mockEnv());
    expect(res.status).toBe(200);
    const payload = await res.json() as {
      window?: { since_hours?: number };
      defaults?: { dedupe_window_sec?: number };
      sources?: Record<string, boolean>;
      counts?: { total?: number; by_kind?: Record<string, number> };
      incidents?: Array<{ kind?: string; severity?: string; signal_source?: string }>;
    };
    expect(payload.window?.since_hours).toBe(24);
    expect(payload.defaults?.dedupe_window_sec).toBe(0);
    expect(payload.sources?.audit_log).toBe(true);
    expect(payload.sources?.middleware_events).toBe(true);
    expect(payload.sources?.runtime_events).toBe(true);
    expect(payload.counts?.total).toBe(3);
    expect(payload.counts?.by_kind?.integrity_breach).toBe(1);
    expect(payload.counts?.by_kind?.loop_halt).toBe(1);
    expect(payload.counts?.by_kind?.circuit_block).toBe(1);
    const kinds = new Set((payload.incidents ?? []).map((i) => i.kind));
    expect(kinds.has("integrity_breach")).toBe(true);
    expect(kinds.has("loop_halt")).toBe(true);
    expect(kinds.has("circuit_block")).toBe(true);
    const integ = payload.incidents?.find((i) => i.kind === "integrity_breach");
    expect(integ?.severity).toBe("medium");
    expect(integ?.signal_source).toBe("audit_log");
    const loop = payload.incidents?.find((i) => i.kind === "loop_halt");
    expect(loop?.severity).toBe("critical");
  });

  it("incidents endpoint rejects invalid kinds", async () => {
    vi.mocked(getDb).mockResolvedValue((async () => []) as any);
    vi.mocked(getDbForOrg).mockResolvedValue((async () => []) as any);
    const app = buildApp("org-a");
    const res = await app.request("/incidents?kinds=not_a_kind", { method: "GET" }, mockEnv());
    expect(res.status).toBe(400);
  });

  it("incidents endpoint filters by min_severity", async () => {
    const mockSqlSev = (async (strings: TemplateStringsArray) => {
      const query = strings.join("?");
      if (query.includes("FROM audit_log") && query.includes("created_at >=")) {
        return [
          {
            resource_id: "t-low",
            user_id: "u-1",
            created_at: "2026-03-27T12:00:00.000Z",
            changes_json: JSON.stringify({ strict: false, missing_billing_records: 1 }),
          },
        ];
      }
      if (query.includes("FROM middleware_events")) {
        return [
          {
            session_id: "s-h",
            event_type: "loop_halt",
            details_json: "{}",
            created_at: "2026-03-27T12:01:00.000Z",
            trace_id: "t-h",
          },
        ];
      }
      if (query.includes("FROM runtime_events")) return [];
      return [];
    }) as any;
    vi.mocked(getDb).mockResolvedValue(mockSqlSev);
    vi.mocked(getDbForOrg).mockResolvedValue(mockSqlSev);

    const app = buildApp("org-a");
    const res = await app.request("/incidents?min_severity=high&dedupe_window_sec=0", { method: "GET" }, mockEnv());
    expect(res.status).toBe(200);
    const payload = await res.json() as { incidents?: unknown[]; counts?: { total?: number } };
    expect(payload.counts?.total).toBe(1);
    expect((payload.incidents?.[0] as { kind?: string }).kind).toBe("loop_halt");
  });
});
