/**
 * Feedback router — user feedback loop (thumbs up/down) on agent responses.
 *
 * Endpoints:
 *   GET    /           — List feedback (org-scoped, filterable)
 *   GET    /stats      — Aggregate feedback stats
 *   GET    /:id        — Single feedback detail
 *   DELETE /:id        — Delete feedback
 */
import { createRoute, z } from "@hono/zod-openapi";
import { createOpenAPIRouter } from "../lib/openapi";
import { ErrorSchema, errorResponses } from "../schemas/openapi";
import { withOrgDb } from "../db/client";
import { requireScope } from "../middleware/auth";

export const feedbackRoutes = createOpenAPIRouter();

/* ── List feedback ──────────────────────────────────────────────── */

const listFeedbackRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Feedback"],
  summary: "List feedback entries (org-scoped, filterable)",
  middleware: [requireScope("sessions:read")],
  request: {
    query: z.object({
      agent_name: z.string().optional(),
      rating: z.string().optional(),
      since_days: z.coerce.number().int().min(1).max(365).default(30).optional(),
      limit: z.coerce.number().int().min(1).max(500).default(50).optional(),
      offset: z.coerce.number().int().min(0).default(0).optional(),
    }),
  },
  responses: {
    200: {
      description: "Feedback list",
      content: { "application/json": { schema: z.object({ feedback: z.array(z.record(z.unknown())), count: z.number() }) } },
    },
  },
});
feedbackRoutes.openapi(listFeedbackRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const q = c.req.valid("query");
  const agentName = q.agent_name || "";
  const rating = q.rating || "";
  const sinceDays = Math.max(1, Math.min(365, Number(q.since_days) || 30));
  const limit = Math.min(500, Math.max(1, Number(q.limit) || 50));
  const offset = Math.max(0, Number(q.offset) || 0);
  const since = new Date(Date.now() - sinceDays * 86400 * 1000).toISOString();

  return await withOrgDb(c.env, user.org_id, async (sql) => {
    let rows;
    if (agentName && rating) {
      rows = await sql`
        SELECT id, session_id, turn_number, rating, comment, message_preview, agent_name, channel, created_at
        FROM session_feedback
        WHERE agent_name = ${agentName} AND rating = ${rating} AND created_at >= ${since}
        ORDER BY created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
    } else if (agentName) {
      rows = await sql`
        SELECT id, session_id, turn_number, rating, comment, message_preview, agent_name, channel, created_at
        FROM session_feedback
        WHERE agent_name = ${agentName} AND created_at >= ${since}
        ORDER BY created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
    } else if (rating) {
      rows = await sql`
        SELECT id, session_id, turn_number, rating, comment, message_preview, agent_name, channel, created_at
        FROM session_feedback
        WHERE rating = ${rating} AND created_at >= ${since}
        ORDER BY created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
    } else {
      rows = await sql`
        SELECT id, session_id, turn_number, rating, comment, message_preview, agent_name, channel, created_at
        FROM session_feedback
        WHERE created_at >= ${since}
        ORDER BY created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
    }

    return c.json({ feedback: rows, count: rows.length });
  });
});

/* ── Aggregate stats ────────────────────────────────────────────── */

const feedbackStatsRoute = createRoute({
  method: "get",
  path: "/stats",
  tags: ["Feedback"],
  summary: "Aggregate feedback stats",
  middleware: [requireScope("sessions:read")],
  request: {
    query: z.object({
      agent_name: z.string().optional(),
      since_days: z.coerce.number().int().min(1).max(365).default(30).optional(),
    }),
  },
  responses: {
    200: {
      description: "Feedback stats",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
  },
});
feedbackRoutes.openapi(feedbackStatsRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const q = c.req.valid("query");
  const agentName = q.agent_name || "";
  const sinceDays = Math.max(1, Math.min(365, Number(q.since_days) || 30));
  const since = new Date(Date.now() - sinceDays * 86400 * 1000).toISOString();
  const prevSince = new Date(Date.now() - sinceDays * 2 * 86400 * 1000).toISOString();

  return await withOrgDb(c.env, user.org_id, async (sql) => {
    // Current period counts
    const countQuery = agentName
      ? sql`
          SELECT rating, COUNT(*) as cnt
          FROM session_feedback
          WHERE agent_name = ${agentName} AND created_at >= ${since}
          GROUP BY rating
        `
      : sql`
          SELECT rating, COUNT(*) as cnt
          FROM session_feedback
          WHERE created_at >= ${since}
          GROUP BY rating
        `;

    const counts = await countQuery;

    // Previous period counts (for trend)
    const prevCountQuery = agentName
      ? sql`
          SELECT rating, COUNT(*) as cnt
          FROM session_feedback
          WHERE agent_name = ${agentName} AND created_at >= ${prevSince} AND created_at < ${since}
          GROUP BY rating
        `
      : sql`
          SELECT rating, COUNT(*) as cnt
          FROM session_feedback
          WHERE created_at >= ${prevSince} AND created_at < ${since}
          GROUP BY rating
        `;

    const prevCounts = await prevCountQuery;

    // Per-agent breakdown
    const agentBreakdown = agentName
      ? []
      : await sql`
          SELECT agent_name, rating, COUNT(*) as cnt
          FROM session_feedback
          WHERE created_at >= ${since}
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
});

/* ── Single feedback detail ─────────────────────────────────────── */

const getFeedbackRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["Feedback"],
  summary: "Get a single feedback entry",
  middleware: [requireScope("sessions:read")],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "Feedback detail",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(404),
  },
});
feedbackRoutes.openapi(getFeedbackRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { id } = c.req.valid("param");

  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const rows = await sql`
      SELECT id, session_id, turn_number, rating, comment, message_preview, agent_name, channel, created_at, org_id
      FROM session_feedback
      WHERE id = ${id}
      LIMIT 1
    `;

    if (rows.length === 0) return c.json({ error: "not_found" }, 404);
    return c.json(rows[0] as any);
  });
});

/* ── Delete feedback ────────────────────────────────────────────── */

const deleteFeedbackRoute = createRoute({
  method: "delete",
  path: "/{id}",
  tags: ["Feedback"],
  summary: "Delete a feedback entry",
  middleware: [requireScope("sessions:write")],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "Feedback deleted",
      content: { "application/json": { schema: z.object({ deleted: z.boolean(), id: z.string() }) } },
    },
  },
});
feedbackRoutes.openapi(deleteFeedbackRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { id } = c.req.valid("param");

  return await withOrgDb(c.env, user.org_id, async (sql) => {
    await sql`
      DELETE FROM session_feedback
      WHERE id = ${id}
    `;

    return c.json({ deleted: true, id });
  });
});
