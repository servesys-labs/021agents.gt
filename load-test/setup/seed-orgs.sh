#!/usr/bin/env bash
#
# Seed load-test orgs, agents, API keys, and credit balances.
#
# Creates 10 orgs (load-test-org-0 through load-test-org-9), each with:
# - An agent named "load-test-agent"
# - An API key (printed to stdout for k6 config)
# - $10,000 credit balance
#
# Also seeds 1000 autopilot sessions for the autopilot workload.
#
# Usage:
#   ./load-test/setup/seed-orgs.sh
#
# Requires: node + control-plane's postgres dependency.
# Reads DATABASE_URL from the project .env file.
#
# IMPORTANT: run this ONCE before the first load test, not per-run.
# The script is idempotent (uses ON CONFLICT DO NOTHING).

set -euo pipefail
cd "$(dirname "$0")/../../control-plane"

if [ -f ../.env ]; then
  export $(grep -E '^DATABASE_URL=' ../.env | xargs)
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo "ERROR: DATABASE_URL not set."
  exit 1
fi

ORG_COUNT=${1:-10}
BALANCE_USD=${2:-10000}
AUTOPILOT_COUNT=${3:-1000}
AGENT_NAME="load-test-agent"

echo "=== Seeding $ORG_COUNT load-test orgs ==="
echo ""

node -e "
const postgres = require('postgres');
const sql = postgres(process.env.DATABASE_URL, { max: 1, idle_timeout: 10, connect_timeout: 10 });
const crypto = require('crypto');

const ORG_COUNT = ${ORG_COUNT};
const BALANCE_USD = ${BALANCE_USD};
const AUTOPILOT_COUNT = ${AUTOPILOT_COUNT};
const AGENT_NAME = '${AGENT_NAME}';

(async () => {
  const apiKeys = [];

  for (let i = 0; i < ORG_COUNT; i++) {
    const orgId = 'load-test-org-' + i;
    const userId = 'load-test-user-' + i;
    const apiKeyValue = 'ak_lt_' + crypto.randomBytes(16).toString('hex');

    // Create org (idempotent)
    await sql\`
      INSERT INTO orgs (org_id, name, plan, created_at)
      VALUES (\${orgId}, \${'Load Test Org ' + i}, 'standard', now())
      ON CONFLICT (org_id) DO NOTHING
    \`.catch(() => {});

    // Create user + membership (idempotent)
    await sql\`
      INSERT INTO users (user_id, email, name, created_at)
      VALUES (\${userId}, \${userId + '@loadtest.local'}, \${'Load Test User ' + i}, now())
      ON CONFLICT (user_id) DO NOTHING
    \`.catch(() => {});

    await sql\`
      INSERT INTO org_members (org_id, user_id, role, created_at)
      VALUES (\${orgId}, \${userId}, 'admin', now())
      ON CONFLICT (org_id, user_id) DO NOTHING
    \`.catch(() => {});

    // Create agent (idempotent)
    await sql\`
      INSERT INTO agents (name, org_id, description, config, is_active, created_at)
      VALUES (\${AGENT_NAME}, \${orgId}, 'Load test agent',
              \${JSON.stringify({
                system_prompt: 'You are a load test agent. Respond briefly.',
                model: 'load-test-mock',
                plan: 'standard',
                tools: [],
                budget_limit_usd: 100
              })},
              true, now())
      ON CONFLICT DO NOTHING
    \`.catch(() => {});

    // Create API key (idempotent by checking existing)
    const existingKey = await sql\`
      SELECT api_key FROM api_keys WHERE org_id = \${orgId} AND name = 'load-test' LIMIT 1
    \`.catch(() => []);

    let keyValue;
    if (existingKey.length > 0) {
      keyValue = existingKey[0].api_key;
    } else {
      keyValue = apiKeyValue;
      await sql\`
        INSERT INTO api_keys (api_key, org_id, name, scopes, rate_limit_rpm, rate_limit_rpd, created_at)
        VALUES (\${keyValue}, \${orgId}, 'load-test', ARRAY['*'], 10000, 1000000, now())
      \`.catch((err) => {
        console.error('  API key insert failed for ' + orgId + ':', err.message);
        keyValue = null;
      });
    }

    // Seed credit balance (upsert)
    await sql\`
      INSERT INTO org_credit_balance (org_id, balance_usd, lifetime_purchased_usd, updated_at)
      VALUES (\${orgId}, \${BALANCE_USD}, \${BALANCE_USD}, now())
      ON CONFLICT (org_id) DO UPDATE SET
        balance_usd = \${BALANCE_USD},
        lifetime_purchased_usd = org_credit_balance.lifetime_purchased_usd + \${BALANCE_USD},
        updated_at = now()
    \`;

    if (keyValue) {
      apiKeys.push({ org: orgId, key: keyValue });
      console.log('  Org ' + orgId + ': key=' + keyValue.slice(0, 20) + '...');
    } else {
      console.log('  Org ' + orgId + ': FAILED to create API key');
    }
  }

  // Seed autopilot sessions (for the 20% autopilot workload)
  console.log('');
  console.log('Seeding ' + AUTOPILOT_COUNT + ' autopilot sessions...');
  const primaryOrg = 'load-test-org-0';
  let seeded = 0;
  for (let i = 0; i < AUTOPILOT_COUNT; i++) {
    const sessionId = 'load-test-auto-' + i;
    await sql\`
      INSERT INTO autopilot_sessions (session_id, org_id, agent_name, status, tick_interval_seconds, created_at)
      VALUES (\${sessionId}, \${primaryOrg}, \${AGENT_NAME}, 'active', 30, now())
      ON CONFLICT DO NOTHING
    \`.catch(() => {});
    seeded++;
  }
  console.log('  Seeded ' + seeded + ' autopilot sessions on ' + primaryOrg);

  // Print k6 env vars
  console.log('');
  console.log('=== k6 environment variables ===');
  console.log('');
  const envLines = apiKeys.map((k, i) => 'API_KEY_' + i + '=' + k.key);
  console.log(envLines.join(' \\\\\\n  '));
  console.log('');
  console.log('Or as a single key for quick runs:');
  if (apiKeys.length > 0) {
    console.log('API_KEY=' + apiKeys[0].key);
  }

  await sql.end();
  console.log('');
  console.log('Done. ' + apiKeys.length + ' orgs seeded with \$' + BALANCE_USD + ' each.');
})().catch((err) => {
  console.error('Seed error:', err.message);
  process.exit(1);
});
" 2>&1
