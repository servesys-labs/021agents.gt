/**
 * Portal JWT resolver.
 *
 * Accepts either:
 *   - a locally-signed JWT (verified via AUTH_JWT_SECRET), or
 *   - a Cloudflare Access JWT (verified via the team domain's JWKS)
 *
 * On success, enriches with org membership from org_members and
 * enforces the session idle timeout for portal users.
 *
 * Runs BEFORE any user/org context exists — we're literally resolving
 * which org the caller belongs to. Uses withAdminDb for every query:
 * the whole point of this function is to produce the org_id that later
 * withOrgDb calls will pass in.
 */
import type { Env } from "../../env";
import type { CurrentUser } from "../../auth/types";
import { verifyToken } from "../../auth/jwt";
import { verifyCfAccessToken, cfAccessEnabled } from "../../auth/cf-access";
import { withAdminDb } from "../../db/client";
import { logSecurityEvent } from "../../auth/security-events";
import { cacheGet, cachePut, hashForCache } from "./cache";
import { checkSessionTimeout, touchSessionActivity } from "./session-timeout";
import { resolveEndUserToken } from "./resolve-end-user";

export async function resolveJwt(token: string, env: Env): Promise<CurrentUser> {
  const cacheKey = `jwt:${await hashForCache(token)}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  // Local JWT first, CF Access fallback
  let claims = await verifyToken(env.AUTH_JWT_SECRET, token);
  if (!claims && cfAccessEnabled(env.CF_ACCESS_TEAM_DOMAIN)) {
    claims = await verifyCfAccessToken(token, env.CF_ACCESS_TEAM_DOMAIN!, {
      aud: env.CF_ACCESS_AUD,
    });
  }

  if (!claims) {
    throw Object.assign(new Error("Invalid or expired token"), { status: 401 });
  }

  // End-user tokens have their own resolver which also runs as admin.
  if (claims.type === "end_user") {
    const endUser = await resolveEndUserToken(claims, env);
    cachePut(cacheKey, endUser);
    return endUser;
  }

  // All remaining DB work — session timeout check, org membership lookup,
  // activity ping, audit log — runs inside a single admin transaction
  // because we don't have an org context yet.
  const user = await withAdminDb(env, async (sql) => {
    // ── Session timeout enforcement ──
    const sessionCheck = await checkSessionTimeout(claims!, sql);
    if (!sessionCheck.valid) {
      logSecurityEvent(sql, {
        event_type: "session.expired",
        user_id: claims!.sub,
        org_id: claims!.org_id || "",
        metadata: { reason: sessionCheck.reason },
      });
      throw Object.assign(
        new Error("Session expired"),
        { status: 401, code: "session_expired" },
      );
    }

    let orgId = claims!.org_id || "";
    let role = claims!.role || "member";

    // Look up org membership from DB if the claim lacks it
    try {
      if (!orgId) {
        const rows = await sql`
          SELECT org_id, role FROM org_members
          WHERE user_id = ${claims!.sub}
          ORDER BY created_at ASC LIMIT 1
        `;
        if (rows.length > 0) {
          orgId = rows[0].org_id;
          role = rows[0].role;
        }
      } else {
        const rows = await sql`
          SELECT role FROM org_members
          WHERE org_id = ${orgId} AND user_id = ${claims!.sub}
        `;
        if (rows.length > 0) role = rows[0].role;
      }
    } catch {
      // DB may be unavailable — best-effort
    }

    const u: CurrentUser = {
      user_id: claims!.sub,
      email: claims!.email,
      name: claims!.name,
      org_id: orgId,
      project_id: "",
      env: "",
      role,
      scopes: ["*"], // JWT users get full scopes
      auth_method: "jwt",
    };

    // Fire-and-forget activity ping + audit log
    touchSessionActivity(sql, claims!.sub);
    logSecurityEvent(sql, {
      event_type: "login.success",
      user_id: claims!.sub,
      org_id: orgId,
    });

    return u;
  });

  cachePut(cacheKey, user);
  return user;
}
