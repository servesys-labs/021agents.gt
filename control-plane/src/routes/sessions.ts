/**
 * Sessions router — list, detail, turns, traces, feedback.
 * Ported from agentos/api/routers/sessions.py
 */
import { createRoute, z } from "@hono/zod-openapi";
import type { CurrentUser } from "../auth/types";
import { createOpenAPIRouter } from "../lib/openapi";
import { ErrorSchema, errorResponses } from "../schemas/openapi";
import { getDbForOrg } from "../db/client";
import { requireScope } from "../middleware/auth";

export const sessionRoutes = createOpenAPIRouter();

// ── Route definitions ───────────────────────────────────────────────

const getRuntimeInsightsRoute = createRoute({
  method: "get",
  path: "/runtime/insights",
  tags: ["Sessions"],
  summary: "Get runtime insights",
  middleware: [requireScope("sessions:read")],
  request: {
    query: z.object({
      since_days: z.coerce.number().int().min(1).max(90).default(30),
      limit_sessions: z.coerce.number().int().min(10).max(200).default(200),
    }),
  },
  responses: {
    200: { description: "Runtime insights", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(401, 500),
  },
});

sessionRoutes.openapi(getRuntimeInsightsRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { since_days: sinceDays, limit_sessions: limitSessions } = c.req.valid("query");
  const since = new Date(Date.now() - sinceDays * 86400 * 1000).toISOString();
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  // Aggregate runtime insights
  const [stats] = await sql`
    SELECT COUNT(*) as total_sessions,
           COALESCE(AVG(wall_clock_seconds), 0) as avg_duration,
           COALESCE(SUM(cost_total_usd), 0) as total_cost,
           COALESCE(AVG(step_count), 0) as avg_steps
    FROM sessions
    WHERE org_id = ${user.org_id} AND created_at >= ${since}
    LIMIT ${limitSessions}
  `;

  return c.json({
    total_sessions: Number(stats.total_sessions),
    avg_duration_seconds: Number(stats.avg_duration),
    total_cost_usd: Number(stats.total_cost),
    avg_steps: Number(stats.avg_steps),
  });
});

const getStatsSummaryRoute = createRoute({
  method: "get",
  path: "/stats/summary",
  tags: ["Sessions"],
  summary: "Get session stats summary",
  middleware: [requireScope("sessions:read")],
  request: {
    query: z.object({
      agent_name: z.string().default(""),
      since_days: z.coerce.number().int().min(1).max(90).default(30),
    }),
  },
  responses: {
    200: { description: "Stats summary", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(401, 500),
  },
});

sessionRoutes.openapi(getStatsSummaryRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { agent_name: agentName, since_days: sinceDays } = c.req.valid("query");
  const since = new Date(Date.now() - sinceDays * 86400 * 1000).toISOString();
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  let summaryRows;
  if (agentName) {
    summaryRows = await sql`
      SELECT COUNT(*) as total, COALESCE(SUM(cost_total_usd), 0) as cost, COALESCE(AVG(wall_clock_seconds), 0) as avg_duration
      FROM sessions WHERE org_id = ${user.org_id} AND created_at >= ${since} AND agent_name = ${agentName}
    `;
  } else {
    summaryRows = await sql`
      SELECT COUNT(*) as total, COALESCE(SUM(cost_total_usd), 0) as cost, COALESCE(AVG(wall_clock_seconds), 0) as avg_duration
      FROM sessions WHERE org_id = ${user.org_id} AND created_at >= ${since}
    `;
  }
  const r = summaryRows[0] as any;

  let statusRows;
  if (agentName) {
    statusRows = await sql`
      SELECT status, COUNT(*) as cnt FROM sessions
      WHERE org_id = ${user.org_id} AND created_at >= ${since} AND agent_name = ${agentName}
      GROUP BY status
    `;
  } else {
    statusRows = await sql`
      SELECT status, COUNT(*) as cnt FROM sessions
      WHERE org_id = ${user.org_id} AND created_at >= ${since}
      GROUP BY status
    `;
  }

  const byStatus: Record<string, number> = {};
  for (const s of statusRows) byStatus[s.status] = Number(s.cnt);

  return c.json({
    total_sessions: Number(r.total) || 0,
    total_cost_usd: Number(r.cost) || 0,
    avg_duration_seconds: Number(r.avg_duration) || 0,
    by_status: byStatus,
  });
});

const listSessionsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Sessions"],
  summary: "List sessions",
  middleware: [requireScope("sessions:read")],
  request: {
    query: z.object({
      agent_name: z.string().default(""),
      status: z.string().default(""),
      limit: z.coerce.number().int().min(1).max(200).default(50),
      offset: z.coerce.number().int().min(0).default(0),
    }),
  },
  responses: {
    200: { description: "Session list", content: { "application/json": { schema: z.array(z.record(z.unknown())) } } },
    ...errorResponses(401, 500),
  },
});

sessionRoutes.openapi(listSessionsRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { agent_name: agentName, status, limit, offset } = c.req.valid("query");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  let rows;
  if (agentName && status) {
    rows = await sql`
      SELECT * FROM sessions WHERE org_id = ${user.org_id} AND agent_name = ${agentName} AND status = ${status}
      ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}
    `;
  } else if (agentName) {
    rows = await sql`
      SELECT * FROM sessions WHERE org_id = ${user.org_id} AND agent_name = ${agentName}
      ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}
    `;
  } else if (status) {
    rows = await sql`
      SELECT * FROM sessions WHERE org_id = ${user.org_id} AND status = ${status}
      ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}
    `;
  } else {
    rows = await sql`
      SELECT * FROM sessions WHERE org_id = ${user.org_id}
      ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}
    `;
  }

  return c.json(
    rows.map((r: any) => ({
      session_id: r.session_id || "",
      agent_name: r.agent_name || "",
      status: r.status || "",
      input_text: (r.input_text || "").slice(0, 200),
      output_text: (r.output_text || "").slice(0, 200),
      step_count: Number(r.step_count || 0),
      cost_total_usd: Number(r.cost_total_usd || 0),
      wall_clock_seconds: Number(r.wall_clock_seconds || 0),
      trace_id: r.trace_id || "",
      parent_session_id: r.parent_session_id || null,
      depth: Number(r.depth || 0),
      created_at: Number(r.created_at || 0),
    })),
  );
});

const getSessionRoute = createRoute({
  method: "get",
  path: "/{session_id}",
  tags: ["Sessions"],
  summary: "Get session detail",
  middleware: [requireScope("sessions:read")],
  request: {
    params: z.object({ session_id: z.string() }),
  },
  responses: {
    200: { description: "Session detail", content: { "application/json": { schema: z.record(z.unknown()) } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    ...errorResponses(401, 500),
  },
});

sessionRoutes.openapi(getSessionRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { session_id: sessionId } = c.req.valid("param");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const rows = await sql`SELECT * FROM sessions WHERE session_id = ${sessionId} AND org_id = ${user.org_id}`;
  if (rows.length === 0) return c.json({ error: "Session not found" }, 404);
  const r = rows[0] as any;
  return c.json({
    session_id: r.session_id || "",
    agent_name: r.agent_name || "",
    status: r.status || "",
    input_text: r.input_text || "",
    output_text: r.output_text || "",
    step_count: Number(r.step_count || 0),
    cost_total_usd: Number(r.cost_total_usd || 0),
    wall_clock_seconds: Number(r.wall_clock_seconds || 0),
    trace_id: r.trace_id || "",
    parent_session_id: r.parent_session_id || null,
    depth: Number(r.depth || 0),
    created_at: Number(r.created_at || 0),
  });
});

const getSessionTurnsRoute = createRoute({
  method: "get",
  path: "/{session_id}/turns",
  tags: ["Sessions"],
  summary: "Get session turns",
  middleware: [requireScope("sessions:read")],
  request: {
    params: z.object({ session_id: z.string() }),
  },
  responses: {
    200: { description: "Turn list", content: { "application/json": { schema: z.array(z.record(z.unknown())) } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    ...errorResponses(401, 500),
  },
});

sessionRoutes.openapi(getSessionTurnsRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { session_id: sessionId } = c.req.valid("param");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  // Verify session belongs to org before querying turns
  const ownerCheck = await sql`
    SELECT 1 FROM sessions WHERE session_id = ${sessionId} AND org_id = ${user.org_id}
  `;
  if (ownerCheck.length === 0) return c.json({ error: "Session not found" }, 404);

  const rows = await sql`
    SELECT * FROM turns WHERE session_id = ${sessionId} ORDER BY turn_number
  `;

  return c.json(
    rows.map((r: any) => {
      let toolCalls: any[] = [];
      let toolResults: any[] = [];
      let planArtifact: any = {};
      let reflection: any = {};
      try { toolCalls = JSON.parse(r.tool_calls_json || "[]"); } catch {}
      try { toolResults = JSON.parse(r.tool_results_json || "[]"); } catch {}
      try { planArtifact = JSON.parse(r.plan_json || "{}"); } catch {}
      try { reflection = JSON.parse(r.reflection_json || "{}"); } catch {}

      return {
        turn_number: Number(r.turn_number || 0),
        model_used: r.model_used || "",
        input_tokens: Number(r.input_tokens || 0),
        output_tokens: Number(r.output_tokens || 0),
        latency_ms: Number(r.latency_ms || 0),
        content: r.llm_content || "",
        cost_total_usd: Number(r.cost_total_usd || 0),
        tool_calls: toolCalls,
        tool_results: toolResults,
        execution_mode: r.execution_mode || "sequential",
        plan_artifact: planArtifact,
        reflection,
        started_at: Number(r.started_at || 0),
        ended_at: Number(r.ended_at || 0),
      };
    }),
  );
});

const getSessionRuntimeRoute = createRoute({
  method: "get",
  path: "/{session_id}/runtime",
  tags: ["Sessions"],
  summary: "Get session runtime profile",
  middleware: [requireScope("sessions:read")],
  request: {
    params: z.object({ session_id: z.string() }),
  },
  responses: {
    200: { description: "Runtime profile", content: { "application/json": { schema: z.record(z.unknown()) } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    ...errorResponses(401, 500),
  },
});

sessionRoutes.openapi(getSessionRuntimeRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { session_id: sessionId } = c.req.valid("param");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const check = await sql`SELECT session_id FROM sessions WHERE session_id = ${sessionId} AND org_id = ${user.org_id}`;
  if (check.length === 0) return c.json({ error: "Session not found" }, 404);

  // Build runtime profile from turns
  const turns = await sql`
    SELECT turn_number, execution_mode, plan_json, reflection_json, latency_ms, cost_total_usd
    FROM turns WHERE session_id = ${sessionId} ORDER BY turn_number
  `;

  return c.json({
    session_id: sessionId,
    turns: turns.map((t: any) => ({
      turn_number: Number(t.turn_number),
      execution_mode: t.execution_mode || "sequential",
      plan: (() => { try { return JSON.parse(t.plan_json || "{}"); } catch { return {}; } })(),
      reflection: (() => { try { return JSON.parse(t.reflection_json || "{}"); } catch { return {}; } })(),
      latency_ms: Number(t.latency_ms || 0),
      cost_total_usd: Number(t.cost_total_usd || 0),
    })),
  });
});

const getSessionTraceRoute = createRoute({
  method: "get",
  path: "/{session_id}/trace",
  tags: ["Sessions"],
  summary: "Get session trace with cost rollup",
  middleware: [requireScope("sessions:read")],
  request: {
    params: z.object({ session_id: z.string() }),
  },
  responses: {
    200: { description: "Trace detail", content: { "application/json": { schema: z.record(z.unknown()) } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    ...errorResponses(401, 500),
  },
});

sessionRoutes.openapi(getSessionTraceRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { session_id: sessionId } = c.req.valid("param");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const sessionRows = await sql`SELECT trace_id FROM sessions WHERE session_id = ${sessionId} AND org_id = ${user.org_id}`;
  if (sessionRows.length === 0 || !sessionRows[0].trace_id) {
    return c.json({ error: "No trace found for session" }, 404);
  }
  const traceId = sessionRows[0].trace_id;

  const sessions = await sql`
    SELECT * FROM sessions WHERE trace_id = ${traceId} AND org_id = ${user.org_id} ORDER BY created_at
  `;

  // Cost rollup — scope to org via trace_id already validated above, but also filter by org_id
  const billing = await sql`
    SELECT COALESCE(SUM(total_cost_usd), 0) as total_cost,
           COALESCE(SUM(input_tokens), 0) as total_input_tokens,
           COALESCE(SUM(output_tokens), 0) as total_output_tokens,
           COUNT(*) as records
    FROM billing_records WHERE trace_id = ${traceId} AND org_id = ${user.org_id}
  `;

  return c.json({
    trace_id: traceId,
    sessions,
    cost_rollup: {
      total_cost_usd: Number(billing[0]?.total_cost || 0),
      total_input_tokens: Number(billing[0]?.total_input_tokens || 0),
      total_output_tokens: Number(billing[0]?.total_output_tokens || 0),
      billing_records: Number(billing[0]?.records || 0),
    },
  });
});

const postSessionFeedbackRoute = createRoute({
  method: "post",
  path: "/{session_id}/feedback",
  tags: ["Sessions"],
  summary: "Submit session feedback",
  middleware: [requireScope("sessions:write")],
  request: {
    params: z.object({ session_id: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            rating: z.number().default(0),
            comment: z.string().default(""),
            tags: z.string().default(""),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Feedback submitted", content: { "application/json": { schema: z.record(z.unknown()) } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    ...errorResponses(401, 500),
  },
});

sessionRoutes.openapi(postSessionFeedbackRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { session_id: sessionId } = c.req.valid("param");
  const body = c.req.valid("json");
  const rating = Number(body.rating || 0);
  const comment = String(body.comment || "");
  const tags = String(body.tags || "");

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const check = await sql`SELECT session_id FROM sessions WHERE session_id = ${sessionId} AND org_id = ${user.org_id}`;
  if (check.length === 0) return c.json({ error: "Session not found" }, 404);

  const now = new Date().toISOString();
  await sql`
    INSERT INTO session_feedback (session_id, rating, comment, tags, created_at)
    VALUES (${sessionId}, ${rating}, ${comment}, ${tags}, ${now})
  `;
  return c.json({ submitted: true, session_id: sessionId });
});

const getSessionFeedbackRoute = createRoute({
  method: "get",
  path: "/{session_id}/feedback",
  tags: ["Sessions"],
  summary: "Get session feedback",
  middleware: [requireScope("sessions:read")],
  request: {
    params: z.object({ session_id: z.string() }),
  },
  responses: {
    200: { description: "Feedback list", content: { "application/json": { schema: z.record(z.unknown()) } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    ...errorResponses(401, 500),
  },
});

sessionRoutes.openapi(getSessionFeedbackRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { session_id: sessionId } = c.req.valid("param");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  // Verify session belongs to org before returning feedback
  const ownerCheck = await sql`
    SELECT 1 FROM sessions WHERE session_id = ${sessionId} AND org_id = ${user.org_id}
  `;
  if (ownerCheck.length === 0) return c.json({ error: "Session not found" }, 404);

  const rows = await sql`
    SELECT * FROM session_feedback WHERE session_id = ${sessionId} ORDER BY created_at DESC
  `;
  return c.json({ feedback: rows });
});

const deleteSessionsRoute = createRoute({
  method: "delete",
  path: "/",
  tags: ["Sessions"],
  summary: "Purge old sessions",
  middleware: [requireScope("sessions:write")],
  request: {
    query: z.object({
      before_days: z.coerce.number().int().min(7).default(90),
    }),
  },
  responses: {
    200: { description: "Deleted count", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(401, 500),
  },
});

sessionRoutes.openapi(deleteSessionsRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { before_days: beforeDays } = c.req.valid("query");
  const cutoff = new Date(Date.now() - beforeDays * 86400 * 1000).toISOString();
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  // Delete turns for the sessions we're about to delete (before deleting sessions)
  await sql`
    DELETE FROM turns WHERE session_id IN (
      SELECT session_id FROM sessions WHERE created_at < ${cutoff} AND org_id = ${user.org_id}
    )
  `;
  // Then delete the sessions
  const result = await sql`DELETE FROM sessions WHERE created_at < ${cutoff} AND org_id = ${user.org_id}`;

  return c.json({ deleted: result.count, before_days: beforeDays });
});

// ══════════════════════════════════════════════════════════════════════
// Phase 8.1: Session Search & Export
// ══════════════════════════════════════════════════════════════════════

/**
 * GET /search — Full-text search across sessions with filters
 */
sessionRoutes.get("/search", requireScope("sessions:read"), async (c) => {
  const user = c.get("user") as CurrentUser;
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const q = c.req.query("q") || "";
  const agentName = c.req.query("agent") || "";
  const status = c.req.query("status") || "";
  const minCost = Number(c.req.query("min_cost") || 0);
  const limit = Math.min(Number(c.req.query("limit") || 20), 50);
  const offset = Number(c.req.query("offset") || 0);

  try {
    // Escape LIKE wildcards (% and _) in search query to prevent unintended patterns
    const escapedQ = q.toLowerCase().replace(/%/g, "\\%").replace(/_/g, "\\_");
    let rows: any[];
    if (q) {
      rows = await sql`
        SELECT session_id, agent_name, status, cost_total_usd,
               LEFT(input_text, 100) as input_preview,
               created_at
        FROM sessions
        WHERE org_id = ${user.org_id}
          AND (LOWER(input_text) LIKE ${`%${escapedQ}%`} OR LOWER(output_text) LIKE ${`%${escapedQ}%`})
          ${agentName ? sql`AND agent_name = ${agentName}` : sql``}
          ${status ? sql`AND status = ${status}` : sql``}
          ${minCost > 0 ? sql`AND COALESCE(cost_total_usd, 0) >= ${minCost}` : sql``}
        ORDER BY created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
    } else {
      rows = await sql`
        SELECT session_id, agent_name, status, cost_total_usd,
               LEFT(input_text, 100) as input_preview,
               created_at
        FROM sessions
        WHERE org_id = ${user.org_id}
          ${agentName ? sql`AND agent_name = ${agentName}` : sql``}
          ${status ? sql`AND status = ${status}` : sql``}
          ${minCost > 0 ? sql`AND COALESCE(cost_total_usd, 0) >= ${minCost}` : sql``}
        ORDER BY created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
    }
    return c.json({ results: rows, query: q, limit, offset });
  } catch (err) {
    return c.json({ results: [], error: String(err) }, 500);
  }
});

/**
 * GET /:session_id/export — Export session as JSON or CSV
 */
sessionRoutes.get("/:session_id/export", requireScope("sessions:read"), async (c) => {
  const user = c.get("user") as CurrentUser;
  const sessionId = c.req.param("session_id");
  const format = c.req.query("format") || "json";
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  try {
    const session = await sql`
      SELECT * FROM sessions WHERE session_id = ${sessionId} AND org_id = ${user.org_id}
    `;
    if (session.length === 0) return c.json({ error: "Session not found" }, 404);

    const turns = await sql`
      SELECT turn_number, model_used, llm_content, input_tokens, output_tokens,
             cost_total_usd, latency_ms, tool_calls_json, tool_results_json
      FROM turns WHERE session_id = ${sessionId}
      ORDER BY turn_number ASC
    `;

    if (format === "csv") {
      const header = "turn_number,model,input_tokens,output_tokens,cost_usd,latency_ms,content\n";
      const rows = turns.map((t: any) =>
        `${t.turn_number},"${t.model_used}",${t.input_tokens},${t.output_tokens},${t.cost_total_usd},${t.latency_ms},"${(t.llm_content || "").replace(/"/g, '""').slice(0, 500)}"`
      ).join("\n");
      return new Response(header + rows, {
        headers: { "Content-Type": "text/csv", "Content-Disposition": `attachment; filename="session-${sessionId}.csv"` },
      });
    }

    const parsedTurns = (turns as any[]).map((t) => {
      let tool_calls: unknown[] = [];
      let tool_results: unknown[] = [];
      try { tool_calls = JSON.parse(t.tool_calls_json || "[]"); } catch {}
      try { tool_results = JSON.parse(t.tool_results_json || "[]"); } catch {}
      return {
        ...t,
        content: t.llm_content,
        tool_calls,
        tool_results,
      };
    });

    return c.json({ session: session[0], turns: parsedTurns });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});
