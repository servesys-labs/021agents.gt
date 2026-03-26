/**
 * Skills router — list, enable/disable, reload skills.
 * Ported from agentos/api/routers/skills.py
 *
 * Skills are stored in Supabase (skills table).
 */
import { Hono } from "hono";
import type { Env } from "../env";
import type { CurrentUser } from "../auth/types";
import { getDbForOrg } from "../db/client";

type R = { Bindings: Env; Variables: { user: CurrentUser } };
export const skillRoutes = new Hono<R>();

skillRoutes.get("/", async (c) => {
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  try {
    const rows = await sql`SELECT * FROM skills ORDER BY name`;
    return c.json(rows);
  } catch {
    return c.json([]);
  }
});

skillRoutes.get("/:name", async (c) => {
  const user = c.get("user");
  const name = c.req.param("name");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const rows = await sql`SELECT * FROM skills WHERE name = ${name}`;
  if (rows.length === 0) return c.json({ error: `Skill '${name}' not found` }, 404);
  return c.json(rows[0]);
});

skillRoutes.put("/:name", async (c) => {
  const user = c.get("user");
  const name = c.req.param("name");
  const body = await c.req.json();
  const enabled = Boolean(body.enabled);

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const rows = await sql`SELECT name FROM skills WHERE name = ${name}`;
  if (rows.length === 0) return c.json({ error: `Skill '${name}' not found` }, 404);

  await sql`UPDATE skills SET enabled = ${enabled} WHERE name = ${name}`;

  const updated = await sql`SELECT * FROM skills WHERE name = ${name}`;
  return c.json(updated[0]);
});

skillRoutes.post("/reload", async (c) => {
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  try {
    const rows = await sql`SELECT * FROM skills ORDER BY name`;
    return c.json({
      total: rows.length,
      enabled: rows.filter((r: any) => r.enabled).length,
      skills: rows.map((r: any) => r.name),
    });
  } catch {
    return c.json({ total: 0, enabled: 0, skills: [] });
  }
});
