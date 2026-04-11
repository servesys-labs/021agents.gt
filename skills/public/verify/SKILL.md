---
name: verify
description: "Verify that a change works by running the agent's eval test cases against it."
when_to_use: "When the user asks to verify a change works, run tests, or check for regressions."
category: testing
version: 1.0.0
enabled: true
allowed-tools:
  - bash
  - read-file
  - http-request
---
You are executing the /verify skill. What to verify: {{ARGS}}

# Verify: Structured Verification Methodology

You verify that a code change does what it claims, handles edge cases, and doesn't break existing functionality. Follow all four phases. NEVER claim a test passes when it fails — accuracy is more important than a clean report.

---

## Phase 1: UNDERSTAND — Read the Change and Its Intent

1. **Read the diff.** Run \`git diff\` (or \`git diff HEAD~1\` for committed changes) to see exactly what changed. Note every file, every added line, every removed line.
2. **Read the full files.** Don't just read the diff — read the complete changed files to understand the surrounding context, invariants, and contracts.
3. **Identify the intent.** What is this change supposed to do? Check:
   - Commit message (if committed)
   - PR description (if available)
   - The user's stated goal
   - Comments in the code
4. **Identify the blast radius.** What could this change break?
   - What other files import/depend on the changed code?
   - What features use the changed code paths?
   - Are there config changes that affect multiple environments?
   - Use \`grep\` to find all callers/importers of changed exports

---

## Phase 2: PLAN TESTS — Design Verification for Each Change

For each meaningful change, plan tests across four dimensions:

### Positive Tests (Happy Path)
- Does the change achieve its stated goal?
- Does it work with typical, expected input?
- Does it produce the correct output/behavior?

### Negative Tests (Edge Cases and Bad Input)
- What happens with null/undefined/empty input?
- What happens with malformed input?
- What happens with extremely large input?
- What happens with special characters (unicode, newlines, HTML entities)?
- What happens at boundary values (0, -1, MAX_INT, empty string vs null)?

### Regression Tests (Blast Radius)
- Do existing features that depend on the changed code still work?
- Do the existing test suites pass?
- Are there integration points that might break (API contracts, event shapes, DB schemas)?

### Performance Tests (if change is non-trivial)
Only run performance checks if the change is >10 lines or touches a hot path:
- Is the change measurably slower? (benchmark before/after)
- Does it add new allocations to a hot loop?
- Does it add new I/O to a synchronous path?

### What to Verify by Change Type

| Change Type | Must Verify | Also Verify |
|------------|-------------|-------------|
| **Bug fix** | Fix works + original bug report scenario | No regression in related features |
| **New feature** | Feature works end-to-end | No regression + feature is discoverable |
| **Refactor** | Behavior is unchanged (same inputs → same outputs) | Performance is not degraded |
| **Config change** | Works in target environment | Works in ALL environments (dev, staging, prod) |
| **Dependency update** | Build succeeds + tests pass | No breaking API changes in the dependency |
| **Security fix** | Vulnerability is patched | No new attack surface introduced |
| **Performance fix** | Measurable improvement | No correctness regression |

---

## Phase 3: EXECUTE — Run Tests Systematically

### Step 3.1: Run Existing Test Suite First

Always start with the project's own tests:
1. Check for test scripts: \`package.json\` scripts, \`Makefile\` targets, \`pytest.ini\`, \`jest.config\`, \`.github/workflows\`
2. Run the full test suite: \`npm test\`, \`bun test\`, \`pytest\`, \`go test ./...\`, etc.
3. If the full suite is slow, run only the tests related to changed files first, then the full suite
4. Record: which tests ran, how many passed, how many failed, how long it took

### Step 3.2: Run Type Checking (if applicable)

- TypeScript: \`npx tsc --noEmit\`
- Python: \`mypy\` or \`pyright\`
- Go: \`go vet ./...\`
- Record any type errors introduced by the change

### Step 3.3: Run Linting (if applicable)

- Check for lint config: \`.eslintrc\`, \`biome.json\`, \`.pylintrc\`, \`golangci-lint\`
- Run the linter on changed files
- Record any new warnings/errors

### Step 3.4: Ad-Hoc Scenarios (if no existing tests cover the change)

If the project lacks tests for the changed area, create ad-hoc verification:

**Unit verification:**
- Call the changed function directly with test inputs
- Check return values match expectations
- Check error cases throw/return appropriate errors

**Integration verification:**
- Start the service/server if applicable
- Hit the affected endpoint/route with test requests
- Verify responses match expectations

**E2E verification:**
- Walk through the full user flow that exercises the change
- Check that the change is visible/functional from the user's perspective

### Step 3.5: Manual Inspection

Even if all automated tests pass, manually inspect:
- Does the diff contain any debug code (\`console.log\`, \`debugger\`, \`print\`)? Flag it.
- Does the diff contain any hardcoded values that should be configurable? Flag it.
- Does the diff contain any commented-out code? Flag it.
- Does the diff handle all error paths, or does it only handle the happy path?

---

## Phase 4: REPORT — Honest, Structured Results

### Test Results Table

| # | Test | Type | Expected | Actual | Status |
|---|------|------|----------|--------|--------|
| 1 | Unit tests pass | Existing | 0 failures | 0 failures | PASS |
| 2 | Type check clean | Existing | 0 errors | 2 errors | FAIL |
| 3 | Login still works | Regression | 200 OK | 200 OK | PASS |
| 4 | Empty input handled | Edge case | Returns null | Throws TypeError | FAIL |

### For Each Failure

Include ALL of the following:
1. **What failed**: The exact test or scenario
2. **Expected**: What should have happened
3. **Actual**: What actually happened (include the exact error output)
4. **Root cause**: Why it failed (if determinable)
5. **Suggested fix**: How to fix it (if obvious)

### Summary

- **Verdict**: PASS (all tests pass, change is safe to ship) | FAIL (issues found, see details) | PARTIAL (some concerns, but shippable with caveats)
- **Confidence**: HIGH (comprehensive test coverage) | MEDIUM (some gaps in coverage) | LOW (minimal testing available)
- **Risks**: Any remaining concerns even if tests pass (e.g., "No load testing done", "Cannot verify in production-like environment")
- **Recommendations**: Next steps (e.g., "Add a test for the empty-input edge case before merging")

---

## Rules

- **NEVER claim passing when failing.** If a test fails, report it honestly. A false green is worse than a real red.
- **NEVER skip verification steps silently.** If you can't run a test (missing dependency, no test config), say so explicitly.
- **Test the change, not your assumptions.** Run the actual code — don't just read it and say "this looks correct."
- **Include exact output.** When reporting failures, include the actual error message, not a paraphrase.
- **Verify the negative.** It's not enough that the right thing happens — verify that the wrong thing doesn't happen.
