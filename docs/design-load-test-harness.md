# Design: Load Test Harness

**Status:** Proposal (not yet implemented)
**Priority:** P1 (next after DLQ consumer)
**Effort:** 2-3 days (harness setup + first run + analysis)
**Author:** Claude Opus 4.6 (design), Ish (review)
**Date:** 2026-04-12

---

## Goals

Two distinct questions this harness must answer:

1. **Where does Hyperdrive/Postgres saturate?** — connection pool exhaustion, query latency degradation, Hyperdrive error rate under sustained load. This gives the capacity ceiling for the current infrastructure.

2. **Can the system handle 1000s of concurrent agents?** — queue depth stability, credit hold throughput, DLQ rate, autopilot tick fan-out under the volume the architecture claims to support.

These require different test scenarios but share the same harness, environment, and measurement infrastructure.

---

## Decision 1: Tool choice

**Decision: k6.**

| Tool | Language | SSE support | Constant-arrival-rate | CF Workers compat | Verdict |
|------|----------|-------------|----------------------|-------------------|---------|
| k6 | JS/TS | Built-in | `constant-arrival-rate` executor | Native HTTP, no special config | **Winner** |
| Locust | Python | Manual | Event-based (close) | Fine | Good but Python overhead |
| Artillery | YAML + JS | Plugin | Phases with arrivalRate | Fine | Less flexible scripting |
| Custom (Node) | TS | Manual | Manual | Fine | Maximum flexibility, maximum maintenance |

k6 reasons:
- **JS/TS native**: the team already writes TypeScript. k6 scripts feel natural.
- **`constant-arrival-rate` executor**: generates load at a fixed request rate regardless of response time, which is the right model for simulating "N users making requests" (vs. "N connections sending as fast as possible").
- **Built-in SSE/streaming**: the `/runnable/stream` and `/v1/agents/:name/run/stream` endpoints return SSE — k6 handles `text/event-stream` natively.
- **`--out json` + Grafana integration**: structured output for post-run analysis. Can pipe to InfluxDB/Grafana if we want dashboards later.
- **No infra dependency**: runs locally or in CI. No need for a separate load-generation cluster at this scale.

Install: `brew install k6` or `go install go.k6.io/k6@latest`.

---

## Decision 2: Workload mix

**70% interactive / 20% autopilot / 10% batch**, mapped to concrete endpoints.

### Interactive (70% of total RPS)

Simulates users running agents via the public API.

| Endpoint | Method | Payload | Auth | Weight within interactive |
|----------|--------|---------|------|--------------------------|
| `/v1/agents/:name/run` | POST | `{ input: "...", user_id: "load-test-user-{N}" }` | API key (`ak_load_test_...`) | 60% (sync) |
| `/v1/agents/:name/run/stream` | POST | Same + SSE consumption | API key | 30% (stream) |
| `/v1/agents/:name/conversations` | POST | `{ input: "...", title: "load-test" }` | API key | 10% (conversation) |

Each request exercises: auth middleware → rate limiter → `reserveCreditHold` → `withOrgDb` → `RUNTIME.fetch` → `settleCreditHold` → response. This is the full billing hot path.

**Payload**: short inputs (~50 tokens) to minimize runtime processing time. The goal is to stress the control-plane, not the LLM. If the runtime worker is a bottleneck, we'll see it as elevated p99 on the RUNTIME.fetch subrequest.

### Autopilot (20% of total RPS)

Simulates autonomous agent tick processing. Cannot directly trigger the cron — instead, pre-seed autopilot sessions in the DB and let the real `*/1 * * * *` cron fan them out to `JOB_QUEUE`.

**Setup phase** (before the load test):
```sql
INSERT INTO autopilot_sessions (session_id, org_id, agent_name, status, tick_interval_seconds)
SELECT
  'load-test-auto-' || generate_series(1, 1000),
  'load-test-org',
  'load-test-agent',
  'active',
  30  -- tick every 30 seconds
FROM generate_series(1, 1000);
```

1000 sessions × 30s tick = ~2000 queue messages/minute at steady state. The cron's 500/page × 20 pages = 10K/min ceiling gives 5x headroom.

**What this exercises**: cron fan-out → `JOB_QUEUE.send` → queue consumer → `withOrgDb(reserveCreditHold)` → `RUNTIME.fetch` → `withOrgDb(settleCreditHold)` → `withOrgDb(terminal state write)`. Full billing + queue + DB path.

### Batch (10% of total RPS)

Simulates batch API submissions.

| Endpoint | Method | Payload | Auth |
|----------|--------|---------|------|
| `/v1/agents/:name/run/batch` | POST | `{ tasks: [{input: "..."}] × 10 }` | API key |

10 tasks per batch. Each task creates its own credit hold. At 10% of total RPS with 10 tasks/batch, effective per-task throughput is comparable to the interactive path.

**What this exercises**: batch enqueue → queue consumer → per-task `reserveCreditHold` loop → `RUNTIME.fetch` per task → per-task `settleCreditHold` → batch-level terminal write.

---

## Decision 3: What we're measuring

### Scenario A — Hyperdrive/Postgres saturation

**Metrics to collect**:

| Metric | Source | Saturation signal |
|--------|--------|-------------------|
| Hyperdrive connection utilization | CF dashboard → Hyperdrive analytics | >80% of pool used |
| Postgres `active` connections | `SELECT count(*) FROM pg_stat_activity WHERE state = 'active'` | Approaching `max_connections` |
| Postgres query latency (p50/p99) | `pg_stat_statements` (mean_exec_time, max_exec_time) | p99 > 100ms |
| Postgres wait events | `pg_stat_activity.wait_event_type` | Lock waits, IO waits growing |
| `withOrgDb` transaction duration | k6 response time on endpoints that use it | p99 > 500ms |
| Hyperdrive error count | CF dashboard | Any non-zero error rate |

**How to collect**: Postgres metrics via a separate monitoring query that runs every 10s during the test (k6 `setup`/`teardown` hooks or a parallel script). Hyperdrive metrics from the CF dashboard post-run. k6 collects endpoint-level latency natively.

### Scenario B — "1000s of concurrent agents"

**Metrics to collect**:

| Metric | Source | Capacity signal |
|--------|--------|-----------------|
| Queue depth (`agentos-jobs`) | CF Queues dashboard | Must plateau, not grow unboundedly |
| Queue consumer latency | k6 (time from enqueue to observable side-effect) | <30s for agent_run |
| DLQ rate | `SELECT count(*) FROM billing_exceptions WHERE kind = 'dlq_hold_release'` + DLQ dashboard | <0.1% of total messages |
| Active credit holds count | `SELECT count(*) FROM credit_holds WHERE status = 'active'` | Must stay bounded (<2x concurrent sessions) |
| Hold TTL pressure | Holds approaching 10-min expiry without settlement | <5% of active holds |
| Credit operation throughput | k6 (reserve → settle round-trip inside endpoint response time) | <200ms per hold lifecycle |
| Autopilot tick throughput | Cron fan-out messages/min vs expected (2000/min for 1000 sessions) | Fan-out keeps up with schedule |

---

## Decision 4: Environment

### Target

**Staging Hyperdrive + Postgres** — NOT production. The load test will push the DB to saturation on purpose; doing that against prod would affect real customers.

**If no staging Hyperdrive exists** (the survey found only two bindings, both pointing at the same Supabase project): create one before the test. Options:
1. **Supabase branch** (if on Pro plan): `supabase branch create load-test`. Separate Postgres instance with identical schema.
2. **Neon branch**: if the underlying Postgres is Neon, branching is instant and free.
3. **Manual staging**: `CREATE DATABASE agentos_staging` on the same Postgres cluster. Cheaper but shares resources with prod — saturation test would affect prod latency.

**Recommendation**: option 1 or 2 (isolated branch). If neither is available, option 3 with a clear comms window ("load test running 14:00-15:30 UTC, expect elevated latency").

### Data volume

The test environment needs representative row counts for RLS + index performance to be realistic:

| Table | Minimum rows | Why |
|-------|-------------|-----|
| `orgs` | 100 | Multi-tenant RLS filter selectivity |
| `agents` | 1,000 (10/org) | Agent config lookups |
| `sessions` | 100,000 | Observability queries, evolution analysis |
| `turns` | 1,000,000 | The largest table — `run_query` CTEs scan this |
| `credit_transactions` | 500,000 | Daily spend cap checks scan last 24h |
| `credit_holds` | 10,000 (active) | Reclaim cron scan, hold lookup by session |
| `autopilot_sessions` | 1,000 | Cron fan-out volume |

**Seed script**: a k6 `setup()` function that INSERTs synthetic rows via the public API (create orgs, create agents, run sessions). Alternatively, a standalone SQL seed script that bulk-inserts with `generate_series`. The SQL approach is faster but requires direct DB access.

---

## Decision 5: Duration and ramp profile

```
Phase 1 (0-5 min):    warm-up     — 10% of target RPS
Phase 2 (5-15 min):   step-25     — 25% of target RPS
Phase 3 (15-25 min):  step-50     — 50% of target RPS
Phase 4 (25-35 min):  step-100    — 100% of target RPS
Phase 5 (35-65 min):  sustained   — hold at 100% for 30 min
Phase 6 (65-70 min):  step-down   — 50% of target RPS
Phase 7 (70-75 min):  cool-down   — 10% of target RPS
Phase 8 (75-80 min):  drain       — 0 RPS, observe resource release
```

**Total: 80 minutes.**

Why step-down + drain:
- **Phase 6-7**: catches latency regression under decreasing load (connection pool not releasing, leaked Durable Objects, unclosed streams).
- **Phase 8**: catches resource leaks that only surface when all requests stop (orphaned credit holds, queue depth that doesn't drain, pg_stat_activity connections that linger).

### Target RPS at 100%

Start with **50 RPS total** (the control-plane's `MAX_CONCURRENT_RUNTIME_REQUESTS = 40` caps in-flight requests). At 50 RPS with an average 2s response time, ~100 requests are in-flight — above the 40-cap, which means we'll see queueing behavior. That's intentional: we want to find the saturation point.

If 50 RPS is comfortable, bump to 100 on a second run. If it saturates early, drop to 25 and re-run.

Workload split at 50 RPS:
- Interactive: 35 RPS (70%)
- Autopilot: 10 RPS equivalent (20%) — driven by the cron + 1000 seeded sessions
- Batch: 5 RPS (10%) — each batch = 10 tasks = 50 effective task-level RPS

---

## Decision 6: Pass/fail criteria

### "Production-ready" thresholds (must ALL pass)

| Metric | Threshold | Rationale |
|--------|-----------|-----------|
| Sync `/agents/:name/run` p99 latency | < 5,000ms | Includes RUNTIME.fetch (LLM call). Below 5s = acceptable UX. |
| Stream `/run/stream` time-to-first-byte p99 | < 3,000ms | User perceives "thinking" before first SSE event. |
| Error rate (5xx) at sustained peak | < 1% | Occasional timeout is OK; persistent errors are not. |
| Queue depth at sustained peak | Plateaus within 5 min | Unbounded growth = consumer can't keep up. |
| DLQ rate | < 0.1% of total queue messages | Higher = systematic failure, not transient. |
| Active credit holds at sustained peak | < 2x concurrent requests | Higher = settlement lag. |
| Postgres `active` connections | < 80% of `max_connections` | Above 80% = pool exhaustion imminent. |
| Hyperdrive error rate | 0 | Any error = connection issue that needs investigation. |
| p99 `withOrgDb` transaction time | < 500ms | Above = Postgres is the bottleneck. |

### "1000s of concurrent agents" thresholds (stretch goals)

| Metric | Threshold | Rationale |
|--------|-----------|-----------|
| Autopilot cron processes 1000 sessions in < 30s | Yes/No | Above 30s = cron overlaps itself next minute. |
| Queue consumer clears backlog within 60s of burst | Yes/No | If not, queue grows unboundedly under sustained autopilot load. |
| Credit hold lifecycle (reserve → settle) p99 | < 1,000ms | Above = billing is the bottleneck, not the LLM. |
| Zero stuck 'pending' tasks after test drain | Yes/No | Any = terminal-write fix regression or retry cascade. |
| Zero unresolved `billing_exceptions` with `kind='unrecovered_cost'` after drain | Yes/No | Any = debt ledger has uncollected entries from the test. |

---

## k6 script structure

```
load-test/
  k6/
    config.ts           # Environment vars, target URLs, API keys
    scenarios/
      interactive.ts    # sync + stream + conversation endpoints
      batch.ts          # batch API submissions
    helpers/
      auth.ts           # API key rotation (spread load across orgs)
      checks.ts         # Custom k6 checks (SSE parsing, billing assertions)
      seed.ts           # DB seed via public API (setup phase)
    thresholds.ts       # Pass/fail criteria from Decision 6
    main.ts             # k6 entry point: combines scenarios with ramp profile
  monitoring/
    pg-monitor.sh       # Polls pg_stat_activity + pg_stat_statements every 10s
    cf-metrics.sh       # Post-run: pulls Cloudflare GraphQL analytics
  analysis/
    report.md           # Template for post-run findings
```

The autopilot workload is NOT a k6 scenario — it's driven by the real cron consuming pre-seeded `autopilot_sessions` rows. k6 only measures the side effects (queue depth, hold count, DLQ rate) via monitoring queries.

---

## Risks and mitigations

| Risk | Mitigation |
|------|------------|
| Load test hammers prod Postgres | Use staging branch. If unavailable, schedule a maintenance window and alert the team. |
| RUNTIME.fetch hits real LLM endpoints and burns credits | Mock the runtime worker to return canned responses with `cost_usd: 0.01`. Deploy a `load-test` variant of the runtime worker that short-circuits the LLM call. |
| Rate limiter blocks load test requests | Create a load-test API key with elevated `rpm: 10000, rpd: 1000000`. Or temporarily raise limits on the load-test org. |
| Session counter blocks concurrent runs | Set session limit to 1000 for the load-test org via `org_settings`. |
| Credit balance runs out mid-test | Seed with $10,000 balance. At $0.01/request × 50 RPS × 80 min = ~$2,400 consumed. $10K gives 4x headroom. |
| k6 machine becomes the bottleneck | k6 is compiled Go — handles 1000+ RPS on a single laptop. If needed, distribute across 2-3 machines. |

---

## Open questions for review

1. **Staging environment**: do you have a Supabase/Neon branch capability, or do we need to create a manual staging DB? This is the main blocker before implementation.

2. **Runtime mock**: should the load-test runtime variant be a separate wrangler.jsonc config (deployed to a different worker name like `agentos-load-test`), or a feature flag in the existing runtime that short-circuits on a `x-load-test: true` header?

3. **API key provisioning**: one shared load-test API key, or per-org keys (to test multi-tenant RLS isolation under load)? Per-org is more realistic but more setup.

4. **k6 cloud vs local**: k6 Cloud (Grafana) gives geographic distribution and built-in dashboards. Local gives full control and no SaaS dependency. For the first run, local is fine — upgrade to Cloud if we need multi-region load generation later.
