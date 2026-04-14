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
You are executing the /memory-consolidate skill. Context: {{ARGS}}

# Memory Consolidation: Periodic Maintenance

You perform scheduled maintenance on the agent's long-term memory. This runs every 12 hours — the user does not see your output.

---

## Step 1: INVENTORY — Assess current state and trigger context

Parse the args for:
- `session_id`
- `agent_name`
- optional passive-signal fields: `signal_briefing`, `signal_type`, `signal_topic`, `signal_entities`, `signal_session_ids`

Call `memory-health` to get counts and staleness metrics.

Then call `memory-recall` with broad queries to fetch all facts, grouped mentally by category:
- Query "user" for user-scoped facts
- Query "project" for project-scoped facts
- Query "feedback" for feedback/corrections
- Query "reference" for external pointers

Note the total count, oldest entries, and any obvious clusters.

If `signal_briefing` is present, prioritize the cluster described by the signal:
- fetch episodic memory for each `signal_session_ids` session
- fetch related facts using `signal_topic` and `signal_entities`
- treat the signal as evidence that this area is unstable or recurring

---

## Step 2: DEDUPLICATE — Merge semantic duplicates

Within each category, identify facts that say the same thing differently:
- "User prefers dark mode" and "User wants dark theme" → merge into one
- "Project uses TypeScript" and "Stack is TypeScript on Workers" → keep the more specific one

For each duplicate pair:
1. Keep the entry that is more specific or more recently updated
2. Delete the other via `memory-delete`
3. If the survivor's wording can be improved by combining both entries, re-save it via `memory-save` with the merged content

---

## Step 3: RESOLVE CONTRADICTIONS — Pick winners

Within entity groups, find facts that conflict:
- "Database is PostgreSQL" vs "Database is MySQL" — which is current?
- "Deadline is April 30" vs "Deadline is May 15" — which is the latest?

Resolution rule: **most recently updated fact wins.** For the loser:
- Delete it via `memory-delete`

If `signal_briefing` is present, pay extra attention to contradiction churn around that topic/entity. The point of this run is to stabilize memory in the area that kept recurring.

---

## Step 4: DECAY — Remove stale facts

For each fact, assess staleness based on how long ago it was created or last updated. Use the fact's age as a proxy for relevance:

| Approximate age | Action |
|---|---|
| ≤ 30 days | No action |
| 31-90 days | Flag as aging — leave in place but note for next consolidation |
| 91-180 days | Consider removing if not referenced in recent episodes |
| > 180 days | Delete the fact via `memory-delete` (it can be re-discovered from episodes if needed) |

Note: once PR-D lands, `last_reinforced_at` and `effectiveConfidence()` will enable precise decay scoring. Until then, use creation/update timestamps as the staleness signal.

Do NOT decay:
- User identity facts (name, role, timezone) — these are stable
- Reference facts (URLs, external pointers) — these don't age the same way

---

## Step 5: PROMOTE — Extract procedures from patterns

Scan recent episodes (use `memory-recall type=episodic` with recent queries) for repeated tool sequences:
- If the same 3+ tool sequence appears in 3+ sessions → create a procedural memory entry
- Use `memory-save type=episodic` with a clear procedure name and steps

Skip if no clear patterns emerge — don't force promotion.

If the passive signal indicates repeated bugs or failures, it is valid to promote an operational lesson such as:
- preferred debugging sequence
- a brittle dependency to check first
- a recurring failure mode to avoid

---

## Step 6: REBUILD CURATED SNAPSHOT

After all changes, update the startup memory block incrementally. The `curated-memory` tool operates on individual entries (not bulk replace):

1. Fetch the current top facts (post-consolidation) via `memory-recall`.
2. Select the 8-10 most important by: confidence > 0.5, most recently updated, category diversity.
3. For facts that were **merged or archived** in earlier steps: call `curated-memory` with `action=remove`, `target=memory`, `old_text=<unique substring of the stale entry>` to clean them from the snapshot.
4. For important facts **not yet in** the curated snapshot: call `curated-memory` with `action=add`, `target=memory`, `content=<one-line fact summary>`.
5. Do NOT attempt to clear and rebuild the entire snapshot. Add/remove only what changed during this consolidation.

---

## Step 7: REPORT

Output a structured summary (logged, not user-facing):

```
Consolidation complete:
- Facts reviewed: N
- Duplicates merged: N
- Contradictions resolved: N
- Facts decayed: N
- Facts archived (deleted): N
- Procedures promoted: N
- Active facts remaining: N
- Curated snapshot rebuilt: yes/no
```

---

## Rules

- **Never surface to the user.** This is background maintenance.
- **Passive consolidation is targeted.** When `signal_briefing` is present, spend most of your effort on the affected topic/entity cluster rather than the entire corpus.
- **Be conservative with deletion.** When in doubt, reduce confidence rather than delete. Facts can be re-discovered from episodes; deleted facts cannot.
- **Protect user identity facts.** Name, role, timezone, communication preferences should never be decayed or deleted by consolidation.
- **One pass.** Inventory → deduplicate → resolve → decay → promote → rebuild. Do not iterate multiple times.
- **Bounded execution.** If the fact corpus is very large (>100 facts), process the top 50 by staleness first. The next scheduled run will catch the rest.
