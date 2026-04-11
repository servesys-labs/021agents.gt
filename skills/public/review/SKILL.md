---
name: review
description: "Review changed code through 3 parallel lenses: reuse, quality, and efficiency. Then fix found issues."
when_to_use: "When the user asks to review code changes, check code quality, audit recent commits, or do a code review."
category: code-quality
version: 1.0.0
enabled: true
allowed-tools:
  - bash
  - read-file
  - edit-file
  - grep
  - glob
---
You are executing the /review skill. Focus: {{ARGS}}

# Review: Three-Lens Parallel Code Review

You perform a structured code review through three parallel lenses — reuse, quality, and efficiency — then fix the issues found. Follow all four phases in order.

---

## Phase 1: IDENTIFY — Gather the Changes

1. Run \`git diff\` to see unstaged changes. Also run \`git diff --staged\` for staged changes and \`git diff HEAD~1\` for the last commit. Use whichever has content.
2. Run \`git diff --name-only HEAD~1\` (or equivalent) to get the list of changed files.
3. Read each changed file IN FULL — do not rely only on the diff. You need surrounding context to judge whether code is redundant, whether utilities exist nearby, and whether abstractions are leaky.
4. Note the total scope: X files changed, Y lines added, Z lines removed.

If there are no git changes, review the files the user mentioned or the most recently edited files in this conversation.

---

## Phase 2: THREE-LENS REVIEW

Run all three lenses. If using swarm, launch them in parallel — each lens is independent. Pass each lens agent the full diff AND the full content of changed files.

### Lens 1: REUSE — Find existing code that makes new code unnecessary

For each changed file, actively search for existing utilities that could replace new code:

1. **Search for existing helpers.** Use these specific search patterns:
   - \`grep -r "function <similar_name>"\` in \`src/\`, \`lib/\`, \`utils/\`, \`shared/\`, \`common/\`
   - \`glob("**/utils/**")\`, \`glob("**/helpers/**")\`, \`glob("**/lib/**")\`
   - \`grep\` for the same operation name (e.g., if new code formats dates, search for "formatDate", "dateFormat", "toDateString")
2. **Flag duplicate functionality.** If the new code does something an existing function already does, flag it with: the new code location, the existing function location, and whether they're exact or near duplicates.
3. **Flag inline logic that should use existing helpers.** Common candidates:
   - Hand-rolled string manipulation (when \`lodash\`, \`path\`, or project utilities exist)
   - Manual path joining/resolution (when \`path.join\`/\`path.resolve\` exists)
   - Custom environment checks (when an env utility exists)
   - Ad-hoc type guards (when branded types or Zod schemas exist)
   - Manual error formatting (when an error utility exists)
4. **Check for pattern violations.** Does the new code follow the patterns established in adjacent files? If sibling files use a factory, but the new code hand-constructs — flag it.

### Lens 2: QUALITY — Find code smells and structural problems

Review for these specific anti-patterns, in order of severity:

1. **Empty catch blocks** — swallowing errors silently. Severity: HIGH.
2. **Console.log left in production code** — should use structured logger or be removed. Severity: MEDIUM.
3. **TODO/FIXME/HACK without a ticket reference** — untracked tech debt. Severity: LOW.
4. **Magic numbers/strings** — unexplained literals that should be named constants. Severity: MEDIUM.
5. **God functions** — functions longer than 50 lines or doing more than one thing. Severity: MEDIUM.
6. **Redundant state** — state that duplicates existing state, cached values that could be derived, effects that could be direct calls. Severity: HIGH.
7. **Parameter sprawl** — functions with 5+ parameters. Should use an options object or be decomposed. Severity: MEDIUM.
8. **Copy-paste with variation** — near-duplicate code blocks (>5 lines with <20% variation) that should be unified into a shared abstraction. Severity: HIGH.
9. **Leaky abstractions** — exposing internal implementation details through return types, parameter types, or thrown error types that break encapsulation. Severity: MEDIUM.
10. **Stringly-typed code** — using raw strings where constants, enums, string unions, or branded types already exist in the codebase. Severity: MEDIUM.
11. **Unnecessary comments** — comments that explain WHAT the code does (the code already says that) rather than WHY. Delete these. Keep only comments that explain non-obvious constraints, subtle invariants, or workarounds. Severity: LOW.

### Lens 3: EFFICIENCY — Find performance and resource issues

Review for these specific patterns:

1. **Unnecessary work** — redundant computations, repeated file reads, duplicate network/API calls, N+1 query patterns, computing values that are never used. Severity: HIGH.
2. **Missed concurrency** — independent async operations (\`await a(); await b();\`) that could run in parallel with \`Promise.all([a(), b()])\`. Only flag when the operations are truly independent. Severity: MEDIUM.
3. **Hot-path bloat** — new blocking or expensive work added to startup, per-request, or per-render hot paths. Check: is this code called once or on every request? Severity: HIGH.
4. **Recurring no-op updates** — state/store updates inside polling loops, intervals, or event handlers that fire unconditionally without change detection. Downstream consumers get notified even when nothing changed. Also: verify that wrapper functions honor "no change" return signals from updater callbacks. Severity: MEDIUM.
5. **Unnecessary existence checks (TOCTOU)** — pre-checking file/resource existence before operating on it (\`if exists then read\`). Instead, operate directly and handle the error. The pre-check is both wasteful and racy. Severity: MEDIUM.
6. **Memory leaks** — unbounded data structures (maps/arrays that grow without bounds), missing cleanup of timers/listeners, event listeners registered without corresponding removal, closures capturing large objects unnecessarily. Severity: HIGH.
7. **Overly broad operations** — reading entire files when only a header is needed, loading all records when filtering for one, fetching all columns when only two are used. Severity: MEDIUM.

---

## Phase 3: REPORT — Structured Findings Table

Aggregate all findings from the three lenses into a single table, sorted by severity:

| # | File | Line(s) | Lens | Issue | Severity | Auto-fixable? |
|---|------|---------|------|-------|----------|---------------|
| 1 | \`src/foo.ts\` | 42-55 | REUSE | Duplicates existing \`formatDate\` in \`utils/dates.ts\` | HIGH | Yes |
| 2 | \`src/bar.ts\` | 18 | QUALITY | Empty catch block swallows network error | HIGH | Yes |
| 3 | \`src/baz.ts\` | 92-94 | EFFICIENCY | Sequential awaits that could be parallel | MEDIUM | Yes |

After the table:
- **Summary**: "Found X issues across Y files (Z auto-fixable)"
- **Recommendation**: "Shall I fix the N auto-fixable issues? I'll apply them one at a time so you can review each change."

---

## Phase 4: FIX — Apply Auto-Fixable Issues

If the user approves (or for auto-fix items when user says "fix all"):

1. Apply fixes **one at a time**, in order of severity (HIGH first)
2. For each fix, explain:
   - **What changed**: The specific edit made
   - **Why**: Which lens finding this addresses
   - **Confidence**: HIGH (mechanical replacement), MEDIUM (judgment call), LOW (suggest manual review)
3. After each fix, verify it doesn't break surrounding code — check imports, types, and test compilation if applicable
4. After all fixes are applied, present a summary:
   - "Applied X/Y auto-fixable changes. Z issues require manual review — see items #A, #B above."

---

## Anti-Pattern Quick Reference (flag these on sight)

| Pattern | Why it's bad | Fix |
|---------|-------------|-----|
| Empty catch block | Hides errors, makes debugging impossible | Log or rethrow with context |
| \`console.log\` in prod code | No structure, no levels, pollutes output | Use project logger or remove |
| TODO without ticket | Untracked debt, never gets done | Add ticket ref or do it now |
| Magic number \`if (x > 86400)\` | Unreadable, unmaintainable | \`const SECONDS_PER_DAY = 86400\` |
| God function (50+ lines) | Hard to test, hard to understand | Extract sub-functions |
| \`any\` type escape hatch | Defeats type safety | Use proper type or \`unknown\` |
