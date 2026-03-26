/**
 * Tests for the db-query, db-batch, and db-report agent tools
 * from deploy/src/runtime/tools.ts.
 *
 * We simulate the dispatch() function's db-query/db-batch/db-report cases
 * with a mock SQL layer so no real database is needed.
 */
import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// Mock SQL that records calls and returns configurable data
// ---------------------------------------------------------------------------

interface RecordedCall {
  query: string;
  params: unknown[];
}

function createMockSql(defaultRows: unknown[] = []) {
  const calls: RecordedCall[] = [];

  function taggedTemplate(strings: TemplateStringsArray, ...values: unknown[]) {
    calls.push({ query: strings.join("?"), params: values });
    return Promise.resolve(defaultRows);
  }

  const mockSql = Object.assign(taggedTemplate, {
    begin: async (fn: (tx: typeof taggedTemplate) => Promise<unknown>) => {
      return fn(taggedTemplate);
    },
  });

  return { sql: mockSql, calls };
}

// ---------------------------------------------------------------------------
// Simulated db-query dispatch (mirrors tools.ts case "db-query")
// ---------------------------------------------------------------------------

async function dbQueryTool(
  sql: ReturnType<typeof createMockSql>["sql"],
  args: Record<string, unknown>,
): Promise<string> {
  const queryId = String(args.query_id || "");
  if (!queryId) return "db-query requires query_id (e.g., 'sessions.list', 'issues.open', 'eval.runs')";

  const orgId = String(args.org_id || "");
  const userId = String(args.user_id || "");

  try {
    const rows = await sql.begin(async (tx: any) => {
      await tx`SELECT set_config('app.current_org_id', ${orgId}, true)`;
      await tx`SELECT set_config('app.current_user_id', ${userId || "agent"}, true)`;
      await tx`SELECT set_config('app.current_role', 'agent', true)`;

      const p = (args.params || {}) as Record<string, unknown>;
      switch (queryId) {
        case "sessions.stats": {
          const an = p.agent_name ? String(p.agent_name) : null;
          const sd = Math.min(Number(p.since_days) || 7, 90);
          const since = Date.now() / 1000 - sd * 86400;
          return an
            ? await tx`SELECT COUNT(*) as total, COALESCE(AVG(cost_total_usd),0) as avg_cost FROM sessions WHERE org_id = ${orgId} AND agent_name = ${an} AND created_at >= ${since}`
            : await tx`SELECT COUNT(*) as total, COALESCE(AVG(cost_total_usd),0) as avg_cost FROM sessions WHERE org_id = ${orgId} AND created_at >= ${since}`;
        }
        case "issues.summary":
          return await tx`SELECT status, severity, COUNT(*) as count FROM issues WHERE org_id = ${orgId} GROUP BY status, severity`;
        case "eval.latest_run": {
          const an = String(p.agent_name || "");
          return await tx`SELECT * FROM eval_runs WHERE agent_name = ${an} AND org_id = ${orgId} ORDER BY created_at DESC LIMIT 1`;
        }
        case "billing.usage": {
          const sd = Math.min(Number(p.since_days) || 30, 365);
          const since = Date.now() / 1000 - sd * 86400;
          return await tx`SELECT COALESCE(SUM(total_cost_usd),0) as total FROM billing_records WHERE org_id = ${orgId} AND created_at >= ${since}`;
        }
        case "billing.by_agent": {
          const sd = Math.min(Number(p.since_days) || 30, 365);
          const since = Date.now() / 1000 - sd * 86400;
          return await tx`SELECT agent_name, SUM(total_cost_usd) as cost FROM billing_records WHERE org_id = ${orgId} AND created_at >= ${since} GROUP BY agent_name ORDER BY cost DESC`;
        }
        case "feedback.stats": {
          const sd = Math.min(Number(p.since_days) || 30, 365);
          const since = Date.now() / 1000 - sd * 86400;
          return await tx`SELECT rating, COUNT(*) as count FROM user_feedback WHERE org_id = ${orgId} AND created_at >= ${since} GROUP BY rating`;
        }
        default:
          throw new Error(`Unknown query_id: ${queryId}. Available: sessions.stats, issues.summary, eval.latest_run, billing.usage, billing.by_agent, feedback.stats`);
      }
    });

    return JSON.stringify({
      query_id: queryId,
      rows,
      row_count: Array.isArray(rows) ? rows.length : 0,
    });
  } catch (err: any) {
    return `db-query failed: ${err.message || err}`;
  }
}

// ---------------------------------------------------------------------------
// Simulated db-batch dispatch (mirrors tools.ts case "db-batch")
// ---------------------------------------------------------------------------

async function dbBatchTool(
  sql: ReturnType<typeof createMockSql>["sql"],
  args: Record<string, unknown>,
): Promise<string> {
  const queries = args.queries;
  if (!Array.isArray(queries) || queries.length === 0) return "db-batch requires queries array";
  if (queries.length > 10) return "db-batch max 10 queries per batch";

  const orgId = String(args.org_id || "");

  try {
    const results = await Promise.all(
      queries.map(async (q: { query_id: string; params?: Record<string, unknown> }) => {
        const result = await dbQueryTool(sql, {
          query_id: q.query_id,
          params: q.params || {},
          org_id: orgId,
        });
        try {
          return JSON.parse(result);
        } catch {
          return { query_id: q.query_id, error: result };
        }
      }),
    );
    return JSON.stringify({ batch: true, count: results.length, results });
  } catch (err: any) {
    return `db-batch failed: ${err.message || err}`;
  }
}

// ---------------------------------------------------------------------------
// Simulated db-report dispatch (mirrors tools.ts case "db-report")
// ---------------------------------------------------------------------------

async function dbReportTool(
  sql: ReturnType<typeof createMockSql>["sql"],
  args: Record<string, unknown>,
): Promise<string> {
  const reportId = String(args.report_id || "");
  const orgId = String(args.org_id || "");
  if (!reportId) return "db-report requires report_id (e.g., 'agent_health', 'org_overview')";

  try {
    if (reportId === "agent_health") {
      const agentName = String(args.agent_name || "");
      if (!agentName) return "agent_health report requires agent_name";

      const batchResult = await dbBatchTool(sql, {
        org_id: orgId,
        queries: [
          { query_id: "sessions.stats", params: { agent_name: agentName, since_days: 7 } },
          { query_id: "issues.summary", params: {} },
          { query_id: "eval.latest_run", params: { agent_name: agentName } },
          { query_id: "feedback.stats", params: { since_days: 7 } },
        ],
      });
      const parsed = JSON.parse(batchResult);
      return JSON.stringify({
        report: "agent_health",
        agent_name: agentName,
        sessions: parsed.results?.[0]?.rows?.[0] || {},
        issues: parsed.results?.[1]?.rows || [],
        eval: parsed.results?.[2]?.rows?.[0] || null,
        feedback: parsed.results?.[3]?.rows || [],
      });
    }

    if (reportId === "org_overview") {
      const batchResult = await dbBatchTool(sql, {
        org_id: orgId,
        queries: [
          { query_id: "sessions.stats", params: { since_days: 7 } },
          { query_id: "issues.summary", params: {} },
          { query_id: "billing.usage", params: { since_days: 30 } },
          { query_id: "billing.by_agent", params: { since_days: 30 } },
        ],
      });
      const parsed = JSON.parse(batchResult);
      return JSON.stringify({
        report: "org_overview",
        sessions: parsed.results?.[0]?.rows?.[0] || {},
        issues: parsed.results?.[1]?.rows || [],
        billing: parsed.results?.[2]?.rows?.[0] || {},
        billing_by_agent: parsed.results?.[3]?.rows || [],
      });
    }

    return `Unknown report_id: ${reportId}. Available: agent_health, org_overview`;
  } catch (err: any) {
    return `db-report failed: ${err.message || err}`;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DB Query Tools", () => {
  describe("db-query", () => {
    it("returns error for missing query_id", async () => {
      const { sql } = createMockSql();
      const result = await dbQueryTool(sql, {});
      expect(result).toContain("db-query requires query_id");
    });

    it("returns error for unknown query_id", async () => {
      const { sql } = createMockSql();
      const result = await dbQueryTool(sql, { query_id: "not.real", org_id: "org-1" });
      expect(result).toContain("db-query failed");
      expect(result).toContain("Unknown query_id");
    });

    it("executes sessions.stats and returns structured result", async () => {
      const { sql } = createMockSql();
      const result = await dbQueryTool(sql, {
        query_id: "sessions.stats",
        org_id: "org-1",
        params: { agent_name: "bot-a", since_days: 7 },
      });
      const parsed = JSON.parse(result);
      expect(parsed.query_id).toBe("sessions.stats");
      expect(parsed).toHaveProperty("rows");
      expect(parsed).toHaveProperty("row_count");
      expect(typeof parsed.row_count).toBe("number");
    });

    it("executes issues.summary and returns structured result", async () => {
      const { sql } = createMockSql();
      const result = await dbQueryTool(sql, {
        query_id: "issues.summary",
        org_id: "org-1",
      });
      const parsed = JSON.parse(result);
      expect(parsed.query_id).toBe("issues.summary");
      expect(parsed).toHaveProperty("rows");
      expect(parsed).toHaveProperty("row_count");
    });

    it("sets RLS context (app.current_org_id) before query", async () => {
      const { sql, calls } = createMockSql();
      await dbQueryTool(sql, {
        query_id: "billing.usage",
        org_id: "org-abc",
      });
      // First call inside the transaction should be set_config for org_id
      expect(calls[0].query).toContain("app.current_org_id");
      expect(calls[0].params).toContain("org-abc");
    });

    it("sets role to 'agent' for tool calls", async () => {
      const { sql, calls } = createMockSql();
      await dbQueryTool(sql, {
        query_id: "issues.summary",
        org_id: "org-1",
      });
      expect(calls[2].query).toContain("app.current_role");
      // 'agent' is a literal in the SQL template, not a parameterized value
      expect(calls[2].query).toContain("agent");
    });

    it("executes billing.usage with custom since_days", async () => {
      const { sql, calls } = createMockSql();
      const beforeTime = Date.now() / 1000;
      await dbQueryTool(sql, {
        query_id: "billing.usage",
        org_id: "org-1",
        params: { since_days: 60 },
      });
      // Data query is calls[3]
      const q = calls[3];
      expect(q.query).toContain("billing_records");
      const sinceParam = q.params.find((p) => typeof p === "number" && p > 1e9) as number;
      const daysAgo = (beforeTime - sinceParam) / 86400;
      expect(daysAgo).toBeGreaterThan(59);
      expect(daysAgo).toBeLessThan(61);
    });
  });

  describe("db-batch", () => {
    it("returns error for empty queries array", async () => {
      const { sql } = createMockSql();
      const result = await dbBatchTool(sql, { queries: [], org_id: "org-1" });
      expect(result).toBe("db-batch requires queries array");
    });

    it("returns error for non-array queries", async () => {
      const { sql } = createMockSql();
      const result = await dbBatchTool(sql, { queries: "not-array", org_id: "org-1" });
      expect(result).toBe("db-batch requires queries array");
    });

    it("returns error for >10 queries", async () => {
      const { sql } = createMockSql();
      const manyQueries = Array.from({ length: 11 }, (_, i) => ({
        query_id: "issues.summary",
      }));
      const result = await dbBatchTool(sql, { queries: manyQueries, org_id: "org-1" });
      expect(result).toBe("db-batch max 10 queries per batch");
    });

    it("executes multiple queries and returns all results", async () => {
      const { sql } = createMockSql();
      const result = await dbBatchTool(sql, {
        org_id: "org-1",
        queries: [
          { query_id: "sessions.stats", params: { since_days: 7 } },
          { query_id: "issues.summary", params: {} },
          { query_id: "billing.usage", params: { since_days: 30 } },
        ],
      });
      const parsed = JSON.parse(result);
      expect(parsed.batch).toBe(true);
      expect(parsed.count).toBe(3);
      expect(parsed.results).toHaveLength(3);
      expect(parsed.results[0].query_id).toBe("sessions.stats");
      expect(parsed.results[1].query_id).toBe("issues.summary");
      expect(parsed.results[2].query_id).toBe("billing.usage");
    });

    it("handles partial failures gracefully", async () => {
      const { sql } = createMockSql();
      const result = await dbBatchTool(sql, {
        org_id: "org-1",
        queries: [
          { query_id: "issues.summary", params: {} },
          { query_id: "totally.bogus", params: {} },
        ],
      });
      const parsed = JSON.parse(result);
      expect(parsed.count).toBe(2);
      // First should succeed
      expect(parsed.results[0].query_id).toBe("issues.summary");
      // Second should contain error
      expect(parsed.results[1].error).toBeDefined();
      expect(parsed.results[1].error).toContain("db-query failed");
    });

    it("accepts exactly 10 queries", async () => {
      const { sql } = createMockSql();
      const tenQueries = Array.from({ length: 10 }, () => ({
        query_id: "issues.summary",
      }));
      const result = await dbBatchTool(sql, { queries: tenQueries, org_id: "org-1" });
      const parsed = JSON.parse(result);
      expect(parsed.batch).toBe(true);
      expect(parsed.count).toBe(10);
    });
  });

  describe("db-report", () => {
    it("returns error for missing report_id", async () => {
      const { sql } = createMockSql();
      const result = await dbReportTool(sql, { org_id: "org-1" });
      expect(result).toContain("db-report requires report_id");
    });

    it("returns error for unknown report_id", async () => {
      const { sql } = createMockSql();
      const result = await dbReportTool(sql, { report_id: "not_real", org_id: "org-1" });
      expect(result).toContain("Unknown report_id");
      expect(result).toContain("agent_health");
      expect(result).toContain("org_overview");
    });

    it("agent_health returns sessions + issues + eval + feedback", async () => {
      const { sql } = createMockSql();
      const result = await dbReportTool(sql, {
        report_id: "agent_health",
        agent_name: "my-bot",
        org_id: "org-1",
      });
      const parsed = JSON.parse(result);
      expect(parsed.report).toBe("agent_health");
      expect(parsed.agent_name).toBe("my-bot");
      expect(parsed).toHaveProperty("sessions");
      expect(parsed).toHaveProperty("issues");
      expect(parsed).toHaveProperty("eval");
      expect(parsed).toHaveProperty("feedback");
    });

    it("org_overview returns sessions + issues + billing", async () => {
      const { sql } = createMockSql();
      const result = await dbReportTool(sql, {
        report_id: "org_overview",
        org_id: "org-1",
      });
      const parsed = JSON.parse(result);
      expect(parsed.report).toBe("org_overview");
      expect(parsed).toHaveProperty("sessions");
      expect(parsed).toHaveProperty("issues");
      expect(parsed).toHaveProperty("billing");
      expect(parsed).toHaveProperty("billing_by_agent");
    });

    it("agent_health requires agent_name", async () => {
      const { sql } = createMockSql();
      const result = await dbReportTool(sql, {
        report_id: "agent_health",
        org_id: "org-1",
      });
      expect(result).toContain("agent_health report requires agent_name");
    });

    it("agent_health batches exactly 4 queries", async () => {
      const { sql, calls } = createMockSql();
      await dbReportTool(sql, {
        report_id: "agent_health",
        agent_name: "my-bot",
        org_id: "org-1",
      });
      // Each query = 3 set_config + 1 data = 4 calls. 4 queries = 16 calls total.
      expect(calls).toHaveLength(16);
    });

    it("org_overview batches exactly 4 queries", async () => {
      const { sql, calls } = createMockSql();
      await dbReportTool(sql, {
        report_id: "org_overview",
        org_id: "org-1",
      });
      // 4 queries x 4 calls each = 16
      expect(calls).toHaveLength(16);
    });
  });
});
