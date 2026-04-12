#!/usr/bin/env bash
#
# Post-drain verification — runs after the k6 test completes.
# Checks for stuck resources that indicate regressions in the
# billing, queue, or terminal-write paths.
#
# Usage:
#   ./load-test/monitoring/verify-drain.sh
#
# Requires: node + the control-plane's postgres dependency.
# Reads DATABASE_URL from the project .env file.

set -euo pipefail
cd "$(dirname "$0")/../.."

# Load DATABASE_URL from .env
if [ -f .env ]; then
  export $(grep -E '^DATABASE_URL=' .env | xargs)
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo "ERROR: DATABASE_URL not set. Create a .env file or export it."
  exit 1
fi

echo "=== Post-Drain Verification ==="
echo "Timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo ""

node -e "
const postgres = require('postgres');
const sql = postgres(process.env.DATABASE_URL, { max: 1, idle_timeout: 5, connect_timeout: 10 });

(async () => {
  let failures = 0;

  // 1. Stuck 'pending' or 'running' batch tasks
  const [stuckTasks] = await sql\`
    SELECT count(*) as count FROM batch_tasks
    WHERE status IN ('pending', 'running')
      AND created_at > now() - interval '2 hours'
  \`;
  const stuckCount = Number(stuckTasks.count);
  console.log('Stuck batch_tasks (pending/running, last 2h):', stuckCount);
  if (stuckCount > 0) { console.log('  FAIL: expected 0'); failures++; }
  else console.log('  PASS');

  // 2. Stuck 'pending' or 'running' job_queue entries
  const [stuckJobs] = await sql\`
    SELECT count(*) as count FROM job_queue
    WHERE status IN ('pending', 'running')
      AND created_at > now() - interval '2 hours'
  \`;
  const stuckJobCount = Number(stuckJobs.count);
  console.log('Stuck job_queue entries (pending/running, last 2h):', stuckJobCount);
  if (stuckJobCount > 0) { console.log('  FAIL: expected 0'); failures++; }
  else console.log('  PASS');

  // 3. Active credit holds (should all be settled/released/expired by now)
  const [activeHolds] = await sql\`
    SELECT count(*) as count FROM credit_holds
    WHERE status = 'active'
      AND created_at > now() - interval '2 hours'
  \`;
  const holdCount = Number(activeHolds.count);
  console.log('Active credit holds (last 2h):', holdCount);
  if (holdCount > 0) { console.log('  FAIL: expected 0 (reclaim cron should have caught these)'); failures++; }
  else console.log('  PASS');

  // 4. Unresolved billing exceptions (unrecovered_cost debt)
  const [unresolvedDebt] = await sql\`
    SELECT count(*) as count, COALESCE(SUM(amount_usd), 0) as total_usd
    FROM billing_exceptions
    WHERE kind = 'unrecovered_cost' AND resolved_at IS NULL
      AND created_at > now() - interval '2 hours'
  \`;
  const debtCount = Number(unresolvedDebt.count);
  const debtTotal = Number(unresolvedDebt.total_usd);
  console.log('Unresolved credit debt (last 2h):', debtCount, 'rows, \$' + debtTotal.toFixed(2));
  if (debtCount > 0) { console.log('  FAIL: expected 0'); failures++; }
  else console.log('  PASS');

  // 5. DLQ releases during the test
  const [dlqReleases] = await sql\`
    SELECT count(*) as count FROM billing_exceptions
    WHERE kind = 'dlq_hold_release'
      AND created_at > now() - interval '2 hours'
  \`;
  const dlqCount = Number(dlqReleases.count);
  console.log('DLQ hold releases (last 2h):', dlqCount);
  // DLQ releases aren't a failure — they're the safety net working.
  // But high counts indicate systematic job failures worth investigating.
  if (dlqCount > 10) console.log('  WARN: high DLQ rate, check job failure cause');
  else console.log('  OK');

  // 6. Active Postgres connections
  const [pgConns] = await sql\`
    SELECT count(*) as active FROM pg_stat_activity WHERE state = 'active'
  \`;
  console.log('Active Postgres connections:', Number(pgConns.active));

  // Summary
  console.log('');
  if (failures > 0) {
    console.log('=== RESULT: ' + failures + ' FAILURE(S) — investigate before declaring capacity ===');
    process.exit(1);
  } else {
    console.log('=== RESULT: ALL PASS — clean drain ===');
  }

  await sql.end();
})().catch((err) => {
  console.error('Verification error:', err.message);
  process.exit(2);
});
" 2>&1

echo ""
echo "Done."
