# Spec: Memory Agent

## Problem

The personal agent is both the worker and the librarian. It must decide what to remember, how to retrieve, and when to forget — all while doing the user's actual task. These compete for attention and context window. The result:

1. **Write-time extraction is shallow.** Pattern-based `extractFacts()` catches `"I prefer..."` but misses nuanced decisions, evolving goals, and corrections that emerge across multi-turn sessions.
2. **No consolidation.** Facts accumulate monotonically. Duplicates, contradictions, and superseded facts coexist in the `facts` table with no reconciliation.
3. **No forgetting.** The only decay mechanism is a freshness warning after 1 day. Facts from months ago surface with full confidence.
4. **Retrieval is query-shaped.** `buildMemoryContext` uses the current user message as the search key. Thin messages ("let's continue", "same as before") produce poor retrieval. No re-ranking.
5. **Curated snapshots are static.** The `curated_memory` table is user-managed via the curated-memory tool. No automated refresh.

These map directly to the article's failure modes: derivation drift (problem 1), stale context dominance (problems 2-3), selective retrieval bias (problem 4), and confidence without provenance (problem 5).

## Solution

A dedicated **memory agent** — a first-class agent in the system — that owns all curation, consolidation, and decay responsibilities. The personal agent delegates memory to it the same way it delegates domain expertise to marketplace agents.

### Design principles

1. **Fat skill, thin harness.** The memory agent is a skill-driven agent. Its intelligence lives in `skills/public/memory-*` SKILL.md files, not in TS runtime code. The harness provides tools; the skills provide judgment.
2. **Three execution modes.** Post-session (async, after each session ends), periodic (scheduled, every 12h), and synchronous (called by personal agent for recall).
3. **Existing primitives only.** Uses `run-agent`, `create-schedule`, the `facts`/`episodes`/`procedures`/`curated_memory` tables, and Vectorize. No new infrastructure.
4. **Fail-open.** Memory agent failures never block the personal agent's work. Synchronous recall inherits `run-agent`'s poll loop but is bounded by `max_turns: 5`; on error the personal agent falls back to the existing `buildMemoryContext`.

## Architecture

```
Session ends
    │
    ▼
┌──────────────────────────────────────────────┐
│  Memory Agent — post-session digest          │
│  (async, fire-and-forget via run-agent)      │
│                                              │
│  Input: session transcript (episodes)        │
│  Output: upserted facts, updated curated     │
│          memory snapshot                      │
│                                              │
│  Skills: /memory-digest                      │
│  Tools: memory-save, memory-recall,          │
│         memory-delete, curated-memory        │
└──────────────────────────────────────────────┘

Every 12 hours (via create-schedule)
    │
    ▼
┌──────────────────────────────────────────────┐
│  Memory Agent — periodic consolidation       │
│                                              │
│  1. Scan all facts: detect duplicates,       │
│     contradictions, stale entries             │
│  2. Merge/archive/decay as needed            │
│  3. Rebuild curated_memory startup snapshot   │
│  4. Emit health metrics                      │
│                                              │
│  Skills: /memory-consolidate                 │
│  Tools: memory-save, memory-recall,          │
│         memory-delete, memory-health,        │
│         curated-memory                       │
└──────────────────────────────────────────────┘

Personal agent needs context
    │
    ▼
┌──────────────────────────────────────────────┐
│  Memory Agent — synchronous recall           │
│  (via run-agent, bounded by max_turns=5)     │
│                                              │
│  Input: query + conversation summary         │
│  Output: curated context block               │
│                                              │
│  Skills: /memory-recall-deep                 │
│  Tools: memory-recall, knowledge-search      │
│                                              │
│  Fallback: on error, personal agent falls    │
│  back to buildMemoryContext()                │
└──────────────────────────────────────────────┘
```

## What the memory agent is NOT

- **Not a RAG pipeline.** It doesn't chunk documents or build indexes. That's the existing `rag-hybrid.ts` / `rag-rerank.ts` layer.
- **Not a replacement for working memory.** Session-scoped state stays in-memory (`WorkingMemory` Map). The memory agent operates on cross-session persistence.
- **Not a tool rewrite.** `memory-save`, `memory-recall`, `memory-delete` remain as tools. The memory agent calls them — it doesn't replace them.
- **Not user-facing.** Users interact with memory through the personal agent. The memory agent is an internal service agent.

## Memory model changes

### Confidence decay

Facts gain a `last_reinforced_at` timestamp (defaults to `created_at`). When the memory agent encounters a fact in a new session, it bumps `last_reinforced_at`. During consolidation:

```
effective_confidence = confidence * decay_factor(days_since_last_reinforced)

decay_factor(days):
  days ≤ 7    → 1.0       (full confidence)
  days ≤ 30   → 0.9       (slight decay)
  days ≤ 90   → 0.7       (moderate decay)
  days > 90   → 0.5       (low confidence)
  days > 180  → archived   (moved out of active retrieval)
```

### Provenance tracking

Facts gain a `source_session_ids TEXT[]` field — the session IDs that contributed to or reinforced this fact. When the memory agent extracts or reinforces a fact, it appends the session ID. This enables:

- "Where did I learn this?" queries
- Cascade deletion when a user asks to forget a session
- Confidence grounding — facts backed by multiple sessions are more trustworthy

### Entity tagging

Facts gain an `entities TEXT[]` field — normalized entity names extracted during digestion. Enables:

- Entity-scoped retrieval ("what do I know about Project X?")
- Cross-fact relationship detection during consolidation
- Merge candidates: facts sharing entities are compared for contradiction

## Skill definitions

### `/memory-digest` (post-session)

```
Activation: automatic, after session end
Input: session_id, agent_name, org_id
Budget: 1 LLM call (the digest itself)
```

Reads the session's episodes. For each substantive interaction:

1. **Extract facts** — preferences, decisions, corrections, goals, project state changes. Goes beyond pattern matching: uses LLM judgment to identify what's worth remembering.
2. **Check for contradictions** — compares extracted facts against existing facts via `memory-recall`. If a new fact contradicts an old one, the new fact wins (more recent session) and the old fact is updated or archived.
3. **Reinforce existing facts** — if a session references a known fact without contradicting it, bump `last_reinforced_at`.
4. **Update curated snapshot** — rebuild the startup block with the most important, most recent, highest-confidence facts.

### `/memory-consolidate` (periodic)

```
Activation: scheduled, every 12 hours
Input: agent_name, org_id
Budget: 1-2 LLM calls
```

1. **Inventory** — fetch all facts, group by category and entity.
2. **Deduplicate** — semantic similarity check within groups. Merge facts that say the same thing differently.
3. **Resolve contradictions** — within groups, identify facts that conflict. Keep the most recently reinforced one; archive the other with a note.
4. **Decay** — apply the confidence decay function. Archive facts below threshold.
5. **Promote patterns** — scan recent episodes for repeated tool sequences not yet in procedural memory. Promote to procedures.
6. **Rebuild curated snapshot** — regenerate `curated_memory` from the cleaned fact corpus.
7. **Emit health** — log metrics: total facts, archived count, merged count, new procedures.

### `/memory-recall-deep` (synchronous via run-agent)

```
Activation: called by personal agent via run-agent tool
Input: query, conversation_summary (last 3 turns)
Timeout: inherits run-agent's poll loop (up to 5 min, but memory recall
         should complete in 1-2 turns — bounded by max_turns=5 on the agent config)
Budget: 1 LLM call
```

**Important constraint:** The current `run-agent` tool spawns a child Workflow via `AGENT_RUN_WORKFLOW` binding and polls for completion with a 5-minute ceiling (`150 × 2s`). There is no per-call timeout argument. The memory agent's `max_turns: 5` config is the practical bound — recall should complete in 1-2 turns. If faster response is needed in the future, a dedicated lightweight code path (not `run-agent`) can be added as an optimization.

1. **Multi-query retrieval** — expands the query into 2-3 semantic variants (e.g., "user's project" → also search "current work", "ongoing tasks").
2. **Cross-tier search** — searches facts, episodes, and procedures in parallel.
3. **Re-rank** — LLM-based relevance scoring against the conversation summary, not just the query.
4. **Format** — returns a curated context block, sized to the caller's token budget.

Fallback: if the memory agent errors or takes too long, the personal agent falls back to the existing `buildMemoryContext()` — no degradation from today's behavior.

## Agent configuration

```jsonc
{
  "name": "memory-agent",
  "system_prompt": "You are the memory curator for {{AGENT_NAME}}. You manage what the agent remembers across sessions...",
  "tools": [
    "memory-save",
    "memory-recall",
    "memory-delete",
    "memory-health",
    "curated-memory"
  ],
  "enabled_skills": [
    "memory-digest",
    "memory-consolidate",
    "memory-recall-deep"
  ],
  "model": "gemma-4",     // cheap model for curation tasks
  "max_turns": 5,         // curation is bounded work
  "internal": true        // not user-facing, not in marketplace
}
```

## Integration with personal agent

### Prompt changes (personal-agent.ts)

Replace the current memory protocol section:

```markdown
# Memory protocol

Your memory is managed by a dedicated memory agent. You don't need to decide
what to remember — it handles extraction, consolidation, and decay automatically
after each session.

- **Recall**: for complex queries where you need deep context, use
  `run-agent(agent_name="memory-agent", task="recall: <your question>")`.
  For simple lookups, `memory-recall` still works directly.
- **Explicit save**: if the user asks you to remember something specific,
  use `memory-save` directly — don't wait for the post-session digest.
- **Don't duplicate**: the memory agent processes every session. You don't need
  to save routine facts at session end.
```

### Runtime changes (workflow.ts)

The post-session trigger lives in `deploy/src/workflow.ts`, right after the existing `queueSessionEpisodicNote()` call (~L2348). The trigger spawns a child Workflow via the `AGENT_RUN_WORKFLOW` binding — the same mechanism `run-agent` uses — NOT via the deprecated control-plane `/agents/:name/run` endpoint (which returns `runtimeMovedToEdge()`).

```typescript
// Post-session: fire memory agent digest (fail-open)
// Spawns a child Workflow — same mechanism as run-agent tool at tools.ts:3164
try {
  const workflow = (this.env as any).AGENT_RUN_WORKFLOW;
  if (workflow) {
    await workflow.create({
      params: {
        agent_name: "memory-agent",
        input: `/memory-digest session_id=${sessionId} agent_name=${p.agent_name}`,
        org_id: p.org_id || "",
        project_id: "",
        channel: "internal",
        channel_user_id: "",
        history: [],
        progress_key: `memory-digest:${sessionId}`,
        parent_session_id: sessionId,
        parent_depth: 0,
      },
    });
    // Fire-and-forget: do NOT poll for completion
  }
} catch {
  // Memory digest is non-critical — fail silently
}
```

**Key difference from `run-agent`:** we call `workflow.create()` but do NOT poll for completion. The memory agent runs asynchronously — no blocking the session response.

### Schedule setup

Created once per org during onboarding (or via meta-agent):

```typescript
create-schedule({
  agent_name: "memory-agent",
  task: "/memory-consolidate",
  cron: "0 */12 * * *",  // every 12 hours
})
```

## Evaluation

### Unit-testable components

| Component | Test strategy |
|---|---|
| Confidence decay | Seed facts with known timestamps, run decay, assert confidence values |
| Deduplication | 20 facts with known duplicates, assert correct merges |
| Contradiction resolution | Pairs of contradictory facts with known timestamps, assert winner |
| Entity extraction | Session transcripts with labeled entities, assert extraction accuracy |
| Provenance tracking | Multi-session fact evolution, assert `source_session_ids` accuracy |

### Integration test

Round-trip regression (same pattern as Phase 6 skill learning loop test):

1. Seed 3 sessions with known content
2. Run `/memory-digest` on each
3. Assert facts table contains expected entries
4. Introduce contradicting session
5. Run `/memory-digest`, assert old fact archived, new fact active
6. Run `/memory-consolidate`, assert duplicates merged, stale facts decayed
7. Query `/memory-recall-deep`, assert relevant facts returned with provenance

### Eval fixtures (personal agent eval)

Add 3 fixtures to the existing eval suite (currently 20 fixtures — do not hardcode counts; gate on "all existing fixtures pass"):

1. **Memory continuity** — multi-session scenario where session 2 references session 1 facts. Assert the agent surfaces relevant context.
2. **Contradiction handling** — user corrects a previously stated preference. Assert old fact is superseded.
3. **Stale decay** — facts from 90+ days ago should surface with reduced confidence or not at all for routine queries.

## What this does NOT solve

Per the article's framework, this improves but doesn't eliminate:

- **Derivation drift** — LLM-based extraction is better than pattern matching but still lossy. The consolidation pass reduces drift but doesn't eliminate it.
- **The evaluation paradox** — we can test components but can't prove "the user feels remembered over 6 months" at scale.
- **Memory-induced bias** — the agent still sees its memories on every turn. Sometimes you want an uncolored take.

These are fundamental limitations of any memory system, not bugs in this design.
