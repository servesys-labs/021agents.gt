# Load Test Harness

k6-based load test for the AgentOS control-plane. Answers two questions:

1. **Where does Hyperdrive/Postgres saturate?**
2. **Can the system handle 1000s of concurrent agents?**

See [design doc](../docs/design-load-test-harness.md) for full rationale.

## Prerequisites

- [k6](https://k6.io/docs/getting-started/installation/) installed (`brew install k6`)
- Node.js (for monitoring scripts — uses the project's `postgres` dependency)
- API keys for 10 load-test orgs (or 1 key for quick runs)
- Agents named `load-test-agent` created in each org
- Credit balance seeded (at least $10,000 per org)

## Quick Start

```bash
# Single-org quick run (5 min, low RPS)
k6 run -e BASE_URL=https://your-worker.workers.dev \
       -e API_KEY=ak_your_load_test_key \
       -e TARGET_RPS=10 \
       load-test/k6/main.js

# Full 80-minute run with 10 orgs
k6 run -e BASE_URL=https://your-worker.workers.dev \
       -e API_KEY_0=ak_org0 -e API_KEY_1=ak_org1 ... \
       -e TARGET_RPS=50 \
       load-test/k6/main.js
```

## Monitoring (run in parallel)

```bash
# Terminal 1: Postgres metrics every 10s
./load-test/monitoring/pg-monitor.sh > load-test/analysis/pg-metrics.tsv

# Terminal 2: Workers logs (autopilot cron timing)
npx wrangler tail agentos-control-plane --format json | grep cron

# Terminal 3: k6 running
k6 run ...
```

## Post-Run

```bash
# Automated drain verification
./load-test/monitoring/verify-drain.sh
```

## Workload Mix

| Scenario | % of RPS | Endpoint | Driven by |
|----------|---------|----------|-----------|
| Interactive (sync) | 42% | `POST /v1/agents/:name/run` | k6 |
| Interactive (stream) | 21% | `POST /v1/agents/:name/run/stream` | k6 |
| Interactive (conversation) | 7% | `POST /v1/agents/:name/conversations` | k6 |
| Autopilot | 20% | Cron → JOB_QUEUE → /agent/run | Real cron + seeded sessions |
| Batch | 10% | `POST /v1/agents/:name/run/batch` | k6 |

## Pass/Fail Thresholds

k6 exits with code 99 if any threshold is breached:

- Sync p99 < 5s
- Stream TTFB p99 < 3s
- Error rate < 1%
- Batch submit p99 < 2s
- Global p99 < 10s

Post-drain (via `verify-drain.sh`):
- Zero stuck pending/running tasks
- Zero active credit holds
- Zero unresolved billing debt
