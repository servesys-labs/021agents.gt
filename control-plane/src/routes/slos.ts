/**
 * SLOs router — success rate, latency, cost thresholds.
 * Ported from agentos/api/routers/slos.py
 */
import { Hono } from "hono";
import type { Env } from "../env";
import type { CurrentUser } from "../auth/types";
import { getDbForOrg } from "../db/client";
import { requireScope } from "../middleware/auth";

type R = { Bindings: Env; Variables: { user: CurrentUser } };
export const sloRoutes = new Hono<R>();

function genId(): string {
  const arr = new Uint8Array(6);
  crypto.getRandomValues(arr);
  return [...arr].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const VALID_METRICS = new Set(["success_rate", "p95_latency_ms", "cost_per_run_usd", "avg_turns"]);
const VALID_OPERATORS = new Set(["gte", "lte", "eq"]);

sloRoutes.get("/", requireScope("slos:read"), async (c) => {
  const user = c.get("user");
  const agentName = c.req.query("agent_name") || "";
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  let rows;
  if (agentName) {
    rows = await sql`
      SELECT * FROM slo_definitions WHERE org_id = ${user.org_id} AND agent_name = ${agentName}
    `;
  } else {
    rows = await sql`SELECT * FROM slo_definitions WHERE org_id = ${user.org_id}`;
  }
  return c.json({ slos: rows });
});

sloRoutes.post("/", requireScope("slos:write"), async (c) => {
  const user = c.get("user");
  const body = await c.req.json();
  const metric = String(body.metric || "");
  const threshold = Number(body.threshold || 0);
  const agentName = String(body.agent_name || "");
  const env = String(body.env || "");
  const operator = String(body.operator || "gte");
  const windowHours = Number(body.window_hours || 24);

  if (!VALID_METRICS.has(metric)) return c.json({ error: `Unknown metric: ${metric}` }, 400);
  if (!VALID_OPERATORS.has(operator)) return c.json({ error: `Unknown operator: ${operator}` }, 400);

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const sloId = genId();

  await sql`
    INSERT INTO slo_definitions (slo_id, org_id, agent_name, env, metric, threshold, operator, window_hours)
    VALUES (${sloId}, ${user.org_id}, ${agentName}, ${env}, ${metric}, ${threshold}, ${operator}, ${windowHours})
  `;

  return c.json({ slo_id: sloId, metric, threshold, operator });
});

sloRoutes.delete("/:slo_id", requireScope("slos:write"), async (c) => {
  const user = c.get("user");
  const sloId = c.req.param("slo_id");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  await sql`DELETE FROM slo_definitions WHERE slo_id = ${sloId} AND org_id = ${user.org_id}`;
  return c.json({ deleted: sloId });
});

sloRoutes.get("/status", requireScope("slos:read"), async (c) => {
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const slos = await sql`SELECT * FROM slo_definitions WHERE org_id = ${user.org_id}`;
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
              FROM sessions WHERE created_at >= ${since} AND agent_name = ${s.agent_name} AND org_id = ${user.org_id}
            `
          : await sql`
              SELECT CAST(SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) AS FLOAT) / NULLIF(COUNT(*), 0) as val
              FROM sessions WHERE created_at >= ${since} AND org_id = ${user.org_id}
            `;
        current = rows[0]?.val != null ? Number(rows[0].val) : null;
      } else if (s.metric === "p95_latency_ms") {
        const rows = s.agent_name
          ? await sql`
              SELECT PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY wall_clock_seconds * 1000) as val
              FROM sessions WHERE created_at >= ${since} AND agent_name = ${s.agent_name} AND org_id = ${user.org_id}
            `
          : await sql`
              SELECT PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY wall_clock_seconds * 1000) as val
              FROM sessions WHERE created_at >= ${since} AND org_id = ${user.org_id}
            `;
        current = rows[0]?.val != null ? Number(rows[0].val) : null;
      } else if (s.metric === "cost_per_run_usd") {
        const rows = s.agent_name
          ? await sql`
              SELECT AVG(cost_total_usd) as val FROM sessions
              WHERE created_at >= ${since} AND agent_name = ${s.agent_name} AND org_id = ${user.org_id}
            `
          : await sql`
              SELECT AVG(cost_total_usd) as val FROM sessions
              WHERE created_at >= ${since} AND org_id = ${user.org_id}
            `;
        current = rows[0]?.val != null ? Number(rows[0].val) : null;
      } else if (s.metric === "avg_turns") {
        const rows = s.agent_name
          ? await sql`
              SELECT AVG(step_count) as val FROM sessions
              WHERE created_at >= ${since} AND agent_name = ${s.agent_name} AND org_id = ${user.org_id}
            `
          : await sql`
              SELECT AVG(step_count) as val FROM sessions
              WHERE created_at >= ${since} AND org_id = ${user.org_id}
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

// ── SLO evaluation history ────────────────────────────────────────────────
sloRoutes.get("/history", requireScope("slos:read"), async (c) => {
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const sloId = c.req.query("slo_id") || "";
  const sinceDays = Math.min(Math.max(Number(c.req.query("since_days") || 30), 1), 365);
  const limit = Math.min(Math.max(Number(c.req.query("limit") || 100), 1), 1000);
  const since = new Date(Date.now() - sinceDays * 86400 * 1000).toISOString();

  let rows;
  if (sloId) {
    rows = await sql`
      SELECT * FROM slo_evaluations
      WHERE org_id = ${user.org_id} AND slo_id = ${sloId} AND created_at >= ${since}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
  } else {
    rows = await sql`
      SELECT * FROM slo_evaluations
      WHERE org_id = ${user.org_id} AND created_at >= ${since}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
  }

  return c.json({ evaluations: rows, count: rows.length });
});

// ── Error budgets (all SLOs) ──────────────────────────────────────────────
sloRoutes.get("/error-budgets", requireScope("slos:read"), async (c) => {
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const rows = await sql`
    SELECT eb.slo_id, sd.metric, eb.month, eb.total_evaluations, eb.breaches, eb.budget_remaining_pct
    FROM slo_error_budgets eb
    JOIN slo_definitions sd ON sd.slo_id = eb.slo_id AND sd.org_id = eb.org_id
    WHERE eb.org_id = ${user.org_id}
    ORDER BY eb.month DESC, sd.metric
  `;

  return c.json({ error_budgets: rows });
});

// ── Error budget for a specific SLO (across months) ───────────────────────
sloRoutes.get("/error-budgets/:slo_id", requireScope("slos:read"), async (c) => {
  const user = c.get("user");
  const sloId = c.req.param("slo_id");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const slo = await sql`
    SELECT * FROM slo_definitions WHERE slo_id = ${sloId} AND org_id = ${user.org_id}
  `;
  if (!slo.length) return c.json({ error: "SLO not found" }, 404);

  const budgets = await sql`
    SELECT month, total_evaluations, breaches, budget_remaining_pct
    FROM slo_error_budgets
    WHERE org_id = ${user.org_id} AND slo_id = ${sloId}
    ORDER BY month DESC
  `;

  return c.json({ slo: slo[0], budgets });
});
