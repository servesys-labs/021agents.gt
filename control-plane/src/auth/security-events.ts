/**
 * Security event logger — fire-and-forget INSERTs to security_events table.
 * Used by auth middleware, MFA enforcement, and session management.
 */
import type { Sql } from "../db/client";
import type { SecurityEventType } from "../telemetry/events";

export { type SecurityEventType };

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
 *
 * Schema columns: id (BIGSERIAL), org_id, event_type, actor_type, actor_id,
 * severity, details (JSONB), ip_address, created_at.
 */
export function logSecurityEvent(sql: Sql, event: SecurityEvent): void {
  const details = event.metadata ? JSON.stringify(event.metadata) : "{}";
  sql`
    INSERT INTO security_events (org_id, event_type, actor_type, actor_id, severity, details, ip_address, created_at)
    VALUES (
      ${event.org_id ?? ""},
      ${event.event_type},
      ${"user"},
      ${event.user_id},
      ${"info"},
      ${details},
      ${event.ip_address ?? null},
      NOW()
    )
  `.catch(() => {
    // Fire-and-forget — never block the auth flow
  });
}
