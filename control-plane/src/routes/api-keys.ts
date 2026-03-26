/**
 * API key routes — list, create, revoke, rotate.
 * Ported from agentos/api/routers/api_keys.py.
 *
 * All routes are protected (require authenticated user via c.var.user).
 */
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import type { CurrentUser } from "../auth/types";
import { generateApiKey, hashApiKey } from "../auth/api-keys";
import { getDbForOrg } from "../db/client";
import { requireScope } from "../middleware/auth";

type R = { Bindings: Env; Variables: { user: CurrentUser } };
export const apiKeyRoutes = new Hono<R>();

// ── Zod schemas ──────────────────────────────────────────────────────────

const CreateApiKeyRequest = z.object({
  name: z.string().min(1).max(255).default("default"),
  scopes: z.array(z.string()).default(["*"]),
  project_id: z.string().default(""),
  env: z.string().default(""),
  expires_in_days: z.number().int().positive().nullable().optional(),
});

// ── Helpers ──────────────────────────────────────────────────────────────

function generateId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

function ensureUser(user: CurrentUser): boolean {
  return !!user.user_id && !!user.org_id;
}

// ── GET / — List all API keys for the current user's org ─────────────────

apiKeyRoutes.get("/", requireScope("api_keys:read"), async (c) => {
  const user = c.get("user");
  if (!ensureUser(user)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const rows = await sql`
    SELECT key_id, name, key_prefix, scopes, project_id, env, created_at, last_used_at, is_active
    FROM api_keys
    WHERE org_id = ${user.org_id}
    ORDER BY created_at DESC
  `;

  const keys = rows.map((r: any) => {
    let scopes: string[];
    try {
      scopes = typeof r.scopes === "string" ? JSON.parse(r.scopes) : r.scopes;
    } catch {
      scopes = ["*"];
    }

    return {
      key_id: r.key_id,
      name: r.name,
      key_prefix: r.key_prefix,
      scopes,
      project_id: r.project_id || "",
      env: r.env || "",
      created_at: Number(r.created_at),
      last_used_at: r.last_used_at ? Number(r.last_used_at) : null,
      is_active: Boolean(r.is_active),
    };
  });

  return c.json(keys);
});

// ── POST / — Create a new API key ────────────────────────────────────────

apiKeyRoutes.post("/", requireScope("api_keys:write"), async (c) => {
  const user = c.get("user");
  if (!ensureUser(user)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const body = await c.req.json().catch(() => ({}));
  const parsed = CreateApiKeyRequest.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation failed", detail: parsed.error.issues[0]?.message }, 400);
  }
  const req = parsed.data;

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const { key, prefix } = generateApiKey();
  const keyHash = await hashApiKey(key);
  const keyId = generateId();
  const nowEpoch = Date.now() / 1000;

  let expiresAt: number | null = null;
  if (req.expires_in_days) {
    expiresAt = nowEpoch + req.expires_in_days * 86400;
  }

  const scopesJson = JSON.stringify(req.scopes);

  await sql`
    INSERT INTO api_keys (
      key_id, org_id, user_id, name, key_prefix, key_hash, scopes,
      project_id, env, expires_at, is_active, created_at
    ) VALUES (
      ${keyId}, ${user.org_id}, ${user.user_id}, ${req.name}, ${prefix},
      ${keyHash}, ${scopesJson}, ${req.project_id}, ${req.env},
      ${expiresAt}, ${true}, ${nowEpoch}
    )
  `;

  // Audit log (fire-and-forget)
  sql`
    INSERT INTO audit_log (event, user_id, org_id, resource_type, resource_id, changes, created_at)
    VALUES (
      ${"apikey.create"}, ${user.user_id}, ${user.org_id}, ${"api_key"}, ${keyId},
      ${JSON.stringify({ name: req.name, scopes: req.scopes, project_id: req.project_id, env: req.env })},
      ${nowEpoch}
    )
  `.catch(() => {}); // Best-effort audit

  return c.json({
    key_id: keyId,
    name: req.name,
    key_prefix: prefix,
    scopes: req.scopes,
    project_id: req.project_id,
    env: req.env,
    created_at: nowEpoch,
    last_used_at: null,
    is_active: true,
    key, // Full key — only shown once at creation
  });
});

// ── DELETE /:key_id — Revoke an API key ──────────────────────────────────

apiKeyRoutes.delete("/:key_id", requireScope("api_keys:write"), async (c) => {
  const user = c.get("user");
  if (!ensureUser(user)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const keyId = c.req.param("key_id");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const result = await sql`
    UPDATE api_keys SET is_active = ${false}
    WHERE key_id = ${keyId} AND org_id = ${user.org_id}
    RETURNING key_id
  `;

  if (result.length === 0) {
    return c.json({ error: "API key not found" }, 404);
  }

  return c.json({ revoked: keyId });
});

// ── POST /:key_id/rotate — Rotate an API key ────────────────────────────

apiKeyRoutes.post("/:key_id/rotate", requireScope("api_keys:write"), async (c) => {
  const user = c.get("user");
  if (!ensureUser(user)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const keyId = c.req.param("key_id");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  // Fetch the existing key
  const rows = await sql`
    SELECT key_id, org_id, user_id, name, scopes, project_id, env
    FROM api_keys
    WHERE key_id = ${keyId} AND org_id = ${user.org_id}
  `;

  if (rows.length === 0) {
    return c.json({ error: "API key not found" }, 404);
  }

  const old = rows[0];

  // Parse scopes from old key
  let scopes: string[];
  try {
    scopes = typeof old.scopes === "string" ? JSON.parse(old.scopes) : old.scopes;
  } catch {
    scopes = ["*"];
  }

  const { key, prefix } = generateApiKey();
  const keyHash = await hashApiKey(key);
  const newKeyId = generateId();
  const nowEpoch = Date.now() / 1000;
  const scopesJson = JSON.stringify(scopes);

  // Revoke old + create new in sequence
  await sql`UPDATE api_keys SET is_active = ${false} WHERE key_id = ${keyId}`;

  await sql`
    INSERT INTO api_keys (
      key_id, org_id, user_id, name, key_prefix, key_hash, scopes,
      project_id, env, is_active, created_at
    ) VALUES (
      ${newKeyId}, ${user.org_id}, ${user.user_id}, ${old.name}, ${prefix},
      ${keyHash}, ${scopesJson}, ${old.project_id || ""}, ${old.env || ""},
      ${true}, ${nowEpoch}
    )
  `;

  return c.json({
    key_id: newKeyId,
    name: old.name,
    key_prefix: prefix,
    scopes,
    project_id: old.project_id || "",
    env: old.env || "",
    created_at: nowEpoch,
    last_used_at: null,
    is_active: true,
    key, // Full key — only shown once
  });
});
