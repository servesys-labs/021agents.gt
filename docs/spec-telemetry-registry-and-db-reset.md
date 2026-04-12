# Spec: Telemetry Event Registry + DB Reset

**Status:** Ready for execution
**Effort:** 1 day (5 focused phases, ~2h each)
**Scope:** Fix telemetry debt + reset Railway DB + reseed founder accounts

---

## Problem Statement

The telemetry system has three concrete defects:

1. **Dead type enum**: `RuntimeEventType` in `deploy/src/runtime/types.ts` defines 20 event types. Zero are actually emitted. The 11 events that ARE emitted use free-form string literals not in the enum.

2. **5 separate event tables with no unified registry**: `otel_events`, `runtime_events`, `audit_log`, `security_events`, `guardrail_events` — each with its own schema, its own write path, and no shared type discipline.

3. **Scattered string literals**: 18 event types in `deploy/`, 27 in `control-plane/`, all as inline string literals with no compile-time validation. A typo creates a new event type silently.

## Current State (measured)

### Event tables

| Table | Columns | Written by | Event types | Pipeline |
|---|---|---|---|---|
| `otel_events` | org_id, agent_name, session_id, trace_id, span_id, event_type, event_data (JSONB) | deploy (workflow) | `turn_phase`, `run_phase_state`, `query_profile`, `completion_contract` | `TELEMETRY_QUEUE` → consumer → INSERT |
| `runtime_events` | org_id, agent_name, event_type, event_data (JSONB) | deploy (tools, workflow, index) | `tool_exec`, `llm_fallback`, `sandbox_start`, `llm_fallback_alert`, `memory_read`, `memory_miss`, `memory_write_rejected` | `TELEMETRY_QUEUE` → consumer → INSERT |
| `audit_log` | org_id, user_id, action, event_category, resource_type, resource_id, details (JSONB), ip_address, user_agent | control-plane (routes) | `login.success`, `login.failed`, `api_key.created`, `agent.created`, `session.revoked`, etc. (27 types) | Direct INSERT in route handlers |
| `security_events` | org_id, event_type, actor_type, actor_id, severity, details (JSONB) | control-plane | `login.failed`, `guardrail.blocked` | Direct INSERT |
| `guardrail_events` | org_id, agent_name, session_id, policy_id, event_type, blocked, details (JSONB) | control-plane | `guardrail.blocked`, `guardrail.triggered` | Direct INSERT |

### Emitters by source file

**deploy/ (18 event types across 5 files):**
- `workflow.ts`: `memory_agent_variant_assigned`, `llm_fallback`, `llm_fallback_alert`, `memory_digest_fired`, `memory_digest_skipped`, `completion_gate`, `completion_contract`, `run_phase_state`, `query_profile`, `research_artifact`, `turn_phase`
- `runtime/tools.ts`: `sandbox_start`, `tool_exec`
- `runtime/stream.ts`: `llm_fallback`, `llm_fallback_alert`
- `index.ts`: `sandbox.error`, `config.update`, `kv_poll_loop`, `email.processed`, `rag_eval`, `done`

**control-plane/ (27 event types across 10 files):**
- `routes/auth.ts`: `login.success`, `login.failed`, `agent.created`, `agent.updated`, `agent.deleted`, `session.started`, `session.completed`, `session.failed`, etc.
- `routes/api-keys.ts`: `api_key.created`, `api_key.revoked`, `api_key.rotated`
- `routes/orgs.ts`: `user.invited`, `user.role_changed`, `user.removed`
- `routes/session-mgmt.ts`: `session.revoked`, `session.revoked_all`
- `routes/guardrails.ts`: `guardrail.blocked`, `guardrail.triggered`
- Others: `direct_message`, `connector.token_stored`, `connector.tool_call`, `retention.applied`, `policy.audit_archived`

---

## Target State

### One canonical event registry, two packages

```
deploy/src/runtime/events.ts           — RuntimeEvent types + emitter
control-plane/src/telemetry/events.ts  — ControlPlaneEvent types + emitter
```

Each file exports:
1. A string union type of ALL valid event names for its package
2. A typed payload interface for each event (what goes in `event_data` / `details`)
3. An `emit()` function that accepts only registered events with the correct payload

### Naming convention

```
{domain}.{action}          — for control-plane events
  login.success, api_key.created, session.revoked

{component}_{action}       — for runtime events  
  llm_fallback, tool_exec, sandbox_start, turn_phase
```

This matches what's already emitted — no renaming needed. Just formalize and type it.

---

## Execution Plan

### Phase 1: Create the canonical registries (45 min)

**deploy/src/runtime/events.ts** — replace the dead `RuntimeEventType` enum:

```typescript
// Every event the runtime can emit, with its typed payload.
export type RuntimeEventType =
  // Workflow observability (→ otel_events)
  | "turn_phase"
  | "run_phase_state"
  | "query_profile"
  | "completion_contract"
  | "completion_gate"
  | "research_artifact"
  // LLM (→ runtime_events)
  | "llm_fallback"
  | "llm_fallback_alert"
  // Tools (→ runtime_events)
  | "tool_exec"
  | "sandbox_start"
  | "sandbox.error"
  // Memory (→ runtime_events)
  | "memory_read"
  | "memory_miss"
  | "memory_write_rejected"
  | "memory_digest_fired"
  | "memory_digest_skipped"
  | "memory_agent_variant_assigned"
  // Infra (→ runtime_events)
  | "config.update"
  | "kv_poll_loop"
  | "email.processed"
  | "rag_eval";
```

**control-plane/src/telemetry/events.ts** — formalize the 27 audit event types:

```typescript
export type AuditEventType =
  // Auth
  | "login.success"
  | "login.failed"
  | "login.mfa_verified"
  // Sessions
  | "session.started"
  | "session.completed"
  | "session.failed"
  | "session.expired"
  | "session.revoked"
  | "session.revoked_all"
  // Agents
  | "agent.created"
  | "agent.updated"
  | "agent.deleted"
  | "agent.run.completed"
  // API keys
  | "api_key.created"
  | "api_key.revoked"
  | "api_key.rotated"
  // Org management
  | "user.invited"
  | "user.removed"
  | "user.role_changed"
  | "member.invited"
  | "member.removed"
  // Connectors
  | "connector.token_stored"
  | "connector.tool_call"
  // Config & retention
  | "config.update"
  | "retention.applied"
  | "policy.audit_archived"
  // Chat platforms
  | "direct_message";
```

**Deliverable**: two files with string union types covering every event that exists in the codebase today. No behavioral changes yet.

### Phase 2: Wire emitters to the registries (1 hour)

Replace every free-form `event_type: "..."` string literal with a reference to the registry.

**deploy/**: ~26 emit sites across 5 files. Each becomes:
```typescript
import type { RuntimeEventType } from "./events";
// Before: event_type: "tool_exec"
// After:  event_type: "tool_exec" satisfies RuntimeEventType
// Or:     event_type: "tool_exec" as RuntimeEventType
```

The `satisfies` approach is zero-runtime-cost — it's a compile-time check only. If someone types `"tool_exce"`, TypeScript catches it.

**control-plane/**: ~37 emit sites across 10 files. Same pattern with `AuditEventType`.

**Deliverable**: every emit site has a compile-time type check. No runtime changes, no behavioral changes.

### Phase 3: Delete the dead enum + update types.ts (15 min)

Remove the old `RuntimeEventType` from `deploy/src/runtime/types.ts` and update the `RuntimeEvent` interface to import from the new `events.ts`.

Update `deploy/src/runtime/db.ts` lines 1055, 1445, 1710 that cast to `RuntimeEvent["event_type"]` — these will now reference the real type.

**Deliverable**: the dead enum is gone. One source of truth for event types per package.

### Phase 4: DB reset + reseed (30 min)

Now that the schema is verified clean (Phase 0 of today's session), reset the data:

```sql
-- Truncate all data tables (keep schema)
TRUNCATE TABLE sessions, turns, otel_events, runtime_events, 
  credit_holds, credit_transactions, billing_records, billing_exceptions,
  end_user_usage, do_conversation_messages, episodes, conversations,
  conversation_messages, batch_jobs, batch_tasks, job_queue, 
  audit_log, security_events, guardrail_events, facts,
  org_credit_balance, api_keys, agents, org_members, orgs, users
  CASCADE;
```

Then reseed:
- 2 founder accounts (founder@oneshots.co, stella@021agents.ai)
- Default assistant agent per org
- $100 credit balance each
- API keys with proper SHA-256 hashing

**Deliverable**: pristine production DB, zero load-test artifacts, founder accounts ready.

### Phase 5: Verify end-to-end (30 min)

1. Make a live agent request → verify:
   - Credit hold reserved + settled ✅
   - Session written to `sessions` ✅
   - Turn written to `turns` ✅
   - `otel_events` has a `turn_phase` row ✅
   - `runtime_events` has a `tool_exec` or `llm_fallback` row ✅
   - `credit_transactions` has an audit row ✅
   - `billing_records` has a billing row ✅

2. Check TypeScript catches a typo:
   - Change one emit site to `"tool_exce"` → verify tsc fails
   - Revert

3. Run `verify-drain.sh` → all pass

**Deliverable**: confidence that the full pipeline works with real data, typed events, and clean DB.

---

## What this does NOT change

- **Table schemas**: the 5 event tables stay as-is. No schema migration.
- **Event naming**: all event names stay the same. No renaming.
- **Write paths**: `TELEMETRY_QUEUE` for runtime events, direct INSERT for audit events. Unchanged.
- **Payload shapes**: the `event_data` / `details` JSONB stays free-form for now. Typed payload interfaces are a follow-up (adds Zod validation at emit time).

## What this DOES change

- **Dead enum → real enum**: `RuntimeEventType` reflects reality
- **Compile-time safety**: typos in event names caught at build time
- **Canonical registry**: one file per package lists every event — new contributors know where to look
- **Clean DB**: zero load-test artifacts, verified end-to-end pipeline

---

## Risks

| Risk | Mitigation |
|---|---|
| `satisfies` check breaks on an event we missed | Phase 1 survey was exhaustive (grep-based). If tsc fails, add the missing type. |
| DB truncate loses founder accounts | Reseed script is idempotent and tested. |
| Telemetry queue has in-flight messages during reset | TRUNCATE is instant. A few events may fail to INSERT (FK on org_id). The queue retries, and after reseed the FKs resolve. |

## Success criteria

- [ ] `npx tsc --noEmit` passes on both deploy and control-plane
- [ ] All 834+ tests pass
- [ ] Live agent request produces rows in: sessions, turns, otel_events, runtime_events, credit_holds (settled), credit_transactions
- [ ] `verify-drain.sh` all pass
- [ ] Changing an event_type string literal to a typo → tsc fails
