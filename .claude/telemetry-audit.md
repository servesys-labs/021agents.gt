# AgentOS Telemetry Audit — April 2, 2026

## Status: Audit complete. P0 items need implementation.

## P0 — Need for Launch (6 items)

### 1. skill_auto_activation messages silently dropped
- **File:** `deploy/src/index.ts` queue consumer (~line 6568)
- **Issue:** Workflow sends `type: "skill_auto_activation"` but queue consumer has no handler — messages acked without persistence
- **Fix:** Add `else if (type === "skill_auto_activation")` handler identical to `skill_activation`, write to `audit_log`

### 2. do_eviction events are console.log only
- **File:** `deploy/src/index.ts` queue consumer (~line 6580)
- **Issue:** `do_eviction` messages only console.log, not written to any table
- **Fix:** Write to `runtime_events` table with event_type='do_eviction'

### 3. Per-tool latency not tracked
- **File:** `deploy/src/runtime/tools.ts` (~line 947, after dispatch)
- **Issue:** `latencyMs` is computed but never emitted as telemetry
- **Fix:** Send queue message `type: "event"` with event_type="tool_exec", tool_name, latency_ms, status

### 4. Container cold start vs warm not tracked
- **File:** `deploy/src/runtime/tools.ts` in `getSafeSandbox` and browser pool
- **Issue:** No data on cold start frequency or warm hit rate
- **Fix:** Emit `type: "event"` with event_type="sandbox_start", details={cold: bool, latency_ms}

### 5. KV poll loop not instrumented
- **File:** `deploy/src/index.ts` WebSocket poll loop (~line 1300)
- **Issue:** No data on poll count, KV failures, degraded state
- **Fix:** After poll loop exits, emit event with poll_count, kv_failures, total_duration_ms

### 6. DO billing records have input_tokens=0
- **File:** `deploy/src/index.ts` lines 1357 and 1797
- **Issue:** Hardcoded `input_tokens: 0, output_tokens: 0` — cost analysis impossible
- **Fix:** Pass actual token counts from Workflow result

## P1 — Need Within 2 Weeks (6 items)

### 7. WebSocket connection lifecycle
- **Where:** onConnect/onClose in index.ts
- **What:** Track duration_ms, close_code, close_reason, messages_sent/received

### 8. DO onStart duration
- **Where:** onStart() in index.ts
- **What:** Record start time, emit do_hydration event with duration_ms, hydration_source

### 9. Context utilization %
- **Where:** workflow.ts turn recording
- **What:** Add context_tokens_used and context_window_size to turn record

### 10. Tool success/failure aggregates
- **Where:** workflow.ts before write-telemetry
- **What:** Compute per-tool success/failure counts, add tool_stats_json to session record

### 11. Hyperdrive query latency
- **Where:** deploy/src/runtime/db.ts
- **What:** Wrap critical queries with timing, structured console output

### 12. Workflow step-level timing
- **Where:** workflow.ts around each step.do()
- **What:** Record step name, duration_ms, retry_count as runtime_event

## What We Currently Collect (Reference)

### Session record (via TELEMETRY_QUEUE → sessions table):
session_id, org_id, project_id, agent_name, model, status, input_text (2K), output_text (2K),
step_count, action_count, wall_clock_seconds, cost_total_usd, detailed_cost_json,
total_cache_read/write_tokens, feature_flags_json, repair_count, compaction_count, trace_id

### Turn record (via TELEMETRY_QUEUE → turns table):
session_id, turn_number, model_used, input/output_tokens, latency_ms, llm_latency_ms,
llm_content (5K), cost_total_usd, tool_calls_json, tool_results_json, errors_json,
execution_mode, plan_json, reflection_json, stop_reason, refusal, cache_read/write_tokens, gateway_log_id

### Queue message types handled:
session, turn, episode, event, cost_ledger, runtime_event, middleware_event,
billing_flush, skill_activation, loop_detected, do_eviction (log only)

### NOT handled: skill_auto_activation (dropped silently)
