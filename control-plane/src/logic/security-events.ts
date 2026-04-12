/**
 * Security event logging utility — fire-and-forget INSERT into security_events.
 * Never throws. Used across routes for compliance-grade security audit trail.
 */
import type { Sql } from "../db/client";
import type { SecurityEventType } from "../telemetry/events";

export interface SecurityEvent {
  org_id: string;
  event_type: SecurityEventType;
  actor_id: string;
  actor_type?: "user" | "system" | "api_key" | "end_user";
  target_id?: string;
  target_type?: string;
  ip_address?: string;
  user_agent?: string;
  details?: Record<string, unknown>;
  severity?: "critical" | "high" | "medium" | "low" | "info";
}

/**
 * Log a security event. Fire-and-forget — never throws.
 * Inserts into the `security_events` table with sensible defaults.
 *
 * Schema columns: id (BIGSERIAL), org_id, event_type, actor_type, actor_id,
 * severity, details (JSONB), ip_address, created_at.
 */
export async function logSecurityEvent(
  sql: Sql,
  event: SecurityEvent,
): Promise<void> {
  try {
    // Pack extra fields (target_id, target_type, user_agent) into the details JSONB
    const details: Record<string, unknown> = { ...(event.details ?? {}) };
    if (event.target_id) details.target_id = event.target_id;
    if (event.target_type) details.target_type = event.target_type;
    if (event.user_agent) details.user_agent = event.user_agent;

    await sql`
      INSERT INTO security_events (
        org_id, event_type, actor_type, actor_id,
        severity, details, ip_address, created_at
      ) VALUES (
        ${event.org_id},
        ${event.event_type},
        ${event.actor_type ?? "user"},
        ${event.actor_id},
        ${event.severity ?? "info"},
        ${JSON.stringify(details)},
        ${event.ip_address ?? null},
        NOW()
      )
    `;
  } catch {
    // Fire-and-forget — never let security logging break the request
  }
}
