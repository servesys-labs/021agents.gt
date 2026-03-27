/**
 * Hono auth middleware — resolves JWT or API key to CurrentUser.
 * Ported from agentos/api/deps.py get_current_user().
 */
import { createMiddleware } from "hono/factory";
import type { Env } from "../env";
import type { CurrentUser } from "../auth/types";
import { verifyToken } from "../auth/jwt";
import { verifyCfAccessToken, cfAccessEnabled } from "../auth/cf-access";
import { hashApiKey } from "../auth/api-keys";
import { hasScope, hasRole } from "../auth/types";
import { getDb } from "../db/client";

// In-memory TTL cache (bounded, same as Python's _auth_cache)
const AUTH_CACHE_MAX = 2048;
const AUTH_CACHE_TTL = 300_000; // 5 min in ms
const authCache = new Map<string, { ts: number; user: CurrentUser }>();

function cacheGet(key: string): CurrentUser | null {
  const entry = authCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > AUTH_CACHE_TTL) {
    authCache.delete(key);
    return null;
  }
  return entry.user;
}

function cachePut(key: string, user: CurrentUser): void {
  authCache.set(key, { ts: Date.now(), user });
  if (authCache.size > AUTH_CACHE_MAX) {
    // Evict oldest 25%
    const entries = [...authCache.entries()].sort((a, b) => a[1].ts - b[1].ts);
    const toRemove = Math.floor(entries.length / 4);
    for (let i = 0; i < toRemove; i++) authCache.delete(entries[i][0]);
  }
}

async function hashForCache(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Public routes that skip auth
const PUBLIC_PATHS = new Set([
  "/health",
  "/health/detailed",
  "/api/v1/health",
  "/api/v1/auth/login",
  "/api/v1/auth/signup",
  "/api/v1/auth/providers",
  "/api/v1/config",
]);

/** Unauthenticated voice provider webhooks (signature verified in-route). */
function isPublicVoiceWebhook(path: string, method: string): boolean {
  if (method !== "POST") return false;
  if (path === "/api/v1/voice/vapi/webhook") return true;
  const m = path.match(/^\/api\/v1\/voice\/([a-z0-9_-]+)\/webhook$/);
  if (!m) return false;
  return m[1] === "tavus";
}

/** Unauthenticated external webhooks (verified in-route). */
function isPublicExternalWebhook(path: string, method: string): boolean {
  if (method !== "POST") return false;
  if (path === "/api/v1/chat/telegram/webhook") return true;
  if (path === "/api/v1/stripe/webhook") return true;
  return false;
}

/**
 * Auth middleware — sets c.var.user to CurrentUser.
 * Returns 401 if no valid auth on protected routes.
 */
export const authMiddleware = createMiddleware<{
  Bindings: Env;
  Variables: { user: CurrentUser };
}>(async (c, next) => {
  // Plans list + detail are public reads; POST /api/v1/plans requires auth.
  const isPublicPlansRead =
    c.req.method !== "POST" &&
    (c.req.path === "/api/v1/plans" || c.req.path.startsWith("/api/v1/plans/"));

  // Skip auth for public routes
  if (
    PUBLIC_PATHS.has(c.req.path) ||
    c.req.path.startsWith("/api/v1/auth/") ||
    isPublicPlansRead ||
    isPublicVoiceWebhook(c.req.path, c.req.method) ||
    isPublicExternalWebhook(c.req.path, c.req.method)
  ) {
    // Set a default empty user for public routes
    c.set("user", {
      user_id: "",
      email: "",
      name: "",
      org_id: "",
      project_id: "",
      env: "",
      role: "viewer",
      scopes: [],
      auth_method: "jwt",
    });
    return next();
  }

  const authHeader = c.req.header("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return c.json({ error: "Missing Authorization header" }, 401);
  }

  const token = authHeader.slice(7);

  try {
    let user: CurrentUser;

    if (token.startsWith("ak_")) {
      user = await resolveApiKey(token, c.env);
    } else {
      user = await resolveJwt(token, c.env);
    }

    c.set("user", user);
    return next();
  } catch (e: any) {
    const status = e.status ?? 401;
    return c.json({ error: e.message ?? "Unauthorized" }, status);
  }
});

async function resolveJwt(token: string, env: Env): Promise<CurrentUser> {
  const cacheKey = `jwt:${await hashForCache(token)}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  // Try local JWT first
  let claims = await verifyToken(env.AUTH_JWT_SECRET, token);

  // Fallback to CF Access
  if (!claims && cfAccessEnabled(env.CF_ACCESS_TEAM_DOMAIN)) {
    claims = await verifyCfAccessToken(token, env.CF_ACCESS_TEAM_DOMAIN!, {
      aud: env.CF_ACCESS_AUD,
    });
  }

  if (!claims) {
    throw Object.assign(new Error("Invalid or expired token"), { status: 401 });
  }

  let orgId = claims.org_id || "";
  let role = claims.role || "member";

  // Look up org membership from DB if needed
  try {
    const sql = await getDb(env.HYPERDRIVE);
    if (!orgId) {
      const rows = await sql`
        SELECT org_id, role FROM org_members
        WHERE user_id = ${claims.sub}
        ORDER BY created_at ASC LIMIT 1
      `;
      if (rows.length > 0) {
        orgId = rows[0].org_id;
        role = rows[0].role;
      }
    } else {
      const rows = await sql`
        SELECT role FROM org_members
        WHERE org_id = ${orgId} AND user_id = ${claims.sub}
      `;
      if (rows.length > 0) role = rows[0].role;
    }
  } catch {
    // Best-effort — DB may be unavailable
  }

  const user: CurrentUser = {
    user_id: claims.sub,
    email: claims.email,
    name: claims.name,
    org_id: orgId,
    project_id: "",
    env: "",
    role,
    scopes: ["*"], // JWT users get full scopes
    auth_method: "jwt",
  };

  cachePut(cacheKey, user);
  return user;
}

async function resolveApiKey(key: string, env: Env): Promise<CurrentUser> {
  const cacheKey = `ak:${await hashForCache(key)}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const keyHash = await hashApiKey(key);
  const sql = await getDb(env.HYPERDRIVE);

  // Always do the same work regardless of key validity (constant-time defense)
  const rows = await sql`
    SELECT * FROM api_keys WHERE key_hash = ${keyHash} LIMIT 1
  `;
  const row = rows.length > 0 ? rows[0] : null;

  // Check active status and expiry even for null row (constant time)
  const isActive = row ? Boolean(row.is_active) : false;
  const isExpired = row?.expires_at ? new Date(row.expires_at).getTime() < Date.now() : false;

  if (!row || !isActive || isExpired) {
    // Always do a dummy user lookup to normalize timing
    await sql`SELECT email FROM users WHERE user_id = 'nonexistent' LIMIT 1`.catch(() => []);
    throw Object.assign(new Error("Invalid or expired API key"), { status: 401 });
  }

  // Update last_used synchronously for parity with backend behavior.
  try {
    await sql`UPDATE api_keys SET last_used_at = ${new Date().toISOString()} WHERE key_id = ${row.key_id}`;
  } catch {
    // Best-effort update only.
  }

  // Get user info
  const userRows = await sql`SELECT email FROM users WHERE user_id = ${row.user_id}`;

  const scopes: string[] = (() => {
    try { return JSON.parse(row.scopes || '["*"]'); } catch { return ["*"]; }
  })();

  const user: CurrentUser = {
    user_id: row.user_id,
    email: userRows[0]?.email ?? "",
    name: "",
    org_id: row.org_id,
    project_id: row.project_id ?? "",
    env: row.env ?? "",
    role: "member",
    scopes,
    auth_method: "api_key",
  };

  cachePut(cacheKey, user);
  return user;
}

/**
 * Scope guard — returns 403 if user lacks the required scope.
 */
export function requireScope(scope: string) {
  return createMiddleware<{
    Bindings: Env;
    Variables: { user: CurrentUser };
  }>(async (c, next) => {
    const user = c.get("user");
    if (!hasScope(user, scope)) {
      return c.json({ error: `Insufficient permissions. Required scope: ${scope}` }, 403);
    }
    return next();
  });
}

/**
 * Role guard — returns 403 if user lacks the minimum role.
 */
export function requireRole(minRole: string) {
  return createMiddleware<{
    Bindings: Env;
    Variables: { user: CurrentUser };
  }>(async (c, next) => {
    const user = c.get("user");
    if (!hasRole(user, minRole)) {
      return c.json({ error: `Insufficient role. Required: ${minRole}, current: ${user.role}` }, 403);
    }
    return next();
  });
}
