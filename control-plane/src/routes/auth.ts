/**
 * Auth routes — signup, login, providers, me, logout, password change, CF Access exchange.
 * Ported from agentos/api/routers/auth.py.
 *
 * Note: The auth middleware skips all /api/v1/auth/* paths, so public routes
 * (signup, login, providers) work without tokens. Protected routes (me, logout,
 * password) must manually resolve the user from the Authorization header.
 */
import { createRoute, z } from "@hono/zod-openapi";
import type { Env } from "../env";
import type { CurrentUser, TokenClaims } from "../auth/types";
import { createToken, verifyToken } from "../auth/jwt";
import { hashPassword, verifyPassword } from "../auth/password";
import { verifyCfAccessToken, cfAccessEnabled, deriveDisplayName } from "../auth/cf-access";
import { withAdminDb, type AdminSql } from "../db/client";
import { sendPasswordResetEmail, sendVerificationEmail, sendWelcomeEmail } from "../lib/email";
import { buildPersonalAgentPrompt } from "../prompts/personal-agent";
import { logSecurityEvent } from "../logic/security-events";
import { createOpenAPIRouter } from "../lib/openapi";
import { failSafe } from "../lib/error-response";
import { ErrorSchema, RateLimitErrorSchema, AuthTokenResponse, UserProfile, TokenVerifyResponse, errorResponses } from "../schemas/openapi";

export const authRoutes = createOpenAPIRouter();

/** Fire-and-forget audit log for auth events */
async function auditAuthEvent(
  sql: AdminSql,
  action: string,
  userId: string,
  orgId: string,
  details?: Record<string, unknown>,
): Promise<void> {
  try {
    await sql`
      INSERT INTO audit_log (org_id, actor_id, action, resource_type, resource_name, details, created_at)
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
  referral_code: z.string().max(50).optional(),
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

const ForgotPasswordRequest = z.object({
  email: z.string().min(1).email(),
});

const ResetPasswordRequest = z.object({
  token: z.string().min(1),
  new_password: z.string().min(8).max(128),
});

const VerifyEmailRequest = z.object({
  token: z.string().min(1),
});

// ── Helpers ──────────────────────────────────────────────────────────────

function generateId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

function generateSecureToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function getClientIp(c: any): string {
  const cfIp = c.req.header("cf-connecting-ip");
  if (cfIp) return String(cfIp).trim();
  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded) return String(forwarded).split(",")[0].trim();
  return "unknown";
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
  let name = claims.name || "";

  try {
    await withAdminDb(c.env, async (sql) => {
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

      // Look up name from DB if not in claims
      if (!name) {
        const rows = await sql`SELECT name FROM users WHERE user_id = ${claims.sub}`;
        if (rows.length > 0) name = rows[0].name || "";
      }
    });
  } catch {
    // Best-effort DB lookup
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

const signupRoute = createRoute({
  method: "post",
  path: "/signup",
  tags: ["Auth"],
  summary: "Create a new account",
  description: "Register a new user with email and password. Creates a personal org automatically.",
  security: [],
  request: {
    body: { content: { "application/json": { schema: SignupRequest } } },
  },
  responses: {
    200: { description: "Account created", content: { "application/json": { schema: AuthTokenResponse } } },
    ...errorResponses(400, 429, 500),
    403: { description: "Password auth disabled", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Email already registered", content: { "application/json": { schema: ErrorSchema } } },
  },
});

authRoutes.openapi(signupRoute, async (c): Promise<any> => {
  if (passwordAuthDisabled(c.env)) {
    return c.json({ error: "Password authentication is disabled" }, 403);
  }
  const signupLimit = checkRateLimit(c, `signup:${getClientIp(c)}`, 5, 24 * 60 * 60 * 1000);
  if (signupLimit) return signupLimit as any;

  const { email, password, name, referral_code: referralCode } = c.req.valid("json") as { email: string; password: string; name: string; referral_code?: string };

  // ── Invite-only gate ──────────────────────────────────────
  const openSignups = c.env.OPEN_SIGNUPS === "true" || c.env.OPEN_SIGNUPS === "1";
  // Bootstrap: SEED_ADMIN_CODE env var allows the first signup without existing codes
  const seedCode = c.env.SEED_ADMIN_CODE;
  const isSeedSignup = seedCode && referralCode?.trim() === seedCode;
  if (!openSignups && !isSeedSignup && !referralCode?.trim()) {
    return c.json({
      error: "Invite required. You need a referral code from an existing user to create an account.",
      code: "invite_required",
    }, 403);
  }

  return await withAdminDb(c.env, async (sql) => {
    // Check if user already exists
    try {
      const existing = await sql`SELECT user_id FROM users WHERE email = ${email}`;
      if (existing.length > 0) {
        return c.json({ error: "Email already registered" }, 409);
      }
    } catch (err) {
      return c.json(failSafe(err, "auth/signup:user-lookup"), 500);
    }

  // Validate AND consume invite code atomically BEFORE creating user/org.
  // Uses atomic UPDATE ... WHERE to prevent race conditions on max_uses.
  let validatedReferrerOrgId: string | null = null;
  if (!openSignups && referralCode?.trim() && !isSeedSignup) {
    try {
      // Atomic: validate + increment uses in a single UPDATE
      const consumed = await sql`
        UPDATE referral_codes
        SET uses = uses + 1
        WHERE code = ${referralCode}
          AND is_active = true
          AND (max_uses IS NULL OR uses < max_uses)
        RETURNING org_id, user_id
      `;
      if (consumed.length === 0) {
        // Check why it failed — give specific error
        const [codeRow] = await sql`SELECT is_active, uses, max_uses FROM referral_codes WHERE code = ${referralCode}`;
        if (!codeRow) return c.json({ error: "Invalid invite code.", code: "invalid_invite" }, 403);
        if (!codeRow.is_active) return c.json({ error: "This invite code is no longer active.", code: "invite_inactive" }, 403);
        return c.json({ error: "This invite code has reached its limit.", code: "invite_exhausted" }, 403);
      }
      validatedReferrerOrgId = String(consumed[0].org_id);
    } catch (err: any) {
      // Table doesn't exist = migration not run. Block signup in invite-only mode.
      if (!openSignups) {
        return c.json({ error: "Invite system not configured. Contact support.", code: "system_error" }, 500);
      }
    }
  }

  const userId = generateId();
  let passwordHash: string;
  try {
    passwordHash = await hashPassword(password);
  } catch (err) {
    return c.json(failSafe(err, "auth/signup:hash-password"), 500);
  }
  const nowEpoch = new Date().toISOString();

  const orgId = generateId();
  const orgSlug = email.split("@")[0].toLowerCase().replace(/\./g, "-");
  const orgName = `${name || orgSlug}'s Org`;

  // NOTE: `sql` inside this withAdminDb callback is already a
  // transaction-scoped client — withAdminDb opens the transaction for
  // us. Calling sql.begin() here would nest and fail at runtime
  // (TransactionSql doesn't expose .begin). All the INSERTs below run
  // in the same enclosing transaction and roll back together on throw.
  try {
    // Create user
    await sql`
      INSERT INTO users (user_id, email, name, password_hash, provider, created_at)
      VALUES (${userId}, ${email}, ${name}, ${passwordHash}, ${"local"}, ${nowEpoch})
    `;

    // Create personal org
    await sql`
      INSERT INTO orgs (org_id, name, slug, owner_user_id, plan, created_at)
      VALUES (${orgId}, ${orgName}, ${orgSlug}, ${userId}, ${"free"}, ${nowEpoch})
    `;

    await sql`
      INSERT INTO org_members (org_id, user_id, role, created_at)
      VALUES (${orgId}, ${userId}, ${"owner"}, ${nowEpoch})
    `;

    // Auto-create personal agent (every user gets one on signup)
    const personalAgentId = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    const personalName = "my-assistant";
    const personalDescription = `${name || email.split("@")[0]}'s personal AI assistant`;
    const personalConfig = {
      name: personalName,
      description: personalDescription,
      system_prompt: buildPersonalAgentPrompt(name || email.split("@")[0]),
      model: "",  // Let plan routing handle model selection
      plan: "free",
      // Lean tool list: 8 core tools the PA uses on most turns.
      // The runtime's progressive tool discovery makes all 100+ tools
      // available on demand — they don't need to be in this list.
      tools: [
        "web-search", "browse",           // research (daily use)
        "python-exec", "bash",            // code execution
        "read-file", "write-file",        // workspace
        "memory-save", "memory-recall",   // persistence across sessions
        "create-schedule", "list-schedules", "delete-schedule", // automation
      ],
      max_turns: 50,
      temperature: 0.7,
      tags: ["personal", "assistant"],
      version: "1.0.0",
      governance: { budget_limit_usd: 10 },
      reasoning_strategy: "",  // auto-select is best for a generalist
      use_code_mode: true,     // Collapse tool schema for better latency and fewer direct tool calls.
      parallel_tool_calls: true,
      is_personal: true,
    };

    await sql`
      INSERT INTO agents (agent_id, name, org_id, description, config, version, is_active, created_by, created_at, updated_at)
      VALUES (${personalAgentId}, ${personalName}, ${orgId}, ${personalDescription}, ${JSON.stringify(personalConfig)}, '1.0.0', ${true}, ${userId}, now(), now())
    `;
    console.log(`[auth/signup] Personal agent created for ${email}`);

    // Meta-agent is ambient — no DB row needed. It uses its own system prompt
    // from prompts/meta-agent-chat.ts and operates on any agent via /agents/:name/meta-chat.

    // Create default org_settings
    await sql`
      INSERT INTO org_settings (org_id, plan_type, settings, limits, features, created_at, updated_at)
      VALUES (
        ${orgId},
        ${"free"},
        ${JSON.stringify({ onboarding_complete: false, default_connectors: [] })},
        ${JSON.stringify({ max_agents: 50, max_runs_per_month: 1000, max_seats: 1 })},
        ${JSON.stringify(["basic_agents", "basic_observability"])},
        now(),
        now()
      )
      ON CONFLICT (org_id) DO NOTHING
    `;

    // Seed free tier credits ($5.00 — enough for ~50-200 agent runs)
    const FREE_TIER_USD = 5.00;
    await sql`
      INSERT INTO org_credit_balance (org_id, balance_usd, lifetime_purchased_usd, updated_at)
      VALUES (${orgId}, ${FREE_TIER_USD}, ${FREE_TIER_USD}, now())
      ON CONFLICT (org_id) DO NOTHING
    `;
    await sql`
      INSERT INTO credit_transactions (org_id, type, amount_usd, balance_after_usd, description, reference_id, reference_type, created_at)
      VALUES (${orgId}, 'bonus', ${FREE_TIER_USD}, ${FREE_TIER_USD}, 'Welcome bonus — free tier credits', 'signup', 'signup_bonus', now())
    `;
    console.log(`[auth/signup] Seeded $${FREE_TIER_USD} free credits for org ${orgId}`);

    // Create referral relationship (code already validated + consumed above)
    if (validatedReferrerOrgId && validatedReferrerOrgId !== orgId) {
      await sql`
        INSERT INTO referrals (referrer_org_id, referred_org_id, referral_code, status, created_at)
        VALUES (${validatedReferrerOrgId}, ${orgId}, ${referralCode || ''}, 'active', now())
        ON CONFLICT (referred_org_id) DO NOTHING
      `;
    }

    // Auto-create default referral code for the new org (5 invites to start)
    try {
      const { createReferralCode } = await import("../logic/referrals");
      await createReferralCode(sql, orgId, { label: "Your invite link", maxUses: 5 });
    } catch {} // non-blocking within tx

    // Seed default event_types for the org (best-effort, idempotent)
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

    // Create default project for the new org
    const projectId = generateId();
    const projectSlug = email.split("@")[0].toLowerCase().replace(/\./g, "-").slice(0, 30) || "my-agents";

    await sql`
      INSERT INTO projects (project_id, org_id, name, slug, description, default_env, default_plan, created_at, updated_at)
      VALUES (${projectId}, ${orgId}, ${`${projectSlug}'s project`}, ${projectSlug}, ${"Default project"}, ${"development"}, ${"standard"}, ${nowEpoch}, ${nowEpoch})
    `;

    // Create default environments.
    // NOTE: environments.org_id is NOT NULL (required for the RLS
    // policy org_id = current_org_id()). Historical signups that
    // omitted org_id no longer work — include it here and in any
    // other code path that inserts into environments.
    for (const envName of ["development", "staging", "production"]) {
      const envId = generateId();
      await sql`
        INSERT INTO environments (env_id, org_id, project_id, name, is_active, created_at)
        VALUES (${envId}, ${orgId}, ${projectId}, ${envName}, ${true}, ${nowEpoch})
      `;
    }
  } catch (err) {
    return c.json(failSafe(err, "auth/signup:transaction", { userMessage: "We couldn't create your account right now. Please try again in a moment." }), 500);
  }

  const token = await createToken(c.env.AUTH_JWT_SECRET, userId, {
    email,
    name,
    org_id: orgId,
    provider: "local",
  });

  auditAuthEvent(sql, "auth.signup", userId, orgId, { email, provider: "local" });

  // Generate email verification token (best-effort, outside transaction)
  try {
    const verifyToken = generateSecureToken();
    const verifyExpires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await sql`
      INSERT INTO email_verification_tokens (token, user_id, expires_at, created_at)
      VALUES (${verifyToken}, ${userId}, ${verifyExpires}, now())
    `;
    // Send verification + welcome emails (fire-and-forget)
    sendVerificationEmail(email, verifyToken).catch(() => {});
    sendWelcomeEmail(email, name || email.split("@")[0]).catch(() => {});
    console.log(`[auth/signup] Verification email sent to ${email}`);
  } catch (err) {
    console.warn("[auth/signup] Email verification token failed:", err);
  }

  return c.json({
    token,
    user_id: userId,
    email,
    org_id: orgId,
    provider: "local",
    email_verified: false,
  });
  });
});

// ── POST /login ──────────────────────────────────────────────────────────

const loginRoute = createRoute({
  method: "post",
  path: "/login",
  tags: ["Auth"],
  summary: "Log in with email and password",
  security: [],
  request: {
    body: { content: { "application/json": { schema: LoginRequest } } },
  },
  responses: {
    200: { description: "Login successful", content: { "application/json": { schema: AuthTokenResponse } } },
    ...errorResponses(400, 401, 429, 500),
    403: { description: "Password auth disabled", content: { "application/json": { schema: ErrorSchema } } },
  },
});

authRoutes.openapi(loginRoute, async (c): Promise<any> => {
  if (passwordAuthDisabled(c.env)) {
    return c.json({ error: "Password authentication is disabled" }, 403);
  }
  const loginLimit = checkRateLimit(c, `login:${getClientIp(c)}`, 10, 60 * 60 * 1000);
  if (loginLimit) return loginLimit as any;

  const { email, password } = c.req.valid("json");

  return await withAdminDb(c.env, async (sql) => {
  let rows: Array<{ user_id: string; email: string; name: string; password_hash: string }>;
  try {
    rows = await sql`
      SELECT user_id, email, name, password_hash FROM users WHERE email = ${email}
    `;
  } catch (err) {
    return c.json(failSafe(err, "auth/login:user-lookup"), 500);
  }
  if (rows.length === 0) {
    // Security event: login failed — unknown email
    logSecurityEvent(sql, {
      org_id: "",
      event_type: "login.failed",
      actor_id: email,
      actor_type: "user",
      ip_address: getClientIp(c),
      severity: "medium",
      details: { reason: "unknown_email", email },
    });
    return c.json({ error: "Invalid credentials" }, 401);
  }

  const user = rows[0];
  if (!user.password_hash) {
    logSecurityEvent(sql, {
      org_id: "",
      event_type: "login.failed",
      actor_id: email,
      actor_type: "user",
      ip_address: getClientIp(c),
      severity: "medium",
      details: { reason: "no_password_hash", email },
    });
    return c.json({ error: "Invalid credentials" }, 401);
  }

  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) {
    auditAuthEvent(sql, "auth.login_failed", user.user_id, "", { email, reason: "invalid_password" });
    logSecurityEvent(sql, {
      org_id: "",
      event_type: "login.failed",
      actor_id: email,
      actor_type: "user",
      ip_address: getClientIp(c),
      severity: "medium",
      details: { reason: "wrong_password", email },
    });
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

  // Security event: login success
  logSecurityEvent(sql, {
    org_id: String(orgId),
    event_type: "login.success",
    actor_id: user.user_id,
    actor_type: "user",
    ip_address: getClientIp(c),
    severity: "info",
    details: { email: user.email, provider: "local" },
  });

  return c.json({
    token,
    user_id: user.user_id,
    email: user.email,
    org_id: orgId,
    provider: "local",
  });
  });
});

// ── GET /providers ───────────────────────────────────────────────────────

const providersRoute = createRoute({
  method: "get",
  path: "/providers",
  tags: ["Auth"],
  summary: "List available auth providers",
  security: [],
  responses: {
    200: {
      description: "Auth provider configuration",
      content: {
        "application/json": {
          schema: z.object({
            active_provider: z.string(),
            cf_access_enabled: z.boolean(),
            cf_access_team_domain: z.string().optional(),
            password_enabled: z.boolean(),
          }),
        },
      },
    },
  },
});

authRoutes.openapi(providersRoute, (c) => {
  const cfAccessIsEnabled = cfAccessEnabled(c.env.CF_ACCESS_TEAM_DOMAIN);
  return c.json({
    active_provider: cfAccessIsEnabled ? "cf_access" : "local",
    cf_access_enabled: cfAccessIsEnabled,
    cf_access_team_domain: cfAccessIsEnabled ? c.env.CF_ACCESS_TEAM_DOMAIN : undefined,
    password_enabled: !passwordAuthDisabled(c.env),
  });
});

// ── POST /cf-access/exchange ─────────────────────────────────────────────

const cfAccessExchangeRoute = createRoute({
  method: "post",
  path: "/cf-access/exchange",
  tags: ["Auth"],
  summary: "Exchange CF Access token for JWT",
  description: "Exchange a Cloudflare Access token for a OneShots JWT. Auto-provisions users on first login.",
  security: [],
  request: {
    body: { content: { "application/json": { schema: CfAccessExchangeRequest } } },
  },
  responses: {
    200: {
      description: "Token exchange successful",
      content: {
        "application/json": {
          schema: AuthTokenResponse.extend({ name: z.string().optional() }),
        },
      },
    },
    ...errorResponses(400, 401, 500),
  },
});

authRoutes.openapi(cfAccessExchangeRoute, async (c): Promise<any> => {
  if (!cfAccessEnabled(c.env.CF_ACCESS_TEAM_DOMAIN)) {
    return c.json({ error: "Cloudflare Access auth is not enabled" }, 400);
  }

  const { cf_access_token } = c.req.valid("json");

  const cfClaims = await verifyCfAccessToken(cf_access_token, c.env.CF_ACCESS_TEAM_DOMAIN!, {
    aud: c.env.CF_ACCESS_AUD,
  });

  if (!cfClaims || !cfClaims.sub || !cfClaims.email) {
    return c.json({ error: "Invalid CF Access token" }, 401);
  }

  return await withAdminDb(c.env, async (sql) => {
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
        INSERT INTO org_settings (org_id, plan_type, settings, limits, features, created_at, updated_at)
        VALUES (
          ${orgId},
          ${"free"},
          ${JSON.stringify({ onboarding_complete: false, default_connectors: [] })},
          ${JSON.stringify({ max_agents: 50, max_runs_per_month: 1000, max_seats: 1 })},
          ${JSON.stringify(["basic_agents", "basic_observability"])},
          ${nowEpoch},
          ${nowEpoch}
        )
      `;
    } catch {}

    // Auto-create personal agent (same as email signup)
    try {
      const personalAgentId = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
      const personalName = "my-assistant";
      const displayName = userName || cfClaims.email.split("@")[0];
      const personalDescription = `${displayName}'s personal AI assistant`;
      const personalConfig = {
        name: personalName,
        description: personalDescription,
        system_prompt: buildPersonalAgentPrompt(displayName),
        model: "",
        plan: "free",
        tools: [
          "web-search", "browse",
          "python-exec", "bash",
          "read-file", "write-file",
          "memory-save", "memory-recall",
          "create-schedule", "list-schedules", "delete-schedule",
        ],
        max_turns: 50,
        temperature: 0.7,
        tags: ["personal", "assistant"],
        version: "1.0.0",
        governance: { budget_limit_usd: 10 },
        reasoning_strategy: "",
        use_code_mode: true,
        parallel_tool_calls: true,
        is_personal: true,
      };
      await sql`
        INSERT INTO agents (agent_id, name, org_id, description, config, version, is_active, created_by, created_at, updated_at)
        VALUES (${personalAgentId}, ${personalName}, ${orgId}, ${personalDescription}, ${JSON.stringify(personalConfig)}, '1.0.0', ${true}, ${userId}, ${nowEpoch}, ${nowEpoch})
      `;
      console.log(`[auth/cf-access] Personal agent created for ${cfClaims.email}`);
    } catch (e: any) { console.warn(`[auth/cf-access] Personal agent creation failed: ${e.message}`); }

    // Meta-agent is ambient — no DB row needed.

    // Seed free tier credits
    const FREE_TIER_USD = 5.00;
    try {
      await sql`
        INSERT INTO org_credit_balance (org_id, balance_usd, lifetime_purchased_usd, updated_at)
        VALUES (${orgId}, ${FREE_TIER_USD}, ${FREE_TIER_USD}, ${nowEpoch})
        ON CONFLICT (org_id) DO NOTHING
      `;
      await sql`
        INSERT INTO credit_transactions (org_id, type, amount_usd, balance_after_usd, description, reference_id, reference_type, created_at)
        VALUES (${orgId}, 'bonus', ${FREE_TIER_USD}, ${FREE_TIER_USD}, 'Welcome bonus — free tier credits', 'signup', 'signup_bonus', ${nowEpoch})
      `;
      console.log(`[auth/cf-access] Seeded $${FREE_TIER_USD} free credits for ${cfClaims.email}`);
    } catch (e: any) { console.warn(`[auth/cf-access] Credit seeding failed: ${e.message}`); }

    // Auto-create default referral code (5 invites)
    try {
      const { createReferralCode } = await import("../logic/referrals");
      await createReferralCode(sql, orgId, { label: "Your invite link", maxUses: 5 });
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

  auditAuthEvent(sql, "auth.cf_access_exchange", userId, orgId, { email: cfClaims.email, provider: "cf_access" });

  return c.json({
    token,
    user_id: userId,
    email: cfClaims.email,
    org_id: orgId,
    provider: "cf_access",
    name: userName,
  });
  });
});

// ── POST /token/verify ───────────────────────────────────────────────────

const tokenVerifyRoute = createRoute({
  method: "post",
  path: "/token/verify",
  tags: ["Auth"],
  summary: "Verify a JWT token",
  security: [],
  request: {
    body: { content: { "application/json": { schema: TokenVerifyRequest } } },
  },
  responses: {
    200: { description: "Token is valid", content: { "application/json": { schema: TokenVerifyResponse } } },
    401: { description: "Token is invalid", content: { "application/json": { schema: z.object({ valid: z.literal(false) }) } } },
    ...errorResponses(400),
  },
});

authRoutes.openapi(tokenVerifyRoute, async (c): Promise<any> => {
  const { token } = c.req.valid("json");

  let claims = await verifyToken(c.env.AUTH_JWT_SECRET, token);

  // Fallback to CF Access
  if (!claims && cfAccessEnabled(c.env.CF_ACCESS_TEAM_DOMAIN)) {
    claims = await verifyCfAccessToken(token, c.env.CF_ACCESS_TEAM_DOMAIN!, {
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

const meRoute = createRoute({
  method: "get",
  path: "/me",
  tags: ["Auth"],
  summary: "Get current user profile",
  responses: {
    200: { description: "Current user", content: { "application/json": { schema: UserProfile } } },
    ...errorResponses(401),
  },
});

authRoutes.openapi(meRoute, async (c): Promise<any> => {
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

const logoutRoute = createRoute({
  method: "post",
  path: "/logout",
  tags: ["Auth"],
  summary: "Log out (invalidate client token)",
  responses: {
    200: { description: "Logged out", content: { "application/json": { schema: z.object({ logged_out: z.boolean() }) } } },
    ...errorResponses(401),
  },
});

authRoutes.openapi(logoutRoute, async (c): Promise<any> => {
  const user = await resolveUser(c);
  if (!requireUser(user, c)) {
    return c.json({ error: "Missing or invalid Authorization header" }, 401);
  }

  // Stateless JWT — client discards the token. Server acknowledges.
  await withAdminDb(c.env, async (sql) => {
    await auditAuthEvent(sql, "auth.logout", user.user_id, user.org_id ?? "", { email: user.email });
  });

  return c.json({ logged_out: true });
});

// ── POST /password (protected) ──────────────────────────────────────────

const changePasswordRoute = createRoute({
  method: "post",
  path: "/password",
  tags: ["Auth"],
  summary: "Change password",
  request: {
    body: { content: { "application/json": { schema: ChangePasswordRequest } } },
  },
  responses: {
    200: { description: "Password updated", content: { "application/json": { schema: z.object({ updated: z.boolean() }) } } },
    ...errorResponses(400, 401, 500),
    403: { description: "Password auth disabled", content: { "application/json": { schema: ErrorSchema } } },
  },
});

authRoutes.openapi(changePasswordRoute, async (c): Promise<any> => {
  if (passwordAuthDisabled(c.env)) {
    return c.json({ error: "Password authentication is disabled" }, 403);
  }
  const user = await resolveUser(c);
  if (!requireUser(user, c)) {
    return c.json({ error: "Missing or invalid Authorization header" }, 401);
  }

  const { current_password, new_password } = c.req.valid("json");

  return await withAdminDb(c.env, async (sql) => {
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

  auditAuthEvent(sql, "auth.password_change", user.user_id, user.org_id ?? "", { email: user.email });

  return c.json({ updated: true });
  });
});

// ── POST /forgot-password ─────────────────────────────────────────────

authRoutes.post("/forgot-password", async (c) => {
  if (passwordAuthDisabled(c.env)) {
    return c.json({ error: "Password authentication is disabled" }, 403);
  }
  const limit = checkRateLimit(c, `forgot:${getClientIp(c)}`, 3, 60 * 60 * 1000);
  if (limit) return limit;

  const body = await c.req.json().catch(() => ({}));
  const parsed = ForgotPasswordRequest.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Valid email is required" }, 400);
  }
  const { email } = parsed.data;

  return await withAdminDb(c.env, async (sql) => {
    // Always return success to prevent email enumeration
    const successResponse = { message: "If that email exists, a reset link has been sent." };

    const rows = await sql`SELECT user_id FROM users WHERE email = ${email} AND password_hash IS NOT NULL`;
    if (rows.length === 0) {
      return c.json(successResponse);
    }

    const userId = rows[0].user_id;
    const token = generateSecureToken();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour

    // Invalidate any existing reset tokens for this user
    await sql`DELETE FROM password_reset_tokens WHERE user_id = ${userId}`;

    await sql`
      INSERT INTO password_reset_tokens (token, user_id, expires_at, created_at)
      VALUES (${token}, ${userId}, ${expiresAt}, now())
    `;

    auditAuthEvent(sql, "auth.forgot_password", userId, "", { email });

    // Send reset email (fire-and-forget)
    sendPasswordResetEmail(email, token).catch(() => {});
    console.log(`[auth] Password reset email sent to ${email}`);

    return c.json(successResponse);
  });
});

// ── POST /reset-password ──────────────────────────────────────────────

authRoutes.post("/reset-password", async (c) => {
  if (passwordAuthDisabled(c.env)) {
    return c.json({ error: "Password authentication is disabled" }, 403);
  }
  const limit = checkRateLimit(c, `reset:${getClientIp(c)}`, 5, 60 * 60 * 1000);
  if (limit) return limit;

  const body = await c.req.json().catch(() => ({}));
  const parsed = ResetPasswordRequest.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation failed", detail: parsed.error.issues[0]?.message }, 400);
  }
  const { token, new_password } = parsed.data;

  return await withAdminDb(c.env, async (sql) => {
    const rows = await sql`
      SELECT user_id, expires_at FROM password_reset_tokens
      WHERE token = ${token} LIMIT 1
    `;

    if (rows.length === 0) {
      return c.json({ error: "Invalid or expired reset token" }, 400);
    }

    const { user_id, expires_at } = rows[0];
    if (new Date(expires_at).getTime() < Date.now()) {
      await sql`DELETE FROM password_reset_tokens WHERE token = ${token}`;
      return c.json({ error: "Reset token has expired" }, 400);
    }

    const newHash = await hashPassword(new_password);
    const now = new Date().toISOString();

    await sql`UPDATE users SET password_hash = ${newHash}, updated_at = ${now} WHERE user_id = ${user_id}`;
    await sql`DELETE FROM password_reset_tokens WHERE user_id = ${user_id}`;

    auditAuthEvent(sql, "auth.password_reset", String(user_id), "", { method: "token" });

    return c.json({ updated: true });
  });
});

// ── POST /verify-email ────────────────────────────────────────────────

authRoutes.post("/verify-email", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = VerifyEmailRequest.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "token is required" }, 400);
  }

  return await withAdminDb(c.env, async (sql) => {
    const rows = await sql`
      SELECT user_id, expires_at FROM email_verification_tokens
      WHERE token = ${parsed.data.token} LIMIT 1
    `;

    if (rows.length === 0) {
      return c.json({ error: "Invalid or expired verification token" }, 400);
    }

    const { user_id, expires_at } = rows[0];
    if (new Date(expires_at).getTime() < Date.now()) {
      await sql`DELETE FROM email_verification_tokens WHERE token = ${parsed.data.token}`;
      return c.json({ error: "Verification token has expired" }, 400);
    }

    await sql`UPDATE users SET email_verified = true, updated_at = now() WHERE user_id = ${user_id}`;
    await sql`DELETE FROM email_verification_tokens WHERE user_id = ${user_id}`;

    auditAuthEvent(sql, "auth.email_verified", String(user_id), "", {});

    return c.json({ verified: true });
  });
});

// ── POST /resend-verification ─────────────────────────────────────────

authRoutes.post("/resend-verification", async (c) => {
  const limit = checkRateLimit(c, `verify:${getClientIp(c)}`, 3, 60 * 60 * 1000);
  if (limit) return limit;

  const user = await resolveUser(c);
  if (!requireUser(user, c)) {
    return c.json({ error: "Missing or invalid Authorization header" }, 401);
  }

  return await withAdminDb(c.env, async (sql) => {
    const rows = await sql`SELECT email_verified FROM users WHERE user_id = ${user.user_id}`;
    if (rows.length > 0 && rows[0].email_verified) {
      return c.json({ message: "Email already verified" });
    }

    const token = generateSecureToken();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 24 hours

    await sql`DELETE FROM email_verification_tokens WHERE user_id = ${user.user_id}`;
    await sql`
      INSERT INTO email_verification_tokens (token, user_id, expires_at, created_at)
      VALUES (${token}, ${user.user_id}, ${expiresAt}, now())
    `;

    // Send verification email (fire-and-forget)
    sendVerificationEmail(user.email, token).catch(() => {});
    console.log(`[auth] Verification email sent to ${user.email}`);

    return c.json({ message: "Verification email sent" });
  });
});

// ── GET /cli — CLI login redirect page ────────────────────────────────────

const cliLoginRoute = createRoute({
  method: "get",
  path: "/cli",
  tags: ["Auth"],
  summary: "CLI login — show login form or redirect if already authenticated",
  security: [],
  request: {
    query: z.object({
      port: z.string().min(1),
      state: z.string().min(1),
    }),
  },
  responses: {
    200: { description: "Login form HTML" },
    302: { description: "Redirect to CLI callback (already authenticated)" },
    ...errorResponses(400),
  },
});

authRoutes.openapi(cliLoginRoute, async (c): Promise<any> => {
  const { port, state } = c.req.valid("query");

  // Check if user already has a valid session (Authorization header or cookie)
  const existingUser = await resolveUser(c);
  if (existingUser && existingUser.user_id) {
    // Issue a fresh JWT and redirect straight to CLI callback
    const token = await createToken(c.env.AUTH_JWT_SECRET, existingUser.user_id, {
      email: existingUser.email,
      name: existingUser.name,
      org_id: existingUser.org_id,
      provider: existingUser.auth_method,
      expiry_seconds: 24 * 60 * 60,
    });
    return c.redirect(
      `http://localhost:${encodeURIComponent(port)}/callback?token=${encodeURIComponent(token)}&state=${encodeURIComponent(state)}`,
    );
  }

  // Render login form
  const html = `<!DOCTYPE html>
<html>
<head><title>OneShots CLI Login</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 400px; margin: 80px auto; padding: 20px;">
  <h2>Sign in to OneShots CLI</h2>
  <form method="POST" action="/api/v1/auth/cli/callback">
    <input type="hidden" name="port" value="${port.replace(/"/g, "&quot;")}">
    <input type="hidden" name="state" value="${state.replace(/"/g, "&quot;")}">
    <label>Email<br><input type="email" name="email" required style="width:100%;padding:8px;margin:4px 0 12px;border:1px solid #ddd;border-radius:6px;box-sizing:border-box;"></label>
    <label>Password<br><input type="password" name="password" required style="width:100%;padding:8px;margin:4px 0 12px;border:1px solid #ddd;border-radius:6px;box-sizing:border-box;"></label>
    <button type="submit" style="width:100%;padding:10px;background:#6366f1;color:white;border:none;border-radius:6px;cursor:pointer;font-size:14px;">Sign in</button>
  </form>
</body>
</html>`;

  return c.html(html);
});

// ── POST /cli/callback — Process login form and redirect to CLI ──────────

const cliCallbackRoute = createRoute({
  method: "post",
  path: "/cli/callback",
  tags: ["Auth"],
  summary: "CLI login callback — validate credentials and redirect to local CLI server",
  security: [],
  request: {
    body: {
      content: {
        "application/x-www-form-urlencoded": {
          schema: z.object({
            email: z.string().min(1),
            password: z.string().min(1),
            port: z.string().min(1),
            state: z.string().min(1),
          }),
        },
      },
    },
  },
  responses: {
    302: { description: "Redirect to CLI callback on success" },
    200: { description: "Re-rendered login form with error" },
    ...errorResponses(400, 429),
  },
});

authRoutes.openapi(cliCallbackRoute, async (c): Promise<any> => {
  const { email, password, port, state } = c.req.valid("form");

  const loginLimit = checkRateLimit(c, `cli-login:${getClientIp(c)}`, 10, 60 * 60 * 1000);
  if (loginLimit) return loginLimit as any;

  return await withAdminDb(c.env, async (sql) => {
  // Validate credentials (same logic as POST /login)
  const rows = await sql`
    SELECT user_id, email, name, password_hash FROM users WHERE email = ${email}
  `;

  let errorMsg = "";

  if (rows.length === 0) {
    errorMsg = "Invalid email or password.";
  } else {
    const user = rows[0];
    if (!user.password_hash) {
      errorMsg = "Invalid email or password.";
    } else {
      const valid = await verifyPassword(password, user.password_hash);
      if (!valid) {
        errorMsg = "Invalid email or password.";
      }
    }
  }

  if (errorMsg) {
    // Re-render form with error
    const html = `<!DOCTYPE html>
<html>
<head><title>OneShots CLI Login</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 400px; margin: 80px auto; padding: 20px;">
  <h2>Sign in to OneShots CLI</h2>
  <div style="background: #fef2f2; color: #dc2626; border: 1px solid #fecaca; border-radius: 6px; padding: 10px; margin-bottom: 16px; font-size: 14px;">${errorMsg}</div>
  <form method="POST" action="/api/v1/auth/cli/callback">
    <input type="hidden" name="port" value="${port.replace(/"/g, "&quot;")}">
    <input type="hidden" name="state" value="${state.replace(/"/g, "&quot;")}">
    <label>Email<br><input type="email" name="email" required value="${email.replace(/"/g, "&quot;")}" style="width:100%;padding:8px;margin:4px 0 12px;border:1px solid #ddd;border-radius:6px;box-sizing:border-box;"></label>
    <label>Password<br><input type="password" name="password" required style="width:100%;padding:8px;margin:4px 0 12px;border:1px solid #ddd;border-radius:6px;box-sizing:border-box;"></label>
    <button type="submit" style="width:100%;padding:10px;background:#6366f1;color:white;border:none;border-radius:6px;cursor:pointer;font-size:14px;">Sign in</button>
  </form>
</body>
</html>`;
    return c.html(html);
  }

  // Credentials valid — issue JWT and redirect to CLI
  const user = rows[0];
  const orgRows = await sql`
    SELECT org_id FROM org_members WHERE user_id = ${user.user_id} LIMIT 1
  `;
  const orgId = orgRows.length > 0 ? orgRows[0].org_id : "";

  const token = await createToken(c.env.AUTH_JWT_SECRET, user.user_id, {
    email: user.email,
    name: user.name || "",
    org_id: orgId,
    provider: "local",
    expiry_seconds: 24 * 60 * 60,
  });

  auditAuthEvent(sql, "auth.cli_login", user.user_id, String(orgId), { email: user.email, provider: "local" });

  logSecurityEvent(sql, {
    org_id: String(orgId),
    event_type: "login.success",
    actor_id: user.user_id,
    actor_type: "user",
    ip_address: getClientIp(c),
    severity: "info",
    details: { email: user.email, provider: "local", method: "cli" },
  });

  return c.redirect(
    `http://localhost:${encodeURIComponent(port)}/callback?token=${encodeURIComponent(token)}&state=${encodeURIComponent(state)}`,
  );
  });
});
