/**
 * Security event logger — fire-and-forget INSERTs to security_events table.
 * Used by auth middleware, MFA enforcement, and session management.
 */
import type { Sql } from "../db/client";

export type SecurityEventType =
  | "login.success"
  | "login.failed"
  | "login.mfa_verified"
  | "session.expired"
  | "session.revoked"
  | "session.revoked_all";

export interface SecurityEvent {
  event_type: SecurityEventType;
  user_id: string;
  org_id?: string;
  ip_address?: string;
  user_agent?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Log a security event to the security_events table.
 * Fire-and-forget — errors are silently caught to avoid blocking auth flow.
 */
export function logSecurityEvent(sql: Sql, event: SecurityEvent): void {
  const meta = event.metadata ? JSON.stringify(event.metadata) : null;
  sql`
    INSERT INTO security_events (event_type, user_id, org_id, ip_address, user_agent, metadata, created_at)
    VALUES (
      ${event.event_type},
      ${event.user_id},
      ${event.org_id ?? ""},
      ${event.ip_address ?? ""},
      ${event.user_agent ?? ""},
      ${meta},
      NOW()
    )
  `.catch(() => {
    // Fire-and-forget — never block the auth flow
  });
}
