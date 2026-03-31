/**
 * Skills loader — loads SKILL.md-based skills from Supabase into edge runtime.
 * Skills are injected into the system prompt and can specify allowed tools + prompt templates.
 */

import { getDb } from "./db";

export interface Skill {
  name: string;
  description: string;
  prompt_template: string;
  allowed_tools: string[];
  enabled: boolean;
  version: string;
  category: string;
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
      SELECT name, description, prompt_template, allowed_tools, version, category
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
    }));

    skillCache.set(cacheKey, { skills, expiresAt: Date.now() + SKILL_CACHE_TTL_MS });

    // Evict old entries
    if (skillCache.size > 256) {
      const oldest = [...skillCache.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt);
      for (let i = 0; i < 64; i++) skillCache.delete(oldest[i][0]);
    }

    return skills;
  } catch (err) {
    console.warn("[skills] Failed to load skills:", err);
    return cached?.skills ?? [];
  }
}

/**
 * Format skills as a system prompt section.
 */
export function formatSkillsPrompt(skills: Skill[]): string {
  const all = [...BUILTIN_SKILLS, ...skills];
  if (all.length === 0) return "";

  const lines = ["", "## Available Skills", "When the user's request matches a skill trigger, activate it by following the skill's instructions.", ""];
  for (const s of all) {
    lines.push(`### /${s.name}`);
    if (s.description) lines.push(s.description);
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

const BUILTIN_SKILLS: Skill[] = [
  // ── /batch — Parallel task decomposition + multi-agent execution ──
  {
    name: "batch",
    description: "Decompose a large task into independent sub-tasks and execute them in parallel via delegated agents.",
    category: "orchestration",
    version: "1.0.0",
    enabled: true,
    allowed_tools: ["run-agent", "a2a-send", "marketplace-search"],
    prompt_template: `You are executing the /batch skill. Your task: {{ARGS}}

Follow this 3-phase workflow EXACTLY:

## Phase 1: PLAN
1. Analyze the user's request and break it into 3-15 INDEPENDENT sub-tasks.
2. Each sub-task must be completable in isolation — no dependencies between tasks.
3. Estimate effort per task (small/medium/large).
4. Present the plan to the user as a numbered list. Wait for approval before proceeding.

## Phase 2: EXECUTE
For each approved sub-task:
1. Use the run-agent tool to delegate to a specialist agent (or self if no specialist exists).
2. Run ALL sub-tasks in parallel (do NOT wait for one to finish before starting the next).
3. Each sub-task should produce a clear deliverable (file created, answer found, action completed).

## Phase 3: TRACK & REPORT
1. As results come back, build a status table:
   | # | Task | Status | Result |
   |---|------|--------|--------|
2. Report any failures with the error details.
3. Summarize the overall outcome.

RULES:
- Never execute sub-tasks sequentially if they're independent.
- If a sub-task fails, report it but continue with others.
- If the user hasn't specified the task, ask what they want to accomplish.`,
  },

  // ── /review — Three-lens parallel code review ──
  {
    name: "review",
    description: "Review changed code through 3 parallel lenses: reuse, quality, and efficiency. Then fix found issues.",
    category: "code-quality",
    version: "1.0.0",
    enabled: true,
    allowed_tools: ["bash", "read-file", "edit-file", "grep", "glob"],
    prompt_template: `You are executing the /review skill. Focus: {{ARGS}}

## Step 1: Identify Changes
Run: bash("git diff --name-only HEAD~1") to find changed files.
Read each changed file to understand the modifications.

## Step 2: Three-Lens Review
Review ALL changes through each of these lenses:

### Lens 1: REUSE
- Are there existing utilities/helpers that could replace new code?
- Is there duplicated logic that should be extracted?
- Are there patterns elsewhere in the codebase that should be followed?
Search the codebase with grep/glob to find existing patterns.

### Lens 2: QUALITY
- Redundant state or unnecessary variables?
- Parameter sprawl (functions with 5+ params that should use an options object)?
- Leaky abstractions (implementation details exposed)?
- Comments that just restate the code?
- Error handling that swallows errors silently?

### Lens 3: EFFICIENCY
- Unnecessary work (computing values that are never used)?
- Missed concurrency (sequential operations that could be parallel)?
- Hot-path bloat (heavy operations in frequently-called functions)?
- Memory issues (unbounded collections, missing cleanup)?

## Step 3: Report
Present findings as a table:
| File | Lens | Issue | Severity | Auto-fixable? |
Then ask: "Want me to fix the auto-fixable issues?"

## Step 4: Fix (if approved)
Apply fixes one at a time. After each fix, explain what changed and why.`,
  },

  // ── /debug — Session and agent diagnostics ──
  {
    name: "debug",
    description: "Diagnose issues with the current agent: check error rates, circuit breaker status, recent failures, and tool health.",
    category: "diagnostics",
    version: "1.0.0",
    enabled: true,
    allowed_tools: ["bash", "read-file", "grep", "web-search", "http-request"],
    prompt_template: `You are executing the /debug skill. Issue: {{ARGS}}

## Diagnostic Steps

### 1. Check Recent Errors
Search for recent error patterns in the session:
- Look at the last few tool results for errors
- Check if any tools are consistently failing

### 2. Identify Root Cause
For each error found:
- What tool failed?
- What was the input?
- Is it a transient error (network, rate limit) or permanent (bad config, missing resource)?
- Has the circuit breaker tripped for this tool?

### 3. Check Configuration
- Is the agent's model correctly configured?
- Are all required tools enabled?
- Is the budget sufficient for the requested operation?
- Are there any domain restrictions blocking needed URLs?

### 4. Suggest Fixes
For each issue found, suggest a specific fix:
- If transient: "Retry after X seconds" or "The tool is rate-limited, wait for cooldown"
- If config: "Update the agent configuration to..."
- If bug: "This appears to be a bug in the tool. Workaround: ..."

Present findings clearly with severity (CRITICAL/HIGH/MEDIUM/LOW).`,
  },

  // ── /verify — Run eval against a specific change ──
  {
    name: "verify",
    description: "Verify that a change works by running the agent's eval test cases against it.",
    category: "testing",
    version: "1.0.0",
    enabled: true,
    allowed_tools: ["bash", "read-file", "http-request"],
    prompt_template: `You are executing the /verify skill. What to verify: {{ARGS}}

## Verification Workflow

### Step 1: Understand the Change
Read the relevant files to understand what was changed and what it should do.

### Step 2: Identify Test Criteria
Based on the change:
- What should work that didn't before?
- What should still work that worked before (regression check)?
- What edge cases should be tested?

### Step 3: Execute Tests
Run the agent's existing eval test cases if available.
If no eval config exists, create ad-hoc test scenarios:
1. Positive test: Does the change achieve its goal?
2. Negative test: Does it handle invalid input gracefully?
3. Regression test: Do existing features still work?

### Step 4: Report
| Test | Expected | Actual | Status |
|------|----------|--------|--------|
Report outcomes FAITHFULLY — never claim tests pass when they fail.
If a test fails, include the exact error output.`,
  },

  // ── /remember — Memory curation and deduplication ──
  {
    name: "remember",
    description: "Review and curate the agent's memory: deduplicate facts, promote useful patterns to procedural memory, clean stale entries.",
    category: "memory",
    version: "1.0.0",
    enabled: true,
    allowed_tools: ["memory-save", "memory-recall", "memory-delete", "knowledge-search"],
    prompt_template: `You are executing the /remember skill. Context: {{ARGS}}

## Memory Curation Workflow

### Step 1: Inventory Current Memory
Search all memory tiers for the current agent:
- Working memory: What's in the session cache?
- Episodic memory: What past interactions are stored?
- Procedural memory: What tool sequences have been learned?
- Semantic memory: What facts are stored?

### Step 2: Identify Issues
For each memory entry, check:
- **Duplicates**: Are there multiple entries saying the same thing?
- **Staleness**: Are there facts that are no longer true?
- **Conflicts**: Do any entries contradict each other?
- **Gaps**: Are there important patterns that should be memorized but aren't?

### Step 3: Propose Changes
Present a table:
| Action | Memory Type | Content | Reason |
|--------|------------|---------|--------|
| DELETE | fact | "API key is xyz" | Contains credential |
| MERGE | episode | "User prefers JSON" + "User wants JSON format" | Duplicate |
| PROMOTE | procedural | "deploy: test → build → push" | Used 5+ times |
| ADD | fact | "User's timezone is PST" | Referenced repeatedly |

Wait for user approval before making changes.

### Step 4: Apply (if approved)
Execute each approved change using the appropriate memory tools.`,
  },

  // ── /skillify — Extract a repeatable process into a reusable skill ──
  {
    name: "skillify",
    description: "Extract a repeatable process from this conversation into a reusable skill definition.",
    category: "meta",
    version: "1.0.0",
    enabled: true,
    allowed_tools: ["read-file", "write-file"],
    prompt_template: `You are executing the /skillify skill. Description: {{ARGS}}

## Skill Extraction Interview

I'll help you capture this process as a reusable skill. Let me ask a few questions:

### Round 1: Identity
- **Name**: What should this skill be called? (lowercase-kebab-case, e.g., "deploy-to-prod")
- **Description**: One sentence describing what it does.
- **When to use**: What trigger phrases should activate this skill?

### Round 2: Steps
- What are the high-level steps of this process?
- What tools does each step need?
- Are any steps parallelizable?

### Round 3: Details
For each step:
- What's the success criteria?
- What are common failure modes?
- Are there any prerequisites?

### Round 4: Finalize
- Are there edge cases or gotchas to document?
- Should this skill be available to all agents or just specific ones?

After the interview, I'll generate a skill definition and save it.

RULES:
- Ask one round of questions at a time. Wait for answers before proceeding.
- Generate the skill with a detailed prompt_template that another agent can follow.
- Include error handling and fallback instructions in the generated prompt.`,
  },

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
  {
    name: "docs",
    description: "Load relevant API documentation, SDK reference, or framework guides based on the current project context.",
    category: "reference",
    version: "1.0.0",
    enabled: true,
    allowed_tools: ["read-file", "web-search", "grep", "glob"],
    prompt_template: `You are executing the /docs skill. Topic: {{ARGS}}

## Documentation Lookup

### Step 1: Detect Project Context
Scan the workspace to identify:
- Languages used (check file extensions, package.json, pyproject.toml, go.mod, etc.)
- Frameworks (React, Express, Django, FastAPI, etc.)
- APIs referenced (check imports, config files)

### Step 2: Find Relevant Docs
Based on the topic and detected context:
1. Search the workspace for existing documentation (README, docs/, wiki/)
2. Search for inline documentation (JSDoc, docstrings, comments)
3. If the topic is about an external API or library, search the web for the official docs

### Step 3: Present
Format the documentation in a clear, scannable way:
- Start with a one-paragraph summary
- Include code examples specific to the user's language/framework
- Link to official documentation when available
- Highlight common gotchas or breaking changes

RULES:
- Always prefer the project's OWN documentation over generic web results.
- If docs conflict with the codebase, trust the codebase.
- Show code examples that match the project's style (imports, naming conventions, etc.).`,
  },
];

