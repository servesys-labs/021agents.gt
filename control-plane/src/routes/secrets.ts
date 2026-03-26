/**
 * Secrets router — encrypted secrets vault per org/project/env.
 * Ported from agentos/api/routers/secrets.py
 *
 * Uses Fernet encryption (AES-CBC + HMAC-SHA256) via Web Crypto.
 */
import { Hono } from "hono";
import type { Env } from "../env";
import type { CurrentUser } from "../auth/types";
import { getDbForOrg } from "../db/client";
import { fernetEncrypt } from "../logic/fernet";
import { requireScope } from "../middleware/auth";

type R = { Bindings: Env; Variables: { user: CurrentUser } };
export const secretRoutes = new Hono<R>();

function getKeySeed(env: Env): string {
  const key = env.SECRETS_ENCRYPTION_KEY;
  if (!key) throw Object.assign(new Error("SECRETS_ENCRYPTION_KEY is required"), { status: 503 });
  return key;
}

secretRoutes.get("/", requireScope("secrets:read"), async (c) => {
  const user = c.get("user");
  const projectId = c.req.query("project_id") || "";
  const envFilter = c.req.query("env") || "";
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  let rows;
  if (projectId && envFilter) {
    rows = await sql`
      SELECT name, project_id, env, created_at, updated_at FROM secrets
      WHERE org_id = ${user.org_id} AND project_id = ${projectId} AND env = ${envFilter}
      ORDER BY name
    `;
  } else if (projectId) {
    rows = await sql`
      SELECT name, project_id, env, created_at, updated_at FROM secrets
      WHERE org_id = ${user.org_id} AND project_id = ${projectId}
      ORDER BY name
    `;
  } else if (envFilter) {
    rows = await sql`
      SELECT name, project_id, env, created_at, updated_at FROM secrets
      WHERE org_id = ${user.org_id} AND env = ${envFilter}
      ORDER BY name
    `;
  } else {
    rows = await sql`
      SELECT name, project_id, env, created_at, updated_at FROM secrets
      WHERE org_id = ${user.org_id}
      ORDER BY name
    `;
  }
  return c.json({ secrets: rows });
});

secretRoutes.post("/", requireScope("secrets:write"), async (c) => {
  const user = c.get("user");
  const body = await c.req.json();
  const name = String(body.name || "").trim();
  const value = String(body.value || "");
  const projectId = String(body.project_id || "");
  const envFilter = String(body.env || "");

  if (!name) return c.json({ error: "name is required" }, 400);
  if (!value) return c.json({ error: "value is required" }, 400);

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  // Check for duplicate
  const existing = await sql`
    SELECT name FROM secrets
    WHERE org_id = ${user.org_id} AND name = ${name} AND project_id = ${projectId} AND env = ${envFilter}
  `;
  if (existing.length > 0) {
    return c.json({ error: `Secret '${name}' already exists in this scope` }, 409);
  }

  const encrypted = await fernetEncrypt(value, getKeySeed(c.env));
  const now = Date.now() / 1000;

  await sql`
    INSERT INTO secrets (org_id, project_id, env, name, value_encrypted, created_by, created_at, updated_at)
    VALUES (${user.org_id}, ${projectId}, ${envFilter}, ${name}, ${encrypted}, ${user.user_id}, ${now}, ${now})
  `;

  return c.json({ created: name, project_id: projectId, env: envFilter });
});

secretRoutes.delete("/:name", requireScope("secrets:write"), async (c) => {
  const user = c.get("user");
  const name = c.req.param("name");
  const projectId = c.req.query("project_id") || "";
  const envFilter = c.req.query("env") || "";
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const result = await sql`
    DELETE FROM secrets
    WHERE org_id = ${user.org_id} AND name = ${name} AND project_id = ${projectId} AND env = ${envFilter}
  `;
  if (result.count === 0) return c.json({ error: `Secret '${name}' not found` }, 404);
  return c.json({ deleted: name });
});

secretRoutes.post("/:name/rotate", requireScope("secrets:write"), async (c) => {
  const user = c.get("user");
  const name = c.req.param("name");
  const body = await c.req.json();
  const newValue = String(body.new_value || "");
  const projectId = String(body.project_id || "");
  const envFilter = String(body.env || "");

  if (!newValue) return c.json({ error: "new_value is required" }, 400);

  const encrypted = await fernetEncrypt(newValue, getKeySeed(c.env));
  const now = Date.now() / 1000;
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const result = await sql`
    UPDATE secrets SET value_encrypted = ${encrypted}, updated_at = ${now}
    WHERE org_id = ${user.org_id} AND name = ${name} AND project_id = ${projectId} AND env = ${envFilter}
  `;
  if (result.count === 0) return c.json({ error: `Secret '${name}' not found` }, 404);
  return c.json({ rotated: name, updated_at: now });
});
