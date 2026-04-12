# Plan: Memory Agent

A phased implementation plan for the memory agent described in `docs/spec-memory-agent.md`. Follows the same conventions as the thin-harness refactor plan: entry criteria, work items pinned to file:line, exit audits, rollback levers. Prototype mode — no canary rollouts.

## ▶︎ Resume here

**Status:** Not started. Spec complete (with review corrections applied). All phases below are pending.

### Review corrections applied (2026-04-12)

1. **P0 fix:** Post-session trigger uses `AGENT_RUN_WORKFLOW` child Workflow (fire-and-forget), NOT the deprecated `/agents/:name/run` control-plane endpoint.
2. **P0 fix:** Synchronous recall via `run-agent` inherits the 5-min poll ceiling — no custom timeout. Bounded by `max_turns: 5` on agent config.
3. **P1 fix:** `memory-save` upsert is SELECT→UPDATE/INSERT (not `ON CONFLICT`). Plan Phase 3 adapts the existing pattern.
4. **P1 fix:** Eval fixture counts are not hardcoded. Gates say "all existing fixtures pass" (currently 20).
5. **P1 fix:** Adding new non-builtin skills requires updating `NON_BUILTIN_ALLOWLIST` in `deploy/test/refactor-phase3.test.ts`.
6. **P2 fix:** Migration strategy — single `001_init.sql` only (prototype, no production data). No separate ALTER TABLE migration.
7. **PR slicing:** Plan phases now map to clean PR boundaries (Schema → Skills → Wiring → Decay → Eval).

---

## Phase 0 — Schema & baselines

**Goal:** Add the schema fields the memory agent needs. Establish baselines for memory quality so we can measure improvement.

**Entry criteria:**
- Thin-harness Phases 0-10 complete ✅
- Personal agent eval 8/8 green ✅
- `deploy/test` and `control-plane/test` green ✅

**Work items**

### 0.1 — Schema migration

File: `control-plane/src/db/migrations/001_init.sql` (facts table, ~L1198)

Add three columns to `facts`:

```sql
ALTER TABLE facts
  ADD COLUMN last_reinforced_at TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN source_session_ids TEXT[] DEFAULT '{}',
  ADD COLUMN entities TEXT[] DEFAULT '{}';
```

**Single migration strategy (`001_init.sql` only):**

This is a prototype with no production data. All schema changes go directly into the `CREATE TABLE` in `001_init.sql`. New environments get the complete schema from a single file. No separate ALTER TABLE migration.

Add the columns to the `facts` table definition:

```sql
-- After existing columns:
last_reinforced_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
source_session_ids  TEXT[]      NOT NULL DEFAULT '{}',
entities            TEXT[]      NOT NULL DEFAULT '{}',
```

Add a GIN index for entity-scoped queries:

```sql
CREATE INDEX IF NOT EXISTS idx_facts_entities ON facts USING GIN (entities);
```

### 0.2 — Memory quality baseline

Create `deploy/test/fixtures/memory_baseline.json`:

```json
{
  "measured_at": "2026-04-12",
  "fact_count_per_agent": "TBD (run memory-health)",
  "duplicate_rate": "TBD (manual audit of 50 facts)",
  "staleness": {
    "facts_older_than_30d": "TBD",
    "facts_older_than_90d": "TBD",
    "facts_never_reinforced": "TBD"
  },
  "retrieval_relevance": {
    "method": "manual: 10 queries, human-judged top-5 relevance",
    "precision_at_5": "TBD"
  }
}
```

This is a manual baseline — fill in after Phase 0.1 lands by running queries against a seeded agent. The numbers don't need to be perfect; they need to exist so Phase 4 can compare.

### 0.3 — Type updates

File: `deploy/src/runtime/types.ts`

If the `Fact` or `MemoryFact` interface exists in types, add the new fields. If facts are untyped (raw query results), add a typed interface:

```typescript
export interface MemoryFact {
  id: string;
  org_id: string;
  agent_name: string;
  key: string;
  value: string;
  content: string;
  fact_type: string;
  category: string;
  confidence: number;
  source: string;
  embedding_id?: string;
  verified: boolean;
  author_agent?: string;
  score?: number;
  created_at: string;
  updated_at: string;
  // Phase 0 additions:
  last_reinforced_at: string;
  source_session_ids: string[];
  entities: string[];
}
```

**Exit audit — "Schema Extended"**
- [ ] `001_init.sql` has the three new columns + GIN index
- [ ] Type definitions updated
- [ ] `deploy/test` green, `control-plane/test` green
- [ ] `memory_baseline.json` committed (even if TBD — the file must exist)

**Rollback:** Revert the migration changes. No runtime code depends on the new columns yet.

---

## Phase 1 — Skills: memory-digest and memory-consolidate

**Goal:** Write the SKILL.md files that define the memory agent's behavior. No runtime wiring yet — just the skills.

**Entry criteria:** Phase 0 complete.

### 1.1 — `/memory-digest` skill

Create `skills/public/memory-digest/SKILL.md`:

```yaml
---
name: memory-digest
description: "Process a completed session transcript: extract facts, resolve contradictions, reinforce existing knowledge, update curated memory."
category: memory
version: 1.0.0
enabled: true
allowed-tools:
  - memory-save
  - memory-recall
  - memory-delete
  - curated-memory
---
```

Body structure (the prompt template):

1. **Read session** — fetch episodes for the given `session_id` via `memory-recall type=episodic`.
2. **Extract facts** — for each substantive exchange, identify:
   - User preferences (stated or implied)
   - Decisions made and their rationale
   - Corrections to previous understanding
   - Project state changes (new tools, new goals, completed milestones)
   - Entity mentions (people, projects, services, repos)
3. **Contradiction check** — for each extracted fact, query existing facts via `memory-recall`. If contradiction found:
   - If new fact is from a more recent session → update old fact, append source_session_id
   - If ambiguous → save both, flag for consolidation
4. **Reinforce** — for facts referenced but not contradicted, bump `last_reinforced_at` via `memory-save` (upsert by key)
5. **Save** — write new facts via `memory-save` with:
   - `category`: user/feedback/project/reference (same as existing)
   - `entities`: extracted entity names, normalized to lowercase
   - `source_session_ids`: `[session_id]`
6. **Update curated snapshot** — call `curated-memory` action=replace to rebuild the startup block from top-confidence facts

**Key constraint:** Budget is 1 LLM call for the digest itself (the skill body IS the LLM call). Tool calls within the skill are deterministic DB operations, not additional LLM calls.

### 1.2 — `/memory-consolidate` skill

Create `skills/public/memory-consolidate/SKILL.md`:

```yaml
---
name: memory-consolidate
description: "Periodic memory maintenance: deduplicate facts, resolve contradictions, decay stale entries, promote patterns to procedures, rebuild curated snapshot."
category: memory
version: 1.0.0
enabled: true
allowed-tools:
  - memory-save
  - memory-recall
  - memory-delete
  - memory-health
  - curated-memory
---
```

Body structure:

1. **Inventory** — call `memory-health` for counts, then `memory-recall` with broad queries to fetch all facts grouped by category.
2. **Deduplicate** — within each category, identify semantic duplicates (same meaning, different wording). Merge: keep the higher-confidence entry, append the other's `source_session_ids`, delete the duplicate.
3. **Resolve contradictions** — within entity groups, find facts that conflict. Keep the most recently reinforced; archive the other (set confidence to 0, prepend `[ARCHIVED]` to key).
4. **Decay** — for each fact, compute `effective_confidence`:
   - `days = now - last_reinforced_at`
   - Apply decay curve from spec
   - If effective_confidence < 0.3 → archive
   - If effective_confidence < 0.5 → reduce stored confidence by 0.1
5. **Promote** — scan recent episodes (last 7 days) for repeated tool sequences (≥3 occurrences of same pattern). If not already in procedural memory, create a procedure entry.
6. **Rebuild curated snapshot** — regenerate `curated_memory` from top-10 highest-confidence, most-recently-reinforced facts.
7. **Report** — output a structured summary: `{merged: N, archived: N, decayed: N, promoted: N, total_active: N}`.

### 1.3 — `/memory-recall-deep` skill

Create `skills/public/memory-recall-deep/SKILL.md`:

```yaml
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
```

Body structure:

1. **Query expansion** — given the input query and conversation summary, generate 2-3 semantic variants. E.g., "what are we working on?" → also search "current project", "recent tasks", "ongoing work".
2. **Parallel search** — call `memory-recall` for each variant across types (semantic, episodic).
3. **Deduplicate results** — merge results from all queries, remove duplicates by fact ID.
4. **Re-rank** — score each result against the full conversation summary (not just the query). Criteria: recency, confidence, entity overlap with conversation, category relevance.
5. **Format** — return a markdown block sized to the caller's budget (default 2000 chars), structured as:
   ```
   [Relevant Context]
   - fact1 (confidence: 0.9, last confirmed: 2d ago)
   - fact2 ...
   
   [Recent Activity]
   - episode summary ...
   
   [Applicable Procedures]
   - procedure ...
   ```

### 1.4 — Bundle regeneration + allowlist update

Run `deploy/scripts/bundle-skills.mjs` to add the three new skills to `skills-manifest.generated.ts`.

**Do NOT add to `BUILTIN_SKILL_ORDER`.** These skills are agent-specific (memory-agent only), referenced via `enabled_skills` in the agent config.

**Required:** Update `NON_BUILTIN_ALLOWLIST` in `deploy/test/refactor-phase3.test.ts` (~L35) to include the three new skills:

```typescript
const NON_BUILTIN_ALLOWLIST = new Set([
  "code-review", "deep-research", "diarize", "improve",
  "memory-digest", "memory-consolidate", "memory-recall-deep",
]);
```

Without this, the Phase 3 invariant test ("every SKILL.md on disk is wired into BUILTIN_SKILLS or explicitly allowlisted") will fail.

**Exit audit — "Skills Authored"**
- [ ] Three new SKILL.md files in `skills/public/memory-{digest,consolidate,recall-deep}/`
- [ ] `bundle-skills.mjs` runs clean, manifest regenerated
- [ ] New skills NOT in `BUILTIN_SKILL_ORDER`
- [ ] `NON_BUILTIN_ALLOWLIST` updated with all three skill names
- [ ] Existing skill hashes unchanged (Phase 0 drift guard green)
- [ ] `deploy/test` green (including refactor-phase3 invariant test)

**Rollback:** Delete the three `skills/public/memory-*` directories. Rebundle.

---

## Phase 2 — Agent config & wiring

**Goal:** Create the memory agent as a first-class agent and wire the post-session digest trigger.

**Entry criteria:** Phase 1 complete.

### 2.1 — Memory agent config

Create the agent via the existing agent creation flow (either `meta-agent` or direct DB insert for prototype). Config:

```jsonc
{
  "name": "memory-agent",
  "display_name": "Memory Agent",
  "system_prompt": "You are the memory curator. You manage what agents remember across sessions. You extract facts from conversations, consolidate knowledge over time, resolve contradictions, and ensure the most relevant context is always available. You never interact with users directly — you work behind the scenes.",
  "tools": ["memory-save", "memory-recall", "memory-delete", "memory-health", "curated-memory"],
  "enabled_skills": ["memory-digest", "memory-consolidate", "memory-recall-deep"],
  "model": "gemma-4",
  "max_turns": 5,
  "version": "1.0.0"
}
```

The system prompt is intentionally lean (~50 words). All operational detail lives in the skills. This follows the Phase 10 pattern established for the personal agent (19.5K → 6.6K by moving content to skills).

### 2.2 — Post-session digest trigger

File: `deploy/src/workflow.ts` (~L2348, right after `queueSessionEpisodicNote()`)

**Important:** The control-plane `/agents/:name/run` endpoint is deprecated — it returns `runtimeMovedToEdge()` (see `control-plane/src/routes/agents.ts:1799`). The correct invocation path is spawning a child Workflow via the `AGENT_RUN_WORKFLOW` binding — the same mechanism the `run-agent` tool uses at `tools.ts:3164`.

```typescript
// Post-session: fire memory agent digest (fail-open)
// Uses AGENT_RUN_WORKFLOW binding — same as run-agent tool (tools.ts:3164)
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
    // Fire-and-forget: do NOT poll for completion (unlike run-agent which polls)
  }
} catch {
  // Memory digest is non-critical — fail silently
}
```

**Key difference from `run-agent`:** we call `workflow.create()` but skip the 150-iteration poll loop. The memory agent runs fully async — the session response is never blocked.

**Test requirement:** Add a failure-path test proving the personal agent's session completes normally when `AGENT_RUN_WORKFLOW` is undefined or `workflow.create()` throws. This is the fail-open guarantee.

### 2.3 — Periodic consolidation schedule

Create the schedule during org onboarding or via a one-time setup script:

```typescript
// In org setup or run manually:
await createSchedule({
  agent_name: "memory-agent",
  task: "/memory-consolidate",
  cron: "0 */12 * * *",
  org_id: orgId,
});
```

### 2.4 — Personal agent prompt update

File: `control-plane/src/prompts/personal-agent.ts` (~L72-79)

Replace the memory protocol section. The new section should be shorter (the memory agent handles the complexity):

```markdown
# Memory protocol

Your memory is managed by a dedicated memory agent that processes every session
after it ends. You don't need to decide what to remember for routine interactions.

- **Recall**: `memory-recall` works for simple lookups. For complex queries
  needing deep context, use `run-agent(agent_name="memory-agent", task="recall: <question>")`.
  Note: this spawns a child workflow — use only when deeper context is worth the latency.
- **Explicit save**: if the user says "remember this", use `memory-save` directly.
- **Don't duplicate**: skip end-of-session memory saves — the memory agent handles it.
```

**Prompt budget impact:** The new section is shorter than the current one (~4 lines vs ~6 lines). No fixture bump needed.

### 2.5 — Fallback in buildMemoryContext

File: `deploy/src/runtime/memory.ts` (~L733)

No changes to `buildMemoryContext` itself. It remains the fallback path. The memory agent's `/memory-recall-deep` is an optional upgrade path that the personal agent can choose to use via `run-agent`. If the memory agent is unavailable, `buildMemoryContext` continues to work exactly as today.

**Exit audit — "Agent Wired"**
- [ ] Memory agent config exists in the system (DB row or seed file)
- [ ] Post-session digest fires (verify via log or test)
- [ ] Schedule created (verify via `list-schedules`)
- [ ] Personal agent prompt updated, prompt budget unchanged or decreased
- [ ] Fallback path (`buildMemoryContext`) unchanged and tested
- [ ] `deploy/test` green, `control-plane/test` green

**Rollback:** Delete the agent config. Remove the post-session trigger (3 lines). Delete the schedule. Revert the prompt change. Zero residual impact.

---

## Phase 3 — Decay, consolidation, and reinforcement logic

**Goal:** Implement the confidence decay and reinforcement mechanics in the memory tools so the skills can use them.

**Entry criteria:** Phase 2 complete.

### 3.1 — `memory-save` upsert: reinforcement

File: `deploy/src/runtime/tools.ts` (`memorySave` function, ~L5045-5115)

**Current pattern:** `memorySave` does a manual `SELECT id FROM facts WHERE agent_name AND org_id AND key` then branches to `UPDATE` or `INSERT` (not `ON CONFLICT`). Adapt the existing pattern — do NOT rewrite to `ON CONFLICT`:

```typescript
// Existing UPDATE branch (~L5098):
if (existing.length > 0) {
  await sql`
    UPDATE facts SET
      value = ${content},
      category = ${category},
      updated_at = ${now},
      last_reinforced_at = ${now},
      source_session_ids = array_append(
        COALESCE(source_session_ids, '{}'),
        ${sessionId}
      ),
      entities = COALESCE(${entities}::text[], entities)
    WHERE id = ${existing[0].id}
  `;
}

// Existing INSERT branch (~L5103):
else {
  await sql`
    INSERT INTO facts (id, agent_name, org_id, scope, key, value, category,
                       created_at, last_reinforced_at, source_session_ids, entities)
    VALUES (${id}, ${agentName}, ${orgId}, 'agent', ${factKey}, ${content}, ${category},
            ${now}, ${now}, ${sessionId ? `{${sessionId}}` : '{}'}, ${entities || '{}'})
  `;
}
```

Where `sessionId` comes from `(env as any).__delegationLineage?.session_id || ""` and `entities` from `args.entities || null`.

### 3.2 — `memory-save` new arg: entities

Add `entities` as an optional argument to the `memory-save` tool schema:

```typescript
entities: {
  type: "array",
  items: { type: "string" },
  description: "Entity names this fact relates to (people, projects, services). Lowercase, normalized.",
}
```

### 3.3 — Decay function

File: `deploy/src/runtime/memory.ts` (new export, near `memoryFreshnessNote`)

```typescript
export function effectiveConfidence(
  confidence: number,
  lastReinforcedAt: string | number,
): number {
  const days = (Date.now() - new Date(lastReinforcedAt).getTime()) / 86_400_000;
  if (days <= 7) return confidence;
  if (days <= 30) return confidence * 0.9;
  if (days <= 90) return confidence * 0.7;
  if (days <= 180) return confidence * 0.5;
  return 0; // archive threshold
}
```

This is a pure function — no DB writes. The consolidation skill calls it to decide what to archive. The retrieval path can also use it for ranking.

### 3.4 — `buildMemoryContext` uses effective confidence for ranking

File: `deploy/src/runtime/memory.ts` (~L782-788)

In the facts section of `buildMemoryContext`, sort by `effectiveConfidence` descending before truncation:

```typescript
// Before:
const factLines = facts.map((f) => { ... });

// After:
const rankedFacts = facts
  .map(f => ({ ...f, effConf: effectiveConfidence(f.confidence, f.last_reinforced_at || f.created_at) }))
  .filter(f => f.effConf > 0.1)  // skip near-archived
  .sort((a, b) => b.effConf - a.effConf);
const factLines = rankedFacts.map((f) => { ... });
```

### 3.5 — Tests

File: `deploy/test/memory-decay.test.ts` (new)

```typescript
import { effectiveConfidence } from "../src/runtime/memory";

describe("effectiveConfidence", () => {
  it("returns full confidence within 7 days", () => { ... });
  it("decays to 0.9x at 15 days", () => { ... });
  it("decays to 0.7x at 60 days", () => { ... });
  it("decays to 0.5x at 120 days", () => { ... });
  it("returns 0 beyond 180 days", () => { ... });
  it("handles missing last_reinforced_at (falls back to created_at)", () => { ... });
});
```

**Exit audit — "Decay Mechanics Live"**
- [ ] `memory-save` upsert includes `last_reinforced_at` and `source_session_ids`
- [ ] `entities` arg accepted by `memory-save`
- [ ] `effectiveConfidence` exported and tested
- [ ] `buildMemoryContext` ranks by effective confidence
- [ ] `deploy/test` green, including new decay tests
- [ ] LoC budget: `tools.ts` within ceiling (the upsert change is ~5 lines net; if at ceiling, offset with a trim elsewhere in the tool)
- [ ] `memory.ts` LoC increase ≤ 20 lines

**Rollback:** Revert the tool and memory changes. The new columns are backward-compatible (DEFAULT values), so no schema rollback needed.

---

## Phase 4 — Integration test & eval

**Goal:** Prove the memory agent works end-to-end. Add eval fixtures for memory quality.

**Entry criteria:** Phase 3 complete.

### 4.1 — Integration test

File: `deploy/test/memory-agent-integration.test.ts` (new)

Round-trip test (same pattern as Phase 6 skill learning loop):

1. **Setup:** Seed 3 mock sessions with known content:
   - Session A: user states preference ("I prefer dark mode")
   - Session B: user mentions project ("working on Project Atlas, deadline April 30")
   - Session C: user corrects preference ("actually, light mode is better")

2. **Digest:** Simulate `/memory-digest` for each session in order. Assert:
   - After A: fact exists with key ~"user_preference_theme", value ~"dark mode"
   - After B: fact exists with entity "project atlas", source_session_ids includes B
   - After C: dark mode fact is updated/archived, light mode fact is active

3. **Consolidate:** Simulate `/memory-consolidate`. Assert:
   - No duplicate theme facts remain
   - Project Atlas fact has `last_reinforced_at` unchanged (only mentioned once)
   - Stale seeded facts (180+ days) are archived

4. **Recall:** Simulate `/memory-recall-deep` with query "what theme does the user prefer?". Assert:
   - Returns "light mode" (not dark mode)
   - Includes provenance (session C)

### 4.2 — Eval fixtures

File: `deploy/personal-agent-eval/fixtures/inputs.ts`

Add 3 fixtures to the existing suite (currently 20 fixtures — verify count at implementation time; do not hardcode):

**Fixture N — Memory continuity:**
```typescript
{
  name: "memory-continuity",
  input: "Let's pick up where we left off on the API migration",
  context: { seeded_facts: [{ key: "current_project", content: "Migrating REST API to GraphQL, 60% complete" }] },
  expected: "references the GraphQL migration without being told about it",
}
```

**Fixture N+1 — Contradiction handling:**
```typescript
{
  name: "memory-contradiction",
  input: "Actually we switched to tRPC, not GraphQL",
  context: { seeded_facts: [{ key: "current_project", content: "Migrating REST API to GraphQL" }] },
  expected: "acknowledges the correction, does not reference GraphQL as current",
}
```

**Fixture N+2 — Stale decay:**
```typescript
{
  name: "memory-stale-decay",
  input: "What tools am I using?",
  context: {
    seeded_facts: [
      { key: "editor", content: "Uses Sublime Text", created_at: "2025-10-01", last_reinforced_at: "2025-10-01" },
      { key: "editor_v2", content: "Uses VS Code with Vim bindings", created_at: "2026-04-01", last_reinforced_at: "2026-04-10" },
    ],
  },
  expected: "mentions VS Code, does not mention Sublime Text",
}
```

### 4.3 — Measure improvement

Re-run the memory quality baseline from Phase 0.2. Compare:

- Duplicate rate: should decrease (consolidation merges)
- Stale fact count: should decrease (decay archives)
- Retrieval precision@5: should increase (confidence ranking + re-ranking)

Update `memory_baseline.json` with post-implementation numbers.

**Exit audit — "Memory Agent Substrate Complete"**
- [x] Integration test green (`memory-agent-integration.test.ts` — 8 tests)
- [x] 3 new eval fixtures added (`memory-explicit-save`, `memory-no-save-trivial`, `memory-deep-recall`)
- [x] All eval fixtures pass on 3 models (2026-04-12):
  - Kimi K2.5: 4/4 passed (deep-recall tool_selection=2 — used discover-api first, still passed threshold)
  - Gemma 4 31B: 4/4 passed (5.0 avg across all fixtures)
  - Claude Haiku 4.5: 4/4 passed (5.0 avg across all fixtures)
- [x] All existing unit tests green (no regressions)
- [x] deploy: 561/561, control-plane: 831/831
- [ ] Memory baseline numbers filled in `memory_baseline.json` (requires seeded agent data)

**Rollback:** Revert Phase 4 test additions. The memory agent continues to run but without eval coverage.

---

## Phase 4.5 (next) — Validation rollout: replay → shadow → A/B

**Goal:** Validate that the memory agent improves user experience before full rollout. Three stages, each gated on the previous.

**Entry criteria:** Phase 4 complete, all eval fixtures green.

### Stage 1: Offline replay

Re-run historical sessions through both paths and compare:

- **Path A (baseline):** `buildMemoryContext()` with no decay, no ranking, no digest.
- **Path B (memory agent):** `buildMemoryContext()` with `effectiveConfidence` ranking + post-session digest simulation.

**Method:** Extract recent sessions from `episodes` table. For each, compute the memory context that would have been injected under both paths. Score:

| Metric | How to measure |
|---|---|
| Contradiction correctness | Manual review: does path B surface the corrected fact, not the old one? |
| Stale-fact injection rate | Count facts with `effectiveConfidence < 0.3` that appear in context |
| Retrieval precision@5 | Human-judged: are the top 5 facts relevant to the session's query? |
| Ranking stability | Do the same queries return the same top facts across runs? |

**Gate:** Path B must equal or beat Path A on all 4 metrics. Any regression blocks Stage 2.

### Stage 2: Shadow mode

Deploy the memory agent trigger but **log deltas only** — no user-visible changes.

1. Post-session digest fires as implemented (already fail-open).
2. Add a shadow comparison: on each turn, compute `buildMemoryContext` with and without decay ranking. Log the delta to telemetry (`memory_shadow_delta` event).
3. Monitor for 48-72 hours:
   - Digest trigger success rate (target: >95%)
   - Fail-open fallback frequency (target: <5%)
   - Added latency from digest spawn (target: <50ms p95)
   - Token cost per session (target: <5% increase)

**Gate:** All targets met for 48+ hours. Any sustained miss blocks Stage 3.

### Stage 3: True A/B rollout

Route a percentage of sessions through the full memory agent path:

1. **5% initial rollout** — 1 week.
2. **25% ramp** — if no quality regression.
3. **50% → 100%** — based on metrics.

**A/B split:** By `org_id` hash (sticky per user). Controlled by a config flag in `curated_memory_config` table (already has per-agent settings).

**Metrics to track:**

| Category | Metric | Source |
|---|---|---|
| Quality | Contradiction resolution accuracy | Manual review sample (20/week) |
| Quality | Relevance@k improvement | Judge eval on sampled turns |
| Quality | "You forgot" complaint rate | User message pattern detection |
| Behavior | Explicit-save compliance | `memory_write` telemetry events |
| Behavior | Deep-recall invocation rate | `run-agent` calls to `memory-agent` |
| Reliability | Digest success rate | Workflow completion events |
| Reliability | Fail-open frequency | `memory-digest` catch block hits |
| Performance | p95 session latency | Existing latency telemetry |
| Performance | Token cost per session | `cost_usd` on sessions table |

**Stop conditions (auto-revert to 0%):**
- Quality: judge score drops >0.5 on any dimension vs. control
- Reliability: digest success rate <90% for 1 hour
- Performance: p95 latency increase >500ms sustained for 30 min
- Cost: per-session cost increase >15%

**Rollback:** Set A/B split to 0%. Memory agent trigger still fires but digest output is ignored. No code change needed.

---

## Phase 5 (future) — Entity graph

**Deferred.** Not in scope for initial implementation.

If memory quality plateaus, the next lever is an entity graph layer:

- Extract entities during digest → store in a `memory_entities` table with relationships
- During recall, traverse the graph: "Project Atlas" → "uses tRPC" → "tRPC needs Node 20+"
- Enables multi-hop retrieval that flat fact search can't do

This requires a graph traversal primitive (either a new table with adjacency lists or a dedicated graph DB). Deferred until the flat-fact approach proves insufficient.

## Phase 6 (future) — Multi-agent memory sharing

**Deferred.** The `team-memory.ts` layer already exists. When multiple agents share an org, the memory agent could:

- Cross-pollinate facts between agents (agent A learns something relevant to agent B)
- Maintain a shared entity graph across all agents
- Deduplicate across agent boundaries

This requires careful scoping of what's agent-private vs. org-shared. Deferred until multi-agent is a real use case.

---

## Related: Harness hardening

Code review during the memory agent build surfaced 5 harness-level gaps (structured verification, planning contracts, mailbox approval wiring, path ACLs, simplicity budgets). These are **not memory-specific** — they apply to the runtime broadly. Tracked separately in:

- `docs/spec-harness-hardening-v1.md`
- `docs/plan-harness-hardening-v1.md`

Memory agent rollout does not depend on harness hardening. Ship independently.

---

## PR slicing

Each phase maps to a single PR for clean review and rollback:

| PR | Phase | Scope | Gate |
|---|---|---|---|
| **PR-A** | Phase 0 | Schema + type contract only. No behavior changes. | `control-plane` + `deploy` tests green |
| **PR-B** | Phase 1 | Skills only. Three SKILL.md files + bundle regen + allowlist update. | Bundler clean, `refactor-phase3` test passes |
| **PR-C** | Phase 2 | Runtime wiring. Agent config, workflow trigger, schedule, prompt update. | Fail-open test proving session completes when memory-agent trigger fails |
| **PR-D** | Phase 3 | Decay/reinforcement mechanics. `effectiveConfidence()`, `memory-save` contract extension. | Deterministic unit tests around decay thresholds |
| **PR-E** | Phase 4 | Eval + integration test. | All existing fixtures pass + new memory fixtures pass |
| **PR-F** | Phase 4.5 | Validation rollout: replay → shadow → A/B. | Stage-gated: each stage passes before next begins |

PRs A-E are independent enough to land in order but review in parallel. PR-A and PR-B have zero runtime overlap and can be developed concurrently. PR-F is sequential — each stage gates the next.

---

## Invariants (never violated during implementation)

1. **Memory agent failures never block the personal agent.** Every call is wrapped in try/catch with fail-open semantics. If the memory agent is down, the personal agent falls back to `buildMemoryContext()` — identical to today's behavior.
2. **No schema breaks.** New columns have DEFAULT values. Existing queries work unchanged. The memory agent's queries are additive.
3. **Skills are the source of truth.** The memory agent's behavior is defined in SKILL.md files, not in TS runtime code. Changing behavior = editing markdown, not redeploying the worker.
4. **Existing memory tools unchanged.** `memory-save`, `memory-recall`, `memory-delete` keep their current interfaces. New fields (`entities`, `source_session_ids`) are optional args.
5. **Eval pass-rate is the gate.** All existing fixtures must pass (do not hardcode count — verify at implementation time). The 3 new fixtures are additive.
6. **LoC budgets respected.** `tools.ts` changes are ≤10 lines net. `memory.ts` changes are ≤30 lines net. If at ceiling, offset with trims.
7. **Prototype mode.** No feature flags. The memory agent is either wired or not. Rollback = git revert.
