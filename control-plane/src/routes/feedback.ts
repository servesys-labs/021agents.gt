/**
 * Feedback router — user feedback loop (thumbs up/down) on agent responses.
 *
 * Endpoints:
 *   GET    /           — List feedback (org-scoped, filterable)
 *   GET    /stats      — Aggregate feedback stats
 *   GET    /:id        — Single feedback detail
 *   DELETE /:id        — Delete feedback
 */
import { Hono } from "hono";
import type { Env } from "../env";
import type { CurrentUser } from "../auth/types";
import { getDbForOrg } from "../db/client";
import { requireScope } from "../middleware/auth";

type R = { Bindings: Env; Variables: { user: CurrentUser } };
export const feedbackRoutes = new Hono<R>();

/* ── List feedback ──────────────────────────────────────────────── */

feedbackRoutes.get("/", requireScope("sessions:read"), async (c) => {
  const user = c.get("user");
  const agentName = c.req.query("agent_name") || "";
  const rating = c.req.query("rating") || "";
  const sinceDays = Math.max(1, Math.min(365, Number(c.req.query("since_days")) || 30));
  const limit = Math.min(500, Math.max(1, Number(c.req.query("limit")) || 50));
  const offset = Math.max(0, Number(c.req.query("offset")) || 0);
  const since = Date.now() / 1000 - sinceDays * 86400;

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  let rows;
  if (agentName && rating) {
    rows = await sql`
      SELECT id, session_id, turn_number, rating, comment, message_preview, agent_name, channel, created_at
      FROM user_feedback
      WHERE org_id = ${user.org_id} AND agent_name = ${agentName} AND rating = ${rating} AND created_at >= ${since}
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  } else if (agentName) {
    rows = await sql`
      SELECT id, session_id, turn_number, rating, comment, message_preview, agent_name, channel, created_at
      FROM user_feedback
      WHERE org_id = ${user.org_id} AND agent_name = ${agentName} AND created_at >= ${since}
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  } else if (rating) {
    rows = await sql`
      SELECT id, session_id, turn_number, rating, comment, message_preview, agent_name, channel, created_at
      FROM user_feedback
      WHERE org_id = ${user.org_id} AND rating = ${rating} AND created_at >= ${since}
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  } else {
    rows = await sql`
      SELECT id, session_id, turn_number, rating, comment, message_preview, agent_name, channel, created_at
      FROM user_feedback
      WHERE org_id = ${user.org_id} AND created_at >= ${since}
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  }

  return c.json({ feedback: rows, count: rows.length });
});

/* ── Aggregate stats ────────────────────────────────────────────── */

feedbackRoutes.get("/stats", requireScope("sessions:read"), async (c) => {
  const user = c.get("user");
  const agentName = c.req.query("agent_name") || "";
  const sinceDays = Math.max(1, Math.min(365, Number(c.req.query("since_days")) || 30));
  const since = Date.now() / 1000 - sinceDays * 86400;
  const prevSince = since - sinceDays * 86400;

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  // Current period counts
  const countQuery = agentName
    ? sql`
        SELECT rating, COUNT(*) as cnt
        FROM user_feedback
        WHERE org_id = ${user.org_id} AND agent_name = ${agentName} AND created_at >= ${since}
        GROUP BY rating
      `
    : sql`
        SELECT rating, COUNT(*) as cnt
        FROM user_feedback
        WHERE org_id = ${user.org_id} AND created_at >= ${since}
        GROUP BY rating
      `;

  const counts = await countQuery;

  // Previous period counts (for trend)
  const prevCountQuery = agentName
    ? sql`
        SELECT rating, COUNT(*) as cnt
        FROM user_feedback
        WHERE org_id = ${user.org_id} AND agent_name = ${agentName} AND created_at >= ${prevSince} AND created_at < ${since}
        GROUP BY rating
      `
    : sql`
        SELECT rating, COUNT(*) as cnt
        FROM user_feedback
        WHERE org_id = ${user.org_id} AND created_at >= ${prevSince} AND created_at < ${since}
        GROUP BY rating
      `;

  const prevCounts = await prevCountQuery;

  // Per-agent breakdown
  const agentBreakdown = agentName
    ? []
    : await sql`
        SELECT agent_name, rating, COUNT(*) as cnt
        FROM user_feedback
        WHERE org_id = ${user.org_id} AND created_at >= ${since}
        GROUP BY agent_name, rating
        ORDER BY agent_name
      `;

  // Build response
  const byRating: Record<string, number> = {};
  const prevByRating: Record<string, number> = {};
  let total = 0;
  let prevTotal = 0;

  for (const row of counts as any[]) {
    byRating[row.rating] = Number(row.cnt);
    total += Number(row.cnt);
  }
  for (const row of prevCounts as any[]) {
    prevByRating[row.rating] = Number(row.cnt);
    prevTotal += Number(row.cnt);
  }

  // Group agent breakdown
  const agentMap = new Map<string, Record<string, number>>();
  for (const row of agentBreakdown as any[]) {
    const name = row.agent_name || "unknown";
    if (!agentMap.has(name)) agentMap.set(name, {});
    agentMap.get(name)![row.rating] = Number(row.cnt);
  }

  const agents = Array.from(agentMap.entries()).map(([name, ratings]) => ({
    agent_name: name,
    positive: ratings.positive || 0,
    negative: ratings.negative || 0,
    neutral: ratings.neutral || 0,
    total: (ratings.positive || 0) + (ratings.negative || 0) + (ratings.neutral || 0),
  }));

  return c.json({
    total,
    positive: byRating.positive || 0,
    negative: byRating.negative || 0,
    neutral: byRating.neutral || 0,
    positive_pct: total > 0 ? ((byRating.positive || 0) / total) * 100 : 0,
    negative_pct: total > 0 ? ((byRating.negative || 0) / total) * 100 : 0,
    prev_total: prevTotal,
    prev_positive: prevByRating.positive || 0,
    prev_negative: prevByRating.negative || 0,
    trend_direction: total > prevTotal ? "up" : total < prevTotal ? "down" : "flat",
    by_agent: agents,
  });
});

/* ── Single feedback detail ─────────────────────────────────────── */

feedbackRoutes.get("/:id", requireScope("sessions:read"), async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const rows = await sql`
    SELECT id, session_id, turn_number, rating, comment, message_preview, agent_name, channel, created_at, org_id
    FROM user_feedback
    WHERE id = ${id} AND org_id = ${user.org_id}
    LIMIT 1
  `;

  if (rows.length === 0) return c.json({ error: "not_found" }, 404);
  return c.json(rows[0]);
});

/* ── Delete feedback ────────────────────────────────────────────── */

feedbackRoutes.delete("/:id", requireScope("sessions:write"), async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  await sql`
    DELETE FROM user_feedback
    WHERE id = ${id} AND org_id = ${user.org_id}
  `;

  return c.json({ deleted: true, id });
});
