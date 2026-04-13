/**
 * Canonical event registry for the runtime (deploy/) package.
 *
 * Every telemetry event the runtime can emit is listed here as a typed
 * string union. Emit sites use `satisfies RuntimeEventType` so a typo
 * is caught at compile time.
 *
 * To add a new event: add it to the union, then emit it — tsc enforces
 * that only registered events are used.
 */

export type RuntimeEventType =
  // ── Workflow observability (→ otel_events) ────────────────────
  | "turn_phase"
  | "run_phase_state"
  | "query_profile"
  | "completion_contract"
  | "completion_gate"
  | "implementation_complexity"
  | "research_artifact"
  // ── LLM (→ runtime_events) ───────────────────────────────────
  | "llm_fallback"
  | "llm_fallback_alert"
  // ── Tools (→ runtime_events) ─────────────────────────────────
  | "tool_exec"
  | "sandbox_start"
  | "sandbox.error"
  // ── Memory (→ runtime_events) ────────────────────────────────
  | "memory_read"
  | "memory_hit"
  | "memory_miss"
  | "memory_write"
  | "memory_write_rejected"
  | "memory_digest_fired"
  | "memory_digest_skipped"
  | "memory_agent_variant_assigned"
  | "memory_shadow_delta"
  // ── Signal substrate (→ runtime_events) ────────────────────────
  | "signal_buffered"
  | "signal_threshold_hit"
  | "signal_cooldown_suppressed"
  | "signal_workflow_fired"
  | "signal_envelope_dropped"
  // ── Approval protocol (→ runtime_events) ─────────────────────
  | "permission_requested"
  | "permission_granted"
  | "permission_denied"
  | "permission_timeout"
  | "plan_approved"
  | "plan_rejected"
  // ── Infra (→ runtime_events) ─────────────────────────────────
  | "config.update"
  | "kv_poll_loop"
  | "email.processed"
  | "rag_eval"
  | "do_eviction";
