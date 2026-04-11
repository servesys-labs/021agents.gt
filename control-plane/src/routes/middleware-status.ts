/**
 * Middleware status router — status, stats, and event history.
 */
import { createRoute, z } from "@hono/zod-openapi";
import { createOpenAPIRouter } from "../lib/openapi";
import { ErrorSchema, errorResponses } from "../schemas/openapi";
import { withOrgDb } from "../db/client";

export const middlewareStatusRoutes = createOpenAPIRouter();

// ── GET /status — Middleware chain status ────────────────────────────

const statusRoute = createRoute({
  method: "get",
  path: "/status",
  tags: ["Middleware"],
  summary: "Get middleware chain status and stats",
  responses: {
    200: {
      description: "Middleware status",
      content: { "application/json": { schema: z.array(z.record(z.unknown())) } },
    },
    ...errorResponses(500),
  },
});

middlewareStatusRoutes.openapi(statusRoute, async (c): Promise<any> => {
  // Return the known middleware chain with their types
  // In edge architecture, actual stats come from RUNTIME
  const middlewares = [
    { name: "loop_detection", order: 1, type: "LoopDetectionMiddleware", stats: {} },
    { name: "summarization", order: 2, type: "SummarizationMiddleware", stats: {} },
  ];

  // Try to get live stats from RUNTIME
  try {
    const resp = await c.env.RUNTIME.fetch("https://runtime/api/v1/middleware/status");
    if (resp.status < 400) {
      const data = await resp.json();
      return c.json(data);
    }
  } catch {}

  return c.json(middlewares);
});

// ── GET /events — Middleware event history ───────────────────────────

const eventsRoute = createRoute({
  method: "get",
  path: "/events",
  tags: ["Middleware"],
  summary: "List middleware events",
  request: {
    query: z.object({
      session_id: z.string().optional().openapi({ example: "sess-abc123" }),
      middleware_name: z.string().optional().openapi({ example: "loop_detection" }),
      limit: z.coerce.number().int().min(1).max(500).default(100).openapi({ example: 100 }),
    }),
  },
  responses: {
    200: {
      description: "Middleware events",
      content: { "application/json": { schema: z.array(z.record(z.unknown())) } },
    },
    ...errorResponses(500),
  },
});

middlewareStatusRoutes.openapi(eventsRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { session_id: sessionId, middleware_name: middlewareName, limit: rawLimit } = c.req.valid("query");
  const limit = Math.min(500, Math.max(1, Number(rawLimit) || 100));

  return await withOrgDb(c.env, user.org_id, async (sql) => {
    try {
      let rows;
      if (sessionId && middlewareName) {
        rows = await sql`
          SELECT * FROM middleware_events
          WHERE session_id = ${sessionId} AND middleware_name = ${middlewareName}
          ORDER BY created_at DESC LIMIT ${limit}
        `;
      } else if (sessionId) {
        rows = await sql`
          SELECT * FROM middleware_events
          WHERE session_id = ${sessionId}
          ORDER BY created_at DESC LIMIT ${limit}
        `;
      } else if (middlewareName) {
        rows = await sql`
          SELECT * FROM middleware_events
          WHERE middleware_name = ${middlewareName}
          ORDER BY created_at DESC LIMIT ${limit}
        `;
      } else {
        rows = await sql`
          SELECT * FROM middleware_events
          ORDER BY created_at DESC LIMIT ${limit}
        `;
      }
      return c.json(rows);
    } catch {
      return c.json([]);
    }
  });
});
