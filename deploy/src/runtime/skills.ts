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
export function formatSkillsPrompt(skills: Skill[], plan?: string): string {
  const all = [...BUILTIN_SKILLS, ...skills];
  if (all.length === 0) return "";

  const planTier = (plan || "standard").toLowerCase();
  const planRank: Record<string, number> = { basic: 0, standard: 1, premium: 2 };
  const userRank = planRank[planTier] ?? 1;

  const lines = ["", "## Available Skills", "When the user's request matches a skill trigger, activate it by following the skill's instructions.", ""];
  for (const s of all) {
    lines.push(`### /${s.name}`);
    if (s.description) lines.push(s.description);
    // If user's plan is below the skill's minimum, add delegation note
    if (s.min_plan && s.delegate_agent && userRank < (planRank[s.min_plan] ?? 1)) {
      lines.push(`> **Note:** This skill requires ${s.min_plan}+ plan for best results. On your current plan, auto-delegate to the \`${s.delegate_agent}\` skill agent via \`run-agent\` for higher quality output.`);
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

  // ═══════════════════════════════════════════════════════════════
  // Research & Analysis Skills (adapted from Perplexity methodology)
  // ═══════════════════════════════════════════════════════════════

  {
    name: "research",
    description: "Deep research with iterative evidence gathering, source verification, and structured reporting. Use for any question requiring multi-source investigation.",
    category: "research",
    version: "1.0.0",
    enabled: true,
    min_plan: "standard",
    delegate_agent: "research-analyst",
    allowed_tools: ["web-search", "browse", "web-crawl", "http-request", "memory-save", "memory-recall", "python-exec", "write-file"],
    prompt_template: `You are a world-class research expert. Your output should be of the quality expected from a $200,000+ professional consulting deliverable.

## Research Protocol

### Phase 1: Scope & Prior Knowledge
- Check memory-recall for any prior findings on this topic
- Define 3-5 specific research questions that must be answered
- Identify what "good enough" evidence looks like

### Phase 2: Evidence Gathering (iterate until complete)
For each research question:
1. Search with **recency-focused queries** (include current year: 2026)
2. Prefer **primary sources**: official docs, published papers, government data, company filings
3. For any statistics or claims, find the **original source** — not a blog citing a blog
4. Cross-reference minimum 2 independent sources for key claims
5. Browse full pages for critical sources — snippets miss context

### Phase 3: Analysis & Synthesis
- Clean and normalize data before drawing conclusions
- Derive insights, don't just transform data — "what does this mean?"
- Use inline tables and structured comparisons to reduce cognitive load
- Call out **confidence levels**: High (multiple primary sources), Medium (single primary or multiple secondary), Low (limited evidence)
- Flag gaps: explicitly state what you could NOT find

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
- Prefer recent data (2025-2026) over older data unless historical context is needed.`,
  },

  {
    name: "report",
    description: "Generate a structured markdown research report with citations, data visualizations, and executive summary.",
    category: "research",
    version: "1.0.0",
    enabled: true,
    min_plan: "standard",
    delegate_agent: "research-analyst",
    allowed_tools: ["web-search", "browse", "python-exec", "write-file", "read-file", "memory-recall"],
    prompt_template: `Generate a comprehensive research report on: {{ARGS}}

## Report Structure

1. **Title** (H1) — descriptive, not clickbait
2. **Executive Summary** — 3-5 sentences, key findings + implications
3. **Body Sections** (H2/H3) — organized by theme, not by source
4. **Analysis** — your synthesis, not just source summaries
5. **Conclusion** — actionable takeaways

## Citation Rules
- Inline citations as markdown links: [Source Name](https://actual-url)
- 1-3 citations per major claim
- All URLs must be from pages you actually retrieved — never fabricate
- No bare URLs in text — always descriptive anchor text

## Data Visualization
When data warrants it, generate charts with python-exec (matplotlib):
- Line charts for trends over time
- Bar charts for comparisons (horizontal for rankings)
- Tables for structured comparisons

## Length Calibration
- Quick summary: 5-10 paragraphs
- Standard report: 15-25 paragraphs
- Deep analysis: 30-50+ paragraphs

## Quality Rules
- No first-person pronouns
- State confidence levels for contested claims
- Include a "Limitations" section
- Write the report to a file: report-{topic-slug}.md`,
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
    allowed_tools: ["python-exec", "write-file", "read-file"],
    prompt_template: `Apply these design foundations to: {{ARGS}}

## Core Principles
1. **Restraint** — 1 accent color + neutrals, 2 fonts max, 2-3 weights
2. **Purpose** — every visual element must earn its place
3. **Accessibility** — WCAG AA minimum (4.5:1 text contrast, 3:1 large text)

## Color System (Light / Dark)
| Role | Light | Dark |
|------|-------|------|
| Background | #FFFFFF | #131416 |
| Surface | #F7F7F8 | #1E2022 |
| Border | #E5E5E5 | rgba(255,255,255,0.08) |
| Text Primary | #1A1A1A | #E8E8E6 |
| Text Secondary | #6B6B67 | #9B9B97 |
| Primary | #5B6AF0 | #6B8AFD |
| Error | #DC3545 | #F87171 |
| Success | #059669 | #34D399 |

## Chart Color Sequence (data visualization)
\`["#20808D", "#A84B2F", "#3B7FC4", "#7B5EA7", "#C4853B", "#4EA87B", "#C44B6B", "#6B8A3B"]\`

## Chart Selection
- Trend over time → Line chart
- Category comparison → Vertical bar
- Ranking → Horizontal bar (sorted)
- Part of whole → Stacked bar (NOT pie charts)
- Distribution → Histogram
- Correlation → Scatter plot

## Typography Rules
- Body: 16px, line-height 1.5-1.6, max 75 chars/line
- Headings: Bold weight of same family, or complementary display font
- Never use: Papyrus, Comic Sans, Lobster, Impact
- Avoid as primary: Roboto, Arial, Helvetica, Open Sans (overused)

## Data Viz Rules
- Title states the INSIGHT, not the metric ("Revenue doubled in Q3" not "Revenue by Quarter")
- Highlight the story: bright accent for key data, grey for context
- Always sort bar charts by value
- Bar charts MUST start at zero
- Include units in axis labels
- Use \`format_number()\` for K/M/B abbreviations`,
  },

  {
    name: "chart",
    description: "Generate publication-quality data visualizations with matplotlib/seaborn. Provide data and chart type.",
    category: "visualization",
    version: "1.0.0",
    min_plan: "standard",
    delegate_agent: "data-analyst",
    enabled: true,
    allowed_tools: ["python-exec", "write-file", "read-file"],
    prompt_template: `Create a data visualization: {{ARGS}}

## Python Setup
\`\`\`python
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import seaborn as sns
import numpy as np

# Professional defaults
plt.rcParams.update({
    "figure.figsize": (10, 6),
    "figure.dpi": 150,
    "font.family": "sans-serif",
    "font.size": 11,
    "axes.titlesize": 14,
    "axes.titleweight": "bold",
    "axes.spines.top": False,
    "axes.spines.right": False,
    "legend.frameon": False,
})

PALETTE = ["#20808D", "#A84B2F", "#3B7FC4", "#7B5EA7", "#C4853B", "#4EA87B", "#C44B6B", "#6B8A3B"]

def format_number(n, prefix="", suffix="", decimals=1):
    """Format large numbers: 1200 → '1.2K', 1500000 → '1.5M'"""
    for unit, threshold in [("B", 1e9), ("M", 1e6), ("K", 1e3)]:
        if abs(n) >= threshold:
            return f"{prefix}{n/threshold:.{decimals}f}{unit}{suffix}"
    return f"{prefix}{n:.{decimals}f}{suffix}"
\`\`\`

## Design Rules
1. Title states the INSIGHT ("Revenue doubled in Q3"), not just the metric
2. Highlight the story: use bright accent for key data point, grey (#BBBBBB) for everything else
3. Sort bar charts by value (largest first for horizontal)
4. Bar charts start at zero — NEVER truncate y-axis
5. Save as PNG: \`plt.savefig("chart.png", bbox_inches="tight", facecolor="white")\`
6. For accessibility: use \`sns.color_palette("colorblind")\` when >3 categories

## Visual QA (run BEFORE sharing any chart)
After saving the chart, verify:
- Text is not clipped or overlapping (check long labels, rotated text)
- Legend doesn't overlap data
- All axis labels are readable (font size >= 10)
- Colors have sufficient contrast against background
- Number formatting is consistent (all K, all M, not mixed)

## Chart Type Guide
- Time series → Line (markers optional for <15 points)
- Category comparison → Vertical bar
- Ranking → Horizontal bar (sorted desc)
- Part of whole → Stacked bar (NOT pie)
- Distribution → Histogram or KDE
- Correlation → Scatter with optional regression line`,
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
    min_plan: "standard",
    delegate_agent: "pdf-specialist",
    allowed_tools: ["python-exec", "bash", "read-file", "write-file"],
    prompt_template: `PDF task: {{ARGS}}

## Tool Selection Matrix

| Task | Library | Install |
|------|---------|---------|
| Create PDF | reportlab | \`pip install reportlab\` |
| Read/merge/split | pypdf | \`pip install pypdf\` |
| Extract text/tables | pdfplumber | \`pip install pdfplumber\` |
| Render pages to PNG | pypdfium2 | \`pip install pypdfium2\` |
| OCR scanned PDFs | pytesseract + pdf2image | \`pip install pytesseract pdf2image\` |

## PDF Creation with ReportLab
\`\`\`python
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.pagesizes import letter
from reportlab.lib import colors
from reportlab.lib.units import inch

doc = SimpleDocTemplate("output.pdf", pagesize=letter,
    topMargin=0.75*inch, bottomMargin=0.75*inch,
    leftMargin=1*inch, rightMargin=1*inch)
styles = getSampleStyleSheet()
story = []
# Build content with Paragraph, Table, Spacer elements
doc.build(story)
\`\`\`

## Text/Table Extraction with pdfplumber
\`\`\`python
import pdfplumber
with pdfplumber.open("input.pdf") as pdf:
    for page in pdf.pages:
        text = page.extract_text()
        tables = page.extract_tables()
\`\`\`

## Rules
- Install libraries first: \`pip install reportlab pdfplumber pypdf\`
- All metadata: set title, author (user's name or org)
- Source citations: numbered footnotes with clickable URLs
- Never use Unicode superscript chars in ReportLab (render as black boxes)
- All hyperlinks must be clickable
- For scanned PDFs: OCR with pytesseract at 300 DPI as fallback

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
    min_plan: "standard",
    delegate_agent: "data-analyst",
    allowed_tools: ["python-exec", "bash", "read-file", "write-file"],
    prompt_template: `Spreadsheet task: {{ARGS}}

## Setup
\`\`\`python
pip install openpyxl pandas
\`\`\`

## Core Rules
1. **Zero formula errors** — every deliverable must have zero #REF!, #DIV/0!, #NAME?, #VALUE!, #NULL!, #N/A
2. **Formulas over hardcoded values** — every derived cell must be a formula, not a pasted number
3. **Never use \`data_only=True\`** when reading — it destroys all formulas
4. **openpyxl uses 1-based indexing** — row 1 / column A = (1, 1)

## Layout Standards
- Content starts at B2 (Row 1 and Column A are empty spacers)
- Column A width = 3 (gutter)
- Row 1 height = small (spacer)
- Freeze panes at B2 for header row + label column
- Use Excel Table objects (\`worksheet.add_table()\`) for structured data

## Formatting
- Headers: Bold, dark background (#2D3748), white text, center-aligned
- Numbers: Right-aligned with appropriate format (\`#,##0\`, \`$#,##0.00\`, \`0.0%\`)
- Dates: \`YYYY-MM-DD\` format
- Years: Format as TEXT to prevent Excel treating them as numbers
- Negatives: Parentheses style \`(1,234)\` for financial data
- Zeros: Display as "—" via number format \`#,##0;(#,##0);"—"\`

## Conditional Formatting
Always use rule-based formatting, never static PatternFill:
\`\`\`python
from openpyxl.formatting.rule import CellIsRule
ws.conditional_formatting.add("B2:B100",
    CellIsRule(operator="greaterThan", formula=["0"],
              fill=PatternFill(bgColor="C6EFCE")))
\`\`\`

## Financial Model Color Coding
- Blue (#0000FF): Input/assumption cells
- Black: Formula cells
- Green (#008000): Cross-sheet references
- Red (#FF0000): External data links`,
  },

  // ═══════════════════════════════════════════════════════════════
  // Code & Data Analysis Skills
  // ═══════════════════════════════════════════════════════════════

  {
    name: "analyze",
    description: "Analyze data from files, APIs, or databases. Clean, transform, visualize, and derive insights.",
    category: "data",
    version: "1.0.0",
    enabled: true,
    min_plan: "standard",
    delegate_agent: "data-analyst",
    allowed_tools: ["python-exec", "bash", "read-file", "write-file", "web-search", "http-request"],
    prompt_template: `Data analysis task: {{ARGS}}

## Protocol

### Phase 1: Data Ingestion
- Load the data (CSV, JSON, Excel, API, database)
- Display shape, dtypes, first 5 rows, null counts
- Identify the grain (what does each row represent?)

### Phase 2: Cleaning & Validation
- Handle missing values (document strategy: drop, fill, interpolate)
- Check for duplicates, outliers, inconsistent formats
- Normalize column names (snake_case, no spaces)
- Parse dates, standardize categories, fix data types

### Phase 3: Exploration & Analysis
- Summary statistics for numerical columns
- Value counts for categorical columns
- Key relationships and correlations
- Group-by aggregations relevant to the question

### Phase 4: Visualization
- Generate 2-4 charts that tell the story (see /chart skill for standards)
- Each chart title states the INSIGHT, not just the metric

### Phase 5: Findings
Present findings as:
- **Key Insight** (1-2 sentences, the headline)
- **Supporting Evidence** (data points, with exact numbers)
- **Caveats** (sample size, missing data, assumptions)
- **Recommendations** (actionable next steps)

RULES:
- Always show your data at each step (don't just describe — print actual values)
- Derive insights, don't just transform — "what does this MEAN?"
- If data quality is poor, say so explicitly before proceeding
- Save charts as PNG files and reference them in your response`,
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
    allowed_tools: ["bash", "read-file", "write-file", "edit-file", "grep", "glob", "web-search", "python-exec"],
    prompt_template: `Build a website: {{ARGS}}

## Workflow

### Step 1: Design Direction
- Infer visual direction from the subject/purpose (don't ask — decide)
- Choose color palette: 1 primary + 1 accent + neutrals
- Choose typography: 1 heading font + 1 body font (Google Fonts CDN)
- Generate an inline SVG logo (geometric, minimal, single-color)

### Step 2: Setup
\`\`\`bash
mkdir -p project && cd project
npm init -y
npm install vite @vitejs/plugin-react react react-dom tailwindcss @tailwindcss/vite
\`\`\`

### Step 3: Build
- **Stack**: Vite + React + Tailwind CSS (or plain HTML/CSS for simple sites)
- **Type scale**: Hero 32-128px, Page Title 24-36px, Body 16px, Nav 14-16px, Meta 12-14px
- **Responsive**: Mobile-first, test at 375px / 768px / 1440px
- **Performance targets**: LCP < 1.5s, page weight < 800KB
- **SEO**: Semantic HTML, one H1 per page, meta description, Open Graph tags
- **Accessibility**: Reading order = visual order, lang attribute, alt text on images

### Step 4: Multi-page Layout
For editorial/informational sites:
- Asymmetric two-column, feature grid, sidebar + main
- Pull quotes, photo grids, full-bleed sections for visual rhythm
- Mobile: stack to single column, maintain hierarchy

### Step 5: Test & Polish
- Check all links work
- Verify responsive at 3 breakpoints
- Run \`npx vite build\` to verify clean production build

RULES:
- Every site gets a favicon (inline SVG converted to ICO or use emoji)
- No placeholder text — write real copy relevant to the subject
- Images: use Unsplash/Pexels URLs for stock, generate SVG illustrations for icons
- Dark mode: include if the site's audience expects it (tech, developer, creative)

## Anti-AI-Slop Checklist (mandatory)
Reject these patterns — they instantly mark output as AI-generated:
- NO gradient backgrounds on shapes or sections
- NO colored side borders on cards (the AI hallmark)
- NO accent lines or decorative bars under headings
- NO decorative icons unless the user explicitly asked for them
- NO generic filler phrases ("Empowering your journey", "Unlock your potential", "Seamless experience")
- NO more than 1 accent color — "earn every color" (each non-neutral must answer: what does this help the viewer understand?)
- NO pure white (#fff) or pure black (#000) — use warm neutrals (e.g., #F7F6F2 bg, #28251D text)
- NO overused fonts: Roboto, Arial, Poppins, Montserrat, Open Sans, Lato on web projects`,
  },

  {
    name: "game",
    description: "Build a browser game — 2D Canvas or 3D WebGL with Three.js. Covers game loop, physics, input, audio, and deployment.",
    category: "development",
    version: "1.0.0",
    enabled: true,
    allowed_tools: ["bash", "read-file", "write-file", "edit-file", "grep", "glob", "web-search", "python-exec"],
    prompt_template: `Build a browser game: {{ARGS}}

## Architecture Decision

### 2D Game (Canvas API)
- Use for: platformers, puzzle games, card games, retro-style games
- Stack: HTML5 Canvas, vanilla JS or lightweight framework
- Game loop: \`requestAnimationFrame\` with fixed timestep (1/60s)
- Physics: AABB/circle collision, spatial partitioning for many entities

### 3D Game (Three.js + WebGL 2)
- Use for: 3D environments, racing, FPS, exploration games
- Stack: Three.js, Rapier physics (via CDN), Zustand for UI state
- Assets from CDN: Poly Pizza, Kenney, Quaternius (all CC0)
- Performance: InstancedMesh, LOD, frustum culling, cap DPR at 2

## Core Patterns (both 2D and 3D)
\`\`\`javascript
// Fixed timestep game loop
const TICK_RATE = 1/60;
let accumulator = 0;
function gameLoop(timestamp) {
  const dt = (timestamp - lastTime) / 1000;
  lastTime = timestamp;
  accumulator += dt;
  while (accumulator >= TICK_RATE) {
    update(TICK_RATE);
    accumulator -= TICK_RATE;
  }
  render();
  requestAnimationFrame(gameLoop);
}
\`\`\`

## Required Features
1. **Title screen** with start button
2. **HUD**: Score, lives/health, timer (if applicable)
3. **Game over screen** with score + restart
4. **Sound effects**: Web Audio API for interactions (jump, collect, hit, win)
5. **Music**: Background loop (royalty-free: freesound.org, opengameart.org)
6. **Debug overlay**: FPS, frame time, entity count (toggle with backtick key)

## Quality Targets
- 55+ FPS average, 30+ FPS 1% low
- Draw calls < 200 (3D)
- Stable memory (no leaks in entity pools)
- All inputs responsive (keyboard, mouse, touch)

Build with \`npx vite\` for dev, \`npx vite build\` for production.`,
  },
];

