# Known Issues

Tracked issues with a known diagnosis and a deferred fix. Entries document the blast-radius, the bound that keeps them tolerable, and the recommended fix so a future context can pick up where it was left.

## Phase 6.5 (learning loop)

### Concurrent auto-fire dedup race — bounded, fix deferred

**Where:** `control-plane/src/routes/skills-admin.ts` `/append-rule` handler, dedup `SELECT` at the top of the `withOrgDb` callback.

**What happens:** The dedup `SELECT 1 FROM skill_audit WHERE ... LIMIT 1` runs *before* the `pg_advisory_xact_lock` in `appendRule`. Two concurrent auto-fire requests with the same `(org, skill, pattern)` can both observe an empty dedup result — request A's audit row has not committed yet when request B runs its check. A's `appendRule` takes the lock, writes; then B acquires the same lock, reads the (now-updated) rate-limit count correctly, and also writes. The rate limiter stays honest, but the dedup guarantee is lost and two identical rows land.

**Blast radius:** bounded 2× per race window (not N-way, because each subsequent request would see the committed rows from the prior racers). Further capped by the 5/day auto bucket — at most 5 duplicates per `(org, skill)` per day before the rate limiter hard-stops the loop. Worst realistic case: a user double-clicks "Analyze" and lands 2 identical `improve` overlay rows instead of 1. The admin revert path handles cleanup cleanly.

**Fix (deferred):** 3 lines. Acquire the same `pg_advisory_xact_lock` key that `appendRule` uses, *before* the dedup `SELECT`. Postgres advisory locks are reentrant within a transaction, so `appendRule`'s subsequent lock acquisition is a free no-op:

```ts
await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`skill-rl:${user.org_id}:${skillName}`}, 0))`;
// ... existing dedup SELECT ... then appendRule (re-enters the same lock)
```

Ship as a standalone `fix(phase6.5): serialize dedup check under the rate-limit advisory lock` commit. Safe to defer because the bound holds and the revert path exists.

### Rule text is descriptive, not directive — Phase 6.6 follow-up

**Where:** `deploy/src/runtime/skill-feedback.ts` `detectEvolveFeedback`, rule text template.

**What it says now:** `"ATTENTION: Pattern 'X' has produced N recent failures on agent 'Y'. When proposing changes related to this pattern, prefer configurations that avoid it."`

**Why it's fuzzy:** "prefer configurations that avoid it" is not an imperative the model can directly act on — there's no concrete knob being named. Writing concrete imperatives requires a pattern→remediation mapping (e.g., `tool:web-search` → "suggest increasing the `max_results` parameter", `governance:budget` → "suggest raising `budget_limit_usd`"). That mapping is a rabbit hole and correct mappings are non-obvious without real audit data.

**Fix (deferred to Phase 6.6):** once the detector has been firing on production traffic for 1-2 weeks and `skill_audit` has real rows, grade the existing fuzzy rules against a reward signal (eval delta on the affected skill, or a second-ask follow-through metric). Use the passing rules to bootstrap a pattern→imperative dictionary. Re-emit historical rules with directive phrasing where a signal exists.

**Blast radius:** rules are still read by the model and still carry the pattern + count + originating agent. They just don't prescribe a specific action. Worst case is a mildly noisier `/improve` context without concrete quality regression.

### `revert` source classifies as `human_count` — pre-existing Phase 6 behavior

**Where:** `control-plane/src/logic/skill-mutation.ts` dual-bucket rate-limit query.

**What it means:** The dual-bucket partition uses `source NOT LIKE 'auto-fire%'` for the human bucket, which matches everything that isn't auto-fire — including the `"revert"` source written by `revertSkillRule` to the audit trail. A user reverting 10 auto-fire rules in a cleanup burns 10 slots of the human daily budget, even though a revert isn't itself a human authoring action.

**Pre-existing:** this classification is inherited from Phase 6 — the original single-bucket limit also counted reverts against the 10/day ceiling. The Phase 6.5 dual-bucket refactor preserved the behavior exactly, it did not introduce it.

**Fix:** 1-line addition — a third `FILTER` clause excluding `source = 'revert'`:

```sql
SELECT
  COUNT(*) FILTER (WHERE source LIKE 'auto-fire%')::int AS auto_count,
  COUNT(*) FILTER (WHERE source NOT LIKE 'auto-fire%' AND source != 'revert')::int AS human_count
FROM skill_audit
WHERE skill_name = ${skillName}
  AND created_at > NOW() - INTERVAL '1 day'
```

Ship as a dedicated hygiene commit at any time — no ordering dependency on the rest of Phase 6.5 or the compaction work.

**Blast radius:** tolerable. Admins who need to revert >10 rules in a day hit a rate-limit error on rules 11+ and have to wait. Workaround is to file a direct DB delete against `skill_overlays` with an admin connection, which bypasses the limiter but loses audit trail. Hitting this ceiling is vanishingly rare in practice.
