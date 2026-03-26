/**
 * Config router — project configuration, A2A management.
 * Ported from agentos/api/routers/config.py
 *
 * In edge architecture, config is stored in Supabase, not filesystem.
 */
import { Hono } from "hono";
import type { Env } from "../env";
import type { CurrentUser } from "../auth/types";
import { getDbForOrg } from "../db/client";

type R = { Bindings: Env; Variables: { user: CurrentUser } };
export const configRoutes = new Hono<R>();

configRoutes.get("/yaml", async (c) => {
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  try {
    const rows = await sql`
      SELECT config_json FROM project_configs WHERE org_id = ${user.org_id} LIMIT 1
    `;
    if (rows.length === 0) return c.json({ config: {}, exists: false });
    const config = JSON.parse(rows[0].config_json || "{}");
    return c.json({ config, exists: true });
  } catch {
    return c.json({ config: {}, exists: false });
  }
});

configRoutes.put("/yaml", async (c) => {
  const user = c.get("user");
  const body = await c.req.json();
  const updates = body.updates || body;

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const now = Date.now() / 1000;

  // Get existing config
  let existing: any = {};
  try {
    const rows = await sql`
      SELECT config_json FROM project_configs WHERE org_id = ${user.org_id} LIMIT 1
    `;
    if (rows.length > 0) existing = JSON.parse(rows[0].config_json || "{}");
  } catch {}

  // Merge updates
  const merged = { ...existing, ...updates };
  const configJson = JSON.stringify(merged);

  await sql`
    INSERT INTO project_configs (org_id, config_json, updated_at)
    VALUES (${user.org_id}, ${configJson}, ${now})
    ON CONFLICT (org_id) DO UPDATE SET config_json = EXCLUDED.config_json, updated_at = EXCLUDED.updated_at
  `;

  return c.json({ updated: true });
});

configRoutes.get("/a2a/remotes", async (c) => {
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  try {
    const rows = await sql`
      SELECT config_json FROM project_configs WHERE org_id = ${user.org_id} LIMIT 1
    `;
    if (rows.length === 0) return c.json({ remotes: [] });
    const config = JSON.parse(rows[0].config_json || "{}");
    return c.json({ remotes: config.a2a_remotes || [] });
  } catch {
    return c.json({ remotes: [] });
  }
});

configRoutes.post("/a2a/test", async (c) => {
  const body = await c.req.json();
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
