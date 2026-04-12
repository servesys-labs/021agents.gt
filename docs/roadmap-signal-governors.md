# Signal Governor Roadmap

**Status:** Memory governor live in production. Next governors sequenced below.
**Date:** 2026-04-12

---

## Architecture (already built)

```
Telemetry Queue
  -> fanOutSignals() derives SignalEnvelopes
  -> SIGNAL_QUEUE routes to SignalCoordinatorDO (scoped per org:agent:feature)
  -> DO clusters signals by signature, coalesces via 45s alarm
  -> evaluateNow() runs the feature's SignalRulePack
  -> Actions: fire workflow, emit telemetry, write analytics
  -> Cooldowns prevent re-firing (3-12 hours per action type)
```

Extension point: `getSignalRulePack(feature)` returns a rule pack per feature.
Each governor is a new rule pack + new signal derivation rules + new workflow actions.

---

## Phase 0: Harden memory governor (CURRENT)

Before adding new governors, prove one clean end-to-end cycle:

```
signal derived -> threshold hit -> workflow fired -> memory updated -> evidence retrievable
```

### Checklist

- [x] Signal derivation working (tool_failure, topic_recurrence, etc.)
- [x] Coordinator buffering + clustering working
- [x] Threshold evaluation firing workflows
- [x] Telemetry emitted (signal_buffered, signal_threshold_hit, signal_workflow_fired)
- [ ] Digest workflow actually updates memory (curated_memory / facts table)
- [ ] Consolidate workflow reconciles contradictions
- [ ] Memory-recall returns signal-triggered facts in future sessions
- [ ] Schema-sync test in CI
- [ ] Local PG integration test in deploy pipeline

---

## Phase 1: Tool Reliability Governor

**Why first:** `tool_failure` signals already derived. Clearest signal, most objective.

### Signals (already derived)

| Signal | Source | Severity |
|--------|--------|----------|
| `tool_failure` | runtime_event (tool_exec status=error) | 0.8-0.85 |
| `tool_failure` | turn (tool_results with error) | 0.85 |

### New signals to derive

| Signal | Source | Severity |
|--------|--------|----------|
| `connector_auth_failure` | runtime_event (401/403 from connector) | 0.9 |
| `tool_timeout` | runtime_event (tool_exec timeout) | 0.7 |
| `tool_rate_limited` | runtime_event (429 from external API) | 0.6 |

### Threshold rules

| Rule | Threshold | Action |
|------|-----------|--------|
| Same tool failing >= 5 times in 24h | count >= 5 | Create issue + downrank tool |
| Same connector 401/403 >= 3 times | count >= 3 | Quarantine connector + alert |
| Same tool timeout >= 4 times | count >= 4 | Increase timeout or suggest fallback |
| Rate limit hits >= 10 in 1h | count >= 10 | Throttle tool usage |

### Actions

- `create_issue` — write to `issues` table with tool name, failure pattern, evidence
- `downrank_tool` — update agent config to deprioritize the tool
- `quarantine_connector` — mark connector as degraded in `connector_tokens`
- `alert_operator` — emit to `alert_history` + webhook delivery

### Cooldowns

- create_issue: 12 hours
- downrank_tool: 6 hours
- quarantine_connector: 4 hours

---

## Phase 2: Cost Anomaly Governor

**Why second:** Operationally high value, objective signals, billing pipeline now solid.

### Signals to derive

| Signal | Source | Severity |
|--------|--------|----------|
| `token_spike` | turn (input_tokens + output_tokens > 2x org median) | 0.7 |
| `expensive_turn` | turn (cost_usd > budget_limit / max_turns * 3) | 0.8 |
| `tool_loop` | turn (same tool called 5+ times in one turn) | 0.85 |
| `model_cost_drift` | billing_records (7-day rolling avg up 50%+) | 0.6 |

### Threshold rules

| Rule | Threshold | Action |
|------|-----------|--------|
| Token spikes >= 3 sessions in 24h | count >= 3 | Tighten token ceiling |
| Expensive turns >= 5 in 24h | count >= 5 | Downgrade model routing |
| Tool loops >= 2 sessions | count >= 2 | Cap tool iterations |
| Cost drift sustained 3+ days | distinct_sessions >= 5 | Alert + recommend cheaper model |

### Actions

- `tighten_budget` — reduce per-turn token ceiling in agent config
- `downgrade_routing` — switch complex tier to cheaper model
- `cap_tool_iterations` — add tool call limit per turn
- `cost_alert` — emit to alert_history + operator webhook

### Cooldowns

- tighten_budget: 24 hours
- downgrade_routing: 12 hours
- cost_alert: 6 hours

---

## Phase 3: Quality Drift Governor

**Why third:** Highest long-term value but more interpretation-heavy.

### Signals to derive

| Signal | Source | Severity |
|--------|--------|----------|
| `completion_contract_failed` | otel_events (completion_contract event) | 0.7 |
| `output_too_short` | session (termination_reason) | 0.5 |
| `user_correction` | turn (LLM content contains correction markers) | 0.6 |
| `retry_loop` | session (same input retried within 5 min) | 0.75 |
| `eval_regression` | eval_trials (pass_rate drop > 20%) | 0.9 |

### Threshold rules

| Rule | Threshold | Action |
|------|-----------|--------|
| Completion failures >= 5 in 24h | count >= 5 | Trigger shadow eval |
| Output too short >= 3 sessions | count >= 3 | Recommend prompt tuning |
| User corrections >= 3 on same topic | count >= 3 | Flag for review |
| Eval regression detected | count >= 1 (high severity) | Hold release promotion |

### Actions

- `trigger_shadow_eval` — create eval_run with last N sessions as test cases
- `hold_release` — update release_channels to pause promotion
- `create_test_cases` — write to eval_test_cases from failure patterns
- `recommend_prompt_change` — create evolution_proposal

### Cooldowns

- trigger_shadow_eval: 6 hours
- hold_release: 24 hours
- create_test_cases: 12 hours

---

## Implementation pattern (same for all governors)

```typescript
// 1. Add feature to SignalFeature type
export type SignalFeature = "memory" | "reliability" | "cost" | "quality" | ...;

// 2. Add signal derivation in signals.ts
function deriveRuntimeEventSignals(payload): SignalEnvelope[] {
  // existing memory signals + new governor signals
}

// 3. Create rule pack: signal-rules-{feature}.ts
export function evaluate{Feature}SignalRules(input): {Feature}SignalAction[] {
  // threshold logic
}

// 4. Register in signal-rule-packs.ts
export function getSignalRulePack(feature): SignalRulePack | null {
  if (feature === "memory") return memorySignalRulePack;
  if (feature === "reliability") return reliabilitySignalRulePack;
  // ...
}

// 5. Add workflow actions (or reuse existing)
// 6. Add feature flag (defaults to true)
// 7. Add tests
```

---

## Mental model

| Governor | Role | First action |
|----------|------|--------------|
| Memory | Sensemaking | Digest / consolidate |
| Reliability | Ops | Issue creation / tool downrank |
| Cost | Economics | Budget tighten / model downgrade |
| Quality | Product fitness | Shadow eval / release hold |

The platform becomes self-maintaining: each governor watches its domain,
clusters weak signals into strong evidence, and fires bounded background
actions — never immediate user-facing behavior changes without review.
