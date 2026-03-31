-- ═══════════════════════════════════════════════════════════════════════
-- Migration 028: Enable Row-Level Security on ALL tables
-- ═══════════════════════════════════════════════════════════════════════
--
-- CRITICAL SECURITY FIX: Supabase flagged all tables as publicly accessible.
-- This migration enables RLS on every table and creates policies that:
--   1. Restrict reads/writes to the user's own org_id
--   2. Service-role bypasses RLS (for backend Workers via Hyperdrive)
--   3. Sensitive tables get stricter policies
--
-- NOTE: Our backend connects via Hyperdrive (service role), which bypasses
-- RLS by default. These policies protect against direct Supabase API access
-- (PostgREST, client libraries, dashboard queries).
-- ═══════════════════════════════════════════════════════════════════════

-- Helper: Create a standard org-scoped RLS policy on a table.
-- Usage: SELECT enable_org_rls('table_name');
CREATE OR REPLACE FUNCTION enable_org_rls(tbl TEXT) RETURNS VOID AS $$
BEGIN
  -- Enable RLS
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
  -- Force RLS even for table owners (prevents bypass)
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tbl);
  -- Allow service role full access (our backend Workers)
  EXECUTE format(
    'CREATE POLICY %I ON %I FOR ALL TO service_role USING (true) WITH CHECK (true)',
    tbl || '_service_role', tbl
  );
  -- Allow authenticated users to access only their org's rows
  EXECUTE format(
    'CREATE POLICY %I ON %I FOR ALL TO authenticated USING (org_id = auth.jwt() ->> ''org_id'') WITH CHECK (org_id = auth.jwt() ->> ''org_id'')',
    tbl || '_org_isolation', tbl
  );
END;
$$ LANGUAGE plpgsql;

-- ═══════════════════════════════════════════════════════════════════════
-- 1. Core tables with org_id column
-- ═══════════════════════════════════════════════════════════════════════

SELECT enable_org_rls('agents');
SELECT enable_org_rls('sessions');
SELECT enable_org_rls('billing_records');
SELECT enable_org_rls('credit_transactions');
SELECT enable_org_rls('org_credit_balance');
SELECT enable_org_rls('org_settings');
SELECT enable_org_rls('api_keys');
-- api_key_agent_scopes has no org_id — scoped by key_id (joins to api_keys). Service-only.
-- (moved to service-only section below)
SELECT enable_org_rls('api_access_log');

-- ═══════════════════════════════════════════════════════════════════════
-- 2. Agent-related tables
-- ═══════════════════════════════════════════════════════════════════════

SELECT enable_org_rls('agent_versions');
SELECT enable_org_rls('schedules');
SELECT enable_org_rls('channel_configs');
SELECT enable_org_rls('custom_domains');

-- ═══════════════════════════════════════════════════════════════════════
-- 3. Training & Eval tables
-- ═══════════════════════════════════════════════════════════════════════

SELECT enable_org_rls('training_jobs');
SELECT enable_org_rls('training_iterations');
SELECT enable_org_rls('training_resources');
SELECT enable_org_rls('training_rewards');
SELECT enable_org_rls('eval_runs');
SELECT enable_org_rls('eval_trials');

-- ═══════════════════════════════════════════════════════════════════════
-- 4. Observability & Audit tables
-- ═══════════════════════════════════════════════════════════════════════

SELECT enable_org_rls('audit_log');
SELECT enable_org_rls('security_events');
SELECT enable_org_rls('alert_configs');
SELECT enable_org_rls('alert_history');
SELECT enable_org_rls('slo_evaluations');
SELECT enable_org_rls('slo_error_budgets');

-- ═══════════════════════════════════════════════════════════════════════
-- 5. A2A & Marketplace tables
-- ═══════════════════════════════════════════════════════════════════════

-- a2a_tasks: has caller_org_id/callee_org_id, not org_id — custom policy
ALTER TABLE a2a_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE a2a_tasks FORCE ROW LEVEL SECURITY;
CREATE POLICY a2a_tasks_service_role ON a2a_tasks FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY a2a_tasks_org_isolation ON a2a_tasks FOR ALL TO authenticated
  USING (caller_org_id = auth.jwt() ->> 'org_id' OR callee_org_id = auth.jwt() ->> 'org_id');

-- a2a_artifacts: has sender_org_id/receiver_org_id — custom policy
ALTER TABLE a2a_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE a2a_artifacts FORCE ROW LEVEL SECURITY;
CREATE POLICY a2a_artifacts_service_role ON a2a_artifacts FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY a2a_artifacts_org_isolation ON a2a_artifacts FOR ALL TO authenticated
  USING (sender_org_id = auth.jwt() ->> 'org_id' OR receiver_org_id = auth.jwt() ->> 'org_id');

SELECT enable_org_rls('delegation_events');
SELECT enable_org_rls('marketplace_listings');

-- marketplace_ratings: has rater_org_id, not org_id — custom policy
ALTER TABLE marketplace_ratings ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketplace_ratings FORCE ROW LEVEL SECURITY;
CREATE POLICY marketplace_ratings_service_role ON marketplace_ratings FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY marketplace_ratings_org_isolation ON marketplace_ratings FOR ALL TO authenticated
  USING (rater_org_id = auth.jwt() ->> 'org_id')
  WITH CHECK (rater_org_id = auth.jwt() ->> 'org_id');

-- ═══════════════════════════════════════════════════════════════════════
-- 6. User & Memory tables
-- ═══════════════════════════════════════════════════════════════════════

SELECT enable_org_rls('user_profiles');
-- memory_facts: no org_id, no app code references — service-only
-- (moved to service-only section below)
SELECT enable_org_rls('episodic_memories');
SELECT enable_org_rls('semantic_facts');
SELECT enable_org_rls('user_feedback');

-- ═══════════════════════════════════════════════════════════════════════
-- 7. Feed & Social tables
-- ═══════════════════════════════════════════════════════════════════════

SELECT enable_org_rls('feed_posts');

-- ═══════════════════════════════════════════════════════════════════════
-- 8. Compliance & Governance tables
-- ═══════════════════════════════════════════════════════════════════════

SELECT enable_org_rls('guardrail_events');
SELECT enable_org_rls('guardrail_policies');
SELECT enable_org_rls('account_deletion_requests');
SELECT enable_org_rls('data_export_requests');

-- ═══════════════════════════════════════════════════════════════════════
-- 9. Pipeline & Workflow tables
-- ═══════════════════════════════════════════════════════════════════════

SELECT enable_org_rls('pipelines');
SELECT enable_org_rls('batch_jobs');
SELECT enable_org_rls('batch_tasks');

-- ═══════════════════════════════════════════════════════════════════════
-- 10. Referral & Billing tables
-- ═══════════════════════════════════════════════════════════════════════

SELECT enable_org_rls('referral_codes');

-- referrals: has referrer_org_id/referred_org_id, not org_id — custom policy
ALTER TABLE referrals ENABLE ROW LEVEL SECURITY;
ALTER TABLE referrals FORCE ROW LEVEL SECURITY;
CREATE POLICY referrals_service_role ON referrals FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY referrals_org_isolation ON referrals FOR ALL TO authenticated
  USING (referrer_org_id = auth.jwt() ->> 'org_id' OR referred_org_id = auth.jwt() ->> 'org_id');

-- referral_earnings: has earner_org_id, not org_id — custom policy
ALTER TABLE referral_earnings ENABLE ROW LEVEL SECURITY;
ALTER TABLE referral_earnings FORCE ROW LEVEL SECURITY;
CREATE POLICY referral_earnings_service_role ON referral_earnings FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY referral_earnings_org_isolation ON referral_earnings FOR ALL TO authenticated
  USING (earner_org_id = auth.jwt() ->> 'org_id')
  WITH CHECK (earner_org_id = auth.jwt() ->> 'org_id');

-- ═══════════════════════════════════════════════════════════════════════
-- 11. Evolution & Analysis tables
-- ═══════════════════════════════════════════════════════════════════════

SELECT enable_org_rls('evolution_proposals');
SELECT enable_org_rls('evolution_ledger');
SELECT enable_org_rls('evolution_reports');
SELECT enable_org_rls('evolution_schedules');

-- ═══════════════════════════════════════════════════════════════════════
-- 12. Turns table — joined via sessions.org_id
-- Turns don't have org_id directly; they reference sessions.
-- Use a policy that joins to sessions for org check.
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE turns ENABLE ROW LEVEL SECURITY;
ALTER TABLE turns FORCE ROW LEVEL SECURITY;

CREATE POLICY turns_service_role ON turns
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY turns_org_isolation ON turns
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM sessions s
      WHERE s.session_id = turns.session_id
        AND s.org_id = auth.jwt() ->> 'org_id'
    )
  );

-- ═══════════════════════════════════════════════════════════════════════
-- 13. Tables without org_id — restrict to service_role only
-- These tables should never be accessed via client/PostgREST.
-- ═══════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOR tbl IN
    SELECT unnest(ARRAY[
      'password_reset_tokens',
      'email_verification_tokens',
      'connector_tokens',
      'stripe_events_processed',
      'idempotency_cache',
      'secrets_key_rotations',
      'credit_packages',
      'network_stats',
      'user_sessions',
      'auth_audit_log',
      'end_user_tokens',
      'end_user_usage',
      'file_uploads',
      'voice_numbers',
      'webhook_deliveries',
      'skills',
      'tool_registry',
      'tool_executions',
      'feature_flags',
      'github_webhook_subscriptions',
      'autopilot_sessions',
      'api_key_agent_scopes',
      'memory_facts'
    ])
  LOOP
    BEGIN
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
      EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tbl);
      EXECUTE format(
        'CREATE POLICY %I ON %I FOR ALL TO service_role USING (true) WITH CHECK (true)',
        tbl || '_service_only', tbl
      );
      -- No policy for authenticated = complete deny for direct client access
    EXCEPTION WHEN undefined_table THEN
      -- Table doesn't exist yet — skip silently
      NULL;
    END;
  END LOOP;
END $$;

-- ═══════════════════════════════════════════════════════════════════════
-- 14. Marketplace listings — public read, org-scoped write
-- Anyone can browse the marketplace, but only the owner org can edit.
-- ═══════════════════════════════════════════════════════════════════════

-- Drop the default org_isolation policy and replace with split read/write
DROP POLICY IF EXISTS marketplace_listings_org_isolation ON marketplace_listings;

CREATE POLICY marketplace_listings_public_read ON marketplace_listings
  FOR SELECT TO authenticated USING (true);

CREATE POLICY marketplace_listings_org_write ON marketplace_listings
  FOR ALL TO authenticated
  USING (org_id = auth.jwt() ->> 'org_id')
  WITH CHECK (org_id = auth.jwt() ->> 'org_id');

-- Same for feed_posts — public read
DROP POLICY IF EXISTS feed_posts_org_isolation ON feed_posts;

CREATE POLICY feed_posts_public_read ON feed_posts
  FOR SELECT TO authenticated USING (true);

CREATE POLICY feed_posts_org_write ON feed_posts
  FOR ALL TO authenticated
  USING (org_id = auth.jwt() ->> 'org_id')
  WITH CHECK (org_id = auth.jwt() ->> 'org_id');

-- ═══════════════════════════════════════════════════════════════════════
-- 15. Revoke anon access to all tables (belt + suspenders)
-- ═══════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  tbl RECORD;
BEGIN
  FOR tbl IN
    SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  LOOP
    BEGIN
      EXECUTE format('REVOKE ALL ON %I FROM anon', tbl.tablename);
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END LOOP;
END $$;

-- ═══════════════════════════════════════════════════════════════════════
-- Cleanup: drop the helper function
-- ═══════════════════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS enable_org_rls(TEXT);

-- ═══════════════════════════════════════════════════════════════════════
-- IMPORTANT: After applying this migration, verify:
--   1. Run: SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname = 'public';
--      All tables should show rowsecurity = true
--   2. Test with anon key: should get 0 rows from all tables
--   3. Backend (service_role via Hyperdrive) should work unchanged
-- ═══════════════════════════════════════════════════════════════════════
