/**
 * Dashboard router — aggregated stats and recent activity for the portal.
 */
import { createRoute, z } from "@hono/zod-openapi";
import { createOpenAPIRouter } from "../lib/openapi";
import { ErrorSchema, errorResponses } from "../schemas/openapi";
import { getDbForOrg } from "../db/client";
import { requireScope } from "../middleware/auth";

export const dashboardRoutes = createOpenAPIRouter();

/**
 * GET /stats
 * Aggregated dashboard statistics from agents, sessions, and billing tables.
 */
const statsRoute = createRoute({
  method: "get",
  path: "/stats",
  tags: ["Dashboard"],
  summary: "Aggregated dashboard statistics",
  middleware: [requireScope("observability:read")],
  responses: {
    200: {
      description: "Dashboard stats",
      content: {
        "application/json": {
          schema: z.object({
            total_agents: z.number(),
            live_agents: z.number(),
            total_sessions: z.number(),
            active_sessions: z.number(),
            total_runs: z.number(),
            avg_latency_ms: z.number(),
            total_cost_usd: z.number(),
            error_rate_pct: z.number(),
          }),
        },
      },
    },
    ...errorResponses(500),
  },
});

dashboardRoutes.openapi(statsRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  let total_agents = 0;
  let live_agents = 0;
  try {
    const [agentStats] = await sql`
      SELECT
        COUNT(*) as total,
        COALESCE(SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END), 0) as live
      FROM agents
      WHERE org_id = ${user.org_id}
    `;
    total_agents = Number(agentStats.total);
    live_agents = Number(agentStats.live);
  } catch {}

  let total_sessions = 0;
  let active_sessions = 0;
  let total_runs = 0;
  let avg_latency_ms = 0;
  let error_rate_pct = 0;
  try {
    const [sessionStats] = await sql`
      SELECT
        COUNT(*) as total,
        COALESCE(SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END), 0) as active,
        COALESCE(SUM(turn_count), 0) as runs,
        COALESCE(AVG(wall_clock_seconds), 0) as avg_latency_s,
        COALESCE(
          SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END)::float
          / NULLIF(COUNT(*), 0), 0
        ) as error_rate
      FROM sessions
      WHERE org_id = ${user.org_id}
    `;
    total_sessions = Number(sessionStats.total);
    active_sessions = Number(sessionStats.active);
    total_runs = Number(sessionStats.runs);
    avg_latency_ms = Math.round(Number(sessionStats.avg_latency_s) * 1000);
    error_rate_pct = Math.round(Number(sessionStats.error_rate) * 10000) / 100;
  } catch {}

  let total_cost_usd = 0;
  try {
    const [costStats] = await sql`
      SELECT COALESCE(SUM(total_cost_usd), 0) as cost
      FROM billing_records
      WHERE org_id = ${user.org_id}
    `;
    total_cost_usd = Number(costStats.cost);
  } catch {}

  return c.json({
    total_agents,
    live_agents,
    total_sessions,
    active_sessions,
    total_runs,
    avg_latency_ms,
    total_cost_usd,
    error_rate_pct,
  });
});

/**
 * GET /activity?limit=10
 * Recent activity feed from sessions table.
 */
const activityRoute = createRoute({
  method: "get",
  path: "/activity",
  tags: ["Dashboard"],
  summary: "Recent activity feed",
  middleware: [requireScope("observability:read")],
  request: {
    query: z.object({
      limit: z.coerce.number().int().min(1).max(100).default(10).openapi({ example: 10 }),
    }),
  },
  responses: {
    200: {
      description: "Activity feed",
      content: {
        "application/json": {
          schema: z.object({
            activity: z.array(z.object({
              id: z.string(),
              type: z.string(),
              message: z.string(),
              agent_name: z.string(),
              timestamp: z.number(),
            })),
          }),
        },
      },
    },
    ...errorResponses(500),
  },
});

dashboardRoutes.openapi(activityRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { limit: rawLimit } = c.req.valid("query");
  const limit = Math.max(1, Math.min(100, Number(rawLimit) || 10));
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  let activity: Array<{
    id: string;
    type: string;
    message: string;
    agent_name: string;
    timestamp: number;
  }> = [];

  try {
    const rows = await sql`
      SELECT session_id, agent_name, status, created_at
      FROM sessions
      WHERE org_id = ${user.org_id}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;

    activity = rows.map((r: any) => ({
      id: String(r.session_id),
      type: String(r.status) === "error" ? "error" : "session",
      message: `Session ${String(r.status)} for agent ${String(r.agent_name)}`,
      agent_name: String(r.agent_name || ""),
      timestamp: Number(r.created_at),
    }));
  } catch {}

  return c.json({ activity });
});
