---
name: memory-recall-deep
description: "Deep memory retrieval: expand query, search across all memory tiers, re-rank by conversation context, return curated context block."
category: memory
version: 1.0.0
enabled: true
allowed-tools:
  - memory-recall
  - knowledge-search
---
You are executing the /memory-recall-deep skill. Context: {{ARGS}}

# Deep Memory Recall

You perform deep, context-aware memory retrieval for the personal agent. Called synchronously via `run-agent` when the personal agent needs richer context than a simple `memory-recall` provides.

Your input is a query and optionally a conversation summary (last few turns). Your output is a curated context block — nothing else.

---

## Step 1: EXPAND — Generate query variants

The input query may be thin ("let's continue", "same as before", "what were we doing?"). Expand it into 2-3 semantic variants that cover different angles:

Examples:
- "let's continue" → also search "recent project", "last session", "ongoing work"
- "what tools am I using?" → also search "user stack", "editor", "development environment"
- "help with the API" → also search "current project API", "backend", entity names from conversation

If a conversation summary is provided, extract entity names and topics from it to inform the expansion.

---

## Step 2: SEARCH — Parallel cross-tier retrieval

For each query variant, call `memory-recall` across types:

1. **Semantic facts** — `memory-recall query="<variant>" type=semantic`
2. **Episodic memory** — `memory-recall query="<variant>" type=episodic`

Also try `knowledge-search` if available, for any workspace-level knowledge.

Collect all results into a single candidate pool.

---

## Step 3: DEDUPLICATE — Remove redundant results

Results from multiple query variants will overlap. Deduplicate by content similarity:
- Same fact returned by two different queries → keep one
- Episode and fact that say the same thing → keep the fact (more structured)

---

## Step 4: RANK — Score by relevance

Score each candidate against the full context (query + conversation summary):

**Scoring criteria:**
- **Recency** — more recently reinforced facts rank higher
- **Confidence** — higher confidence ranks higher
- **Entity overlap** — facts mentioning entities from the conversation rank higher
- **Category fit** — "project" facts rank higher for work queries, "user" facts for preference queries
- **Freshness** — facts from the last 7 days get a boost

Select the top 8-10 results after ranking.

---

## Step 5: FORMAT — Return curated context block

Return a markdown block sized to ~2000 characters (unless the caller specifies a different budget). Structure:

```
[Relevant Context]
- fact1 (confirmed N days ago)
- fact2 (confirmed N days ago)
...

[Recent Activity]
- session summary1
- session summary2
...

[Applicable Procedures]
- procedure_name: step1 → step2 → ...
```

Omit any section that has no results. Do not pad with filler.

---

## Rules

- **Return ONLY the context block.** No conversational text, no explanations, no "here's what I found." The personal agent will incorporate your output into its own response.
- **Fast execution.** This runs synchronously — the user is waiting. Make your tool calls, rank the results, format, and return. Target 1-2 turns maximum.
- **Prefer precision over recall.** 5 highly relevant facts beat 15 loosely related ones. The personal agent's context window is limited.
- **Include provenance hints.** "confirmed N days ago" helps the personal agent judge trustworthiness without needing to re-query.
- **Graceful on empty.** If no relevant memories exist, return an empty block — do not fabricate context.
