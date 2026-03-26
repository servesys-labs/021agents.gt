/**
 * Auth routes — signup, login, providers, me, logout, password change, clerk exchange.
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
import { verifyClerkToken, clerkEnabled } from "../auth/clerk";
import { getDb } from "../db/client";

type R = { Bindings: Env; Variables: { user: CurrentUser } };
export const authRoutes = new Hono<R>();

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

const ClerkExchangeRequest = z.object({
  clerk_token: z.string().min(1),
});

const TokenVerifyRequest = z.object({
  token: z.string().min(1),
});

// ── Helpers ──────────────────────────────────────────────────────────────

function generateId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
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

  // Fallback to Clerk
  if (!claims && clerkEnabled(c.env.CLERK_ISSUER)) {
    claims = await verifyClerkToken(token, c.env.CLERK_ISSUER!, {
      audience: c.env.CLERK_AUDIENCE,
      jwksUrl: c.env.CLERK_JWKS_URL,
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
  const nowEpoch = Date.now() / 1000;

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
  const clerkIsEnabled = clerkEnabled(c.env.CLERK_ISSUER);
  return c.json({
    active_provider: clerkIsEnabled ? "clerk" : "local",
    clerk_enabled: clerkIsEnabled,
    password_enabled: !passwordAuthDisabled(c.env),
  });
});

// ── POST /clerk/exchange ─────────────────────────────────────────────────

authRoutes.post("/clerk/exchange", async (c) => {
  if (!clerkEnabled(c.env.CLERK_ISSUER)) {
    return c.json({ error: "Clerk auth is not enabled" }, 400);
  }

  const body = await c.req.json().catch(() => ({}));
  const parsed = ClerkExchangeRequest.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "clerk_token is required" }, 400);
  }

  const clerkClaims = await verifyClerkToken(parsed.data.clerk_token, c.env.CLERK_ISSUER!, {
    audience: c.env.CLERK_AUDIENCE,
    jwksUrl: c.env.CLERK_JWKS_URL,
  });

  if (!clerkClaims || !clerkClaims.sub || !clerkClaims.email) {
    return c.json({ error: "Invalid Clerk token" }, 401);
  }

  const sql = await getDb(c.env.HYPERDRIVE);
  const nowEpoch = Date.now() / 1000;

  // Provision user from Clerk identity (upsert pattern)
  // C1: prefix user_id with "clerk:" to match Python provisioning
  const clerkUserId = `clerk:${clerkClaims.sub}`;
  let userId: string;
  let orgId: string = "";
  let role: string = "member";
  let userName = clerkClaims.name || "";

  // Check if user exists by clerk-prefixed ID first, then by email
  const existingById = await sql`SELECT user_id, email, name FROM users WHERE user_id = ${clerkUserId}`;
  const existingByEmail = existingById.length > 0
    ? []
    : await sql`SELECT user_id, email, name FROM users WHERE email = ${clerkClaims.email}`;

  if (existingById.length > 0) {
    userId = existingById[0].user_id;
    userName = userName || existingById[0].name || "";

    // Update name if provided
    if (userName) {
      await sql`UPDATE users SET name = ${userName} WHERE user_id = ${userId}`;
    }
  } else if (existingByEmail.length > 0) {
    userId = existingByEmail[0].user_id;
    userName = userName || existingByEmail[0].name || "";

    // Update name if provided
    if (userName) {
      await sql`UPDATE users SET name = ${userName} WHERE user_id = ${userId}`;
    }
  } else {
    // Create new user with clerk-prefixed ID
    userId = clerkUserId;
    await sql`
      INSERT INTO users (user_id, email, name, password_hash, provider, created_at)
      VALUES (${userId}, ${clerkClaims.email}, ${userName}, ${""}, ${"clerk"}, ${nowEpoch})
    `;
  }

  // C2: Handle Clerk org_id — shared org provisioning
  // Map Clerk role to internal role (matching Python's map_clerk_role)
  const clerkOrgRole = clerkClaims.role || "";
  const roleMap: Record<string, string> = {
    "org:owner": "owner", "owner": "owner",
    "org:admin": "admin", "admin": "admin",
    "org:member": "member", "basic_member": "member", "member": "member",
    "org:viewer": "viewer", "viewer": "viewer", "read_only": "viewer",
  };
  const mappedRole = (clerkOrgRole ? roleMap[clerkOrgRole.toLowerCase()] : undefined) || "member";

  const clerkOrgId = clerkClaims.org_id || "";

  if (clerkOrgId) {
    // Shared org: ensure org exists, then upsert membership
    const orgSlug = `clerk-${clerkOrgId}`.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "") || "org";
    const existingOrg = await sql`SELECT org_id FROM orgs WHERE slug = ${orgSlug}`;

    if (existingOrg.length > 0) {
      orgId = existingOrg[0].org_id;
    } else {
      orgId = generateId();
      const orgName = `Clerk Org ${clerkOrgId}`;
      await sql`
        INSERT INTO orgs (org_id, name, slug, owner_user_id, plan, created_at)
        VALUES (${orgId}, ${orgName}, ${orgSlug}, ${userId}, ${"free"}, ${nowEpoch})
      `;
    }

    // Upsert membership
    const existingMember = await sql`
      SELECT role FROM org_members WHERE org_id = ${orgId} AND user_id = ${userId}
    `;
    if (existingMember.length === 0) {
      await sql`
        INSERT INTO org_members (org_id, user_id, role, created_at)
        VALUES (${orgId}, ${userId}, ${mappedRole}, ${nowEpoch})
      `;
    } else if (existingMember[0].role !== mappedRole) {
      await sql`
        UPDATE org_members SET role = ${mappedRole} WHERE org_id = ${orgId} AND user_id = ${userId}
      `;
    }
    role = mappedRole;
  } else {
    // Personal org: check if user already has one, otherwise create
    const orgRows = await sql`
      SELECT org_id, role FROM org_members WHERE user_id = ${userId} ORDER BY created_at ASC LIMIT 1
    `;
    if (orgRows.length > 0) {
      orgId = orgRows[0].org_id;
      role = orgRows[0].role;
    } else {
      orgId = generateId();
      const orgSlug = clerkClaims.email.split("@")[0].toLowerCase().replace(/\./g, "-");
      await sql`
        INSERT INTO orgs (org_id, name, slug, owner_user_id, plan, created_at)
        VALUES (${orgId}, ${`${userName || orgSlug}'s Org`}, ${orgSlug}, ${userId}, ${"free"}, ${nowEpoch})
      `;
      await sql`
        INSERT INTO org_members (org_id, user_id, role, created_at)
        VALUES (${orgId}, ${userId}, ${"owner"}, ${nowEpoch})
      `;
      role = "owner";
    }
    // If mapped role differs from default, upsert
    if (mappedRole !== "member") {
      const existingMember = await sql`
        SELECT role FROM org_members WHERE org_id = ${orgId} AND user_id = ${userId}
      `;
      if (existingMember.length > 0 && existingMember[0].role !== mappedRole) {
        await sql`
          UPDATE org_members SET role = ${mappedRole} WHERE org_id = ${orgId} AND user_id = ${userId}
        `;
      }
      role = mappedRole;
    }
  }

  const token = await createToken(c.env.AUTH_JWT_SECRET, userId, {
    email: clerkClaims.email,
    name: userName,
    org_id: orgId,
    provider: "clerk",
    extra: { role },
  });

  return c.json({
    token,
    user_id: userId,
    email: clerkClaims.email,
    org_id: orgId,
    provider: "clerk",
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

  // Fallback to Clerk
  if (!claims && clerkEnabled(c.env.CLERK_ISSUER)) {
    claims = await verifyClerkToken(parsed.data.token, c.env.CLERK_ISSUER!, {
      audience: c.env.CLERK_AUDIENCE,
      jwksUrl: c.env.CLERK_JWKS_URL,
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
  const nowEpoch = Date.now() / 1000;

  await sql`
    UPDATE users SET password_hash = ${newHash}, updated_at = ${nowEpoch}
    WHERE user_id = ${user.user_id}
  `;

  return c.json({ updated: true });
});
