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
 */
export async function logSecurityEvent(
  sql: Sql,
  event: SecurityEvent,
): Promise<void> {
  try {
    const id = crypto.randomUUID().replace(/-/g, "").slice(0, 24);
    const now = new Date().toISOString();

    await sql`
      INSERT INTO security_events (
        id, org_id, event_type, actor_id, actor_type,
        target_id, target_type, ip_address, user_agent,
        details, severity, created_at
      ) VALUES (
        ${id},
        ${event.org_id},
        ${event.event_type},
        ${event.actor_id},
        ${event.actor_type ?? "user"},
        ${event.target_id ?? null},
        ${event.target_type ?? null},
        ${event.ip_address ?? null},
        ${event.user_agent ?? null},
        ${JSON.stringify(event.details ?? {})},
        ${event.severity ?? "info"},
        ${now}
      )
    `;
  } catch {
    // Fire-and-forget — never let security logging break the request
  }
}
