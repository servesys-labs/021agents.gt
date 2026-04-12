# Spec: Harness Hardening v1

## Context

Code review of the thin harness (workflow.ts, tools.ts, codemode.ts) against Karpathy-style agent design principles surfaced five gaps. None block the memory agent rollout — these are general harness maturity items that cut across the runtime.

Separated from `docs/spec-memory-agent.md` to avoid scope creep on the memory rollout track.

## Findings

### 1. Mailbox approval types are defined but unwired

**Schema:** `mailbox.ts` defines `permission_request`, `permission_response`, `plan_approval` message types with a full SQL schema (`message_type TEXT NOT NULL CHECK(...)`).

**Runtime:** `workflow.ts:2091-2107` only handles `shutdown` and `text`. The three approval types are dead schema.

**Impact:** No HITL approval checkpoints exist. A parent agent can send a `permission_request` message and the child workflow silently ignores it.

**Fix:** Wire `permission_request` and `plan_approval` handlers in the workflow mailbox loop. When received, pause execution and wait for a corresponding `permission_response` / approval before continuing. Emit telemetry for approval latency.

### 2. No task-level edit scope ACL

**Current:** File tools (`write-file`, `edit-file`) enforce sandbox boundaries (`/workspace`, `/tmp`) but accept any path within those boundaries. A task asked to "fix the login page" can freely modify database migrations, config files, or unrelated modules.

**Impact:** Low risk in single-user single-agent sessions. Higher risk with multi-agent delegation — a sub-agent could modify files outside its intended scope.

**Fix:** Optional `allowed_paths: string[]` field on `AgentRunParams`. When set, file tools validate that the target path matches at least one glob pattern before proceeding. When unset (default), current behavior is preserved.

### 3. Completion gate is heuristic, not structured

**Current:** `evaluateCompletionContract()` in `workflow.ts:219-249` checks regex patterns (`execution_intent_without_tools`, `output_too_short`, `all_tool_calls_failed`) and artifact validation. No structured success criteria.

**Impact:** The gate catches obvious failures (no tools called, empty output) but can't verify task-specific outcomes. A task to "deploy the API" could output "Done!" with a successful tool call to `write-file` and pass the gate without actually deploying.

**Fix:** Optional `verify_command` and `pass_condition` fields on run params. When present, the completion gate runs the verify command in the sandbox and checks the output against the condition before declaring success. When absent, current heuristic behavior is preserved.

### 4. Planning contract is regex-detected, not structured

**Current:** `looksLikePrematurePlanCompletion()` detects plan-like output via regex (`## plan`, `step 1`, `executing now`) and blocks premature completion. The personal agent prompt says "MANDATORY — your response MUST begin with a numbered checklist" but this isn't validated structurally.

**Impact:** The model can output prose that looks like a plan but lacks assumptions, alternatives, or tradeoffs. The gate can't distinguish "real plan" from "plan-shaped text."

**Fix:** For tasks above a complexity threshold, require the model to emit a structured planning artifact (JSON or tagged XML) with `assumptions`, `alternatives`, `tradeoffs` fields. The completion gate validates the artifact exists before allowing execution to proceed. This belongs in a planning skill (`skills/public/plan/SKILL.md`), not harness code.

### 5. No simplicity/complexity budget

**Current:** Runtime budgets exist (cost USD, max turns, max tool calls per codemode scope). No measurement of implementation complexity — files touched, symbols changed, abstractions introduced.

**Impact:** A model asked to "add a button" could create 5 new files, 3 utility functions, and a context provider. Nothing in the runtime detects or constrains this.

**Fix:** Post-execution telemetry metric, not a runtime gate. After a task completes, emit `implementation_complexity` event with `files_touched`, `lines_added`, `lines_removed`, `new_files_created`. Alerting/eval can flag outliers. Not worth blocking execution on — the model should be guided by prompt ("don't create abstractions for one-time operations"), not hard limits.

## What this spec does NOT cover

- Memory agent behavior (see `docs/spec-memory-agent.md`)
- Security hardening (RLS, SSRF, injection — covered in the reliability audit)
- Prompt quality (covered by the personal agent eval harness)
