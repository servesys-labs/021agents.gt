/**
 * Middleware status router — status, stats, and event history.
 * Ported from agentos/api/routers/middleware.py
 */
import { Hono } from "hono";
import type { Env } from "../env";
import type { CurrentUser } from "../auth/types";
import { getDbForOrg } from "../db/client";

type R = { Bindings: Env; Variables: { user: CurrentUser } };
export const middlewareStatusRoutes = new Hono<R>();

middlewareStatusRoutes.get("/status", async (c) => {
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

middlewareStatusRoutes.get("/events", async (c) => {
  const user = c.get("user");
  const orgId = user.org_id;
  const sessionId = c.req.query("session_id") || "";
  const middlewareName = c.req.query("middleware_name") || "";
  const limit = Math.min(500, Math.max(1, Number(c.req.query("limit")) || 100));
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  try {
    let rows;
    if (sessionId && middlewareName) {
      rows = await sql`
        SELECT * FROM middleware_events
        WHERE org_id = ${orgId} AND session_id = ${sessionId} AND middleware_name = ${middlewareName}
        ORDER BY created_at DESC LIMIT ${limit}
      `;
    } else if (sessionId) {
      rows = await sql`
        SELECT * FROM middleware_events
        WHERE org_id = ${orgId} AND session_id = ${sessionId}
        ORDER BY created_at DESC LIMIT ${limit}
      `;
    } else if (middlewareName) {
      rows = await sql`
        SELECT * FROM middleware_events
        WHERE org_id = ${orgId} AND middleware_name = ${middlewareName}
        ORDER BY created_at DESC LIMIT ${limit}
      `;
    } else {
      rows = await sql`
        SELECT * FROM middleware_events
        WHERE org_id = ${orgId}
        ORDER BY created_at DESC LIMIT ${limit}
      `;
    }
    return c.json(rows);
  } catch {
    return c.json([]);
  }
});
