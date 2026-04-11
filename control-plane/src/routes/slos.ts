/**
 * SLOs router — success rate, latency, cost thresholds.
 * Ported from agentos/api/routers/slos.py
 */
import { createRoute, z } from "@hono/zod-openapi";
import type { CurrentUser } from "../auth/types";
import { createOpenAPIRouter } from "../lib/openapi";
import { ErrorSchema, errorResponses } from "../schemas/openapi";
import { withOrgDb } from "../db/client";
import { requireScope } from "../middleware/auth";

export const sloRoutes = createOpenAPIRouter();

function genId(): string {
  const arr = new Uint8Array(6);
  crypto.getRandomValues(arr);
  return [...arr].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const VALID_METRICS = new Set(["success_rate", "p95_latency_ms", "cost_per_run_usd", "avg_turns"]);
const VALID_OPERATORS = new Set(["gte", "lte", "eq"]);

// ── Zod schemas ─────────────────────────────────────────────────

const sloCreateBody = z.object({
  metric: z.enum(["success_rate", "p95_latency_ms", "cost_per_run_usd", "avg_turns"]),
  threshold: z.number(),
  agent_name: z.string().min(1),
  env: z.string().default(""),
  operator: z.enum(["gte", "lte", "eq"]).default("gte"),
  window_hours: z.number().int().positive().default(24),
});

const sloListQuery = z.object({
  agent_name: z.string().optional(),
});

const sloHistoryQuery = z.object({
  slo_id: z.string().optional(),
  since_days: z.coerce.number().int().min(1).max(365).default(30),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
});

// ── GET / ───────────────────────────────────────────────────────

const listSlosRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["SLOs"],
  summary: "List SLO definitions",
  middleware: [requireScope("slos:read")],
  request: { query: sloListQuery },
  responses: {
    200: { description: "List of SLOs", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(401),
  },
});

sloRoutes.openapi(listSlosRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { agent_name: agentName } = c.req.valid("query");
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    let rows;
    if (agentName) {
      rows = await sql`
        SELECT * FROM slo_definitions WHERE agent_name = ${agentName}
      `;
    } else {
      rows = await sql`SELECT * FROM slo_definitions`;
    }
    return c.json({ slos: rows });
  });
});

// ── POST / ──────────────────────────────────────────────────────

const createSloRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["SLOs"],
  summary: "Create an SLO definition",
  middleware: [requireScope("slos:write")],
  request: { body: { content: { "application/json": { schema: sloCreateBody } } } },
  responses: {
    200: { description: "SLO created", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(400, 401),
  },
});

sloRoutes.openapi(createSloRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const body = c.req.valid("json");
  const { metric, threshold, agent_name: agentName, env, operator, window_hours: windowHours } = body;

  if (!VALID_METRICS.has(metric)) return c.json({ error: `Unknown metric: ${metric}` }, 400);
  if (!VALID_OPERATORS.has(operator)) return c.json({ error: `Unknown operator: ${operator}` }, 400);

  const sloId = genId();

  return await withOrgDb(c.env, user.org_id, async (sql) => {
    await sql`
      INSERT INTO slo_definitions (slo_id, org_id, agent_name, env, metric, threshold, operator, window_hours)
      VALUES (${sloId}, ${user.org_id}, ${agentName}, ${env}, ${metric}, ${threshold}, ${operator}, ${windowHours})
    `;

    return c.json({ slo_id: sloId, metric, threshold, operator });
  });
});

// ── DELETE /:slo_id ─────────────────────────────────────────────

const deleteSloRoute = createRoute({
  method: "delete",
  path: "/{slo_id}",
  tags: ["SLOs"],
  summary: "Delete an SLO definition",
  middleware: [requireScope("slos:write")],
  request: {
    params: z.object({ slo_id: z.string() }),
  },
  responses: {
    200: { description: "SLO deleted", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(401),
  },
});

sloRoutes.openapi(deleteSloRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { slo_id: sloId } = c.req.valid("param");
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    await sql`DELETE FROM slo_definitions WHERE slo_id = ${sloId}`;
    return c.json({ deleted: sloId });
  });
});

// ── GET /status ─────────────────────────────────────────────────

const sloStatusRoute = createRoute({
  method: "get",
  path: "/status",
  tags: ["SLOs"],
  summary: "Evaluate all SLOs and return current status",
  middleware: [requireScope("slos:read")],
  responses: {
    200: { description: "SLO status", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(401),
  },
});

sloRoutes.openapi(sloStatusRoute, async (c): Promise<any> => {
  const user = c.get("user");
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const slos = await sql`SELECT * FROM slo_definitions`;
    const results: any[] = [];

    for (const slo of slos) {
      const s = slo as any;
      const since = new Date(Date.now() - s.window_hours * 3600 * 1000).toISOString();
      let current: number | null = null;

      try {
        if (s.metric === "success_rate") {
          const rows = s.agent_name
            ? await sql`
                SELECT CAST(SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) AS FLOAT) / NULLIF(COUNT(*), 0) as val
                FROM sessions WHERE created_at >= ${since} AND agent_name = ${s.agent_name}
              `
            : await sql`
                SELECT CAST(SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) AS FLOAT) / NULLIF(COUNT(*), 0) as val
                FROM sessions WHERE created_at >= ${since}
              `;
          current = rows[0]?.val != null ? Number(rows[0].val) : null;
        } else if (s.metric === "p95_latency_ms") {
          const rows = s.agent_name
            ? await sql`
                SELECT PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY wall_clock_seconds * 1000) as val
                FROM sessions WHERE created_at >= ${since} AND agent_name = ${s.agent_name}
              `
            : await sql`
                SELECT PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY wall_clock_seconds * 1000) as val
                FROM sessions WHERE created_at >= ${since}
              `;
          current = rows[0]?.val != null ? Number(rows[0].val) : null;
        } else if (s.metric === "cost_per_run_usd") {
          const rows = s.agent_name
            ? await sql`
                SELECT AVG(cost_total_usd) as val FROM sessions
                WHERE created_at >= ${since} AND agent_name = ${s.agent_name}
              `
            : await sql`
                SELECT AVG(cost_total_usd) as val FROM sessions
                WHERE created_at >= ${since}
              `;
          current = rows[0]?.val != null ? Number(rows[0].val) : null;
        } else if (s.metric === "avg_turns") {
          const rows = s.agent_name
            ? await sql`
                SELECT AVG(step_count) as val FROM sessions
                WHERE created_at >= ${since} AND agent_name = ${s.agent_name}
              `
            : await sql`
                SELECT AVG(step_count) as val FROM sessions
                WHERE created_at >= ${since}
              `;
          current = rows[0]?.val != null ? Number(rows[0].val) : null;
        }
      } catch {}

      let breached = false;
      if (current !== null) {
        if (s.operator === "gte") breached = current < s.threshold;
        else if (s.operator === "lte") breached = current > s.threshold;
        else if (s.operator === "eq") breached = current !== s.threshold;
      }

      results.push({ ...s, current_value: current, breached });

      // ── Persist evaluation to history ──────────────────────────────────
      const evalId = genId();
      try {
        await sql`
          INSERT INTO slo_evaluations (eval_id, org_id, slo_id, metric, agent_name, threshold, actual_value, breached, window_hours)
          VALUES (${evalId}, ${user.org_id}, ${s.slo_id}, ${s.metric}, ${s.agent_name}, ${s.threshold}, ${current}, ${breached}, ${s.window_hours})
        `;
      } catch {}

      // ── Update error budget for current month ─────────────────────────
      const now = new Date();
      const monthKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
      try {
        await sql`
          INSERT INTO slo_error_budgets (org_id, slo_id, month, total_evaluations, breaches, budget_remaining_pct)
          VALUES (${user.org_id}, ${s.slo_id}, ${monthKey}, 1, ${breached ? 1 : 0}, ${breached ? 99.0 : 100.0})
          ON CONFLICT (org_id, slo_id, month)
          DO UPDATE SET
            total_evaluations = slo_error_budgets.total_evaluations + 1,
            breaches = slo_error_budgets.breaches + ${breached ? 1 : 0},
            budget_remaining_pct = GREATEST(0, 100.0 - (
              (slo_error_budgets.breaches + ${breached ? 1 : 0})::FLOAT
              / (slo_error_budgets.total_evaluations + 1)::FLOAT
              * 100.0
            ))
        `;
      } catch {}
    }

    return c.json({ slos: results, breached_count: results.filter((r) => r.breached).length });
  });
});

// ── GET /history ────────────────────────────────────────────────

const sloHistoryRoute = createRoute({
  method: "get",
  path: "/history",
  tags: ["SLOs"],
  summary: "Get SLO evaluation history",
  middleware: [requireScope("slos:read")],
  request: { query: sloHistoryQuery },
  responses: {
    200: { description: "SLO evaluation history", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(401),
  },
});

sloRoutes.openapi(sloHistoryRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { slo_id: sloId, since_days: sinceDays, limit } = c.req.valid("query");
  const since = new Date(Date.now() - sinceDays * 86400 * 1000).toISOString();

  return await withOrgDb(c.env, user.org_id, async (sql) => {
    let rows;
    if (sloId) {
      rows = await sql`
        SELECT * FROM slo_evaluations
        WHERE slo_id = ${sloId} AND created_at >= ${since}
        ORDER BY created_at DESC
        LIMIT ${limit}
      `;
    } else {
      rows = await sql`
        SELECT * FROM slo_evaluations
        WHERE created_at >= ${since}
        ORDER BY created_at DESC
        LIMIT ${limit}
      `;
    }

    return c.json({ evaluations: rows, count: rows.length });
  });
});

// ── GET /error-budgets ──────────────────────────────────────────

const errorBudgetsRoute = createRoute({
  method: "get",
  path: "/error-budgets",
  tags: ["SLOs"],
  summary: "Get error budgets for all SLOs",
  middleware: [requireScope("slos:read")],
  responses: {
    200: { description: "Error budgets", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(401),
  },
});

sloRoutes.openapi(errorBudgetsRoute, async (c): Promise<any> => {
  const user = c.get("user");
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const rows = await sql`
      SELECT eb.slo_id, sd.metric, eb.month, eb.total_evaluations, eb.breaches, eb.budget_remaining_pct
      FROM slo_error_budgets eb
      JOIN slo_definitions sd ON sd.slo_id = eb.slo_id AND sd.org_id = eb.org_id
      ORDER BY eb.month DESC, sd.metric
    `;

    return c.json({ error_budgets: rows });
  });
});

// ── GET /error-budgets/:slo_id ──────────────────────────────────

const errorBudgetBySloRoute = createRoute({
  method: "get",
  path: "/error-budgets/{slo_id}",
  tags: ["SLOs"],
  summary: "Get error budget for a specific SLO",
  middleware: [requireScope("slos:read")],
  request: {
    params: z.object({ slo_id: z.string() }),
  },
  responses: {
    200: { description: "SLO error budget", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(401, 404),
  },
});

sloRoutes.openapi(errorBudgetBySloRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { slo_id: sloId } = c.req.valid("param");
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const slo = await sql`
      SELECT * FROM slo_definitions WHERE slo_id = ${sloId}
    `;
    if (!slo.length) return c.json({ error: "SLO not found" }, 404);

    const budgets = await sql`
      SELECT month, total_evaluations, breaches, budget_remaining_pct
      FROM slo_error_budgets
      WHERE slo_id = ${sloId}
      ORDER BY month DESC
    `;

    return c.json({ slo: slo[0], budgets });
  });
});
