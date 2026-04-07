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

  // ── Agent stats ──────────────────────────────────────────
  let total_agents = 0;
  let live_agents = 0;
  let agentNames: string[] = [];
  try {
    const [agentStats] = await sql`
      SELECT
        COUNT(*) as total,
        COALESCE(SUM(CASE WHEN is_active = true THEN 1 ELSE 0 END), 0) as live
      FROM agents
      WHERE org_id = ${user.org_id} AND is_active = true
    `;
    total_agents = Number(agentStats.total);
    live_agents = Number(agentStats.live);

    const nameRows = await sql`SELECT name FROM agents WHERE org_id = ${user.org_id} AND is_active = true`;
    agentNames = nameRows.map((a: any) => String(a.name));
  } catch (err) {
    console.error("[dashboard] Agent stats failed:", err);
  }

  // ── Session stats ────────────────────────────────────────
  // Sessions may have org_id = '' (empty) from telemetry pipeline.
  // Match by org_id OR by agent_name belonging to this org's agents.
  let total_sessions = 0;
  let active_sessions = 0;
  let total_runs = 0;
  let avg_latency_ms = 0;
  let error_rate_pct = 0;
  try {
    // Query sessions matching org OR agent names (handles empty org_id from telemetry)
    const sessionQuery = agentNames.length > 0
      ? sql`
          SELECT
            COUNT(*) as total,
            COALESCE(SUM(CASE WHEN status = 'running' OR (created_at > now() - interval '2 minutes' AND status = 'success') THEN 1 ELSE 0 END), 0) as active,
            COALESCE(SUM(COALESCE(step_count, 0) + COALESCE(action_count, 0)), 0) as runs,
            COALESCE(AVG(NULLIF(wall_clock_seconds, 0)), 0) as avg_latency_s,
            COALESCE(
              SUM(CASE WHEN status IN ('error', 'failed') THEN 1 ELSE 0 END)::float
              / NULLIF(COUNT(*), 0), 0
            ) as error_rate
          FROM sessions
          WHERE org_id = ${user.org_id}
             OR agent_name IN (${sql(agentNames)})
        `
      : sql`
          SELECT
            COUNT(*) as total, 0 as active, 0 as runs, 0 as avg_latency_s, 0 as error_rate
          FROM sessions
          WHERE org_id = ${user.org_id}
        `;

    const [sessionStats] = await sessionQuery;
    total_sessions = Number(sessionStats.total);
    active_sessions = Number(sessionStats.active);
    total_runs = Number(sessionStats.runs);
    // wall_clock_seconds is often 0 (not measured) — fall back to turn latency
    avg_latency_ms = Math.round(Number(sessionStats.avg_latency_s) * 1000);
    error_rate_pct = Math.round(Number(sessionStats.error_rate) * 10000) / 100;

    // If wall_clock_seconds is always 0, try computing from turns table
    if (avg_latency_ms === 0 && total_sessions > 0) {
      try {
        const [turnLatency] = await sql`
          SELECT COALESCE(AVG(NULLIF(latency_ms, 0)), 0) as avg_ms
          FROM turns t
          JOIN sessions s ON s.session_id = t.session_id
          WHERE s.org_id = ${user.org_id}
             ${agentNames.length > 0 ? sql`OR s.agent_name IN (${sql(agentNames)})` : sql``}
          LIMIT 1000
        `;
        avg_latency_ms = Math.round(Number(turnLatency.avg_ms));
      } catch {}
    }

    // Fallback: count credit burns as session proxy
    if (total_sessions === 0) {
      try {
        const [txCount] = await sql`
          SELECT COUNT(*) as c FROM credit_transactions
          WHERE org_id = ${user.org_id} AND type = 'burn'
        `;
        total_sessions = Number(txCount.c);
      } catch {}
    }
  } catch (err) {
    console.error("[dashboard] Session stats failed:", err);
  }

  // ── Cost stats ───────────────────────────────────────────
  let total_cost_usd = 0;
  try {
    // Try billing_records first
    const [costStats] = await sql`
      SELECT COALESCE(SUM(total_cost_usd), 0) as cost
      FROM billing_records
      WHERE org_id = ${user.org_id}
    `;
    total_cost_usd = Number(costStats.cost);

    // If billing_records empty, try summing credit burns
    if (total_cost_usd === 0) {
      try {
        const [burnSum] = await sql`
          SELECT COALESCE(SUM(ABS(amount_usd)), 0) as cost
          FROM credit_transactions
          WHERE org_id = ${user.org_id} AND type = 'burn'
        `;
        total_cost_usd = Number(burnSum.cost);
      } catch {}
    }
  } catch (err) {
    console.error("[dashboard] Cost stats failed:", err);
  }

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
    // Get agent names for this org to include sessions with empty org_id
    const nameRows = await sql`SELECT name FROM agents WHERE org_id = ${user.org_id}`;
    const agentNames = nameRows.map((a: any) => String(a.name));

    if (agentNames.length > 0) {
      const rows = await sql`
        SELECT session_id, agent_name, status, created_at
        FROM sessions
        WHERE org_id = ${user.org_id}
           OR agent_name = ANY(${agentNames})
        ORDER BY created_at DESC
        LIMIT ${limit}
      `;

      activity = rows.map((r: any) => {
        // Handle both epoch numbers and ISO date strings
        let ts: number;
        const raw = r.created_at;
        if (typeof raw === "number") {
          ts = raw;
        } else if (typeof raw === "string") {
          const parsed = new Date(raw).getTime();
          ts = isNaN(parsed) ? Math.floor(Date.now() / 1000) : Math.floor(parsed / 1000);
        } else {
          ts = Math.floor(Date.now() / 1000);
        }

        return {
          id: String(r.session_id),
          type: String(r.status) === "error" ? "error" : "session",
          message: `Session ${String(r.status)} for agent ${String(r.agent_name)}`,
          agent_name: String(r.agent_name || ""),
          timestamp: ts,
        };
      });
    }
  } catch (err) {
    console.error("[dashboard] Activity feed failed:", err);
  }

  return c.json({ activity });
});

// ══════════════════════════════════════════════════════════════════════
// Phase 7.5: Dashboard Deep Drill-Down Endpoints
// ══════════════════════════════════════════════════════════════════════

/**
 * GET /stats/by-agent — Top agents by cost, sessions, and errors
 */
dashboardRoutes.get("/stats/by-agent", requireScope("observability:read"), async (c) => {
  const orgId = c.get("user").org_id;
  const sql = await getDbForOrg(c.env.HYPERDRIVE, orgId);
  try {
    const rows = await sql`
      SELECT
        s.agent_name,
        COUNT(*) as session_count,
        SUM(COALESCE(s.cost_total_usd, 0)) as total_cost_usd,
        AVG(COALESCE(s.wall_clock_seconds, 0)) as avg_latency_s,
        COUNT(*) FILTER (WHERE s.status IN ('error', 'failed')) as error_count,
        ROUND(COUNT(*) FILTER (WHERE s.status IN ('error', 'failed'))::numeric / NULLIF(COUNT(*), 0) * 100, 1) as error_rate_pct
      FROM sessions s
      WHERE (s.org_id = ${orgId} OR s.agent_name IN (SELECT name FROM agents WHERE org_id = ${orgId}))
        AND s.created_at > NOW() - INTERVAL '30 days'
      GROUP BY s.agent_name
      ORDER BY total_cost_usd DESC
      LIMIT 20
    `;
    return c.json({ agents: rows });
  } catch (err) {
    return c.json({ agents: [], error: String(err) });
  }
});

/**
 * GET /stats/by-model — Cost and tokens per model
 */
dashboardRoutes.get("/stats/by-model", requireScope("observability:read"), async (c) => {
  const orgId = c.get("user").org_id;
  const sql = await getDbForOrg(c.env.HYPERDRIVE, orgId);
  try {
    const rows = await sql`
      SELECT
        t.model_used as model,
        COUNT(*) as turn_count,
        SUM(COALESCE(t.input_tokens, 0)) as total_input_tokens,
        SUM(COALESCE(t.output_tokens, 0)) as total_output_tokens,
        SUM(COALESCE(t.cost_total_usd, 0)) as total_cost_usd
      FROM turns t
      JOIN sessions s ON t.session_id = s.session_id
      WHERE (s.org_id = ${orgId} OR s.agent_name IN (SELECT name FROM agents WHERE org_id = ${orgId}))
        AND t.created_at > NOW() - INTERVAL '30 days'
      GROUP BY t.model_used
      ORDER BY total_cost_usd DESC
    `;
    return c.json({ models: rows });
  } catch (err) {
    return c.json({ models: [], error: String(err) });
  }
});

/**
 * GET /stats/tool-health — Per-tool call count, error rate, avg latency
 * Phase 5.3: Circuit breaker observability
 */
dashboardRoutes.get("/stats/tool-health", requireScope("observability:read"), async (c) => {
  const orgId = c.get("user").org_id;
  const sql = await getDbForOrg(c.env.HYPERDRIVE, orgId);
  try {
    // Parse tool_calls JSON from turns to get per-tool stats
    const rows = await sql`
      SELECT
        tool_name,
        COUNT(*) as call_count,
        COUNT(*) FILTER (WHERE error IS NOT NULL AND error != '') as error_count,
        ROUND(AVG(latency_ms)::numeric, 0) as avg_latency_ms,
        ROUND(COUNT(*) FILTER (WHERE error IS NOT NULL AND error != '')::numeric / NULLIF(COUNT(*), 0) * 100, 1) as error_rate_pct
      FROM (
        SELECT
          jsonb_array_elements(COALESCE(tool_results::jsonb, '[]'::jsonb))->>'name' as tool_name,
          (jsonb_array_elements(COALESCE(tool_results::jsonb, '[]'::jsonb))->>'latency_ms')::numeric as latency_ms,
          jsonb_array_elements(COALESCE(tool_results::jsonb, '[]'::jsonb))->>'error' as error
        FROM turns t
        JOIN sessions s ON t.session_id = s.session_id
        WHERE s.org_id = ${orgId}
          AND t.created_at > NOW() - INTERVAL '7 days'
          AND t.tool_results IS NOT NULL AND t.tool_results != '[]'
      ) tool_stats
      WHERE tool_name IS NOT NULL
      GROUP BY tool_name
      ORDER BY error_rate_pct DESC, call_count DESC
      LIMIT 50
    `;
    return c.json({ tools: rows });
  } catch (err) {
    return c.json({ tools: [], error: String(err) });
  }
});

/**
 * GET /stats/routing — Phase 10.1: Intent router feedback (misroute tracking)
 */
dashboardRoutes.get("/stats/routing", requireScope("observability:read"), async (c) => {
  const orgId = c.get("user").org_id;
  const sql = await getDbForOrg(c.env.HYPERDRIVE, orgId);
  try {
    // Find sessions where user started with one agent but the conversation
    // was short (1-2 turns) and low-rated — suggests misroute
    const rows = await sql`
      SELECT
        s.agent_name,
        COUNT(*) as total_sessions,
        COUNT(*) FILTER (WHERE s.step_count <= 2 AND COALESCE(f.rating, 5) <= 2) as likely_misroutes,
        ROUND(AVG(COALESCE(f.rating, 0)) FILTER (WHERE f.rating IS NOT NULL)::numeric, 1) as avg_rating,
        ROUND(COUNT(*) FILTER (WHERE s.step_count <= 2 AND COALESCE(f.rating, 5) <= 2)::numeric / NULLIF(COUNT(*), 0) * 100, 1) as misroute_rate_pct
      FROM sessions s
      LEFT JOIN session_feedback f ON s.session_id = f.session_id
      WHERE s.org_id = ${orgId}
        AND s.created_at > NOW() - INTERVAL '30 days'
      GROUP BY s.agent_name
      HAVING COUNT(*) >= 5
      ORDER BY misroute_rate_pct DESC
    `;
    return c.json({ routing: rows });
  } catch (err) {
    return c.json({ routing: [], error: String(err) });
  }
});

/**
 * GET /stats/trends — Daily cost, sessions, errors over time period
 */
dashboardRoutes.get("/stats/trends", requireScope("observability:read"), async (c) => {
  const orgId = c.get("user").org_id;
  const period = Number(c.req.query("period_days") || 7);
  const sql = await getDbForOrg(c.env.HYPERDRIVE, orgId);
  try {
    const rows = await sql`
      SELECT
        DATE(s.created_at) as day,
        COUNT(*) as sessions,
        SUM(COALESCE(s.cost_total_usd, 0)) as cost_usd,
        COUNT(*) FILTER (WHERE s.status IN ('error', 'failed')) as errors,
        AVG(COALESCE(s.wall_clock_seconds, 0)) as avg_latency_s
      FROM sessions s
      WHERE (s.org_id = ${orgId} OR s.agent_name IN (SELECT name FROM agents WHERE org_id = ${orgId}))
        AND s.created_at > NOW() - INTERVAL '1 day' * ${period}
      GROUP BY DATE(s.created_at)
      ORDER BY day ASC
    `;
    return c.json({ trends: rows, period_days: period });
  } catch (err) {
    return c.json({ trends: [], error: String(err) });
  }
});
