/**
 * Sessions router — list, detail, turns, traces, feedback.
 * Ported from agentos/api/routers/sessions.py
 */
import { Hono } from "hono";
import type { Env } from "../env";
import type { CurrentUser } from "../auth/types";
import { getDbForOrg } from "../db/client";
import { requireScope } from "../middleware/auth";

type R = { Bindings: Env; Variables: { user: CurrentUser } };
export const sessionRoutes = new Hono<R>();

sessionRoutes.get("/runtime/insights", requireScope("sessions:read"), async (c) => {
  const user = c.get("user");
  const sinceDays = Math.max(1, Math.min(90, Number(c.req.query("since_days")) || 30));
  const limitSessions = Math.max(10, Math.min(200, Number(c.req.query("limit_sessions")) || 200));
  const since = Date.now() / 1000 - sinceDays * 86400;
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

sessionRoutes.get("/stats/summary", requireScope("sessions:read"), async (c) => {
  const user = c.get("user");
  const agentName = c.req.query("agent_name") || "";
  const sinceDays = Math.max(1, Math.min(90, Number(c.req.query("since_days")) || 30));
  const since = Date.now() / 1000 - sinceDays * 86400;
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

sessionRoutes.get("/", requireScope("sessions:read"), async (c) => {
  const user = c.get("user");
  const agentName = c.req.query("agent_name") || "";
  const status = c.req.query("status") || "";
  const limit = Math.max(1, Math.min(200, Number(c.req.query("limit")) || 50));
  const offset = Math.max(0, Number(c.req.query("offset")) || 0);
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
      created_at: Number(r.created_at || 0),
    })),
  );
});

sessionRoutes.get("/:session_id", requireScope("sessions:read"), async (c) => {
  const user = c.get("user");
  const sessionId = c.req.param("session_id");
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
    created_at: Number(r.created_at || 0),
  });
});

sessionRoutes.get("/:session_id/turns", requireScope("sessions:read"), async (c) => {
  const user = c.get("user");
  const sessionId = c.req.param("session_id");
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
      let planArtifact: any = {};
      let reflection: any = {};
      try { toolCalls = JSON.parse(r.tool_calls_json || "[]"); } catch {}
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
        execution_mode: r.execution_mode || "sequential",
        plan_artifact: planArtifact,
        reflection,
        started_at: Number(r.started_at || 0),
        ended_at: Number(r.ended_at || 0),
      };
    }),
  );
});

sessionRoutes.get("/:session_id/runtime", requireScope("sessions:read"), async (c) => {
  const user = c.get("user");
  const sessionId = c.req.param("session_id");
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

sessionRoutes.get("/:session_id/trace", requireScope("sessions:read"), async (c) => {
  const user = c.get("user");
  const sessionId = c.req.param("session_id");
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

sessionRoutes.post("/:session_id/feedback", requireScope("sessions:write"), async (c) => {
  const user = c.get("user");
  const sessionId = c.req.param("session_id");
  const body = await c.req.json();
  const rating = Number(body.rating || 0);
  const comment = String(body.comment || "");
  const tags = String(body.tags || "");

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const check = await sql`SELECT session_id FROM sessions WHERE session_id = ${sessionId} AND org_id = ${user.org_id}`;
  if (check.length === 0) return c.json({ error: "Session not found" }, 404);

  const now = Date.now() / 1000;
  await sql`
    INSERT INTO session_feedback (session_id, rating, comment, tags, created_at)
    VALUES (${sessionId}, ${rating}, ${comment}, ${tags}, ${now})
  `;
  return c.json({ submitted: true, session_id: sessionId });
});

sessionRoutes.get("/:session_id/feedback", requireScope("sessions:read"), async (c) => {
  const user = c.get("user");
  const sessionId = c.req.param("session_id");
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

sessionRoutes.delete("/", requireScope("sessions:write"), async (c) => {
  const user = c.get("user");
  const beforeDays = Math.max(7, Number(c.req.query("before_days")) || 90);
  const cutoff = Date.now() / 1000 - beforeDays * 86400;
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
