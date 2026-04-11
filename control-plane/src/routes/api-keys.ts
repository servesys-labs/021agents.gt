/**
 * API key routes — list, create, revoke, rotate.
 *
 * All routes are protected (require authenticated user via c.var.user).
 */
import { createRoute, z } from "@hono/zod-openapi";
import { createOpenAPIRouter } from "../lib/openapi";
import { ErrorSchema, errorResponses, ApiKeyCreateBody, ApiKeySummary } from "../schemas/openapi";
import type { CurrentUser } from "../auth/types";
import { generateApiKey, hashApiKey } from "../auth/api-keys";
import { withOrgDb } from "../db/client";
import { requireScope, invalidateAuthCache } from "../middleware/auth";
import { logSecurityEvent } from "../logic/security-events";

export const apiKeyRoutes = createOpenAPIRouter();

// ── Helpers ──────────────────────────────────────────────────────────────

function generateId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

function ensureUser(user: CurrentUser): boolean {
  return !!user.user_id && !!user.org_id;
}

function normalizeTimestamp(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value < 1e12 ? value * 1000 : value;
    return new Date(ms).toISOString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^\d+$/.test(trimmed)) {
      const n = Number(trimmed);
      if (Number.isFinite(n)) {
        const ms = n < 1e12 ? n * 1000 : n;
        return new Date(ms).toISOString();
      }
    }
    const parsed = Date.parse(trimmed);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
    return null;
  }
  return null;
}

// ── GET / — List all API keys for the current user's org ─────────────────

const listApiKeysRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["API Keys"],
  summary: "List all API keys for the current org",
  middleware: [requireScope("api_keys:read")],
  responses: {
    200: {
      description: "List of API keys",
      content: { "application/json": { schema: z.array(ApiKeySummary) } },
    },
    ...errorResponses(401, 500),
  },
});
apiKeyRoutes.openapi(listApiKeysRoute, async (c): Promise<any> => {
  const user = c.get("user");
  if (!ensureUser(user)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const rows = await sql`
      SELECT
        key_id, name, key_prefix, scopes, project_id, env,
        expires_at, created_at, last_used_at, is_active,
        ip_allowlist, allowed_agents, rate_limit_rpm, rate_limit_rpd
      FROM api_keys
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
        expires_at: normalizeTimestamp(r.expires_at),
        created_at: normalizeTimestamp(r.created_at) ?? new Date().toISOString(),
        last_used_at: normalizeTimestamp(r.last_used_at),
        is_active: Boolean(r.is_active),
        ip_allowlist: Array.isArray(r.ip_allowlist) ? r.ip_allowlist : [],
        allowed_agents: Array.isArray(r.allowed_agents) ? r.allowed_agents : [],
        rate_limit_rpm: Number(r.rate_limit_rpm || 60),
        rate_limit_rpd: Number(r.rate_limit_rpd || 10000),
      };
    });

    return c.json(keys);
  });
});

// ── POST / — Create a new API key ────────────────────────────────────────

const createApiKeyRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["API Keys"],
  summary: "Create a new API key",
  middleware: [requireScope("api_keys:write")],
  request: {
    body: {
      content: {
        "application/json": { schema: ApiKeyCreateBody },
      },
    },
  },
  responses: {
    200: {
      description: "Created API key (includes full key, shown only once)",
      content: {
        "application/json": {
          schema: ApiKeySummary.extend({ key: z.string() }),
        },
      },
    },
    ...errorResponses(400, 401, 500),
  },
});
apiKeyRoutes.openapi(createApiKeyRoute, async (c): Promise<any> => {
  const user = c.get("user");
  if (!ensureUser(user)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const req = c.req.valid("json");

  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const { key, prefix } = generateApiKey();
    const keyHash = await hashApiKey(key);
    const keyId = generateId();
    const nowEpoch = new Date().toISOString();

    let expiresAt: string | null = null;
    if (req.expires_in_days) {
      expiresAt = new Date(Date.now() + req.expires_in_days * 86400 * 1000).toISOString();
    }

    const scopesJson = JSON.stringify(req.scopes);

    // Keep JSONB NOT NULL columns non-null on insert.
    const ipAllowlistArr = Array.isArray(req.ip_allowlist) ? req.ip_allowlist : [];
    const allowedAgentsArr = Array.isArray(req.allowed_agents) ? req.allowed_agents : [];

    await sql`
      INSERT INTO api_keys (
        key_id, org_id, user_id, name, key_prefix, key_hash, scopes,
        project_id, env, expires_at, is_active, created_at,
        ip_allowlist, allowed_agents, rate_limit_rpm, rate_limit_rpd
      ) VALUES (
        ${keyId}, ${user.org_id}, ${user.user_id}, ${req.name}, ${prefix},
        ${keyHash}, ${scopesJson}, ${req.project_id}, ${req.env},
        ${expiresAt}, ${true}, ${nowEpoch},
        ${ipAllowlistArr}, ${allowedAgentsArr}, ${req.rate_limit_rpm}, ${req.rate_limit_rpd}
      )
    `;

    // Audit log (fire-and-forget)
    sql`
      INSERT INTO audit_log (action, actor_id, org_id, resource_type, resource_name, details, created_at)
      VALUES (
        ${"apikey.create"}, ${user.user_id}, ${user.org_id}, ${"api_key"}, ${keyId},
        ${JSON.stringify({ name: req.name, scopes: req.scopes, project_id: req.project_id, env: req.env })},
        ${nowEpoch}
      )
    `.catch(() => {}); // Best-effort audit

    // Security event: API key created
    logSecurityEvent(sql, {
      org_id: user.org_id,
      event_type: "api_key.created",
      actor_id: user.user_id,
      actor_type: "user",
      target_id: keyId,
      target_type: "api_key",
      severity: "info",
      details: { name: req.name, scopes: req.scopes, project_id: req.project_id },
    });

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
      ip_allowlist: req.ip_allowlist,
      allowed_agents: req.allowed_agents,
      rate_limit_rpm: req.rate_limit_rpm,
      rate_limit_rpd: req.rate_limit_rpd,
      key, // Full key — only shown once at creation
    });
  });
});

// ── DELETE /:key_id — Revoke an API key ──────────────────────────────────

const revokeApiKeyRoute = createRoute({
  method: "delete",
  path: "/{key_id}",
  tags: ["API Keys"],
  summary: "Revoke an API key",
  middleware: [requireScope("api_keys:write")],
  request: {
    params: z.object({ key_id: z.string() }),
  },
  responses: {
    200: {
      description: "API key revoked",
      content: { "application/json": { schema: z.object({ revoked: z.string() }) } },
    },
    ...errorResponses(401, 404, 500),
  },
});
apiKeyRoutes.openapi(revokeApiKeyRoute, async (c): Promise<any> => {
  const user = c.get("user");
  if (!ensureUser(user)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const { key_id: keyId } = c.req.valid("param");
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const result = await sql`
      UPDATE api_keys SET is_active = ${0}
      WHERE key_id = ${keyId}
      RETURNING key_id
    `;

    if (result.length === 0) {
      return c.json({ error: "API key not found" }, 404);
    }

    // Security event: API key revoked
    logSecurityEvent(sql, {
      org_id: user.org_id,
      event_type: "api_key.revoked",
      actor_id: user.user_id,
      actor_type: "user",
      target_id: keyId,
      target_type: "api_key",
      severity: "medium",
      details: { key_id: keyId },
    });

    // Invalidate cached auth so revoked key is rejected immediately
    await invalidateAuthCache(c.env);

    return c.json({ revoked: keyId });
  });
});

// ── POST /:key_id/rotate — Rotate an API key ────────────────────────────

const rotateApiKeyRoute = createRoute({
  method: "post",
  path: "/{key_id}/rotate",
  tags: ["API Keys"],
  summary: "Rotate an API key (revoke old, create new with same config)",
  middleware: [requireScope("api_keys:write")],
  request: {
    params: z.object({ key_id: z.string() }),
  },
  responses: {
    200: {
      description: "Rotated API key (includes full key, shown only once)",
      content: {
        "application/json": {
          schema: ApiKeySummary.extend({ key: z.string() }),
        },
      },
    },
    ...errorResponses(401, 404, 500),
  },
});
apiKeyRoutes.openapi(rotateApiKeyRoute, async (c): Promise<any> => {
  const user = c.get("user");
  if (!ensureUser(user)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const { key_id: keyId } = c.req.valid("param");
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    // Fetch the existing key (RLS enforces org isolation)
    const rows = await sql`
      SELECT
        key_id, org_id, user_id, name, scopes, project_id, env,
        expires_at, ip_allowlist, allowed_agents, rate_limit_rpm, rate_limit_rpd
      FROM api_keys
      WHERE key_id = ${keyId}
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
    const nowEpoch = new Date().toISOString();
    const scopesJson = JSON.stringify(scopes);

    // Revoke old + create new in sequence
    await sql`UPDATE api_keys SET is_active = ${0} WHERE key_id = ${keyId}`;

    await sql`
      INSERT INTO api_keys (
        key_id, org_id, user_id, name, key_prefix, key_hash, scopes,
        project_id, env, expires_at, is_active, created_at,
        ip_allowlist, allowed_agents, rate_limit_rpm, rate_limit_rpd
      ) VALUES (
        ${newKeyId}, ${user.org_id}, ${user.user_id}, ${old.name}, ${prefix},
        ${keyHash}, ${scopesJson}, ${old.project_id || ""}, ${old.env || ""},
        ${old.expires_at || null}, ${true}, ${nowEpoch},
        ${Array.isArray(old.ip_allowlist) ? old.ip_allowlist : []},
        ${Array.isArray(old.allowed_agents) ? old.allowed_agents : []},
        ${Number(old.rate_limit_rpm || 60)}, ${Number(old.rate_limit_rpd || 10000)}
      )
    `;

    // Security event: API key rotated
    logSecurityEvent(sql, {
      org_id: user.org_id,
      event_type: "api_key.rotated",
      actor_id: user.user_id,
      actor_type: "user",
      target_id: keyId,
      target_type: "api_key",
      severity: "medium",
      details: { old_key_id: keyId, new_key_id: newKeyId },
    });

    // Invalidate cached auth so old key is rejected immediately after rotation.
    await invalidateAuthCache(c.env);

    return c.json({
      key_id: newKeyId,
      name: old.name,
      key_prefix: prefix,
      scopes,
      project_id: old.project_id || "",
      env: old.env || "",
      expires_at: old.expires_at || null,
      created_at: nowEpoch,
      last_used_at: null,
      is_active: true,
      ip_allowlist: Array.isArray(old.ip_allowlist) ? old.ip_allowlist : [],
      allowed_agents: Array.isArray(old.allowed_agents) ? old.allowed_agents : [],
      rate_limit_rpm: Number(old.rate_limit_rpm || 60),
      rate_limit_rpd: Number(old.rate_limit_rpd || 10000),
      key, // Full key — only shown once
    });
  });
});
