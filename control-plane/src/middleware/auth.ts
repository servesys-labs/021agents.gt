/**
 * Hono auth middleware — resolves JWT or API key to CurrentUser.
 *
 * This file is the orchestrator. The actual work lives in ./auth/:
 *   - cache.ts             — bounded in-memory cache + KV cross-isolate invalidation
 *   - public-routes.ts     — routes that skip auth entirely
 *   - session-timeout.ts   — portal-user idle + absolute-age checks
 *   - resolve-jwt.ts       — JWT (local) resolver
 *   - resolve-api-key.ts   — ak_* API key resolver
 *   - resolve-end-user.ts  — end-user JWT resolver (issued by parent API key)
 *
 * Public surface (kept stable for all route importers):
 *   - authMiddleware
 *   - requireScope
 *   - requireRole
 *   - invalidateAuthCache (re-exported from ./auth/cache)
 */
import { createMiddleware } from "hono/factory";
import type { Env } from "../env";
import type { CurrentUser } from "../auth/types";
import { hasScope, hasRole } from "../auth/types";
import { withAdminDb } from "../db/client";
import { logSecurityEvent } from "../auth/security-events";
import { checkCacheVersion, invalidateAuthCache } from "./auth/cache";
import { isPublicRequest } from "./auth/public-routes";
import { resolveJwt } from "./auth/resolve-jwt";
import { resolveApiKey } from "./auth/resolve-api-key";

export { invalidateAuthCache };

/**
 * Auth middleware — sets c.var.user to CurrentUser.
 * Returns 401 if no valid auth on protected routes.
 */
export const authMiddleware = createMiddleware<{
  Bindings: Env;
  Variables: { user: CurrentUser };
}>(async (c, next) => {
  // Service-to-service auth via SERVICE_TOKEN (runtime tools calling control-plane)
  const isServiceAuth = (() => {
    const serviceToken = c.env.SERVICE_TOKEN || "";
    if (!serviceToken) return false;
    const authHeader = c.req.header("Authorization") || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    return token === serviceToken;
  })();

  if (isPublicRequest(c.req.path, c.req.method) || isServiceAuth) {
    // Service token gets an owner-like synthetic user with optional org scoping
    // via X-Org-Id header. Public routes get a viewer with no org.
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

  // Cross-isolate cache invalidation check
  await checkCacheVersion(c.env);

  const authHeader = c.req.header("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return c.json({ error: "Missing Authorization header" }, 401);
  }

  const token = authHeader.slice(7);

  try {
    const user = token.startsWith("ak_")
      ? await resolveApiKey(token, c.env)
      : await resolveJwt(token, c.env);

    c.set("user", user);
    return next();
  } catch (e: any) {
    const status = e.status ?? 401;
    const code = e.code ?? undefined;

    // Fire-and-forget: log failed auth attempt. No org context exists
    // yet (that's why auth failed) — use withAdminDb so the audit row
    // is recorded regardless of which tenant the caller was targeting.
    try {
      await withAdminDb(c.env, async (sql) => {
        logSecurityEvent(sql, {
          event_type: code === "session_expired" ? "session.expired" : "login.failed",
          user_id: "",
          ip_address: c.req.header("CF-Connecting-IP") ?? c.req.header("X-Forwarded-For") ?? "",
          user_agent: c.req.header("User-Agent") ?? "",
          metadata: { error: e.message, path: c.req.path },
        });
      });
    } catch {}

    const body: Record<string, unknown> = { error: e.message ?? "Unauthorized" };
    if (code) body.code = code;
    return c.json(body, status);
  }
});

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
