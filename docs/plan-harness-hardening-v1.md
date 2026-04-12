# Plan: Harness Hardening v1

Implementation plan for the harness gaps identified in `docs/spec-harness-hardening-v1.md`. Phased by ROI — highest-value, lowest-risk changes first.

## ▶︎ Resume here

**Status:** Not started. Spec complete. Decoupled from memory agent rollout (PRs A-F complete, eval green on 3 models).

---

## Phase 1 — Mailbox approval wiring

**Goal:** Wire the three unused mailbox message types so HITL approval checkpoints work end-to-end.

**Why first:** Schema already exists (`mailbox.ts:10-31`). Zero migration work. The workflow mailbox loop (`workflow.ts:2091-2107`) already reads messages — it just ignores the approval types. Highest ROI because it unblocks human-in-the-loop patterns for delegation, deployment, and destructive operations.

**Work items:**

### 1.1 — Handle `permission_request` in workflow loop

File: `deploy/src/workflow.ts` (~L2091-2107)

When `mm.message_type === "permission_request"`:
1. Emit a progress event (`type: "permission_requested"`) so the UI can show an approval dialog.
2. Pause the turn loop — poll mailbox for a `permission_response` with matching `correlation_id` (add to mailbox schema if needed).
3. On approval: continue execution. On denial: set `terminationReason = "permission_denied"`, break.
4. Timeout: if no response within configurable window (default 5 min), treat as denial.

### 1.2 — Handle `plan_approval` in workflow loop

When `mm.message_type === "plan_approval"`:
1. Inject the approved plan into messages as a system prompt: `[Plan approved by parent]: ...`
2. Set a flag so the completion gate knows a plan was explicitly approved (skip `looksLikePrematurePlanCompletion` for approved plans).

### 1.3 — Telemetry

Emit events: `permission_requested`, `permission_granted`, `permission_denied`, `permission_timeout`, `plan_approved`.

### 1.4 — Tests

- Unit: mock mailbox with `permission_request` → assert workflow pauses.
- Unit: mock `permission_response` approval → assert workflow continues.
- Unit: mock `permission_response` denial → assert workflow terminates.
- Unit: timeout → assert workflow terminates with `permission_timeout`.
- Unit: `plan_approval` → assert plan injected and premature-completion check skipped.

**Exit audit:**
- [ ] All 3 message types handled in workflow loop
- [ ] Telemetry events emitted
- [ ] Tests green
- [ ] Existing `shutdown` and `text` behavior unchanged

**Rollback:** Remove the new `case` branches. Messages revert to being ignored.

---

## Phase 2 — Task-level path ACL

**Goal:** Optional `allowed_paths` field on run params that constrains file tool operations.

**Why second:** Lightweight, optional, backward-compatible. Useful immediately for multi-agent delegation — a parent can scope a sub-agent to specific directories.

**Work items:**

### 2.1 — Schema

File: `deploy/src/workflow.ts` — `AgentRunParams` interface

Add optional field:
```typescript
/** Glob patterns limiting file operations. When set, file tools reject paths not matching any pattern. */
allowed_paths?: string[];
```

### 2.2 — Enforcement in file tools

File: `deploy/src/runtime/tools.ts` — `write-file`, `edit-file`, `read-file` cases

Before executing, check:
```typescript
if (allowedPaths?.length && !allowedPaths.some(p => minimatch(filePath, p))) {
  return `Error: ${filePath} is outside the allowed paths for this task: ${allowedPaths.join(", ")}`;
}
```

Pass `allowedPaths` through from the workflow env (set on `env.__allowedPaths` from `AgentRunParams`).

### 2.3 — Tests

- File write within allowed path → succeeds.
- File write outside allowed path → rejected with clear error.
- No `allowed_paths` set → all paths accepted (backward compat).
- Glob patterns work (`/workspace/src/**` allows `/workspace/src/foo.ts`).

**Exit audit:**
- [ ] `allowed_paths` field on `AgentRunParams`
- [ ] File tools check it
- [ ] Backward compatible (unset = no restriction)
- [ ] Tests green

**Rollback:** Remove the field and the checks. Purely additive.

---

## Phase 3 — Structured verification contract

**Goal:** Optional `verify_command` + `pass_condition` on run params for task-specific success validation.

**Why third:** Larger schema change, requires callers to adopt. Most valuable for scheduled/automated runs where no human reviews the output.

**Work items:**

### 3.1 — Schema

Add to `AgentRunParams`:
```typescript
/** Shell command to run in sandbox after completion to verify success. */
verify_command?: string;
/** Regex or substring the verify_command output must match for the task to be considered successful. */
pass_condition?: string;
```

### 3.2 — Completion gate integration

In `evaluateCompletionContract`, after all existing checks:
```typescript
if (opts.verifyCommand) {
  const result = await sandbox.exec(opts.verifyCommand, { timeout: 30_000 });
  const output = result.stdout || "";
  if (opts.passCondition && !new RegExp(opts.passCondition).test(output)) {
    reasons.push("verify_command_failed");
  }
}
```

### 3.3 — Tests

- With verify_command that passes → completion gate OK.
- With verify_command that fails → completion gate flags `verify_command_failed`.
- Without verify_command → existing heuristic behavior unchanged.
- Verify command timeout → treated as failure (not crash).

**Exit audit:**
- [ ] Fields on schema
- [ ] Completion gate runs verification
- [ ] Backward compatible
- [ ] Tests green

---

## Phase 4 — Structured planning artifact

**Goal:** For complex tasks, require a structured planning artifact before execution begins.

**Deferred until Phase 3 lands.** The verification contract provides the substrate — a planning artifact is "verify that a plan exists before executing." Implementation is a skill (`skills/public/plan/SKILL.md`) that emits structured JSON, not harness code.

---

## Phase 5 — Simplicity budget (telemetry only)

**Goal:** Emit post-execution complexity metrics for observability. Not a runtime gate.

**Work items:**
- After task completion, compute: `files_touched`, `lines_added`, `lines_removed`, `new_files_created`.
- Emit as `implementation_complexity` telemetry event.
- Dashboard/alerting can flag outliers.

**Not a runtime gate.** The model is guided by prompt ("don't create abstractions for one-time operations"). Hard limits on file count would break legitimate multi-file tasks.

---

## Invariants

1. **All changes are backward-compatible.** New fields are optional. Unset = current behavior.
2. **No prompt changes.** These are harness-level contracts, not model instructions.
3. **Each phase is independently shippable.** No dependencies between phases (except Phase 4 → Phase 3).
4. **Prototype mode.** No feature flags for these — they're structural improvements, not experiments.
