/**
 * Session lifetime checks for portal JWT users.
 *
 * Two orthogonal rules:
 *   1. Absolute token age — JWTs older than MAX_TOKEN_AGE_SEC are rejected.
 *   2. Idle timeout — a portal user whose last activity is older than
 *      IDLE_TIMEOUT_SEC is rejected, based on user_sessions.last_activity_at.
 *
 * End-user tokens (type === "end_user") are exempt from the idle check.
 */
import type { TokenClaims } from "../../auth/types";

export const MAX_TOKEN_AGE_SEC = 86400; // 24 hours
export const IDLE_TIMEOUT_SEC = 1800;   // 30 minutes

export type SessionCheckResult =
  | { valid: true }
  | { valid: false; reason: string };

export async function checkSessionTimeout(
  claims: TokenClaims,
  sql: any,
): Promise<SessionCheckResult> {
  // Token age: max 24 hours
  if (claims.iat && (Date.now() / 1000 - claims.iat) > MAX_TOKEN_AGE_SEC) {
    return { valid: false, reason: "session_expired" };
  }

  // End-user tokens skip idle tracking
  if (claims.type === "end_user") return { valid: true };

  try {
    const rows = await sql`
      SELECT last_activity_at FROM user_sessions
      WHERE user_id = ${claims.sub} AND revoked = false
      ORDER BY last_activity_at DESC LIMIT 1
    `;
    if (rows.length > 0) {
      const lastActivity = new Date(rows[0].last_activity_at).getTime();
      if (Date.now() - lastActivity > IDLE_TIMEOUT_SEC * 1000) {
        return { valid: false, reason: "session_expired" };
      }
    }
    // No session row → skip idle check (tracking not yet initialized)
  } catch {
    // user_sessions table may not exist in all deployments — skip
  }

  return { valid: true };
}

/** Fire-and-forget activity ping. */
export function touchSessionActivity(sql: any, userId: string): void {
  sql`
    UPDATE user_sessions
    SET last_activity_at = NOW()
    WHERE user_id = ${userId} AND revoked = false
  `.catch(() => {});
}
