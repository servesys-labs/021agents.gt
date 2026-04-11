---
name: batch
description: "Decompose a large task into independent sub-tasks and execute them in parallel via delegated agents."
when_to_use: "When the user has a large task that can be decomposed into independent parallel sub-tasks, or explicitly asks to batch/parallelize work."
category: orchestration
version: 1.0.0
enabled: true
allowed-tools:
  - run-agent
  - a2a-send
  - marketplace-search
---
You are executing the /batch skill. Your task: {{ARGS}}

# Batch: Parallel Work Orchestration

You orchestrate large, parallelizable work across this codebase. Follow this 3-phase workflow EXACTLY. Do NOT skip phases or reorder them.

---

## Phase 1: PLAN — Research, Decompose, Present, Wait

### Step 1.1: Understand the Scope

Read the user's request carefully. If the task is vague, ambiguous, or missing critical details, ask clarifying questions FIRST — do not guess. Use these research steps:

1. **Identify the blast radius.** Use \`glob\` and \`grep\` to find every file, module, pattern, and call site that the change touches. Cast a wide net — search for type names, function names, import paths, config keys, and string literals related to the change.
2. **Understand existing conventions.** Read 2-3 representative files that already do what the change requires. Note naming conventions, error handling patterns, test structure, import style, and any project-specific idioms.
3. **Check for blockers.** Look for:
   - Circular dependencies that would make isolated changes impossible
   - Shared state (global singletons, module-level caches) that multiple sub-tasks would both modify
   - Generated files that would conflict if multiple workers regenerate them
   - Lock files, build outputs, or config files that cannot be split

### Step 1.2: Decompose into 3-15 Independent Sub-Tasks

Each sub-task MUST be:
- **Independently implementable** — no shared mutable state with sibling tasks
- **Independently verifiable** — has its own success criteria that can be checked without inspecting other tasks
- **Independently mergeable** — produces a valid codebase state on its own
- **Roughly uniform in effort** — split large tasks, merge trivial ones into batches

**Decomposition decision table** — choose the slicing strategy that best fits:

| Strategy | When to use | Example | Risk to watch |
|----------|-------------|---------|---------------|
| By module/package | Changes span multiple packages or services | "Migrate logging in auth, api, worker" | Shared types across modules |
| By file | Many files need the same mechanical change | "Add type annotations to all handlers" | Files that import each other |
| By feature | Cross-cutting change touches multiple features | "Update error handling in search, upload, export" | Shared error utilities |
| By layer | Change spans data/logic/presentation layers | "Update validation at API, service, DB layers" | Interface contracts between layers |
| By test surface | Each sub-task maps to an existing test suite | "Fix all failing test suites" | Shared test fixtures |

**Scale guidance:**
- Few files, simple mechanical changes → 3-5 workers
- Moderate scope, some complexity → 6-10 workers
- Large codebase, many independent modules → 11-15 workers
- NEVER exceed 15 — coordination overhead outweighs parallelism beyond this

### Step 1.3: Estimate Effort and Dependencies

For each sub-task:
- **Effort**: S (< 5 files, mechanical), M (5-15 files or requires judgment), L (15+ files or complex logic)
- **Dependencies**: List any sub-tasks that MUST complete before this one (most should have none)
- **Risk**: LOW (mechanical), MEDIUM (requires understanding context), HIGH (touches critical path or shared state)

### Step 1.4: Present the Plan

Present a numbered plan table. Include ALL of the following columns:

| # | Task | Scope (files/dirs) | Description | Effort | Risk | Dependencies | Success Criteria |
|---|------|--------------------|-------------|--------|------|-------------|-----------------|
| 1 | ... | \`src/auth/\` | ... | S/M/L | L/M/H | none | ... |
| 2 | ... | \`src/api/*.ts\` | ... | S/M/L | L/M/H | none | ... |

Below the table, include:
- **Total estimated scope**: X files across Y directories
- **Parallelism**: "All tasks are independent" or "Tasks N, M must run after task K"
- **Conventions to enforce**: List the 3-5 most important conventions workers must follow (naming, imports, error handling, test patterns)

### Step 1.5: WAIT for Approval

**STOP HERE.** Present the plan and wait for the user to approve, modify, or reject it. Do NOT proceed to Phase 2 until the user explicitly approves. If the user requests changes, update the plan and present it again.

---

## Phase 2: EXECUTE — Parallel Dispatch via Swarm

Once the plan is approved, spawn workers using the \`swarm\` tool. **Use swarm, NOT run-agent.** Launch ALL independent sub-tasks in parallel in a single swarm call. If some tasks depend on others, launch the independent ones first, wait for completion, then launch the dependent ones.

### Worker Prompt Requirements

Each worker's prompt must be **fully self-contained** — workers cannot see each other's context. Include ALL of the following:

1. **Overall goal**: The user's original instruction (verbatim)
2. **This worker's assignment**: Task title, exact file list, change description — copied verbatim from the approved plan
3. **Codebase conventions**: The conventions list from the plan (naming, imports, error handling, test patterns)
4. **Success criteria**: The specific, verifiable criteria from the plan for this sub-task
5. **Reference examples**: Point the worker to 1-2 existing files that demonstrate the desired pattern (discovered during research)
6. **Worker checklist** (include verbatim in every worker prompt):

\`\`\`
After completing your assigned change:
1. VERIFY — Check that your success criteria are met. Read the changed files and confirm the change is correct.
2. TEST — Run the project's test suite if available (check package.json scripts, Makefile targets, or common commands like npm test, bun test, pytest, go test). Fix any failures your change introduced.
3. LINT — Run the project's linter if available. Fix any warnings your change introduced.
4. SELF-REVIEW — Read your diff (git diff). Check for: debug code left in, hardcoded values, missing error handling, broken imports.
5. REPORT — End with a structured summary:
   - STATUS: done | failed
   - FILES_CHANGED: <count>
   - TESTS: passed | failed | skipped (with reason)
   - ISSUES: <any problems encountered or concerns>
\`\`\`

### Swarm Dispatch Rules

- Launch ALL independent tasks in a **single** swarm call — do not send them one at a time
- Each worker gets its own isolated context — do not assume workers can communicate
- If a task has effort L or risk HIGH, add extra context and more detailed instructions to its worker prompt
- Include file paths as absolute paths or paths relative to the repo root — never ambiguous partial paths

---

## Phase 3: TRACK — Monitor, Report, Summarize

### Step 3.1: Initial Status Table

Render immediately after launching workers:

| # | Task | Status | Files Changed | Tests | Issues |
|---|------|--------|---------------|-------|--------|
| 1 | \`<title>\` | running | — | — | — |
| 2 | \`<title>\` | running | — | — | — |

### Step 3.2: Progressive Updates

As results arrive, update each row:
- **Status**: \`done\` (green), \`failed\` (red), \`partial\` (yellow — some changes made but issues remain)
- **Files Changed**: Number from worker's report
- **Tests**: passed / failed / skipped
- **Issues**: Brief description from worker's report

### Step 3.3: Failure Handling

For each failed task:
1. Quote the error message from the worker's report
2. Identify the root cause category: build error, test failure, merge conflict, timeout, unclear instructions
3. Suggest remediation: retry, manual fix, split into smaller tasks, or skip with justification

### Step 3.4: Final Summary

When all workers have reported, render:
1. The completed status table (all rows updated)
2. A one-line summary: "X/Y tasks completed successfully. Z failures — see details above."
3. If there were failures: a prioritized list of recommended next steps
4. If all succeeded: "All tasks completed. Run \`/verify\` to validate the full change set."

---

## Rules

- **Never execute sequentially** if tasks are independent — always use swarm for parallelism
- **Continue on failure** — one task failing does NOT block others
- **Ask if unclear** — if the user's instruction is ambiguous, ask in Phase 1 BEFORE decomposing
- **Each sub-task must be independently verifiable** — no task's correctness depends on another task's output
- **Never launch more than 15 workers** — split into rounds if needed
- **Preserve the user's intent** — if decomposition would change the semantics of the request, flag it and ask
- If the user hasn't specified a task, ask what they want to accomplish before planning
