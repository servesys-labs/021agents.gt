/**
 * MFA enforcement middleware — checks org-level MFA policy against CF Access amr claim.
 *
 * Runs after auth middleware. Reads org_settings.mfa_enforcement to decide
 * whether the current user must have passed MFA via Cloudflare Zero Trust.
 */
import { createMiddleware } from "hono/factory";
import type { Env } from "../env";
import type { CurrentUser } from "../auth/types";
import { withOrgDb } from "../db/client";
import { logSecurityEvent } from "../auth/security-events";

// ── In-memory cache for org MFA settings (5 min TTL) ──────────────────
const MFA_CACHE_TTL = 300_000; // 5 min
const mfaSettingsCache = new Map<string, { ts: number; policy: MfaPolicy }>();

type MfaPolicy = "optional" | "required_all" | "required_admins";

function getCachedMfaPolicy(orgId: string): MfaPolicy | null {
  const entry = mfaSettingsCache.get(orgId);
  if (!entry) return null;
  if (Date.now() - entry.ts > MFA_CACHE_TTL) {
    mfaSettingsCache.delete(orgId);
    return null;
  }
  return entry.policy;
}

function setCachedMfaPolicy(orgId: string, policy: MfaPolicy): void {
  mfaSettingsCache.set(orgId, { ts: Date.now(), policy });
  // Bound cache size
  if (mfaSettingsCache.size > 1024) {
    const entries = [...mfaSettingsCache.entries()].sort((a, b) => a[1].ts - b[1].ts);
    const toRemove = Math.floor(entries.length / 4);
    for (let i = 0; i < toRemove; i++) mfaSettingsCache.delete(entries[i][0]);
  }
}

/** Roles that count as "admin" for required_admins policy. */
const ADMIN_ROLES = new Set(["admin", "owner"]);

/**
 * Extract amr (Authentication Methods References) from the original CF Access JWT.
 * The auth middleware stores the decoded claims; we check for "mfa" in amr array.
 */
function hasMfaInAmr(c: any): boolean {
  // CF Access sets the amr claim in the JWT. The auth middleware may forward
  // this via a custom header or we can re-decode the token's payload.
  const cfJwt = c.req.header("Cf-Access-Jwt-Assertion") ?? "";
  if (!cfJwt) return false;

  try {
    const parts = cfJwt.split(".");
    if (parts.length !== 3) return false;
    // Decode payload (base64url)
    let padded = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const pad = 4 - (padded.length % 4);
    if (pad !== 4) padded += "=".repeat(pad);
    const payload = JSON.parse(atob(padded));
    const amr = payload.amr;
    return Array.isArray(amr) && amr.includes("mfa");
  } catch {
    return false;
  }
}

/**
 * MFA enforcement middleware.
 * Must be applied after authMiddleware so c.get("user") is available.
 */
export const mfaEnforcementMiddleware = createMiddleware<{
  Bindings: Env;
  Variables: { user: CurrentUser };
}>(async (c, next) => {
  const user = c.get("user");

  // Only enforce MFA for JWT-authenticated portal users with an org
  if (!user.user_id || !user.org_id || user.auth_method !== "jwt") {
    return next();
  }

  // Look up org MFA policy (cached)
  let policy = getCachedMfaPolicy(user.org_id);
  if (policy === null) {
    try {
      policy = await withOrgDb(c.env, user.org_id, async (sql) => {
        // RLS on org_settings filters to current org — no WHERE needed.
        const rows = await sql`
          SELECT mfa_enforcement FROM org_settings LIMIT 1
        `;
        const p = (rows.length > 0 ? rows[0].mfa_enforcement : "optional") as MfaPolicy;
        return ["optional", "required_all", "required_admins"].includes(p) ? p : "optional";
      });
    } catch {
      // DB unavailable — default to optional
      policy = "optional";
    }
    setCachedMfaPolicy(user.org_id, policy);
  }

  // If optional, skip
  if (policy === "optional") return next();

  // Determine if this user needs MFA
  const needsMfa =
    policy === "required_all" ||
    (policy === "required_admins" && ADMIN_ROLES.has(user.role));

  if (!needsMfa) return next();

  // Check if MFA was performed via CF Access amr claim
  const mfaVerified = hasMfaInAmr(c);

  if (!mfaVerified) {
    const teamDomain = c.env.CF_ACCESS_TEAM_DOMAIN ?? "access.cloudflare.com";
    return c.json(
      {
        error: "MFA verification required",
        code: "mfa_required",
        cf_access_url: `https://${teamDomain}/`,
      },
      403,
    );
  }

  // MFA verified — fire-and-forget: update org_members + log event.
  // org_members is NOT org-scoped via RLS (see audit Option A) so keep
  // the explicit WHERE; security_events IS org-scoped so RLS handles it.
  try {
    await withOrgDb(c.env, user.org_id, async (sql) => {
      sql`
        UPDATE org_members
        SET mfa_verified = true, mfa_verified_at = NOW()
        WHERE org_id = ${user.org_id} AND user_id = ${user.user_id}
      `.catch(() => {});

      logSecurityEvent(sql, {
        event_type: "login.mfa_verified",
        user_id: user.user_id,
        org_id: user.org_id,
        ip_address: c.req.header("CF-Connecting-IP") ?? "",
      });
    });
  } catch {
    // Best-effort
  }

  return next();
});

/**
 * Invalidate the MFA settings cache for an org (call after settings update).
 */
export function invalidateMfaCache(orgId: string): void {
  mfaSettingsCache.delete(orgId);
}
