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
import { hasScope, hasRole, type TokenClaims } from "../auth/types";
import { getDb } from "../db/client";
import { logSecurityEvent } from "../auth/security-events";

// In-memory TTL cache (bounded, same as Python's _auth_cache)
const AUTH_CACHE_MAX = 2048;
const AUTH_CACHE_TTL = 60_000; // 1 min in ms (safety backstop)
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

// ── Cross-isolate cache invalidation via KV version key ──────────
// When API keys are revoked, the version key is bumped. Each isolate
// checks the version every 30s and flushes its cache on change.
// This reduces stale-token window from 5 minutes to ~30 seconds.
let _lastVersionCheck = 0;
const VERSION_CHECK_INTERVAL = 30_000; // 30s
const _versionCache = new Map<string, number>();

async function checkCacheVersion(env: any): Promise<void> {
  if (Date.now() - _lastVersionCheck < VERSION_CHECK_INTERVAL) return;
  _lastVersionCheck = Date.now();

  const kv = env?.AGENT_PROGRESS_KV;
  if (!kv) return;

  try {
    const globalVersion = await kv.get("auth-cache-version");
    const remote = globalVersion ? Number(globalVersion) : 0;
    const local = _versionCache.get("global") ?? -1;
    if (remote !== local) {
      // Version changed — flush entire auth cache
      authCache.clear();
      _versionCache.set("global", remote);
    }
  } catch {}
}

/**
 * Bump the auth cache version. Call this when API keys are revoked/rotated.
 * All isolates will flush their caches within 30 seconds.
 */
export async function invalidateAuthCache(env: any): Promise<void> {
  const kv = env?.AGENT_PROGRESS_KV;
  if (!kv) return;
  try {
    const raw = await kv.get("auth-cache-version");
    const version = (raw ? Number(raw) : 0) + 1;
    await kv.put("auth-cache-version", String(version));
    // Also flush local cache immediately
    authCache.clear();
    _versionCache.set("global", version);
  } catch {}
}

async function hashForCache(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ── Session timeout constants ──────────────────────────────────────────
const MAX_TOKEN_AGE_SEC = 86400; // 24 hours
const IDLE_TIMEOUT_SEC = 1800;   // 30 minutes

/**
 * Check session validity: token age + idle timeout for portal JWT users.
 * Returns { valid: true } or { valid: false, reason: string }.
 */
async function checkSessionTimeout(
  claims: TokenClaims,
  sql: any,
): Promise<{ valid: true } | { valid: false; reason: string }> {
  // Token age check: max 24 hours
  if (claims.iat && (Date.now() / 1000 - claims.iat) > MAX_TOKEN_AGE_SEC) {
    return { valid: false, reason: "session_expired" };
  }

  // Idle timeout check: only for portal JWT users (not end-user tokens)
  if (claims.type === "end_user") return { valid: true };

  try {
    const rows = await sql`
      SELECT last_activity_at FROM user_sessions
      WHERE user_id = ${claims.sub} AND revoked = false
      ORDER BY last_activity_at DESC LIMIT 1
    `;
    if (rows.length > 0) {
      const lastActivity = new Date(rows[0].last_activity_at).getTime();
      const idleMs = Date.now() - lastActivity;
      if (idleMs > IDLE_TIMEOUT_SEC * 1000) {
        return { valid: false, reason: "session_expired" };
      }
    }
    // If no session row exists, skip idle check (session tracking not yet set up for this user)
  } catch {
    // Best-effort — if user_sessions table doesn't exist, skip
  }

  return { valid: true };
}

/**
 * Update the user's session activity timestamp (fire-and-forget).
 */
function touchSessionActivity(sql: any, userId: string): void {
  sql`
    UPDATE user_sessions
    SET last_activity_at = NOW()
    WHERE user_id = ${userId} AND revoked = false
  `.catch(() => {
    // Fire-and-forget
  });
}

// Public routes that skip auth
const PUBLIC_PATHS = new Set([
  "/health",
  "/health/detailed",
  "/api/v1/health",
  "/api/v1/health/detailed",
  "/api/v1/auth/login",
  "/api/v1/auth/signup",
  "/api/v1/auth/providers",
  "/api/v1/config",
  "/v1/health",
  "/v1/openapi.json",
  "/v1/docs",
  "/api/v1/openapi.json",
  "/api/v1/_openapi-raw.json",
  "/api/v1/docs",
  "/widget.js",
]);

/** Unauthenticated voice provider webhooks (signature verified in-route). */
function isPublicVoiceWebhook(path: string, method: string): boolean {
  if (method !== "POST") return false;
  if (path === "/api/v1/voice/vapi/webhook") return true;
  if (path === "/api/v1/voice/twilio/incoming") return true;
  const m = path.match(/^\/api\/v1\/voice\/([a-z0-9_-]+)\/webhook$/);
  if (!m) return false;
  return m[1] === "tavus";
}

/** Unauthenticated external webhooks (verified in-route). */
function isPublicExternalWebhook(path: string, method: string): boolean {
  if (method !== "POST") return false;
  if (path === "/api/v1/chat/telegram/webhook") return true;
  if (path === "/api/v1/stripe/webhook") return true;
  if (path === "/api/v1/github/webhooks/receive") return true;
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

  // Public discovery endpoints (marketplace search, feed, agent cards)
  const isPublicDiscovery =
    c.req.method === "GET" && (
      c.req.path === "/api/v1/marketplace/search" ||
      c.req.path.startsWith("/api/v1/marketplace/listings/") ||
      c.req.path === "/api/v1/feed" ||
      c.req.path === "/api/v1/feed/stats" ||
      c.req.path === "/.well-known/agent.json" ||
      c.req.path === "/.well-known/agents.json"
    );

  // Service-to-service auth via SERVICE_TOKEN (runtime tools calling control-plane)
  const isServiceAuth = (() => {
    const serviceToken = c.env.SERVICE_TOKEN || "";
    if (!serviceToken) return false;
    const authHeader = c.req.header("Authorization") || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    return token === serviceToken;
  })();

  // Skip auth for public routes
  if (
    PUBLIC_PATHS.has(c.req.path) ||
    c.req.path.startsWith("/api/v1/auth/") ||
    isPublicPlansRead ||
    isPublicDiscovery ||
    isServiceAuth ||
    isPublicVoiceWebhook(c.req.path, c.req.method) ||
    isPublicExternalWebhook(c.req.path, c.req.method)
  ) {
    // Set default user — service token gets full access, public routes get viewer
    // Service token can pass X-Org-Id header to scope operations to an org
    const serviceOrgId = isServiceAuth ? (c.req.header("X-Org-Id") || "") : "";
    c.set("user", {
      user_id: isServiceAuth ? "service" : "",
      email: "",
      name: isServiceAuth ? "Service Token" : "",
      org_id: serviceOrgId,
      project_id: "",
      env: "",
      role: isServiceAuth ? "owner" : "viewer",
      scopes: isServiceAuth ? ["*"] : [],
      auth_method: "jwt" as const,
    });
    return next();
  }

  // Check KV version for cross-isolate cache invalidation
  await checkCacheVersion(c.env);

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
    const code = e.code ?? undefined;

    // Fire-and-forget: log failed auth attempt
    try {
      const sql = await getDb(c.env.HYPERDRIVE);
      logSecurityEvent(sql, {
        event_type: code === "session_expired" ? "session.expired" : "login.failed",
        user_id: "",
        ip_address: c.req.header("CF-Connecting-IP") ?? c.req.header("X-Forwarded-For") ?? "",
        user_agent: c.req.header("User-Agent") ?? "",
        metadata: { error: e.message, path: c.req.path },
      });
    } catch {
      // Best-effort
    }

    const body: Record<string, unknown> = { error: e.message ?? "Unauthorized" };
    if (code) body.code = code;
    return c.json(body, status);
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

  // ── Session timeout enforcement ──────────────────────────────────────
  let sql: any;
  try {
    sql = await getDb(env.HYPERDRIVE);
  } catch {
    // DB unavailable — skip session checks
  }

  if (sql) {
    const sessionCheck = await checkSessionTimeout(claims, sql);
    if (!sessionCheck.valid) {
      // Log the expiry event (fire-and-forget)
      logSecurityEvent(sql, {
        event_type: "session.expired",
        user_id: claims.sub,
        org_id: claims.org_id || "",
        metadata: { reason: sessionCheck.reason },
      });
      throw Object.assign(
        new Error("Session expired"),
        { status: 401, code: "session_expired" },
      );
    }
  }

  // ── End-user token path ──────────────────────────────────────────────
  if (claims.type === "end_user") {
    const endUser = await resolveEndUserToken(claims, env);
    cachePut(cacheKey, endUser);
    return endUser;
  }

  let orgId = claims.org_id || "";
  let role = claims.role || "member";

  // Look up org membership from DB if needed
  try {
    if (!sql) sql = await getDb(env.HYPERDRIVE);
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

  // Fire-and-forget: update session activity + log success
  if (sql) {
    touchSessionActivity(sql, claims.sub);
    logSecurityEvent(sql, {
      event_type: "login.success",
      user_id: claims.sub,
      org_id: orgId,
    });
  }

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

  // Parse allowed_agents from api_keys row (may be JSON array or Postgres array)
  let allowedAgents: string[] = [];
  try {
    if (row.allowed_agents) {
      allowedAgents = typeof row.allowed_agents === "string"
        ? JSON.parse(row.allowed_agents)
        : Array.isArray(row.allowed_agents)
          ? row.allowed_agents
          : [];
    }
  } catch {}

  // Also check the api_key_agent_scopes junction table
  if (allowedAgents.length === 0) {
    try {
      const scopeRows = await sql`
        SELECT agent_name FROM api_key_agent_scopes WHERE key_id = ${row.key_id}
      `;
      if (scopeRows.length > 0) {
        allowedAgents = scopeRows.map((r: any) => String(r.agent_name));
      }
    } catch {}
  }

  // Parse ip_allowlist from api_keys row (Postgres text[] comes as string[])
  let ipAllowlist: string[] = [];
  try {
    if (row.ip_allowlist) {
      ipAllowlist = Array.isArray(row.ip_allowlist)
        ? row.ip_allowlist.filter((v: unknown) => typeof v === "string" && v.length > 0)
        : typeof row.ip_allowlist === "string"
          ? JSON.parse(row.ip_allowlist)
          : [];
    }
  } catch {}

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
    rateLimitRpm: Number(row.rate_limit_rpm) || 60,
    rateLimitRpd: Number(row.rate_limit_rpd) || 10000,
    allowedAgents: allowedAgents.length > 0 ? allowedAgents : undefined,
    ipAllowlist: ipAllowlist.length > 0 ? ipAllowlist : undefined,
    apiKeyId: row.key_id,
  };

  cachePut(cacheKey, user);
  return user;
}

/**
 * Resolve an end-user token (type: "end_user" JWT) to a CurrentUser.
 * Verifies the token is not revoked by checking the end_user_tokens table.
 */
async function resolveEndUserToken(claims: TokenClaims, env: Env): Promise<CurrentUser> {
  const orgId = claims.org_id || "";
  if (!orgId) {
    throw Object.assign(new Error("End-user token missing org_id"), { status: 401 });
  }

  const endUserId = claims.sub;
  const apiKeyId = String(claims.api_key_id || "");

  // Look up the token in the DB to verify it's not revoked
  const sql = await getDb(env.HYPERDRIVE);
  const rows = await sql`
    SELECT token_id, api_key_id, allowed_agents, rate_limit_rpm, rate_limit_rpd, revoked, expires_at
    FROM end_user_tokens
    WHERE org_id = ${orgId} AND end_user_id = ${endUserId} AND api_key_id = ${apiKeyId}
      AND revoked = false AND expires_at > now()
    ORDER BY created_at DESC LIMIT 1
  `;

  if (rows.length === 0) {
    throw Object.assign(new Error("End-user token revoked or expired"), { status: 401 });
  }

  const row = rows[0];

  // Parse allowed_agents from claims or DB row
  let allowedAgents: string[] = [];
  try {
    const claimAgents = claims.allowed_agents;
    if (Array.isArray(claimAgents)) {
      allowedAgents = claimAgents.map(String);
    } else if (row.allowed_agents) {
      allowedAgents = typeof row.allowed_agents === "string"
        ? JSON.parse(row.allowed_agents)
        : Array.isArray(row.allowed_agents) ? row.allowed_agents : [];
    }
  } catch {}

  // Inherit parent API key IP allowlist for end-user tokens.
  let ipAllowlist: string[] = [];
  try {
    if (row.api_key_id) {
      const keyRows = await sql`
        SELECT ip_allowlist FROM api_keys
        WHERE org_id = ${orgId} AND key_id = ${String(row.api_key_id)} AND is_active = true
        LIMIT 1
      `;
      const allow = keyRows[0]?.ip_allowlist;
      if (Array.isArray(allow)) {
        ipAllowlist = allow.filter((v: unknown) => typeof v === "string" && v.length > 0);
      } else if (typeof allow === "string" && allow.trim()) {
        try {
          const parsed = JSON.parse(allow);
          if (Array.isArray(parsed)) {
            ipAllowlist = parsed.filter((v: unknown) => typeof v === "string" && v.length > 0);
          }
        } catch {}
      }
    }
  } catch {}

  return {
    user_id: endUserId,
    email: "",
    name: "",
    org_id: orgId,
    project_id: "",
    env: "",
    role: "viewer",
    scopes: ["agents:run"], // End-user tokens have limited scopes
    auth_method: "end_user_token",
    rateLimitRpm: Number(row.rate_limit_rpm) || 60,
    rateLimitRpd: Number(row.rate_limit_rpd) || 10000,
    allowedAgents: allowedAgents.length > 0 ? allowedAgents : undefined,
    ipAllowlist: ipAllowlist.length > 0 ? ipAllowlist : undefined,
    endUserApiKeyId: apiKeyId,
  };
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
