---
name: remember
description: "Review and curate the agent's memory: deduplicate facts, promote useful patterns to procedural memory, clean stale entries."
when_to_use: When the user asks to clean up, deduplicate, or curate the agent's memory.
category: memory
version: 1.0.0
enabled: true
allowed-tools:
  - memory-save
  - memory-recall
  - memory-delete
  - knowledge-search
---
You are executing the /remember skill. Context: {{ARGS}}

# Remember: Memory Management and Curation

You audit, clean, and optimize the agent's memory across all tiers. Follow all four phases. NEVER delete or modify memory without explicit user approval.

---

## Phase 1: INVENTORY — Map All Memory

Search and enumerate every memory entry across all tiers:

### Tier 1: Working Memory (Session Cache)
- What's currently in the session context?
- What recent tool results are cached?
- What temporary state is being held?

### Tier 2: Episodic Memory (Past Interactions)
- Use \`memory-recall\` to search for stored past interactions
- Search broadly: try queries like "user preference", "error", "decision", "pattern", "convention"
- Count total entries

### Tier 3: Procedural Memory (Learned Tool Sequences)
- Search for stored workflows, tool chains, and process patterns
- Look for: deployment steps, review processes, build sequences, debug patterns
- Count total entries

### Tier 4: Semantic Memory (Facts and Knowledge)
- Search for stored facts about: the project, the user, the codebase, the environment
- Try queries: "project", "stack", "architecture", "user", "preference", "config"
- Count total entries

### Tier 5: Workspace Memory (MEMORY.md)
- Read the workspace MEMORY.md file if it exists
- Note all entries and their categories

Present a summary:
| Tier | Entry Count | Last Updated | Notes |
|------|------------|-------------|-------|
| Working | X | (current session) | ... |
| Episodic | Y | ... | ... |
| Procedural | Z | ... | ... |
| Semantic | W | ... | ... |
| Workspace | V | ... | ... |

---

## Phase 2: AUDIT — Check Every Entry

For each memory entry, evaluate against these criteria:

### Duplicates (Exact or Semantic)
- **Exact duplicates**: Same content stored multiple times (different keys or tiers)
- **Semantic duplicates**: Different wording but same meaning ("User prefers JSON output" vs "User wants responses in JSON format")
- **Near duplicates**: Same topic with slight variations that should be consolidated

### Staleness
Flag entries about things that change over time:
- Version numbers (packages, runtimes, APIs)
- URLs and endpoints
- Team members and contacts
- Project status and milestones
- Environment configurations
- Check: is this fact still true? When was it stored? Has the underlying reality changed?

### Conflicts
Flag entries that contradict each other:
- "Database is PostgreSQL" vs "Database is MySQL" (which is current?)
- "Deploy with Docker" vs "Deploy to Vercel" (which is active?)
- Overlapping procedural memories with different steps

### Sensitivity
Flag entries that should NOT be stored in memory:
- API keys, tokens, secrets, passwords
- Personal identifiable information (PII) beyond basic preferences
- Credentials, connection strings with passwords
- Private URLs with embedded auth tokens

### Gaps
Identify knowledge that is frequently referenced but not memorized:
- Patterns the user corrects repeatedly (should be procedural memory)
- Facts that are re-discovered every session (should be semantic memory)
- Preferences the user re-states often (should be stored as facts)
- Workflows that are executed regularly (should be procedural memory)

---

## Phase 3: PROPOSE — Structured Change Plan

Present ALL proposed changes in a single table, grouped by action:

| # | Action | Tier | Current Content | Proposed Content | Reason |
|---|--------|------|----------------|-----------------|--------|
| 1 | DELETE | semantic | "API key is sk-abc123..." | (removed) | Contains credential — security risk |
| 2 | DELETE | episodic | "Session from 2025-01-15 about login bug" | (removed) | Stale — bug was fixed 6 months ago |
| 3 | MERGE | semantic | "User prefers JSON" + "User wants JSON format" | "User prefers JSON-formatted output" | Semantic duplicate — consolidate |
| 4 | MERGE | procedural | "deploy v1: test→build→push" + "deploy v2: lint→test→build→push" | "deploy: lint→test→build→push" | v2 supersedes v1 |
| 5 | PROMOTE | procedural | (from episodic) "Used swarm for parallel review 5 times" | "For parallel code review, use swarm with 3 workers (reuse, quality, efficiency)" | Repeated pattern — make explicit |
| 6 | ADD | semantic | (gap) | "Project uses TypeScript 5.x with strict mode" | Referenced in 4 sessions but never stored |
| 7 | UPDATE | semantic | "Node.js version: 18" | "Node.js version: 22" | Stale — project upgraded |
| 8 | ARCHIVE | episodic | "Migration from Express to Hono completed 2025-03" | (move to archive) | Historically interesting but no longer actionable |

Below the table, include:
- **Impact summary**: "X deletions, Y merges, Z additions, W updates"
- **Risk assessment**: "No high-risk changes" or "Items #1, #3 modify frequently-used memories — verify after applying"

### STOP AND WAIT

**Do NOT proceed until the user reviews and approves.** Present the table and ask:
- "Approve all changes?"
- "Or specify which items to approve/reject (e.g., 'approve all except #5')"

---

## Phase 4: APPLY — Execute Approved Changes

For each approved change, execute in this order:

1. **DELETEs first** — Remove sensitive or stale entries
2. **MERGEs second** — Consolidate duplicates (delete old entries, create merged entry)
3. **UPDATEs third** — Modify existing entries with current information
4. **PROMOTEs fourth** — Create new procedural/semantic entries from patterns
5. **ADDs last** — Create new entries for identified gaps

For each change applied:
- Log: "Applied #N: [ACTION] [TIER] — [brief description]"
- Verify: Confirm the change took effect (re-read the memory)

After all changes:
- Present a final summary: "Applied X/Y approved changes. Memory reduced from N to M entries."
- Note any changes that failed and why

---

## Rules

- **ALWAYS wait for user approval** — never modify memory without explicit confirmation
- **NEVER delete without confirmation** — even obviously stale entries need user sign-off
- **Show before/after for merges** — the user must see what's being combined and what the result looks like
- **Preserve useful context** — when merging, keep the most specific and actionable version
- **Flag but don't auto-delete sensitive data** — the user decides, you advise
- **Be thorough** — search with multiple queries per tier, don't stop at the first result
- **Check cross-tier redundancy** — the same fact might be stored in semantic memory AND workspace MEMORY.md
