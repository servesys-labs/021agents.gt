/**
 * Canonical event registry for the control-plane package.
 *
 * Three event tables, three typed unions. Emit sites use `satisfies`
 * so a typo is caught at compile time.
 *
 * To add a new event: add it to the appropriate union, then emit it.
 */

// ── audit_log.action ────────────────────────────────────────────────────

export type AuditAction =
  // Auth
  | "auth.signup"
  | "auth.login"
  | "auth.login_failed"
  | "auth.logout"
  | "auth.cf_access_exchange"
  | "auth.cli_login"
  | "auth.email_verified"
  | "auth.forgot_password"
  | "auth.password_change"
  | "auth.password_reset"
  // Agents
  | "config_change"
  | "delete"
  | "update_config"
  // Releases / canary
  | "agent.promote_override"
  | "agent.promoted"
  | "agent.canary_rollback"
  | "agent.canary_auto_promoted"
  | "agent.canary_auto_rollback"
  | "agent.explicit_auto_rollback"
  | "canary.auto_promote"
  | "canary.auto_rollback"
  // Connectors
  | "connector.token_stored"
  | "connector.tool_call"
  // Projects / policies
  | "project.create"
  | "policy.create"
  // Retention
  | "retention.applied"
  // Training
  | "training.created"
  | "training.completed"
  | "training.cancelled"
  | "training.step"
  | "resource.activated"
  | "resource.rolled_back"
  // Meta-agent
  | "set_feature_flag"
  // Compliance
  | "account.deletion_completed"
  | "account.deletion_failed"
  | "data_export.completed"
  // API keys (audit_log)
  | "apikey.create"
  // Observability
  | "trace.integrity_breach"
  // Runtime queue consumer → audit_log (cross-package writes)
  | "loop_detected"
  | "skill_activation"
  | "skill_auto_activation";

// ── security_events.event_type ──────────────────────────────────────────

export type SecurityEventType =
  // Auth
  | "login.success"
  | "login.failed"
  | "login.mfa_verified"
  // Sessions
  | "session.expired"
  | "session.revoked"
  | "session.revoked_all"
  // API keys
  | "api_key.created"
  | "api_key.revoked"
  | "api_key.rotated"
  // Org management
  | "user.invited"
  | "user.role_changed"
  | "user.removed"
  // Guardrails (also written to guardrail_events)
  | "guardrail.blocked"
  | "guardrail.triggered"
  // Retention
  | "policy.audit_archived"
  // Secrets
  | "secrets.rotated"
  // Compliance (via local logSecurityEvent in compliance.ts)
  | "account.deletion_completed"
  | "account.deletion_failed";

// ── guardrail_events.event_type ─────────────────────────────────────────
// The guardrail_events table stores scan direction in event_type; the
// "guardrail.blocked" / "guardrail.triggered" names live in security_events.

export type GuardrailEventType =
  | "input"
  | "output";

// ── Seed catalog (event_types table) ────────────────────────────────────

export type SeedEventType =
  | "agent.created"
  | "agent.updated"
  | "agent.deleted"
  | "session.started"
  | "session.completed"
  | "session.failed"
  | "connector.token_stored"
  | "connector.tool_call"
  | "retention.applied"
  | "config.update"
  | "member.invited"
  | "member.removed";

// ── Webhook delivery event types ────────────────────────────────────────

export type WebhookEventType =
  | "agent.run.completed";

// ── Chat platform events ────────────────────────────────────────────────

export type ChatPlatformEventType =
  | "direct_message";
