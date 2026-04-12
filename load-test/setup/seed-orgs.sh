#!/usr/bin/env bash
#
# Seed load-test orgs, agents, API keys, and credit balances.
#
# Creates 10 orgs (load-test-org-0 through load-test-org-9), each with:
# - An agent named "load-test-agent"
# - An API key (hashed with SHA-256, matching the auth middleware)
# - $10,000 credit balance
#
# Also seeds 1000 autopilot sessions for the autopilot workload.
#
# Usage:
#   ./load-test/setup/seed-orgs.sh
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
const crypto = require('crypto');
const sql = postgres(process.env.DATABASE_URL, { max: 1, idle_timeout: 10, connect_timeout: 10 });

const ORG_COUNT = ${ORG_COUNT};
const BALANCE_USD = ${BALANCE_USD};
const AUTOPILOT_COUNT = ${AUTOPILOT_COUNT};
const AGENT_NAME = '${AGENT_NAME}';

async function hashApiKey(key) {
  const data = new TextEncoder().encode(key);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
}

(async () => {
  const apiKeys = [];

  for (let i = 0; i < ORG_COUNT; i++) {
    const orgId = 'load-test-org-' + i;
    const userId = 'load-test-user-' + i;

    // Create org (idempotent)
    await sql\`
      INSERT INTO orgs (org_id, name, slug, owner_user_id, plan, created_at, updated_at)
      VALUES (\${orgId}, \${'Load Test Org ' + i}, \${'load-test-' + i}, \${userId}, 'standard', now(), now())
      ON CONFLICT (org_id) DO NOTHING
    \`.catch((e) => console.error('  org insert:', e.message));

    // Create user (idempotent)
    await sql\`
      INSERT INTO users (user_id, email, name, created_at)
      VALUES (\${userId}, \${userId + '@loadtest.local'}, \${'Load Test User ' + i}, now())
      ON CONFLICT (user_id) DO NOTHING
    \`.catch(() => {});

    // Create org membership (idempotent)
    await sql\`
      INSERT INTO org_members (org_id, user_id, role, created_at)
      VALUES (\${orgId}, \${userId}, 'admin', now())
      ON CONFLICT (org_id, user_id) DO NOTHING
    \`.catch(() => {});

    // Create agent (idempotent — ON CONFLICT on (name, org_id) unique)
    await sql\`
      INSERT INTO agents (name, org_id, description, config, is_active, created_at, updated_at)
      VALUES (\${AGENT_NAME}, \${orgId}, 'Load test agent',
              \${JSON.stringify({
                system_prompt: 'You are a load test agent. Respond briefly.',
                model: 'load-test-mock',
                plan: 'standard',
                tools: [],
                budget_limit_usd: 100
              })},
              true, now(), now())
      ON CONFLICT DO NOTHING
    \`.catch(() => {});

    // Generate API key using the same hashing as auth/api-keys.ts
    const rawKey = 'ak_' + crypto.randomUUID().replace(/-/g, '');
    const keyPrefix = rawKey.slice(0, 11);
    const keyHash = await hashApiKey(rawKey);
    const keyId = crypto.randomUUID();

    // Check for existing key first
    const existing = await sql\`
      SELECT key_prefix FROM api_keys WHERE org_id = \${orgId} AND name = 'load-test' LIMIT 1
    \`.catch(() => []);

    let usableKey;
    if (existing.length > 0) {
      // Key already exists — we can't recover the raw key. Create a new one.
      const newRaw = 'ak_' + crypto.randomUUID().replace(/-/g, '');
      const newPrefix = newRaw.slice(0, 11);
      const newHash = await hashApiKey(newRaw);
      const newId = crypto.randomUUID();
      await sql\`
        UPDATE api_keys SET key_hash = \${newHash}, key_prefix = \${newPrefix}, key_id = \${newId},
          rate_limit_rpm = 10000, rate_limit_rpd = 1000000, is_active = true, revoked = false,
          updated_at = now()
        WHERE org_id = \${orgId} AND name = 'load-test'
      \`;
      usableKey = newRaw;
    } else {
      await sql\`
        INSERT INTO api_keys (key_id, org_id, user_id, name, key_prefix, key_hash, scopes,
          rate_limit_rpm, rate_limit_rpd, is_active, revoked, created_at, updated_at)
        VALUES (\${keyId}, \${orgId}, \${userId}, 'load-test', \${keyPrefix}, \${keyHash},
          '\"*\"'::jsonb, 10000, 1000000, true, false, now(), now())
      \`.catch((e) => console.error('  key insert:', e.message));
      usableKey = rawKey;
    }

    // Seed credit balance (upsert)
    await sql\`
      INSERT INTO org_credit_balance (org_id, balance_usd, lifetime_purchased_usd, updated_at)
      VALUES (\${orgId}, \${BALANCE_USD}, \${BALANCE_USD}, now())
      ON CONFLICT (org_id) DO UPDATE SET
        balance_usd = \${BALANCE_USD},
        updated_at = now()
    \`;

    if (usableKey) {
      apiKeys.push({ org: orgId, key: usableKey });
      console.log('  Org ' + orgId + ': key=' + usableKey.slice(0, 20) + '...');
    } else {
      console.log('  Org ' + orgId + ': FAILED');
    }
  }

  // Seed autopilot sessions
  console.log('');
  console.log('Seeding ' + AUTOPILOT_COUNT + ' autopilot sessions...');
  const primaryOrg = 'load-test-org-0';
  let seeded = 0;
  for (let i = 0; i < AUTOPILOT_COUNT; i++) {
    const sessionId = 'load-test-auto-' + i;
    await sql\`
      INSERT INTO autopilot_sessions (session_id, org_id, agent_name, status, tick_interval_seconds, created_at, updated_at)
      VALUES (\${sessionId}, \${primaryOrg}, \${AGENT_NAME}, 'active', 30, now(), now())
      ON CONFLICT DO NOTHING
    \`.catch(() => {});
    seeded++;
  }
  console.log('  Seeded ' + seeded + ' autopilot sessions on ' + primaryOrg);

  // Print k6 env vars
  console.log('');
  console.log('=== k6 environment variables ===');
  console.log('');
  for (let i = 0; i < apiKeys.length; i++) {
    console.log('export K6_API_KEY_' + i + '=' + apiKeys[i].key);
  }
  console.log('');
  console.log('# Single-key shortcut:');
  if (apiKeys.length > 0) {
    console.log('export K6_API_KEY=' + apiKeys[0].key);
  }
  console.log('');
  console.log('# k6 run command:');
  const keyArgs = apiKeys.map((k, i) => '-e API_KEY_' + i + '=' + k.key).join(' ');
  console.log('k6 run -e BASE_URL=https://agentos-control-plane-staging.servesys.workers.dev ' + keyArgs + ' -e TARGET_RPS=50 load-test/k6/main.js');

  await sql.end();
  console.log('');
  console.log('Done. ' + apiKeys.length + ' orgs seeded with \$' + BALANCE_USD + ' each.');
})().catch((err) => {
  console.error('Seed error:', err.message);
  process.exit(1);
});
" 2>&1
