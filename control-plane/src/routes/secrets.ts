/**
 * Secrets router — encrypted secrets vault per org/project/env.
 * Ported from agentos/api/routers/secrets.py
 *
 * Uses Fernet encryption (AES-CBC + HMAC-SHA256) via Web Crypto.
 */
import { createRoute, z } from "@hono/zod-openapi";
import { createOpenAPIRouter } from "../lib/openapi";
import { ErrorSchema, errorResponses } from "../schemas/openapi";
import type { CurrentUser } from "../auth/types";
import type { Env } from "../env";
import { getDbForOrg } from "../db/client";
import { fernetEncrypt } from "../logic/fernet";
import { requireScope } from "../middleware/auth";

export const secretRoutes = createOpenAPIRouter();

function getKeySeed(env: Env): string {
  const key = env.SECRETS_ENCRYPTION_KEY;
  if (!key) throw Object.assign(new Error("SECRETS_ENCRYPTION_KEY is required"), { status: 503 });
  return key;
}

// ── GET / — List secrets (metadata only) ────────────────────────────────────
const listSecretsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Secrets"],
  summary: "List secrets (metadata only)",
  middleware: [requireScope("secrets:read")],
  request: {
    query: z.object({
      project_id: z.string().optional(),
      env: z.string().optional(),
    }),
  },
  responses: {
    200: { description: "Secrets list", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(401, 403),
  },
});
secretRoutes.openapi(listSecretsRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const query = c.req.valid("query");
  const projectId = query.project_id || "";
  const envFilter = query.env || "";
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

// ── POST / — Create a secret ────────────────────────────────────────────────
const createSecretRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Secrets"],
  summary: "Create a secret",
  middleware: [requireScope("secrets:write")],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            name: z.string().min(1),
            value: z.string().min(1),
            project_id: z.string().optional(),
            env: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Secret created", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(400, 401, 403, 409),
  },
});
secretRoutes.openapi(createSecretRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const body = c.req.valid("json");
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
  const now = new Date().toISOString();

  await sql`
    INSERT INTO secrets (org_id, project_id, env, name, value_encrypted, created_by, created_at, updated_at)
    VALUES (${user.org_id}, ${projectId}, ${envFilter}, ${name}, ${encrypted}, ${user.user_id}, ${now}, ${now})
  `;

  return c.json({ created: name, project_id: projectId, env: envFilter });
});

// ── DELETE /{name} — Delete a secret ────────────────────────────────────────
const deleteSecretRoute = createRoute({
  method: "delete",
  path: "/{name}",
  tags: ["Secrets"],
  summary: "Delete a secret",
  middleware: [requireScope("secrets:write")],
  request: {
    params: z.object({ name: z.string() }),
    query: z.object({
      project_id: z.string().optional(),
      env: z.string().optional(),
    }),
  },
  responses: {
    200: { description: "Secret deleted", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(401, 403, 404),
  },
});
secretRoutes.openapi(deleteSecretRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { name } = c.req.valid("param");
  const query = c.req.valid("query");
  const projectId = query.project_id || "";
  const envFilter = query.env || "";
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const result = await sql`
    DELETE FROM secrets
    WHERE org_id = ${user.org_id} AND name = ${name} AND project_id = ${projectId} AND env = ${envFilter}
  `;
  if (result.count === 0) return c.json({ error: `Secret '${name}' not found` }, 404);
  return c.json({ deleted: name });
});

// ── POST /{name}/rotate — Rotate a secret value ────────────────────────────
const rotateSecretRoute = createRoute({
  method: "post",
  path: "/{name}/rotate",
  tags: ["Secrets"],
  summary: "Rotate a secret value",
  middleware: [requireScope("secrets:write")],
  request: {
    params: z.object({ name: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            new_value: z.string().min(1),
            project_id: z.string().optional(),
            env: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Secret rotated", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(400, 401, 403, 404),
  },
});
secretRoutes.openapi(rotateSecretRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { name } = c.req.valid("param");
  const body = c.req.valid("json");
  const newValue = String(body.new_value || "");
  const projectId = String(body.project_id || "");
  const envFilter = String(body.env || "");

  if (!newValue) return c.json({ error: "new_value is required" }, 400);

  const encrypted = await fernetEncrypt(newValue, getKeySeed(c.env));
  const now = new Date().toISOString();
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const result = await sql`
    UPDATE secrets SET value_encrypted = ${encrypted}, updated_at = ${now}
    WHERE org_id = ${user.org_id} AND name = ${name} AND project_id = ${projectId} AND env = ${envFilter}
  `;
  if (result.count === 0) return c.json({ error: `Secret '${name}' not found` }, 404);
  return c.json({ rotated: name, updated_at: now });
});
