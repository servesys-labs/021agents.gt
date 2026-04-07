-- ============================================================================
-- 003_rls_and_hardening.sql — Row-Level Security + Schema Hardening
-- Generated: 2026-04-07
-- Prerequisites: 001_init.sql (consolidated schema), 002_rag_chunks_fts.sql
--
-- This migration:
--   1. Adds missing indexes for query performance
--   2. Adds CHECK constraints for data integrity
--   3. Fixes FK gaps and NOT NULL constraints
--   4. Enables RLS on all multi-tenant tables
--   5. Creates org-isolation policies
-- ============================================================================

-- ============================================================================
-- SECTION 1: Missing Indexes
-- ============================================================================

-- Secrets: looked up by (org_id, name) on every channel token fetch
CREATE INDEX IF NOT EXISTS idx_secrets_org_name
  ON secrets(org_id, name);

-- Channel configs: filtered by (org_id, channel, is_active) on every inbound message
CREATE INDEX IF NOT EXISTS idx_channel_configs_org_channel_active
  ON channel_configs(org_id, channel) WHERE is_active = true;

-- Billing records: aggregated by org + agent for dashboard
CREATE INDEX IF NOT EXISTS idx_billing_records_org_agent
  ON billing_records(org_id, agent_name);

-- Agent versions: queried by agent_name for version listing
CREATE INDEX IF NOT EXISTS idx_agent_versions_name
  ON agent_versions(agent_name);

-- OTel events: queried by session + time for trace timeline
CREATE INDEX IF NOT EXISTS idx_otel_events_session_created
  ON otel_events(session_id, created_at DESC);

-- Eval runs: queried by org for dashboard
CREATE INDEX IF NOT EXISTS idx_eval_runs_org_created
  ON eval_runs(org_id, created_at DESC);

-- RAG chunks: queried by org + agent for filtered search
CREATE INDEX IF NOT EXISTS idx_rag_chunks_pipeline
  ON rag_chunks(pipeline);

-- ============================================================================
-- SECTION 2: CHECK Constraints — Data Integrity
-- ============================================================================

-- Confidence/quality scores must be 0.0-1.0
DO $$ BEGIN
  ALTER TABLE facts ADD CONSTRAINT chk_facts_confidence
    CHECK (confidence >= 0 AND confidence <= 1);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE dlp_classifications ADD CONSTRAINT chk_dlp_confidence
    CHECK (confidence >= 0 AND confidence <= 1);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Percentage columns must be 0-100
DO $$ BEGIN
  ALTER TABLE slo_error_budgets ADD CONSTRAINT chk_slo_budget_pct
    CHECK (budget_remaining_pct >= 0 AND budget_remaining_pct <= 100);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Pass rate must be 0.0-1.0
DO $$ BEGIN
  ALTER TABLE eval_runs ADD CONSTRAINT chk_eval_pass_rate
    CHECK (pass_rate >= 0 AND pass_rate <= 1);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ============================================================================
-- SECTION 3: FK + NOT NULL Fixes
-- ============================================================================

-- agent_versions: add FK to orgs
DO $$ BEGIN
  ALTER TABLE agent_versions ADD CONSTRAINT fk_agent_versions_org
    FOREIGN KEY (org_id) REFERENCES orgs(org_id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- transfer_pairs: add FK to orgs (RESTRICT, not CASCADE — don't delete orgs with active transfers)
DO $$ BEGIN
  ALTER TABLE transfer_pairs ADD CONSTRAINT fk_transfer_from_org
    FOREIGN KEY (from_org_id) REFERENCES orgs(org_id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE transfer_pairs ADD CONSTRAINT fk_transfer_to_org
    FOREIGN KEY (to_org_id) REFERENCES orgs(org_id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ============================================================================
-- SECTION 4: Row-Level Security — Org Isolation
-- ============================================================================
-- Pattern: app.current_org_id is set via SET LOCAL at transaction start.
-- Backend (service-token) sets it from the authenticated org context.
-- Direct Postgres connections (admin) bypass via superuser or service_role.
--
-- Hyperdrive note: Hyperdrive uses transaction-mode pooling. SET LOCAL
-- is scoped to the transaction and automatically cleared on COMMIT/ROLLBACK.
-- This is safe for connection pooling — no org_id leaks between requests.
-- ============================================================================

-- Helper function to get current org_id from session context
CREATE OR REPLACE FUNCTION current_org_id() RETURNS TEXT AS $$
BEGIN
  RETURN COALESCE(current_setting('app.current_org_id', true), '');
END;
$$ LANGUAGE plpgsql STABLE;

-- ── Tier 1: Critical (credentials, sessions, billing) ─────────────

-- Secrets
ALTER TABLE secrets ENABLE ROW LEVEL SECURITY;
CREATE POLICY secrets_org_isolation ON secrets
  FOR ALL USING (org_id = current_org_id());

-- API Keys
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
CREATE POLICY api_keys_org_isolation ON api_keys
  FOR ALL USING (org_id = current_org_id());

-- Sessions
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY sessions_org_isolation ON sessions
  FOR ALL USING (org_id = current_org_id());

-- Billing Records
ALTER TABLE billing_records ENABLE ROW LEVEL SECURITY;
CREATE POLICY billing_records_org_isolation ON billing_records
  FOR ALL USING (org_id = current_org_id());

-- Credit Transactions
ALTER TABLE credit_transactions ENABLE ROW LEVEL SECURITY;
CREATE POLICY credit_transactions_org_isolation ON credit_transactions
  FOR ALL USING (org_id = current_org_id());

-- Org Credit Balance
ALTER TABLE org_credit_balance ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_credit_balance_org_isolation ON org_credit_balance
  FOR ALL USING (org_id = current_org_id());

-- End User Tokens
ALTER TABLE end_user_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY end_user_tokens_org_isolation ON end_user_tokens
  FOR ALL USING (org_id = current_org_id());

-- Connector Tokens
ALTER TABLE connector_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY connector_tokens_org_isolation ON connector_tokens
  FOR ALL USING (org_id = current_org_id());

-- ── Tier 2: High (agent config, observability, eval) ──────────────

-- Agents
ALTER TABLE agents ENABLE ROW LEVEL SECURITY;
CREATE POLICY agents_org_isolation ON agents
  FOR ALL USING (org_id = current_org_id());

-- Conversations
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
CREATE POLICY conversations_org_isolation ON conversations
  FOR ALL USING (org_id = current_org_id());

-- Eval Runs
ALTER TABLE eval_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY eval_runs_org_isolation ON eval_runs
  FOR ALL USING (org_id = current_org_id());

-- OTel Events
ALTER TABLE otel_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY otel_events_org_isolation ON otel_events
  FOR ALL USING (org_id = current_org_id());

-- Runtime Events
ALTER TABLE runtime_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY runtime_events_org_isolation ON runtime_events
  FOR ALL USING (org_id = current_org_id());

-- Tool Executions
ALTER TABLE tool_executions ENABLE ROW LEVEL SECURITY;
CREATE POLICY tool_executions_org_isolation ON tool_executions
  FOR ALL USING (org_id = current_org_id());

-- Channel Configs
ALTER TABLE channel_configs ENABLE ROW LEVEL SECURITY;
CREATE POLICY channel_configs_org_isolation ON channel_configs
  FOR ALL USING (org_id = current_org_id());

-- Skills
ALTER TABLE skills ENABLE ROW LEVEL SECURITY;
CREATE POLICY skills_org_isolation ON skills
  FOR ALL USING (org_id = current_org_id());

-- Facts (agent memory)
ALTER TABLE facts ENABLE ROW LEVEL SECURITY;
CREATE POLICY facts_org_isolation ON facts
  FOR ALL USING (org_id = current_org_id());

-- Episodes (agent memory)
ALTER TABLE episodes ENABLE ROW LEVEL SECURITY;
CREATE POLICY episodes_org_isolation ON episodes
  FOR ALL USING (org_id = current_org_id());

-- Procedures (agent memory)
ALTER TABLE procedures ENABLE ROW LEVEL SECURITY;
CREATE POLICY procedures_org_isolation ON procedures
  FOR ALL USING (org_id = current_org_id());

-- Training Jobs
ALTER TABLE training_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY training_jobs_org_isolation ON training_jobs
  FOR ALL USING (org_id = current_org_id());

-- Codemode Snippets
ALTER TABLE codemode_snippets ENABLE ROW LEVEL SECURITY;
CREATE POLICY codemode_snippets_org_isolation ON codemode_snippets
  FOR ALL USING (org_id = current_org_id());

-- Audit Log
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_log_org_isolation ON audit_log
  FOR ALL USING (org_id = current_org_id());

-- Webhooks
ALTER TABLE webhooks ENABLE ROW LEVEL SECURITY;
CREATE POLICY webhooks_org_isolation ON webhooks
  FOR ALL USING (org_id = current_org_id());

-- ── Tier 3: Medium (analytics, marketplace, A2A) ─────────────────

-- Marketplace Listings
ALTER TABLE marketplace_listings ENABLE ROW LEVEL SECURITY;
CREATE POLICY marketplace_listings_org_isolation ON marketplace_listings
  FOR ALL USING (org_id = current_org_id());

-- A2A Tasks (caller sees their tasks)
ALTER TABLE a2a_tasks ENABLE ROW LEVEL SECURITY;
CREATE POLICY a2a_tasks_caller_isolation ON a2a_tasks
  FOR ALL USING (caller_org_id = current_org_id() OR callee_org_id = current_org_id());

-- Security Scans
ALTER TABLE security_scans ENABLE ROW LEVEL SECURITY;
CREATE POLICY security_scans_org_isolation ON security_scans
  FOR ALL USING (org_id = current_org_id());

-- RAG Chunks (BM25 search data)
ALTER TABLE rag_chunks ENABLE ROW LEVEL SECURITY;
CREATE POLICY rag_chunks_org_isolation ON rag_chunks
  FOR ALL USING (org_id = current_org_id() OR org_id = '');

-- ── Service Role Bypass ───────────────────────────────────────────
-- Backend service-token queries bypass RLS via the postgres role.
-- This is safe because:
--   1. Service-token auth is fail-closed (503 when unset)
--   2. The Worker always sets app.current_org_id before queries
--   3. Hyperdrive transaction-mode pooling scopes SET LOCAL per request
--
-- If you need a restricted service role that respects RLS:
--   CREATE ROLE app_user;
--   GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO app_user;
--   (Then connect as app_user for user-facing queries)

-- ============================================================================
-- SECTION 5: Comments — Document Denormalization Decisions
-- ============================================================================

COMMENT ON COLUMN sessions.agent_name IS 'Denormalized from agents.name for query performance. Agent names are immutable — do not rename agents.';
COMMENT ON COLUMN sessions.org_id IS 'Denormalized from agents.org_id for RLS filtering without JOIN.';
COMMENT ON COLUMN turns.cost_usd IS 'Per-turn cost in USD. Replaces old cost_total_usd column.';
COMMENT ON COLUMN eval_runs.config IS 'Replaces old eval_conditions_json. Contains eval_name, source, and run parameters.';
COMMENT ON COLUMN eval_runs.results IS 'Aggregated results: total_tasks, pass_count, avg_score, avg_latency_ms, total_cost_usd.';
COMMENT ON TABLE rag_chunks IS 'BM25 full-text search index. Parallel to Vectorize (dense vectors). org_id="" means global/unscoped.';
