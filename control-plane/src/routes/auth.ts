/**
 * Auth routes — signup, login, providers, me, logout, password change, CF Access exchange.
 * Ported from agentos/api/routers/auth.py.
 *
 * Note: The auth middleware skips all /api/v1/auth/* paths, so public routes
 * (signup, login, providers) work without tokens. Protected routes (me, logout,
 * password) must manually resolve the user from the Authorization header.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import type { CurrentUser, TokenClaims } from "../auth/types";
import { createToken, verifyToken } from "../auth/jwt";
import { hashPassword, verifyPassword } from "../auth/password";
import { verifyCfAccessToken, cfAccessEnabled, deriveDisplayName } from "../auth/cf-access";
import { getDb } from "../db/client";

type R = { Bindings: Env; Variables: { user: CurrentUser } };
export const authRoutes = new Hono<R>();

/** Fire-and-forget audit log for auth events */
async function auditAuthEvent(
  sql: ReturnType<typeof getDb>,
  action: string,
  userId: string,
  orgId: string,
  details?: Record<string, unknown>,
): Promise<void> {
  try {
    await sql`
      INSERT INTO audit_log (org_id, user_id, action, resource_type, resource_id, changes_json, created_at)
      VALUES (${orgId}, ${userId}, ${action}, 'auth', ${userId}, ${JSON.stringify(details ?? {})}, now())
    `;
  } catch { /* non-critical */ }
}
const authRateLimitStore = new Map<string, { count: number; resetAt: number }>();

// ── Zod schemas ──────────────────────────────────────────────────────────

const SignupRequest = z.object({
  email: z.string().min(1).email(),
  password: z.string().min(8).max(128),
  name: z.string().default(""),
});

const LoginRequest = z.object({
  email: z.string().min(1),
  password: z.string().min(1),
});

const ChangePasswordRequest = z.object({
  current_password: z.string().min(1),
  new_password: z.string().min(8).max(128),
});

const CfAccessExchangeRequest = z.object({
  cf_access_token: z.string().min(1),
});

const TokenVerifyRequest = z.object({
  token: z.string().min(1),
});

// ── Helpers ──────────────────────────────────────────────────────────────

function generateId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

function getClientIp(c: any): string {
  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded) return String(forwarded).split(",")[0].trim();
  return c.req.header("cf-connecting-ip") || "unknown";
}

function checkRateLimit(c: any, key: string, limit: number, windowMs: number): Response | null {
  const now = Date.now();
  const bucket = authRateLimitStore.get(key);
  if (!bucket || now >= bucket.resetAt) {
    authRateLimitStore.set(key, { count: 1, resetAt: now + windowMs });
    return null;
  }
  if (bucket.count >= limit) {
    const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    return c.json(
      { error: "Too many requests", retry_after_seconds: retryAfterSeconds },
      429,
      { "Retry-After": String(retryAfterSeconds) },
    );
  }
  bucket.count += 1;
  authRateLimitStore.set(key, bucket);
  return null;
}

/**
 * Resolve the current user from the Authorization header.
 * Used for protected routes within the auth group (which bypass global auth middleware).
 */
async function resolveUser(c: { req: { header(name: string): string | undefined }; env: Env }): Promise<CurrentUser | null> {
  const authHeader = c.req.header("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return null;

  const token = authHeader.slice(7);
  if (!token) return null;

  // Try local JWT
  let claims = await verifyToken(c.env.AUTH_JWT_SECRET, token);

  // Fallback to CF Access
  if (!claims && cfAccessEnabled(c.env.CF_ACCESS_TEAM_DOMAIN)) {
    claims = await verifyCfAccessToken(token, c.env.CF_ACCESS_TEAM_DOMAIN!, {
      aud: c.env.CF_ACCESS_AUD,
    });
  }

  if (!claims) return null;

  let orgId = claims.org_id || "";
  let role = claims.role || "member";

  try {
    const sql = await getDb(c.env.HYPERDRIVE);
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
    // Best-effort DB lookup
  }

  // Look up name from DB
  let name = claims.name || "";
  if (!name) {
    try {
      const sql = await getDb(c.env.HYPERDRIVE);
      const rows = await sql`SELECT name FROM users WHERE user_id = ${claims.sub}`;
      if (rows.length > 0) name = rows[0].name || "";
    } catch {
      // Best-effort
    }
  }

  return {
    user_id: claims.sub,
    email: claims.email,
    name,
    org_id: orgId,
    project_id: "",
    env: "",
    role,
    scopes: ["*"],
    auth_method: "jwt",
  };
}

/**
 * Guard helper — resolves user or returns 401 JSON response.
 */
function requireUser(user: CurrentUser | null, c: any): user is CurrentUser {
  return user !== null && user.user_id !== "";
}

// ── Password auth guard ──────────────────────────────────────────────────

function passwordAuthDisabled(env: Env): boolean {
  return (env.AUTH_ALLOW_PASSWORD ?? "true").toLowerCase() === "false";
}

// ── POST /signup ─────────────────────────────────────────────────────────

authRoutes.post("/signup", async (c) => {
  if (passwordAuthDisabled(c.env)) {
    return c.json({ error: "Password authentication is disabled" }, 403);
  }
  const signupLimit = checkRateLimit(c, `signup:${getClientIp(c)}`, 5, 24 * 60 * 60 * 1000);
  if (signupLimit) return signupLimit;

  const body = await c.req.json().catch(() => ({}));
  const parsed = SignupRequest.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation failed", detail: parsed.error.issues[0]?.message }, 400);
  }
  const { email, password, name } = parsed.data;

  let sql;
  try {
    sql = await getDb(c.env.HYPERDRIVE);
  } catch (err: any) {
    console.error("[auth/signup] DB connection failed:", err);
    return c.json({ error: "Database unavailable", detail: err.message }, 503);
  }

  // Check if user already exists
  try {
    const existing = await sql`SELECT user_id FROM users WHERE email = ${email}`;
    if (existing.length > 0) {
      return c.json({ error: "Email already registered" }, 409);
    }
  } catch (err: any) {
    console.error("[auth/signup] User lookup failed:", err);
    return c.json({ error: "Database query failed", detail: err.message }, 500);
  }

  const userId = generateId();
  let passwordHash: string;
  try {
    passwordHash = await hashPassword(password);
  } catch (err: any) {
    console.error("[auth/signup] Password hashing failed:", err);
    return c.json({ error: "Password processing failed", detail: err.message }, 500);
  }
  const nowEpoch = new Date().toISOString();

  // Create user
  try {
    await sql`
      INSERT INTO users (user_id, email, name, password_hash, provider, created_at)
      VALUES (${userId}, ${email}, ${name}, ${passwordHash}, ${"local"}, ${nowEpoch})
    `;
  } catch (err: any) {
    console.error("[auth/signup] User insert failed:", err);
    return c.json({ error: "Failed to create user", detail: err.message }, 500);
  }

  // Create personal org
  const orgId = generateId();
  const orgSlug = email.split("@")[0].toLowerCase().replace(/\./g, "-");
  const orgName = `${name || orgSlug}'s Org`;

  try {
    await sql`
      INSERT INTO orgs (org_id, name, slug, owner_user_id, plan, created_at)
      VALUES (${orgId}, ${orgName}, ${orgSlug}, ${userId}, ${"free"}, ${nowEpoch})
    `;
  } catch (err: any) {
    console.error("[auth/signup] Org creation failed:", err);
    // User was created, continue with token even if org fails
  }
  try {
    await sql`
      INSERT INTO org_members (org_id, user_id, role, created_at)
      VALUES (${orgId}, ${userId}, ${"owner"}, ${nowEpoch})
    `;
  } catch (err: any) {
    console.error("[auth/signup] Org member insert failed:", err);
  }

  // Create default org_settings
  try {
    await sql`
      INSERT INTO org_settings (org_id, plan_type, settings_json, limits_json, features_json, created_at, updated_at)
      VALUES (
        ${orgId},
        ${"free"},
        ${JSON.stringify({ onboarding_complete: false, default_connectors: [] })},
        ${JSON.stringify({ max_agents: 3, max_runs_per_month: 1000, max_seats: 1 })},
        ${JSON.stringify(["basic_agents", "basic_observability"])},
        now(),
        now()
      )
      ON CONFLICT (org_id) DO NOTHING
    `;
  } catch (err) {
    console.warn("[auth/signup] org_settings insert failed:", err);
  }

  // Seed default event_types for the org (best-effort, idempotent)
  try {
    const defaultEventTypes = [
      { event_type: "agent.created", category: "agents", description: "Agent was created" },
      { event_type: "agent.updated", category: "agents", description: "Agent config was updated" },
      { event_type: "agent.deleted", category: "agents", description: "Agent was deleted" },
      { event_type: "session.started", category: "sessions", description: "Agent session started" },
      { event_type: "session.completed", category: "sessions", description: "Agent session completed" },
      { event_type: "session.failed", category: "sessions", description: "Agent session failed" },
      { event_type: "connector.token_stored", category: "connectors", description: "OAuth token stored" },
      { event_type: "connector.tool_call", category: "connectors", description: "Connector tool invoked" },
      { event_type: "retention.applied", category: "retention", description: "Retention policy applied" },
      { event_type: "config.update", category: "config", description: "Configuration changed" },
      { event_type: "member.invited", category: "orgs", description: "Member invited to org" },
      { event_type: "member.removed", category: "orgs", description: "Member removed from org" },
    ];
    for (const et of defaultEventTypes) {
      await sql`
        INSERT INTO event_types (event_type, category, description)
        VALUES (${et.event_type}, ${et.category}, ${et.description})
        ON CONFLICT (event_type) DO NOTHING
      `;
    }
  } catch (err) {
    console.warn("[auth/signup] event_types seed failed:", err);
  }

  // Create default project for the new org
  try {
    const projectId = generateId();
    const projectSlug = email.split("@")[0].toLowerCase().replace(/\./g, "-").slice(0, 30) || "my-agents";

    await sql`
      INSERT INTO projects (project_id, org_id, name, slug, description, default_env, default_plan, created_at, updated_at)
      VALUES (${projectId}, ${orgId}, ${`${projectSlug}'s project`}, ${projectSlug}, ${"Default project"}, ${"development"}, ${"standard"}, ${nowEpoch}, ${nowEpoch})
    `;

    // Create default environments
    for (const envName of ["development", "staging", "production"]) {
      const envId = generateId();
      await sql`
        INSERT INTO environments (env_id, project_id, name, is_active, created_at)
        VALUES (${envId}, ${projectId}, ${envName}, ${true}, ${nowEpoch})
      `;
    }
  } catch (err) {
    // Default project creation is best-effort — don't fail signup
    console.warn("[auth/signup] Default project creation failed:", err);
  }

  const token = await createToken(c.env.AUTH_JWT_SECRET, userId, {
    email,
    name,
    org_id: orgId,
    provider: "local",
  });

  auditAuthEvent(sql, "auth.signup", userId, orgId, { email, provider: "local" });

  return c.json({
    token,
    user_id: userId,
    email,
    org_id: orgId,
    provider: "local",
  });
});

// ── POST /login ──────────────────────────────────────────────────────────

authRoutes.post("/login", async (c) => {
  if (passwordAuthDisabled(c.env)) {
    return c.json({ error: "Password authentication is disabled" }, 403);
  }
  const loginLimit = checkRateLimit(c, `login:${getClientIp(c)}`, 10, 60 * 60 * 1000);
  if (loginLimit) return loginLimit;

  const body = await c.req.json().catch(() => ({}));
  const parsed = LoginRequest.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation failed", detail: parsed.error.issues[0]?.message }, 400);
  }
  const { email, password } = parsed.data;

  const sql = await getDb(c.env.HYPERDRIVE);

  const rows = await sql`
    SELECT user_id, email, name, password_hash FROM users WHERE email = ${email}
  `;
  if (rows.length === 0) {
    return c.json({ error: "Invalid credentials" }, 401);
  }

  const user = rows[0];
  if (!user.password_hash) {
    return c.json({ error: "Invalid credentials" }, 401);
  }

  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) {
    return c.json({ error: "Invalid credentials" }, 401);
  }

  // Get default org
  const orgRows = await sql`
    SELECT org_id FROM org_members WHERE user_id = ${user.user_id} LIMIT 1
  `;
  const orgId = orgRows.length > 0 ? orgRows[0].org_id : "";

  const token = await createToken(c.env.AUTH_JWT_SECRET, user.user_id, {
    email: user.email,
    name: user.name || "",
    org_id: orgId,
    provider: "local",
  });

  auditAuthEvent(sql, "auth.login", user.user_id, String(orgId), { email: user.email, provider: "local" });

  return c.json({
    token,
    user_id: user.user_id,
    email: user.email,
    org_id: orgId,
    provider: "local",
  });
});

// ── GET /providers ───────────────────────────────────────────────────────

authRoutes.get("/providers", (c) => {
  const cfAccessIsEnabled = cfAccessEnabled(c.env.CF_ACCESS_TEAM_DOMAIN);
  return c.json({
    active_provider: cfAccessIsEnabled ? "cf_access" : "local",
    cf_access_enabled: cfAccessIsEnabled,
    cf_access_team_domain: cfAccessIsEnabled ? c.env.CF_ACCESS_TEAM_DOMAIN : undefined,
    password_enabled: !passwordAuthDisabled(c.env),
  });
});

// ── POST /cf-access/exchange ─────────────────────────────────────────────

authRoutes.post("/cf-access/exchange", async (c) => {
  if (!cfAccessEnabled(c.env.CF_ACCESS_TEAM_DOMAIN)) {
    return c.json({ error: "Cloudflare Access auth is not enabled" }, 400);
  }

  const body = await c.req.json().catch(() => ({}));
  const parsed = CfAccessExchangeRequest.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "cf_access_token is required" }, 400);
  }

  const cfClaims = await verifyCfAccessToken(parsed.data.cf_access_token, c.env.CF_ACCESS_TEAM_DOMAIN!, {
    aud: c.env.CF_ACCESS_AUD,
  });

  if (!cfClaims || !cfClaims.sub || !cfClaims.email) {
    return c.json({ error: "Invalid CF Access token" }, 401);
  }

  const sql = await getDb(c.env.HYPERDRIVE);
  const nowEpoch = new Date().toISOString();

  // Provision user from CF Access identity (upsert by email)
  const cfAccessUserId = `cfaccess:${cfClaims.sub}`;
  let userId: string;
  let orgId: string = "";
  let role: string = "member";
  let userName = cfClaims.name || "";

  // Check if user exists by cfaccess-prefixed ID first, then by email
  const existingById = await sql`SELECT user_id, email, name FROM users WHERE user_id = ${cfAccessUserId}`;
  const existingByEmail = existingById.length > 0
    ? []
    : await sql`SELECT user_id, email, name FROM users WHERE email = ${cfClaims.email}`;

  if (existingById.length > 0) {
    userId = existingById[0].user_id;
    userName = userName || existingById[0].name || "";

    if (userName) {
      await sql`UPDATE users SET name = ${userName} WHERE user_id = ${userId}`;
    }
  } else if (existingByEmail.length > 0) {
    userId = existingByEmail[0].user_id;
    userName = userName || existingByEmail[0].name || "";

    if (userName) {
      await sql`UPDATE users SET name = ${userName} WHERE user_id = ${userId}`;
    }
  } else {
    // Create new user with cfaccess-prefixed ID
    userId = cfAccessUserId;
    await sql`
      INSERT INTO users (user_id, email, name, password_hash, provider, created_at)
      VALUES (${userId}, ${cfClaims.email}, ${userName}, ${""}, ${"cf_access"}, ${nowEpoch})
    `;
  }

  // CF Access JWTs have no org_id — always take personal-org path
  const orgRows = await sql`
    SELECT org_id, role FROM org_members WHERE user_id = ${userId} ORDER BY created_at ASC LIMIT 1
  `;
  if (orgRows.length > 0) {
    orgId = orgRows[0].org_id;
    role = orgRows[0].role;
  } else {
    orgId = generateId();
    const orgSlug = cfClaims.email.split("@")[0].toLowerCase().replace(/\./g, "-");
    await sql`
      INSERT INTO orgs (org_id, name, slug, owner_user_id, plan, created_at)
      VALUES (${orgId}, ${`${userName || orgSlug}'s Org`}, ${orgSlug}, ${userId}, ${"free"}, ${nowEpoch})
    `;
    await sql`
      INSERT INTO org_members (org_id, user_id, role, created_at)
      VALUES (${orgId}, ${userId}, ${"owner"}, ${nowEpoch})
    `;
    // Create default org_settings for CF Access provisioned org
    try {
      await sql`
        INSERT INTO org_settings (org_id, plan_type, settings_json, limits_json, features_json, created_at, updated_at)
        VALUES (
          ${orgId},
          ${"free"},
          ${JSON.stringify({ onboarding_complete: false, default_connectors: [] })},
          ${JSON.stringify({ max_agents: 3, max_runs_per_month: 1000, max_seats: 1 })},
          ${JSON.stringify(["basic_agents", "basic_observability"])},
          ${nowEpoch},
          ${nowEpoch}
        )
      `;
    } catch {}
    role = "owner";
  }

  const token = await createToken(c.env.AUTH_JWT_SECRET, userId, {
    email: cfClaims.email,
    name: userName,
    org_id: orgId,
    provider: "cf_access",
    extra: { role },
  });

  return c.json({
    token,
    user_id: userId,
    email: cfClaims.email,
    org_id: orgId,
    provider: "cf_access",
    name: userName,
  });
});

// ── POST /token/verify ───────────────────────────────────────────────────

authRoutes.post("/token/verify", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = TokenVerifyRequest.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "token is required" }, 400);
  }

  let claims = await verifyToken(c.env.AUTH_JWT_SECRET, parsed.data.token);

  // Fallback to CF Access
  if (!claims && cfAccessEnabled(c.env.CF_ACCESS_TEAM_DOMAIN)) {
    claims = await verifyCfAccessToken(parsed.data.token, c.env.CF_ACCESS_TEAM_DOMAIN!, {
      aud: c.env.CF_ACCESS_AUD,
    });
  }

  if (!claims) {
    return c.json({ valid: false }, 401);
  }

  return c.json({
    valid: true,
    user_id: claims.sub,
    email: claims.email,
    org_id: claims.org_id,
    exp: claims.exp,
  });
});

// ── GET /me (protected) ──────────────────────────────────────────────────

authRoutes.get("/me", async (c) => {
  const user = await resolveUser(c);
  if (!requireUser(user, c)) {
    return c.json({ error: "Missing or invalid Authorization header" }, 401);
  }

  return c.json({
    user_id: user.user_id,
    email: user.email,
    name: user.name,
    org_id: user.org_id,
    role: user.role,
  });
});

// ── POST /logout (protected) ────────────────────────────────────────────

authRoutes.post("/logout", async (c) => {
  const user = await resolveUser(c);
  if (!requireUser(user, c)) {
    return c.json({ error: "Missing or invalid Authorization header" }, 401);
  }

  // Stateless JWT — client discards the token. Server acknowledges.
  const sql = getDb(c.env.HYPERDRIVE);
  auditAuthEvent(sql, "auth.logout", user.user_id, user.org_id ?? "", { email: user.email });

  return c.json({ logged_out: true });
});

// ── POST /password (protected) ──────────────────────────────────────────

authRoutes.post("/password", async (c) => {
  if (passwordAuthDisabled(c.env)) {
    return c.json({ error: "Password authentication is disabled" }, 403);
  }
  const user = await resolveUser(c);
  if (!requireUser(user, c)) {
    return c.json({ error: "Missing or invalid Authorization header" }, 401);
  }

  const body = await c.req.json().catch(() => ({}));
  const parsed = ChangePasswordRequest.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation failed", detail: parsed.error.issues[0]?.message }, 400);
  }
  const { current_password, new_password } = parsed.data;

  const sql = await getDb(c.env.HYPERDRIVE);

  const rows = await sql`
    SELECT password_hash FROM users WHERE user_id = ${user.user_id}
  `;
  if (rows.length === 0 || !rows[0].password_hash) {
    return c.json({ error: "Current password is incorrect" }, 401);
  }

  const valid = await verifyPassword(current_password, rows[0].password_hash);
  if (!valid) {
    return c.json({ error: "Current password is incorrect" }, 401);
  }

  const newHash = await hashPassword(new_password);
  const nowEpoch = new Date().toISOString();

  await sql`
    UPDATE users SET password_hash = ${newHash}, updated_at = ${nowEpoch}
    WHERE user_id = ${user.user_id}
  `;

  return c.json({ updated: true });
});
