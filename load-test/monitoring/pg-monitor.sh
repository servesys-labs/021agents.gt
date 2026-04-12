#!/usr/bin/env bash
#
# Postgres monitoring — polls pg_stat_activity + pg_stat_statements every 10s
# during the load test. Outputs TSV to stdout for post-run analysis.
#
# Usage:
#   ./load-test/monitoring/pg-monitor.sh > load-test/analysis/pg-metrics.tsv
#
# Stop with Ctrl+C when the test completes.

set -euo pipefail
cd "$(dirname "$0")/../.."

if [ -f .env ]; then
  export $(grep -E '^DATABASE_URL=' .env | xargs)
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo "ERROR: DATABASE_URL not set."
  exit 1
fi

INTERVAL=${1:-10}

echo -e "timestamp\tactive_conns\tidle_conns\ttotal_conns\tmax_conns\tactive_holds\tqueue_pending\tqueue_running"

while true; do
  node -e "
const postgres = require('postgres');
const sql = postgres(process.env.DATABASE_URL, { max: 1, idle_timeout: 3, connect_timeout: 5 });
(async () => {
  const [conns] = await sql\`
    SELECT
      count(*) FILTER (WHERE state = 'active') as active,
      count(*) FILTER (WHERE state = 'idle') as idle,
      count(*) as total
    FROM pg_stat_activity
  \`;
  const [maxc] = await sql\`SHOW max_connections\`;
  const [holds] = await sql\`SELECT count(*) as c FROM credit_holds WHERE status = 'active'\`.catch(() => [{c: 0}]);
  const [queueP] = await sql\`SELECT count(*) as c FROM job_queue WHERE status = 'pending'\`.catch(() => [{c: 0}]);
  const [queueR] = await sql\`SELECT count(*) as c FROM job_queue WHERE status = 'running'\`.catch(() => [{c: 0}]);
  const ts = new Date().toISOString();
  console.log([ts, conns.active, conns.idle, conns.total, maxc.max_connections, holds.c, queueP.c, queueR.c].join('\t'));
  await sql.end();
})().catch((e) => console.error('poll error:', e.message));
" 2>&1
  sleep "$INTERVAL"
done
