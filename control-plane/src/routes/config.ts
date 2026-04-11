/**
 * Config router — project configuration, A2A management.
 * Ported from agentos/api/routers/config.py
 *
 * In edge architecture, config is stored in Supabase, not filesystem.
 */
import { createRoute, z } from "@hono/zod-openapi";
import { createOpenAPIRouter } from "../lib/openapi";
import { ErrorSchema, errorResponses } from "../schemas/openapi";
import { withOrgDb } from "../db/client";
import { parseJsonColumn } from "../lib/parse-json-column";

export const configRoutes = createOpenAPIRouter();

// ── GET /yaml — read project config ─────────────────────────────────────

const getConfigRoute = createRoute({
  method: "get",
  path: "/yaml",
  tags: ["Config"],
  summary: "Read project configuration",
  responses: {
    200: {
      description: "Project config",
      content: {
        "application/json": {
          schema: z.object({
            config: z.record(z.unknown()),
            exists: z.boolean(),
          }),
        },
      },
    },
    ...errorResponses(401, 500),
  },
});
configRoutes.openapi(getConfigRoute, async (c): Promise<any> => {
  const user = c.get("user");
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    try {
      const rows = await sql`
        SELECT config FROM project_configs LIMIT 1
      `;
      if (rows.length === 0) return c.json({ config: {}, exists: false });
      const config = parseJsonColumn(rows[0].config);
      return c.json({ config, exists: true });
    } catch {
      return c.json({ config: {}, exists: false });
    }
  });
});

// ── PUT /yaml — update project config ───────────────────────────────────

const updateConfigRoute = createRoute({
  method: "put",
  path: "/yaml",
  tags: ["Config"],
  summary: "Update project configuration (merge with existing)",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            updates: z.record(z.unknown()).optional(),
          }).passthrough(),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Config updated",
      content: { "application/json": { schema: z.object({ updated: z.boolean() }) } },
    },
    ...errorResponses(401, 500),
  },
});
configRoutes.openapi(updateConfigRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const body = c.req.valid("json");
  const updates = body.updates || body;

  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const now = new Date().toISOString();

    // Get existing config
    let existing: any = {};
    try {
      const rows = await sql`
        SELECT config FROM project_configs LIMIT 1
      `;
      if (rows.length > 0) existing = parseJsonColumn(rows[0].config);
    } catch {}

    // Merge updates
    const merged = { ...existing, ...updates };
    const configJson = JSON.stringify(merged);

    await sql`
      INSERT INTO project_configs (org_id, config, updated_at)
      VALUES (${user.org_id}, ${configJson}, ${now})
      ON CONFLICT (org_id) DO UPDATE SET config = EXCLUDED.config, updated_at = EXCLUDED.updated_at
    `;

    return c.json({ updated: true });
  });
});

// ── GET /a2a/remotes — list A2A remote agents ───────────────────────────

const listA2aRemotesRoute = createRoute({
  method: "get",
  path: "/a2a/remotes",
  tags: ["Config"],
  summary: "List configured A2A remote agents",
  responses: {
    200: {
      description: "Remote agent list",
      content: { "application/json": { schema: z.object({ remotes: z.array(z.record(z.unknown())) }) } },
    },
    ...errorResponses(401, 500),
  },
});
configRoutes.openapi(listA2aRemotesRoute, async (c): Promise<any> => {
  const user = c.get("user");
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    try {
      const rows = await sql`
        SELECT config FROM project_configs LIMIT 1
      `;
      if (rows.length === 0) return c.json({ remotes: [] });
      const config = parseJsonColumn(rows[0].config);
      return c.json({ remotes: config.a2a_remotes || [] });
    } catch {
      return c.json({ remotes: [] });
    }
  });
});

// ── POST /a2a/test — test connectivity to a remote A2A agent ────────────

const testA2aRoute = createRoute({
  method: "post",
  path: "/a2a/test",
  tags: ["Config"],
  summary: "Test connectivity to a remote A2A agent",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            url: z.string().min(1),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Connectivity test result",
      content: {
        "application/json": {
          schema: z.object({
            reachable: z.boolean(),
            agent: z.string().optional(),
            description: z.string().optional(),
            capabilities: z.record(z.unknown()).optional(),
            skills: z.number().optional(),
            error: z.string().optional(),
          }),
        },
      },
    },
    ...errorResponses(400, 401, 500),
  },
});
configRoutes.openapi(testA2aRoute, async (c): Promise<any> => {
  const body = c.req.valid("json");
  const url = String(body.url || "").trim();
  if (!url) return c.json({ error: "url is required" }, 400);

  try {
    const resp = await fetch(url.replace(/\/+$/, "") + "/.well-known/agent.json", {
      signal: AbortSignal.timeout(10000),
    });
    if (resp.status >= 400) {
      return c.json({ reachable: false, error: `HTTP ${resp.status}` });
    }
    const card = await resp.json() as any;
    return c.json({
      reachable: true,
      agent: card.name || "unknown",
      description: card.description || "",
      capabilities: card.capabilities || {},
      skills: (card.skills || []).length,
    });
  } catch (e: any) {
    return c.json({ reachable: false, error: e.message || "Connection failed" });
  }
});
