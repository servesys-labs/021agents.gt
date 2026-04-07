/**
 * AgentOS Internal Ops Dashboard
 *
 * Sentry-style monitoring portal for internal use.
 * Serves HTML dashboard + JSON API endpoints.
 * Auth: simple password gate (OPS_PASSWORD env var).
 */

import postgres from "postgres";

import { DASHBOARD_HTML } from "./dashboard-html";

interface Env {
  HYPERDRIVE: Hyperdrive;
  OPS_PASSWORD: string;
}

// ── Auth ──────────────────────────────────────────────────────
function checkAuth(request: Request, env: Env): Response | null {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(/ops_token=([^;]+)/);
  if (match && match[1] === btoa(env.OPS_PASSWORD)) return null; // authenticated
  return null; // TODO: enable auth after initial setup
}

// ── DB helper ─────────────────────────────────────────────────
function getDb(env: Env) {
  return postgres(env.HYPERDRIVE.connectionString, {
    max: 3,
    fetch_types: false,
    prepare: false,
    idle_timeout: 20,
    connect_timeout: 10,
  });
}

// ── API handlers ──────────────────────────────────────────────
async function queryOrEmpty<T extends Record<string, unknown>>(
  label: string,
  run: () => Promise<T[]>,
  emptyRow: T
): Promise<T> {
  try {
    const rows = await run();
    return rows[0] ?? emptyRow;
  } catch (e) {
    console.error(`[ops] ${label}`, e);
    return emptyRow;
  }
}

async function handleApi(path: string, env: Env): Promise<Response> {
  const sql = getDb(env);
  try {
    if (path === "/api/overview") {
      const sessionsEmpty = {
        total: 0,
        last_24h: 0,
        last_1h: 0,
        total_cost: 0,
        cost_24h: 0,
        avg_latency_24h: 0,
      };
      const billingEmpty = {
        total: 0,
        last_24h: 0,
        input_tokens_24h: 0,
        output_tokens_24h: 0,
        zero_token_24h: 0,
      };
      const countPairEmpty = { total: 0, last_24h: 0 };
      const agentsEmpty = { total: 0, active: 0 };
      const orgsEmpty = { total: 0 };

      const [sessions, billing, turns, events, agents, orgs] = await Promise.all([
        queryOrEmpty("overview:sessions", () => sql`
            SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS last_24h,
            COUNT(*) FILTER (WHERE created_at > now() - interval '1 hour')::int AS last_1h,
            COALESCE(SUM(cost_total_usd), 0)::float8 AS total_cost,
            COALESCE(SUM(cost_total_usd) FILTER (WHERE created_at > now() - interval '24 hours'), 0)::float8 AS cost_24h,
            COALESCE(AVG(wall_clock_seconds) FILTER (WHERE created_at > now() - interval '24 hours'), 0)::float8 AS avg_latency_24h
            FROM sessions`,
          sessionsEmpty),
        queryOrEmpty("overview:billing", () => sql`
            SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS last_24h,
            COALESCE(SUM(input_tokens) FILTER (WHERE created_at > now() - interval '24 hours'), 0)::float8 AS input_tokens_24h,
            COALESCE(SUM(output_tokens) FILTER (WHERE created_at > now() - interval '24 hours'), 0)::float8 AS output_tokens_24h,
            COUNT(*) FILTER (WHERE input_tokens = 0 AND created_at > now() - interval '24 hours')::int AS zero_token_24h
            FROM billing_records`,
          billingEmpty),
        queryOrEmpty("overview:turns", () => sql`
            SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS last_24h FROM turns`,
          countPairEmpty),
        queryOrEmpty("overview:runtime_events", () => sql`
            SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS last_24h FROM runtime_events`,
          countPairEmpty),
        queryOrEmpty("overview:agents", () => sql`
            SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE is_active = true)::int AS active FROM agents`,
          agentsEmpty),
        queryOrEmpty("overview:orgs", () => sql`SELECT COUNT(*)::int AS total FROM orgs`, orgsEmpty),
      ]);
      return json({
        sessions,
        billing,
        turns,
        runtime_events: events,
        agents,
        orgs,
      });
    }

    if (path === "/api/sessions/recent") {
      const rows = await sql`
        SELECT session_id, org_id, agent_name, model, status, cost_total_usd,
               step_count, wall_clock_seconds, created_at,
               trace_id,
               COALESCE(repair_count, 0) AS repair_count,
               COALESCE(compaction_count, 0) AS compaction_count,
               COALESCE(total_cache_read_tokens, 0) AS total_cache_read_tokens,
               COALESCE(total_cache_write_tokens, 0) AS total_cache_write_tokens
        FROM sessions ORDER BY created_at DESC LIMIT 50
      `;
      return json(rows);
    }

    if (path === "/api/billing/recent") {
      const rows = await sql`
        SELECT session_id, org_id, agent_name, model, input_tokens, output_tokens,
               inference_cost_usd, created_at
        FROM billing_records ORDER BY created_at DESC LIMIT 50
      `;
      return json(rows);
    }

    if (path === "/api/turns/recent") {
      const rows = await sql`
        SELECT
          session_id, turn_number, model_used,
          input_tokens, output_tokens, cost_total_usd,
          latency_ms, llm_latency_ms, stop_reason, execution_mode,
          refusal,
          cache_read_tokens, cache_write_tokens, gateway_log_id,
          COALESCE(jsonb_array_length(COALESCE(tool_calls_json, '[]'::jsonb)), 0) AS tool_call_count,
          COALESCE(jsonb_array_length(COALESCE(tool_results_json, '[]'::jsonb)), 0) AS tool_result_count,
          COALESCE(jsonb_array_length(COALESCE(errors_json, '[]'::jsonb)), 0) AS error_count,
          COALESCE(jsonb_array_length(COALESCE(middleware_warnings_json, '[]'::jsonb)), 0) AS mw_warn_count,
          created_at
        FROM turns
        ORDER BY created_at DESC
        LIMIT 50
      `;
      return json(rows);
    }

    /** Aggregated per-turn signals for the last 24h (what the runtime writes each turn). */
    if (path === "/api/turns/summary-24h") {
      const [agg] = await sql`
        SELECT
          COUNT(*)::int AS turns_24h,
          COUNT(*) FILTER (WHERE refusal = true)::int AS refusals_24h,
          COUNT(*) FILTER (WHERE COALESCE(jsonb_array_length(COALESCE(errors_json, '[]'::jsonb)), 0) > 0)::int AS turns_with_errors,
          COUNT(*) FILTER (WHERE COALESCE(jsonb_array_length(COALESCE(tool_calls_json, '[]'::jsonb)), 0) > 0)::int AS turns_with_tools,
          ROUND(AVG(NULLIF(llm_latency_ms, 0))::numeric, 1) AS avg_llm_ms,
          ROUND(AVG(NULLIF(latency_ms, 0))::numeric, 1) AS avg_wall_ms,
          COALESCE(SUM(cache_read_tokens), 0)::bigint AS sum_cache_read,
          COALESCE(SUM(cache_write_tokens), 0)::bigint AS sum_cache_write,
          ROUND(AVG(jsonb_array_length(COALESCE(tool_calls_json, '[]'::jsonb)))::numeric, 2) AS avg_tool_calls_per_turn,
          COUNT(*) FILTER (WHERE COALESCE(jsonb_array_length(COALESCE(middleware_warnings_json, '[]'::jsonb)), 0) > 0)::int AS turns_with_mw_warnings
        FROM turns
        WHERE created_at > now() - interval '24 hours'
      `;
      return json(agg ?? {});
    }

    if (path === "/api/turns/stop-reasons-24h") {
      const rows = await sql`
        SELECT COALESCE(NULLIF(trim(COALESCE(stop_reason, '')), ''), 'unknown') AS stop_reason, COUNT(*)::int AS cnt
        FROM turns
        WHERE created_at > now() - interval '24 hours'
        GROUP BY 1
        ORDER BY cnt DESC
        LIMIT 16
      `;
      return json(rows);
    }

    if (path === "/api/turns/execution-modes-24h") {
      const rows = await sql`
        SELECT COALESCE(NULLIF(trim(COALESCE(execution_mode, '')), ''), 'unknown') AS mode, COUNT(*)::int AS cnt
        FROM turns
        WHERE created_at > now() - interval '24 hours'
        GROUP BY 1
        ORDER BY cnt DESC
      `;
      return json(rows);
    }

    if (path === "/api/sessions/summary-24h") {
      const [agg] = await sql`
        SELECT
          COALESCE(SUM(repair_count), 0)::bigint AS repairs,
          COALESCE(SUM(compaction_count), 0)::bigint AS compactions,
          COALESCE(SUM(total_cache_read_tokens), 0)::bigint AS sum_cache_read,
          COALESCE(SUM(total_cache_write_tokens), 0)::bigint AS sum_cache_write,
          COUNT(*)::int AS sessions_started_24h
        FROM sessions
        WHERE created_at > now() - interval '24 hours'
      `;
      return json(agg ?? {});
    }

    if (path === "/api/tools/top-24h") {
      try {
        const rows = await sql`
          SELECT elem->>'name' AS tool_name, COUNT(*)::int AS call_count
          FROM turns,
            LATERAL jsonb_array_elements(COALESCE(tool_calls_json, '[]'::jsonb)) AS elem
          WHERE created_at > now() - interval '24 hours'
            AND elem ? 'name'
            AND length(trim(elem->>'name')) > 0
          GROUP BY 1
          ORDER BY call_count DESC
          LIMIT 24
        `;
        return json(rows);
      } catch (e) {
        console.error("[ops] tools/top-24h", e);
        return json([]);
      }
    }

    if (path === "/api/middleware/recent") {
      const rows = await sql`
        SELECT session_id, middleware_name, action, turn_number, created_at,
               details_json
        FROM middleware_events
        ORDER BY created_at DESC
        LIMIT 50
      `;
      return json(rows);
    }

    if (path === "/api/audit/recent") {
      const rows = await sql`
        SELECT created_at, org_id, actor_id, action, resource_type, resource_name, details
        FROM audit_log
        ORDER BY created_at DESC
        LIMIT 50
      `;
      return json(rows);
    }

    if (path === "/api/runtime-events/recent") {
      const rows = await sql`
        SELECT event_type, node_id, status, latency_ms, session_id, org_id, created_at
        FROM runtime_events ORDER BY created_at DESC LIMIT 50
      `;
      return json(rows);
    }

    /** Sentry-style performance: turn wall-clock vs LLM latency percentiles (24h). */
    if (path === "/api/performance/turn-latency-24h") {
      const [wall] = await sql`
        SELECT
          ROUND(percentile_cont(0.50) WITHIN GROUP (ORDER BY latency_ms))::int AS p50,
          ROUND(percentile_cont(0.75) WITHIN GROUP (ORDER BY latency_ms))::int AS p75,
          ROUND(percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms))::int AS p95,
          ROUND(percentile_cont(0.99) WITHIN GROUP (ORDER BY latency_ms))::int AS p99,
          COUNT(*)::int AS samples
        FROM turns
        WHERE created_at > now() - interval '24 hours' AND latency_ms > 0
      `;
      const [llm] = await sql`
        SELECT
          ROUND(percentile_cont(0.50) WITHIN GROUP (ORDER BY llm_latency_ms))::int AS p50,
          ROUND(percentile_cont(0.75) WITHIN GROUP (ORDER BY llm_latency_ms))::int AS p75,
          ROUND(percentile_cont(0.95) WITHIN GROUP (ORDER BY llm_latency_ms))::int AS p95,
          ROUND(percentile_cont(0.99) WITHIN GROUP (ORDER BY llm_latency_ms))::int AS p99,
          COUNT(*)::int AS samples
        FROM turns
        WHERE created_at > now() - interval '24 hours' AND llm_latency_ms > 0
      `;
      return json({
        wall: wall ?? { p50: null, p75: null, p95: null, p99: null, samples: 0 },
        llm: llm ?? { p50: null, p75: null, p95: null, p99: null, samples: 0 },
      });
    }

    /** Hourly turn volume for throughput sparkline / bar chart (last 24h). */
    if (path === "/api/trends/turns-hourly-24h") {
      try {
        const rows = await sql`
          SELECT date_trunc('hour', created_at) AS hour, COUNT(*)::int AS turns
          FROM turns
          WHERE created_at > now() - interval '24 hours'
          GROUP BY 1
          ORDER BY 1 ASC
        `;
        return json(rows);
      } catch (e) {
        console.error("[ops] trends/turns-hourly-24h", e);
        return json([]);
      }
    }

    /** Regressed / risky turns for an “issue detail” style list (Sentry-like stream). */
    if (path === "/api/turns/regressed-recent") {
      const rows = await sql`
        SELECT session_id, turn_number, model_used, latency_ms, llm_latency_ms,
               COALESCE(jsonb_array_length(COALESCE(errors_json, '[]'::jsonb)), 0) AS error_count,
               refusal, stop_reason, execution_mode, created_at
        FROM turns
        WHERE created_at > now() - interval '24 hours'
          AND (
            refusal = true
            OR COALESCE(jsonb_array_length(COALESCE(errors_json, '[]'::jsonb)), 0) > 0
            OR COALESCE(jsonb_array_length(COALESCE(middleware_warnings_json, '[]'::jsonb)), 0) > 0
          )
        ORDER BY created_at DESC
        LIMIT 40
      `;
      return json(rows);
    }

    if (path === "/api/queue-health") {
      // Check for signs of queue issues: sessions without turns, billing without tokens
      const [orphanSessions, zeroBilling, recentErrors] = await Promise.all([
        sql`SELECT COUNT(*) as cnt FROM sessions s
            WHERE s.created_at > now() - interval '1 hour'
            AND NOT EXISTS (SELECT 1 FROM turns t WHERE t.session_id = s.session_id)`,
        sql`SELECT COUNT(*) as cnt FROM billing_records
            WHERE created_at > now() - interval '1 hour' AND input_tokens = 0`,
        sql`SELECT event_type, COUNT(*) as cnt FROM runtime_events
            WHERE created_at > now() - interval '1 hour'
            GROUP BY event_type ORDER BY cnt DESC LIMIT 10`,
      ]);
      return json({
        orphan_sessions_1h: Number(orphanSessions[0]?.cnt) || 0,
        zero_token_billing_1h: Number(zeroBilling[0]?.cnt) || 0,
        event_breakdown_1h: recentErrors,
      });
    }

    if (path === "/api/cost-analysis") {
      const rows = await sql`
        SELECT date_trunc('hour', created_at) as hour,
               COUNT(*) as sessions,
               COALESCE(SUM(cost_total_usd), 0) as cost_usd,
               COALESCE(AVG(cost_total_usd), 0) as avg_cost,
               COALESCE(AVG(wall_clock_seconds), 0) as avg_latency_s
        FROM sessions
        WHERE created_at > now() - interval '48 hours'
        GROUP BY hour ORDER BY hour DESC
      `;
      return json(rows);
    }

    if (path === "/api/model-usage") {
      const rows = await sql`
        SELECT model_used as model, COUNT(*) as turns,
               COALESCE(SUM(input_tokens), 0) as input_tokens,
               COALESCE(SUM(output_tokens), 0) as output_tokens,
               COALESCE(SUM(cost_total_usd), 0) as cost_usd
        FROM turns WHERE created_at > now() - interval '24 hours'
        GROUP BY model_used ORDER BY cost_usd DESC
      `;
      return json(rows);
    }

    if (path === "/api/credits") {
      const rows = await sql`
        SELECT o.name as org_name, c.org_id, c.balance_usd,
               c.lifetime_purchased_usd, c.lifetime_consumed_usd, c.updated_at
        FROM org_credit_balance c
        JOIN orgs o ON o.org_id = c.org_id
        ORDER BY c.balance_usd ASC
      `;
      return json(rows);
    }

    if (path === "/api/table-stats") {
      const rows = await sql`
        SELECT relname as table_name, n_live_tup as row_estimate,
               pg_size_pretty(pg_total_relation_size(quote_ident(relname))) as total_size
        FROM pg_stat_user_tables
        WHERE schemaname = 'public'
        ORDER BY pg_total_relation_size(quote_ident(relname)) DESC
        LIMIT 30
      `;
      return json(rows);
    }

    return json({ error: "Not found" }, 404);
  } finally {
    await sql.end().catch(() => {});
  }
}

function json(data: unknown, status = 200) {
  return new Response(
    JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? Number(v) : v)),
    {
      status,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    }
  );
}

// ── Main handler ──────────────────────────────────────────────
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Auth check
    const authResp = checkAuth(request, env);
    if (authResp) return authResp;

    // Login endpoint
    if (url.pathname === "/login" && request.method === "POST") {
      const body = await request.formData();
      const pw = body.get("password");
      if (pw === env.OPS_PASSWORD) {
        return new Response("OK", {
          status: 302,
          headers: {
            Location: "/",
            "Set-Cookie": `ops_token=${btoa(env.OPS_PASSWORD)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`,
          },
        });
      }
      return new Response("Invalid password", { status: 401 });
    }

    // API routes
    if (url.pathname.startsWith("/api/")) {
      return handleApi(url.pathname, env);
    }

    // Dashboard HTML
    return new Response(DASHBOARD_HTML, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  },
};
