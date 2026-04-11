/**
 * Skills router — list, enable/disable, reload skills.
 * Ported from agentos/api/routers/skills.py
 *
 * Skills are stored in Supabase (skills table).
 */
import { createRoute, z } from "@hono/zod-openapi";
import { createOpenAPIRouter } from "../lib/openapi";
import { ErrorSchema, errorResponses } from "../schemas/openapi";
import { withOrgDb } from "../db/client";
import { requireScope } from "../middleware/auth";

export const skillRoutes = createOpenAPIRouter();

// ── GET /skills ────────────────────────────────────────────────────────

const listSkillsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Skills"],
  summary: "List all skills",
  middleware: [requireScope("agents:read")],
  responses: {
    200: {
      description: "Skill list",
      content: { "application/json": { schema: z.array(z.record(z.unknown())) } },
    },
  },
});
skillRoutes.openapi(listSkillsRoute, async (c): Promise<any> => {
  const user = c.get("user");
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    try {
      const rows = await sql`SELECT * FROM skills ORDER BY name`;
      return c.json(rows);
    } catch {
      return c.json([]);
    }
  });
});

// ── GET /skills/{name} ────────────────────────────────────────────────

const getSkillRoute = createRoute({
  method: "get",
  path: "/{name}",
  tags: ["Skills"],
  summary: "Get a skill by name",
  middleware: [requireScope("agents:read")],
  request: {
    params: z.object({ name: z.string() }),
  },
  responses: {
    200: {
      description: "Skill details",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(404),
  },
});
skillRoutes.openapi(getSkillRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { name } = c.req.valid("param");
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const rows = await sql`SELECT * FROM skills WHERE name = ${name}`;
    if (rows.length === 0) return c.json({ error: `Skill '${name}' not found` }, 404);
    return c.json(rows[0]);
  });
});

// ── PUT /skills/{name} ────────────────────────────────────────────────

const updateSkillRoute = createRoute({
  method: "put",
  path: "/{name}",
  tags: ["Skills"],
  summary: "Enable or disable a skill",
  middleware: [requireScope("agents:write")],
  request: {
    params: z.object({ name: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            is_active: z.boolean(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Updated skill",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(404),
  },
});
skillRoutes.openapi(updateSkillRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { name } = c.req.valid("param");
  const body = c.req.valid("json");
  const isActive = Boolean(body.is_active);

  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const rows = await sql`SELECT name FROM skills WHERE name = ${name}`;
    if (rows.length === 0) return c.json({ error: `Skill '${name}' not found` }, 404);

    await sql`UPDATE skills SET is_active = ${isActive} WHERE name = ${name}`;

    const updated = await sql`SELECT * FROM skills WHERE name = ${name}`;
    return c.json(updated[0]);
  });
});

// ── POST /skills/reload ────────────────────────────────────────────────

const reloadSkillsRoute = createRoute({
  method: "post",
  path: "/reload",
  tags: ["Skills"],
  summary: "Reload skills from database",
  middleware: [requireScope("agents:read")],
  responses: {
    200: {
      description: "Reload result",
      content: {
        "application/json": {
          schema: z.object({
            total: z.number(),
            enabled: z.number(),
            skills: z.array(z.string()),
          }),
        },
      },
    },
  },
});
skillRoutes.openapi(reloadSkillsRoute, async (c): Promise<any> => {
  const user = c.get("user");
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    try {
      const rows = await sql`SELECT * FROM skills ORDER BY name`;
      return c.json({
        total: rows.length,
        enabled: rows.filter((r: any) => r.is_active).length,
        skills: rows.map((r: any) => r.name),
      });
    } catch {
      return c.json({ total: 0, enabled: 0, skills: [] });
    }
  });
});
