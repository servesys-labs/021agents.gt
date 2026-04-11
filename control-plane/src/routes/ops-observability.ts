/**
 * Ops-observability router — agent health, latency percentiles, error breakdown,
 * webhook health, batch status, concurrency, cost-budget, rate-limit logs, alert testing.
 */
import { createRoute, z } from "@hono/zod-openapi";
import { createOpenAPIRouter } from "../lib/openapi";
import { ErrorSchema, errorResponses } from "../schemas/openapi";
import type { CurrentUser } from "../auth/types";
import { withOrgDb } from "../db/client";
import { requireScope } from "../middleware/auth";

export const opsObservabilityRoutes = createOpenAPIRouter();

// ---------------------------------------------------------------------------
// 1. GET /agents/{name}/health — Agent health check
// ---------------------------------------------------------------------------
const agentHealthRoute = createRoute({
  method: "get",
  path: "/agents/{name}/health",
  tags: ["Ops Observability"],
  summary: "Agent health check",
  middleware: [requireScope("observability:read")],
  request: {
    params: z.object({ name: z.string() }),
    query: z.object({
      window_minutes: z.coerce.number().optional(),
    }),
  },
  responses: {
    200: { description: "Agent health status", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(401, 403),
  },
});
opsObservabilityRoutes.openapi(agentHealthRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { name: agentName } = c.req.valid("param");
  const query = c.req.valid("query");
  const windowMinutes = Math.max(1, Math.min(1440, Number(query.window_minutes) || 30));
  return await withOrgDb(c.env, user.org_id, async (sql) => {

  const since = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString();
  const oneHourAgo = new Date(Date.now() - 3600 * 1000).toISOString();

  // Recent-window query (for healthy / down determination)
  const [recent] = await sql`
    SELECT
      MAX(created_at) AS last_run_at,
      MAX(CASE WHEN status = 'success' THEN created_at END) AS last_success_at
    FROM sessions
    WHERE agent_name = ${agentName}
      AND created_at >= ${since}
  `;

  // 1-hour stats for error rate, avg latency, session count
  const [hourly] = await sql`
    SELECT
      COUNT(*)::int AS sessions_1h,
      COALESCE(SUM(CASE WHEN status != 'success' THEN 1 ELSE 0 END)::float / NULLIF(COUNT(*), 0), 0) AS error_rate_1h,
      COALESCE(AVG(wall_clock_seconds) * 1000, 0) AS avg_latency_1h_ms
    FROM sessions
    WHERE agent_name = ${agentName}
      AND created_at >= ${oneHourAgo}
  `;

  const lastRunAt = recent.last_run_at ?? null;
  const lastSuccessAt = recent.last_success_at ?? null;
  const errorRate = Number(hourly.error_rate_1h);

  let status: "healthy" | "degraded" | "down";
  if (!lastRunAt) {
    status = "down";
  } else if (errorRate > 0.1) {
    status = "degraded";
  } else {
    status = "healthy";
  }

  return c.json({
    agent_name: agentName,
    status,
    last_run_at: lastRunAt,
    last_success_at: lastSuccessAt,
    error_rate_1h: errorRate,
    avg_latency_1h_ms: Number(hourly.avg_latency_1h_ms),
    sessions_1h: Number(hourly.sessions_1h),
  });
  });
});

// ---------------------------------------------------------------------------
// 2. GET /latency-percentiles — Latency distribution
// ---------------------------------------------------------------------------
const latencyPercentilesRoute = createRoute({
  method: "get",
  path: "/latency-percentiles",
  tags: ["Ops Observability"],
  summary: "Latency distribution percentiles",
  middleware: [requireScope("observability:read")],
  request: {
    query: z.object({
      agent_name: z.string().optional(),
      since_hours: z.coerce.number().optional(),
    }),
  },
  responses: {
    200: { description: "Latency percentiles", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(401, 403),
  },
});
opsObservabilityRoutes.openapi(latencyPercentilesRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const query = c.req.valid("query");
  const agentName = query.agent_name || "";
  const sinceHours = Math.max(1, Math.min(720, Number(query.since_hours) || 24));
  const since = new Date(Date.now() - sinceHours * 3600 * 1000).toISOString();
  return await withOrgDb(c.env, user.org_id, async (sql) => {

  const agentFilter = agentName
    ? sql`AND agent_name = ${agentName}`
    : sql``;

  const [row] = await sql`
    SELECT
      COUNT(*)::int AS count,
      COALESCE(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY wall_clock_seconds), 0) * 1000 AS p50_ms,
      COALESCE(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY wall_clock_seconds), 0) * 1000 AS p75_ms,
      COALESCE(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY wall_clock_seconds), 0) * 1000 AS p95_ms,
      COALESCE(PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY wall_clock_seconds), 0) * 1000 AS p99_ms
    FROM sessions
    WHERE wall_clock_seconds IS NOT NULL
      ${agentFilter}
      AND created_at >= ${since}
  `;

  return c.json({
    p50_ms: Number(row.p50_ms),
    p75_ms: Number(row.p75_ms),
    p95_ms: Number(row.p95_ms),
    p99_ms: Number(row.p99_ms),
    count: Number(row.count),
    since_hours: sinceHours,
  });
  });
});

// ---------------------------------------------------------------------------
// 3. GET /error-breakdown — Error categorisation
// ---------------------------------------------------------------------------
const errorBreakdownRoute = createRoute({
  method: "get",
  path: "/error-breakdown",
  tags: ["Ops Observability"],
  summary: "Error categorisation breakdown",
  middleware: [requireScope("observability:read")],
  request: {
    query: z.object({
      agent_name: z.string().optional(),
      since_hours: z.coerce.number().optional(),
    }),
  },
  responses: {
    200: { description: "Error breakdown", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(401, 403),
  },
});
opsObservabilityRoutes.openapi(errorBreakdownRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const query = c.req.valid("query");
  const agentName = query.agent_name || "";
  const sinceHours = Math.max(1, Math.min(720, Number(query.since_hours) || 24));
  const since = new Date(Date.now() - sinceHours * 3600 * 1000).toISOString();
  return await withOrgDb(c.env, user.org_id, async (sql) => {

  const agentFilter = agentName
    ? sql`AND agent_name = ${agentName}`
    : sql``;

  // By-status breakdown
  const statusRows = await sql`
    SELECT status, COUNT(*)::int AS count
    FROM sessions
    WHERE 1=1
      ${agentFilter}
      AND created_at >= ${since}
    GROUP BY status
  `;

  const byStatus: Record<string, number> = {};
  let total = 0;
  let errors = 0;
  for (const r of statusRows) {
    const s = String(r.status);
    const cnt = Number(r.count);
    byStatus[s] = cnt;
    total += cnt;
    if (s !== "success") errors += cnt;
  }

  // By-agent breakdown
  const agentRows = await sql`
    SELECT agent_name,
           COUNT(*)::int AS total,
           SUM(CASE WHEN status != 'success' THEN 1 ELSE 0 END)::int AS errors
    FROM sessions
    WHERE 1=1
      ${agentFilter}
      AND created_at >= ${since}
    GROUP BY agent_name
    ORDER BY total DESC
  `;

  const byAgent = agentRows.map((r) => ({
    name: r.agent_name,
    total: Number(r.total),
    errors: Number(r.errors),
    error_rate: Number(r.total) > 0 ? Number(r.errors) / Number(r.total) : 0,
  }));

  return c.json({
    total,
    by_status: byStatus,
    error_rate: total > 0 ? errors / total : 0,
    by_agent: byAgent,
  });
  });
});

// ---------------------------------------------------------------------------
// 4. GET /webhooks/health — Webhook delivery health
// ---------------------------------------------------------------------------
const webhookHealthRoute = createRoute({
  method: "get",
  path: "/webhooks/health",
  tags: ["Ops Observability"],
  summary: "Webhook delivery health",
  middleware: [requireScope("observability:read")],
  request: {
    query: z.object({
      window_minutes: z.coerce.number().optional(),
    }),
  },
  responses: {
    200: { description: "Webhook health summary", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(401, 403),
  },
});
opsObservabilityRoutes.openapi(webhookHealthRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const query = c.req.valid("query");
  const windowMinutes = Math.max(1, Math.min(1440, Number(query.window_minutes) || 60));
  const since = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString();
  return await withOrgDb(c.env, user.org_id, async (sql) => {

  // webhook_deliveries is NOT RLS-enforced; keep the explicit org filter.
  const [totals] = await sql`
    SELECT
      COUNT(*)::int AS total_deliveries,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END)::int AS successful,
      SUM(CASE WHEN status != 'success' THEN 1 ELSE 0 END)::int AS failed
    FROM webhook_deliveries
    WHERE org_id = ${user.org_id}
      AND created_at >= ${since}
  `;

  const byWebhook = await sql`
    SELECT
      wd.webhook_id,
      w.url,
      COUNT(*)::int AS total,
      SUM(CASE WHEN wd.status = 'success' THEN 1 ELSE 0 END)::int AS successful,
      SUM(CASE WHEN wd.status != 'success' THEN 1 ELSE 0 END)::int AS failed
    FROM webhook_deliveries wd
    LEFT JOIN webhooks w ON w.webhook_id = wd.webhook_id AND w.org_id = wd.org_id
    WHERE wd.org_id = ${user.org_id}
      AND wd.created_at >= ${since}
    GROUP BY wd.webhook_id, w.url
    ORDER BY total DESC
  `;

  const totalDeliveries = Number(totals.total_deliveries);
  const successful = Number(totals.successful);
  const failed = Number(totals.failed);

  return c.json({
    total_deliveries: totalDeliveries,
    successful,
    failed,
    success_rate: totalDeliveries > 0 ? successful / totalDeliveries : 0,
    by_webhook: byWebhook.map((r) => ({
      webhook_id: r.webhook_id,
      url: r.url,
      total: Number(r.total),
      successful: Number(r.successful),
      failed: Number(r.failed),
    })),
  });
  });
});

// ---------------------------------------------------------------------------
// 5. GET /batch/status — Batch job overview
// ---------------------------------------------------------------------------
const batchStatusRoute = createRoute({
  method: "get",
  path: "/batch/status",
  tags: ["Ops Observability"],
  summary: "Batch job overview",
  middleware: [requireScope("observability:read")],
  responses: {
    200: { description: "Batch status counts", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(401, 403),
  },
});
opsObservabilityRoutes.openapi(batchStatusRoute, async (c): Promise<any> => {
  const user = c.get("user");
  return await withOrgDb(c.env, user.org_id, async (sql) => {

  const statusRows = await sql`
    SELECT status, COUNT(*)::int AS count
    FROM batch_jobs
    GROUP BY status
  `;

  const counts: Record<string, number> = {
    pending: 0,
    running: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
  };
  for (const r of statusRows) {
    counts[String(r.status)] = Number(r.count);
  }

  const [tasks] = await sql`
    SELECT
      COALESCE(SUM(total_tasks), 0)::int AS total_tasks,
      COALESCE(SUM(completed_tasks), 0)::int AS completed_tasks,
      COALESCE(SUM(failed_tasks), 0)::int AS failed_tasks
    FROM batch_jobs
  `;

  return c.json({
    ...counts,
    total_tasks: Number(tasks.total_tasks),
    completed_tasks: Number(tasks.completed_tasks),
    failed_tasks: Number(tasks.failed_tasks),
  });
  });
});

// ---------------------------------------------------------------------------
// 6. GET /concurrent — Concurrent sessions
// ---------------------------------------------------------------------------
const concurrentRoute = createRoute({
  method: "get",
  path: "/concurrent",
  tags: ["Ops Observability"],
  summary: "Concurrent sessions",
  middleware: [requireScope("observability:read")],
  responses: {
    200: { description: "Concurrency stats", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(401, 403),
  },
});
opsObservabilityRoutes.openapi(concurrentRoute, async (c): Promise<any> => {
  const user = c.get("user");
  return await withOrgDb(c.env, user.org_id, async (sql) => {
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();

  const [row] = await sql`
    SELECT
      COUNT(*) FILTER (WHERE status = 'running')::int AS running_sessions,
      COUNT(DISTINCT user_id) FILTER (WHERE created_at >= ${fiveMinAgo})::int AS unique_users_5m,
      COUNT(DISTINCT agent_name) FILTER (WHERE status = 'running' OR created_at >= ${fiveMinAgo})::int AS agents_active
    FROM sessions
    WHERE (status = 'running' OR created_at >= ${fiveMinAgo})
  `;

  return c.json({
    running_sessions: Number(row.running_sessions),
    unique_users_5m: Number(row.unique_users_5m),
    agents_active: Number(row.agents_active),
  });
  });
});

// ---------------------------------------------------------------------------
// 7. GET /cost-budget — Cost vs budget
// ---------------------------------------------------------------------------
const costBudgetRoute = createRoute({
  method: "get",
  path: "/cost-budget",
  tags: ["Ops Observability"],
  summary: "Cost vs budget",
  middleware: [requireScope("observability:read")],
  responses: {
    200: { description: "Cost budget summary", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(401, 403),
  },
});
opsObservabilityRoutes.openapi(costBudgetRoute, async (c): Promise<any> => {
  const user = c.get("user");
  return await withOrgDb(c.env, user.org_id, async (sql) => {

  const [settings] = await sql`
    SELECT budget_monthly_usd
    FROM org_settings
  `;

  const budgetMonthly = Number(settings?.budget_monthly_usd ?? 0);

  // Spend this calendar month
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

  const [spend] = await sql`
    SELECT COALESCE(SUM(total_cost_usd), 0) AS spent
    FROM billing_records
    WHERE created_at >= ${monthStart}
  `;

  const spentThisMonth = Number(spend.spent);
  const dayOfMonth = now.getDate();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const daysRemaining = daysInMonth - dayOfMonth;
  const dailyRate = dayOfMonth > 0 ? spentThisMonth / dayOfMonth : 0;
  const projectedMonthly = dailyRate * daysInMonth;
  const pctUsed = budgetMonthly > 0 ? spentThisMonth / budgetMonthly : 0;
  // Alert if projected spend exceeds 90% of budget
  const alert = budgetMonthly > 0 && projectedMonthly > budgetMonthly * 0.9;

  return c.json({
    budget_monthly_usd: budgetMonthly,
    spent_this_month_usd: spentThisMonth,
    pct_used: pctUsed,
    days_remaining: daysRemaining,
    projected_monthly_usd: projectedMonthly,
    alert,
  });
  });
});

// ---------------------------------------------------------------------------
// 8. GET /rate-limits/log — Rate limit breach log
// ---------------------------------------------------------------------------
const rateLimitsLogRoute = createRoute({
  method: "get",
  path: "/rate-limits/log",
  tags: ["Ops Observability"],
  summary: "Rate limit breach log",
  middleware: [requireScope("observability:read")],
  responses: {
    200: { description: "Rate limit breaches", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(401, 403),
  },
});
opsObservabilityRoutes.openapi(rateLimitsLogRoute, async (c): Promise<any> => {
  const user = c.get("user");
  return await withOrgDb(c.env, user.org_id, async (sql) => {
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

  const [total] = await sql`
    SELECT COUNT(*)::int AS total_breaches_24h
    FROM api_access_log
    WHERE status_code = 429
      AND created_at >= ${twentyFourHoursAgo}
  `;

  const byKey = await sql`
    SELECT
      api_key_id,
      COUNT(*)::int AS breaches,
      MAX(created_at) AS last_breach_at
    FROM api_access_log
    WHERE status_code = 429
      AND created_at >= ${twentyFourHoursAgo}
    GROUP BY api_key_id
    ORDER BY breaches DESC
  `;

  return c.json({
    total_breaches_24h: Number(total.total_breaches_24h),
    by_key: byKey.map((r) => ({
      api_key_id: r.api_key_id,
      breaches: Number(r.breaches),
      last_breach_at: r.last_breach_at,
    })),
  });
  });
});

// ---------------------------------------------------------------------------
// 9. POST /alerts/test — Test alert delivery
// ---------------------------------------------------------------------------
const alertsTestRoute = createRoute({
  method: "post",
  path: "/alerts/test",
  tags: ["Ops Observability"],
  summary: "Test alert delivery",
  middleware: [requireScope("observability:read")],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            url: z.string().min(1),
            type: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Alert test result", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(400, 401, 403),
  },
});
opsObservabilityRoutes.openapi(alertsTestRoute, async (c): Promise<any> => {
  const body = c.req.valid("json");
  const url = String(body.url || "").trim();
  const alertType = String(body.type || "error_rate");

  if (!url) return c.json({ error: "url is required" }, 400);

  const validTypes = new Set(["error_rate", "latency", "cost", "agent_down"]);
  if (!validTypes.has(alertType)) {
    return c.json({ error: `Invalid alert type: ${alertType}. Must be one of: ${[...validTypes].join(", ")}` }, 400);
  }

  const payload = {
    alert_type: alertType,
    severity: "test",
    message: `Test ${alertType} alert from OneShots`,
    timestamp: new Date().toISOString(),
    org_id: c.get("user").org_id,
    test: true,
  };

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    return c.json({
      delivered: resp.ok,
      status_code: resp.status,
      payload,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return c.json({
      delivered: false,
      error: message,
      payload,
    }, 502);
  }
});
