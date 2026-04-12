# Phase 4 Runbook — DB Reset + Reseed

**Target:** Railway Postgres at `metro.proxy.rlwy.net:28702`
**Risk level:** DESTRUCTIVE — all data deleted, schema preserved
**Estimated time:** 10 minutes
**Rollback:** Restore from Railway snapshot (must exist before starting)

---

## Operator Checklist (all gates must pass before Step 2)

| # | Gate | Evidence required | Status |
|---|------|-------------------|--------|
| G1 | **Snapshot proof** | Railway snapshot ID + timestamp recorded below | `[ ]` |
| G2 | **Queue quiesced** | TELEMETRY_QUEUE depth = 0 (CF dashboard screenshot or CLI output) | `[ ]` |
| G3 | **Target DB fingerprint** | `current_database()`, `inet_server_addr()`, row-count baseline printed in Step 1 | `[ ]` |
| G4 | **Rollback drill** | Restore command + owner identified, tested at least once | `[ ]` |

**Snapshot ID:** ____________________
**Snapshot timestamp:** ____________________
**Restore owner:** ____________________
**Restore command:** `railway volume restore --snapshot-id <ID>` (or Railway dashboard → Deployments → Volumes → Restore)

**DO NOT proceed past Step 1 until all 4 gates are checked.**

---

## Step 1: Connect and verify target (Gate G3)

```bash
# Connect via psql (Railway Postgres)
psql "postgresql://postgres:rGrnYWekMILmZMjMsQEFafIqvBVPyYiX@metro.proxy.rlwy.net:28702/railway"
```

```sql
-- Verify this is the right database
SELECT current_database(), inet_server_addr(), version();

-- Row counts before reset (save output for audit)
SELECT 'users' AS tbl, count(*)::int FROM users
UNION ALL SELECT 'orgs', count(*)::int FROM orgs
UNION ALL SELECT 'sessions', count(*)::int FROM sessions
UNION ALL SELECT 'turns', count(*)::int FROM turns
UNION ALL SELECT 'otel_events', count(*)::int FROM otel_events
UNION ALL SELECT 'runtime_events', count(*)::int FROM runtime_events
UNION ALL SELECT 'audit_log', count(*)::int FROM audit_log
UNION ALL SELECT 'security_events', count(*)::int FROM security_events
UNION ALL SELECT 'credit_holds', count(*)::int FROM credit_holds
UNION ALL SELECT 'credit_transactions', count(*)::int FROM credit_transactions
UNION ALL SELECT 'billing_records', count(*)::int FROM billing_records
UNION ALL SELECT 'org_credit_balance', count(*)::int FROM org_credit_balance
UNION ALL SELECT 'api_keys', count(*)::int FROM api_keys
UNION ALL SELECT 'agents', count(*)::int FROM agents
UNION ALL SELECT 'do_conversation_messages', count(*)::int FROM do_conversation_messages
ORDER BY tbl;
```

**Expected:** ~620K total rows of load test artifacts. Verify this matches expectations before proceeding.

---

## Step 2: TRUNCATE all data tables (single transaction)

```sql
BEGIN;

-- Core entities (CASCADE handles FK-dependent tables)
TRUNCATE TABLE
  users,
  orgs
CASCADE;

-- The CASCADE above should clear most tables via FK ON DELETE CASCADE.
-- Explicitly truncate tables that may not have CASCADE FKs:
TRUNCATE TABLE
  otel_events,
  runtime_events,
  middleware_events,
  tool_executions,
  span_feedback,
  trace_annotations,
  trace_lineage,
  audit_log,
  audit_log_archive,
  security_events,
  guardrail_events,
  job_queue,
  batch_jobs,
  batch_tasks,
  schedules,
  idempotency_cache,
  event_types,
  stripe_events_processed,
  billing_events,
  billing_exceptions,
  network_stats,
  feed_posts,
  issues,
  schema_validation_errors,
  codemode_executions,
  voice_calls,
  voice_numbers,
  voice_clones,
  autopilot_sessions,
  rag_chunks,
  marketplace_queries,
  alert_history,
  slo_evaluations,
  slo_error_budgets,
  webhook_deliveries,
  api_access_log
CASCADE;

-- ── POST-TRUNCATE ASSERT BLOCK ──────────────────────────────────
-- All critical tables MUST be zero. DO NOT COMMIT if any fail.
ANALYZE;

DO $$
DECLARE
  _users int; _orgs int; _sessions int; _turns int;
  _otel int; _runtime int; _audit int; _security int;
  _credit_holds int; _credit_txns int; _billing int;
  _api_keys int; _agents int;
BEGIN
  SELECT count(*) INTO _users FROM users;
  SELECT count(*) INTO _orgs FROM orgs;
  SELECT count(*) INTO _sessions FROM sessions;
  SELECT count(*) INTO _turns FROM turns;
  SELECT count(*) INTO _otel FROM otel_events;
  SELECT count(*) INTO _runtime FROM runtime_events;
  SELECT count(*) INTO _audit FROM audit_log;
  SELECT count(*) INTO _security FROM security_events;
  SELECT count(*) INTO _credit_holds FROM credit_holds;
  SELECT count(*) INTO _credit_txns FROM credit_transactions;
  SELECT count(*) INTO _billing FROM billing_records;
  SELECT count(*) INTO _api_keys FROM api_keys;
  SELECT count(*) INTO _agents FROM agents;

  IF _users + _orgs + _sessions + _turns + _otel + _runtime +
     _audit + _security + _credit_holds + _credit_txns +
     _billing + _api_keys + _agents > 0 THEN
    RAISE EXCEPTION 'ASSERT FAILED: tables not empty after truncate. users=%, orgs=%, sessions=%, turns=%, otel=%, runtime=%, audit=%, security=%, holds=%, txns=%, billing=%, keys=%, agents=%',
      _users, _orgs, _sessions, _turns, _otel, _runtime,
      _audit, _security, _credit_holds, _credit_txns,
      _billing, _api_keys, _agents;
  END IF;

  RAISE NOTICE 'ASSERT PASSED: all 13 critical tables are empty';
END $$;

-- Also check for any stragglers via pg_stat
SELECT schemaname, relname, n_live_tup
FROM pg_stat_user_tables
WHERE n_live_tup > 0
ORDER BY n_live_tup DESC
LIMIT 20;

-- If the ASSERT passed, commit. If not, the transaction already aborted.
COMMIT;
```

---

## Step 3: Reseed founder accounts

```sql
-- ══════════════════════════════════════════════════════════════
-- Founder 1: founder@oneshots.co
-- ══════════════════════════════════════════════════════════════

INSERT INTO users (user_id, email, name, password_hash, provider, email_verified)
VALUES (
  'usr_founder_001',
  'founder@oneshots.co',
  'Ish',
  -- bcrypt hash of a known password (operator sets real password after)
  '$2a$10$placeholder_change_me_after_seed',
  'email',
  true
);

INSERT INTO orgs (org_id, name, slug, owner_user_id, plan)
VALUES (
  'org_oneshots_001',
  'OneShots',
  'oneshots',
  'usr_founder_001',
  'enterprise'
);

INSERT INTO org_members (org_id, user_id, role)
VALUES ('org_oneshots_001', 'usr_founder_001', 'owner');

INSERT INTO org_settings (org_id, plan_type, onboarding_complete)
VALUES ('org_oneshots_001', 'enterprise', true);

INSERT INTO org_credit_balance (org_id, balance_usd, lifetime_purchased_usd)
VALUES ('org_oneshots_001', 100.00, 100.00);

INSERT INTO credit_transactions (org_id, type, amount_usd, balance_after_usd, description)
VALUES ('org_oneshots_001', 'bonus', 100.00, 100.00, 'Founder seed credit');

-- Default assistant agent
INSERT INTO agents (agent_id, org_id, name, description, config, agent_role)
VALUES (
  'agt_oneshots_asst',
  'org_oneshots_001',
  'assistant',
  'Default assistant agent',
  '{"provider":"anthropic","model":"claude-sonnet-4-20250514","max_turns":25,"budget_limit_usd":5,"tools":["search","browse","code_interpreter"],"blocked_tools":[],"allowed_domains":[],"parallel_tool_calls":true,"require_confirmation_for_destructive":false,"max_tokens_per_turn":4096}'::jsonb,
  'personal_assistant'
);

-- ══════════════════════════════════════════════════════════════
-- Founder 2: stella@021agents.ai
-- ══════════════════════════════════════════════════════════════

INSERT INTO users (user_id, email, name, password_hash, provider, email_verified)
VALUES (
  'usr_founder_002',
  'stella@021agents.ai',
  'Stella',
  '$2a$10$placeholder_change_me_after_seed',
  'email',
  true
);

INSERT INTO orgs (org_id, name, slug, owner_user_id, plan)
VALUES (
  'org_021agents_001',
  '021 Agents',
  '021agents',
  'usr_founder_002',
  'enterprise'
);

INSERT INTO org_members (org_id, user_id, role)
VALUES ('org_021agents_001', 'usr_founder_002', 'owner');

INSERT INTO org_settings (org_id, plan_type, onboarding_complete)
VALUES ('org_021agents_001', 'enterprise', true);

INSERT INTO org_credit_balance (org_id, balance_usd, lifetime_purchased_usd)
VALUES ('org_021agents_001', 100.00, 100.00);

INSERT INTO credit_transactions (org_id, type, amount_usd, balance_after_usd, description)
VALUES ('org_021agents_001', 'bonus', 100.00, 100.00, 'Founder seed credit');

INSERT INTO agents (agent_id, org_id, name, description, config, agent_role)
VALUES (
  'agt_021agents_asst',
  'org_021agents_001',
  'assistant',
  'Default assistant agent',
  '{"provider":"anthropic","model":"claude-sonnet-4-20250514","max_turns":25,"budget_limit_usd":5,"tools":["search","browse","code_interpreter"],"blocked_tools":[],"allowed_domains":[],"parallel_tool_calls":true,"require_confirmation_for_destructive":false,"max_tokens_per_turn":4096}'::jsonb,
  'personal_assistant'
);

-- ══════════════════════════════════════════════════════════════
-- Seed event_types catalog (global, not org-scoped)
-- ══════════════════════════════════════════════════════════════

INSERT INTO event_types (event_type, category, description) VALUES
  ('agent.created',          'agents',     'Agent was created'),
  ('agent.updated',          'agents',     'Agent config was updated'),
  ('agent.deleted',          'agents',     'Agent was deleted'),
  ('session.started',        'sessions',   'Agent session started'),
  ('session.completed',      'sessions',   'Agent session completed'),
  ('session.failed',         'sessions',   'Agent session failed'),
  ('connector.token_stored', 'connectors', 'OAuth token stored'),
  ('connector.tool_call',    'connectors', 'Connector tool invoked'),
  ('retention.applied',      'retention',  'Retention policy applied'),
  ('config.update',          'config',     'Configuration changed'),
  ('member.invited',         'orgs',       'Member invited to org'),
  ('member.removed',         'orgs',       'Member removed from org')
ON CONFLICT (event_type) DO NOTHING;
```

---

## Step 4: Generate API keys (run from app layer)

API keys need SHA-256 hashing which is best done from the app, not raw SQL.
Run this from a local machine with Node.js:

```bash
# Generate and insert API keys for both founders
# This script connects to Railway, generates keys, hashes them, and inserts.
cd /Users/ishprasad/agent-mute/one-shot/control-plane
npx tsx -e "
const crypto = await import('crypto');

function generateKey() {
  const raw = 'ak_' + crypto.randomUUID().replace(/-/g, '');
  const prefix = raw.slice(0, 11);
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  return { raw, prefix, hash };
}

const k1 = generateKey();
const k2 = generateKey();

console.log('=== OneShots founder key ===');
console.log('Key (save this):', k1.raw);
console.log('SQL:');
console.log(\`INSERT INTO api_keys (key_id, org_id, user_id, name, key_hash, key_prefix, scopes, is_active, created_at)
VALUES ('apikey_founder_001', 'org_oneshots_001', 'usr_founder_001', 'Founder key',
        '\${k1.hash}', '\${k1.prefix}', '[\"*\"]'::jsonb, true, now());\`);

console.log();
console.log('=== 021 Agents founder key ===');
console.log('Key (save this):', k2.raw);
console.log('SQL:');
console.log(\`INSERT INTO api_keys (key_id, org_id, user_id, name, key_hash, key_prefix, scopes, is_active, created_at)
VALUES ('apikey_founder_002', 'org_021agents_001', 'usr_founder_002', 'Founder key',
        '\${k2.hash}', '\${k2.prefix}', '[\"*\"]'::jsonb, true, now());\`);
"
```

**Copy the generated SQL and run it in the psql session. Save the raw keys securely.**

---

## Step 5: Post-reset verification

```sql
-- Row counts after reseed
SELECT 'users' AS tbl, count(*)::int FROM users
UNION ALL SELECT 'orgs', count(*)::int FROM orgs
UNION ALL SELECT 'org_members', count(*)::int FROM org_members
UNION ALL SELECT 'org_credit_balance', count(*)::int FROM org_credit_balance
UNION ALL SELECT 'credit_transactions', count(*)::int FROM credit_transactions
UNION ALL SELECT 'agents', count(*)::int FROM agents
UNION ALL SELECT 'api_keys', count(*)::int FROM api_keys
UNION ALL SELECT 'event_types', count(*)::int FROM event_types
UNION ALL SELECT 'org_settings', count(*)::int FROM org_settings
ORDER BY tbl;
```

**Expected:**
| Table | Rows |
|---|---|
| users | 2 |
| orgs | 2 |
| org_members | 2 |
| org_credit_balance | 2 |
| credit_transactions | 2 |
| agents | 2 |
| api_keys | 2 |
| event_types | 12 |
| org_settings | 2 |

```sql
-- Verify credit balances
SELECT org_id, balance_usd, reserved_usd, lifetime_purchased_usd
FROM org_credit_balance;

-- Verify no orphaned data
SELECT schemaname, relname, n_live_tup
FROM pg_stat_user_tables
WHERE n_live_tup > 0
  AND relname NOT IN ('users','orgs','org_members','org_credit_balance',
                       'credit_transactions','agents','api_keys','event_types',
                       'org_settings')
ORDER BY n_live_tup DESC;
```

---

## Step 6: End-to-end live test (Phase 5)

After reset, send one request through the API and verify rows appear:

```bash
# Replace API_KEY with the founder key from Step 4
curl -X POST https://api.oneshots.co/v1/run \
  -H "Authorization: Bearer API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"agent_name":"assistant","task":"Say hello in one sentence."}'
```

Wait 15 seconds for the telemetry queue to drain, then verify in psql:

```sql
SELECT 'sessions' AS tbl, count(*)::int AS cnt FROM sessions WHERE org_id = 'org_oneshots_001'
UNION ALL SELECT 'turns', count(*)::int FROM turns
UNION ALL SELECT 'otel_events', count(*)::int FROM otel_events
UNION ALL SELECT 'runtime_events', count(*)::int FROM runtime_events
UNION ALL SELECT 'billing_records', count(*)::int FROM billing_records
UNION ALL SELECT 'credit_transactions', count(*)::int FROM credit_transactions
UNION ALL SELECT 'credit_holds', count(*)::int FROM credit_holds
ORDER BY tbl;
```

### Pass criteria (ALL must be true)

| Assertion | Condition | Notes |
|-----------|-----------|-------|
| Session created | `sessions >= 1` | Proves auth + session write path works |
| Turn recorded | `turns >= 1` | Proves LLM call + turn persistence works |
| Billing recorded | `billing_records >= 1` | Proves cost tracking pipeline works |
| Credit hold lifecycle | `credit_holds >= 1` (status = 'settled') OR `credit_transactions >= 3` | Proves reserve/settle cycle completed |
| Telemetry flowing | `otel_events >= 1` OR `runtime_events >= 1` | Proves queue consumer → DB write path works. If both are 0 after 30s, check queue depth. |
| Credit balance debited | `SELECT balance_usd FROM org_credit_balance WHERE org_id = 'org_oneshots_001'` returns `< 100.00` | Proves billing actually deducted |

```sql
-- Final pass/fail check (run after live test)
DO $$
DECLARE
  _sessions int; _turns int; _billing int;
  _telemetry int; _balance numeric;
BEGIN
  SELECT count(*) INTO _sessions FROM sessions WHERE org_id = 'org_oneshots_001';
  SELECT count(*) INTO _turns FROM turns;
  SELECT count(*) INTO _billing FROM billing_records;
  SELECT count(*) INTO _telemetry FROM (
    SELECT 1 FROM otel_events LIMIT 1
    UNION ALL
    SELECT 1 FROM runtime_events LIMIT 1
  ) t;
  SELECT balance_usd INTO _balance FROM org_credit_balance
    WHERE org_id = 'org_oneshots_001';

  IF _sessions < 1 THEN RAISE EXCEPTION 'FAIL: no sessions created'; END IF;
  IF _turns < 1 THEN RAISE EXCEPTION 'FAIL: no turns recorded'; END IF;
  IF _billing < 1 THEN RAISE EXCEPTION 'FAIL: no billing records'; END IF;
  IF _telemetry < 1 THEN RAISE WARNING 'WARN: no telemetry rows yet — check queue depth'; END IF;
  IF _balance >= 100.00 THEN RAISE WARNING 'WARN: credit balance not debited — check billing pipeline'; END IF;

  RAISE NOTICE 'PASS: sessions=%, turns=%, billing=%, telemetry=%, balance=%',
    _sessions, _turns, _billing, _telemetry, _balance;
END $$;
```

**If all pass: Phase 4+5 complete. Production is live on clean data.**
**If any FAIL: investigate before declaring success. WARN items can be retried after queue drain.**

---

## Rollback

If anything goes wrong after COMMIT:
1. Restore from Railway snapshot taken in pre-flight
2. Redeploy workers pointing at restored DB (Hyperdrive configs unchanged)
3. **Restore command:** `railway volume restore --snapshot-id <ID>` or Railway dashboard → Deployments → Volumes → Restore

---

## Notes

- Password hashes are placeholders. Operator must set real passwords via `/auth/forgot-password` flow or direct bcrypt update.
- API keys are generated fresh — old keys are invalidated by truncate.
- The telemetry queue may have in-flight messages that fail to INSERT after truncate (FK on org_id). These will retry and succeed after reseed since the org_ids match.
