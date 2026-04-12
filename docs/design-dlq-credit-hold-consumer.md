# Design: DLQ Consumer for Credit Holds

**Status:** Proposal (not yet implemented)
**Priority:** P1 (upgraded from P2 per 3rd-pass code review)
**Effort:** Half-day implementation + review
**Author:** Claude Opus 4.6 (design), Ish (review)
**Date:** 2026-04-11

---

## Problem

When an `agent_run` or `batch_run` queue message exhausts all 3 retries and lands in `agentos-jobs-dlq`, any associated credit hold sits in `status='active'` until the `reclaimExpiredCreditHolds` cron catches it at TTL expiry (default 10 minutes, cron cadence 1 minute).

During an incident (runtime outage, Hyperdrive blip, network partition), many jobs can fail simultaneously. Each holds $0.50 for up to 10 minutes. For a large org with a tight balance, this effectively locks them out of new sessions because the reserve gate sees `balance_usd - reserved_usd < hold_amount` even though the runs never completed.

The hold eventually reclaims, but the 10-minute window is exactly when customer experience matters most.

## Proposed solution

Add a queue consumer for `agentos-jobs-dlq` that immediately releases credit holds for DLQ-bound messages instead of waiting for TTL-based reclaim.

## Decision 1: Queue consumer vs cron poll

**Decision: Queue consumer.**

| Approach | Latency | Complexity | Coupling |
|----------|---------|------------|----------|
| Queue consumer on `agentos-jobs-dlq` | Immediate (message delivery) | Low — same worker, new routing branch | Tied to queue message shape |
| Cron poll that queries `job_queue WHERE status='dead'` | Up to 1 minute (cron cadence) | Medium — needs a new query + state tracking | Tied to job_queue schema |

The queue consumer wins on latency (the defining metric for this P1) and on simplicity (Cloudflare Queues delivers DLQ messages to a consumer automatically — no polling, no state tracking). The cron approach would require marking processed DLQ entries to avoid re-processing, which is a mini state machine the queue consumer avoids entirely because `msg.ack()` is the state transition.

### Implementation shape

```jsonc
// control-plane/wrangler.jsonc — add consumer for the DLQ
{
  "queues": {
    "consumers": [
      {
        "queue": "agentos-jobs",
        "max_batch_size": 10,
        "max_batch_timeout": 5,
        "max_retries": 3,
        "dead_letter_queue": "agentos-jobs-dlq"
      },
      {
        "queue": "agentos-jobs-dlq",
        "max_batch_size": 10,
        "max_batch_timeout": 5,
        "max_retries": 0   // DLQ messages must not retry — if release
                            // fails, the reclaim cron catches it at TTL
      }
    ]
  }
}
```

The `queue()` handler in `index.ts` already receives `MessageBatch`. Add routing on `batch.queue`:

```typescript
async queue(batch: MessageBatch, env: Env): Promise<void> {
  if (batch.queue === "agentos-jobs-dlq") {
    return handleDlqBatch(batch, env);
  }
  // ... existing job consumer ...
}
```

## Decision 2: Deduplication with `reclaimExpiredCreditHolds`

**Decision: No custom dedup needed. The DB layer already prevents double-release.**

### Race analysis

Two actors can try to release the same hold:

| Actor | Trigger | Locking | Timing |
|-------|---------|---------|--------|
| DLQ consumer | Message delivered to consumer | `releaseCreditHold` uses `FOR UPDATE` on hold row | Immediate on DLQ delivery |
| Reclaim cron | Hold's `expires_at < now()` | `FOR UPDATE SKIP LOCKED` on hold row | Every 1 minute, up to 200 holds |

**Case 1: DLQ consumer runs first.**
`releaseCreditHold` acquires `FOR UPDATE` on the hold, checks `status='active'`, releases it (status='released'), commits. Next cron tick: `reclaimExpiredCreditHolds` runs `WHERE status='active' AND expires_at < now() FOR UPDATE SKIP LOCKED` — the hold is no longer `status='active'`, so it's not in the result set. No-op.

**Case 2: Reclaim cron runs first.**
Reclaim acquires the hold via `SKIP LOCKED`, marks it `status='expired'`, commits. DLQ consumer then calls `releaseCreditHold` which does `SELECT ... FOR UPDATE` — the hold row is now `status='expired'`. The function hits `if (!hold || String(hold.status) !== "active") return;` at `credits.ts:283` and returns silently. No-op.

**Case 3: Both run concurrently.**
Postgres `FOR UPDATE` serializes them at the row level. Whichever acquires the lock first proceeds; the second waits, then sees the updated status and no-ops. If reclaim uses `SKIP LOCKED`, it skips the locked row entirely and moves to the next expired hold.

**Conclusion:** The existing `releaseCreditHold` + `reclaimExpiredCreditHolds` design already handles the race correctly. No additional dedup table, flag, or coordination needed.

### One subtlety: the DLQ consumer should use `releaseCreditHold`, not a custom release path

The DLQ consumer must call the same `releaseCreditHold` function that the queue handler's catch block uses. This ensures:
- Same `FOR UPDATE` lock acquisition
- Same `status='active'` guard
- Same balance restoration formula (`balance += holdAmount, reserved -= holdAmount`)
- Same error handling (throws on missing balance row)

A custom release path would risk diverging from the canonical release semantics.

## Decision 3: Metric emission surface

**Decision: Structured log line + `billing_exceptions` row. No per-org metric yet (deferred to metrics pipeline).**

### Per-release observability

```typescript
// On successful release:
console.warn(
  `[dlq-billing] released hold org=${orgId} session=${sessionId} hold=${holdId} reason=dlq_exhausted`
);

// Audit row in billing_exceptions:
await sql`
  INSERT INTO billing_exceptions
    (org_id, session_id, hold_id, kind, amount_usd, exception_type,
     expected_usd, actual_usd, charged_usd, error_message, created_at)
  VALUES
    (${orgId}, ${sessionId}, ${holdId}, 'dlq_hold_release', ${holdAmount},
     'dlq_exhausted', ${holdAmount}, 0, 0,
     'Hold released by DLQ consumer — job exhausted all retries', now())
`;
```

### Aggregate observability

The `billing_exceptions` table now supports three `kind` values for hold lifecycle:
- `unrecovered_cost` — settle overflow (fail-closed debt)
- `reclaim_mismatch` — TTL-based reclaim (cron)
- `dlq_hold_release` — DLQ-based release (new)

An ops query to monitor DLQ release rate:
```sql
SELECT date_trunc('hour', created_at) AS hour, COUNT(*) AS dlq_releases
FROM billing_exceptions
WHERE kind = 'dlq_hold_release'
GROUP BY 1 ORDER BY 1 DESC LIMIT 24;
```

When a metrics pipeline is wired up, the DLQ consumer's `console.warn` becomes a structured log that the pipeline can index. The `billing_exceptions` row provides a durable audit trail regardless.

## Decision 4: Per-org rate limiting on DLQ replay

**Decision: Not needed. Queue consumer batch settings provide sufficient throughput control.**

### Why rate limiting was considered

Concern: a hostile customer engineers many failing jobs to flood the DLQ, forcing rapid hold releases that interfere with legitimate billing.

### Why it's not needed

The DLQ consumer's only action is **releasing holds** — returning money to the customer. There's no billing harm from rapid releases: the customer gets their money back faster, which is what they want (their runs failed). There's no way to use DLQ releases to spend someone else's money or bypass the reserve gate.

The one concern is **DB load from burst DLQ processing**. This is already bounded by the queue consumer's `max_batch_size: 10` and `max_batch_timeout: 5`. At worst, the DLQ consumer processes 10 messages per 5-second window = 120 messages/minute. Each message does 1 SELECT + 1-2 UPDATEs via `releaseCreditHold` = ~360 queries/minute during a burst. That's well within Hyperdrive's capacity.

If we observe bursts exceeding this, the first lever is lowering `max_batch_size` in wrangler.jsonc (config change, no code).

## Flow per DLQ message

```
DLQ message arrives
  ├── Parse payload: extract type, org_id, derive session_id
  │     agent_run:  session_id = payload.session_id || payload.job_id || `agent-run-${org_id}-${agent_name}`
  │     batch_run:  session_id = `batch-${batch_id}-${task_id}` (for each task)
  │
  ├── Look up active hold:
  │     SELECT hold_id, hold_amount_usd
  │     FROM credit_holds
  │     WHERE org_id = $1 AND session_id = $2 AND status = 'active'
  │     LIMIT 1
  │
  ├── If hold found:
  │     ├── releaseCreditHold(sql, orgId, holdId, "expired")
  │     ├── INSERT billing_exceptions (kind='dlq_hold_release', ...)
  │     └── console.warn("[dlq-billing] released hold ...")
  │
  ├── If hold NOT found (already reclaimed by cron, or already settled):
  │     └── console.log("[dlq-billing] no active hold for session ...")
  │
  └── msg.ack()  // always ack — DLQ messages must not retry
```

### batch_run special case

A `batch_run` DLQ message corresponds to potentially many per-task holds. The consumer must iterate over the batch's tasks and release each one:

```typescript
if (type === "batch_run") {
  const batchId = String(payload.batch_id || "");
  const tasks = await sql`
    SELECT task_id FROM batch_tasks
    WHERE batch_id = ${batchId} AND status IN ('pending', 'running')
  `;
  for (const task of tasks) {
    const sessionId = `batch-${batchId}-${String(task.task_id)}`;
    // ... look up hold by session, release if active ...
  }
}
```

This is bounded by the batch size (typically 10-100 tasks). For a 100-task batch, that's 100 lookups + up to 100 releases — still within a single queue consumer invocation's wall-time budget (30 seconds per Cloudflare Queues spec).

## Schema changes

**None required.** The existing `credit_holds` and `billing_exceptions` tables support the DLQ consumer as-is. The new `kind='dlq_hold_release'` value is just a string — no constraint change needed (the `kind` column is `TEXT NOT NULL DEFAULT 'unknown'`, not an enum).

## Files to modify

| File | Change |
|------|--------|
| `control-plane/wrangler.jsonc` | Add consumer for `agentos-jobs-dlq` with `max_retries: 0` |
| `control-plane/src/index.ts` | Add `batch.queue` routing + `handleDlqBatch()` function |
| `control-plane/src/logic/credits.ts` | Add `releaseHoldBySession(sql, orgId, sessionId, reason)` helper (optional — could inline the lookup) |
| `control-plane/test/dlq-consumer.test.ts` | New test file: hold lookup + release + audit row + no-op when already reclaimed |

## Test plan

1. **agent_run DLQ message releases the associated hold** — reserve a hold, simulate DLQ message, assert hold status='released' and balance restored.
2. **batch_run DLQ message releases all per-task holds** — reserve N holds for N tasks, simulate DLQ message, assert all released.
3. **DLQ message for already-reclaimed hold is a no-op** — reserve, reclaim via cron, then simulate DLQ message. Assert no error, no double-release, balance unchanged.
4. **DLQ message for already-settled hold is a no-op** — reserve, settle, then simulate DLQ message. Assert hold stays 'settled', balance unchanged.
5. **billing_exceptions row created with kind='dlq_hold_release'** — verify audit trail.
6. **Malformed DLQ message is acked without error** — missing org_id, missing type, empty payload. Assert msg.ack() called, no throw.

## Open questions for review

1. **Should `releaseHoldBySession` be a new exported function in `credits.ts`?** Or should the DLQ consumer inline the `SELECT hold_id ... WHERE session_id` lookup and call `releaseCreditHold` directly? A helper is cleaner but adds API surface. My lean: extract it — it's also useful for admin tools and debugging.

2. **Should the DLQ consumer also mark the `job_queue` / `batch_tasks` rows as `'dead'`?** Currently these rows just stay at whatever status they were when the message failed. Adding a `status='dead'` terminal write from the DLQ consumer would make the admin UI accurate. But it requires the same `withOrgDb` terminal-write pattern from Commit 4. My lean: yes, but in a follow-up commit, not the initial DLQ implementation.

3. **Should `agentos-telemetry-dlq` get a consumer too?** Telemetry loss is degraded-mode acceptable, and telemetry DLQ messages don't have credit holds. Separate concern, separate design. My lean: defer to its own doc.
