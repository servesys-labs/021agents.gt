---
name: memory-digest
description: "Process a completed session: extract facts, resolve contradictions, reinforce existing knowledge, update curated memory."
category: memory
version: 1.0.0
enabled: true
allowed-tools:
  - memory-save
  - memory-recall
  - memory-delete
  - curated-memory
---
You are executing the /memory-digest skill. Context: {{ARGS}}

# Memory Digest: Post-Session Processing

You process a completed session transcript and update the agent's long-term memory. This runs automatically after each session ends — the user does not see your output.

---

## Step 1: READ — Fetch the triggering evidence

Parse the args for:
- `session_id`
- `agent_name`
- optional passive-signal fields: `signal_briefing`, `signal_type`, `signal_topic`, `signal_entities`, `signal_session_ids`

### Normal post-session digest

If `signal_briefing` is absent, use `memory-recall` with `type=episodic` to fetch the session's interactions for the provided `session_id`.

If no episodes are found for this session, stop — nothing to digest.

### Passive signal-driven digest

If `signal_briefing` is present, this digest was triggered by buffered telemetry rather than only session end. Treat it as **multi-session evidence**:

1. Read episodic memory for every session listed in `signal_session_ids`.
2. Read additional episodic memory using broad queries around `signal_topic` and `signal_entities`.
3. Use `signal_briefing` as a prioritization hint: it tells you what recurrence, bug cluster, contradiction churn, or topic pattern triggered this run.
4. Do NOT stop just because the primary `session_id` has thin data — the point of this run is to combine evidence across sessions.

The goal is to digest the pattern, not only the latest session.

---

## Step 2: EXTRACT — Identify facts worth remembering

For each substantive exchange in the source evidence, identify:

- **User preferences** — stated or implied (tools, formats, communication style, timezone)
- **Decisions** — choices made and their rationale ("we went with tRPC because...")
- **Corrections** — user correcting a previous understanding ("actually, it's X not Y")
- **Project state** — new goals, completed milestones, blockers, deadlines
- **Entity mentions** — people, projects, services, repos, technologies
- **Recurring failures or bugs** — repeated breakages, dead ends, loops, unstable tools, brittle assumptions
- **Operational lessons** — patterns like "browser-open fails on X pages" or "this repo's build breaks when Y is missing"

Skip ephemeral details: greetings, acknowledgments, one-word confirmations, tool output noise.

If this is a passive signal run, prefer facts and lessons that are supported by **multiple sessions** or repeated evidence. A one-off transient error is weaker than a recurring cluster.

For each extracted fact, prepare:
- `key`: short identifier (e.g., "user_preference_editor", "project_atlas_deadline")
- `content`: the fact in one sentence
- `category`: user | feedback | project | reference
- `entities`: lowercase normalized entity names (e.g., ["project atlas", "trpc"])

---

## Step 3: RECONCILE — Check against existing memory

For each extracted fact, call `memory-recall` with the fact's key, topic, and entity names to find existing related facts.

**If a contradiction is found:**
- The new fact wins (more recent session). Update the old fact via `memory-save` with the new content, or delete it via `memory-delete` if fully superseded.
- Include both source session IDs in the updated fact.

**If a duplicate is found:**
- Do not create a new entry. Instead, reinforce the existing fact by calling `memory-save` with the same key (upsert updates the fact). Note: automatic `last_reinforced_at` bumping requires PR-D; until then, the upsert still updates `updated_at`.

**If the fact is new:**
- Save via `memory-save` with the extracted key, content, and category. Note: `entities` and `source_session_ids` fields on `memory-save` require PR-D (decay/reinforcement mechanics) to be landed. Until then, save with key, content, category only — the memory agent will backfill provenance in a future consolidation pass.

If `signal_briefing` is present, bias toward saving:
- repeated corrections
- repeated bug clusters
- recurring topic/state changes across sessions
- stable lessons that help future runs avoid the same failure

---

## Step 4: UPDATE CURATED SNAPSHOT

After all facts are processed, ensure the curated memory startup block reflects the changes from this digest. The `curated-memory` tool operates on individual entries (not bulk replace), so work incrementally:

1. Call `memory-recall` broadly to get the current top facts by recency and category.
2. Identify the 8-10 most important facts — prefer: user identity, active project context, recent corrections, stated preferences.
3. For any NEW fact from this session that belongs in the startup snapshot, call `curated-memory` with `action=add`, `target=memory`, `content=<one-line fact summary>`.
4. For any SUPERSEDED fact (e.g., a corrected preference), call `curated-memory` with `action=remove`, `target=memory`, `old_text=<unique substring of the old entry>` — then `action=add` with the corrected content.
5. Do NOT attempt to replace the entire snapshot at once. Add/remove only what changed in this session.

---

## Rules

- **Never surface to the user.** This skill runs in the background. No conversational output.
- **Be selective.** Not every turn produces a fact. A 3-turn "what's the capital of France" session has nothing to extract.
- **Passive digests are evidence-driven.** When `signal_briefing` is present, look for cross-session patterns and operational lessons, not only user profile facts.
- **Prefer updates over additions.** If a fact already exists and the session merely confirms it, reinforce — don't duplicate.
- **Normalize entities.** Lowercase, trim whitespace, use canonical names ("vs code" not "Visual Studio Code").
- **One LLM pass.** Extract all facts from the session in a single analysis, then execute tool calls to persist them. Do not make multiple LLM calls for individual facts.
