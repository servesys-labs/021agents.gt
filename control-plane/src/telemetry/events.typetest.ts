/**
 * Compile-time regression guard for control-plane event types.
 *
 * This file is checked by `tsc --noEmit` but never runs at runtime.
 * If an event type is added/removed from the registries without updating
 * this file, compilation will fail.
 */
import type { AuditAction, SecurityEventType, GuardrailEventType } from "./events";

function guardA(_e: AuditAction): void {}
function guardS(_e: SecurityEventType): void {}
function guardG(_e: GuardrailEventType): void {}

// ── AuditAction exhaustiveness ──────────────────────────────────
guardA("auth.signup");
guardA("auth.login");
guardA("auth.login_failed");
guardA("auth.logout");

guardA("auth.cli_login");
guardA("auth.email_verified");
guardA("auth.forgot_password");
guardA("auth.password_change");
guardA("auth.password_reset");
guardA("config_change");
guardA("delete");
guardA("update_config");
guardA("agent.promote_override");
guardA("agent.promoted");
guardA("agent.canary_rollback");
guardA("agent.canary_auto_promoted");
guardA("agent.canary_auto_rollback");
guardA("agent.explicit_auto_rollback");
guardA("canary.auto_promote");
guardA("canary.auto_rollback");
guardA("connector.token_stored");
guardA("connector.tool_call");
guardA("project.create");
guardA("policy.create");
guardA("retention.applied");
guardA("training.created");
guardA("training.completed");
guardA("training.cancelled");
guardA("training.step");
guardA("resource.activated");
guardA("resource.rolled_back");
guardA("set_feature_flag");
guardA("account.deletion_completed");
guardA("account.deletion_failed");
guardA("data_export.completed");
guardA("apikey.create");
guardA("trace.integrity_breach");
guardA("loop_detected");
guardA("skill_activation");
guardA("skill_auto_activation");

type AuditCovered =
  | "auth.signup" | "auth.login" | "auth.login_failed" | "auth.logout"
  | "auth.cli_login" | "auth.email_verified"
  | "auth.forgot_password" | "auth.password_change" | "auth.password_reset"
  | "config_change" | "delete" | "update_config"
  | "agent.promote_override" | "agent.promoted" | "agent.canary_rollback"
  | "agent.canary_auto_promoted" | "agent.canary_auto_rollback"
  | "agent.explicit_auto_rollback"
  | "canary.auto_promote" | "canary.auto_rollback"
  | "connector.token_stored" | "connector.tool_call"
  | "project.create" | "policy.create"
  | "retention.applied"
  | "training.created" | "training.completed" | "training.cancelled" | "training.step"
  | "resource.activated" | "resource.rolled_back"
  | "set_feature_flag"
  | "account.deletion_completed" | "account.deletion_failed" | "data_export.completed"
  | "apikey.create"
  | "trace.integrity_breach"
  | "loop_detected"
  | "skill_activation"
  | "skill_auto_activation";

type _AuditExhaustive = AuditAction extends AuditCovered ? true : never;
const _a1: _AuditExhaustive = true;
type _AuditNoExtras = AuditCovered extends AuditAction ? true : never;
const _a2: _AuditNoExtras = true;

// ── SecurityEventType exhaustiveness ────────────────────────────
guardS("login.success");
guardS("login.failed");
guardS("login.mfa_verified");
guardS("session.expired");
guardS("session.revoked");
guardS("session.revoked_all");
guardS("api_key.created");
guardS("api_key.revoked");
guardS("api_key.rotated");
guardS("user.invited");
guardS("user.role_changed");
guardS("user.removed");
guardS("guardrail.blocked");
guardS("guardrail.triggered");
guardS("policy.audit_archived");
guardS("secrets.rotated");
guardS("account.deletion_completed");
guardS("account.deletion_failed");

type SecurityCovered =
  | "login.success" | "login.failed" | "login.mfa_verified"
  | "session.expired" | "session.revoked" | "session.revoked_all"
  | "api_key.created" | "api_key.revoked" | "api_key.rotated"
  | "user.invited" | "user.role_changed" | "user.removed"
  | "guardrail.blocked" | "guardrail.triggered"
  | "policy.audit_archived"
  | "secrets.rotated"
  | "account.deletion_completed" | "account.deletion_failed";

type _SecExhaustive = SecurityEventType extends SecurityCovered ? true : never;
const _s1: _SecExhaustive = true;
type _SecNoExtras = SecurityCovered extends SecurityEventType ? true : never;
const _s2: _SecNoExtras = true;

// ── GuardrailEventType exhaustiveness ───────────────────────────
guardG("input");
guardG("output");

type GuardrailCovered = "input" | "output";
type _GExhaustive = GuardrailEventType extends GuardrailCovered ? true : never;
const _g1: _GExhaustive = true;
type _GNoExtras = GuardrailCovered extends GuardrailEventType ? true : never;
const _g2: _GNoExtras = true;
