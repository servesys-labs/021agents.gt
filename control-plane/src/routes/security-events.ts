/**
 * Security events router — query, summarize, and timeline security events.
 */
import { createRoute, z } from "@hono/zod-openapi";
import { createOpenAPIRouter } from "../lib/openapi";
import { ErrorSchema, errorResponses } from "../schemas/openapi";
import type { CurrentUser } from "../auth/types";
import { getDbForOrg } from "../db/client";
import { requireScope } from "../middleware/auth";

export const securityEventRoutes = createOpenAPIRouter();

// ── GET / — List security events ────────────────────────────────────────
const listSecurityEventsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Security Events"],
  summary: "List security events",
  middleware: [requireScope("security:read")],
  request: {
    query: z.object({
      event_type: z.string().optional(),
      severity: z.string().optional(),
      actor_id: z.string().optional(),
      since_hours: z.coerce.number().optional(),
      limit: z.coerce.number().optional(),
    }),
  },
  responses: {
    200: { description: "Security events list", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(401, 403),
  },
});
securityEventRoutes.openapi(listSecurityEventsRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const query = c.req.valid("query");
  const eventType = query.event_type || "";
  const severity = query.severity || "";
  const actorId = query.actor_id || "";
  const sinceHours = Math.max(1, Math.min(720, Number(query.since_hours) || 24));
  const limit = Math.min(500, Math.max(1, Number(query.limit) || 50));
  const since = new Date(Date.now() - sinceHours * 3600 * 1000).toISOString();

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  // Build query based on filters
  let rows;
  if (eventType && severity && actorId) {
    rows = await sql`
      SELECT * FROM security_events
      WHERE org_id = ${user.org_id} AND event_type = ${eventType}
        AND severity = ${severity} AND actor_id = ${actorId}
        AND created_at >= ${since}
      ORDER BY created_at DESC LIMIT ${limit}
    `;
  } else if (eventType && severity) {
    rows = await sql`
      SELECT * FROM security_events
      WHERE org_id = ${user.org_id} AND event_type = ${eventType}
        AND severity = ${severity} AND created_at >= ${since}
      ORDER BY created_at DESC LIMIT ${limit}
    `;
  } else if (eventType && actorId) {
    rows = await sql`
      SELECT * FROM security_events
      WHERE org_id = ${user.org_id} AND event_type = ${eventType}
        AND actor_id = ${actorId} AND created_at >= ${since}
      ORDER BY created_at DESC LIMIT ${limit}
    `;
  } else if (severity && actorId) {
    rows = await sql`
      SELECT * FROM security_events
      WHERE org_id = ${user.org_id} AND severity = ${severity}
        AND actor_id = ${actorId} AND created_at >= ${since}
      ORDER BY created_at DESC LIMIT ${limit}
    `;
  } else if (eventType) {
    rows = await sql`
      SELECT * FROM security_events
      WHERE org_id = ${user.org_id} AND event_type = ${eventType}
        AND created_at >= ${since}
      ORDER BY created_at DESC LIMIT ${limit}
    `;
  } else if (severity) {
    rows = await sql`
      SELECT * FROM security_events
      WHERE org_id = ${user.org_id} AND severity = ${severity}
        AND created_at >= ${since}
      ORDER BY created_at DESC LIMIT ${limit}
    `;
  } else if (actorId) {
    rows = await sql`
      SELECT * FROM security_events
      WHERE org_id = ${user.org_id} AND actor_id = ${actorId}
        AND created_at >= ${since}
      ORDER BY created_at DESC LIMIT ${limit}
    `;
  } else {
    rows = await sql`
      SELECT * FROM security_events
      WHERE org_id = ${user.org_id} AND created_at >= ${since}
      ORDER BY created_at DESC LIMIT ${limit}
    `;
  }

  return c.json({ events: rows, total: rows.length });
});

// ── GET /summary — Aggregated security event summary ────────────────────
const securitySummaryRoute = createRoute({
  method: "get",
  path: "/summary",
  tags: ["Security Events"],
  summary: "Aggregated security event summary",
  middleware: [requireScope("security:read")],
  request: {
    query: z.object({
      since_hours: z.coerce.number().optional(),
    }),
  },
  responses: {
    200: { description: "Security summary", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(401, 403),
  },
});
securityEventRoutes.openapi(securitySummaryRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const query = c.req.valid("query");
  const sinceHours = Math.max(1, Math.min(720, Number(query.since_hours) || 24));
  const since = new Date(Date.now() - sinceHours * 3600 * 1000).toISOString();

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const byType = await sql`
    SELECT event_type, COUNT(*)::int AS count
    FROM security_events
    WHERE org_id = ${user.org_id} AND created_at >= ${since}
    GROUP BY event_type
    ORDER BY count DESC
  `;

  const bySeverity = await sql`
    SELECT severity, COUNT(*)::int AS count
    FROM security_events
    WHERE org_id = ${user.org_id} AND created_at >= ${since}
    GROUP BY severity
    ORDER BY count DESC
  `;

  const topActors = await sql`
    SELECT actor_id, actor_type, COUNT(*)::int AS count
    FROM security_events
    WHERE org_id = ${user.org_id} AND created_at >= ${since}
    GROUP BY actor_id, actor_type
    ORDER BY count DESC
    LIMIT 10
  `;

  return c.json({
    since_hours: sinceHours,
    by_event_type: byType,
    by_severity: bySeverity,
    top_actors: topActors,
  });
});

// ── GET /timeline — Hourly event counts for last 24 hours ───────────────
const securityTimelineRoute = createRoute({
  method: "get",
  path: "/timeline",
  tags: ["Security Events"],
  summary: "Hourly event counts for last 24 hours",
  middleware: [requireScope("security:read")],
  responses: {
    200: { description: "Hourly timeline", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(401, 403),
  },
});
securityEventRoutes.openapi(securityTimelineRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const rows = await sql`
    SELECT
      date_trunc('hour', created_at::timestamp) AS hour,
      COUNT(*)::int AS count
    FROM security_events
    WHERE org_id = ${user.org_id} AND created_at >= ${since}
    GROUP BY hour
    ORDER BY hour ASC
  `;

  return c.json({ timeline: rows });
});
