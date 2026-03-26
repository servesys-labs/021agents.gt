/**
 * Tools router — list available tools from DB registry.
 * Ported from agentos/api/routers/tools.py
 */
import { Hono } from "hono";
import type { Env } from "../env";
import type { CurrentUser } from "../auth/types";
import { getDb } from "../db/client";

type R = { Bindings: Env; Variables: { user: CurrentUser } };
export const toolRoutes = new Hono<R>();

toolRoutes.get("/", async (c) => {
  const sql = await getDb(c.env.HYPERDRIVE);

  try {
    const rows = await sql`
      SELECT name, description, source, has_handler FROM tool_registry ORDER BY name
    `;
    return c.json({
      tools: rows.map((r: any) => ({
        name: r.name,
        description: r.description || "",
        has_handler: Boolean(r.has_handler),
        source: r.source || "builtin",
      })),
    });
  } catch {
    // Fallback: return builtin tool list from RUNTIME
    try {
      const resp = await c.env.RUNTIME.fetch("https://runtime/api/v1/tools");
      if (resp.status < 400) return c.json(await resp.json());
    } catch {}

    return c.json({
      tools: [
        { name: "web_search", description: "Search the web", has_handler: true, source: "builtin" },
        { name: "browse_url", description: "Fetch and parse a URL", has_handler: true, source: "builtin" },
        { name: "run_code", description: "Execute code in sandbox", has_handler: true, source: "builtin" },
        { name: "file_read", description: "Read a file", has_handler: true, source: "builtin" },
        { name: "file_write", description: "Write a file", has_handler: true, source: "builtin" },
      ],
    });
  }
});
