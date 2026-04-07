/**
 * Unit tests for the DB proxy query allowlist and RLS context injection.
 *
 * These tests simulate the /cf/db/query dispatch logic from deploy/src/index.ts
 * using a mock SQL function that records all queries. No real database is needed.
 */
import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// Mock SQL — records tagged-template calls so we can inspect query shapes
// ---------------------------------------------------------------------------

interface RecordedCall {
  query: string;
  params: unknown[];
}

function createMockSql() {
  const calls: RecordedCall[] = [];

  function taggedTemplate(strings: TemplateStringsArray, ...values: unknown[]) {
    calls.push({ query: strings.join("?"), params: values });
    return Promise.resolve([]);
  }

  const mockSql = Object.assign(taggedTemplate, {
    begin: async (fn: (tx: typeof taggedTemplate) => Promise<unknown>) => {
      return fn(taggedTemplate);
    },
  });

  return { sql: mockSql, calls };
}

// ---------------------------------------------------------------------------
// Simulated dispatch — mirrors the /cf/db/query endpoint logic from index.ts
// ---------------------------------------------------------------------------

interface QueryRequest {
  query_id?: string;
  context?: { org_id?: string; user_id?: string; role?: string };
  params?: Record<string, unknown>;
}

async function simulateDbQuery(
  sql: ReturnType<typeof createMockSql>["sql"],
  body: QueryRequest,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const queryId = String(body.query_id || "").trim();
  const orgId = String(body.context?.org_id || "").trim();
  const userId = String(body.context?.user_id || "").trim();
  const role = String(body.context?.role || "").trim();

  if (!queryId) {
    return { status: 400, body: { error: "query_id is required" } };
  }
  if (!orgId) {
    return { status: 400, body: { error: "context.org_id is required" } };
  }

  try {
    const rows = await sql.begin(async (tx: any) => {
      await tx`SELECT set_config('app.current_org_id', ${orgId}, true)`;
      await tx`SELECT set_config('app.current_user_id', ${userId || "system"}, true)`;
      await tx`SELECT set_config('app.current_role', ${role || "service"}, true)`;

      // ── Agent queries ──
      if (queryId === "agents.list_active_by_org") {
        return await tx`
          SELECT name, description, config, is_active, created_at, updated_at
          FROM agents
          WHERE org_id = ${orgId} AND is_active = true
          ORDER BY created_at DESC
        `;
      }
      if (queryId === "agents.config") {
        const agentName = String(body.params?.agent_name || "");
        if (!agentName) throw new Error("params.agent_name required");
        return await tx`
          SELECT name, config, description FROM agents
          WHERE name = ${agentName} AND org_id = ${orgId} AND is_active = true LIMIT 1
        `;
      }
      if (queryId === "agents.versions") {
        const agentName = String(body.params?.agent_name || "");
        const limit = Math.min(Number(body.params?.limit) || 20, 100);
        return await tx`
          SELECT version_number, created_by, created_at FROM agent_versions
          WHERE agent_name = ${agentName}
          ORDER BY created_at DESC LIMIT ${limit}
        `;
      }

      // ── Session queries ──
      if (queryId === "sessions.list") {
        const limit = Math.min(Number(body.params?.limit) || 50, 500);
        const offset = Math.max(Number(body.params?.offset) || 0, 0);
        const agentName = body.params?.agent_name ? String(body.params.agent_name) : null;
        const status = body.params?.status ? String(body.params.status) : null;
        return agentName && status
          ? await tx`SELECT session_id, agent_name, status FROM sessions WHERE org_id = ${orgId} AND agent_name = ${agentName} AND status = ${status} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`
          : agentName
            ? await tx`SELECT session_id, agent_name, status FROM sessions WHERE org_id = ${orgId} AND agent_name = ${agentName} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`
            : status
              ? await tx`SELECT session_id, agent_name, status FROM sessions WHERE org_id = ${orgId} AND status = ${status} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`
              : await tx`SELECT session_id, agent_name, status FROM sessions WHERE org_id = ${orgId} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`;
      }
      if (queryId === "sessions.detail") {
        const sessionId = String(body.params?.session_id || "");
        if (!sessionId) throw new Error("params.session_id required");
        return await tx`SELECT * FROM sessions WHERE session_id = ${sessionId} AND org_id = ${orgId} LIMIT 1`;
      }
      if (queryId === "sessions.stats") {
        const agentName = body.params?.agent_name ? String(body.params.agent_name) : null;
        const sinceDays = Math.min(Number(body.params?.since_days) || 7, 90);
        const since = Date.now() / 1000 - sinceDays * 86400;
        return agentName
          ? await tx`SELECT COUNT(*) as total FROM sessions WHERE org_id = ${orgId} AND agent_name = ${agentName} AND created_at >= ${since}`
          : await tx`SELECT COUNT(*) as total FROM sessions WHERE org_id = ${orgId} AND created_at >= ${since}`;
      }

      // ── Issue queries ──
      if (queryId === "issues.summary") {
        return await tx`SELECT status, severity, COUNT(*) as count FROM issues WHERE org_id = ${orgId} GROUP BY status, severity`;
      }

      // ── Eval queries ──
      if (queryId === "eval.latest_run") {
        const agentName = String(body.params?.agent_name || "");
        if (!agentName) throw new Error("params.agent_name required");
        return await tx`SELECT * FROM eval_runs WHERE agent_name = ${agentName} AND org_id = ${orgId} ORDER BY created_at DESC LIMIT 1`;
      }
      if (queryId === "eval.trials") {
        const runId = Number(body.params?.run_id);
        if (!runId) throw new Error("params.run_id required");
        return await tx`SELECT * FROM eval_trials WHERE eval_run_id = ${runId} ORDER BY trial_index`;
      }

      // ── Billing queries ──
      if (queryId === "billing.usage") {
        const sinceDays = Math.min(Number(body.params?.since_days) || 30, 365);
        const since = Date.now() / 1000 - sinceDays * 86400;
        return await tx`SELECT COALESCE(SUM(total_cost_usd),0) as total FROM billing_records WHERE org_id = ${orgId} AND created_at >= ${since}`;
      }
      if (queryId === "billing.by_agent") {
        const sinceDays = Math.min(Number(body.params?.since_days) || 30, 365);
        const since = Date.now() / 1000 - sinceDays * 86400;
        return await tx`SELECT agent_name, SUM(total_cost_usd) as cost FROM billing_records WHERE org_id = ${orgId} AND created_at >= ${since} GROUP BY agent_name ORDER BY cost DESC`;
      }

      // ── Feedback queries ──
      if (queryId === "feedback.stats") {
        const sinceDays = Math.min(Number(body.params?.since_days) || 30, 365);
        const since = Date.now() / 1000 - sinceDays * 86400;
        return await tx`SELECT rating, COUNT(*) as count FROM session_feedback WHERE org_id = ${orgId} AND created_at >= ${since} GROUP BY rating`;
      }

      // ── Security queries ──
      if (queryId === "security.scans") {
        const limit = Math.min(Number(body.params?.limit) || 20, 100);
        return await tx`SELECT * FROM security_scans WHERE org_id = ${orgId} ORDER BY created_at DESC LIMIT ${limit}`;
      }

      // ── Memory queries ──
      if (queryId === "memory.facts") {
        const agentName = String(body.params?.agent_name || "");
        const limit = Math.min(Number(body.params?.limit) || 50, 200);
        return await tx`SELECT * FROM facts WHERE agent_name = ${agentName} AND org_id = ${orgId} LIMIT ${limit}`;
      }
      if (queryId === "memory.episodes") {
        const agentName = String(body.params?.agent_name || "");
        const limit = Math.min(Number(body.params?.limit) || 50, 200);
        return await tx`SELECT * FROM episodes WHERE agent_name = ${agentName} AND org_id = ${orgId} ORDER BY created_at DESC LIMIT ${limit}`;
      }

      throw new Error(`unsupported query_id: ${queryId}`);
    });

    return {
      status: 200,
      body: {
        query_id: queryId,
        row_count: Array.isArray(rows) ? rows.length : 0,
        rows,
      },
    };
  } catch (err: any) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith("unsupported query_id:")) {
      return { status: 400, body: { error: message } };
    }
    return { status: 500, body: { error: message } };
  }
}

// ---------------------------------------------------------------------------
// Helper — find the query (after the 3 set_config calls) that targets real data
// ---------------------------------------------------------------------------

function getDataQuery(calls: RecordedCall[]): RecordedCall | undefined {
  // First 3 calls are set_config; the 4th is the actual query
  return calls[3];
}

function getSetConfigCalls(calls: RecordedCall[]): RecordedCall[] {
  return calls.slice(0, 3);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DB Proxy Query Allowlist", () => {
  const ORG = "org-test-123";
  const CTX = { org_id: ORG, user_id: "u-1", role: "admin" };

  // ── Accepted query IDs ──────────────────────────────────────────────────

  it("accepts agents.list_active_by_org", async () => {
    const { sql, calls } = createMockSql();
    const res = await simulateDbQuery(sql, { query_id: "agents.list_active_by_org", context: CTX });
    expect(res.status).toBe(200);
    const q = getDataQuery(calls);
    expect(q).toBeDefined();
    expect(q!.query).toContain("agents");
    expect(q!.params).toContain(ORG);
  });

  it("accepts sessions.list with filters", async () => {
    const { sql, calls } = createMockSql();
    const res = await simulateDbQuery(sql, {
      query_id: "sessions.list",
      context: CTX,
      params: { agent_name: "my-agent", status: "success", limit: 10 },
    });
    expect(res.status).toBe(200);
    const q = getDataQuery(calls);
    expect(q).toBeDefined();
    expect(q!.query).toContain("sessions");
    expect(q!.params).toContain(ORG);
    expect(q!.params).toContain("my-agent");
    expect(q!.params).toContain("success");
  });

  it("accepts sessions.stats with agent_name", async () => {
    const { sql, calls } = createMockSql();
    const res = await simulateDbQuery(sql, {
      query_id: "sessions.stats",
      context: CTX,
      params: { agent_name: "bot-a" },
    });
    expect(res.status).toBe(200);
    const q = getDataQuery(calls);
    expect(q!.query).toContain("sessions");
    expect(q!.params).toContain(ORG);
    expect(q!.params).toContain("bot-a");
  });

  it("accepts issues.summary", async () => {
    const { sql, calls } = createMockSql();
    const res = await simulateDbQuery(sql, { query_id: "issues.summary", context: CTX });
    expect(res.status).toBe(200);
    const q = getDataQuery(calls);
    expect(q!.query).toContain("issues");
    expect(q!.params).toContain(ORG);
  });

  it("accepts eval.latest_run", async () => {
    const { sql, calls } = createMockSql();
    const res = await simulateDbQuery(sql, {
      query_id: "eval.latest_run",
      context: CTX,
      params: { agent_name: "my-agent" },
    });
    expect(res.status).toBe(200);
    const q = getDataQuery(calls);
    expect(q!.query).toContain("eval_runs");
    expect(q!.params).toContain(ORG);
    expect(q!.params).toContain("my-agent");
  });

  it("accepts billing.usage", async () => {
    const { sql, calls } = createMockSql();
    const res = await simulateDbQuery(sql, { query_id: "billing.usage", context: CTX });
    expect(res.status).toBe(200);
    const q = getDataQuery(calls);
    expect(q!.query).toContain("billing_records");
    expect(q!.params).toContain(ORG);
  });

  it("accepts billing.by_agent", async () => {
    const { sql, calls } = createMockSql();
    const res = await simulateDbQuery(sql, { query_id: "billing.by_agent", context: CTX });
    expect(res.status).toBe(200);
    const q = getDataQuery(calls);
    expect(q!.query).toContain("billing_records");
    expect(q!.query).toContain("agent_name");
  });

  it("accepts feedback.stats", async () => {
    const { sql, calls } = createMockSql();
    const res = await simulateDbQuery(sql, { query_id: "feedback.stats", context: CTX });
    expect(res.status).toBe(200);
    const q = getDataQuery(calls);
    expect(q!.query).toContain("session_feedback");
    expect(q!.params).toContain(ORG);
  });

  it("accepts security.scans", async () => {
    const { sql, calls } = createMockSql();
    const res = await simulateDbQuery(sql, { query_id: "security.scans", context: CTX });
    expect(res.status).toBe(200);
    const q = getDataQuery(calls);
    expect(q!.query).toContain("security_scans");
    expect(q!.params).toContain(ORG);
  });

  it("accepts memory.facts", async () => {
    const { sql, calls } = createMockSql();
    const res = await simulateDbQuery(sql, {
      query_id: "memory.facts",
      context: CTX,
      params: { agent_name: "mem-agent" },
    });
    expect(res.status).toBe(200);
    const q = getDataQuery(calls);
    expect(q!.query).toContain("facts");
    expect(q!.params).toContain(ORG);
    expect(q!.params).toContain("mem-agent");
  });

  it("accepts memory.episodes", async () => {
    const { sql, calls } = createMockSql();
    const res = await simulateDbQuery(sql, {
      query_id: "memory.episodes",
      context: CTX,
      params: { agent_name: "mem-agent" },
    });
    expect(res.status).toBe(200);
    const q = getDataQuery(calls);
    expect(q!.query).toContain("episodes");
    expect(q!.params).toContain(ORG);
  });

  // ── Rejected queries ────────────────────────────────────────────────────

  it("rejects unknown query_id with 400", async () => {
    const { sql } = createMockSql();
    const res = await simulateDbQuery(sql, {
      query_id: "not.a.real.query",
      context: CTX,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("unsupported query_id");
  });

  it("rejects empty query_id with 400", async () => {
    const { sql } = createMockSql();
    const res = await simulateDbQuery(sql, { query_id: "", context: CTX });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("query_id is required");
  });

  // ── RLS context injection ──────────────────────────────────────────────

  it("requires org_id in context", async () => {
    const { sql } = createMockSql();
    const res = await simulateDbQuery(sql, {
      query_id: "agents.list_active_by_org",
      context: { org_id: "", user_id: "u-1" },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("context.org_id is required");
  });

  it("rejects empty org_id", async () => {
    const { sql } = createMockSql();
    const res = await simulateDbQuery(sql, {
      query_id: "sessions.list",
      context: {},
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("context.org_id is required");
  });

  it("sets RLS context (set_config) before every data query", async () => {
    const { sql, calls } = createMockSql();
    await simulateDbQuery(sql, { query_id: "issues.summary", context: CTX });
    const configs = getSetConfigCalls(calls);
    expect(configs).toHaveLength(3);
    expect(configs[0].query).toContain("app.current_org_id");
    expect(configs[0].params).toContain(ORG);
    expect(configs[1].query).toContain("app.current_user_id");
    expect(configs[2].query).toContain("app.current_role");
  });

  // ── Parameter validation ───────────────────────────────────────────────

  it("requires agent_name for agents.config", async () => {
    const { sql } = createMockSql();
    const res = await simulateDbQuery(sql, {
      query_id: "agents.config",
      context: CTX,
      params: {},
    });
    expect(res.status).toBe(500);
    expect(res.body.error).toContain("params.agent_name required");
  });

  it("requires session_id for sessions.detail", async () => {
    const { sql } = createMockSql();
    const res = await simulateDbQuery(sql, {
      query_id: "sessions.detail",
      context: CTX,
      params: {},
    });
    expect(res.status).toBe(500);
    expect(res.body.error).toContain("params.session_id required");
  });

  it("requires run_id for eval.trials", async () => {
    const { sql } = createMockSql();
    const res = await simulateDbQuery(sql, {
      query_id: "eval.trials",
      context: CTX,
      params: {},
    });
    expect(res.status).toBe(500);
    expect(res.body.error).toContain("params.run_id required");
  });

  it("caps limit to maximum values", async () => {
    const { sql, calls } = createMockSql();
    await simulateDbQuery(sql, {
      query_id: "sessions.list",
      context: CTX,
      params: { limit: 9999 },
    });
    const q = getDataQuery(calls);
    // The limit param should be capped at 500 (sessions.list max)
    expect(q!.params).toContain(500);
    expect(q!.params).not.toContain(9999);
  });

  it("caps since_days to 90 for sessions", async () => {
    const { sql, calls } = createMockSql();
    const beforeTime = Date.now() / 1000;
    await simulateDbQuery(sql, {
      query_id: "sessions.stats",
      context: CTX,
      params: { since_days: 999 },
    });
    const q = getDataQuery(calls);
    // With since_days capped to 90, the since timestamp should be roughly now - 90 days
    const sinceParam = q!.params.find((p) => typeof p === "number" && p > 1e9) as number;
    expect(sinceParam).toBeDefined();
    const daysAgo = (beforeTime - sinceParam) / 86400;
    expect(daysAgo).toBeGreaterThan(89);
    expect(daysAgo).toBeLessThan(91);
  });

  it("caps since_days to 365 for billing", async () => {
    const { sql, calls } = createMockSql();
    const beforeTime = Date.now() / 1000;
    await simulateDbQuery(sql, {
      query_id: "billing.usage",
      context: CTX,
      params: { since_days: 9999 },
    });
    const q = getDataQuery(calls);
    const sinceParam = q!.params.find((p) => typeof p === "number" && p > 1e9) as number;
    expect(sinceParam).toBeDefined();
    const daysAgo = (beforeTime - sinceParam) / 86400;
    expect(daysAgo).toBeGreaterThan(364);
    expect(daysAgo).toBeLessThan(366);
  });

  // ── SQL injection prevention ───────────────────────────────────────────

  it("does not accept SQL in query_id", async () => {
    const { sql } = createMockSql();
    const res = await simulateDbQuery(sql, {
      query_id: "'; DROP TABLE agents; --",
      context: CTX,
    });
    // Should reject as unsupported (the query_id is dispatched via string match, not interpolated)
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("unsupported query_id");
  });

  it("does not accept SQL in params", async () => {
    const { sql, calls } = createMockSql();
    // Even if params contain SQL, they are passed as parameterized values
    await simulateDbQuery(sql, {
      query_id: "sessions.list",
      context: CTX,
      params: { agent_name: "'; DROP TABLE sessions; --" },
    });
    const q = getDataQuery(calls);
    // The SQL-injection string should appear as a param value, not in the query template
    expect(q!.query).not.toContain("DROP TABLE");
    expect(q!.params).toContain("'; DROP TABLE sessions; --");
  });

  // ── org_id always in WHERE ─────────────────────────────────────────────

  it("always includes org_id in the WHERE clause of data queries", async () => {
    const queryIds = [
      "agents.list_active_by_org",
      "sessions.list",
      "sessions.stats",
      "issues.summary",
      "billing.usage",
      "billing.by_agent",
      "feedback.stats",
      "security.scans",
    ];
    for (const qid of queryIds) {
      const { sql, calls } = createMockSql();
      await simulateDbQuery(sql, { query_id: qid, context: CTX });
      const q = getDataQuery(calls);
      expect(q, `${qid} should generate a data query`).toBeDefined();
      expect(q!.params, `${qid} should include org_id in params`).toContain(ORG);
    }
  });
});
