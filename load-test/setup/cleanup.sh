#!/usr/bin/env bash
#
# Clean up load-test data after a test run.
#
# Removes all orgs, agents, sessions, holds, and queue entries created
# by the seed script. Run this to reset the DB between test runs.
#
# Usage:
#   ./load-test/setup/cleanup.sh
#
# CAUTION: this deletes data. Only run against the load-test DB.

set -euo pipefail
cd "$(dirname "$0")/../../control-plane"

if [ -f ../.env ]; then
  export $(grep -E '^DATABASE_URL=' ../.env | xargs)
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo "ERROR: DATABASE_URL not set."
  exit 1
fi

echo "=== Cleaning up load-test data ==="
echo ""
echo "This will DELETE all data for orgs matching 'load-test-org-%'."
read -p "Continue? (y/N) " confirm
if [ "$confirm" != "y" ] && [ "$confirm" != "Y" ]; then
  echo "Aborted."
  exit 0
fi

node -e "
const postgres = require('postgres');
const sql = postgres(process.env.DATABASE_URL, { max: 1, idle_timeout: 10, connect_timeout: 10 });

(async () => {
  // Autopilot sessions
  const auto = await sql\`DELETE FROM autopilot_sessions WHERE session_id LIKE 'load-test-auto-%' RETURNING session_id\`;
  console.log('  Deleted ' + auto.length + ' autopilot sessions');

  // Credit holds
  const holds = await sql\`DELETE FROM credit_holds WHERE org_id LIKE 'load-test-org-%' RETURNING hold_id\`;
  console.log('  Deleted ' + holds.length + ' credit holds');

  // Billing exceptions
  const exceptions = await sql\`DELETE FROM billing_exceptions WHERE org_id LIKE 'load-test-org-%' RETURNING id\`;
  console.log('  Deleted ' + exceptions.length + ' billing exceptions');

  // Credit transactions
  const txns = await sql\`DELETE FROM credit_transactions WHERE org_id LIKE 'load-test-org-%' RETURNING id\`;
  console.log('  Deleted ' + txns.length + ' credit transactions');

  // Credit balances
  const bals = await sql\`DELETE FROM org_credit_balance WHERE org_id LIKE 'load-test-org-%' RETURNING org_id\`;
  console.log('  Deleted ' + bals.length + ' credit balances');

  // Turns + sessions
  const turns = await sql\`DELETE FROM turns WHERE session_id IN (SELECT session_id FROM sessions WHERE org_id LIKE 'load-test-org-%') RETURNING id\`.catch(() => []);
  console.log('  Deleted ' + turns.length + ' turns');
  const sessions = await sql\`DELETE FROM sessions WHERE org_id LIKE 'load-test-org-%' RETURNING session_id\`;
  console.log('  Deleted ' + sessions.length + ' sessions');

  // Conversations + messages
  const msgs = await sql\`DELETE FROM conversation_messages WHERE conversation_id IN (SELECT conversation_id FROM conversations WHERE org_id LIKE 'load-test-org-%') RETURNING id\`.catch(() => []);
  console.log('  Deleted ' + msgs.length + ' conversation messages');
  const convs = await sql\`DELETE FROM conversations WHERE org_id LIKE 'load-test-org-%' RETURNING conversation_id\`.catch(() => []);
  console.log('  Deleted ' + convs.length + ' conversations');

  // Batch tasks + jobs
  const tasks = await sql\`DELETE FROM batch_tasks WHERE batch_id IN (SELECT batch_id FROM batch_jobs WHERE org_id LIKE 'load-test-org-%') RETURNING task_id\`.catch(() => []);
  console.log('  Deleted ' + tasks.length + ' batch tasks');
  const jobs = await sql\`DELETE FROM batch_jobs WHERE org_id LIKE 'load-test-org-%' RETURNING batch_id\`.catch(() => []);
  console.log('  Deleted ' + jobs.length + ' batch jobs');

  // Job queue
  const queue = await sql\`DELETE FROM job_queue WHERE org_id LIKE 'load-test-org-%' RETURNING job_id\`.catch(() => []);
  console.log('  Deleted ' + queue.length + ' job queue entries');

  // API keys
  const keys = await sql\`DELETE FROM api_keys WHERE org_id LIKE 'load-test-org-%' RETURNING api_key\`;
  console.log('  Deleted ' + keys.length + ' API keys');

  // Agents
  const agents = await sql\`DELETE FROM agents WHERE org_id LIKE 'load-test-org-%' RETURNING name\`;
  console.log('  Deleted ' + agents.length + ' agents');

  // Org members
  const members = await sql\`DELETE FROM org_members WHERE org_id LIKE 'load-test-org-%' RETURNING user_id\`;
  console.log('  Deleted ' + members.length + ' org members');

  // Users
  const users = await sql\`DELETE FROM users WHERE user_id LIKE 'load-test-user-%' RETURNING user_id\`;
  console.log('  Deleted ' + users.length + ' users');

  // Orgs (cascade should handle most of the above, but explicit is safer)
  const orgs = await sql\`DELETE FROM orgs WHERE org_id LIKE 'load-test-org-%' RETURNING org_id\`;
  console.log('  Deleted ' + orgs.length + ' orgs');

  console.log('');
  console.log('Cleanup complete.');
  await sql.end();
})().catch((err) => {
  console.error('Cleanup error:', err.message);
  process.exit(1);
});
" 2>&1
