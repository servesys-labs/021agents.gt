/**
 * Session management routes — active sessions, revocation, timeout settings.
 * Mounted at /api/v1/session-management.
 */
import { Hono } from "hono";
import type { Env } from "../env";
import type { CurrentUser } from "../auth/types";
import { hasRole } from "../auth/types";
import { getDb } from "../db/client";
import { logSecurityEvent } from "../auth/security-events";
import { invalidateMfaCache } from "../middleware/mfa-enforcement";

type R = { Bindings: Env; Variables: { user: CurrentUser } };
export const sessionMgmtRoutes = new Hono<R>();

// ── GET /active — List active sessions for the current user ──────────

sessionMgmtRoutes.get("/active", async (c) => {
  const user = c.get("user");
  if (!user.user_id) return c.json({ error: "Unauthorized" }, 401);

  const sql = await getDb(c.env.HYPERDRIVE);
  const rows = await sql`
    SELECT
      session_id,
      ip_address,
      user_agent,
      created_at,
      last_activity_at,
      is_active
    FROM user_sessions
    WHERE user_id = ${user.user_id} AND is_active = true
    ORDER BY last_activity_at DESC
    LIMIT 50
  `;

  return c.json({ sessions: rows });
});

// ── DELETE /:session_id — Revoke a specific session ──────────────────

sessionMgmtRoutes.delete("/:session_id", async (c) => {
  const user = c.get("user");
  if (!user.user_id) return c.json({ error: "Unauthorized" }, 401);

  const sessionId = c.req.param("session_id");
  const sql = await getDb(c.env.HYPERDRIVE);

  const result = await sql`
    UPDATE user_sessions
    SET is_active = false, revoked_at = NOW()
    WHERE session_id = ${sessionId} AND user_id = ${user.user_id}
    RETURNING session_id
  `;

  if (result.length === 0) {
    return c.json({ error: "Session not found" }, 404);
  }

  logSecurityEvent(sql, {
    event_type: "session.revoked",
    user_id: user.user_id,
    org_id: user.org_id,
    metadata: { revoked_session_id: sessionId },
  });

  return c.json({ ok: true, revoked: sessionId });
});

// ── POST /revoke-all — Revoke all sessions except current ────────────

sessionMgmtRoutes.post("/revoke-all", async (c) => {
  const user = c.get("user");
  if (!user.user_id) return c.json({ error: "Unauthorized" }, 401);

  // The current session token is in the Authorization header; we identify
  // the current session by the most-recently-active one and keep it alive.
  // Alternatively, the client can pass { keep_session_id } in the body.
  let keepSessionId: string | undefined;
  try {
    const body = await c.req.json<{ keep_session_id?: string }>();
    keepSessionId = body.keep_session_id;
  } catch {
    // No body — revoke all (including current)
  }

  const sql = await getDb(c.env.HYPERDRIVE);

  let result;
  if (keepSessionId) {
    result = await sql`
      UPDATE user_sessions
      SET is_active = false, revoked_at = NOW()
      WHERE user_id = ${user.user_id} AND is_active = true AND session_id != ${keepSessionId}
    `;
  } else {
    result = await sql`
      UPDATE user_sessions
      SET is_active = false, revoked_at = NOW()
      WHERE user_id = ${user.user_id} AND is_active = true
    `;
  }

  logSecurityEvent(sql, {
    event_type: "session.revoked_all",
    user_id: user.user_id,
    org_id: user.org_id,
    metadata: { keep_session_id: keepSessionId ?? null },
  });

  return c.json({ ok: true, revoked_count: result.count ?? 0 });
});

// ── GET /settings — Get session timeout settings for the org ─────────

sessionMgmtRoutes.get("/settings", async (c) => {
  const user = c.get("user");
  if (!user.org_id) return c.json({ error: "No org context" }, 400);

  const sql = await getDb(c.env.HYPERDRIVE);
  const rows = await sql`
    SELECT
      idle_timeout_minutes,
      max_session_hours,
      mfa_enforcement
    FROM org_settings
    WHERE org_id = ${user.org_id}
    LIMIT 1
  `;

  if (rows.length === 0) {
    // Return defaults
    return c.json({
      idle_timeout_minutes: 30,
      max_session_hours: 24,
      mfa_enforcement: "optional",
    });
  }

  return c.json({
    idle_timeout_minutes: rows[0].idle_timeout_minutes ?? 30,
    max_session_hours: rows[0].max_session_hours ?? 24,
    mfa_enforcement: rows[0].mfa_enforcement ?? "optional",
  });
});

// ── PUT /settings — Update session timeout settings (admin only) ─────

sessionMgmtRoutes.put("/settings", async (c) => {
  const user = c.get("user");
  if (!user.org_id) return c.json({ error: "No org context" }, 400);

  if (!hasRole(user, "admin")) {
    return c.json({ error: "Admin role required to update session settings" }, 403);
  }

  const body = await c.req.json<{
    idle_timeout_minutes?: number;
    max_session_hours?: number;
    mfa_enforcement?: string;
  }>();

  // Validate inputs
  const idleTimeout = body.idle_timeout_minutes;
  const maxSession = body.max_session_hours;
  const mfaEnforcement = body.mfa_enforcement;

  if (idleTimeout !== undefined && (typeof idleTimeout !== "number" || idleTimeout < 5 || idleTimeout > 1440)) {
    return c.json({ error: "idle_timeout_minutes must be between 5 and 1440" }, 400);
  }
  if (maxSession !== undefined && (typeof maxSession !== "number" || maxSession < 1 || maxSession > 168)) {
    return c.json({ error: "max_session_hours must be between 1 and 168" }, 400);
  }
  const validMfaPolicies = ["optional", "required_all", "required_admins"];
  if (mfaEnforcement !== undefined && !validMfaPolicies.includes(mfaEnforcement)) {
    return c.json({ error: `mfa_enforcement must be one of: ${validMfaPolicies.join(", ")}` }, 400);
  }

  const sql = await getDb(c.env.HYPERDRIVE);

  // Upsert org_settings
  await sql`
    INSERT INTO org_settings (org_id, idle_timeout_minutes, max_session_hours, mfa_enforcement, updated_at)
    VALUES (
      ${user.org_id},
      ${idleTimeout ?? 30},
      ${maxSession ?? 24},
      ${mfaEnforcement ?? "optional"},
      NOW()
    )
    ON CONFLICT (org_id) DO UPDATE SET
      idle_timeout_minutes = COALESCE(${idleTimeout ?? null}, org_settings.idle_timeout_minutes),
      max_session_hours = COALESCE(${maxSession ?? null}, org_settings.max_session_hours),
      mfa_enforcement = COALESCE(${mfaEnforcement ?? null}, org_settings.mfa_enforcement),
      updated_at = NOW()
  `;

  // Invalidate MFA cache for this org so new policy takes effect immediately
  if (mfaEnforcement !== undefined) {
    invalidateMfaCache(user.org_id);
  }

  return c.json({
    ok: true,
    idle_timeout_minutes: idleTimeout ?? 30,
    max_session_hours: maxSession ?? 24,
    mfa_enforcement: mfaEnforcement ?? "optional",
  });
});
