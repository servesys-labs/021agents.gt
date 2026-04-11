/**
 * Skills loader — loads SKILL.md-based skills from Supabase into edge runtime.
 * Skills are injected into the system prompt and can specify allowed tools + prompt templates.
 */

import { getDb } from "./db";
import { log } from "./log";
import { BUNDLED_SKILLS_BY_NAME } from "./skills-manifest.generated";

export interface Skill {
  name: string;
  description: string;
  prompt_template: string;
  allowed_tools: string[];
  enabled: boolean;
  version: string;
  category: string;
  /** When to auto-activate this skill — if present, the LLM can detect and activate without explicit /command. */
  when_to_use?: string;
  /** Minimum plan required to run this skill in the main agent context.
   *  If the user's plan is below this, auto-delegate to delegate_agent. */
  min_plan?: "basic" | "standard" | "premium";
  /** Skill agent to delegate to when the user's plan is below min_plan. */
  delegate_agent?: string;
}

const skillCache = new Map<string, { skills: Skill[]; expiresAt: number }>();
const SKILL_CACHE_TTL_MS = 60_000; // 1 minute

/**
 * Load enabled skills for an agent from the database.
 * Returns cached results within TTL.
 */
export async function loadSkills(
  hyperdrive: Hyperdrive,
  orgId: string,
  agentName: string,
): Promise<Skill[]> {
  const cacheKey = `${orgId}:${agentName}`;
  const cached = skillCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.skills;

  try {
    const sql = await getDb(hyperdrive);
    const rows = await sql`
      SELECT name, description, prompt_template, allowed_tools, version, category, when_to_use
      FROM skills
      WHERE org_id = ${orgId}
        AND (agent_name = ${agentName} OR agent_name IS NULL)
        AND enabled = true
      ORDER BY name
    `;

    const skills: Skill[] = rows.map((r: any) => ({
      name: r.name,
      description: r.description || "",
      prompt_template: r.prompt_template || "",
      allowed_tools: (() => {
        try { return JSON.parse(r.allowed_tools || "[]"); } catch { return []; }
      })(),
      enabled: true,
      version: r.version || "1.0.0",
      category: r.category || "general",
      when_to_use: r.when_to_use || undefined,
    }));

    skillCache.set(cacheKey, { skills, expiresAt: Date.now() + SKILL_CACHE_TTL_MS });

    // Evict old entries
    if (skillCache.size > 256) {
      const oldest = [...skillCache.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt);
      for (let i = 0; i < 64; i++) skillCache.delete(oldest[i][0]);
    }

    return skills;
  } catch (err) {
    log.warn("[skills] Failed to load skills:", err);
    return cached?.skills ?? [];
  }
}

/**
 * Format skills as a system prompt section.
 */
export function formatSkillsPrompt(skills: Skill[], plan?: string): string {
  const all = [...BUILTIN_SKILLS, ...skills];
  if (all.length === 0) return "";

  const planTier = (plan || "standard").toLowerCase();
  const planRank: Record<string, number> = { basic: 0, standard: 1, premium: 2 };
  const userRank = planRank[planTier] ?? 1;

  // Partition into auto-detect (has when_to_use) and manual (explicit /command only)
  const autoSkills = all.filter(s => s.when_to_use);
  const manualSkills = all.filter(s => !s.when_to_use);

  const lines = [
    "",
    "## Available Skills",
    "",
    "When the user's request matches a skill below, activate it by starting your response with: <activate-skill name=\"skill-name\">user's request</activate-skill>",
    "",
  ];

  if (autoSkills.length > 0) {
    lines.push("**Auto-detect skills** (activate when criteria match):");
    for (const s of autoSkills) {
      let line = `- /${s.name} — ${s.description} USE WHEN: ${s.when_to_use}`;
      if (s.min_plan && s.delegate_agent && userRank < (planRank[s.min_plan] ?? 1)) {
        line += ` *(${s.min_plan}+ plan recommended; auto-delegates to \`${s.delegate_agent}\` on current plan)*`;
      }
      lines.push(line);
    }
    lines.push("");
  }

  if (manualSkills.length > 0) {
    lines.push("**Manual skills** (invoke with /command):");
    for (const s of manualSkills) {
      let line = `- /${s.name} — ${s.description}`;
      if (s.min_plan && s.delegate_agent && userRank < (planRank[s.min_plan] ?? 1)) {
        line += ` *(${s.min_plan}+ plan recommended; auto-delegates to \`${s.delegate_agent}\` on current plan)*`;
      }
      lines.push(line);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Get the full prompt for a specific skill activation.
 * Called when user invokes /skill-name or when the agent matches a trigger.
 */
export function getSkillPrompt(skillName: string, args: string, skills: Skill[]): string | null {
  const all = [...BUILTIN_SKILLS, ...skills];
  const skill = all.find(s => s.name === skillName);
  if (!skill) return null;

  let prompt = skill.prompt_template;
  if (args) prompt = prompt.replace("{{ARGS}}", args).replace("{{INPUT}}", args);
  return prompt;
}

// ══════════════════════════════════════════════════════════════════════
// Built-in Skills — ported from Claude Code's bundled skill patterns
// Always available, no DB dependency. Loaded alongside DB skills.
// ══════════════════════════════════════════════════════════════════════

export const BUILTIN_SKILLS: Skill[] = [
  BUNDLED_SKILLS_BY_NAME["batch"],

  BUNDLED_SKILLS_BY_NAME["review"],

  // ── /debug — Session and agent diagnostics ──
  {
    name: "debug",
    description: "Diagnose issues with the current agent: check error rates, circuit breaker status, recent failures, and tool health.",
    when_to_use: "When the user reports an error, asks why something is broken, or needs help diagnosing agent or tool failures.",
    category: "diagnostics",
    version: "1.0.0",
    enabled: true,
    allowed_tools: ["bash", "read-file", "grep", "web-search", "http-request"],
    prompt_template: `You are executing the /debug skill. Issue: {{ARGS}}

# Debug: Structured Diagnostic Methodology

You are a systematic debugger. Follow this 5-phase workflow to diagnose and fix issues. Do NOT jump to conclusions — follow the phases in order.

---

## Phase 1: REPRODUCE — Get the Facts

Before diagnosing anything, establish the exact symptoms:

1. **Get the exact error.** Ask the user for (or find in context):
   - The exact error message and/or stack trace
   - The exact steps that trigger the error
   - When it started (after a deploy? after a code change? randomly?)
   - How often it happens (every time? intermittently? only under load?)

2. **If the user gives a vague description** ("it's broken", "it doesn't work", "something's wrong"), ask these clarifying questions FIRST — do not guess:
   - "What did you expect to happen?"
   - "What actually happened instead?"
   - "Can you share the exact error message or a screenshot?"
   - "Did this work before? What changed?"

3. **Attempt to reproduce.** If possible, run the failing command/request yourself to see the error firsthand. This confirms the issue is real and gives you the full error context.

---

## Phase 2: ISOLATE — Binary Search for the Cause

Narrow down the problem using elimination. Check these dimensions:

### Is it a recent change?
- Run \\\`git log --oneline -10\\\` to see recent commits
- Run \\\`git diff HEAD~3\\\` to see recent changes
- If the issue started after a specific commit, \\\`git bisect\\\` mentally — which commit introduced it?

### Is it a specific tool or service?
- Check circuit breaker status for each tool
- Try the operation with a different tool (if applicable)
- Check if other tools in the same category are also failing

### Is it a specific input?
- Test with the minimal possible input
- Test with known-good input that worked before
- Check if the input has special characters, encoding issues, or exceeds size limits

### Is it timing-dependent?
- Does it fail on first try but succeed on retry? (race condition, cold start)
- Does it fail after running for a while? (memory leak, connection pool exhaustion)
- Does it fail only at certain times? (rate limits, scheduled maintenance, timezone issues)

### Is it environment-specific?
- Does it fail in production but not local? (env vars, secrets, DNS, network policies)
- Does it fail for one user but not another? (permissions, quotas, data-specific)
- Does it fail on one region/replica but not another? (deployment lag, state divergence)

---

## Phase 3: ROOT CAUSE — Decision Tree

Based on the isolation results, follow the appropriate decision tree:

### Network Error (timeout, connection refused, DNS failure)
1. Check the URL — is it correct? Is the host resolvable?
2. Check DNS — can you resolve the hostname? (\\\`nslookup\\\` / \\\`dig\\\`)
3. Check connectivity — can you reach the host? (\\\`curl -v\\\`)
4. Check firewall/network policies — is the port allowed? Is there an allowlist?
5. Check rate limits — are you being throttled? Check response headers for \\\`Retry-After\\\` or \\\`X-RateLimit-*\\\`
6. Check TLS — is the certificate valid? Is the TLS version compatible?

### Auth Error (401, 403, token invalid)
1. Check the token — is it present? Is it expired? (\\\`jwt.io\\\` decode if JWT)
2. Check permissions — does this token/key have the required scopes?
3. Check the auth flow — is the token being sent in the right header/cookie?
4. Check token refresh — is the refresh mechanism working?
5. Check environment — is the correct token being used for this environment (prod vs staging)?

### Data Error (validation failure, parse error, unexpected format)
1. Check input format — does it match the expected schema?
2. Check encoding — UTF-8? URL-encoded? Base64?
3. Check size limits — is the payload too large?
4. Check null/undefined — is a required field missing?
5. Check types — is a string being passed where a number is expected?

### Runtime Error (crash, exception, OOM)
1. Check dependencies — are all required packages installed? Correct versions?
2. Check memory — is the process running out of memory? Check limits.
3. Check stack trace — which function threw? What were the arguments?
4. Check async — is there an unhandled promise rejection? Missing await?
5. Check circular — is there a circular dependency or infinite recursion?

### Intermittent Error (works sometimes, fails sometimes)
1. Check race conditions — are two operations competing for the same resource?
2. Check caching — is a stale cache serving bad data?
3. Check connection pools — are connections being exhausted and not released?
4. Check timeouts — is the operation sometimes too slow?
5. Check load — does it fail under concurrent requests but not single requests?

---

## Phase 4: FIX — Minimal Change, Maximum Safety

1. **Apply the minimal fix.** Change as little as possible to fix the root cause. Do NOT refactor unrelated code while debugging.
2. **Add a regression guard.** For every fix, add at least one of:
   - A test case that reproduces the original bug and verifies the fix
   - An assertion that catches the root cause condition early
   - A log line that makes this failure mode visible if it recurs
3. **Document what was wrong.** In a code comment or commit message, explain:
   - What the symptom was
   - What the root cause was
   - Why this fix is correct

---

## Phase 5: VERIFY — Confirm the Fix

1. **Re-run the failing scenario.** Use the exact same steps/input that triggered the original error.
2. **Check for side effects.** Run the project's test suite. Check that related functionality still works.
3. **Check the edge cases.** Test the boundary conditions near the fix:
   - What happens with empty input?
   - What happens with maximum-size input?
   - What happens under concurrent access?
4. **Report the result.** Present a clear summary:
   - **Root cause**: One sentence explaining what went wrong
   - **Fix applied**: What was changed and where
   - **Verification**: What was tested and the results
   - **Risk assessment**: Could this fix break anything else? What should be monitored?

---

## Common Patterns Quick Reference

| Error Type | Likely Cause | Quick Check |
|-----------|-------------|-------------|
| \\\`ECONNREFUSED\\\` | Service not running | Check process, port, Docker container |
| \\\`ETIMEDOUT\\\` | Network/firewall | Check connectivity, DNS, rate limits |
| \\\`401 Unauthorized\\\` | Bad/expired token | Decode token, check expiry, check env var |
| \\\`403 Forbidden\\\` | Missing permission | Check scopes, roles, RLS policies |
| \\\`404 Not Found\\\` | Wrong URL or missing resource | Check URL, check if resource exists |
| \\\`429 Too Many Requests\\\` | Rate limited | Check Retry-After header, add backoff |
| \\\`500 Internal Server Error\\\` | Unhandled exception | Check server logs, stack trace |
| \\\`ENOMEM\\\` / OOM killed | Memory exhaustion | Check for unbounded growth, leaks |
| \\\`ERR_MODULE_NOT_FOUND\\\` | Missing dependency | Check package.json, run install |
| Intermittent failures | Race condition or pool exhaustion | Check concurrency, connection limits |
| Silent wrong result | Logic error | Add assertions, check boundary conditions |
| Works locally, fails in prod | Env config mismatch | Diff env vars, check secrets, check versions |

## Severity Classification

- **CRITICAL**: Data loss, security vulnerability, complete service outage. Fix immediately.
- **HIGH**: Core feature broken, error rate elevated, user-facing impact. Fix within hours.
- **MEDIUM**: Degraded experience, workaround exists, non-critical feature affected. Fix within days.
- **LOW**: Cosmetic issue, edge case, no user impact. Fix when convenient.`,
  },

  // ── /verify — Run eval against a specific change ──
  {
    name: "verify",
    description: "Verify that a change works by running the agent's eval test cases against it.",
    when_to_use: "When the user asks to verify a change works, run tests, or check for regressions.",
    category: "testing",
    version: "1.0.0",
    enabled: true,
    allowed_tools: ["bash", "read-file", "http-request"],
    prompt_template: `You are executing the /verify skill. What to verify: {{ARGS}}

# Verify: Structured Verification Methodology

You verify that a code change does what it claims, handles edge cases, and doesn't break existing functionality. Follow all four phases. NEVER claim a test passes when it fails — accuracy is more important than a clean report.

---

## Phase 1: UNDERSTAND — Read the Change and Its Intent

1. **Read the diff.** Run \\\`git diff\\\` (or \\\`git diff HEAD~1\\\` for committed changes) to see exactly what changed. Note every file, every added line, every removed line.
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
   - Use \\\`grep\\\` to find all callers/importers of changed exports

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
1. Check for test scripts: \\\`package.json\\\` scripts, \\\`Makefile\\\` targets, \\\`pytest.ini\\\`, \\\`jest.config\\\`, \\\`.github/workflows\\\`
2. Run the full test suite: \\\`npm test\\\`, \\\`bun test\\\`, \\\`pytest\\\`, \\\`go test ./...\\\`, etc.
3. If the full suite is slow, run only the tests related to changed files first, then the full suite
4. Record: which tests ran, how many passed, how many failed, how long it took

### Step 3.2: Run Type Checking (if applicable)

- TypeScript: \\\`npx tsc --noEmit\\\`
- Python: \\\`mypy\\\` or \\\`pyright\\\`
- Go: \\\`go vet ./...\\\`
- Record any type errors introduced by the change

### Step 3.3: Run Linting (if applicable)

- Check for lint config: \\\`.eslintrc\\\`, \\\`biome.json\\\`, \\\`.pylintrc\\\`, \\\`golangci-lint\\\`
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
- Does the diff contain any debug code (\\\`console.log\\\`, \\\`debugger\\\`, \\\`print\\\`)? Flag it.
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
- **Verify the negative.** It's not enough that the right thing happens — verify that the wrong thing doesn't happen.`,
  },

  // ── /remember — Memory curation and deduplication ──
  BUNDLED_SKILLS_BY_NAME["remember"],

  // ── /skillify — Extract a repeatable process into a reusable skill ──
  BUNDLED_SKILLS_BY_NAME["skillify"],

  // ── /schedule — Create a recurring agent task ──
  {
    name: "schedule",
    description: "Schedule an agent to run a task on a recurring interval (e.g., 'every morning at 9am check for new issues').",
    category: "automation",
    version: "1.0.0",
    enabled: true,
    allowed_tools: ["http-request"],
    prompt_template: `You are executing the /schedule skill. Task: {{ARGS}}

## Scheduling Workflow

### Step 1: Parse the Schedule
Extract from the user's request:
- **What**: The task to execute
- **When**: The schedule (e.g., "every 5 minutes", "daily at 9am", "weekdays at noon")
- **Who**: Which agent should run it (default: current agent)

Convert the schedule to a cron expression:
- "every 5 minutes" → */5 * * * *
- "daily at 9am" → 0 9 * * *
- "weekdays at noon" → 0 12 * * 1-5
- "every hour" → 0 * * * *

### Step 2: Confirm
Present the schedule to the user:
"I'll schedule [agent] to run '[task]' on this schedule:
- Cron: [expression]
- Next run: [computed]
- Timezone: [user's timezone]

Proceed?"

### Step 3: Create
Use the HTTP request tool to create the schedule via the control-plane API:
POST /api/v1/schedules
{
  "agent_name": "[agent]",
  "schedule": "[cron]",
  "task": "[task description]",
  "timezone": "[tz]"
}

### Step 4: Confirm
Report the created schedule ID and next execution time.`,
  },

  // ── /docs — Load reference documentation for the current context ──
  BUNDLED_SKILLS_BY_NAME["docs"],

  // ═══════════════════════════════════════════════════════════════
  // Research & Analysis Skills (adapted from Perplexity methodology)
  // ═══════════════════════════════════════════════════════════════

  {
    name: "research",
    description: "Deep iterative research with multi-source evidence gathering, cross-referencing, and structured synthesis.",
    when_to_use: "When the user asks a question requiring investigation, fact-checking, market analysis, competitive analysis, or any query that benefits from searching multiple sources and synthesizing findings with citations.",
    category: "research",
    version: "1.0.0",
    enabled: true,
    min_plan: "standard",
    delegate_agent: "research-analyst",
    allowed_tools: ["web-search", "browse", "parallel-web-search", "web-crawl", "memory-save", "memory-recall", "knowledge-search", "python-exec"],
    prompt_template: `You are a world-class research expert. Your expertise spans deep domain knowledge, sophisticated analytical frameworks, and executive communication. You synthesize complex information into actionable intelligence while adapting your reasoning, structure, and exposition to match the highest conventions of the user's domain.

You produce outputs with substantial economic value — documents that executives, investors, and decision-makers would pay premium consulting fees to access. Your output should meet the quality bar of a $200,000+ professional deliverable.

## Research Protocol

### Phase 1: Prior Knowledge & Scoping
- Search memory-recall for any prior findings on this topic — build on existing work rather than starting from scratch
- Define 3-5 specific research questions that must be answered
- Identify what "good enough" evidence looks like
- Create a mental todo list of research tasks

### Phase 2: Evidence Gathering (iterate until complete)
**Do the full job, not the minimum viable version.**

For each research question:
1. Use \`parallel-web-search\` for broad initial exploration across multiple angles simultaneously
2. Search with **recency-focused queries** (include current year: 2026) to catch recent developments that would invalidate older sources
3. Prefer **primary sources**: official docs, published papers, government data, company filings. Search results help you find URLs, not extract data — never treat snippet content as authoritative.
4. Always \`browse\` or \`web-crawl\` the **primary source** page for critical claims — snippets miss context
5. For any statistics or claims, find the **original source** — not a blog citing a blog
6. Cross-reference minimum 2 independent sources for key claims
7. For complex multi-faceted topics, use \`swarm\` to delegate parallel deep dives on independent sub-questions

**Iteration discipline:**
- After each round of searches, evaluate: does the current evidence fully answer the user's question?
- If gaps remain, search from different angles or deeper on specific subtopics
- Don't consider research complete until you've genuinely satisfied the requirements
- If scope is larger than expected, adapt rather than rushing to finish

### Phase 3: Analysis & Synthesis
- Clean and normalize data before drawing conclusions (don't leave "$1,200" as a string if you need to calculate with it)
- Derive insights, don't just transform data — "what does this MEAN?"
- Use inline tables and structured comparisons to reduce cognitive load
- Call out **confidence levels**: High (multiple primary sources), Medium (single primary or multiple secondary), Low (limited evidence)
- Flag gaps: explicitly state what you could NOT find
- Note limitations in what you found
- Save key findings to memory-save for future research continuity

### Phase 4: Deliverable
Topic: {{ARGS}}

OUTPUT FORMAT:
- **Executive Summary** (3-5 sentences, key findings + recommendation)
- **Detailed Findings** (organized by research question, with inline citations)
- **Data & Comparisons** (tables, lists, structured data)
- **Limitations & Gaps** (what wasn't available, confidence caveats)
- **Sources** (numbered list of URLs with descriptive titles)

RULES:
- Every factual claim must have a source. No unsourced statistics.
- Never fabricate URLs — only cite pages you actually retrieved.
- If you find contradictory evidence, present both sides with your assessment.
- Prefer recent data (2025-2026) over older data unless historical context is needed.
- The bar is: would a meticulous analyst be satisfied with this output, or would they say "this is a good start, but you didn't actually analyze it"?`,
  },

  {
    name: "report",
    description: "Generate a structured markdown research report with citations, data visualizations, and executive summary.",
    category: "research",
    version: "1.0.0",
    enabled: true,
    when_to_use: "When the user asks for a written report, white paper, briefing document, research summary, or any structured deliverable with citations and analysis.",
    min_plan: "standard",
    delegate_agent: "research-analyst",
    allowed_tools: ["web-search", "browse", "python-exec", "write-file", "read-file", "memory-recall"],
    prompt_template: `Generate a comprehensive research report on: {{ARGS}}

## Output File

**Always write the report to a file with a \`.md\` extension.**

- Derive the filename from the query topic: \`report-<topic-slug>.md\` (lowercase kebab-case)
- Write the file using the write-file tool
- After writing, share the file with the user via share-artifact so they can view it
- The chat response should contain a brief summary — the full report lives in the \`.md\` file

## Research Methodology

Use the /research skill methodology for evidence gathering: define research questions, search multiple sources, cross-reference key claims, prefer primary sources, iterate until gaps are filled. The research is always comprehensive; the output length adapts to user intent.

## Content Format

Reports use standard GitHub-Flavored Markdown (GFM):
- Standard Markdown (headings, paragraphs, lists, emphasis, links, code blocks)
- Markdown tables for comparisons and structured data
- Inline citations as markdown links matching search result URLs
- Embedded images and charts (see Embedding Images below)
- LaTeX math expressions allowed (wrap in \\( \\) for inline, \\[ \\] for block — never dollar signs)

## Content Separation

**The report contains ONLY research findings, analysis, and evidence.**
- Direct answers to the user's question go in the chat response, NOT in the report
- The report is a standalone reference document — comprehensible without the chat context
- Think of the chat response as the executive summary and the report as the full analysis

## Report Structure

- **Title** (H1) — descriptive, not clickbait
- **Executive Summary / Overview** — brief synthesis of key findings
- **Body Sections** (H2/H3) — organized by topic or theme, not by source
- **Analysis / Discussion** — interpretation, trade-offs, implications
- **Conclusion** — summary of findings and actionable takeaways

Structure guidelines:
- Use H1 for the report title only
- Use H2 for major sections, H3 for subsections
- Do not skip heading levels (e.g., H1 directly to H3)
- Structure emerges from content and purpose — do not force a rigid template
- Follow domain conventions when applicable (academic, investment, technical, policy)

## Citation System (MANDATORY FOR RESEARCHED TOPICS)

**Use inline markdown links where the anchor text is the source name, publication, or a natural descriptive phrase — never a generic word like "source" or "link", and never a raw URL.**

Only use URLs that are present in your tool outputs. Text must read naturally even if all URLs were removed.

\`\`\`
Recent research shows significant AI advances ([Nature](https://...)). Multiple studies confirm this trend ([MIT Technology Review](https://...)).
\`\`\`

Rules:
- Place citations immediately after the claim as inline markdown links
- 1-3 citations per substantive claim
- Distribute citations throughout — consistent density from beginning to end
- All citations are inline — never include a bibliography or references section
- Only cite actual sources from search results — never fabricate citations or URLs

## Embedding Images

When research includes generated charts, plots, or other images, embed them directly in the report:

1. Generate the image using python-exec (matplotlib, plotly) and save as .png
2. Reference in the report using relative path: \`![descriptive alt text](./filename.png)\`
3. Use descriptive filenames (e.g., \`revenue-growth-chart.png\`, \`market-share-comparison.png\`)
4. Place images at contextually appropriate locations — after the paragraph discussing the data
5. Always include meaningful alt text
6. Do NOT use absolute paths — always use \`./filename\` format

## Length Calibration

- **Concise/summary requests:** 5-10 paragraphs despite thorough research
- **Fact-seeking queries:** Direct answer with rich context, 5-10 paragraphs
- **Comparison/ranking requests:** Structured analysis, 20-40+ paragraphs. Prefer tables.
- **Open-ended research:** 20-40+ paragraphs
- **Explicit depth requests:** Length determined by topic scope with no upper limit
- **Default:** Comprehensive. When in doubt, provide more depth.

## Writing Principles

- Lead with the direct answer, then supporting context
- Paragraphs of 3-8 sentences for most content
- Never use first-person pronouns ("I," "my," "we," "our")
- Use tables when comparing 2+ entities across shared attributes
- Use bullet points when information is naturally list-like
- Lead with conclusions, then support with evidence
- Analyze rather than summarize: explain causation, trade-offs, what makes information actionable
- When sources conflict, state the disagreement, evaluate source quality, justify your conclusion
- Anticipate follow-up questions and address proactively

## Quality Checklist

- Report written to a \`.md\` file and shared with user
- Valid GFM syntax, appropriate heading hierarchy
- Inline citations present for factual claims (source names as anchor text)
- No bibliography or References section
- Images embedded with relative paths and descriptive alt text
- No first-person pronouns
- Report is standalone — comprehensible without chat context
- Appropriate length matching query complexity
- No TODOs or placeholders — all sections fully written
- Real data only — never fabricate citations or data`,
  },

  // ═══════════════════════════════════════════════════════════════
  // Design & Visualization Skills
  // ═══════════════════════════════════════════════════════════════

  {
    name: "design",
    description: "Apply professional design foundations — color palettes, typography, data visualization rules, accessibility standards. Use when creating any visual output.",
    category: "design",
    version: "1.0.0",
    enabled: true,
    when_to_use: "When the user asks to design something visual, choose colors, create a palette, select typography, or needs design guidance for any output format (web, PDF, slides, charts).",
    allowed_tools: ["python-exec", "write-file", "read-file"],
    prompt_template: `Apply these design foundations to: {{ARGS}}

Artifact-agnostic design guidance — works for CSS, PowerPoint, matplotlib, PDF, or any visual output.

## Core Principles

1. **Restraint** — 1 accent + neutrals. 2 fonts max, 2-3 weights. Earn every element; decoration must encode meaning.
2. **Purpose** — Every choice answers "what does this help the viewer understand?" Color encodes meaning, type size signals hierarchy, spacing groups content, animation reveals information.
3. **No decoration** — Do not add illustrations, stock images, decorative icons, or clip art unless explicitly requested. Typography, whitespace, and layout are the primary visual tools.
4. **Accessibility** — WCAG AA contrast (4.5:1 body, 3:1 large text). Never rely on color alone. 12px text floor, 16px body copy. Respect \`prefers-reduced-motion\`.

---

# Color — Default Palette & Accessibility

## Philosophy: Earn Every Color

Color is emphasis — every non-neutral color must answer: **what does this help the viewer understand?** The viewer's eye goes where color is; if everything is colored, nothing stands out.

**Target:** 1 accent + 0-2 semantic colors (error/warning/success). Everything else neutral. Squint at your output — you should see a calm, mostly-neutral surface with 1-2 small moments of color.

---

## Default Palette — Nexus

**Use when the user gives no color direction.** Warm, professional, accessible.

**These are roles, not a mandate.** A typical output uses Background + Text + Primary. Add semantic colors (error, warning, success) only when the content requires them. Do not introduce color for decoration.

### Light Mode

| Role | Hex | Usage |
|---|---|---|
| Background | \`#F7F6F2\` | Primary background |
| Surface | \`#F9F8F5\` | Cards, containers |
| Surface alt | \`#FBFBF9\` | Secondary surface layer |
| Border | \`#D4D1CA\` | Dividers, card borders |
| Text | \`#28251D\` | Primary body text |
| Text muted | \`#7A7974\` | Secondary text |
| Text faint | \`#BAB9B4\` | Placeholders, tertiary |
| Primary | \`#01696F\` | Links, CTAs (Hydra Teal) |
| Primary hover | \`#0C4E54\` | Hover state |
| Error | \`#A12C7B\` | Destructive states |
| Warning | \`#964219\` | Caution states |
| Success | \`#437A22\` | Confirmation states |

### Dark Mode

| Role | Hex | Usage |
|---|---|---|
| Background | \`#171614\` | Primary background |
| Surface | \`#1C1B19\` | Cards, containers |
| Surface alt | \`#201F1D\` | Secondary surface layer |
| Border | \`#393836\` | Dividers, card borders |
| Text | \`#CDCCCA\` | Primary body text |
| Text muted | \`#797876\` | Secondary text |
| Text faint | \`#5A5957\` | Tertiary text |
| Primary | \`#4F98A3\` | Links, CTAs |
| Primary hover | \`#227F8B\` | Hover state |
| Error | \`#D163A7\` | Destructive states |
| Warning | \`#BB653B\` | Caution states |
| Success | \`#6DAA45\` | Confirmation states |

### Extended Palette (data visualization only)

| Name | Light | Dark |
|---|---|---|
| Orange | \`#DA7101\` | \`#FDAB43\` |
| Gold | \`#D19900\` | \`#E8AF34\` |
| Blue | \`#006494\` | \`#5591C7\` |
| Purple | \`#7A39BB\` | \`#A86FDF\` |
| Red | \`#A13544\` | \`#DD6974\` |

**Data visualization naturally needs extra colors** to distinguish categories and series — that's legitimate. Derive chart colors from the project's accent (monochromatic shades work well for sequential data) or use the curated chart color sequence below. Chart colors should feel like they belong in the same design system as the rest of the page.

---

## Custom Palettes

When the user provides color direction **or the content suggests a natural accent** (e.g., finance -> navy, sustainability -> green): start with that primary as accent -> derive surfaces by desaturating -> keep semantic colors recognizable (red=error, green=success) -> build light AND dark -> test contrast (body 4.5:1, large text 3:1). If neither user direction nor content suggest a clear hue, use the Nexus palette above.

---

## Color Accessibility (Non-Negotiable)

- **WCAG AA:** Body text 4.5:1, large text (18px+/14px bold) 3:1
- **Color independence:** Never rely on color alone — add labels, patterns, icons
- **Colorblind safety:** Avoid red/green only. Blue/orange is safer. 8% of men have red-green deficiency
- **Test:** Screenshot and verify contrast. Use DevTools audit for CSS, visual check for slides/charts

---

# Typography — Selection, Hierarchy, Pairing

## Foundational Rules

1. **Readable measure:** 45-75 characters/line (66 ideal). Drives container widths and font sizes.
2. **Leading:** 1.5-1.6x body, 1.15-1.25x headings. Sans-serifs need more.
3. **Typographic color:** Consistent word-spacing. Never letterspace lowercase. Flush-left/ragged-right for screen.
4. **Proportional scales:** Each size step marks a content role change. Same role = same size everywhere.
5. **Content-sympathetic typefaces:** Font chosen for novelty rather than sympathy with content fights the reader.

## Economy

- **3-4 text styles** per page/slide (title, heading, body, caption)
- **2 fonts max** (display + body). Weight and size for variation, not extra typefaces.
- **2-3 weights** per font. Regular + bold covers most needs.

## Display vs. Body

| Type | Min screen | Min print/slides | Use for |
|---|---|---|---|
| Display | 24px | 18pt | Titles, heroes, covers |
| Body | 12px | 9pt | Body, bullets, captions |
| Body bold (heading) | 18px | 14pt | Section headings |

Never set display fonts below 24px/18pt. Never use body fonts at hero sizes expecting drama.

## Serif vs. Sans-Serif

- **Sans-serif** for UI, dashboards, data, product interfaces, documents, and slides. Better at small sizes. Natural default for professional output.
- **Serif** for editorial, long-form, or explicitly formal contexts. Adds authority and rhythm. Use for headings only — not body text in documents or slides.
- Below 14px/10pt, always use sans-serif.
- **Documents & slides default to professional sans-serif** unless the content calls for a formal/editorial tone.

## Font Strategy by Format

| Format | Strategy | Why |
|---|---|---|
| **Websites** | Intentionally selected distinctive fonts loaded via CDN. **Prefer Fontshare** (less overexposed) over Google Fonts. The font IS the design. | Websites load any font via CDN. System fonts are fallback only. |
| **PDFs** | Same quality as web — embed any TTF. Download from Google Fonts at runtime. | PDFs embed fonts automatically. Use professional, distinctive fonts. |
| **Slides (PPTX)** | System fonts only — Calibri, Trebuchet MS, Arial, Georgia. | PPTX cannot embed fonts. Viewer must have the font installed. |
| **Documents (DOCX)** | System fonts recommended — Arial, Calibri. | Documents must render correctly on the viewer's machine. |

### Default Font Pairings (when no font direction is given)

| Purpose | Free web alt | Free PDF alt (embed TTF) | Free slide alt (system only) |
|---|---|---|---|
| Headlines | Satoshi / General Sans | DM Sans Bold / Work Sans SemiBold | Calibri Bold / Trebuchet MS |
| Body | Satoshi / Inter | Inter / DM Sans | Calibri / Arial |
| Code | JetBrains Mono / Fira Code | JetBrains Mono | Consolas / Courier New |

## Font Rules

**Blacklisted:** Papyrus, Comic Sans, Lobster, Impact, Jokerman, Bleeding Cowboys, Permanent Marker, Bradley Hand, Brush Script, Hobo, Trajan, Raleway, Clash Display, Courier New (body).

**Overused on the web (never use as the primary font for websites):** Roboto, Arial, Helvetica, Open Sans, Lato, Montserrat, Poppins. System fonts (Arial, Helvetica, Georgia, Calibri, Times New Roman, Verdana, Tahoma, Trebuchet MS) belong in the fallback stack only — never as the chosen font. For slides and documents where embedding is unavailable, system fonts are fine as the primary choice.

**Vary across projects** — never reuse the same combination twice in a row.

## Size Hierarchy

| Role | Web (px) | Slides (pt) |
|---|---|---|
| Hero / Cover | 48-128px | 44-72pt |
| Page / Slide title | 24-36px | 36-44pt |
| Section heading | 18-24px | 18-28pt |
| Body | 16-18px | 14-18pt |
| Captions / Labels | 12-14px | 10-12pt |

**Floor:** 12px / 9pt absolute minimum for any text.

## Slides Pairings (System Fonts Only)

| Heading | Body | Tone |
|---|---|---|
| Trebuchet MS Bold | Calibri | Modern, clean |
| Calibri Bold | Calibri Light | Minimal, corporate |
| Arial Black | Arial | Bold, direct |
| Georgia | Calibri | Classic, formal |
| Cambria | Calibri | Traditional |

## PDF Pairings (Embedded — download TTF at runtime)

| Heading | Body | Tone |
|---|---|---|
| DM Sans Bold | Inter | Modern, clean |
| Work Sans SemiBold | Work Sans | Minimal, versatile |
| Instrument Serif | DM Sans | Editorial, sophisticated |
| Source Serif 4 Bold | Source Sans 3 | Traditional, authoritative |

Fallback: Helvetica (built-in, no download needed).

---

# Data Visualization — Colors, Charts, Design

## Chart Color Sequence

Use in order for data series (bar, pie, line, scatter):

| # | Hex | Name |
|---|---|---|
| 1 | \`#20808D\` | Teal (chart primary) |
| 2 | \`#A84B2F\` | Terra/rust |
| 3 | \`#1B474D\` | Dark teal |
| 4 | \`#BCE2E7\` | Light cyan |
| 5 | \`#944454\` | Mauve |
| 6 | \`#FFC553\` | Gold |
| 7 | \`#848456\` | Olive |
| 8 | \`#6E522B\` | Brown |

**Fit chart colors to the art direction.** For sequential data, use monochromatic shades of the primary accent. For categorical data that needs distinct hues, use the curated sequence above. When the project has a custom palette, derive chart colors from it.

**Rules:** <=5 series per chart (use small multiples beyond that). Sequential data: single hue, varying lightness. Diverging data: teal \`#20808D\` positive, red \`#A13544\` negative. Highlight key series at full opacity, dim others to 40-60%.

**Colorblind safety:** Never color alone — add labels/patterns/markers. Avoid red/green only. Blue+orange is safer.

## Chart Type Selection

| Data question | Chart type | Notes |
|---|---|---|
| Change over time? | Line | Continuous data, trends |
| Category comparison? | Vertical bar | Discrete comparisons |
| Ranking? | Horizontal bar | Easier label reading |
| Part of whole? | Stacked bar / treemap | NOT pie (rarely right) |
| Distribution? | Histogram / box plot | Spread, outliers |
| Relationship? | Scatter | Correlation, clusters |
| Geographic? | Choropleth map | Regional comparisons |
| Flow/process? | Sankey / funnel | Conversion, steps |

**Never:** 3D charts, pie with 5+ slices, dual-axis charts.

## Data Viz Design Principles

1. **Data-ink ratio** — Every pixel presents data. Remove decorative gridlines, borders, backgrounds.
2. **Label directly** — Labels on/near data points, not in separate legends. Legends only when direct labeling would clutter.
3. **Color with purpose** — Encode a data dimension, never decorate.
4. **Accessible** — Never color alone. 3:1 contrast between adjacent elements. Alt text or data tables as fallback.

## Typography in Charts

- Body font only — never display fonts
- Axis labels: 12-14px / 10-12pt
- Titles state the insight: "Revenue grew 23% in Q4" not "Revenue Chart"
- \`tabular-nums lining-nums\` on all numeric values

## KPI Cards

- **Value:** Large, bold — dominant element
- **Label:** Small, muted
- **Delta:** Colored arrow + %. Teal/green up, red down, gray flat
- **Sparkline (optional):** Tiny trend line, no axes`,
  },

  {
    name: "chart",
    description: "Generate publication-quality charts, graphs, and data visualizations using Python.",
    when_to_use: "When the user asks to create a chart, graph, plot, visualization, or visual representation of data.",
    category: "visualization",
    version: "1.0.0",
    min_plan: "standard",
    delegate_agent: "data-analyst",
    enabled: true,
    allowed_tools: ["python-exec", "read-file", "write-file", "image-generate"],
    prompt_template: `Create a data visualization: {{ARGS}}

Reference the /design skill for color palettes and foundational design rules.

---

## Chart Selection Table

| What you're showing | Best chart | Alternatives |
|---------------------|-----------|-------------|
| Trend over time | Line | Area (cumulative/composition) |
| Comparison across categories | Vertical bar | Horizontal bar (many categories) |
| Ranking | Horizontal bar | Dot plot, slope chart (two periods) |
| Part-to-whole | Stacked bar | Treemap (hierarchical), waffle chart |
| Composition over time | Stacked area | 100% stacked bar (proportion focus) |
| Distribution (single var) | Histogram | Box plot (group comparison), violin, KDE |
| Distribution (group comparison) | Box plot | Violin (shape), strip/swarm (small N) |
| Correlation (2 vars) | Scatter | Bubble (3rd var as size), hexbin (large N) |
| Correlation (many vars) | Heatmap (correlation matrix) | Pair plot (distributions + scatter) |
| Multiple KPIs | Small multiples | Dashboard with separate charts |
| Flow / conversion | Sankey / funnel | Waterfall (additive breakdown) |
| Geographic | Choropleth | Bubble map (point data) |

**Avoid:** Pie charts (humans compare angles poorly -- use bar or waffle), 3D charts (distortion, zero information gain), dual-axis (implies false correlation -- use two panels instead).

**Decision shortcut:** If in doubt, horizontal bar chart is almost always a safe, readable choice.

---

## Python Setup

\\\`\\\`\\\`python
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.ticker as mticker
import matplotlib.dates as mdates
import matplotlib.patheffects as pe
import seaborn as sns
import numpy as np
import pandas as pd

plt.style.use("seaborn-v0_8-whitegrid")
plt.rcParams.update({
    "figure.figsize": (10, 6),
    "figure.dpi": 150,
    "figure.facecolor": "white",
    "font.family": "sans-serif",
    "font.size": 11,
    "axes.titlesize": 14,
    "axes.titleweight": "bold",
    "axes.labelsize": 12,
    "axes.spines.top": False,
    "axes.spines.right": False,
    "legend.frameon": False,
    "legend.fontsize": 10,
    "xtick.labelsize": 10,
    "ytick.labelsize": 10,
})

# ---- Palettes ----
# Categorical -- distinct hues for unordered categories (max 8 series; use small multiples beyond)
PALETTE_CATEGORICAL = ["#20808D", "#A84B2F", "#1B474D", "#BCE2E7", "#944454", "#FFC553", "#848456", "#6E522B"]
# Sequential -- single hue, varying lightness (for ordered/continuous data)
PALETTE_SEQUENTIAL = sns.color_palette("YlGnBu", n_colors=7)
# Diverging -- two opposing hues through neutral midpoint
PALETTE_DIVERGING = sns.color_palette("RdYlBu", n_colors=7)
# Colorblind-safe fallback -- use when audience is unknown or >3 categories
PALETTE_COLORBLIND = sns.color_palette("colorblind")

# Highlight pattern: accent for key insight, grey for everything else
COLOR_HIGHLIGHT = "#20808D"
COLOR_MUTED = "#BBBBBB"

def highlight_palette(n, highlight_idx=0):
    """Return list of n colors where highlight_idx is accented, rest muted."""
    return [COLOR_HIGHLIGHT if i == highlight_idx else COLOR_MUTED for i in range(n)]
\\\`\\\`\\\`

---

## Number Formatting Helper

\\\`\\\`\\\`python
def format_number(val, fmt="number"):
    """Format numbers for axis labels, annotations, and tooltips.
    fmt: 'number' | 'currency' | 'percent' | 'decimal'"""
    if pd.isna(val):
        return ""
    prefix = "$" if fmt == "currency" else ""
    if fmt == "percent":
        return f"{val:.1f}%"
    if fmt == "decimal":
        return f"{prefix}{val:,.2f}"
    if abs(val) >= 1e9:
        return f"{prefix}{val/1e9:.1f}B"
    if abs(val) >= 1e6:
        return f"{prefix}{val/1e6:.1f}M"
    if abs(val) >= 1e3:
        return f"{prefix}{val/1e3:.1f}K"
    return f"{prefix}{val:,.0f}"

# Apply to axes:
ax.yaxis.set_major_formatter(mticker.FuncFormatter(lambda x, p: format_number(x, "currency")))

# Apply to bar labels:
for bar, val in zip(bars, values):
    ax.text(bar.get_x() + bar.get_width()/2, bar.get_height(),
            format_number(val), ha="center", va="bottom", fontsize=10)
\\\`\\\`\\\`

---

## Design Principles

1. **Highlight the story**: Bright accent for the key insight; grey (\\\`#BBBBBB\\\`) everything else. Use \\\`highlight_palette()\\\` to apply this pattern. The viewer's eye goes where color is -- if everything is colored, nothing stands out.
2. **Titles state insights**: "Revenue grew 23% YoY" not "Revenue by Month." Add subtitle with date range and source via \\\`ax.set_title("Insight", loc="left"); ax.text(0, 1.02, "Subtitle", transform=ax.transAxes, fontsize=9, color="#777")\\\`.
3. **Sort by value**, not alphabetically, unless a natural order exists (months, funnel stages, time).
4. **Aspect ratio**: Time series wider than tall (16:6 to 16:9); comparisons squarer (8:6). Set via \\\`figsize\\\`.
5. **Bar charts start at zero.** Line charts may use non-zero baselines when the value range matters more than absolute position.
6. **Consistent scales across panels** when comparing multiple charts (same y-axis range, same color mapping). Use \\\`sharey=True\\\` in \\\`plt.subplots()\\\`.
7. **Data-ink ratio**: Every pixel should present data. Remove decorative gridlines, chart borders, and backgrounds. Use \\\`ax.grid(axis="y", alpha=0.3)\\\` for subtle horizontal reference lines only.
8. **Label directly**: Place labels on or near data points, not in separate legends. Use \\\`ax.annotate()\\\` or \\\`ax.text()\\\`. Legends only when direct labeling would clutter (>4 series).
9. **White space is information**: Don't cram charts together. Use \\\`plt.tight_layout(pad=2.0)\\\` or \\\`fig.subplots_adjust()\\\` for breathing room.
10. **One chart, one message**: If a chart tries to show two things, split it into two charts.

---

## Common Chart Recipes

\\\`\\\`\\\`python
# ---- Annotated bar chart with highlight ----
fig, ax = plt.subplots(figsize=(10, 6))
colors = highlight_palette(len(categories), highlight_idx=top_idx)
bars = ax.barh(categories, values, color=colors)
ax.set_xlabel("")
ax.set_title("Top category outperforms by 2x", loc="left")
for bar, val in zip(bars, values):
    ax.text(bar.get_width() + offset, bar.get_y() + bar.get_height()/2,
            format_number(val), va="center", fontsize=10)

# ---- Time series with confidence band ----
ax.plot(dates, values, color=COLOR_HIGHLIGHT, linewidth=2)
ax.fill_between(dates, lower, upper, color=COLOR_HIGHLIGHT, alpha=0.15)
ax.xaxis.set_major_formatter(mdates.DateFormatter("%b %Y"))
ax.xaxis.set_major_locator(mdates.MonthLocator(interval=3))

# ---- Small multiples ----
fig, axes = plt.subplots(1, 3, figsize=(15, 5), sharey=True)
for ax, (name, group) in zip(axes, df.groupby("category")):
    ax.plot(group["date"], group["value"], color=COLOR_HIGHLIGHT)
    ax.set_title(name, fontsize=12)
fig.suptitle("Trend by category", fontsize=14, fontweight="bold", x=0.05, ha="left")
\\\`\\\`\\\`

---

## Accessibility

- Use \\\`PALETTE_COLORBLIND\\\` (or \\\`sns.color_palette("colorblind")\\\`) as the default palette when >3 categories or when you don't control the audience.
- Add pattern fills alongside color so the chart works in B&W:
  \\\`\\\`\\\`python
  hatches = ["/", "\\\\\\\\", "x", ".", "o", "+", "-", "*"]
  for bar, hatch in zip(bars, hatches):
      bar.set_hatch(hatch)
  \\\`\\\`\\\`
- For line charts, combine color with distinct line styles (\\\`"-"\\\`, \\\`"--"\\\`, \\\`"-."\\\`, \\\`":"\\\`) and markers (\\\`"o"\\\`, \\\`"s"\\\`, \\\`"^"\\\`, \\\`"D"\\\`).
- Include descriptive alt text that states the key finding, not just "a bar chart." Example: "Bar chart showing Q4 revenue at $4.2M, 23% above Q3."
- Provide a data table alternative when sharing charts in reports or documents.
- **Test:** Does the chart convey its message in grayscale? Is all text readable at standard zoom (font size >= 10)? Print \\\`fig\\\` to grayscale: \\\`fig.savefig("test_bw.png", dpi=72); from PIL import Image; Image.open("test_bw.png").convert("L").save("test_bw.png")\\\`

---

## Gotchas

- **Truncated y-axis exaggerates differences** -- A bar chart starting at 95 instead of 0 makes a 2% difference look like a 10x gap. Always start bar charts at zero. For line charts, consider a broken axis if the range is extreme.
- **Sequential palettes hide categorical data** -- Using a gradient (light-to-dark) for unordered categories implies a ranking that doesn't exist. Use distinct hues for categorical, sequential shades for ordered/continuous. Quick rule: if the categories have no inherent order, use \\\`PALETTE_CATEGORICAL\\\`.
- **Legend order != data order** -- Matplotlib legend order matches plot call order, not the visual stack order in area/stacked charts. Fix: \\\`handles, labels = ax.get_legend_handles_labels(); ax.legend(handles[::-1], labels[::-1])\\\` or label directly on the chart.
- **savefig cuts off labels** -- Default \\\`plt.savefig()\\\` clips titles and axis labels. Always use \\\`bbox_inches="tight"\\\`. Full pattern: \\\`fig.savefig("chart.png", bbox_inches="tight", facecolor="white", dpi=150)\\\`.
- **Seaborn mutates global state** -- \\\`sns.set_theme()\\\` changes \\\`rcParams\\\` globally. Reset with \\\`plt.rcdefaults()\\\` after use, or scope changes with \\\`with plt.rc_context({...}):\\\`.
- **Number format inconsistency** -- Don't mix "1.2K" and "1,200" on the same chart. Pick one format and apply uniformly via \\\`FuncFormatter\\\`.
- **Overlapping labels** -- Long category names on bar charts: use horizontal bars (\\\`barh\\\`) or rotate labels (\\\`plt.xticks(rotation=45, ha="right")\\\`). For scatter plots, use \\\`adjustText\\\` library.
- **Too many colors** -- More than 5-6 colors in a single chart becomes unreadable. Group minor categories into "Other" or switch to small multiples.
- **Date axes crowd** -- Matplotlib auto-ticks dates poorly. Always set explicit locators: \\\`ax.xaxis.set_major_locator(mdates.MonthLocator())\\\` and formatters.
- **Tight layout fails with suptitle** -- \\\`plt.tight_layout()\\\` ignores \\\`fig.suptitle()\\\`. Use \\\`fig.subplots_adjust(top=0.92)\\\` to make room.

---

## Quality Checklist (run BEFORE sharing any chart)

- [ ] Title states the insight, not just the metric name
- [ ] Subtitle includes date range, source, or context
- [ ] Key data point highlighted with accent color; supporting data is muted
- [ ] Chart type matches the data question (see selection table)
- [ ] Bar charts start y-axis at zero
- [ ] Text is not clipped or overlapping (check long labels, rotated text)
- [ ] Legend does not overlap data (or labels are applied directly)
- [ ] All axis labels readable (font size >= 10)
- [ ] Number formatting is consistent across axes and annotations
- [ ] Colors have sufficient contrast against background (3:1 minimum between adjacent elements)
- [ ] Colorblind-safe palette used, or patterns/markers supplement color
- [ ] Chart works in grayscale (not relying on color alone)
- [ ] Saved with \\\`bbox_inches="tight"\\\`, \\\`facecolor="white"\\\`, and \\\`dpi=150\\\`
- [ ] Chart answers a specific question -- not just "here's some data"
- [ ] No more than 5-6 series per chart (use small multiples beyond that)
- [ ] Data sorted meaningfully (by value for ranking, by time for trends)`,
  },

  // ═══════════════════════════════════════════════════════════════
  // Document & Office Skills
  // ═══════════════════════════════════════════════════════════════

  {
    name: "pdf",
    description: "Create, read, extract, or fill PDF documents. Supports text extraction, table extraction, PDF generation, and form filling.",
    category: "office",
    version: "1.0.0",
    enabled: true,
    when_to_use: "When the user asks to create, read, extract text from, merge, split, fill forms in, or convert a PDF document.",
    min_plan: "standard",
    delegate_agent: "pdf-specialist",
    allowed_tools: ["python-exec", "bash", "read-file", "write-file"],
    prompt_template: `PDF task: {{ARGS}}

## When to Use Which Tool

| Task | Tool | Notes |
|------|------|-------|
| Create PDF from scratch | reportlab | \`pip install reportlab\` — primary creation tool |
| Read / merge / split / rotate / encrypt | pypdf | \`pip install pypdf\` |
| Extract text and tables | pdfplumber | \`pip install pdfplumber\` — best for structured extraction |
| Render pages to images | pypdfium2 | \`pip install pypdfium2\` |
| OCR scanned PDFs | pytesseract + pdf2image | \`pip install pytesseract pdf2image\` — convert to images, then OCR |
| Fill PDF forms | pypdf | Read field names first, then set values |
| CLI merge/split/encrypt/repair | qpdf | **Check availability first:** run \`which qpdf\` — may not be installed in sandbox |
| CLI text extraction | pdftotext | **Check availability first:** run \`which pdftotext\` — may not be installed |
| CLI image extraction | pdfimages | **Check availability first:** run \`which pdfimages\` — may not be installed |

**Form filling:** Before attempting to fill any PDF form, first extract all field names with pypdf (\`reader.get_fields()\`) to understand the form structure. Never guess field names.

## Design and Typography

**Design defaults:** See the /design skill for palette, fonts, PDF font pairings, chart colors, and core principles (1 accent + neutrals, no decorative imagery, accessibility).

**Typography:** PDFs embed any TTF font — use distinctive, professional fonts, not system defaults. Download from Google Fonts at runtime, register with ReportLab, and it embeds automatically. Default to a clean sans-serif (Inter, DM Sans, Work Sans). See /design skill for PDF Pairings table.

**CJK text:** Fonts like Inter and DM Sans only cover Latin glyphs. ReportLab has no automatic font fallback — unregistered scripts render as tofu. Register Noto Sans CJK for Chinese, Japanese, or Korean text.

## PDF Metadata

Always set metadata when creating PDFs:
- **Author** — set to the user's name or organization name (ask if unknown)
- **Title** — a descriptive name relevant to the document contents

Canvas API: \`c.setTitle(...)\`, \`c.setAuthor("...")\` right after creating the canvas.
SimpleDocTemplate: pass \`title=...\`, \`author="..."\` as constructor kwargs.

## Source Citations

Every PDF that includes information from web sources MUST have:
1. Numbered superscript footnote markers in body text (using \`<super>\` tags, never Unicode superscripts)
2. A numbered source list at the bottom of each page with clickable hyperlinked URLs

Each footnote entry must include the actual URL wrapped in an \`<a href>\` tag — never omit the URL or substitute a plain-text source name.

## Hyperlinks

All URLs in generated PDFs must be clickable. In ReportLab Paragraph objects, use \`<a href="..." color="blue">\` markup. On the canvas, use \`canvas.linkURL(url, rect)\`.

## Subscripts and Superscripts

**Never use Unicode subscript/superscript characters** in ReportLab PDFs. Built-in fonts lack these glyphs, rendering them as black boxes. Use \`<sub>\` and \`<super>\` XML tags in Paragraph objects. For canvas text, manually adjust font size and y-offset.

## Tips

**Text extraction:** \`pdftotext\` (if available) is the fastest option for plain text. Use pdfplumber when you need tables or coordinate data — don't use \`pypdf.extract_text()\` on large documents, it's slow.

**Image extraction:** \`pdfimages\` (if available) extracts embedded images directly and is much faster than rendering whole pages. Only render with pypdfium2 when you need a visual snapshot of the page layout.

**Large PDFs:** Process pages individually or in chunks rather than loading the entire document. Use \`qpdf --split-pages\` (if available) to break up very large files before processing.

**Encrypted PDFs:** Use \`pypdf\` to detect and decrypt (\`reader.is_encrypted\` / \`reader.decrypt(pw)\`). If you don't have the password, try \`qpdf --password=X --decrypt\`. Run \`qpdf --show-encryption\` to inspect what protection is applied.

**Corrupted PDFs:** Run \`qpdf --check\` to diagnose structural problems, then \`qpdf --replace-input\` to attempt repair.

**Text extraction fails:** If pdfplumber or pdftotext return empty/garbled text, the PDF is likely scanned images. Fall back to OCR:

\`\`\`python
import pytesseract
from pdf2image import convert_from_path

pages = convert_from_path("scan_output.pdf", dpi=300)
ocr_text = "\\n\\n".join(
    f"--- Page {n} ---\\n{pytesseract.image_to_string(pg)}"
    for n, pg in enumerate(pages, 1)
)
\`\`\`

## Visual QA (run BEFORE sharing any PDF)
After generating the PDF, verify:
- Check page count matches expectation
- Check file size is reasonable (< 10MB for text docs)
- Extract first page text with pdfplumber to verify content rendered
- For multi-page: spot-check a middle page for layout consistency
- For forms: verify field names match expected values`,
  },

  {
    name: "spreadsheet",
    description: "Create or analyze Excel spreadsheets with formulas, formatting, charts, and data analysis.",
    category: "office",
    version: "1.0.0",
    enabled: true,
    when_to_use: "When the user asks to create, edit, or analyze an Excel spreadsheet, .xlsx file, or asks for data in spreadsheet format with formatting.",
    min_plan: "standard",
    delegate_agent: "data-analyst",
    allowed_tools: ["python-exec", "bash", "read-file", "write-file"],
    prompt_template: `Spreadsheet task: {{ARGS}}

## Tool Decision Matrix

| Goal | Library | Why |
|------|---------|-----|
| Create workbook, add formulas, cell-level formatting | openpyxl | Native Excel objects, formulas stored as strings, full styling API |
| Analyze / transform / pivot data before writing | pandas | Vectorised ops, groupby, merge, pivot_table — reshape then hand off to openpyxl |
| High-volume write with complex formatting | xlsxwriter | Streaming writes, richer conditional-format API, but CANNOT read existing files |

Default: openpyxl for creation + formatting, pandas for data wrangling. Use xlsxwriter only when you need its unique formatting features AND are creating a new file from scratch.

\\\`\\\`\\\`python
# Standard imports
import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side, numbers
from openpyxl.utils import get_column_letter
from openpyxl.formatting.rule import CellIsRule, ColorScaleRule, DataBarRule, FormulaRule
from openpyxl.chart import BarChart, LineChart, PieChart, Reference
from openpyxl.worksheet.table import Table, TableStyleInfo
from openpyxl.worksheet.datavalidation import DataValidation
import pandas as pd
from datetime import datetime
\\\`\\\`\\\`

## Creation Workflow

1. **Understand requirements** — What data? How many sheets? Who is the audience? Print or screen?
2. **Design layout** — Sketch sheet structure: summary sheet first, detail sheets after. Decide column order, header rows, where charts go.
3. **Implement** — Write data and formulas. Every derived value MUST be an Excel formula, not a Python-computed constant. The spreadsheet must recalculate when inputs change.
4. **Format** — Apply number formats, fonts, colors, borders, column widths, row heights.
5. **Validate** — Check zero formula errors, print preview, data validation rules, freeze panes.

## Core Rules

1. **Zero formula errors** — every deliverable must have zero #REF!, #DIV/0!, #NAME?, #VALUE!, #NULL!, #N/A
2. **Formulas over hardcoded values** — every derived cell must be a formula, not a pasted number
3. **Never use \\\`data_only=True\\\` when saving** — opening with \\\`data_only=True\\\` replaces formula strings with cached values; use it only for reading computed results, never save afterwards
4. **openpyxl uses 1-based indexing** — row 1 / column A = (1, 1); DataFrame row N = Excel row N+1
5. **Preserve existing templates** — when modifying an existing file, study and exactly match its format, style, and conventions; never impose new formatting on files with established patterns

## Layout Standards

- Content starts at B2 (Row 1 and Column A are empty spacers)
- Column A width = 3 (gutter): \\\`ws.column_dimensions['A'].width = 3\\\`
- Row 1 height = small (spacer)
- Freeze panes below header row: \\\`ws.freeze_panes = f'A\\\${header_row + 1}'\\\`
- Use Excel Table objects (\\\`Table\\\` + \\\`TableStyleInfo\\\`) for structured data — provides auto-filter, banding, structured references
- Never set \\\`ws.auto_filter.ref\\\` on a range that is also an Excel Table (causes file corruption)
- For tables with >20 rows, enable auto-filter
- Pre-sort data by most meaningful dimension (rankings descending, time ascending, otherwise alphabetical)

## Cell Formatting Patterns

| Data Type | Format Code | Display Example |
|-----------|-------------|-----------------|
| Integer | \\\`#,##0\\\` | 1,234,567 |
| Decimal (1dp) | \\\`#,##0.0\\\` | 1,234.6 |
| Currency | \\\`$#,##0.00\\\` | $1,234.56 |
| Currency (millions) | \\\`$#,##0,,"M"\\\` | $1M |
| Percentage | \\\`0.0%\\\` | 12.3% |
| Date | \\\`YYYY-MM-DD\\\` | 2026-04-02 |
| Years | Format as TEXT string | "2026" not 2,026 |
| Negatives (financial) | \\\`$#,##0;($#,##0);"-"\\\` | ($1,234) |
| Valuation multiples | \\\`0.0"x"\\\` | 8.5x |

CRITICAL: Formula cells need \\\`number_format\\\` too — they display raw precision unless explicitly formatted.

\\\`\\\`\\\`python
# WRONG — formula displays 14.123456789
ws['C10'] = '=C7-C9'
# RIGHT — always set number_format for formula cells
ws['C10'] = '=C7-C9'
ws['C10'].number_format = '#,##0.0'
\\\`\\\`\\\`

### Alignment Rules
- Headers: center-aligned, bold
- Numbers: right-aligned
- Short text (status, codes): center-aligned
- Long text (descriptions): left-aligned with \\\`indent=1\\\`
- Dates: center-aligned

### Column Width
\\\`\\\`\\\`python
def auto_width(ws, col, min_w=12, max_w=50, pad=2):
    length = max((len(str(c.value)) for c in ws[get_column_letter(col)] if c.value), default=0)
    ws.column_dimensions[get_column_letter(col)].width = min(max(length + pad, min_w), max_w)
\\\`\\\`\\\`

### Standalone Text Rows (titles, notes)
Text extends into empty right-neighbour cells but is clipped if they contain content. Merge cells across content width for titles, subtitles, section headers, and disclaimers.

## Conditional Formatting

Always use rule-based conditional formatting — never loop through cells applying static PatternFill. Static fills do not update when values change and cannot be managed by the user in Excel.

### CellIsRule — threshold-based highlighting
\\\`\\\`\\\`python
from openpyxl.formatting.rule import CellIsRule
ws.conditional_formatting.add("C2:C100",
    CellIsRule(operator="greaterThan", formula=["0"],
              fill=PatternFill(bgColor="C6EFCE")))  # green
ws.conditional_formatting.add("C2:C100",
    CellIsRule(operator="lessThan", formula=["0"],
              fill=PatternFill(bgColor="FFC7CE")))  # red
\\\`\\\`\\\`

### Color Scales — heatmap effect for matrices
\\\`\\\`\\\`python
# Two-color: white to blue
rule = ColorScaleRule(
    start_type='min', start_color='FFFFFF',
    end_type='max', end_color='4472C4')
ws.conditional_formatting.add('D5:H20', rule)
# Three-color: red to yellow to green (performance data)
rule = ColorScaleRule(
    start_type='min', start_color='F8696B',
    mid_type='percentile', mid_value=50, mid_color='FFEB84',
    end_type='max', end_color='63BE7B')
ws.conditional_formatting.add('D5:H20', rule)
\\\`\\\`\\\`

### Data Bars — inline magnitude comparison
\\\`\\\`\\\`python
rule = DataBarRule(start_type='min', end_type='max', color='4472C4')
ws.conditional_formatting.add('C5:C50', rule)
\\\`\\\`\\\`

### Icon Sets — use FormulaRule with custom icons for KPI dashboards

| Feature | Best For |
|---------|----------|
| CellIsRule | Threshold highlighting (above/below target) |
| Color Scale (2-color) | Single metric distributions |
| Color Scale (3-color) | Good / neutral / bad interpretation |
| Data Bars | Quick magnitude comparison within a column |

## Chart Creation in Excel

Place charts below their data table with a 2-row gap, left-aligned with content. Charts must never overlap each other or tables.

| Chart Type | Use When |
|------------|----------|
| BarChart / BarChart3D | Comparing values across categories |
| LineChart | Time series, trends over time |
| PieChart | Part-to-whole composition (6 or fewer categories only) |
| AreaChart | Cumulative totals over time |
| ScatterChart | Correlation between two variables |

\\\`\\\`\\\`python
chart = BarChart()
chart.title = "Revenue by Region"
chart.style = 10
data = Reference(ws, min_col=2, min_row=header_row, max_row=last_row)
cats = Reference(ws, min_col=1, min_row=header_row + 1, max_row=last_row)
chart.add_data(data, titles_from_data=True)
chart.set_categories(cats)
chart.width = 15   # centimetres
chart.height = 7.5
ws.add_chart(chart, f"B\\\${last_row + 3}")
\\\`\\\`\\\`

### Preventing chart overlap
\\\`\\\`\\\`python
from math import ceil
rows_for_chart = ceil(chart.height * 2)  # ~2 rows per cm at default row height
next_content_row = chart_anchor_row + rows_for_chart + 2
\\\`\\\`\\\`

## Formula Patterns

### Live Excel formulas — always prefer over Python-computed constants
\\\`\\\`\\\`python
# Totals
ws['F20'] = '=SUM(F2:F19)'
# Percentage
ws['D5'] = '=(B5-C5)/B5'
ws['D5'].number_format = '0.0%'
# YoY growth
ws[f'E\\\${row}'] = f'=(\\\${current}-\\\${prior})/\\\${prior}'
# Ranking
ws[f'G\\\${row}'] = f'=RANK(C\\\${row},$C$2:$C$100,0)'
\\\`\\\`\\\`

### Structured Table References (when Tables exist)
When editing an existing file with Table objects (\\\`ws.tables\\\`), use structured references:
- \\\`=SUM(SalesData[Revenue])\\\` not \\\`=SUM(C2:C100)\\\`
- \\\`=VLOOKUP(A2,SalesData[#All],3,FALSE)\\\` for lookups

### VLOOKUP equivalents in Python (for data prep before writing)
\\\`\\\`\\\`python
# pandas merge = VLOOKUP
result = left_df.merge(right_df[['key', 'value']], on='key', how='left')
# Pivot table via pandas — then write result to Excel
pivot = df.pivot_table(values='Revenue', index='Region', columns='Quarter', aggfunc='sum')
\\\`\\\`\\\`

## Multi-Sheet Design

| Principle | Rule |
|-----------|------|
| Sheet order | Summary / Overview first, then supporting detail sheets (general to specific) |
| Sheet count | 3-5 ideal, max 7 |
| Naming | Descriptive (\\\`Revenue Data\\\`, not \\\`Sheet1\\\`) |
| Consistency | Same layout patterns, same starting positions, same formatting across sheets |
| Overview | Must stand alone — user understands the main message without opening other sheets |
| Navigation | For 3+ sheets, add a sheet index on Overview with hyperlinks |

\\\`\\\`\\\`python
# Cross-sheet hyperlink
from openpyxl.worksheet.hyperlink import Hyperlink
cell = ws.cell(row=6, column=2, value="Revenue Data")
cell.hyperlink = Hyperlink(ref=cell.coordinate, location="'Revenue Data'!A1")
cell.font = Font(color='0000FF', underline='single')
\\\`\\\`\\\`

## Print Layout

\\\`\\\`\\\`python
# Page setup
ws.page_setup.orientation = ws.ORIENTATION_LANDSCAPE
ws.page_setup.paperSize = ws.PAPERSIZE_A4
ws.page_setup.fitToWidth = 1
ws.page_setup.fitToHeight = 0  # as many pages tall as needed

# Print area
ws.print_area = f'A1:\\\${get_column_letter(last_col)}\\\${last_row}'

# Repeat header row on every printed page
ws.print_title_rows = f'1:\\\${header_row}'

# Headers and footers
ws.oddHeader.center.text = "Report Title"
ws.oddFooter.left.text = f"Generated: \\\${datetime.now().strftime('%Y-%m-%d')}"
ws.oddFooter.right.text = "Page &P of &N"

# Manual page break
from openpyxl.worksheet.pagebreak import Break
ws.row_breaks.append(Break(id=section_end_row))
\\\`\\\`\\\`

## Data Validation

\\\`\\\`\\\`python
# Dropdown list
dv = DataValidation(type="list", formula1='"Option A,Option B,Option C"', allow_blank=True)
dv.error = "Invalid selection"
dv.errorTitle = "Input Error"
dv.prompt = "Choose from the list"
dv.promptTitle = "Selection"
ws.add_data_validation(dv)
dv.add(f'D2:D\\\${last_row}')

# Numeric constraint (1-100)
dv_num = DataValidation(type="whole", operator="between", formula1="1", formula2="100")
dv_num.error = "Enter a number between 1 and 100"
ws.add_data_validation(dv_num)
dv_num.add(f'E2:E\\\${last_row}')

# Date constraint
dv_date = DataValidation(type="date", operator="greaterThan", formula1="2020-01-01")
ws.add_data_validation(dv_date)
dv_date.add(f'F2:F\\\${last_row}')
\\\`\\\`\\\`

## Performance: Large Files

### Reading large files
\\\`\\\`\\\`python
# openpyxl read_only mode — streams rows, low memory
wb = openpyxl.load_workbook('large.xlsx', read_only=True)
for row in ws.iter_rows(min_row=2, values_only=True):
    process(row)
wb.close()  # MUST close read_only workbooks

# pandas — read only needed columns
df = pd.read_excel('large.xlsx', usecols=['A', 'C', 'E'], dtype={'id': str})
\\\`\\\`\\\`

### Writing large files
\\\`\\\`\\\`python
# openpyxl write_only mode — streaming, never loads full sheet in memory
wb = openpyxl.Workbook(write_only=True)
ws = wb.create_sheet()
for chunk in data_chunks:
    for record in chunk:
        ws.append([record['a'], record['b'], record['c']])
wb.save('output.xlsx')
\\\`\\\`\\\`

Note: write_only mode does NOT support cell-level formatting, merged cells, or random access. If you need formatting, write data in write_only mode first, then reopen in normal mode to apply styles to header rows only.

## Financial Model Color Coding

| Color | Meaning |
|-------|---------|
| Blue text (#0000FF) | Hardcoded inputs / assumptions the user will change |
| Black text (#000000) | All formulas and calculations |
| Green text (#008000) | Links pulling from other worksheets in the same workbook |
| Red text (#FF0000) | External links to other files |
| Yellow background (#FFFF00) | Key assumptions needing attention |

## Common Gotchas

1. **Date serialization** — openpyxl stores Python \\\`datetime\\\` objects natively, but pandas may write dates as serial numbers. Always verify date columns render correctly; set \\\`number_format = 'YYYY-MM-DD'\\\` explicitly.
2. **Merged cells break iteration** — \\\`iter_rows()\\\` returns \\\`MergedCell\\\` objects with \\\`value=None\\\` for all but the top-left cell. Unmerge before processing data, or skip merged regions.
3. **Font availability** — Excel on the target machine must have the font installed. Stick to universally available fonts: Calibri, Arial, Times New Roman. Never assume custom fonts exist.
4. **\\\`data_only=True\\\` destroys formulas on save** — use only for reading cached values, never save.
5. **Auto-filter + Table conflict** — never set \\\`ws.auto_filter.ref\\\` on a Table range; Tables include their own filter automatically.
6. **Cell indices are 1-based** — DataFrame row 5 = Excel row 6. Off-by-one errors are the most common formula bug.
7. **String numbers** — Excel may auto-convert ZIP codes, IDs, and years to numbers. Write them as strings or set the column format to Text before writing.
8. **write_only limitations** — no cell styling, no merged cells, no random-access writes. Plan accordingly.
9. **Large formula arrays** — openpyxl does not evaluate formulas; if you need computed values for conditional logic during generation, compute in pandas first, then write the formula string for the user.

## Data Context — Every Dataset Needs Provenance

| Element | Location | Example |
|---------|----------|---------|
| Data source | Footer or notes row | "Source: Company 10-K, FY2025" |
| Time range | Subtitle near title | "Data from Jan 2023 - Dec 2025" |
| Generation date | Footer | "Generated: 2026-04-02" |
| Definitions | Notes section | "Revenue = Net sales excluding returns" |

## Quality Checklist (verify before delivering)

- [ ] **Data accuracy** — spot-check 3-5 values against source data
- [ ] **Zero formula errors** — no #REF!, #DIV/0!, #VALUE!, #N/A, #NAME?, #NULL!
- [ ] **Formatting consistency** — same number format for same data type across all sheets
- [ ] **Column widths** — no truncated text, no excessively wide empty columns
- [ ] **Print preview** — content fits page, headers repeat, no orphan rows
- [ ] **Formula validation** — test with edge cases (zero, negative, blank)
- [ ] **Cross-sheet references** — all links resolve, no broken sheet names
- [ ] **Data validation rules** — dropdowns work, constraints reject invalid input
- [ ] **Chart accuracy** — data ranges correct, labels readable, no overlapping elements
- [ ] **File opens cleanly** — open in Excel / LibreOffice to verify no corruption warnings`,
  },

  // ═══════════════════════════════════════════════════════════════
  // Code & Data Analysis Skills
  // ═══════════════════════════════════════════════════════════════

  {
    name: "analyze",
    description: "Analyze data files (CSV, JSON, Excel) — clean, summarize, find patterns, and generate insights.",
    when_to_use: "When the user provides or references data and asks for analysis, insights, trends, patterns, statistics, or summaries.",
    category: "data",
    version: "1.0.0",
    enabled: true,
    min_plan: "standard",
    delegate_agent: "data-analyst",
    allowed_tools: ["python-exec", "read-file", "write-file", "bash"],
    prompt_template: `Data analysis task: {{ARGS}}

## Six-Phase Analysis Protocol

Follow these phases in order. Show your work at every step -- print actual values, not just descriptions. The user should be able to audit your reasoning.

---

### Phase 1: INGEST -- Load and Understand the Data

\\\`\\\`\\\`python
import pandas as pd
import numpy as np
from pathlib import Path

# Detect format and load
def load_data(path):
    p = Path(path)
    ext = p.suffix.lower()
    loaders = {
        ".csv": lambda: pd.read_csv(p, encoding="utf-8-sig"),  # handles BOM
        ".tsv": lambda: pd.read_csv(p, sep="\\t", encoding="utf-8-sig"),
        ".json": lambda: pd.read_json(p),
        ".jsonl": lambda: pd.read_json(p, lines=True),
        ".xlsx": lambda: pd.read_excel(p, engine="openpyxl"),
        ".xls": lambda: pd.read_excel(p, engine="xlrd"),
        ".parquet": lambda: pd.read_parquet(p),
        ".feather": lambda: pd.read_feather(p),
    }
    if ext not in loaders:
        return pd.read_csv(p)  # CSV fallback
    return loaders[ext]()

df = load_data("data.csv")
\\\`\\\`\\\`

**Immediately print:**
- Shape: \\\`df.shape\\\`
- Column names and dtypes: \\\`df.dtypes\\\`
- First 5 rows: \\\`df.head()\\\`
- Null counts: \\\`df.isnull().sum()\\\`
- Identify the **grain** (what does each row represent?) and state it explicitly

**Encoding issues:** If garbled characters appear, retry with \\\`encoding="latin-1"\\\` or \\\`encoding="cp1252"\\\`. For mixed encodings, use \\\`errors="replace"\\\`.

---

### Phase 2: PROFILE -- Statistical Overview

\\\`\\\`\\\`python
# Numeric columns
print(df.describe().T[["count", "mean", "std", "min", "25%", "50%", "75%", "max"]])

# Categorical columns
for col in df.select_dtypes(include=["object", "category"]).columns:
    vc = df[col].value_counts()
    print(f"\\n{col}: {df[col].nunique()} unique values, top 5:")
    print(vc.head())

# Cardinality summary
print("\\nCardinality:")
for col in df.columns:
    n = df[col].nunique()
    print(f"  {col}: {n} unique / {len(df)} rows ({n/len(df)*100:.1f}%)")

# Memory usage
print(f"\\nMemory: {df.memory_usage(deep=True).sum() / 1e6:.1f} MB")
\\\`\\\`\\\`

**Report:** Shape, dtypes, null percentages, basic stats (mean/median/std/min/max) for numerics, top values and cardinality for categoricals.

---

### Phase 3: CLEAN -- Prepare Data for Analysis

**Missing value strategy decision table:**

| Pattern | Strategy | When to use |
|---------|----------|-------------|
| < 5% missing, random | Drop rows | Small dataset, plenty of rows |
| < 5% missing, random | Fill with median (numeric) / mode (categorical) | Need to preserve row count |
| Systematic missing (e.g., optional field) | Keep as-is or create indicator column | Missingness is informative |
| > 30% missing | Drop column or flag for investigation | Column may be unreliable |
| Time series gaps | Interpolate (linear/ffill) | Temporal continuity matters |

\\\`\\\`\\\`python
# Normalize column names
df.columns = df.columns.str.strip().str.lower().str.replace(r"[\\s/\\-]+", "_", regex=True)

# Fix dtypes
for col in df.columns:
    if df[col].dtype == "object":
        try:
            df[col] = pd.to_datetime(df[col], infer_datetime_format=True)
            continue
        except (ValueError, TypeError):
            pass
    if df[col].dtype == "object":
        cleaned = df[col].astype(str).str.replace(r"[\\$,%]", "", regex=True).str.strip()
        try:
            df[col] = pd.to_numeric(cleaned)
        except (ValueError, TypeError):
            pass

# Deduplicate
n_dupes = df.duplicated().sum()
if n_dupes > 0:
    print(f"Removing {n_dupes} duplicate rows")
    df = df.drop_duplicates()

# Outlier detection (IQR method)
def detect_outliers_iqr(series):
    Q1, Q3 = series.quantile(0.25), series.quantile(0.75)
    IQR = Q3 - Q1
    return ((series < Q1 - 1.5 * IQR) | (series > Q3 + 1.5 * IQR)).sum()

for col in df.select_dtypes(include="number").columns:
    n_outliers = detect_outliers_iqr(df[col])
    if n_outliers > 0:
        print(f"  {col}: {n_outliers} outliers (IQR method)")
\\\`\\\`\\\`

**Document every cleaning decision.** State what you changed and why. Never silently drop data.

---

### Phase 4: ANALYZE -- Extract Patterns and Insights

\\\`\\\`\\\`python
# Distribution analysis
for col in df.select_dtypes(include="number").columns:
    skew = df[col].skew()
    kurt = df[col].kurtosis()
    print(f"{col}: skew={skew:.2f}, kurtosis={kurt:.2f}")

# Correlation matrix (numeric columns)
corr = df.select_dtypes(include="number").corr()
# Flag strong correlations (|r| > 0.7)
strong = corr.where(np.triu(np.ones(corr.shape), k=1).astype(bool))
strong = strong.stack().reset_index()
strong.columns = ["var1", "var2", "corr"]
print(strong[strong["corr"].abs() > 0.7].sort_values("corr", ascending=False))

# Group-by aggregations (adapt to the specific question)
# df.groupby("category")["revenue"].agg(["mean", "median", "sum", "count"])

# Time series decomposition (if temporal data detected)
# from statsmodels.tsa.seasonal import seasonal_decompose
# result = seasonal_decompose(ts, model="additive", period=12)

# Statistical tests where appropriate
# - t-test for comparing two group means
# - chi-squared for categorical independence
# - Mann-Whitney U for non-normal distributions
# from scipy import stats
# stat, p = stats.ttest_ind(group_a, group_b)
\\\`\\\`\\\`

**For every finding, answer: "So what?"** Don't just report that two variables correlate -- explain what it means for the user's question.

---

### Phase 5: VISUALIZE -- Tell the Story with Charts

Generate 3-5 key visualizations. Reference the /chart skill for full chart selection table, palettes, and design principles.

**Auto-select chart types per finding:**

| Finding type | Chart |
|-------------|-------|
| Top/bottom ranking | Horizontal bar (sorted) |
| Trend over time | Line with optional confidence band |
| Distribution shape | Histogram or KDE |
| Group comparison | Grouped bar or box plot |
| Correlation | Scatter with regression line |
| Composition | Stacked bar or treemap |

\\\`\\\`\\\`python
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import seaborn as sns

plt.style.use("seaborn-v0_8-whitegrid")
plt.rcParams.update({
    "figure.figsize": (10, 6), "figure.dpi": 150,
    "axes.spines.top": False, "axes.spines.right": False,
})
PALETTE = ["#20808D", "#A84B2F", "#1B474D", "#BCE2E7", "#944454", "#FFC553"]

# Every chart title states the INSIGHT, not the metric:
# GOOD: "Revenue grew 23% YoY driven by enterprise segment"
# BAD:  "Revenue by Quarter"

fig.savefig("chart_name.png", bbox_inches="tight", facecolor="white", dpi=150)
\\\`\\\`\\\`

---

### Phase 6: SYNTHESIZE -- Deliver Actionable Findings

Present findings in this structure:

**Executive Summary** (2-3 sentences -- the headline the user needs first)

**Key Insights** (ranked by impact, not by discovery order):
1. Insight with exact numbers and context
2. Insight with exact numbers and context
3. ...

**Limitations and Caveats:**
- Sample size considerations
- Missing data impact
- Assumptions made during cleaning
- Potential confounders or biases

**Recommended Next Steps:**
- Specific, actionable recommendations based on findings
- What additional data would strengthen the analysis
- Suggested follow-up analyses

---

## Anti-Patterns (never do these)

- **Don't analyze without cleaning.** Raw data has encoding issues, mixed types, and nulls that corrupt stats.
- **Don't claim causation from correlation.** "X correlates with Y" is not "X causes Y." State the relationship precisely.
- **Don't ignore outliers without explanation.** Either explain why they're excluded or analyze their impact.
- **Don't present raw p-values without context.** State the test, the null hypothesis, and the practical significance -- not just "p < 0.05."
- **Don't generate charts without insights.** Every chart must have a title that states a finding. No "Figure 1: Data."
- **Don't skip the grain check.** If you don't know what each row represents, you will aggregate incorrectly.

---

## Quality Checklist

- [ ] Grain identified and stated explicitly
- [ ] All cleaning decisions documented (what changed, why)
- [ ] No silent data drops -- row counts reported before/after each cleaning step
- [ ] Summary statistics computed and reviewed before analysis
- [ ] Insights answer "so what?" -- not just "here is a number"
- [ ] All charts saved as PNG with insight-stating titles
- [ ] Executive summary leads with the most important finding
- [ ] Limitations and caveats stated honestly
- [ ] Recommendations are specific and actionable
- [ ] Numbers are exact (not rounded to meaninglessness) with appropriate precision`,
  },

  // ═══════════════════════════════════════════════════════════════
  // Website & App Building Skills
  // ═══════════════════════════════════════════════════════════════

  {
    name: "website",
    description: "Build a complete website or web app — design, code, and test. Covers landing pages, portfolios, web apps, and browser games.",
    category: "development",
    version: "1.0.0",
    enabled: true,
    when_to_use: "When the user asks to build a website, web app, landing page, portfolio site, or any web-based project.",
    allowed_tools: ["bash", "read-file", "write-file", "edit-file", "grep", "glob", "web-search", "python-exec"],
    prompt_template: `Build a website: {{ARGS}}

Build distinctive, production-grade websites that avoid generic "AI slop" aesthetics. Every choice — type, color, motion, layout — must be intentional.

## Project Type Routing

**Step 1: Identify project type:**

| Project Type | Approach | Examples |
|---|---|---|
| Informational sites | Static HTML/CSS/JS or Vite + React | Personal sites, portfolios, editorial/blogs, small business, landing pages |
| Web applications | Vite + React + state management | SaaS products, dashboards, admin panels, e-commerce |
| Browser games | HTML5 Canvas or Three.js + WebGL | 2D Canvas games, 3D experiences (see /game skill) |

If the user says just "website" or "site" with no detail, ask what type or default to informational.

## Workflow

### Step 1: Art Direction — Infer Before You Ask, Ask Before You Default

Every site should have a visual identity derived from its content. **Do not skip to the default palette.** It is a last resort.

1. **Infer from the subject.** A coffee roaster site -> earthy browns, warm cream. A fintech dashboard -> cool slate, sharp sans-serif, data-dense. The content tells you the palette, typography, and spacing before the user says a word.
2. **Derive the five pillars:** Color (warm/cool, accent from subject), Typography (serif/sans, display personality), Spacing (dense/generous), Motion (minimal/expressive), Imagery (photo/illustration/type-only).
3. **If the subject is genuinely ambiguous, ask** — "What mood are you going for?" and "Any reference sites?" One question is enough.
4. **Default fallback — only when inference AND asking yield nothing.** Use the Nexus palette from the /design skill: neutral surfaces + one teal accent for CTAs only. Typography: Satoshi or General Sans body (Fontshare), or Inter/DM Sans.

### Step 2: Version Control

Run \`git init\` in the project directory after scaffolding. Commit after each major milestone.

### Step 3: Build

- **Stack**: Vite + React + Tailwind CSS (or plain HTML/CSS for simple sites)
- **Type scale**: Hero 48-128px, Page Title 24-36px, Section heading 18-24px, Body 16-18px, Captions 12-14px
- **Fonts**: Load distinctive fonts via CDN. **Prefer Fontshare** (less overexposed) over Google Fonts. System fonts are fallback only — never the chosen font for web projects. See /design skill for font pairings and blacklist.
- **Responsive**: Mobile-first, test at 375px / 768px / 1440px
- **Performance targets**: LCP < 1.5s, page weight < 800KB
- **SEO**: Semantic HTML, one H1 per page, meta description, Open Graph tags
- **Accessibility**: Reading order = visual order, lang attribute, alt text on images, WCAG AA contrast, 44x44px touch targets

### Step 4: Multi-page Layout
For editorial/informational sites:
- Asymmetric two-column, feature grid, sidebar + main
- Pull quotes, photo grids, full-bleed sections for visual rhythm
- Mobile: stack to single column, maintain hierarchy

### Step 5: Test & Publish

- Check all links work
- Verify responsive at 3 breakpoints
- Run \`npx vite build\` to verify clean production build
- Serve locally with \`npx vite preview\` or deploy via bash (e.g., \`npx wrangler pages deploy dist\`, \`npx netlify deploy --prod\`, or similar)

## Use Every Tool

- **Research first.** Search the web for reference sites, trends, and competitor examples before designing. Browse award-winning examples of the specific site type. Fetch any URLs the user provides.
- **Generate real assets — generously.** Generate images for heroes, section illustrations, editorial visuals, atmospheric backgrounds — not just one hero image. Every long page should have visual rhythm. No placeholders. Generate a custom SVG logo for every project (see below).
- **Screenshot for QA.** For multi-page sites and web apps, take screenshots at desktop (1280px+) and mobile (375px) to verify quality. Skip for simple single-page static sites.
- **Write production code directly.** HTML, CSS, JS, SVG. Use bash for build tools and file processing.

## SVG Logo Generation

Every project gets a custom inline SVG logo. Never substitute a styled text heading.

1. **Understand the brand** — purpose, tone, one defining word
2. **Write SVG directly** — geometric shapes, letterforms, or abstract marks. One memorable shape.
3. **Principles:** Geometric/minimal. Works at 24px and 200px. Monochrome first — add color as enhancement. Use \`currentColor\` for dark/light mode.
4. **Implement inline** with \`aria-label\`, \`viewBox\`, \`fill="none"\`, \`currentColor\` strokes
5. **Generate a favicon** — simplified 32x32 version

## Anti-AI-Slop Checklist (mandatory)

Reject these patterns — they instantly mark output as AI-generated:
- NO gradient backgrounds on shapes or sections
- NO colored side borders on cards (the AI hallmark)
- NO accent lines or decorative bars under headings
- NO decorative icons unless the user explicitly asked for them
- NO generic filler phrases ("Empowering your journey", "Unlock your potential", "Seamless experience")
- NO more than 1 accent color — "earn every color" (each non-neutral must answer: what does this help the viewer understand?)
- NO pure white (#fff) or pure black (#000) — use warm neutrals (e.g., #F7F6F2 bg, #28251D text)
- NO overused fonts: Roboto, Arial, Poppins, Montserrat, Open Sans, Lato as primary web fonts
- NO stock photo placeholders — generate or source real visuals
- NO decoration that doesn't encode meaning

RULES:
- Every site gets a favicon (inline SVG converted to ICO or use emoji)
- No placeholder text — write real copy relevant to the subject
- Images: use Unsplash/Pexels URLs for stock, generate SVG illustrations for icons
- Dark mode: include if the site's audience expects it (tech, developer, creative)
- Visual foundations (color, type, charts): reference the /design skill`,
  },

  {
    name: "game",
    description: "Build a browser game — 2D Canvas or 3D WebGL with Three.js. Covers game loop, physics, input, audio, and deployment.",
    category: "development",
    version: "1.0.0",
    enabled: true,
    when_to_use: "When the user asks to build a browser game, 2D game, 3D game, or interactive game experience.",
    allowed_tools: ["bash", "read-file", "write-file", "edit-file", "grep", "glob", "web-search", "python-exec"],
    prompt_template: `Build a browser game: {{ARGS}}

---

## Container Environment Constraints

Games run inside a CF Container (not an iframe sandbox). Code is served via Vite dev server or static build. Understand what works and what is restricted.

### What Works
- **JavaScript, HTML5 Canvas, WebGL 2** -- fully functional
- **WebAssembly** -- works when loaded from CDN (e.g., Rapier via esm.sh)
- **Web Audio API** -- works, but AudioContext requires a user gesture (click/tap) to start
- **\\\`<img>\\\`, \\\`<video>\\\`, \\\`<audio>\\\` HTML elements** -- load binary files correctly
- **CDN imports** -- \\\`fetch()\\\` to external CDN URLs (esm.sh, jsdelivr, unpkg, gstatic) works
- **Keyboard, mouse, touch, gamepad events** -- all standard DOM events work
- **Pointer Lock API** -- works in containers (unlike iframe sandboxes)
- **Fullscreen API** -- works in containers

### What Is Restricted
- **localStorage / sessionStorage / IndexedDB** -- may be cleared between sessions. Use in-memory state for game saves; treat persistence as optional.
- **\\\`alert()\\\` / \\\`confirm()\\\` / \\\`prompt()\\\`** -- avoid. Use in-game UI overlays instead.
- **WebGPU** -- not reliably supported. Use WebGL 2 as the default renderer.
- **Large binary fetches from origin** -- for models/audio/WASM over 5MB, prefer CDN URLs to avoid slow container I/O.

### Asset Loading Strategy
- **3D models, textures, audio, WASM** -- load from external CDN URLs (Poly Pizza, Kenney, ambientCG, esm.sh)
- **HTML, CSS, JS, JSON, small images** -- serve locally via Vite
- **Generated images** (from \\\`image-generate\\\` tool) -- deployed alongside the site as local files. Use \\\`<img>\\\` elements to display, or for Three.js textures set \\\`crossOrigin = "anonymous"\\\` before \\\`src\\\`

---

## Art Direction

Before writing code, establish a cohesive art direction. Every visual decision -- palette, lighting, asset style, UI treatment -- flows from this.

### Art Direction Workflow

1. **Analyze the game concept**: A horror game demands dark palettes, fog, desaturated textures. A kids' puzzle game calls for bright primaries and rounded shapes. A sci-fi shooter needs neon accents, metallic materials, volumetric lighting.
2. **Pick a visual style**: Low-poly stylized, realistic PBR, pixel-art-inspired 3D, cel-shaded, voxel, neon/synthwave, hand-painted. Commit to one.
3. **Define a color palette**: 3-5 core colors. One dominant, one accent, neutrals. Reference the /design skill for palette generation. Apply consistently to environment, UI, and particles.
4. **Match lighting to mood**: Warm directional for adventure, cold blue ambient for horror, high-contrast rim lighting for action.
5. **UI must match the game world**: Menu screens, HUD, loading, and game-over states share the same palette and typographic style.

### Game Art Generation

Use the \\\`image-generate\\\` tool to create custom art. Do NOT use placeholder rectangles -- generate real art that matches the art direction.

**Always generate:**
- **Title screen / splash image** -- hero image establishing the game's visual identity
- **Loading screen background** -- themed art shown during asset loading
- **Game-over / victory screen art** -- emotional payoff images

**Generate when appropriate:**
- Skybox/environment concept art (reference for 3D scene)
- Character/enemy concept art (texture reference or 2D sprite overlays)
- UI background textures or patterns

**Prompting tips:**
- Be specific about style: "low-poly isometric forest scene with warm sunset lighting, stylized"
- Include mood: "dark cyberpunk alley, neon reflections on wet pavement, moody"
- Specify aspect ratio: 16:9 for backgrounds, 1:1 for icons
- Reference the established art direction in every prompt for consistency

---

## Game UI Typography

**Two fonts max.** One display font for titles/game-over. One legible sans-serif for HUD/menus. Load from Google Fonts or Fontshare.

### Font-to-Genre Matching

| Genre | Display Font | HUD/Body Font |
|---|---|---|
| Fantasy/RPG | Serif (Cormorant, Playfair, Erode) | Sans (Satoshi, General Sans) |
| Sci-fi/Cyber | Geometric/mono (Cabinet Grotesk, JetBrains Mono) | Technical sans (Inter, Geist) |
| Horror | High-contrast serif (Boska, Instrument Serif) | Neutral sans (Switzer, Inter) |
| Casual/Puzzle | Rounded sans (Plus Jakarta Sans, Chillax) | Same family lighter |
| Retro/Pixel | Mono (Azeret Mono, Fira Code) | Same family |

### HUD Number Formatting
- Use \\\`font-variant-numeric: tabular-nums lining-nums\\\` so digits don't shift
- Clean sans at 14-16px
- Minimum sizes: 12px labels, 14px buttons, 16px dialog text, 24px+ display
- Never use Papyrus, Comic Sans, Impact, Lobster, Roboto, Arial, Poppins as game fonts

### Text Rendering

Game UI is HTML/CSS overlaid on the canvas:

\\\`\\\`\\\`css
.game-ui { position: fixed; inset: 0; pointer-events: none; z-index: 10; font-family: var(--font-body); color: var(--color-text); }
.game-ui button, .game-ui [data-interactive] { pointer-events: auto; }
.hud-value { font-variant-numeric: tabular-nums lining-nums; font-size: 14px; font-weight: 600; }
.game-title { font-family: var(--font-display); font-size: clamp(2rem, 6vw, 4rem); line-height: 1.1; }
\\\`\\\`\\\`

For in-world 3D text (damage numbers, name tags), use \\\`THREE.CanvasTexture\\\` with a hidden 2D canvas drawing the same CSS-loaded font.

**Contrast safety:** Text on dynamic 3D/2D scenes must have a background treatment -- semi-transparent panel, text shadow, or dark vignette. Minimum: \\\`text-shadow: 0 1px 3px rgba(0,0,0,0.7), 0 0 8px rgba(0,0,0,0.3)\\\`.

---

## Game Design System

Define CSS custom properties for consistent UI:

\\\`\\\`\\\`css
:root {
  --font-display: 'Cabinet Grotesk', sans-serif;
  --font-body: 'Satoshi', sans-serif;
  --color-bg: #0a0a0f;
  --color-surface: rgba(255,255,255,0.05);
  --color-border: rgba(255,255,255,0.12);
  --color-text: #e8e8ec;
  --color-text-muted: #8888a0;
  --color-primary: #4af0c0;
  --color-danger: #ff4466;
  --color-warning: #ffaa22;
  --panel-blur: 12px;
  --panel-radius: 8px;
  --transition-ui: 180ms cubic-bezier(0.16, 1, 0.3, 1);
}
.game-panel {
  background: var(--color-surface);
  backdrop-filter: blur(var(--panel-blur));
  border: 1px solid var(--color-border);
  border-radius: var(--panel-radius);
  padding: 16px;
}
\\\`\\\`\\\`

Adapt tokens to match the game's art direction (warm for adventure, cold for sci-fi, dark for horror).

---

## Architecture Decision

### 2D Game (Canvas API)
- Use for: platformers, puzzle games, card games, retro-style, top-down shooters
- Stack: HTML5 Canvas, vanilla JS or lightweight framework
- Physics: AABB/circle collision, spatial partitioning (grid or quadtree) for many entities

**2D Canvas patterns:**

\\\`\\\`\\\`javascript
// ---- Game loop with fixed timestep ----
const TICK_RATE = 1/60;
let accumulator = 0, lastTime = 0;

function gameLoop(timestamp) {
  const dt = Math.min((timestamp - lastTime) / 1000, 0.1); // cap delta to prevent spiral
  lastTime = timestamp;
  accumulator += dt;
  while (accumulator >= TICK_RATE) {
    update(TICK_RATE);
    accumulator -= TICK_RATE;
  }
  render();
  requestAnimationFrame(gameLoop);
}
requestAnimationFrame(gameLoop);

// ---- Sprite management with object pooling ----
class SpritePool {
  constructor(size) {
    this.pool = new Array(size).fill(null).map(() => ({ active: false, x: 0, y: 0, vx: 0, vy: 0, w: 0, h: 0 }));
  }
  acquire() {
    const obj = this.pool.find(o => !o.active);
    if (obj) obj.active = true;
    return obj;
  }
  release(obj) { obj.active = false; }
  forEach(fn) { this.pool.forEach(o => o.active && fn(o)); }
}

// ---- AABB collision detection ----
function aabbCollision(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

// ---- Spatial hash grid (for many entities) ----
class SpatialGrid {
  constructor(cellSize) {
    this.cellSize = cellSize;
    this.cells = new Map();
  }
  clear() { this.cells.clear(); }
  _key(x, y) {
    return Math.floor(x / this.cellSize) + "," + Math.floor(y / this.cellSize);
  }
  insert(entity) {
    const key = this._key(entity.x, entity.y);
    if (!this.cells.has(key)) this.cells.set(key, []);
    this.cells.get(key).push(entity);
  }
  query(x, y, radius) {
    const results = [];
    const r = Math.ceil(radius / this.cellSize);
    const cx = Math.floor(x / this.cellSize), cy = Math.floor(y / this.cellSize);
    for (let dx = -r; dx <= r; dx++)
      for (let dy = -r; dy <= r; dy++) {
        const cell = this.cells.get((cx+dx) + "," + (cy+dy));
        if (cell) results.push(...cell);
      }
    return results;
  }
}

// ---- 2D Canvas text (load fonts via CSS first, wait for document.fonts.ready) ----
ctx.font = '600 14px Satoshi, sans-serif';
ctx.fillStyle = '#e8e8ec';
ctx.fillText("Score: " + score, 16, 16);
\\\`\\\`\\\`

### 3D Game (Three.js + WebGL 2)
- Use for: 3D environments, racing, FPS, exploration, flight sims
- Stack: Three.js, Rapier physics (via CDN), Zustand for UI state (no persist middleware)
- Assets from CDN: Poly Pizza, Kenney, Quaternius (all CC0/CC-BY)

**3D Three.js patterns:**

\\\`\\\`\\\`javascript
import * as THREE from 'three';

// ---- Renderer setup ----
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); // cap at 2
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.body.appendChild(renderer.domElement);

// ---- Scene + camera ----
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 1000);

// ---- Fixed timestep game loop ----
const clock = new THREE.Clock();
const FIXED_TIMESTEP = 1/60;
let accumulator = 0;

function gameLoop() {
  requestAnimationFrame(gameLoop);
  const delta = Math.min(clock.getDelta(), 0.1);
  accumulator += delta;
  while (accumulator >= FIXED_TIMESTEP) {
    updatePhysics(FIXED_TIMESTEP);
    updateGameLogic(FIXED_TIMESTEP);
    accumulator -= FIXED_TIMESTEP;
  }
  updateAnimations(delta);
  renderer.render(scene, camera); // or composer.render() for post-processing
}
requestAnimationFrame(gameLoop);

// ---- Physics with Rapier ----
import RAPIER from '@dimforge/rapier3d-compat';
await RAPIER.init();
const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });

// Static ground
const groundBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
world.createCollider(RAPIER.ColliderDesc.cuboid(50, 0.1, 50), groundBody);

// Dynamic body
const playerBody = world.createRigidBody(
  RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 5, 0)
);
world.createCollider(RAPIER.ColliderDesc.capsule(0.5, 0.3), playerBody);

function updatePhysics(dt) {
  world.step();
  const pos = playerBody.translation();
  const rot = playerBody.rotation();
  playerMesh.position.set(pos.x, pos.y, pos.z);
  playerMesh.quaternion.set(rot.x, rot.y, rot.z, rot.w);
}

// ---- Asset loading (always from CDN for binaries) ----
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';

const draco = new DRACOLoader();
draco.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/');
const loader = new GLTFLoader();
loader.setDRACOLoader(draco);

loader.load('https://cdn.example.com/model.glb', (gltf) => {
  scene.add(gltf.scene);
  if (gltf.animations.length) {
    const mixer = new THREE.AnimationMixer(gltf.scene);
    gltf.animations.forEach(clip => mixer.clipAction(clip).play());
  }
});

// ---- Post-processing ----
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
composer.addPass(new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.5, 0.4, 0.85));
\\\`\\\`\\\`

**Input handling (works in containers):**

\\\`\\\`\\\`javascript
// Keyboard state map
const keys = {};
window.addEventListener('keydown', e => keys[e.code] = true);
window.addEventListener('keyup', e => keys[e.code] = false);

// Mouse with pointer lock (available in containers)
renderer.domElement.addEventListener('click', () => renderer.domElement.requestPointerLock());
document.addEventListener('mousemove', (e) => {
  if (document.pointerLockElement === renderer.domElement) {
    camera.rotation.y -= e.movementX * 0.002;
    camera.rotation.x -= e.movementY * 0.002;
    camera.rotation.x = Math.max(-Math.PI/2, Math.min(Math.PI/2, camera.rotation.x));
  }
});

// Fallback for no pointer lock (click-drag)
renderer.domElement.addEventListener('mousemove', (e) => {
  if (e.buttons === 1) {
    camera.rotation.y -= e.movementX * 0.002;
    camera.rotation.x -= e.movementY * 0.002;
  }
});
\\\`\\\`\\\`

---

## Music and Sound

Every game must include music and sound. Audio requires a user gesture to start -- show a "Click to Play" screen.

\\\`\\\`\\\`javascript
// Music via <audio> element
function startMusic() {
  const audio = document.createElement('audio');
  audio.src = 'https://cdn.example.com/bgm.mp3'; // CDN URL
  audio.loop = true;
  audio.volume = 0.4;
  audio.play();
  return audio;
}

// Procedural SFX via Web Audio API
const audioCtx = new AudioContext();
function playSFX(freq = 440, duration = 0.1, type = 'square') {
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.3, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start();
  osc.stop(audioCtx.currentTime + duration);
}

// Start on user interaction
document.addEventListener('click', () => {
  audioCtx.resume();
  startMusic();
}, { once: true });
\\\`\\\`\\\`

Music sources: Pixabay Music (royalty-free, no attribution), Freesound (CC0/CC-BY), Incompetech (CC-BY 3.0), OpenGameArt.

---

## Required Game Features

1. **Title screen** with start button and generated splash art
2. **HUD**: Score, lives/health, timer (if applicable) -- tabular-nums, contrast-safe
3. **Pause menu** (Escape key) with resume/restart/mute
4. **Game over screen** with final score, generated art, and restart button
5. **Sound effects**: Web Audio API for all interactions (jump, collect, hit, win, lose)
6. **Background music**: Looping, with volume control and mute toggle
7. **Debug overlay**: FPS, frame time, draw calls (3D), entity count -- toggle with backtick key

---

## Performance Checklist

- [ ] Game loop uses \\\`requestAnimationFrame\\\` with fixed timestep (never \\\`setInterval\\\`)
- [ ] Delta time capped at 0.1s to prevent spiral of death
- [ ] Object pooling for bullets, particles, enemies (no \\\`new\\\` in hot loop)
- [ ] Spatial partitioning (grid/quadtree for 2D, octree for 3D) when entity count > 50
- [ ] \\\`devicePixelRatio\\\` capped at 2 (3D)
- [ ] InstancedMesh for repeated objects (trees, rocks, particles) in 3D
- [ ] LOD (\\\`THREE.LOD\\\`) for geometry detail by camera distance
- [ ] Draw calls < 200 (3D) -- check via \\\`renderer.info.render.calls\\\`
- [ ] Textures at 1K-2K max, KTX2/Basis Universal preferred
- [ ] No memory leaks -- dispose Three.js geometries/materials/textures on scene change
- [ ] Event listeners cleaned up on game restart
- [ ] Stable 55+ FPS average, 30+ FPS 1% low

---

## Testing and QA

**Play-test at every major milestone.** Don't build the entire game then test -- iterate.

### Milestone Testing Schedule
1. **After game loop + basic rendering** -- verify smooth 60fps, no visual glitches
2. **After player controls** -- verify all inputs feel responsive (keyboard, mouse, touch)
3. **After core mechanic** -- verify the game is fun (the most important test)
4. **After enemies/obstacles** -- verify collision detection, difficulty curve
5. **After UI (HUD, menus)** -- verify contrast, readability, all buttons work
6. **After audio** -- verify SFX trigger correctly, music loops, volume controls work
7. **Before shipping** -- full playthrough, check for soft-locks, verify game-over and restart

### Debug Overlay (required)

\\\`\\\`\\\`javascript
// Toggle with backtick key
let debugVisible = false;
const debugEl = document.createElement('div');
debugEl.style.cssText = 'position:fixed;top:8px;left:8px;color:#0f0;font:12px monospace;z-index:999;display:none;background:rgba(0,0,0,0.6);padding:4px 8px;border-radius:4px;';
document.body.appendChild(debugEl);
window.addEventListener('keydown', e => {
  if (e.code === 'Backquote') {
    debugVisible = !debugVisible;
    debugEl.style.display = debugVisible ? 'block' : 'none';
  }
});

// Update each frame:
// debugEl.textContent = "FPS: " + fps.toFixed(0) + " | DT: " + (dt*1000).toFixed(1) + "ms | Entities: " + entityCount;
\\\`\\\`\\\`

---

## Quality Targets

- 55+ FPS average, 30+ FPS 1% low
- Draw calls < 200 (3D)
- Stable memory (no leaks in entity pools)
- All inputs responsive (keyboard, mouse, touch)
- All screens present: title, HUD, pause, game-over
- Audio working: SFX on interactions, background music with mute option
- Art direction consistent across all screens and game elements

Build with \\\`npx vite\\\` for dev, \\\`npx vite build\\\` for production.`,
  },

  // ── /docx — Word document creation, editing, and conversion ──
  {
    name: "docx",
    description: "Create, edit, and convert Word documents (.docx). Supports creation from scratch, template editing, PDF-to-Word conversion, and text extraction.",
    category: "office",
    version: "1.0.0",
    enabled: true,
    when_to_use: "When the user asks to create, edit, convert, or extract text from a Word document, .docx file, or asks for a formatted document output.",
    allowed_tools: ["python-exec", "bash", "read-file", "write-file"],
    prompt_template: `You are executing the /docx skill. Your task: {{ARGS}}

# Word Document (.docx) Skill

Under the hood, .docx is a ZIP container holding XML parts. Creation, reading, and modification all operate on this XML structure.

**Visual and typographic standards:** Reference the /design skill for color palette, typeface selection, and layout principles (single accent color with neutral tones, no decorative graphics, WCAG-compliant contrast). Use widely available sans-serif typefaces like Arial or Calibri as your baseline.

---

## Choosing an Approach

| Objective | Technique | Notes |
|-----------|-----------|-------|
| Create a document from scratch | \\\`docx\\\` npm module (JavaScript) or \\\`python-docx\\\` (Python) | Check which is available first |
| Edit an existing file | Unpack to XML, modify, repack | See Editing section below |
| Extract text | \\\`pandoc document.docx -o output.md\\\` | Append \\\`--track-changes=all\\\` for redline content |
| Handle legacy .doc format | \\\`soffice --headless --convert-to docx file.doc\\\` | Convert before any XML work |
| Rebuild from a PDF | Run \\\`pdf2docx\\\`, then patch issues | See PDF-to-Word section |
| Export pages as images | \\\`soffice\\\` to PDF, then \\\`pdftoppm\\\` | Check if installed |

**Important:** Before using any tool, verify it is available in the current environment:
\\\`\\\`\\\`bash
which pandoc && echo "pandoc available" || echo "pandoc not found"
which soffice && echo "LibreOffice available" || echo "LibreOffice not found"
node -e "require('docx')" 2>/dev/null && echo "docx npm available" || echo "docx npm not found"
python3 -c "import docx" 2>/dev/null && echo "python-docx available" || echo "python-docx not found"
\\\`\\\`\\\`
Install missing tools as needed: \\\`npm install docx\\\`, \\\`pip install python-docx\\\`, \\\`pip install pdf2docx\\\`.

---

## Creating Documents from Scratch (JavaScript \\\`docx\\\` module)

### Workflow
1. **Initialize** — load the library, set up the document skeleton
2. **Configure pages** — dimensions, margins, portrait vs. landscape
3. **Define typography** — heading overrides, body font defaults
4. **Assemble content** — paragraphs, lists, tables, images, hyperlinks, tab stops, columns
5. **Export** — write the buffer to disk

### Initialization

\\\`\\\`\\\`javascript
const fs = require('fs');
const docx = require('docx');
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  ImageRun, Header, Footer, AlignmentType, PageOrientation, LevelFormat,
  ExternalHyperlink, InternalHyperlink, Bookmark,
  TableOfContents, HeadingLevel,
  BorderStyle, WidthType, ShadingType, VerticalAlign, PageNumber,
  PageBreak, FootnoteReferenceRun,
} = docx;

const report = new Document({ sections: [{ children: [/* ... */] }] });
Packer.toBuffer(report).then(buf => fs.writeFileSync("deliverable.docx", buf));
\\\`\\\`\\\`

### Page Configuration

All measurements use DXA units (twentieths of a typographic point). One inch = 1440 DXA.

| Format | Width (DXA) | Height (DXA) | Printable area with 1" margins |
|--------|-------------|--------------|--------------------------------|
| US Letter | 12240 | 15840 | 9360 |
| A4 | 11906 | 16838 | 9026 |

\\\`\\\`\\\`javascript
sections: [{
  properties: {
    page: {
      size: { width: 12240, height: 15840 },
      margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 }
    }
  },
  children: [/* ... */]
}]
\\\`\\\`\\\`

**Landscape mode:** Supply the standard portrait values and set the orientation flag — the engine swaps dimensions internally.
\\\`\\\`\\\`javascript
size: { width: 12240, height: 15840, orientation: PageOrientation.LANDSCAPE }
\\\`\\\`\\\`

### Typography and Heading Styles

Pick a professional, universally installed sans-serif font. Keep heading text in black for legibility. Override built-in heading styles by referencing canonical IDs. The \\\`outlineLevel\\\` property is mandatory for Table of Contents generation.

\\\`\\\`\\\`javascript
const report = new Document({
  styles: {
    default: { document: { run: { font: "Arial", size: 24 } } },
    paragraphStyles: [
      { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 36, bold: true, font: "Arial" },
        paragraph: { spacing: { before: 280, after: 140 }, outlineLevel: 0 } },
      { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 28, bold: true, font: "Arial" },
        paragraph: { spacing: { before: 220, after: 110 }, outlineLevel: 1 } },
    ]
  },
  sections: [{ children: [
    new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun("Key Findings")] }),
  ] }]
});
\\\`\\\`\\\`

### Lists

**Do not insert bullet characters directly** — raw Unicode bullets produce broken formatting in Word.

\\\`\\\`\\\`javascript
const report = new Document({
  numbering: {
    config: [
      { reference: "bullets",
        levels: [{ level: 0, format: LevelFormat.BULLET, text: "\\u2022", alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] },
      { reference: "steps",
        levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] },
    ]
  },
  sections: [{ children: [
    new Paragraph({ numbering: { reference: "bullets", level: 0 },
      children: [new TextRun("Key takeaway")] }),
  ] }]
});
\\\`\\\`\\\`

### Tables

Set widths in two places: on the table object and on every individual cell. Omitting either causes inconsistent rendering.

- **Avoid \\\`WidthType.PERCENTAGE\\\`** — Google Docs does not handle percentage-based widths correctly. Stick to \\\`WidthType.DXA\\\`.
- **Avoid \\\`ShadingType.SOLID\\\`** — this fills cells completely black. Use \\\`ShadingType.CLEAR\\\` with a \\\`fill\\\` hex color.

\\\`\\\`\\\`javascript
const thinBorder = { style: BorderStyle.SINGLE, size: 1, color: "B0B0B0" };
const allBorders = { top: thinBorder, bottom: thinBorder, left: thinBorder, right: thinBorder };

new Table({
  width: { size: 9360, type: WidthType.DXA },
  columnWidths: [5200, 4160],
  rows: [
    new TableRow({
      children: [
        new TableCell({
          borders: allBorders,
          width: { size: 5200, type: WidthType.DXA },
          shading: { fill: "EDF2F7", type: ShadingType.CLEAR },
          margins: { top: 60, bottom: 60, left: 100, right: 100 },
          children: [new Paragraph({ children: [new TextRun({ text: "Label", bold: true })] })]
        }),
      ]
    })
  ]
})
\\\`\\\`\\\`

### Images

The \\\`type\\\` field is required on every \\\`ImageRun\\\`. Accepted formats: \\\`png\\\`, \\\`jpg\\\`, \\\`jpeg\\\`, \\\`gif\\\`, \\\`bmp\\\`, \\\`svg\\\`.

\\\`\\\`\\\`javascript
new Paragraph({
  children: [new ImageRun({
    type: "png",
    data: fs.readFileSync("diagram.png"),
    transformation: { width: 350, height: 220 },
    altText: { title: "Monthly trend", description: "Line chart of monthly active users", name: "trend-chart" }
  })]
})
\\\`\\\`\\\`

### Hyperlinks

\\\`\\\`\\\`javascript
// External
new ExternalHyperlink({
  children: [new TextRun({ text: "the project wiki", style: "Hyperlink" })],
  link: "https://wiki.example.org"
})

// Internal cross-reference (bookmark)
new Bookmark({ id: "section-data", children: [new TextRun("Data Collection Methods")] })
new InternalHyperlink({ anchor: "section-data",
  children: [new TextRun({ text: "Data Collection Methods", style: "Hyperlink" })] })
\\\`\\\`\\\`

### Page Breaks, TOC, Headers, and Footers

\\\`\\\`\\\`javascript
// Page break
new Paragraph({ children: [new PageBreak()] })

// Table of Contents — only recognizes HeadingLevel, not custom styles
new TableOfContents("Table of Contents", { hyperlink: true, headingStyleRange: "1-3" })

// Header and footer
headers: {
  default: new Header({ children: [
    new Paragraph({ alignment: AlignmentType.RIGHT,
      children: [new TextRun({ text: "Confidential", italics: true, color: "999999", size: 16 })] })
  ] })
},
footers: {
  default: new Footer({ children: [
    new Paragraph({ alignment: AlignmentType.CENTER,
      children: [new TextRun("Page "), new TextRun({ children: [PageNumber.CURRENT] }),
                 new TextRun(" of "), new TextRun({ children: [PageNumber.TOTAL_PAGES] })] })
  ] })
}
\\\`\\\`\\\`

### Source Citations

When content draws on external sources, attach numbered footnotes with clickable links.

\\\`\\\`\\\`javascript
const report = new Document({
  footnotes: {
    1: { children: [new Paragraph({ children: [
      new TextRun("Source Name, "),
      new ExternalHyperlink({ children: [new TextRun({ text: "https://example.com", style: "Hyperlink" })], link: "https://example.com" })
    ]})] },
  },
  sections: [{ children: [
    new Paragraph({ children: [
      new TextRun("Claim based on research"),
      new FootnoteReferenceRun(1),
      new TextRun(".")
    ] })
  ] }]
});
\\\`\\\`\\\`

---

## Editing Existing Documents

To edit a .docx file, unpack it into raw XML, apply your changes, then repack into a new .docx.

### Stage 1: Unpack

\\\`\\\`\\\`bash
# Unpack the ZIP archive, reformat XML for readability
mkdir -p working && cd working && unzip -o ../document.docx
# Or use a helper script if available:
# python scripts/unpack.py document.docx working/
\\\`\\\`\\\`

### Stage 2: Edit XML

All editable content lives under \\\`working/word/\\\`. The primary file is \\\`document.xml\\\`.

**Author name for tracked changes and comments:** set to the user's name or a sensible default for the context.

**Typographic quotes:** encode as XML entities for proper curly quotes:
- \\\`&#x2018;\\\` left single, \\\`&#x2019;\\\` right single/apostrophe
- \\\`&#x201C;\\\` left double, \\\`&#x201D;\\\` right double

**Tracked changes — insertion:**
\\\`\\\`\\\`xml
<w:ins w:id="1" w:author="Author Name" w:date="2026-04-02T12:00:00Z">
  <w:r><w:t>added material</w:t></w:r>
</w:ins>
\\\`\\\`\\\`

**Tracked changes — deletion:**
\\\`\\\`\\\`xml
<w:del w:id="2" w:author="Author Name" w:date="2026-04-02T12:00:00Z">
  <w:r><w:delText>removed material</w:delText></w:r>
</w:del>
\\\`\\\`\\\`

**Editing guidelines:**
- Swap out entire \\\`<w:r>\\\` elements when introducing tracked changes — do not inject change markup inside an existing run
- Carry forward \\\`<w:rPr>\\\` formatting — copy the original run's formatting block into both \\\`<w:del>\\\` and \\\`<w:ins>\\\` runs
- Preserve whitespace: attach \\\`xml:space="preserve"\\\` to any \\\`<w:t>\\\` with leading/trailing spaces
- Element order within \\\`<w:pPr>\\\`: \\\`<w:pStyle>\\\`, \\\`<w:numPr>\\\`, \\\`<w:spacing>\\\`, \\\`<w:ind>\\\`, \\\`<w:jc>\\\`, \\\`<w:rPr>\\\` last

### Stage 3: Repack

\\\`\\\`\\\`bash
cd working && zip -r ../output.docx . -x ".*"
# Or use a helper script if available:
# python scripts/pack.py working/ output.docx
\\\`\\\`\\\`

---

## PDF to Word Conversion

Start by running \\\`pdf2docx\\\` to get a baseline .docx, then correct any artifacts. Never skip the automated conversion and attempt to rebuild manually.

\\\`\\\`\\\`python
from pdf2docx import Converter

parser = Converter("source.pdf")
parser.convert("converted.docx")
parser.close()
\\\`\\\`\\\`

Once converted, fix misaligned tables, broken hyperlinks, or shifted images by unpacking and editing the XML directly.

---

## Image Rendering (Export to images)

\\\`\\\`\\\`bash
soffice --headless --convert-to pdf document.docx
pdftoppm -jpeg -r 150 document.pdf page
ls page-*.jpg   # always ls — zero-padding varies by page count
\\\`\\\`\\\`

---

## Rules (Non-Negotiable)

- **Specify paper size** — the library assumes A4 by default; set 12240 x 15840 DXA for US Letter
- **Supply portrait values for landscape** — the engine swaps dimensions internally
- **Line breaks need separate Paragraphs** — \\n inside a TextRun does nothing useful
- **Bullet lists require numbering config** — raw Unicode bullets produce broken formatting
- **Wrap PageBreak in a Paragraph** — a bare PageBreak generates invalid XML
- **Always declare \\\`type\\\` on ImageRun** — the library cannot infer the image format
- **Use DXA for all table widths** — \\\`WidthType.PERCENTAGE\\\` is unreliable in Google Docs
- **Set widths on both the table and each cell** — \\\`columnWidths\\\` and cell \\\`width\\\` must agree
- **Column widths must sum to the table width** — any mismatch causes layout shifts
- **Include cell margins for readability** — padding keeps text from pressing against borders
- **Apply \\\`ShadingType.CLEAR\\\` for cell backgrounds** — \\\`SOLID\\\` fills cells with black
- **TOC only recognizes \\\`HeadingLevel\\\`** — custom paragraph styles are invisible to the TOC generator
- **Reference canonical style IDs** — use "Heading1", "Heading2" to override built-in styles
- **Set \\\`outlineLevel\\\` on heading styles** — the TOC needs this (0 for H1, 1 for H2)
- **Set author to the user's name** — not a generic placeholder

## Quality Checklist

Before delivering the document:
1. Verify the file opens without errors (test with \\\`python3 -c "import zipfile; zipfile.ZipFile('output.docx').testzip()"\\\`)
2. Check all headings use \\\`HeadingLevel\\\` enum (not custom styles) for TOC compatibility
3. Verify table column widths sum correctly
4. Confirm images have \\\`type\\\` and \\\`altText\\\` properties
5. Check that no raw Unicode bullets are used — all lists use numbering config
6. Verify page dimensions match the intended paper size
7. Reference /design for typography and color choices`,
  },

  // ── /pptx — PowerPoint presentation creation and editing ──
  {
    name: "pptx",
    description: "Create and edit PowerPoint presentations (.pptx). Professional slide design with data visualization, layout variety, and consistent typography.",
    category: "office",
    version: "1.0.0",
    enabled: true,
    when_to_use: "When the user asks to create, edit, or design a PowerPoint presentation, slide deck, or .pptx file.",
    allowed_tools: ["python-exec", "bash", "read-file", "write-file", "image-generate", "web-search"],
    prompt_template: `You are executing the /pptx skill. Your task: {{ARGS}}

# PowerPoint Presentation (.pptx) Skill

---

## Choosing an Approach

| Objective | Technique | Notes |
|-----------|-----------|-------|
| Extract text or data | \\\`python -m markitdown presentation.pptx\\\` | Check if markitdown is installed |
| Modify an existing file | Unpack to XML, edit, repack | See Editing section below |
| Generate a deck from scratch | JavaScript with \\\`pptxgenjs\\\` | See Creation section below |

**Before using any tool, verify availability:**
\\\`\\\`\\\`bash
node -e "require('pptxgenjs')" 2>/dev/null && echo "pptxgenjs available" || echo "pptxgenjs not found"
python3 -m markitdown --help 2>/dev/null && echo "markitdown available" || echo "markitdown not found"
which soffice && echo "LibreOffice available" || echo "LibreOffice not found"
\\\`\\\`\\\`
Install missing tools as needed: \\\`npm install pptxgenjs\\\`, \\\`pip install markitdown[pptx]\\\`.

---

## Design Philosophy

### Before Starting

- **No icons** unless the user explicitly asks. Icons next to headings, in colored circles, or as bullet decorations are visual clutter. Only include icons when data or content requires them (chart selector, logo).
- **Accent at 10-15% visual weight**: Neutral tones fill backgrounds and body text (85-90%). Never give multiple hues equal weight.
- **Dark/light contrast**: Dark backgrounds for title + conclusion slides, light for content ("sandwich" structure). Or commit to dark throughout for a premium feel.
- **Commit to a structural motif**: Pick ONE structural element and repeat it — rounded card frames, consistent header bars, background color blocks, or bold typographic weight. Carry it across every slide.

### Color Selection

**Derive color from the content itself.** Don't pick from a preset list — let the subject matter guide the accent:

- *Financial report* -> deep navy or charcoal conveys authority
- *Sustainability pitch* -> muted forest green ties to the topic
- *Healthcare overview* -> calming blue or teal builds trust
- *Creative brief* -> warmer accent (terracotta, berry) adds energy

Build every palette as **1 accent + neutral surface + neutral text**. The accent is for emphasis only (headings, key data, section markers) — everything else stays neutral. Reference /design for the full palette philosophy, contrast rules, and the custom-palette workflow.

**When no topic-specific color is obvious**, fall back to: teal \\\`#01696F\\\` accent on warm beige \\\`#F7F6F2\\\`.

### Layout Variety (For Each Slide)

Use layout variety for visual interest — columns, grids, and whitespace keep slides engaging without decoration.

**Layout options:**
- Two-column (text left, supporting content right)
- Labeled rows (bold header + description)
- 2x2 or 2x3 grid of content blocks
- Half-bleed background with content overlay
- Full-width stat callout with large number and label

**Data display:**
- Large stat callouts (big numbers 60-72pt with small labels below)
- Comparison columns (before/after, pros/cons, side-by-side options)
- Timeline or process flow (numbered steps, arrows)

### Typography

**System fonts only for PPTX** — you cannot embed fonts in PowerPoint files, so the deck must use fonts available on any machine. Safe choices:
- **Calibri** (default, clean, universal)
- **Arial** (fallback, every OS)
- **Trebuchet MS** (slightly more character, still universal)

Use serif (e.g., Georgia) for headings only when a formal tone is needed. See /design for font pairing guidance.

**Size hierarchy:**
- Slide title: 36pt+
- Subtitle/section header: 24-28pt
- Body text: 14-16pt
- Captions/labels: 10-12pt

### Spacing
- 0.5" minimum margins from slide edges
- 0.3-0.5" between content blocks
- Leave breathing room — don't fill every inch

---

## Creating Presentations (PptxGenJS)

### Setup

\\\`\\\`\\\`javascript
const pptxgen = require("pptxgenjs");
const deck = new pptxgen();
deck.layout = "LAYOUT_16x9"; // 10" x 5.625"
const sl = deck.addSlide();
// ... build slides ...
await deck.writeFile({ fileName: "output.pptx" });
\\\`\\\`\\\`

Standard slide dimensions: \\\`LAYOUT_16x9\\\` is 10" x 5.625", \\\`LAYOUT_16x10\\\` is 10" x 6.25", \\\`LAYOUT_4x3\\\` is 10" x 7.5", \\\`LAYOUT_WIDE\\\` is 13.33" x 7.5".

**\\\`writeFile\\\` returns a promise.** Forgetting \\\`await\\\` produces an empty or truncated file.

### Color: No \\\`#\\\`, No 8-char Hex

Always 6-character hex without \\\`#\\\` prefix. \\\`"1E293B"\\\` is correct. \\\`"#1E293B"\\\` corrupts the file. Never use 8-character hex for alpha — use the dedicated \\\`opacity\\\` or \\\`transparency\\\` property instead.

This applies everywhere: text \\\`color\\\`, shape \\\`fill.color\\\`, \\\`line.color\\\`, shadow \\\`color\\\`, chart \\\`chartColors\\\`.

### Object Mutation Warning

PptxGenJS mutates style objects in place during rendering. If you pass the same object to multiple \\\`addShape\\\`/\\\`addText\\\` calls, every call after the first gets already-transformed numbers. Always use a factory function:

\\\`\\\`\\\`javascript
const cardStyle = () => ({
  fill: { color: "FFFFFF" },
  shadow: { type: "outer", color: "1E293B", blur: 8, offset: 3, angle: 150, opacity: 0.1 },
});
sl.addShape(deck.shapes.RECTANGLE, { x: 0.5, y: 1.2, w: 4, h: 2.8, ...cardStyle() });
sl.addShape(deck.shapes.RECTANGLE, { x: 5.3, y: 1.2, w: 4, h: 2.8, ...cardStyle() });
\\\`\\\`\\\`

### Text Formatting

- **\\\`breakLine: true\\\`** — Required on every segment except the last in a multi-segment \\\`addText\\\` array
- **\\\`charSpacing\\\`** — Not \\\`letterSpacing\\\` (which is silently ignored)
- **\\\`margin: 0\\\`** — Text boxes have built-in inset padding; set \\\`margin: 0\\\` to eliminate it
- **\\\`lineSpacing\\\` vs \\\`paraSpaceAfter\\\`** — \\\`lineSpacing\\\` adjusts distance between wrapped lines AND paragraphs simultaneously. Use \\\`paraSpaceAfter\\\` for whitespace only between bullet items.

### Bullets

Bullets belong on body-sized text (14-16pt) in lists of 3+ items. Never use \\\`bullet\\\` on text above 30pt — the glyph scales with font size and becomes an eyesore. Never place a literal Unicode bullet in the string — PptxGenJS adds its own glyph, producing doubled markers.

Custom bullet characters: \\\`{ bullet: { code: "2013" } }\\\` for en-dash, \\\`"2022"\\\` for bullet, \\\`"25AA"\\\` for small square.

### Rounded Rectangles

\\\`rectRadius\\\` only works on \\\`ROUNDED_RECTANGLE\\\`. Applying it to \\\`RECTANGLE\\\` has no effect. Do not combine \\\`ROUNDED_RECTANGLE\\\` with a thin rectangular accent bar overlay — the bar's sharp corners clip against rounded edges.

### Shadows

- Negative offset corrupts the file — use \\\`angle: 270\\\` with positive \\\`offset\\\` for upward shadows
- 8-char hex corrupts the file — use \\\`opacity\\\` (0.0-1.0) instead
- Factory function required — shadow objects are mutated during render

### Gradient Fills

PptxGenJS has no gradient fill API. Generate a gradient image externally and embed via \\\`addImage\\\` or \\\`sl.background = { data: ... }\\\`.

### Slide Backgrounds

\\\`sl.background = { color: "1E293B" }\\\` for solid fill, or \\\`sl.background = { data: "image/png;base64,..." }\\\` for an image.

### Charts

Key non-obvious option names:
- \\\`chartColors\\\` — array of 6-char hex, one per series/segment
- \\\`chartArea\\\` — \\\`{ fill: { color }, border: { color, pt }, roundedCorners }\\\` for chart background
- \\\`plotArea\\\` — \\\`{ fill: { color } }\\\` for the plot region (often needed on dark slides)
- \\\`catGridLine\\\` / \\\`valGridLine\\\` — use \\\`style: "none"\\\` to hide
- \\\`dataLabelPosition\\\` — \\\`"outEnd"\\\`, \\\`"inEnd"\\\`, \\\`"center"\\\`
- \\\`dataLabelFormatCode\\\` — Excel-style format, e.g. \\\`'#,##0.0'\\\`, \\\`'#"%"'\\\`
- \\\`barDir\\\` — \\\`"col"\\\` for vertical, \\\`"bar"\\\` for horizontal
- \\\`holeSize\\\` — doughnut inner ring (try 50-60 for proper look)
- Scatter charts: first array = X-axis values, subsequent = Y-series. Do NOT use \\\`labels\\\` for X-values.
- No waterfall chart type — build manually from positioned rectangles

### Tables

- \\\`colW\\\` — array of column widths in inches, must sum to desired table width
- \\\`rowH\\\` — array of row heights or single value for uniform rows
- \\\`border\\\` — \\\`{ type: "solid", color: "CCCCCC", pt: 0.5 }\\\`
- Cell fill: \\\`fill: { color: "F1F5F9" }\\\` on header row cells for contrast

### Source Citations

Every slide using information from web sources MUST have a source attribution at the bottom with hyperlinked source names:

\\\`\\\`\\\`javascript
slide.addText([
  { text: "Source: " },
  { text: "Reuters", options: { hyperlink: { url: "https://reuters.com/article/123" } } },
  { text: ", " },
  { text: "WHO", options: { hyperlink: { url: "https://who.int/publications/m/item/update-42" } } },
], { x: 0.5, y: 5.2, w: 9, h: 0.3 });
\\\`\\\`\\\`

Each source name MUST have a \\\`hyperlink.url\\\` — never plain text URLs, never omit hyperlinks.

---

## Editing Existing Presentations

### Inspect

\\\`\\\`\\\`bash
python -m markitdown template.pptx   # extract text content
\\\`\\\`\\\`

### Unpack / Repack

\\\`\\\`\\\`bash
mkdir -p unpacked && cd unpacked && unzip -o ../input.pptx
# Edit XML files in ppt/slides/
# Then repack:
cd unpacked && zip -r ../output.pptx . -x ".*"
\\\`\\\`\\\`

### Workflow

1. **Analyze** — Run markitdown to extract text. Map content to template layouts.
2. **Restructure** — Unpack, handle structural changes: delete/add slide entries in \\\`ppt/presentation.xml\\\`, reorder. Finish all additions/deletions before touching content.
3. **Replace content** — Edit each \\\`slide{N}.xml\\\` directly.
4. **Finalize** — Repack into .pptx.
5. **QA** — See Quality Checklist below.

### XML Editing Gotchas

- **Bold:** Use \\\`b="1"\\\` on \\\`<a:rPr>\\\`, not \\\`bold="true"\\\`
- **Bullets:** Never use Unicode bullet characters. Use \\\`<a:buChar>\\\` or \\\`<a:buAutoNum>\\\` in \\\`<a:pPr>\\\`
- **One \\\`<a:p>\\\` per logical item** — each list item, metric, agenda item gets its own paragraph
- **Whitespace:** Set \\\`xml:space="preserve"\\\` on any \\\`<a:t>\\\` with significant leading/trailing spaces
- **Smart quotes:** Use XML character references: \\\`&#x201C;\\\` / \\\`&#x201D;\\\` (double), \\\`&#x2018;\\\` / \\\`&#x2019;\\\` (single)
- **Template adaptation:** When template has more slots than content, delete the entire shape group (images + text boxes + captions), not just the text

---

## Anti-AI-Slop Rules (Mandatory)

Reject these patterns — they instantly mark output as AI-generated:
- **NEVER** use colored side borders on cards/shapes (\\\`border-left: 3px solid <accent>\\\`)
- **NEVER** use accent lines or decorative bars under headings
- **NEVER** use gradient backgrounds on shapes or text — solid colors are more professional
- **NEVER** add random decorative icons — omit icons unless the user specifically requests them
- **NEVER** use generic filler phrases ("Empowering your journey", "Unlock the power of...", "Your all-in-one solution")
- **NEVER** leave orphan shapes — if an icon render fails, remove BOTH the icon AND its background shape
- **NEVER** use \\\`bullet: true\\\` on large stat text (60-72pt) — bullets scale with font size
- **NEVER** use \\\`bullet: true\\\` on all text in a slide — only use for actual lists of 3+ items
- **NEVER** repeat the same layout across all slides — vary columns, cards, and callouts
- **NEVER** center body text — left-align paragraphs and lists; center only titles

---

## Quality Checklist

Before delivering the presentation:

### 1. Content QA
\\\`\\\`\\\`bash
python -m markitdown output.pptx
# Check for missing content, typos, wrong order
# Check for leftover placeholder text:
python -m markitdown output.pptx | grep -iE "xxxx|lorem|ipsum|placeholder"
\\\`\\\`\\\`

### 2. Visual QA
Convert slides to images and inspect:
\\\`\\\`\\\`bash
soffice --headless --convert-to pdf output.pptx
pdftoppm -jpeg -r 150 output.pdf slide
ls slide-*.jpg
\\\`\\\`\\\`

Check for: stray dots/circles (orphan shapes), overlapping elements, text overflow/cutoff, elements too close (< 0.3" gaps), uneven spacing, insufficient margins (< 0.5"), misaligned columns, low-contrast text.

### 3. Fix-and-Verify Cycle
Fix every issue found, re-convert affected slides, and verify fixes. At least one cycle before delivering.

### 4. Technical Checks
- Verify no \\\`#\\\` prefix in hex colors (corrupts file)
- Verify no 8-char hex values (corrupts file)
- Verify \\\`await\\\` on \\\`writeFile\\\` (prevents truncation)
- Verify factory functions for shared style objects (prevents mutation bugs)
- Reference /design for full palette and design foundations`,
  },
];

