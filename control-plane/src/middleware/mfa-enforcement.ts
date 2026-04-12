/**
 * MFA enforcement middleware — checks org-level MFA policy.
 *
 * Runs after auth middleware. Reads org_settings.mfa_enforcement to decide
 * whether the current user must have passed MFA.
 */
import { createMiddleware } from "hono/factory";
import type { Env } from "../env";
import type { CurrentUser } from "../auth/types";
import { withOrgDb } from "../db/client";


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

  // MFA enforcement requires an external MFA provider integration.
  // Currently no MFA provider is configured — always deny when MFA is required.
  return c.json(
    {
      error: "MFA verification required but no MFA provider is configured",
      code: "mfa_required",
    },
    403,
  );
});

/**
 * Invalidate the MFA settings cache for an org (call after settings update).
 */
export function invalidateMfaCache(orgId: string): void {
  mfaSettingsCache.delete(orgId);
}
