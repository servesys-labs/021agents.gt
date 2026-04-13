/**
 * Compile-time regression guard for RuntimeEventType.
 *
 * This file is checked by `tsc --noEmit` but never runs at runtime.
 * If a new event is emitted without adding it to the registry,
 * or an existing event is removed, this file will fail to compile.
 *
 * To add a new event:
 *   1. Add it to RuntimeEventType in events.ts
 *   2. Add a guard line below
 */
import type { RuntimeEventType } from "./events";

// Helper: asserts that a string literal is a valid RuntimeEventType
function guard(_e: RuntimeEventType): void {}

// ── Every registered event must appear here ─────────────────────
// Workflow observability
guard("turn_phase");
guard("run_phase_state");
guard("query_profile");
guard("completion_contract");
guard("completion_gate");
guard("implementation_complexity");
guard("research_artifact");

// LLM
guard("llm_fallback");
guard("llm_fallback_alert");

// Tools
guard("tool_exec");
guard("sandbox_start");
guard("sandbox.error");

// Memory
guard("memory_read");
guard("memory_hit");
guard("memory_miss");
guard("memory_write");
guard("memory_write_rejected");
guard("memory_digest_fired");
guard("memory_digest_skipped");
guard("memory_agent_variant_assigned");
guard("memory_shadow_delta");
guard("signal_buffered");
guard("signal_threshold_hit");
guard("signal_cooldown_suppressed");
guard("signal_workflow_fired");
guard("signal_envelope_dropped");

// Approval protocol
guard("permission_requested");
guard("permission_granted");
guard("permission_denied");
guard("permission_timeout");
guard("plan_approved");
guard("plan_rejected");

// Infra
guard("config.update");
guard("kv_poll_loop");
guard("email.processed");
guard("rag_eval");
guard("do_eviction");

// ── Exhaustiveness check ────────────────────────────────────────
// If a new event is added to RuntimeEventType but not listed above,
// this block will cause a compile error.
type Covered =
  | "turn_phase" | "run_phase_state" | "query_profile"
  | "completion_contract" | "completion_gate" | "implementation_complexity" | "research_artifact"
  | "llm_fallback" | "llm_fallback_alert"
  | "tool_exec" | "sandbox_start" | "sandbox.error"
  | "memory_read" | "memory_hit" | "memory_miss" | "memory_write"
  | "memory_write_rejected" | "memory_digest_fired"
  | "memory_digest_skipped" | "memory_agent_variant_assigned"
  | "memory_shadow_delta"
  | "signal_buffered" | "signal_threshold_hit" | "signal_cooldown_suppressed"
  | "signal_workflow_fired" | "signal_envelope_dropped"
  | "permission_requested" | "permission_granted" | "permission_denied"
  | "permission_timeout" | "plan_approved" | "plan_rejected"
  | "config.update" | "kv_poll_loop" | "email.processed" | "rag_eval"
  | "do_eviction";

// This line fails if RuntimeEventType has members not in Covered:
type _Exhaustive = RuntimeEventType extends Covered ? true : never;
const _check: _Exhaustive = true;

// This line fails if Covered has members not in RuntimeEventType:
type _NoExtras = Covered extends RuntimeEventType ? true : never;
const _check2: _NoExtras = true;
