-- ============================================================================
-- 001_init.sql — OneShots/AgentOS consolidated schema
-- Generated: 2026-04-06
-- Replaces: 36 migration files / 148 tables
-- Target: Supabase Postgres (fresh database, zero users)
-- ============================================================================

-- ============================================================================
-- SECTION 1: Extensions & Functions
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- SECTION 2: Core Entities
-- ============================================================================

CREATE TABLE IF NOT EXISTS orgs (
  org_id        TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name          TEXT NOT NULL DEFAULT '',
  slug          TEXT NOT NULL UNIQUE,
  owner_user_id TEXT,
  plan          TEXT NOT NULL DEFAULT 'free',
  stripe_customer_id   TEXT,
  stripe_subscription_id TEXT,
  settings_json JSONB NOT NULL DEFAULT '{}',
  subdomain     TEXT UNIQUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  user_id        TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  email          TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL DEFAULT '',
  password_hash  TEXT,
  provider       TEXT NOT NULL DEFAULT 'email',
  avatar_url     TEXT,
  is_active      BOOLEAN NOT NULL DEFAULT true,
  email_verified BOOLEAN NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS projects (
  project_id  TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id      TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
  name        TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agents (
  agent_id    TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id      TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
  project_id  TEXT,
  name        TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  version     TEXT NOT NULL DEFAULT '1.0.0',
  config_json JSONB NOT NULL DEFAULT '{}',
  is_active   BOOLEAN NOT NULL DEFAULT true,
  agent_role  TEXT NOT NULL DEFAULT 'custom'
              CHECK (agent_role IN ('personal_assistant', 'meta_agent', 'skill', 'custom')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Only one active agent per name per org
CREATE UNIQUE INDEX IF NOT EXISTS uq_agents_name_org_active
  ON agents (name, org_id) WHERE is_active = true;

CREATE TABLE IF NOT EXISTS agent_versions (
  id          BIGSERIAL PRIMARY KEY,
  org_id      TEXT,
  agent_name  TEXT NOT NULL,
  version     TEXT NOT NULL,
  config_json JSONB NOT NULL DEFAULT '{}',
  created_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (agent_name, version)
);

-- ============================================================================
-- SECTION 3: Auth & API Keys
-- ============================================================================

CREATE TABLE IF NOT EXISTS api_keys (
  key_id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id         TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
  user_id        TEXT,
  name           TEXT NOT NULL DEFAULT '',
  key_hash       TEXT NOT NULL UNIQUE,
  key_prefix     TEXT,
  project_id     TEXT,
  env            TEXT,
  scopes         JSONB NOT NULL DEFAULT '[]',
  allowed_agents JSONB NOT NULL DEFAULT '[]',
  rate_limit_rpm INT,
  rate_limit_rpd INT,
  ip_allowlist   JSONB NOT NULL DEFAULT '[]',
  is_active      BOOLEAN NOT NULL DEFAULT true,
  revoked        BOOLEAN NOT NULL DEFAULT false,
  expires_at     TIMESTAMPTZ,
  last_used_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS api_key_agent_scopes (
  id         BIGSERIAL PRIMARY KEY,
  key_id     TEXT NOT NULL REFERENCES api_keys(key_id) ON DELETE CASCADE,
  agent_name TEXT NOT NULL,
  scopes     JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS org_members (
  org_id       TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  role         TEXT NOT NULL DEFAULT 'member'
               CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  mfa_verified BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (org_id, user_id)
);

CREATE TABLE IF NOT EXISTS org_settings (
  org_id              TEXT PRIMARY KEY REFERENCES orgs(org_id) ON DELETE CASCADE,
  plan_type           TEXT NOT NULL DEFAULT 'free',
  settings_json       JSONB NOT NULL DEFAULT '{}',
  limits_json         JSONB NOT NULL DEFAULT '{}',
  features_json       JSONB NOT NULL DEFAULT '{}',
  monthly_budget_usd  NUMERIC(12,8) NOT NULL DEFAULT 0,
  daily_budget_usd    NUMERIC(12,8) NOT NULL DEFAULT 0,
  budget_alert_pct    NUMERIC(5,2) NOT NULL DEFAULT 80,
  onboarding_complete BOOLEAN NOT NULL DEFAULT false,
  immutable_audit     BOOLEAN NOT NULL DEFAULT false,
  auto_redact_pii     BOOLEAN NOT NULL DEFAULT false,
  mfa_required        BOOLEAN NOT NULL DEFAULT false,
  mfa_enforcement     TEXT NOT NULL DEFAULT 'optional'
                      CHECK (mfa_enforcement IN ('optional', 'required_admins', 'required_all')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS email_verification_tokens (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_sessions (
  id               BIGSERIAL PRIMARY KEY,
  session_id       TEXT,
  user_id          TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  session_token    TEXT NOT NULL,
  ip_address       TEXT,
  user_agent       TEXT,
  is_active        BOOLEAN NOT NULL DEFAULT true,
  revoked          BOOLEAN NOT NULL DEFAULT false,
  revoked_at       TIMESTAMPTZ,
  last_activity_at TIMESTAMPTZ,
  expires_at       TIMESTAMPTZ NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- SECTION 4: Sessions & Turns (high-volume, performance-critical)
-- ============================================================================

CREATE TABLE IF NOT EXISTS sessions (
  session_id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id               TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
  agent_id             TEXT,
  agent_name           TEXT NOT NULL DEFAULT '',
  model                TEXT NOT NULL DEFAULT '',
  status               TEXT NOT NULL DEFAULT 'pending',
  llm_input_cost       NUMERIC(12,8) NOT NULL DEFAULT 0,
  llm_output_cost      NUMERIC(12,8) NOT NULL DEFAULT 0,
  tool_cost            NUMERIC(12,8) NOT NULL DEFAULT 0,
  total_cost           NUMERIC(12,8) NOT NULL DEFAULT 0,
  cost_total_usd       NUMERIC(12,8) NOT NULL DEFAULT 0,
  wall_clock_seconds   NUMERIC(12,4) NOT NULL DEFAULT 0,
  step_count           INT NOT NULL DEFAULT 0,
  action_count         INT NOT NULL DEFAULT 0,
  composition_json     JSONB NOT NULL DEFAULT '{}',
  trace_id             TEXT,
  parent_session_id    TEXT,
  depth                INT NOT NULL DEFAULT 0,
  project_id           TEXT,
  conversation_id      TEXT,
  channel              TEXT NOT NULL DEFAULT 'api',
  feature_flags_json   JSONB NOT NULL DEFAULT '{}',
  detailed_cost_json   JSONB NOT NULL DEFAULT '{}',
  total_cache_read_tokens  INT NOT NULL DEFAULT 0,
  total_cache_write_tokens INT NOT NULL DEFAULT 0,
  repair_count         INT NOT NULL DEFAULT 0,
  compaction_count     INT NOT NULL DEFAULT 0,
  last_activity_at     TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS turns (
  id               BIGSERIAL PRIMARY KEY,
  session_id       TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  turn_number      INT NOT NULL,
  model_used       TEXT NOT NULL DEFAULT '',
  role             TEXT NOT NULL DEFAULT 'user',
  input_text       TEXT NOT NULL DEFAULT '',
  output_text      TEXT NOT NULL DEFAULT '',
  input_tokens     INT NOT NULL DEFAULT 0,
  output_tokens    INT NOT NULL DEFAULT 0,
  latency_ms       INT NOT NULL DEFAULT 0,
  tool_calls_json  JSONB NOT NULL DEFAULT '[]',
  tool_results_json JSONB NOT NULL DEFAULT '[]',
  errors_json      JSONB NOT NULL DEFAULT '[]',
  error            TEXT,
  plan_json        JSONB NOT NULL DEFAULT '{}',
  plan_artifact    JSONB NOT NULL DEFAULT '{}',
  reflection_json  JSONB NOT NULL DEFAULT '{}',
  reflection       TEXT,
  execution_mode   TEXT,
  routing_model    TEXT,
  routing_reason   TEXT,
  llm_latency_ms   INT,
  stop_reason      TEXT,
  refusal          BOOLEAN NOT NULL DEFAULT false,
  cache_read_tokens  INT NOT NULL DEFAULT 0,
  cache_write_tokens INT NOT NULL DEFAULT 0,
  gateway_log_id   TEXT,
  cost_usd         NUMERIC(12,8) NOT NULL DEFAULT 0,
  cost_total_usd   NUMERIC(12,8) NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (session_id, turn_number)
);

CREATE TABLE IF NOT EXISTS session_progress (
  id           BIGSERIAL PRIMARY KEY,
  session_id   TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  progress_pct INT NOT NULL DEFAULT 0,
  stage        TEXT NOT NULL DEFAULT '',
  message      TEXT NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS session_feedback (
  id            BIGSERIAL PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  org_id        TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
  agent_name    TEXT NOT NULL DEFAULT '',
  rating        INT NOT NULL CHECK (rating >= 1 AND rating <= 5),
  feedback_text TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- SECTION 5: Conversations (portal chat persistence — CLEAN BREAK)
-- ============================================================================

CREATE TABLE IF NOT EXISTS conversations (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id          TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
  user_id         TEXT,
  agent_name      TEXT NOT NULL DEFAULT '',
  channel         TEXT NOT NULL DEFAULT 'portal',
  title           TEXT NOT NULL DEFAULT 'New conversation',
  status          TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'archived', 'deleted')),
  message_count   INT NOT NULL DEFAULT 0,
  total_cost_usd  NUMERIC(12,8) NOT NULL DEFAULT 0,
  metadata        JSONB NOT NULL DEFAULT '{}',
  last_message_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS conversation_messages (
  id              BIGSERIAL PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
  content         TEXT NOT NULL DEFAULT '',
  model           TEXT,
  token_count     INT NOT NULL DEFAULT 0,
  cost_usd        NUMERIC(12,8) NOT NULL DEFAULT 0,
  session_id      TEXT,
  tool_calls      JSONB NOT NULL DEFAULT '[]',
  tool_results    JSONB NOT NULL DEFAULT '[]',
  metadata        JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Runtime DO persistence — no FK (written by Durable Object)
CREATE TABLE IF NOT EXISTS do_conversation_messages (
  id          BIGSERIAL PRIMARY KEY,
  agent_name  TEXT NOT NULL DEFAULT '',
  instance_id TEXT NOT NULL DEFAULT '',
  role        TEXT NOT NULL DEFAULT '',
  content     TEXT NOT NULL DEFAULT '',
  channel     TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS conversation_analytics (
  id              BIGSERIAL PRIMARY KEY,
  org_id          TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
  agent_name      TEXT NOT NULL DEFAULT '',
  conversation_id TEXT,
  metrics_json    JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS conversation_scores (
  id              BIGSERIAL PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  org_id          TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
  score           NUMERIC(5,4) NOT NULL DEFAULT 0,
  scorer          TEXT NOT NULL DEFAULT '',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- SECTION 6: Billing & Credits
-- ============================================================================

CREATE TABLE IF NOT EXISTS org_credit_balance (
  org_id                TEXT PRIMARY KEY REFERENCES orgs(org_id) ON DELETE CASCADE,
  balance_usd           NUMERIC(12,8) NOT NULL DEFAULT 0,
  lifetime_purchased_usd NUMERIC(12,8) NOT NULL DEFAULT 0,
  lifetime_consumed_usd NUMERIC(12,8) NOT NULL DEFAULT 0,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS credit_transactions (
  id                      BIGSERIAL PRIMARY KEY,
  org_id                  TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
  type                    TEXT NOT NULL
                          CHECK (type IN ('purchase', 'burn', 'refund', 'adjustment', 'bonus', 'transfer_in', 'transfer_out')),
  amount_usd              NUMERIC(12,8) NOT NULL DEFAULT 0,
  balance_after_usd       NUMERIC(12,8) NOT NULL DEFAULT 0,
  amount_cents            INT NOT NULL DEFAULT 0,
  balance_after_cents     INT NOT NULL DEFAULT 0,
  description             TEXT NOT NULL DEFAULT '',
  agent_name              TEXT,
  session_id              TEXT,
  reference_id            TEXT,
  reference_type          TEXT,
  stripe_payment_intent_id TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS billing_records (
  id               BIGSERIAL PRIMARY KEY,
  org_id           TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
  session_id       TEXT,
  agent_name       TEXT,
  cost_type        TEXT NOT NULL DEFAULT '',
  model            TEXT NOT NULL DEFAULT '',
  provider         TEXT NOT NULL DEFAULT '',
  input_tokens     INT NOT NULL DEFAULT 0,
  output_tokens    INT NOT NULL DEFAULT 0,
  inference_cost_usd NUMERIC(12,8) NOT NULL DEFAULT 0,
  tool_cost_usd    NUMERIC(12,8) NOT NULL DEFAULT 0,
  total_cost_usd   NUMERIC(12,8) NOT NULL DEFAULT 0,
  pricing_source   TEXT,
  pricing_key      TEXT,
  pricing_version  TEXT,
  billing_user_id  TEXT,
  api_key_id       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pricing_catalog (
  id              BIGSERIAL PRIMARY KEY,
  provider        TEXT NOT NULL DEFAULT '',
  model           TEXT NOT NULL DEFAULT '',
  resource_type   TEXT NOT NULL DEFAULT '',
  operation       TEXT NOT NULL DEFAULT '',
  unit            TEXT NOT NULL DEFAULT '',
  unit_price_usd  NUMERIC(12,8) NOT NULL DEFAULT 0,
  effective_from  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  effective_to    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS credit_packages (
  id              BIGSERIAL PRIMARY KEY,
  name            TEXT NOT NULL DEFAULT '',
  credits_usd     NUMERIC(12,8) NOT NULL DEFAULT 0,
  price_usd       NUMERIC(12,8) NOT NULL DEFAULT 0,
  stripe_price_id TEXT,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS stripe_events_processed (
  event_id     TEXT PRIMARY KEY,
  event_type   TEXT NOT NULL DEFAULT '',
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cost_ledger (
  id             BIGSERIAL PRIMARY KEY,
  org_id         TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
  period_start   TIMESTAMPTZ NOT NULL,
  period_end     TIMESTAMPTZ NOT NULL,
  total_usd      NUMERIC(12,8) NOT NULL DEFAULT 0,
  breakdown_json JSONB NOT NULL DEFAULT '{}',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS billing_events (
  id            BIGSERIAL PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
  event_type    TEXT NOT NULL DEFAULT '',
  amount_usd    NUMERIC(12,8) NOT NULL DEFAULT 0,
  metadata_json JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- SECTION 7: Training & Eval
-- ============================================================================

CREATE TABLE IF NOT EXISTS eval_runs (
  eval_run_id   TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id        TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
  agent_name    TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'pending',
  config_json   JSONB NOT NULL DEFAULT '{}',
  results_json  JSONB NOT NULL DEFAULT '{}',
  pass_rate     NUMERIC(5,4) NOT NULL DEFAULT 0,
  total_trials  INT NOT NULL DEFAULT 0,
  passed_trials INT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS eval_trials (
  id              BIGSERIAL PRIMARY KEY,
  eval_run_id     TEXT NOT NULL REFERENCES eval_runs(eval_run_id) ON DELETE CASCADE,
  test_input      TEXT NOT NULL DEFAULT '',
  expected_output TEXT NOT NULL DEFAULT '',
  actual_output   TEXT NOT NULL DEFAULT '',
  passed          BOOLEAN NOT NULL DEFAULT false,
  score           NUMERIC(8,4) NOT NULL DEFAULT 0,
  latency_ms      INT NOT NULL DEFAULT 0,
  error_message   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS training_jobs (
  job_id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id            TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
  agent_name        TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL DEFAULT 'pending',
  algorithm         TEXT NOT NULL DEFAULT '',
  config_json       JSONB NOT NULL DEFAULT '{}',
  eval_tasks_json   JSONB NOT NULL DEFAULT '[]',
  max_iterations    INT NOT NULL DEFAULT 10,
  current_iteration INT NOT NULL DEFAULT 0,
  best_score        NUMERIC(8,4) NOT NULL DEFAULT 0,
  best_config_json  JSONB NOT NULL DEFAULT '{}',
  error_message     TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS training_iterations (
  iteration_id     TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  job_id           TEXT NOT NULL REFERENCES training_jobs(job_id) ON DELETE CASCADE,
  iteration_number INT NOT NULL,
  eval_run_id      TEXT,
  prompt_used      TEXT NOT NULL DEFAULT '',
  config_json      JSONB NOT NULL DEFAULT '{}',
  pass_rate        NUMERIC(5,4) NOT NULL DEFAULT 0,
  reward_score     NUMERIC(8,4) NOT NULL DEFAULT 0,
  improvements_json JSONB NOT NULL DEFAULT '[]',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (job_id, iteration_number)
);

CREATE TABLE IF NOT EXISTS training_resources (
  resource_id   TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id        TEXT NOT NULL,
  agent_name    TEXT NOT NULL DEFAULT '',
  job_id        TEXT REFERENCES training_jobs(job_id) ON DELETE SET NULL,
  resource_type TEXT NOT NULL DEFAULT '',
  resource_key  TEXT NOT NULL DEFAULT '',
  version       INT NOT NULL DEFAULT 1,
  content_text  TEXT NOT NULL DEFAULT '',
  content_json  JSONB NOT NULL DEFAULT '{}',
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, agent_name, resource_type, resource_key, version)
);

CREATE TABLE IF NOT EXISTS training_rewards (
  id               BIGSERIAL PRIMARY KEY,
  job_id           TEXT NOT NULL REFERENCES training_jobs(job_id) ON DELETE CASCADE,
  iteration_number INT NOT NULL,
  metric_name      TEXT NOT NULL DEFAULT '',
  metric_value     NUMERIC(12,8) NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- SECTION 8: Marketplace & A2A
-- ============================================================================

CREATE TABLE IF NOT EXISTS marketplace_listings (
  id                    TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id                TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
  agent_name            TEXT NOT NULL DEFAULT '',
  display_name          TEXT NOT NULL DEFAULT '',
  title                 TEXT NOT NULL DEFAULT '',
  short_description     TEXT NOT NULL DEFAULT '',
  description           TEXT NOT NULL DEFAULT '',
  category              TEXT NOT NULL DEFAULT 'other',
  pricing_model         TEXT NOT NULL DEFAULT 'cost_plus'
                        CHECK (pricing_model IN ('fixed', 'cost_plus', 'per_token')),
  price_per_task_usd    NUMERIC(12,8) NOT NULL DEFAULT 0,
  cost_plus_margin_pct  NUMERIC(5,2) NOT NULL DEFAULT 0,
  agent_type            TEXT NOT NULL DEFAULT 'agent'
                        CHECK (agent_type IN ('agent', 'skill')),
  tags                  JSONB NOT NULL DEFAULT '[]',
  a2a_endpoint          TEXT,
  a2a_endpoint_url      TEXT,
  agent_card_url        TEXT,
  sla_max_latency_ms    INT,
  sla_response_time_ms  INT,
  avg_response_time_ms  INT,
  quality_score         NUMERIC(5,4) NOT NULL DEFAULT 0,
  avg_rating            NUMERIC(5,4) NOT NULL DEFAULT 0,
  total_ratings         INT NOT NULL DEFAULT 0,
  total_tasks           INT NOT NULL DEFAULT 0,
  total_tasks_completed INT NOT NULL DEFAULT 0,
  total_tasks_failed    INT NOT NULL DEFAULT 0,
  total_revenue_usd     NUMERIC(12,8) NOT NULL DEFAULT 0,
  is_active             BOOLEAN NOT NULL DEFAULT true,
  is_published          BOOLEAN NOT NULL DEFAULT false,
  is_featured           BOOLEAN NOT NULL DEFAULT false,
  is_verified           BOOLEAN NOT NULL DEFAULT false,
  featured_until        TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (agent_name, org_id)
);

CREATE TABLE IF NOT EXISTS marketplace_ratings (
  id                BIGSERIAL PRIMARY KEY,
  listing_id        TEXT NOT NULL REFERENCES marketplace_listings(id) ON DELETE CASCADE,
  rater_org_id      TEXT NOT NULL,
  rater_agent_name  TEXT NOT NULL DEFAULT '',
  task_id           TEXT NOT NULL DEFAULT '',
  rating            INT NOT NULL CHECK (rating >= 1 AND rating <= 5),
  review_text       TEXT NOT NULL DEFAULT '',
  response_time_ms  INT NOT NULL DEFAULT 0,
  raw_rating        NUMERIC(5,4),
  credibility_weight NUMERIC(5,4),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS marketplace_featured (
  id          BIGSERIAL PRIMARY KEY,
  listing_id  TEXT NOT NULL REFERENCES marketplace_listings(id) ON DELETE CASCADE,
  org_id      TEXT,
  cost_usd    NUMERIC(12,8) NOT NULL DEFAULT 0,
  featured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  starts_at   TIMESTAMPTZ,
  ends_at     TIMESTAMPTZ,
  expires_at  TIMESTAMPTZ,
  status      TEXT NOT NULL DEFAULT 'active',
  category    TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS marketplace_queries (
  id                 BIGSERIAL PRIMARY KEY,
  querier_org_id     TEXT,
  querier_agent_name TEXT NOT NULL DEFAULT '',
  query_text         TEXT NOT NULL DEFAULT '',
  category_filter    TEXT NOT NULL DEFAULT '',
  org_id             TEXT,
  results_count      INT NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS a2a_agents (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id        TEXT NOT NULL,
  agent_name    TEXT NOT NULL DEFAULT '',
  a2a_card_json JSONB NOT NULL DEFAULT '{}',
  status        TEXT NOT NULL DEFAULT 'active',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, agent_name)
);

CREATE TABLE IF NOT EXISTS a2a_tasks (
  task_id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  caller_org_id      TEXT NOT NULL,
  caller_agent_name  TEXT NOT NULL DEFAULT '',
  callee_org_id      TEXT NOT NULL,
  callee_agent_name  TEXT NOT NULL DEFAULT '',
  status             TEXT NOT NULL DEFAULT 'pending',
  input_text         TEXT NOT NULL DEFAULT '',
  output_text        TEXT NOT NULL DEFAULT '',
  amount_usd         NUMERIC(12,8) NOT NULL DEFAULT 0,
  cost_usd           NUMERIC(12,8) NOT NULL DEFAULT 0,
  llm_cost_usd       NUMERIC(12,8) NOT NULL DEFAULT 0,
  pricing_model      TEXT,
  started_at         TIMESTAMPTZ,
  completed_at       TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS a2a_artifacts (
  id                  TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  task_id             TEXT NOT NULL REFERENCES a2a_tasks(task_id) ON DELETE CASCADE,
  sender_org_id       TEXT NOT NULL,
  sender_agent_name   TEXT NOT NULL DEFAULT '',
  receiver_org_id     TEXT NOT NULL,
  receiver_agent_name TEXT NOT NULL DEFAULT '',
  artifact_type       TEXT NOT NULL DEFAULT '',
  storage_key         TEXT,
  url                 TEXT,
  size_bytes          BIGINT NOT NULL DEFAULT 0,
  mime_type           TEXT,
  status              TEXT NOT NULL DEFAULT 'available'
                      CHECK (status IN ('uploading', 'available', 'expired', 'deleted')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS delegation_events (
  id                BIGSERIAL PRIMARY KEY,
  org_id            TEXT NOT NULL,
  parent_session_id TEXT,
  child_session_id  TEXT,
  caller_agent      TEXT NOT NULL DEFAULT '',
  callee_agent      TEXT NOT NULL DEFAULT '',
  task_summary      TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL DEFAULT '',
  cost_usd          NUMERIC(12,8) NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- SECTION 9: Observability & Telemetry
-- ============================================================================

CREATE TABLE IF NOT EXISTS otel_events (
  id          BIGSERIAL PRIMARY KEY,
  org_id      TEXT NOT NULL,
  agent_name  TEXT NOT NULL DEFAULT '',
  session_id  TEXT,
  trace_id    TEXT,
  span_id     TEXT,
  event_type  TEXT NOT NULL DEFAULT '',
  event_data  JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS runtime_events (
  id          BIGSERIAL PRIMARY KEY,
  org_id      TEXT NOT NULL,
  agent_name  TEXT NOT NULL DEFAULT '',
  event_type  TEXT NOT NULL DEFAULT '',
  event_data  JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS span_feedback (
  id         BIGSERIAL PRIMARY KEY,
  span_id    TEXT NOT NULL,
  org_id     TEXT NOT NULL,
  rating     INT,
  comment    TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS trace_annotations (
  id         BIGSERIAL PRIMARY KEY,
  trace_id   TEXT NOT NULL,
  org_id     TEXT NOT NULL,
  key        TEXT NOT NULL DEFAULT '',
  value      TEXT NOT NULL DEFAULT '',
  annotator  TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS trace_lineage (
  id              BIGSERIAL PRIMARY KEY,
  parent_trace_id TEXT NOT NULL,
  child_trace_id  TEXT NOT NULL,
  relationship    TEXT NOT NULL DEFAULT '',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS middleware_events (
  id              BIGSERIAL PRIMARY KEY,
  org_id          TEXT NOT NULL,
  agent_name      TEXT NOT NULL DEFAULT '',
  middleware_name TEXT NOT NULL DEFAULT '',
  event_type      TEXT NOT NULL DEFAULT '',
  payload_json    JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tool_executions (
  id          BIGSERIAL PRIMARY KEY,
  org_id      TEXT NOT NULL,
  session_id  TEXT,
  tool_name   TEXT NOT NULL DEFAULT '',
  input_json  JSONB NOT NULL DEFAULT '{}',
  output_json JSONB NOT NULL DEFAULT '{}',
  latency_ms  INT NOT NULL DEFAULT 0,
  error       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- SECTION 10: Scheduling, Jobs & Workflows
-- ============================================================================

CREATE TABLE IF NOT EXISTS schedules (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  schedule_id     TEXT,
  org_id          TEXT NOT NULL,
  agent_name      TEXT NOT NULL DEFAULT '',
  cron            TEXT NOT NULL DEFAULT '',
  cron_expression TEXT NOT NULL DEFAULT '',
  task            TEXT NOT NULL DEFAULT '',
  task_input      JSONB NOT NULL DEFAULT '{}',
  is_active       BOOLEAN NOT NULL DEFAULT true,
  is_enabled      BOOLEAN NOT NULL DEFAULT true,
  enabled         BOOLEAN NOT NULL DEFAULT true,
  run_count       INT NOT NULL DEFAULT 0,
  last_status     TEXT,
  last_output     TEXT,
  last_error      TEXT,
  last_run_at     TIMESTAMPTZ,
  next_run_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS job_queue (
  id              BIGSERIAL PRIMARY KEY,
  job_id          TEXT,
  org_id          TEXT NOT NULL,
  agent_name      TEXT NOT NULL DEFAULT '',
  job_type        TEXT NOT NULL DEFAULT '',
  task            TEXT NOT NULL DEFAULT '',
  payload_json    JSONB NOT NULL DEFAULT '{}',
  result_json     JSONB,
  status          TEXT NOT NULL DEFAULT 'pending',
  attempts        INT NOT NULL DEFAULT 0,
  max_attempts    INT NOT NULL DEFAULT 3,
  max_retries     INT NOT NULL DEFAULT 3,
  priority        INT NOT NULL DEFAULT 0,
  idempotency_key TEXT,
  error_message   TEXT,
  error           TEXT,
  scheduled_at    TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS batch_jobs (
  batch_id        TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id          TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
  agent_name      TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
  total_tasks     INT NOT NULL DEFAULT 0,
  completed_tasks INT NOT NULL DEFAULT 0,
  failed_tasks    INT NOT NULL DEFAULT 0,
  callback_url    TEXT,
  callback_secret TEXT,
  metadata_json   JSONB NOT NULL DEFAULT '{}',
  completed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS batch_tasks (
  id              BIGSERIAL PRIMARY KEY,
  task_id         TEXT,
  batch_id        TEXT NOT NULL REFERENCES batch_jobs(batch_id) ON DELETE CASCADE,
  org_id          TEXT,
  task_index      INT NOT NULL DEFAULT 0,
  input           TEXT NOT NULL DEFAULT '',
  input_text      TEXT NOT NULL DEFAULT '',
  output          TEXT,
  output_text     TEXT NOT NULL DEFAULT '',
  system_prompt   TEXT,
  response_format TEXT,
  response_schema JSONB,
  file_ids_json   JSONB NOT NULL DEFAULT '[]',
  session_id      TEXT,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
  error_message   TEXT,
  error           TEXT,
  cost_usd        NUMERIC(12,8) NOT NULL DEFAULT 0,
  latency_ms      INT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS workflows (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id          TEXT NOT NULL,
  name            TEXT NOT NULL DEFAULT '',
  definition_json JSONB NOT NULL DEFAULT '{}',
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS workflow_runs (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  workflow_id   TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  org_id        TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  input_json    JSONB NOT NULL DEFAULT '{}',
  output_json   JSONB NOT NULL DEFAULT '{}',
  error_message TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at  TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS workflow_approvals (
  id               TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  workflow_run_id  TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  org_id           TEXT NOT NULL,
  approver_user_id TEXT,
  status           TEXT NOT NULL DEFAULT 'pending',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at      TIMESTAMPTZ
);

-- ============================================================================
-- SECTION 11: Security, Compliance & Audit
-- ============================================================================

CREATE TABLE IF NOT EXISTS audit_log (
  id            BIGSERIAL PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
  user_id       TEXT,
  action        TEXT NOT NULL DEFAULT '',
  resource_type TEXT NOT NULL DEFAULT '',
  resource_id   TEXT,
  details       JSONB NOT NULL DEFAULT '{}',
  ip_address    TEXT,
  actor_id      TEXT,
  resource_name TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS auth_audit_log (
  id            BIGSERIAL PRIMARY KEY,
  org_id        TEXT,
  user_id       TEXT,
  event_type    TEXT NOT NULL DEFAULT '',
  ip_address    TEXT,
  user_agent    TEXT,
  metadata_json JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS security_events (
  id          BIGSERIAL PRIMARY KEY,
  org_id      TEXT NOT NULL,
  event_type  TEXT NOT NULL DEFAULT '',
  actor_type  TEXT NOT NULL DEFAULT 'system'
              CHECK (actor_type IN ('user', 'system', 'api_key', 'end_user')),
  actor_id    TEXT,
  severity    TEXT NOT NULL DEFAULT 'info'
              CHECK (severity IN ('critical', 'high', 'medium', 'low', 'info')),
  details     JSONB NOT NULL DEFAULT '{}',
  ip_address  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS security_scans (
  id            BIGSERIAL PRIMARY KEY,
  scan_id       TEXT,
  org_id        TEXT NOT NULL,
  agent_name    TEXT NOT NULL DEFAULT '',
  scan_type     TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'pending',
  risk_score    NUMERIC(5,4) NOT NULL DEFAULT 0,
  risk_level    TEXT NOT NULL DEFAULT 'low',
  total_probes  INT NOT NULL DEFAULT 0,
  passed        INT NOT NULL DEFAULT 0,
  failed        INT NOT NULL DEFAULT 0,
  findings_json JSONB NOT NULL DEFAULT '[]',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS security_findings (
  id             BIGSERIAL PRIMARY KEY,
  org_id         TEXT NOT NULL,
  scan_id        BIGINT,
  severity       TEXT NOT NULL DEFAULT 'info',
  finding_type   TEXT NOT NULL DEFAULT '',
  description    TEXT NOT NULL DEFAULT '',
  recommendation TEXT NOT NULL DEFAULT '',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS compliance_checks (
  id           BIGSERIAL PRIMARY KEY,
  org_id       TEXT NOT NULL,
  check_type   TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'pending',
  details_json JSONB NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS secrets (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id          TEXT NOT NULL,
  project_id      TEXT,
  env             TEXT NOT NULL DEFAULT 'production',
  name            TEXT NOT NULL DEFAULT '',
  encrypted_value TEXT NOT NULL DEFAULT '',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, project_id, env, name)
);

CREATE TABLE IF NOT EXISTS secrets_key_rotations (
  id           BIGSERIAL PRIMARY KEY,
  secret_id    TEXT NOT NULL REFERENCES secrets(id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'in_progress', 'completed', 'failed')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS account_deletion_requests (
  id           BIGSERIAL PRIMARY KEY,
  org_id       TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS data_export_requests (
  id           BIGSERIAL PRIMARY KEY,
  org_id       TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'expired')),
  export_url   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  expires_at   TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS api_access_log (
  id          BIGSERIAL PRIMARY KEY,
  org_id      TEXT NOT NULL,
  key_id      TEXT,
  method      TEXT NOT NULL DEFAULT '',
  path        TEXT NOT NULL DEFAULT '',
  status_code INT NOT NULL DEFAULT 0,
  latency_ms  INT NOT NULL DEFAULT 0,
  ip_address  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS idempotency_cache (
  key           TEXT PRIMARY KEY,
  response_json JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL
);

-- ============================================================================
-- SECTION 12: Agent Intelligence & Memory
-- ============================================================================

CREATE TABLE IF NOT EXISTS user_profiles (
  id                 BIGSERIAL PRIMARY KEY,
  org_id             TEXT NOT NULL,
  agent_name         TEXT NOT NULL DEFAULT '',
  user_identifier    TEXT NOT NULL DEFAULT '',
  profile_json       JSONB NOT NULL DEFAULT '{}',
  interaction_count  INT NOT NULL DEFAULT 0,
  last_interaction_at TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, agent_name, user_identifier)
);

CREATE TABLE IF NOT EXISTS memory_facts (
  id              BIGSERIAL PRIMARY KEY,
  org_id          TEXT NOT NULL,
  agent_name      TEXT NOT NULL DEFAULT '',
  user_identifier TEXT,
  fact_type       TEXT NOT NULL DEFAULT '',
  content         TEXT NOT NULL DEFAULT '',
  confidence      NUMERIC(5,4) NOT NULL DEFAULT 1.0,
  source          TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS semantic_facts (
  id           BIGSERIAL PRIMARY KEY,
  org_id       TEXT NOT NULL,
  agent_name   TEXT NOT NULL DEFAULT '',
  key          TEXT NOT NULL DEFAULT '',
  value        TEXT NOT NULL DEFAULT '',
  embedding_id TEXT,
  confidence   NUMERIC(5,4) NOT NULL DEFAULT 1.0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (agent_name, org_id, key)
);

CREATE TABLE IF NOT EXISTS episodic_memories (
  id           BIGSERIAL PRIMARY KEY,
  org_id       TEXT NOT NULL,
  agent_name   TEXT NOT NULL DEFAULT '',
  session_id   TEXT,
  summary      TEXT NOT NULL DEFAULT '',
  outcome      TEXT NOT NULL DEFAULT '',
  lessons_json JSONB NOT NULL DEFAULT '[]',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS episodes (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id        TEXT NOT NULL,
  agent_name    TEXT NOT NULL DEFAULT '',
  session_id    TEXT,
  title         TEXT NOT NULL DEFAULT '',
  summary       TEXT NOT NULL DEFAULT '',
  outcome       TEXT NOT NULL DEFAULT '',
  metadata_json JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS facts (
  id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id     TEXT NOT NULL,
  agent_name TEXT NOT NULL DEFAULT '',
  content    TEXT NOT NULL DEFAULT '',
  fact_type  TEXT NOT NULL DEFAULT '',
  confidence NUMERIC(5,4) NOT NULL DEFAULT 1.0,
  source     TEXT,
  verified   BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS procedures (
  id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id       TEXT NOT NULL,
  agent_name   TEXT NOT NULL DEFAULT '',
  name         TEXT NOT NULL DEFAULT '',
  description  TEXT NOT NULL DEFAULT '',
  steps_json   JSONB NOT NULL DEFAULT '[]',
  success_rate NUMERIC(5,4) NOT NULL DEFAULT 0,
  usage_count  INT NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agent_procedures (
  id             BIGSERIAL PRIMARY KEY,
  org_id         TEXT NOT NULL,
  agent_name     TEXT NOT NULL DEFAULT '',
  task_pattern   TEXT NOT NULL DEFAULT '',
  procedure_json JSONB NOT NULL DEFAULT '{}',
  success_rate   NUMERIC(5,4) NOT NULL DEFAULT 0,
  usage_count    INT NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, agent_name, task_pattern)
);

CREATE TABLE IF NOT EXISTS agent_policies (
  id          BIGSERIAL PRIMARY KEY,
  org_id      TEXT NOT NULL,
  agent_name  TEXT NOT NULL DEFAULT '',
  policy_type TEXT NOT NULL DEFAULT '',
  policy_json JSONB NOT NULL DEFAULT '{}',
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, agent_name, policy_type)
);

CREATE TABLE IF NOT EXISTS team_facts (
  id         BIGSERIAL PRIMARY KEY,
  org_id     TEXT NOT NULL,
  content    TEXT NOT NULL DEFAULT '',
  fact_type  TEXT NOT NULL DEFAULT '',
  confidence NUMERIC(5,4) NOT NULL DEFAULT 1.0,
  source     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, content)
);

CREATE TABLE IF NOT EXISTS team_observations (
  id               BIGSERIAL PRIMARY KEY,
  org_id           TEXT NOT NULL,
  content          TEXT NOT NULL DEFAULT '',
  observation_type TEXT NOT NULL DEFAULT '',
  metadata_json    JSONB NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- SECTION 13: Skills, Connectors & Tools
-- ============================================================================

CREATE TABLE IF NOT EXISTS skills (
  skill_id        TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id          TEXT NOT NULL,
  agent_name      TEXT NOT NULL DEFAULT '',
  name            TEXT NOT NULL DEFAULT '',
  description     TEXT NOT NULL DEFAULT '',
  when_to_use     TEXT NOT NULL DEFAULT '',
  prompt          TEXT NOT NULL DEFAULT '',
  prompt_template TEXT NOT NULL DEFAULT '',
  required_tools  JSONB NOT NULL DEFAULT '[]',
  config_json     JSONB NOT NULL DEFAULT '{}',
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, name)
);

CREATE TABLE IF NOT EXISTS tool_registry (
  id             TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id         TEXT NOT NULL,
  name           TEXT NOT NULL DEFAULT '',
  description    TEXT NOT NULL DEFAULT '',
  schema_json    JSONB NOT NULL DEFAULT '{}',
  handler_type   TEXT NOT NULL DEFAULT '',
  handler_config JSONB NOT NULL DEFAULT '{}',
  is_active      BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, name)
);

CREATE TABLE IF NOT EXISTS connector_tokens (
  id                TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id            TEXT NOT NULL,
  provider          TEXT NOT NULL DEFAULT '',
  app               TEXT NOT NULL DEFAULT '',
  access_token_enc  TEXT NOT NULL DEFAULT '',
  refresh_token_enc TEXT,
  expires_at        TIMESTAMPTZ,
  scopes            JSONB NOT NULL DEFAULT '[]',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, provider, app)
);

CREATE TABLE IF NOT EXISTS connector_tools (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  app         TEXT NOT NULL DEFAULT '',
  name        TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  schema_json JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (app, name)
);

CREATE TABLE IF NOT EXISTS mcp_servers (
  id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id     TEXT NOT NULL,
  name       TEXT NOT NULL DEFAULT '',
  url        TEXT NOT NULL DEFAULT '',
  transport  TEXT NOT NULL DEFAULT 'stdio',
  auth_json  JSONB NOT NULL DEFAULT '{}',
  tools_json JSONB NOT NULL DEFAULT '[]',
  is_active  BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS codemode_snippets (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id      TEXT NOT NULL,
  name        TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  scope       TEXT NOT NULL DEFAULT 'agent'
              CHECK (scope IN ('agent', 'graph_node', 'transform', 'validator', 'webhook',
                               'middleware', 'orchestrator', 'observability', 'test', 'mcp_generator')),
  code        TEXT NOT NULL DEFAULT '',
  language    TEXT NOT NULL DEFAULT 'javascript',
  is_template BOOLEAN NOT NULL DEFAULT false,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, name)
);

-- ============================================================================
-- SECTION 13b: Feature Flags
-- ============================================================================

CREATE TABLE IF NOT EXISTS feature_flags (
  org_id     TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
  flag_name  TEXT NOT NULL,
  enabled    BOOLEAN NOT NULL DEFAULT false,
  value      JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (org_id, flag_name)
);

-- ============================================================================
-- SECTION 14: Channels & Voice
-- ============================================================================

CREATE TABLE IF NOT EXISTS channel_configs (
  org_id     TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
  channel    TEXT NOT NULL,
  agent_name TEXT NOT NULL DEFAULT '',
  config     JSONB NOT NULL DEFAULT '{}',
  is_active  BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (org_id, channel)
);

CREATE TABLE IF NOT EXISTS autopilot_sessions (
  id              BIGSERIAL PRIMARY KEY,
  org_id          TEXT NOT NULL,
  agent_name      TEXT NOT NULL DEFAULT '',
  channel         TEXT NOT NULL DEFAULT '',
  channel_user_id TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'paused', 'stopped')),
  config_json     JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, agent_name, channel, channel_user_id)
);

CREATE TABLE IF NOT EXISTS voice_calls (
  id               TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id           TEXT NOT NULL,
  agent_name       TEXT NOT NULL DEFAULT '',
  call_sid         TEXT,
  direction        TEXT NOT NULL DEFAULT 'inbound',
  from_number      TEXT,
  to_number        TEXT,
  status           TEXT NOT NULL DEFAULT 'initiated',
  duration_seconds INT NOT NULL DEFAULT 0,
  recording_url    TEXT,
  transcript       TEXT,
  cost_usd         NUMERIC(12,8) NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at         TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS voice_numbers (
  id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id       TEXT NOT NULL,
  phone_number TEXT NOT NULL UNIQUE,
  provider     TEXT NOT NULL DEFAULT '',
  capabilities JSONB NOT NULL DEFAULT '[]',
  is_active    BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- SECTION 15: Evolution & Governance
-- ============================================================================

CREATE TABLE IF NOT EXISTS evolution_proposals (
  id                 TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  proposal_id        TEXT,
  org_id             TEXT NOT NULL,
  agent_name         TEXT NOT NULL DEFAULT '',
  title              TEXT NOT NULL DEFAULT '',
  category           TEXT NOT NULL DEFAULT '',
  rationale          TEXT NOT NULL DEFAULT '',
  config_diff_json   JSONB NOT NULL DEFAULT '{}',
  evidence_json      JSONB NOT NULL DEFAULT '{}',
  priority           INT NOT NULL DEFAULT 0,
  status             TEXT NOT NULL DEFAULT 'pending',
  impact_json        JSONB NOT NULL DEFAULT '{}',
  apply_context_json JSONB NOT NULL DEFAULT '{}',
  rolled_back_at     TIMESTAMPTZ,
  rollback_reason    TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS evolution_ledger (
  id                  BIGSERIAL PRIMARY KEY,
  org_id              TEXT NOT NULL,
  agent_name          TEXT NOT NULL DEFAULT '',
  proposal_id         TEXT,
  action              TEXT NOT NULL DEFAULT '',
  previous_config_json JSONB NOT NULL DEFAULT '{}',
  new_config_json     JSONB NOT NULL DEFAULT '{}',
  metrics_before_json JSONB NOT NULL DEFAULT '{}',
  metrics_after_json  JSONB NOT NULL DEFAULT '{}',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS evolution_reports (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id        TEXT NOT NULL,
  agent_name    TEXT NOT NULL DEFAULT '',
  session_count INT NOT NULL DEFAULT 0,
  report_json   JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS evolution_schedules (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id          TEXT NOT NULL,
  agent_name      TEXT NOT NULL DEFAULT '',
  schedule_type   TEXT NOT NULL DEFAULT '',
  cron_expression TEXT NOT NULL DEFAULT '',
  interval_days   INT NOT NULL DEFAULT 7,
  min_sessions    INT NOT NULL DEFAULT 10,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  enabled         BOOLEAN NOT NULL DEFAULT true,
  last_run_at     TIMESTAMPTZ,
  next_run_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS guardrail_policies (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id      TEXT NOT NULL,
  agent_name  TEXT NOT NULL DEFAULT '',
  policy_type TEXT NOT NULL DEFAULT '',
  config_json JSONB NOT NULL DEFAULT '{}',
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS guardrail_events (
  id           BIGSERIAL PRIMARY KEY,
  org_id       TEXT NOT NULL,
  agent_name   TEXT NOT NULL DEFAULT '',
  session_id   TEXT,
  policy_id    TEXT,
  event_type   TEXT NOT NULL DEFAULT '',
  blocked      BOOLEAN NOT NULL DEFAULT false,
  details_json JSONB NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS policy_templates (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name          TEXT NOT NULL DEFAULT '',
  description   TEXT NOT NULL DEFAULT '',
  category      TEXT NOT NULL DEFAULT '',
  template_json JSONB NOT NULL DEFAULT '{}',
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS risk_profiles (
  id               TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id           TEXT NOT NULL,
  agent_name       TEXT NOT NULL DEFAULT '',
  risk_score       NUMERIC(5,4) NOT NULL DEFAULT 0,
  risk_level       TEXT NOT NULL DEFAULT 'low',
  last_scan_id     TEXT,
  factors_json     JSONB NOT NULL DEFAULT '{}',
  findings_summary JSONB NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- SECTION 16: DLP & Classification
-- ============================================================================

CREATE TABLE IF NOT EXISTS dlp_classifications (
  id              BIGSERIAL PRIMARY KEY,
  org_id          TEXT NOT NULL,
  content_hash    TEXT NOT NULL DEFAULT '',
  classification  TEXT NOT NULL DEFAULT '',
  confidence      NUMERIC(5,4) NOT NULL DEFAULT 0,
  policy_id       TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS dlp_agent_policies (
  id          BIGSERIAL PRIMARY KEY,
  org_id      TEXT NOT NULL,
  agent_name  TEXT NOT NULL DEFAULT '',
  policy_json JSONB NOT NULL DEFAULT '{}',
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- SECTION 17: SLO & Monitoring
-- ============================================================================

CREATE TABLE IF NOT EXISTS slo_definitions (
  id             TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  slo_id         TEXT,
  org_id         TEXT NOT NULL,
  agent_name     TEXT NOT NULL DEFAULT '',
  env            TEXT NOT NULL DEFAULT 'production',
  name           TEXT NOT NULL DEFAULT '',
  metric         TEXT NOT NULL DEFAULT '',
  metric_type    TEXT NOT NULL DEFAULT '',
  target_value   NUMERIC(8,4) NOT NULL DEFAULT 0,
  target         NUMERIC(12,4) NOT NULL DEFAULT 0,
  threshold      NUMERIC(12,4) NOT NULL DEFAULT 0,
  operator       TEXT NOT NULL DEFAULT 'gte',
  window_days    INT NOT NULL DEFAULT 30,
  window_hours   INT NOT NULL DEFAULT 720,
  window_seconds INT NOT NULL DEFAULT 2592000,
  alert_on_breach BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS slo_evaluations (
  id           BIGSERIAL PRIMARY KEY,
  eval_id      TEXT,
  org_id       TEXT NOT NULL,
  slo_id       TEXT NOT NULL REFERENCES slo_definitions(id) ON DELETE CASCADE,
  agent_name   TEXT NOT NULL DEFAULT '',
  metric       TEXT NOT NULL DEFAULT '',
  actual_value NUMERIC(8,4) NOT NULL DEFAULT 0,
  threshold    NUMERIC(12,4) NOT NULL DEFAULT 0,
  target_met   BOOLEAN NOT NULL DEFAULT false,
  breached     BOOLEAN NOT NULL DEFAULT false,
  window_hours INT NOT NULL DEFAULT 720,
  evaluated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS slo_error_budgets (
  id                   BIGSERIAL PRIMARY KEY,
  org_id               TEXT NOT NULL,
  slo_id               TEXT NOT NULL REFERENCES slo_definitions(id) ON DELETE CASCADE,
  month                TEXT NOT NULL DEFAULT '',
  budget_remaining_pct NUMERIC(8,4) NOT NULL DEFAULT 100,
  burn_rate            NUMERIC(8,4) NOT NULL DEFAULT 0,
  total_evaluations    INT NOT NULL DEFAULT 0,
  breaches             INT NOT NULL DEFAULT 0,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, slo_id, month)
);

CREATE TABLE IF NOT EXISTS alert_configs (
  id                    TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id                TEXT NOT NULL,
  agent_name            TEXT,
  name                  TEXT NOT NULL DEFAULT '',
  type                  TEXT NOT NULL DEFAULT '',
  alert_type            TEXT NOT NULL DEFAULT 'error_rate',
  threshold             NUMERIC(12,4) NOT NULL DEFAULT 0,
  comparison            TEXT NOT NULL DEFAULT 'gte'
                        CHECK (comparison IN ('gte', 'lte', 'gt', 'lt')),
  window_minutes        INT NOT NULL DEFAULT 60,
  cooldown_minutes      INT NOT NULL DEFAULT 60,
  notification_channel  TEXT,
  webhook_url           TEXT,
  webhook_secret        TEXT,
  is_active             BOOLEAN NOT NULL DEFAULT true,
  enabled               BOOLEAN NOT NULL DEFAULT true,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS alert_history (
  id              BIGSERIAL PRIMARY KEY,
  alert_config_id TEXT NOT NULL REFERENCES alert_configs(id) ON DELETE CASCADE,
  org_id          TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'fired'
                  CHECK (status IN ('fired', 'resolved', 'acknowledged')),
  value           NUMERIC(12,4),
  message         TEXT NOT NULL DEFAULT '',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at     TIMESTAMPTZ
);

-- ============================================================================
-- SECTION 18: Miscellaneous
-- ============================================================================

CREATE TABLE IF NOT EXISTS custom_domains (
  id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id     TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
  domain     TEXT NOT NULL DEFAULT '',
  type       TEXT NOT NULL DEFAULT 'subdomain'
             CHECK (type IN ('subdomain', 'custom')),
  ssl_status TEXT NOT NULL DEFAULT 'pending'
             CHECK (ssl_status IN ('pending', 'active', 'failed')),
  status     TEXT NOT NULL DEFAULT 'pending'
             CHECK (status IN ('pending', 'active', 'failed', 'removed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS webhooks (
  id                  TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  webhook_id          TEXT,
  org_id              TEXT NOT NULL,
  url                 TEXT NOT NULL DEFAULT '',
  events              JSONB NOT NULL DEFAULT '[]',
  secret              TEXT,
  codemode_handler_id TEXT,
  is_active           BOOLEAN NOT NULL DEFAULT true,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id              BIGSERIAL PRIMARY KEY,
  webhook_id      TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event_type      TEXT NOT NULL DEFAULT '',
  payload_json    JSONB NOT NULL DEFAULT '{}',
  status_code     INT,
  response_status INT,
  response_body   TEXT,
  duration_ms     INT NOT NULL DEFAULT 0,
  success         BOOLEAN,
  attempts        INT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS github_webhook_subscriptions (
  id             TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id         TEXT NOT NULL,
  repo_full_name TEXT NOT NULL DEFAULT '',
  events         JSONB NOT NULL DEFAULT '[]',
  secret         TEXT,
  is_active      BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS file_uploads (
  id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  file_id      TEXT,
  org_id       TEXT NOT NULL,
  uploaded_by  TEXT,
  filename     TEXT NOT NULL DEFAULT '',
  content_type TEXT NOT NULL DEFAULT '',
  size_bytes   BIGINT NOT NULL DEFAULT 0,
  storage_key  TEXT NOT NULL DEFAULT '',
  r2_key       TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS end_user_tokens (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  token_id        TEXT,
  org_id          TEXT NOT NULL,
  token_hash      TEXT NOT NULL UNIQUE,
  user_identifier TEXT NOT NULL DEFAULT '',
  end_user_id     TEXT NOT NULL DEFAULT '',
  api_key_id      TEXT,
  scopes          JSONB NOT NULL DEFAULT '[]',
  allowed_agents  JSONB NOT NULL DEFAULT '[]',
  rate_limit_rpm  INT,
  rate_limit_rpd  INT,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  revoked         BOOLEAN NOT NULL DEFAULT false,
  is_revoked      BOOLEAN NOT NULL DEFAULT false,
  expires_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS end_user_usage (
  id              BIGSERIAL PRIMARY KEY,
  org_id          TEXT NOT NULL,
  user_identifier TEXT NOT NULL DEFAULT '',
  end_user_id     TEXT NOT NULL DEFAULT '',
  agent_name      TEXT NOT NULL DEFAULT '',
  session_id      TEXT,
  tokens_used     INT NOT NULL DEFAULT 0,
  input_tokens    INT NOT NULL DEFAULT 0,
  cost_usd        NUMERIC(12,8) NOT NULL DEFAULT 0,
  latency_ms      INT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS environments (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id      TEXT NOT NULL,
  name        TEXT NOT NULL DEFAULT '',
  config_json JSONB NOT NULL DEFAULT '{}',
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS project_configs (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id      TEXT NOT NULL,
  project_id  TEXT,
  config_json JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_feedback (
  id            BIGSERIAL PRIMARY KEY,
  org_id        TEXT NOT NULL,
  agent_name    TEXT NOT NULL DEFAULT '',
  session_id    TEXT,
  rating        INT NOT NULL CHECK (rating >= 1 AND rating <= 5),
  feedback_text TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS issues (
  id                TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  issue_id          TEXT,
  org_id            TEXT NOT NULL,
  agent_name        TEXT NOT NULL DEFAULT '',
  title             TEXT NOT NULL DEFAULT '',
  description       TEXT NOT NULL DEFAULT '',
  issue_type        TEXT,
  category          TEXT,
  source            TEXT,
  source_session_id TEXT,
  suggested_fix     TEXT,
  metadata_json     JSONB NOT NULL DEFAULT '{}',
  severity          TEXT NOT NULL DEFAULT 'medium',
  status            TEXT NOT NULL DEFAULT 'open',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS feed_posts (
  id                 TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id             TEXT NOT NULL,
  agent_name         TEXT NOT NULL DEFAULT '',
  post_type          TEXT NOT NULL DEFAULT '',
  title              TEXT NOT NULL DEFAULT '',
  content            TEXT NOT NULL DEFAULT '',
  body               TEXT NOT NULL DEFAULT '',
  tags               JSONB NOT NULL DEFAULT '[]',
  image_url          TEXT,
  cta_text           TEXT,
  cta_url            TEXT,
  offer_discount_pct INT,
  offer_price_usd    NUMERIC(12,8),
  offer_expires_at   TIMESTAMPTZ,
  views              INT NOT NULL DEFAULT 0,
  clicks             INT NOT NULL DEFAULT 0,
  is_active          BOOLEAN NOT NULL DEFAULT true,
  is_promoted        BOOLEAN NOT NULL DEFAULT false,
  promoted_until     TIMESTAMPTZ,
  promotion_cost_usd NUMERIC(12,8),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS network_stats (
  id                           BIGSERIAL PRIMARY KEY,
  total_agents                 INT NOT NULL DEFAULT 0,
  total_sessions               INT NOT NULL DEFAULT 0,
  total_marketplace_listings   INT NOT NULL DEFAULT 0,
  total_orgs                   INT NOT NULL DEFAULT 0,
  total_transactions_24h       INT NOT NULL DEFAULT 0,
  total_volume_24h_usd         NUMERIC(12,8) NOT NULL DEFAULT 0,
  total_transactions_all_time  INT NOT NULL DEFAULT 0,
  total_volume_all_time_usd    NUMERIC(12,8) NOT NULL DEFAULT 0,
  total_feed_posts             INT NOT NULL DEFAULT 0,
  trending_categories          JSONB NOT NULL DEFAULT '[]',
  updated_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS event_types (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name        TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  schema_json JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS referrals (
  id                  TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  referrer_org_id     TEXT NOT NULL,
  referred_org_id     TEXT,
  referrer_user_id    TEXT NOT NULL DEFAULT '',
  referral_code       TEXT NOT NULL DEFAULT '',
  status              TEXT NOT NULL DEFAULT 'pending',
  referral_activated  BOOLEAN NOT NULL DEFAULT false,
  referred_task_count INT NOT NULL DEFAULT 0,
  referred_volume_usd NUMERIC(12,8) NOT NULL DEFAULT 0,
  activated_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS referral_codes (
  id             TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id         TEXT NOT NULL,
  user_id        TEXT NOT NULL DEFAULT '',
  code           TEXT NOT NULL UNIQUE,
  label          TEXT NOT NULL DEFAULT '',
  commission_pct NUMERIC(5,2) NOT NULL DEFAULT 0,
  uses           INT NOT NULL DEFAULT 0,
  max_uses       INT,
  is_active      BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS referral_earnings (
  id               BIGSERIAL PRIMARY KEY,
  earner_org_id    TEXT NOT NULL,
  source_org_id    TEXT NOT NULL DEFAULT '',
  referral_id      TEXT NOT NULL DEFAULT '',
  transfer_id      TEXT NOT NULL DEFAULT '',
  level            INT NOT NULL DEFAULT 1,
  amount_usd       NUMERIC(12,8) NOT NULL DEFAULT 0,
  platform_fee_usd NUMERIC(12,8) NOT NULL DEFAULT 0,
  earning_usd      NUMERIC(12,8) NOT NULL DEFAULT 0,
  earning_rate     NUMERIC(8,6) NOT NULL DEFAULT 0,
  period           TEXT NOT NULL DEFAULT '',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS meta_proposals (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id        TEXT NOT NULL,
  agent_name    TEXT NOT NULL DEFAULT '',
  proposal_type TEXT NOT NULL DEFAULT '',
  content_json  JSONB NOT NULL DEFAULT '{}',
  status        TEXT NOT NULL DEFAULT 'pending',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS canary_splits (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id          TEXT NOT NULL,
  agent_name      TEXT NOT NULL DEFAULT '',
  primary_version TEXT,
  canary_version  TEXT,
  canary_weight   NUMERIC(5,4) NOT NULL DEFAULT 0,
  config_json     JSONB NOT NULL DEFAULT '{}',
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS release_channels (
  id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id       TEXT NOT NULL,
  agent_name   TEXT NOT NULL DEFAULT '',
  channel      TEXT NOT NULL DEFAULT '',
  channel_name TEXT NOT NULL DEFAULT '',
  version      TEXT,
  promoted_by  TEXT,
  promoted_at  TIMESTAMPTZ,
  config_json  JSONB NOT NULL DEFAULT '{}',
  is_active    BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS retention_policies (
  id                    TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  policy_id             TEXT,
  org_id                TEXT NOT NULL,
  resource_type         TEXT NOT NULL DEFAULT '',
  retention_days        INT NOT NULL DEFAULT 90,
  redact_pii            BOOLEAN NOT NULL DEFAULT false,
  redact_fields         JSONB NOT NULL DEFAULT '[]',
  archive_before_delete BOOLEAN NOT NULL DEFAULT false,
  is_active             BOOLEAN NOT NULL DEFAULT true,
  enabled               BOOLEAN NOT NULL DEFAULT true,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS gold_images (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id      TEXT NOT NULL,
  agent_name  TEXT NOT NULL DEFAULT '',
  config_json JSONB NOT NULL DEFAULT '{}',
  score       NUMERIC(8,4) NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS gpu_endpoints (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id      TEXT NOT NULL,
  name        TEXT NOT NULL DEFAULT '',
  url         TEXT NOT NULL DEFAULT '',
  provider    TEXT NOT NULL DEFAULT '',
  model       TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'active',
  config_json JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pipelines (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id          TEXT NOT NULL,
  name            TEXT NOT NULL DEFAULT '',
  definition_json JSONB NOT NULL DEFAULT '{}',
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS components (
  component_id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id       TEXT NOT NULL,
  type         TEXT NOT NULL DEFAULT 'graph'
               CHECK (type IN ('graph', 'prompt', 'tool_set', 'node_template')),
  name         TEXT NOT NULL DEFAULT '',
  description  TEXT NOT NULL DEFAULT '',
  config_json  JSONB NOT NULL DEFAULT '{}',
  is_public    BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, type, name)
);

CREATE TABLE IF NOT EXISTS component_usage (
  id           BIGSERIAL PRIMARY KEY,
  component_id TEXT NOT NULL REFERENCES components(component_id) ON DELETE CASCADE,
  org_id       TEXT NOT NULL,
  agent_name   TEXT NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS subgraph_definitions (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id          TEXT NOT NULL,
  name            TEXT NOT NULL DEFAULT '',
  version         INT NOT NULL DEFAULT 1,
  definition_json JSONB NOT NULL DEFAULT '{}',
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, name, version)
);

CREATE TABLE IF NOT EXISTS prompt_versions (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  component_id    TEXT NOT NULL REFERENCES components(component_id) ON DELETE CASCADE,
  version         INT NOT NULL DEFAULT 1,
  prompt_text     TEXT NOT NULL DEFAULT '',
  config_json     JSONB NOT NULL DEFAULT '{}',
  traffic_percent INT NOT NULL DEFAULT 100 CHECK (traffic_percent >= 0 AND traffic_percent <= 100),
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (component_id, version)
);

CREATE TABLE IF NOT EXISTS graph_snapshots (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id        TEXT NOT NULL,
  agent_name    TEXT NOT NULL DEFAULT '',
  graph_hash    TEXT NOT NULL DEFAULT '',
  snapshot_json JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, agent_name, graph_hash)
);

CREATE TABLE IF NOT EXISTS node_checkpoints (
  id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id     TEXT NOT NULL,
  session_id TEXT NOT NULL,
  node_id    TEXT NOT NULL DEFAULT '',
  state_json JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS langchain_tools (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id      TEXT NOT NULL,
  name        TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  config_json JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS schema_validation_errors (
  id            BIGSERIAL PRIMARY KEY,
  org_id        TEXT NOT NULL,
  resource_type TEXT NOT NULL DEFAULT '',
  resource_id   TEXT,
  errors_json   JSONB NOT NULL DEFAULT '[]',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS codemode_executions (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  snippet_id    TEXT NOT NULL REFERENCES codemode_snippets(id) ON DELETE CASCADE,
  org_id        TEXT NOT NULL,
  input_json    JSONB NOT NULL DEFAULT '{}',
  output_json   JSONB NOT NULL DEFAULT '{}',
  duration_ms   INT NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'pending',
  error_message TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- SECTION 19a: RAG, missing tables, referral anti-gaming
-- ============================================================================

-- BM25 full-text search for RAG chunks (used by deploy/src/runtime/rag-hybrid.ts)
CREATE TABLE IF NOT EXISTS rag_chunks (
  id             TEXT PRIMARY KEY,
  source         TEXT NOT NULL DEFAULT '',
  pipeline       TEXT NOT NULL DEFAULT '',
  org_id         TEXT NOT NULL DEFAULT '',
  agent_name     TEXT NOT NULL DEFAULT '',
  chunk_index    INT NOT NULL DEFAULT 0,
  chunk_type     TEXT NOT NULL DEFAULT '',
  text           TEXT NOT NULL DEFAULT '',
  context_prefix TEXT NOT NULL DEFAULT '',
  tsv            TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', coalesce(context_prefix, '') || ' ' || coalesce(text, ''))) STORED
);

CREATE INDEX IF NOT EXISTS idx_rag_chunks_tsv ON rag_chunks USING GIN (tsv);
CREATE INDEX IF NOT EXISTS idx_rag_chunks_org_id ON rag_chunks(org_id);
CREATE INDEX IF NOT EXISTS idx_rag_chunks_source ON rag_chunks(source);

CREATE TABLE IF NOT EXISTS security_scan_findings (
  id          BIGSERIAL PRIMARY KEY,
  scan_id     TEXT NOT NULL,
  org_id      TEXT NOT NULL,
  agent_name  TEXT NOT NULL DEFAULT '',
  probe_id    TEXT NOT NULL DEFAULT '',
  probe_name  TEXT NOT NULL DEFAULT '',
  category    TEXT NOT NULL DEFAULT '',
  severity    TEXT NOT NULL DEFAULT 'info',
  description TEXT NOT NULL DEFAULT '',
  passed      BOOLEAN NOT NULL DEFAULT true,
  response    TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_log_archive (
  id          BIGSERIAL PRIMARY KEY,
  archive_key TEXT NOT NULL DEFAULT '',
  org_id      TEXT NOT NULL,
  row_count   INT NOT NULL DEFAULT 0,
  data_json   JSONB NOT NULL DEFAULT '[]',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS transfer_pairs (
  id          BIGSERIAL PRIMARY KEY,
  from_org_id TEXT NOT NULL,
  to_org_id   TEXT NOT NULL,
  amount_usd  NUMERIC(12,8) NOT NULL DEFAULT 0,
  transfer_id TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS transfer_rate_limits (
  org_id           TEXT PRIMARY KEY,
  transfers_this_hour INT NOT NULL DEFAULT 0,
  hour_window      TIMESTAMPTZ NOT NULL DEFAULT date_trunc('hour', NOW()),
  volume_today_usd NUMERIC(12,8) NOT NULL DEFAULT 0,
  day_window       DATE NOT NULL DEFAULT CURRENT_DATE,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- SECTION 19: Indexes
-- ============================================================================

-- Core entities
CREATE INDEX IF NOT EXISTS idx_projects_org_id ON projects(org_id);
CREATE INDEX IF NOT EXISTS idx_agents_org_id ON agents(org_id);
CREATE INDEX IF NOT EXISTS idx_agents_org_name ON agents(org_id, name);

-- Auth & API Keys
CREATE INDEX IF NOT EXISTS idx_api_keys_org_id ON api_keys(org_id);
CREATE INDEX IF NOT EXISTS idx_api_key_agent_scopes_key_id ON api_key_agent_scopes(key_id);
CREATE INDEX IF NOT EXISTS idx_org_members_user_id ON org_members(user_id);
CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_sessions_token ON user_sessions(session_token);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user_id ON password_reset_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_email_verification_tokens_user_id ON email_verification_tokens(user_id);

-- Sessions & Turns (performance-critical)
CREATE INDEX IF NOT EXISTS idx_sessions_org_id ON sessions(org_id);
CREATE INDEX IF NOT EXISTS idx_sessions_org_agent ON sessions(org_id, agent_name);
CREATE INDEX IF NOT EXISTS idx_sessions_org_status ON sessions(org_id, status);
CREATE INDEX IF NOT EXISTS idx_sessions_conversation_id ON sessions(conversation_id);
CREATE INDEX IF NOT EXISTS idx_sessions_created_at ON sessions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_session_id) WHERE parent_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sessions_trace_id ON sessions(trace_id) WHERE trace_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_turns_session_id ON turns(session_id);
CREATE INDEX IF NOT EXISTS idx_turns_created_at ON turns(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_turns_refusal ON turns(session_id) WHERE refusal = true;
CREATE INDEX IF NOT EXISTS idx_turns_model_latency ON turns(model_used, llm_latency_ms DESC);
CREATE INDEX IF NOT EXISTS idx_session_progress_session_id ON session_progress(session_id);
CREATE INDEX IF NOT EXISTS idx_session_feedback_session_id ON session_feedback(session_id);
CREATE INDEX IF NOT EXISTS idx_session_feedback_org_id ON session_feedback(org_id);

-- Conversations
CREATE INDEX IF NOT EXISTS idx_conversations_org_id ON conversations(org_id);
CREATE INDEX IF NOT EXISTS idx_conversations_org_agent ON conversations(org_id, agent_name);
CREATE INDEX IF NOT EXISTS idx_conversations_org_user ON conversations(org_id, user_id);
CREATE INDEX IF NOT EXISTS idx_conversations_org_status ON conversations(org_id, status);
CREATE INDEX IF NOT EXISTS idx_conversations_created_at ON conversations(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversation_messages_conversation_id ON conversation_messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_conversation_messages_created_at ON conversation_messages(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_do_conversation_messages_agent_instance ON do_conversation_messages(agent_name, instance_id);
CREATE INDEX IF NOT EXISTS idx_do_conversation_messages_created_at ON do_conversation_messages(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversation_analytics_org_id ON conversation_analytics(org_id);
CREATE INDEX IF NOT EXISTS idx_conversation_scores_conversation_id ON conversation_scores(conversation_id);
CREATE INDEX IF NOT EXISTS idx_conversation_scores_org_id ON conversation_scores(org_id);

-- Billing & Credits
CREATE INDEX IF NOT EXISTS idx_credit_transactions_org_id ON credit_transactions(org_id);
CREATE INDEX IF NOT EXISTS idx_credit_transactions_created_at ON credit_transactions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_billing_records_org_id ON billing_records(org_id);
CREATE INDEX IF NOT EXISTS idx_billing_records_session_id ON billing_records(session_id);
CREATE INDEX IF NOT EXISTS idx_billing_records_created_at ON billing_records(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pricing_catalog_provider_model ON pricing_catalog(provider, model);
CREATE INDEX IF NOT EXISTS idx_cost_ledger_org_id ON cost_ledger(org_id);
CREATE INDEX IF NOT EXISTS idx_billing_events_org_id ON billing_events(org_id);
CREATE INDEX IF NOT EXISTS idx_billing_events_created_at ON billing_events(created_at DESC);

-- Training & Eval
CREATE INDEX IF NOT EXISTS idx_eval_runs_org_id ON eval_runs(org_id);
CREATE INDEX IF NOT EXISTS idx_eval_runs_org_agent ON eval_runs(org_id, agent_name);
CREATE INDEX IF NOT EXISTS idx_eval_trials_eval_run_id ON eval_trials(eval_run_id);
CREATE INDEX IF NOT EXISTS idx_training_jobs_org_id ON training_jobs(org_id);
CREATE INDEX IF NOT EXISTS idx_training_jobs_org_agent ON training_jobs(org_id, agent_name);
CREATE INDEX IF NOT EXISTS idx_training_iterations_job_id ON training_iterations(job_id);
CREATE INDEX IF NOT EXISTS idx_training_resources_org_agent ON training_resources(org_id, agent_name);
CREATE INDEX IF NOT EXISTS idx_training_rewards_job_id ON training_rewards(job_id);

-- Marketplace & A2A
CREATE INDEX IF NOT EXISTS idx_marketplace_listings_org_id ON marketplace_listings(org_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_listings_active ON marketplace_listings(is_active) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_marketplace_ratings_listing_id ON marketplace_ratings(listing_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_featured_listing_id ON marketplace_featured(listing_id);
CREATE INDEX IF NOT EXISTS idx_a2a_agents_org_id ON a2a_agents(org_id);
CREATE INDEX IF NOT EXISTS idx_a2a_tasks_caller_org ON a2a_tasks(caller_org_id);
CREATE INDEX IF NOT EXISTS idx_a2a_tasks_callee_org ON a2a_tasks(callee_org_id);
CREATE INDEX IF NOT EXISTS idx_a2a_tasks_created_at ON a2a_tasks(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_a2a_artifacts_task_id ON a2a_artifacts(task_id);
CREATE INDEX IF NOT EXISTS idx_delegation_events_org_id ON delegation_events(org_id);
CREATE INDEX IF NOT EXISTS idx_delegation_events_parent_session ON delegation_events(parent_session_id);

-- Observability & Telemetry
CREATE INDEX IF NOT EXISTS idx_otel_events_org_id ON otel_events(org_id);
CREATE INDEX IF NOT EXISTS idx_otel_events_org_agent ON otel_events(org_id, agent_name);
CREATE INDEX IF NOT EXISTS idx_otel_events_session_id ON otel_events(session_id);
CREATE INDEX IF NOT EXISTS idx_otel_events_trace_id ON otel_events(trace_id);
CREATE INDEX IF NOT EXISTS idx_otel_events_created_at ON otel_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_runtime_events_org_id ON runtime_events(org_id);
CREATE INDEX IF NOT EXISTS idx_runtime_events_created_at ON runtime_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_span_feedback_span_id ON span_feedback(span_id);
CREATE INDEX IF NOT EXISTS idx_trace_annotations_trace_id ON trace_annotations(trace_id);
CREATE INDEX IF NOT EXISTS idx_trace_lineage_parent ON trace_lineage(parent_trace_id);
CREATE INDEX IF NOT EXISTS idx_trace_lineage_child ON trace_lineage(child_trace_id);
CREATE INDEX IF NOT EXISTS idx_middleware_events_org_id ON middleware_events(org_id);
CREATE INDEX IF NOT EXISTS idx_tool_executions_org_id ON tool_executions(org_id);
CREATE INDEX IF NOT EXISTS idx_tool_executions_session_id ON tool_executions(session_id);

-- Scheduling, Jobs & Workflows
CREATE INDEX IF NOT EXISTS idx_schedules_org_id ON schedules(org_id);
CREATE INDEX IF NOT EXISTS idx_schedules_active ON schedules(is_active) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_job_queue_org_id ON job_queue(org_id);
CREATE INDEX IF NOT EXISTS idx_job_queue_status ON job_queue(status);
CREATE INDEX IF NOT EXISTS idx_batch_jobs_org_id ON batch_jobs(org_id);
CREATE INDEX IF NOT EXISTS idx_batch_tasks_batch_id ON batch_tasks(batch_id);
CREATE INDEX IF NOT EXISTS idx_workflows_org_id ON workflows(org_id);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow_id ON workflow_runs(workflow_id);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_org_id ON workflow_runs(org_id);
CREATE INDEX IF NOT EXISTS idx_workflow_approvals_run_id ON workflow_approvals(workflow_run_id);

-- Security, Compliance & Audit
CREATE INDEX IF NOT EXISTS idx_audit_log_org_id ON audit_log(org_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_org_action ON audit_log(org_id, action);
CREATE INDEX IF NOT EXISTS idx_auth_audit_log_org_id ON auth_audit_log(org_id);
CREATE INDEX IF NOT EXISTS idx_auth_audit_log_user_id ON auth_audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_security_events_org_id ON security_events(org_id);
CREATE INDEX IF NOT EXISTS idx_security_events_severity ON security_events(severity);
CREATE INDEX IF NOT EXISTS idx_security_events_created_at ON security_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_security_scans_org_id ON security_scans(org_id);
CREATE INDEX IF NOT EXISTS idx_security_findings_org_id ON security_findings(org_id);
CREATE INDEX IF NOT EXISTS idx_secrets_org_id ON secrets(org_id);
CREATE INDEX IF NOT EXISTS idx_secrets_key_rotations_secret_id ON secrets_key_rotations(secret_id);
CREATE INDEX IF NOT EXISTS idx_api_access_log_org_id ON api_access_log(org_id);
CREATE INDEX IF NOT EXISTS idx_api_access_log_created_at ON api_access_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_api_access_log_key_id ON api_access_log(key_id);
CREATE INDEX IF NOT EXISTS idx_idempotency_cache_expires ON idempotency_cache(expires_at);

-- Agent Intelligence & Memory
CREATE INDEX IF NOT EXISTS idx_user_profiles_org_agent ON user_profiles(org_id, agent_name);
CREATE INDEX IF NOT EXISTS idx_memory_facts_org_agent ON memory_facts(org_id, agent_name);
CREATE INDEX IF NOT EXISTS idx_semantic_facts_org_agent ON semantic_facts(org_id, agent_name);
CREATE INDEX IF NOT EXISTS idx_episodic_memories_org_agent ON episodic_memories(org_id, agent_name);
CREATE INDEX IF NOT EXISTS idx_episodes_org_agent ON episodes(org_id, agent_name);
CREATE INDEX IF NOT EXISTS idx_facts_org_agent ON facts(org_id, agent_name);
CREATE INDEX IF NOT EXISTS idx_procedures_org_agent ON procedures(org_id, agent_name);
CREATE INDEX IF NOT EXISTS idx_agent_procedures_org_agent ON agent_procedures(org_id, agent_name);
CREATE INDEX IF NOT EXISTS idx_agent_policies_org_agent ON agent_policies(org_id, agent_name);
CREATE INDEX IF NOT EXISTS idx_team_facts_org_id ON team_facts(org_id);
CREATE INDEX IF NOT EXISTS idx_team_observations_org_id ON team_observations(org_id);

-- Skills, Connectors & Tools
CREATE INDEX IF NOT EXISTS idx_skills_org_id ON skills(org_id);
CREATE INDEX IF NOT EXISTS idx_skills_org_agent ON skills(org_id, agent_name);
CREATE INDEX IF NOT EXISTS idx_tool_registry_org_id ON tool_registry(org_id);
CREATE INDEX IF NOT EXISTS idx_connector_tokens_org_id ON connector_tokens(org_id);
CREATE INDEX IF NOT EXISTS idx_connector_tools_app ON connector_tools(app);
CREATE INDEX IF NOT EXISTS idx_mcp_servers_org_id ON mcp_servers(org_id);
CREATE INDEX IF NOT EXISTS idx_codemode_snippets_org_id ON codemode_snippets(org_id);

-- Channels & Voice
CREATE INDEX IF NOT EXISTS idx_channel_configs_agent ON channel_configs(agent_name);
CREATE INDEX IF NOT EXISTS idx_autopilot_sessions_org_id ON autopilot_sessions(org_id);
CREATE INDEX IF NOT EXISTS idx_voice_calls_org_id ON voice_calls(org_id);
CREATE INDEX IF NOT EXISTS idx_voice_numbers_org_id ON voice_numbers(org_id);

-- Evolution & Governance
CREATE INDEX IF NOT EXISTS idx_evolution_proposals_org_agent ON evolution_proposals(org_id, agent_name);
CREATE INDEX IF NOT EXISTS idx_evolution_proposals_status ON evolution_proposals(status);
CREATE INDEX IF NOT EXISTS idx_evolution_ledger_org_agent ON evolution_ledger(org_id, agent_name);
CREATE INDEX IF NOT EXISTS idx_evolution_reports_org_agent ON evolution_reports(org_id, agent_name);
CREATE INDEX IF NOT EXISTS idx_guardrail_policies_org_agent ON guardrail_policies(org_id, agent_name);
CREATE INDEX IF NOT EXISTS idx_guardrail_events_org_id ON guardrail_events(org_id);
CREATE INDEX IF NOT EXISTS idx_guardrail_events_session_id ON guardrail_events(session_id);
CREATE INDEX IF NOT EXISTS idx_risk_profiles_org_agent ON risk_profiles(org_id, agent_name);

-- DLP & Classification
CREATE INDEX IF NOT EXISTS idx_dlp_classifications_org_id ON dlp_classifications(org_id);
CREATE INDEX IF NOT EXISTS idx_dlp_agent_policies_org_id ON dlp_agent_policies(org_id);

-- SLO & Monitoring
CREATE INDEX IF NOT EXISTS idx_slo_definitions_org_id ON slo_definitions(org_id);
CREATE INDEX IF NOT EXISTS idx_slo_evaluations_org_id ON slo_evaluations(org_id);
CREATE INDEX IF NOT EXISTS idx_slo_evaluations_slo_id ON slo_evaluations(slo_id);
CREATE INDEX IF NOT EXISTS idx_alert_configs_org_id ON alert_configs(org_id);
CREATE INDEX IF NOT EXISTS idx_alert_configs_active ON alert_configs(is_active) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_alert_history_alert_config_id ON alert_history(alert_config_id);
CREATE INDEX IF NOT EXISTS idx_alert_history_org_id ON alert_history(org_id);

-- Miscellaneous
CREATE INDEX IF NOT EXISTS idx_custom_domains_org_id ON custom_domains(org_id);
CREATE INDEX IF NOT EXISTS idx_webhooks_org_id ON webhooks(org_id);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook_id ON webhook_deliveries(webhook_id);
CREATE INDEX IF NOT EXISTS idx_github_webhook_subscriptions_org_id ON github_webhook_subscriptions(org_id);
CREATE INDEX IF NOT EXISTS idx_file_uploads_org_id ON file_uploads(org_id);
CREATE INDEX IF NOT EXISTS idx_end_user_tokens_org_id ON end_user_tokens(org_id);
CREATE INDEX IF NOT EXISTS idx_end_user_usage_org_id ON end_user_usage(org_id);
CREATE INDEX IF NOT EXISTS idx_end_user_usage_org_user ON end_user_usage(org_id, user_identifier);
CREATE INDEX IF NOT EXISTS idx_environments_org_id ON environments(org_id);
CREATE INDEX IF NOT EXISTS idx_project_configs_org_id ON project_configs(org_id);
CREATE INDEX IF NOT EXISTS idx_user_feedback_org_id ON user_feedback(org_id);
CREATE INDEX IF NOT EXISTS idx_user_feedback_session_id ON user_feedback(session_id);
CREATE INDEX IF NOT EXISTS idx_issues_org_id ON issues(org_id);
CREATE INDEX IF NOT EXISTS idx_issues_org_status ON issues(org_id, status);
CREATE INDEX IF NOT EXISTS idx_feed_posts_org_id ON feed_posts(org_id);
CREATE INDEX IF NOT EXISTS idx_feed_posts_active ON feed_posts(is_active) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_org_id);
CREATE INDEX IF NOT EXISTS idx_referral_codes_org_id ON referral_codes(org_id);
CREATE INDEX IF NOT EXISTS idx_referral_earnings_earner ON referral_earnings(earner_org_id);
CREATE INDEX IF NOT EXISTS idx_meta_proposals_org_id ON meta_proposals(org_id);
CREATE INDEX IF NOT EXISTS idx_canary_splits_org_agent ON canary_splits(org_id, agent_name);
CREATE INDEX IF NOT EXISTS idx_release_channels_org_agent ON release_channels(org_id, agent_name);
CREATE INDEX IF NOT EXISTS idx_retention_policies_org_id ON retention_policies(org_id);
CREATE INDEX IF NOT EXISTS idx_gold_images_org_agent ON gold_images(org_id, agent_name);
CREATE INDEX IF NOT EXISTS idx_gpu_endpoints_org_id ON gpu_endpoints(org_id);
CREATE INDEX IF NOT EXISTS idx_pipelines_org_id ON pipelines(org_id);
CREATE INDEX IF NOT EXISTS idx_components_org_id ON components(org_id);
CREATE INDEX IF NOT EXISTS idx_component_usage_component_id ON component_usage(component_id);
CREATE INDEX IF NOT EXISTS idx_component_usage_org_id ON component_usage(org_id);
CREATE INDEX IF NOT EXISTS idx_subgraph_definitions_org_id ON subgraph_definitions(org_id);
CREATE INDEX IF NOT EXISTS idx_prompt_versions_component_id ON prompt_versions(component_id);
CREATE INDEX IF NOT EXISTS idx_graph_snapshots_org_agent ON graph_snapshots(org_id, agent_name);
CREATE INDEX IF NOT EXISTS idx_node_checkpoints_org_session ON node_checkpoints(org_id, session_id);
CREATE INDEX IF NOT EXISTS idx_langchain_tools_org_id ON langchain_tools(org_id);
CREATE INDEX IF NOT EXISTS idx_schema_validation_errors_org_id ON schema_validation_errors(org_id);
CREATE INDEX IF NOT EXISTS idx_codemode_executions_snippet_id ON codemode_executions(snippet_id);
CREATE INDEX IF NOT EXISTS idx_codemode_executions_org_id ON codemode_executions(org_id);

-- Missing tables indexes
CREATE INDEX IF NOT EXISTS idx_security_scan_findings_scan_id ON security_scan_findings(scan_id);
CREATE INDEX IF NOT EXISTS idx_security_scan_findings_org_id ON security_scan_findings(org_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_archive_org_id ON audit_log_archive(org_id);
CREATE INDEX IF NOT EXISTS idx_transfer_pairs_orgs ON transfer_pairs(from_org_id, to_org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_credit_transactions_reference_id ON credit_transactions(reference_id) WHERE reference_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_referral_earnings_transfer_id ON referral_earnings(transfer_id);
CREATE INDEX IF NOT EXISTS idx_end_user_tokens_end_user_id ON end_user_tokens(org_id, end_user_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_listings_published ON marketplace_listings(is_published) WHERE is_published = true;
CREATE INDEX IF NOT EXISTS idx_marketplace_listings_featured ON marketplace_listings(is_featured) WHERE is_featured = true;
CREATE INDEX IF NOT EXISTS idx_feed_posts_promoted ON feed_posts(is_promoted) WHERE is_promoted = true;

-- GIN indexes for JSONB query patterns
CREATE INDEX IF NOT EXISTS idx_channel_configs_config_gin ON channel_configs USING GIN (config);
CREATE INDEX IF NOT EXISTS idx_agents_config_gin ON agents USING GIN (config_json);
CREATE INDEX IF NOT EXISTS idx_marketplace_listings_tags_gin ON marketplace_listings USING GIN (tags);

-- ============================================================================
-- SECTION 20: Row Level Security
-- ============================================================================

-- Helper: enable + force RLS on all tables
-- Tables WITH org_id get org-isolation policy
-- Tables WITHOUT org_id get service-role-only policy

-- ---- Core Entities ----
ALTER TABLE orgs ENABLE ROW LEVEL SECURITY;
ALTER TABLE orgs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "orgs_service" ON orgs;
CREATE POLICY "orgs_service" ON orgs FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "orgs_org" ON orgs;
CREATE POLICY "orgs_org" ON orgs FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "users_service" ON users;
CREATE POLICY "users_service" ON users FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "users_self" ON users;
CREATE POLICY "users_self" ON users FOR ALL USING (user_id = current_setting('app.user_id', true)) WITH CHECK (user_id = current_setting('app.user_id', true));

ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "projects_service" ON projects;
CREATE POLICY "projects_service" ON projects FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "projects_org" ON projects;
CREATE POLICY "projects_org" ON projects FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "agents_service" ON agents;
CREATE POLICY "agents_service" ON agents FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "agents_org" ON agents;
CREATE POLICY "agents_org" ON agents FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE agent_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_versions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "agent_versions_service" ON agent_versions;
CREATE POLICY "agent_versions_service" ON agent_versions FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ---- Auth & API Keys ----
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "api_keys_service" ON api_keys;
CREATE POLICY "api_keys_service" ON api_keys FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "api_keys_org" ON api_keys;
CREATE POLICY "api_keys_org" ON api_keys FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE api_key_agent_scopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_key_agent_scopes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "api_key_agent_scopes_service" ON api_key_agent_scopes;
CREATE POLICY "api_key_agent_scopes_service" ON api_key_agent_scopes FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE org_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_members FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "org_members_service" ON org_members;
CREATE POLICY "org_members_service" ON org_members FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "org_members_org" ON org_members;
CREATE POLICY "org_members_org" ON org_members FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE org_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "org_settings_service" ON org_settings;
CREATE POLICY "org_settings_service" ON org_settings FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "org_settings_org" ON org_settings;
CREATE POLICY "org_settings_org" ON org_settings FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE password_reset_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE password_reset_tokens FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "password_reset_tokens_service" ON password_reset_tokens;
CREATE POLICY "password_reset_tokens_service" ON password_reset_tokens FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE email_verification_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_verification_tokens FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "email_verification_tokens_service" ON email_verification_tokens;
CREATE POLICY "email_verification_tokens_service" ON email_verification_tokens FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE user_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_sessions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "user_sessions_service" ON user_sessions;
CREATE POLICY "user_sessions_service" ON user_sessions FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ---- Sessions & Turns ----
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "sessions_service" ON sessions;
CREATE POLICY "sessions_service" ON sessions FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "sessions_org" ON sessions;
CREATE POLICY "sessions_org" ON sessions FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE turns ENABLE ROW LEVEL SECURITY;
ALTER TABLE turns FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "turns_service" ON turns;
CREATE POLICY "turns_service" ON turns FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "turns_org" ON turns;
CREATE POLICY "turns_org" ON turns FOR ALL USING (
  EXISTS (SELECT 1 FROM sessions s WHERE s.session_id = turns.session_id AND s.org_id = current_setting('app.org_id', true))
) WITH CHECK (
  EXISTS (SELECT 1 FROM sessions s WHERE s.session_id = turns.session_id AND s.org_id = current_setting('app.org_id', true))
);

ALTER TABLE session_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_progress FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "session_progress_service" ON session_progress;
CREATE POLICY "session_progress_service" ON session_progress FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE session_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_feedback FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "session_feedback_service" ON session_feedback;
CREATE POLICY "session_feedback_service" ON session_feedback FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "session_feedback_org" ON session_feedback;
CREATE POLICY "session_feedback_org" ON session_feedback FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

-- ---- Conversations ----
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "conversations_service" ON conversations;
CREATE POLICY "conversations_service" ON conversations FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "conversations_org" ON conversations;
CREATE POLICY "conversations_org" ON conversations FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE conversation_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_messages FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "conversation_messages_service" ON conversation_messages;
CREATE POLICY "conversation_messages_service" ON conversation_messages FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE do_conversation_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE do_conversation_messages FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "do_conversation_messages_service" ON do_conversation_messages;
CREATE POLICY "do_conversation_messages_service" ON do_conversation_messages FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE conversation_analytics ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_analytics FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "conversation_analytics_service" ON conversation_analytics;
CREATE POLICY "conversation_analytics_service" ON conversation_analytics FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "conversation_analytics_org" ON conversation_analytics;
CREATE POLICY "conversation_analytics_org" ON conversation_analytics FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE conversation_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_scores FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "conversation_scores_service" ON conversation_scores;
CREATE POLICY "conversation_scores_service" ON conversation_scores FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "conversation_scores_org" ON conversation_scores;
CREATE POLICY "conversation_scores_org" ON conversation_scores FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

-- ---- Billing & Credits ----
ALTER TABLE org_credit_balance ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_credit_balance FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "org_credit_balance_service" ON org_credit_balance;
CREATE POLICY "org_credit_balance_service" ON org_credit_balance FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "org_credit_balance_org" ON org_credit_balance;
CREATE POLICY "org_credit_balance_org" ON org_credit_balance FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE credit_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_transactions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "credit_transactions_service" ON credit_transactions;
CREATE POLICY "credit_transactions_service" ON credit_transactions FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "credit_transactions_org" ON credit_transactions;
CREATE POLICY "credit_transactions_org" ON credit_transactions FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE billing_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_records FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "billing_records_service" ON billing_records;
CREATE POLICY "billing_records_service" ON billing_records FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "billing_records_org" ON billing_records;
CREATE POLICY "billing_records_org" ON billing_records FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE pricing_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE pricing_catalog FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "pricing_catalog_service" ON pricing_catalog;
CREATE POLICY "pricing_catalog_service" ON pricing_catalog FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE credit_packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_packages FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "credit_packages_service" ON credit_packages;
CREATE POLICY "credit_packages_service" ON credit_packages FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE stripe_events_processed ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_events_processed FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "stripe_events_processed_service" ON stripe_events_processed;
CREATE POLICY "stripe_events_processed_service" ON stripe_events_processed FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE cost_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE cost_ledger FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "cost_ledger_service" ON cost_ledger;
CREATE POLICY "cost_ledger_service" ON cost_ledger FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "cost_ledger_org" ON cost_ledger;
CREATE POLICY "cost_ledger_org" ON cost_ledger FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE billing_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "billing_events_service" ON billing_events;
CREATE POLICY "billing_events_service" ON billing_events FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "billing_events_org" ON billing_events;
CREATE POLICY "billing_events_org" ON billing_events FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

-- ---- Training & Eval ----
ALTER TABLE eval_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE eval_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "eval_runs_service" ON eval_runs;
CREATE POLICY "eval_runs_service" ON eval_runs FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "eval_runs_org" ON eval_runs;
CREATE POLICY "eval_runs_org" ON eval_runs FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE eval_trials ENABLE ROW LEVEL SECURITY;
ALTER TABLE eval_trials FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "eval_trials_service" ON eval_trials;
CREATE POLICY "eval_trials_service" ON eval_trials FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE training_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE training_jobs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "training_jobs_service" ON training_jobs;
CREATE POLICY "training_jobs_service" ON training_jobs FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "training_jobs_org" ON training_jobs;
CREATE POLICY "training_jobs_org" ON training_jobs FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE training_iterations ENABLE ROW LEVEL SECURITY;
ALTER TABLE training_iterations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "training_iterations_service" ON training_iterations;
CREATE POLICY "training_iterations_service" ON training_iterations FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE training_resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE training_resources FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "training_resources_service" ON training_resources;
CREATE POLICY "training_resources_service" ON training_resources FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "training_resources_org" ON training_resources;
CREATE POLICY "training_resources_org" ON training_resources FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE training_rewards ENABLE ROW LEVEL SECURITY;
ALTER TABLE training_rewards FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "training_rewards_service" ON training_rewards;
CREATE POLICY "training_rewards_service" ON training_rewards FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ---- Marketplace & A2A ----
ALTER TABLE marketplace_listings ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketplace_listings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "marketplace_listings_service" ON marketplace_listings;
CREATE POLICY "marketplace_listings_service" ON marketplace_listings FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "marketplace_listings_read" ON marketplace_listings;
CREATE POLICY "marketplace_listings_read" ON marketplace_listings FOR SELECT USING (is_active = true);
DROP POLICY IF EXISTS "marketplace_listings_write" ON marketplace_listings;
CREATE POLICY "marketplace_listings_write" ON marketplace_listings FOR INSERT WITH CHECK (org_id = current_setting('app.org_id', true));
DROP POLICY IF EXISTS "marketplace_listings_update" ON marketplace_listings;
CREATE POLICY "marketplace_listings_update" ON marketplace_listings FOR UPDATE USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));
DROP POLICY IF EXISTS "marketplace_listings_delete" ON marketplace_listings;
CREATE POLICY "marketplace_listings_delete" ON marketplace_listings FOR DELETE USING (org_id = current_setting('app.org_id', true));

ALTER TABLE marketplace_ratings ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketplace_ratings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "marketplace_ratings_service" ON marketplace_ratings;
CREATE POLICY "marketplace_ratings_service" ON marketplace_ratings FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE marketplace_featured ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketplace_featured FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "marketplace_featured_service" ON marketplace_featured;
CREATE POLICY "marketplace_featured_service" ON marketplace_featured FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE marketplace_queries ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketplace_queries FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "marketplace_queries_service" ON marketplace_queries;
CREATE POLICY "marketplace_queries_service" ON marketplace_queries FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE a2a_agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE a2a_agents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "a2a_agents_service" ON a2a_agents;
CREATE POLICY "a2a_agents_service" ON a2a_agents FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "a2a_agents_org" ON a2a_agents;
CREATE POLICY "a2a_agents_org" ON a2a_agents FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE a2a_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE a2a_tasks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "a2a_tasks_service" ON a2a_tasks;
CREATE POLICY "a2a_tasks_service" ON a2a_tasks FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "a2a_tasks_caller" ON a2a_tasks;
CREATE POLICY "a2a_tasks_caller" ON a2a_tasks FOR ALL USING (caller_org_id = current_setting('app.org_id', true)) WITH CHECK (caller_org_id = current_setting('app.org_id', true));
DROP POLICY IF EXISTS "a2a_tasks_callee" ON a2a_tasks;
CREATE POLICY "a2a_tasks_callee" ON a2a_tasks FOR SELECT USING (callee_org_id = current_setting('app.org_id', true));

ALTER TABLE a2a_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE a2a_artifacts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "a2a_artifacts_service" ON a2a_artifacts;
CREATE POLICY "a2a_artifacts_service" ON a2a_artifacts FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "a2a_artifacts_sender" ON a2a_artifacts;
CREATE POLICY "a2a_artifacts_sender" ON a2a_artifacts FOR ALL USING (sender_org_id = current_setting('app.org_id', true)) WITH CHECK (sender_org_id = current_setting('app.org_id', true));
DROP POLICY IF EXISTS "a2a_artifacts_receiver" ON a2a_artifacts;
CREATE POLICY "a2a_artifacts_receiver" ON a2a_artifacts FOR SELECT USING (receiver_org_id = current_setting('app.org_id', true));

ALTER TABLE delegation_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE delegation_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "delegation_events_service" ON delegation_events;
CREATE POLICY "delegation_events_service" ON delegation_events FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "delegation_events_org" ON delegation_events;
CREATE POLICY "delegation_events_org" ON delegation_events FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

-- ---- Observability & Telemetry ----
ALTER TABLE otel_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE otel_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "otel_events_service" ON otel_events;
CREATE POLICY "otel_events_service" ON otel_events FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "otel_events_org" ON otel_events;
CREATE POLICY "otel_events_org" ON otel_events FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE runtime_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "runtime_events_service" ON runtime_events;
CREATE POLICY "runtime_events_service" ON runtime_events FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "runtime_events_org" ON runtime_events;
CREATE POLICY "runtime_events_org" ON runtime_events FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE span_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE span_feedback FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "span_feedback_service" ON span_feedback;
CREATE POLICY "span_feedback_service" ON span_feedback FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "span_feedback_org" ON span_feedback;
CREATE POLICY "span_feedback_org" ON span_feedback FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE trace_annotations ENABLE ROW LEVEL SECURITY;
ALTER TABLE trace_annotations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "trace_annotations_service" ON trace_annotations;
CREATE POLICY "trace_annotations_service" ON trace_annotations FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "trace_annotations_org" ON trace_annotations;
CREATE POLICY "trace_annotations_org" ON trace_annotations FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE trace_lineage ENABLE ROW LEVEL SECURITY;
ALTER TABLE trace_lineage FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "trace_lineage_service" ON trace_lineage;
CREATE POLICY "trace_lineage_service" ON trace_lineage FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE middleware_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE middleware_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "middleware_events_service" ON middleware_events;
CREATE POLICY "middleware_events_service" ON middleware_events FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "middleware_events_org" ON middleware_events;
CREATE POLICY "middleware_events_org" ON middleware_events FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE tool_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE tool_executions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tool_executions_service" ON tool_executions;
CREATE POLICY "tool_executions_service" ON tool_executions FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "tool_executions_org" ON tool_executions;
CREATE POLICY "tool_executions_org" ON tool_executions FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

-- ---- Scheduling, Jobs & Workflows ----
ALTER TABLE schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedules FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "schedules_service" ON schedules;
CREATE POLICY "schedules_service" ON schedules FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "schedules_org" ON schedules;
CREATE POLICY "schedules_org" ON schedules FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE job_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_queue FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "job_queue_service" ON job_queue;
CREATE POLICY "job_queue_service" ON job_queue FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "job_queue_org" ON job_queue;
CREATE POLICY "job_queue_org" ON job_queue FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE batch_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE batch_jobs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "batch_jobs_service" ON batch_jobs;
CREATE POLICY "batch_jobs_service" ON batch_jobs FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "batch_jobs_org" ON batch_jobs;
CREATE POLICY "batch_jobs_org" ON batch_jobs FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE batch_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE batch_tasks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "batch_tasks_service" ON batch_tasks;
CREATE POLICY "batch_tasks_service" ON batch_tasks FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE workflows ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflows FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "workflows_service" ON workflows;
CREATE POLICY "workflows_service" ON workflows FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "workflows_org" ON workflows;
CREATE POLICY "workflows_org" ON workflows FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE workflow_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "workflow_runs_service" ON workflow_runs;
CREATE POLICY "workflow_runs_service" ON workflow_runs FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "workflow_runs_org" ON workflow_runs;
CREATE POLICY "workflow_runs_org" ON workflow_runs FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE workflow_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_approvals FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "workflow_approvals_service" ON workflow_approvals;
CREATE POLICY "workflow_approvals_service" ON workflow_approvals FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "workflow_approvals_org" ON workflow_approvals;
CREATE POLICY "workflow_approvals_org" ON workflow_approvals FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

-- ---- Security, Compliance & Audit ----
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "audit_log_service" ON audit_log;
CREATE POLICY "audit_log_service" ON audit_log FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "audit_log_org" ON audit_log;
CREATE POLICY "audit_log_org" ON audit_log FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE auth_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_audit_log FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "auth_audit_log_service" ON auth_audit_log;
CREATE POLICY "auth_audit_log_service" ON auth_audit_log FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE security_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE security_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "security_events_service" ON security_events;
CREATE POLICY "security_events_service" ON security_events FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "security_events_org" ON security_events;
CREATE POLICY "security_events_org" ON security_events FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE security_scans ENABLE ROW LEVEL SECURITY;
ALTER TABLE security_scans FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "security_scans_service" ON security_scans;
CREATE POLICY "security_scans_service" ON security_scans FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "security_scans_org" ON security_scans;
CREATE POLICY "security_scans_org" ON security_scans FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE security_findings ENABLE ROW LEVEL SECURITY;
ALTER TABLE security_findings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "security_findings_service" ON security_findings;
CREATE POLICY "security_findings_service" ON security_findings FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "security_findings_org" ON security_findings;
CREATE POLICY "security_findings_org" ON security_findings FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE compliance_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE compliance_checks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "compliance_checks_service" ON compliance_checks;
CREATE POLICY "compliance_checks_service" ON compliance_checks FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "compliance_checks_org" ON compliance_checks;
CREATE POLICY "compliance_checks_org" ON compliance_checks FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE secrets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "secrets_service" ON secrets;
CREATE POLICY "secrets_service" ON secrets FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "secrets_org" ON secrets;
CREATE POLICY "secrets_org" ON secrets FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE secrets_key_rotations ENABLE ROW LEVEL SECURITY;
ALTER TABLE secrets_key_rotations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "secrets_key_rotations_service" ON secrets_key_rotations;
CREATE POLICY "secrets_key_rotations_service" ON secrets_key_rotations FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE account_deletion_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_deletion_requests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "account_deletion_requests_service" ON account_deletion_requests;
CREATE POLICY "account_deletion_requests_service" ON account_deletion_requests FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "account_deletion_requests_org" ON account_deletion_requests;
CREATE POLICY "account_deletion_requests_org" ON account_deletion_requests FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE data_export_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_export_requests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "data_export_requests_service" ON data_export_requests;
CREATE POLICY "data_export_requests_service" ON data_export_requests FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "data_export_requests_org" ON data_export_requests;
CREATE POLICY "data_export_requests_org" ON data_export_requests FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE api_access_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_access_log FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "api_access_log_service" ON api_access_log;
CREATE POLICY "api_access_log_service" ON api_access_log FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "api_access_log_org" ON api_access_log;
CREATE POLICY "api_access_log_org" ON api_access_log FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE idempotency_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_cache FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "idempotency_cache_service" ON idempotency_cache;
CREATE POLICY "idempotency_cache_service" ON idempotency_cache FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ---- Agent Intelligence & Memory ----
ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_profiles FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "user_profiles_service" ON user_profiles;
CREATE POLICY "user_profiles_service" ON user_profiles FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "user_profiles_org" ON user_profiles;
CREATE POLICY "user_profiles_org" ON user_profiles FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE memory_facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_facts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "memory_facts_service" ON memory_facts;
CREATE POLICY "memory_facts_service" ON memory_facts FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "memory_facts_org" ON memory_facts;
CREATE POLICY "memory_facts_org" ON memory_facts FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE semantic_facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE semantic_facts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "semantic_facts_service" ON semantic_facts;
CREATE POLICY "semantic_facts_service" ON semantic_facts FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "semantic_facts_org" ON semantic_facts;
CREATE POLICY "semantic_facts_org" ON semantic_facts FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE episodic_memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE episodic_memories FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "episodic_memories_service" ON episodic_memories;
CREATE POLICY "episodic_memories_service" ON episodic_memories FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "episodic_memories_org" ON episodic_memories;
CREATE POLICY "episodic_memories_org" ON episodic_memories FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE episodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE episodes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "episodes_service" ON episodes;
CREATE POLICY "episodes_service" ON episodes FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "episodes_org" ON episodes;
CREATE POLICY "episodes_org" ON episodes FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE facts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "facts_service" ON facts;
CREATE POLICY "facts_service" ON facts FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "facts_org" ON facts;
CREATE POLICY "facts_org" ON facts FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE procedures ENABLE ROW LEVEL SECURITY;
ALTER TABLE procedures FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "procedures_service" ON procedures;
CREATE POLICY "procedures_service" ON procedures FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "procedures_org" ON procedures;
CREATE POLICY "procedures_org" ON procedures FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE agent_procedures ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_procedures FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "agent_procedures_service" ON agent_procedures;
CREATE POLICY "agent_procedures_service" ON agent_procedures FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "agent_procedures_org" ON agent_procedures;
CREATE POLICY "agent_procedures_org" ON agent_procedures FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE agent_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_policies FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "agent_policies_service" ON agent_policies;
CREATE POLICY "agent_policies_service" ON agent_policies FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "agent_policies_org" ON agent_policies;
CREATE POLICY "agent_policies_org" ON agent_policies FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE team_facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_facts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "team_facts_service" ON team_facts;
CREATE POLICY "team_facts_service" ON team_facts FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "team_facts_org" ON team_facts;
CREATE POLICY "team_facts_org" ON team_facts FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE team_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_observations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "team_observations_service" ON team_observations;
CREATE POLICY "team_observations_service" ON team_observations FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "team_observations_org" ON team_observations;
CREATE POLICY "team_observations_org" ON team_observations FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

-- ---- Skills, Connectors & Tools ----
ALTER TABLE skills ENABLE ROW LEVEL SECURITY;
ALTER TABLE skills FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "skills_service" ON skills;
CREATE POLICY "skills_service" ON skills FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "skills_org" ON skills;
CREATE POLICY "skills_org" ON skills FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE tool_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE tool_registry FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tool_registry_service" ON tool_registry;
CREATE POLICY "tool_registry_service" ON tool_registry FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "tool_registry_org" ON tool_registry;
CREATE POLICY "tool_registry_org" ON tool_registry FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE connector_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE connector_tokens FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "connector_tokens_service" ON connector_tokens;
CREATE POLICY "connector_tokens_service" ON connector_tokens FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "connector_tokens_org" ON connector_tokens;
CREATE POLICY "connector_tokens_org" ON connector_tokens FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE connector_tools ENABLE ROW LEVEL SECURITY;
ALTER TABLE connector_tools FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "connector_tools_service" ON connector_tools;
CREATE POLICY "connector_tools_service" ON connector_tools FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE mcp_servers ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_servers FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "mcp_servers_service" ON mcp_servers;
CREATE POLICY "mcp_servers_service" ON mcp_servers FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "mcp_servers_org" ON mcp_servers;
CREATE POLICY "mcp_servers_org" ON mcp_servers FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE codemode_snippets ENABLE ROW LEVEL SECURITY;
ALTER TABLE codemode_snippets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "codemode_snippets_service" ON codemode_snippets;
CREATE POLICY "codemode_snippets_service" ON codemode_snippets FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "codemode_snippets_org" ON codemode_snippets;
CREATE POLICY "codemode_snippets_org" ON codemode_snippets FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

-- ---- Channels & Voice ----
ALTER TABLE channel_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_configs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "channel_configs_service" ON channel_configs;
CREATE POLICY "channel_configs_service" ON channel_configs FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "channel_configs_org" ON channel_configs;
CREATE POLICY "channel_configs_org" ON channel_configs FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE autopilot_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE autopilot_sessions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "autopilot_sessions_service" ON autopilot_sessions;
CREATE POLICY "autopilot_sessions_service" ON autopilot_sessions FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "autopilot_sessions_org" ON autopilot_sessions;
CREATE POLICY "autopilot_sessions_org" ON autopilot_sessions FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE voice_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE voice_calls FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "voice_calls_service" ON voice_calls;
CREATE POLICY "voice_calls_service" ON voice_calls FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "voice_calls_org" ON voice_calls;
CREATE POLICY "voice_calls_org" ON voice_calls FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE voice_numbers ENABLE ROW LEVEL SECURITY;
ALTER TABLE voice_numbers FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "voice_numbers_service" ON voice_numbers;
CREATE POLICY "voice_numbers_service" ON voice_numbers FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "voice_numbers_org" ON voice_numbers;
CREATE POLICY "voice_numbers_org" ON voice_numbers FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

-- ---- Evolution & Governance ----
ALTER TABLE evolution_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE evolution_proposals FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "evolution_proposals_service" ON evolution_proposals;
CREATE POLICY "evolution_proposals_service" ON evolution_proposals FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "evolution_proposals_org" ON evolution_proposals;
CREATE POLICY "evolution_proposals_org" ON evolution_proposals FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE evolution_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE evolution_ledger FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "evolution_ledger_service" ON evolution_ledger;
CREATE POLICY "evolution_ledger_service" ON evolution_ledger FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "evolution_ledger_org" ON evolution_ledger;
CREATE POLICY "evolution_ledger_org" ON evolution_ledger FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE evolution_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE evolution_reports FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "evolution_reports_service" ON evolution_reports;
CREATE POLICY "evolution_reports_service" ON evolution_reports FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "evolution_reports_org" ON evolution_reports;
CREATE POLICY "evolution_reports_org" ON evolution_reports FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE evolution_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE evolution_schedules FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "evolution_schedules_service" ON evolution_schedules;
CREATE POLICY "evolution_schedules_service" ON evolution_schedules FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "evolution_schedules_org" ON evolution_schedules;
CREATE POLICY "evolution_schedules_org" ON evolution_schedules FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE guardrail_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE guardrail_policies FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "guardrail_policies_service" ON guardrail_policies;
CREATE POLICY "guardrail_policies_service" ON guardrail_policies FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "guardrail_policies_org" ON guardrail_policies;
CREATE POLICY "guardrail_policies_org" ON guardrail_policies FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE guardrail_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE guardrail_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "guardrail_events_service" ON guardrail_events;
CREATE POLICY "guardrail_events_service" ON guardrail_events FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "guardrail_events_org" ON guardrail_events;
CREATE POLICY "guardrail_events_org" ON guardrail_events FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE policy_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE policy_templates FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "policy_templates_service" ON policy_templates;
CREATE POLICY "policy_templates_service" ON policy_templates FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE risk_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE risk_profiles FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "risk_profiles_service" ON risk_profiles;
CREATE POLICY "risk_profiles_service" ON risk_profiles FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "risk_profiles_org" ON risk_profiles;
CREATE POLICY "risk_profiles_org" ON risk_profiles FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

-- ---- DLP & Classification ----
ALTER TABLE dlp_classifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE dlp_classifications FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "dlp_classifications_service" ON dlp_classifications;
CREATE POLICY "dlp_classifications_service" ON dlp_classifications FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "dlp_classifications_org" ON dlp_classifications;
CREATE POLICY "dlp_classifications_org" ON dlp_classifications FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE dlp_agent_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE dlp_agent_policies FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "dlp_agent_policies_service" ON dlp_agent_policies;
CREATE POLICY "dlp_agent_policies_service" ON dlp_agent_policies FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "dlp_agent_policies_org" ON dlp_agent_policies;
CREATE POLICY "dlp_agent_policies_org" ON dlp_agent_policies FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

-- ---- SLO & Monitoring ----
ALTER TABLE slo_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE slo_definitions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "slo_definitions_service" ON slo_definitions;
CREATE POLICY "slo_definitions_service" ON slo_definitions FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "slo_definitions_org" ON slo_definitions;
CREATE POLICY "slo_definitions_org" ON slo_definitions FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE slo_evaluations ENABLE ROW LEVEL SECURITY;
ALTER TABLE slo_evaluations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "slo_evaluations_service" ON slo_evaluations;
CREATE POLICY "slo_evaluations_service" ON slo_evaluations FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "slo_evaluations_org" ON slo_evaluations;
CREATE POLICY "slo_evaluations_org" ON slo_evaluations FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE slo_error_budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE slo_error_budgets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "slo_error_budgets_service" ON slo_error_budgets;
CREATE POLICY "slo_error_budgets_service" ON slo_error_budgets FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "slo_error_budgets_org" ON slo_error_budgets;
CREATE POLICY "slo_error_budgets_org" ON slo_error_budgets FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE alert_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE alert_configs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "alert_configs_service" ON alert_configs;
CREATE POLICY "alert_configs_service" ON alert_configs FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "alert_configs_org" ON alert_configs;
CREATE POLICY "alert_configs_org" ON alert_configs FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE alert_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE alert_history FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "alert_history_service" ON alert_history;
CREATE POLICY "alert_history_service" ON alert_history FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "alert_history_org" ON alert_history;
CREATE POLICY "alert_history_org" ON alert_history FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

-- ---- Miscellaneous ----
ALTER TABLE custom_domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE custom_domains FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "custom_domains_service" ON custom_domains;
CREATE POLICY "custom_domains_service" ON custom_domains FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "custom_domains_org" ON custom_domains;
CREATE POLICY "custom_domains_org" ON custom_domains FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE webhooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhooks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "webhooks_service" ON webhooks;
CREATE POLICY "webhooks_service" ON webhooks FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "webhooks_org" ON webhooks;
CREATE POLICY "webhooks_org" ON webhooks FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_deliveries FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "webhook_deliveries_service" ON webhook_deliveries;
CREATE POLICY "webhook_deliveries_service" ON webhook_deliveries FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE github_webhook_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE github_webhook_subscriptions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "github_webhook_subscriptions_service" ON github_webhook_subscriptions;
CREATE POLICY "github_webhook_subscriptions_service" ON github_webhook_subscriptions FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "github_webhook_subscriptions_org" ON github_webhook_subscriptions;
CREATE POLICY "github_webhook_subscriptions_org" ON github_webhook_subscriptions FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE file_uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE file_uploads FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "file_uploads_service" ON file_uploads;
CREATE POLICY "file_uploads_service" ON file_uploads FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "file_uploads_org" ON file_uploads;
CREATE POLICY "file_uploads_org" ON file_uploads FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE end_user_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE end_user_tokens FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "end_user_tokens_service" ON end_user_tokens;
CREATE POLICY "end_user_tokens_service" ON end_user_tokens FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "end_user_tokens_org" ON end_user_tokens;
CREATE POLICY "end_user_tokens_org" ON end_user_tokens FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE end_user_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE end_user_usage FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "end_user_usage_service" ON end_user_usage;
CREATE POLICY "end_user_usage_service" ON end_user_usage FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "end_user_usage_org" ON end_user_usage;
CREATE POLICY "end_user_usage_org" ON end_user_usage FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE environments ENABLE ROW LEVEL SECURITY;
ALTER TABLE environments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "environments_service" ON environments;
CREATE POLICY "environments_service" ON environments FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "environments_org" ON environments;
CREATE POLICY "environments_org" ON environments FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE project_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_configs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "project_configs_service" ON project_configs;
CREATE POLICY "project_configs_service" ON project_configs FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "project_configs_org" ON project_configs;
CREATE POLICY "project_configs_org" ON project_configs FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE user_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_feedback FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "user_feedback_service" ON user_feedback;
CREATE POLICY "user_feedback_service" ON user_feedback FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "user_feedback_org" ON user_feedback;
CREATE POLICY "user_feedback_org" ON user_feedback FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE issues ENABLE ROW LEVEL SECURITY;
ALTER TABLE issues FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "issues_service" ON issues;
CREATE POLICY "issues_service" ON issues FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "issues_org" ON issues;
CREATE POLICY "issues_org" ON issues FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE feed_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE feed_posts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "feed_posts_service" ON feed_posts;
CREATE POLICY "feed_posts_service" ON feed_posts FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "feed_posts_read" ON feed_posts;
CREATE POLICY "feed_posts_read" ON feed_posts FOR SELECT USING (is_active = true);
DROP POLICY IF EXISTS "feed_posts_write" ON feed_posts;
CREATE POLICY "feed_posts_write" ON feed_posts FOR INSERT WITH CHECK (org_id = current_setting('app.org_id', true));
DROP POLICY IF EXISTS "feed_posts_update" ON feed_posts;
CREATE POLICY "feed_posts_update" ON feed_posts FOR UPDATE USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));
DROP POLICY IF EXISTS "feed_posts_delete" ON feed_posts;
CREATE POLICY "feed_posts_delete" ON feed_posts FOR DELETE USING (org_id = current_setting('app.org_id', true));

ALTER TABLE network_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE network_stats FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "network_stats_service" ON network_stats;
CREATE POLICY "network_stats_service" ON network_stats FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE event_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_types FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "event_types_service" ON event_types;
CREATE POLICY "event_types_service" ON event_types FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE referrals ENABLE ROW LEVEL SECURITY;
ALTER TABLE referrals FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "referrals_service" ON referrals;
CREATE POLICY "referrals_service" ON referrals FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "referrals_org" ON referrals;
CREATE POLICY "referrals_org" ON referrals FOR ALL USING (referrer_org_id = current_setting('app.org_id', true)) WITH CHECK (referrer_org_id = current_setting('app.org_id', true));

ALTER TABLE referral_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE referral_codes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "referral_codes_service" ON referral_codes;
CREATE POLICY "referral_codes_service" ON referral_codes FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "referral_codes_org" ON referral_codes;
CREATE POLICY "referral_codes_org" ON referral_codes FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE referral_earnings ENABLE ROW LEVEL SECURITY;
ALTER TABLE referral_earnings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "referral_earnings_service" ON referral_earnings;
CREATE POLICY "referral_earnings_service" ON referral_earnings FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "referral_earnings_org" ON referral_earnings;
CREATE POLICY "referral_earnings_org" ON referral_earnings FOR ALL USING (earner_org_id = current_setting('app.org_id', true)) WITH CHECK (earner_org_id = current_setting('app.org_id', true));

ALTER TABLE meta_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE meta_proposals FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "meta_proposals_service" ON meta_proposals;
CREATE POLICY "meta_proposals_service" ON meta_proposals FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "meta_proposals_org" ON meta_proposals;
CREATE POLICY "meta_proposals_org" ON meta_proposals FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE canary_splits ENABLE ROW LEVEL SECURITY;
ALTER TABLE canary_splits FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "canary_splits_service" ON canary_splits;
CREATE POLICY "canary_splits_service" ON canary_splits FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "canary_splits_org" ON canary_splits;
CREATE POLICY "canary_splits_org" ON canary_splits FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE release_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE release_channels FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "release_channels_service" ON release_channels;
CREATE POLICY "release_channels_service" ON release_channels FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "release_channels_org" ON release_channels;
CREATE POLICY "release_channels_org" ON release_channels FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE retention_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE retention_policies FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "retention_policies_service" ON retention_policies;
CREATE POLICY "retention_policies_service" ON retention_policies FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "retention_policies_org" ON retention_policies;
CREATE POLICY "retention_policies_org" ON retention_policies FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE gold_images ENABLE ROW LEVEL SECURITY;
ALTER TABLE gold_images FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "gold_images_service" ON gold_images;
CREATE POLICY "gold_images_service" ON gold_images FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "gold_images_org" ON gold_images;
CREATE POLICY "gold_images_org" ON gold_images FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE gpu_endpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE gpu_endpoints FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "gpu_endpoints_service" ON gpu_endpoints;
CREATE POLICY "gpu_endpoints_service" ON gpu_endpoints FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "gpu_endpoints_org" ON gpu_endpoints;
CREATE POLICY "gpu_endpoints_org" ON gpu_endpoints FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE pipelines ENABLE ROW LEVEL SECURITY;
ALTER TABLE pipelines FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "pipelines_service" ON pipelines;
CREATE POLICY "pipelines_service" ON pipelines FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "pipelines_org" ON pipelines;
CREATE POLICY "pipelines_org" ON pipelines FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE components ENABLE ROW LEVEL SECURITY;
ALTER TABLE components FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "components_service" ON components;
CREATE POLICY "components_service" ON components FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "components_org" ON components;
CREATE POLICY "components_org" ON components FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE component_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE component_usage FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "component_usage_service" ON component_usage;
CREATE POLICY "component_usage_service" ON component_usage FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "component_usage_org" ON component_usage;
CREATE POLICY "component_usage_org" ON component_usage FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE subgraph_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE subgraph_definitions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "subgraph_definitions_service" ON subgraph_definitions;
CREATE POLICY "subgraph_definitions_service" ON subgraph_definitions FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "subgraph_definitions_org" ON subgraph_definitions;
CREATE POLICY "subgraph_definitions_org" ON subgraph_definitions FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE prompt_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE prompt_versions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "prompt_versions_service" ON prompt_versions;
CREATE POLICY "prompt_versions_service" ON prompt_versions FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE graph_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE graph_snapshots FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "graph_snapshots_service" ON graph_snapshots;
CREATE POLICY "graph_snapshots_service" ON graph_snapshots FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "graph_snapshots_org" ON graph_snapshots;
CREATE POLICY "graph_snapshots_org" ON graph_snapshots FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE node_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE node_checkpoints FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "node_checkpoints_service" ON node_checkpoints;
CREATE POLICY "node_checkpoints_service" ON node_checkpoints FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "node_checkpoints_org" ON node_checkpoints;
CREATE POLICY "node_checkpoints_org" ON node_checkpoints FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE langchain_tools ENABLE ROW LEVEL SECURITY;
ALTER TABLE langchain_tools FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "langchain_tools_service" ON langchain_tools;
CREATE POLICY "langchain_tools_service" ON langchain_tools FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "langchain_tools_org" ON langchain_tools;
CREATE POLICY "langchain_tools_org" ON langchain_tools FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE schema_validation_errors ENABLE ROW LEVEL SECURITY;
ALTER TABLE schema_validation_errors FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "schema_validation_errors_service" ON schema_validation_errors;
CREATE POLICY "schema_validation_errors_service" ON schema_validation_errors FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "schema_validation_errors_org" ON schema_validation_errors;
CREATE POLICY "schema_validation_errors_org" ON schema_validation_errors FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE codemode_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE codemode_executions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "codemode_executions_service" ON codemode_executions;
CREATE POLICY "codemode_executions_service" ON codemode_executions FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "codemode_executions_org" ON codemode_executions;
CREATE POLICY "codemode_executions_org" ON codemode_executions FOR ALL USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));

-- ============================================================================
-- SECTION 21: Triggers (updated_at)
-- ============================================================================

DROP TRIGGER IF EXISTS set_updated_at_orgs ON orgs;
CREATE TRIGGER set_updated_at_orgs BEFORE UPDATE ON orgs FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS set_updated_at_users ON users;
CREATE TRIGGER set_updated_at_users BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS set_updated_at_projects ON projects;
CREATE TRIGGER set_updated_at_projects BEFORE UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS set_updated_at_agents ON agents;
CREATE TRIGGER set_updated_at_agents BEFORE UPDATE ON agents FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS set_updated_at_api_keys ON api_keys;
CREATE TRIGGER set_updated_at_api_keys BEFORE UPDATE ON api_keys FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS set_updated_at_org_members ON org_members;
CREATE TRIGGER set_updated_at_org_members BEFORE UPDATE ON org_members FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS set_updated_at_org_settings ON org_settings;
CREATE TRIGGER set_updated_at_org_settings BEFORE UPDATE ON org_settings FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS set_updated_at_sessions ON sessions;
CREATE TRIGGER set_updated_at_sessions BEFORE UPDATE ON sessions FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS set_updated_at_conversations ON conversations;
CREATE TRIGGER set_updated_at_conversations BEFORE UPDATE ON conversations FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS set_updated_at_org_credit_balance ON org_credit_balance;
CREATE TRIGGER set_updated_at_org_credit_balance BEFORE UPDATE ON org_credit_balance FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS set_updated_at_training_jobs ON training_jobs;
CREATE TRIGGER set_updated_at_training_jobs BEFORE UPDATE ON training_jobs FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS set_updated_at_marketplace_listings ON marketplace_listings;
CREATE TRIGGER set_updated_at_marketplace_listings BEFORE UPDATE ON marketplace_listings FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS set_updated_at_a2a_agents ON a2a_agents;
CREATE TRIGGER set_updated_at_a2a_agents BEFORE UPDATE ON a2a_agents FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS set_updated_at_schedules ON schedules;
CREATE TRIGGER set_updated_at_schedules BEFORE UPDATE ON schedules FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS set_updated_at_job_queue ON job_queue;
CREATE TRIGGER set_updated_at_job_queue BEFORE UPDATE ON job_queue FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS set_updated_at_batch_jobs ON batch_jobs;
CREATE TRIGGER set_updated_at_batch_jobs BEFORE UPDATE ON batch_jobs FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS set_updated_at_workflows ON workflows;
CREATE TRIGGER set_updated_at_workflows BEFORE UPDATE ON workflows FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS set_updated_at_secrets ON secrets;
CREATE TRIGGER set_updated_at_secrets BEFORE UPDATE ON secrets FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS set_updated_at_user_profiles ON user_profiles;
CREATE TRIGGER set_updated_at_user_profiles BEFORE UPDATE ON user_profiles FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS set_updated_at_semantic_facts ON semantic_facts;
CREATE TRIGGER set_updated_at_semantic_facts BEFORE UPDATE ON semantic_facts FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS set_updated_at_procedures ON procedures;
CREATE TRIGGER set_updated_at_procedures BEFORE UPDATE ON procedures FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS set_updated_at_skills ON skills;
CREATE TRIGGER set_updated_at_skills BEFORE UPDATE ON skills FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS set_updated_at_connector_tokens ON connector_tokens;
CREATE TRIGGER set_updated_at_connector_tokens BEFORE UPDATE ON connector_tokens FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS set_updated_at_mcp_servers ON mcp_servers;
CREATE TRIGGER set_updated_at_mcp_servers BEFORE UPDATE ON mcp_servers FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS set_updated_at_codemode_snippets ON codemode_snippets;
CREATE TRIGGER set_updated_at_codemode_snippets BEFORE UPDATE ON codemode_snippets FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS set_updated_at_channel_configs ON channel_configs;
CREATE TRIGGER set_updated_at_channel_configs BEFORE UPDATE ON channel_configs FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS set_updated_at_autopilot_sessions ON autopilot_sessions;
CREATE TRIGGER set_updated_at_autopilot_sessions BEFORE UPDATE ON autopilot_sessions FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS set_updated_at_risk_profiles ON risk_profiles;
CREATE TRIGGER set_updated_at_risk_profiles BEFORE UPDATE ON risk_profiles FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS set_updated_at_custom_domains ON custom_domains;
CREATE TRIGGER set_updated_at_custom_domains BEFORE UPDATE ON custom_domains FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS set_updated_at_webhooks ON webhooks;
CREATE TRIGGER set_updated_at_webhooks BEFORE UPDATE ON webhooks FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS set_updated_at_project_configs ON project_configs;
CREATE TRIGGER set_updated_at_project_configs BEFORE UPDATE ON project_configs FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS set_updated_at_issues ON issues;
CREATE TRIGGER set_updated_at_issues BEFORE UPDATE ON issues FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS set_updated_at_gpu_endpoints ON gpu_endpoints;
CREATE TRIGGER set_updated_at_gpu_endpoints BEFORE UPDATE ON gpu_endpoints FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS set_updated_at_pipelines ON pipelines;
CREATE TRIGGER set_updated_at_pipelines BEFORE UPDATE ON pipelines FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS set_updated_at_components ON components;
CREATE TRIGGER set_updated_at_components BEFORE UPDATE ON components FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS set_updated_at_subgraph_definitions ON subgraph_definitions;
CREATE TRIGGER set_updated_at_subgraph_definitions BEFORE UPDATE ON subgraph_definitions FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS set_updated_at_prompt_versions ON prompt_versions;
CREATE TRIGGER set_updated_at_prompt_versions BEFORE UPDATE ON prompt_versions FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- SECTION 22: Views
-- ============================================================================

CREATE OR REPLACE VIEW a2a_revenue_summary AS
SELECT
  t.callee_org_id AS org_id,
  t.callee_agent_name AS agent_name,
  COUNT(*) AS total_tasks,
  SUM(t.amount_usd) AS total_revenue_usd,
  SUM(t.cost_usd) AS total_cost_usd,
  SUM(t.amount_usd) - SUM(t.cost_usd) AS net_revenue_usd,
  DATE_TRUNC('month', t.created_at) AS month
FROM a2a_tasks t
WHERE t.status = 'completed'
GROUP BY t.callee_org_id, t.callee_agent_name, DATE_TRUNC('month', t.created_at);

CREATE OR REPLACE VIEW referral_summary AS
SELECT
  r.referrer_org_id,
  r.referral_code,
  COUNT(DISTINCT r.referred_org_id) AS total_referrals,
  COALESCE(SUM(e.amount_usd), 0) AS total_earnings_usd
FROM referrals r
LEFT JOIN referral_earnings e ON e.referral_id = r.id
GROUP BY r.referrer_org_id, r.referral_code;

-- ============================================================================
-- SECTION 23: Seed Data
-- ============================================================================

INSERT INTO credit_packages (name, credits_usd, price_usd, stripe_price_id, is_active)
VALUES
  ('Starter', 5.00, 5.00, NULL, true),
  ('Growth', 25.00, 25.00, NULL, true),
  ('Scale', 100.00, 100.00, NULL, true)
ON CONFLICT DO NOTHING;

INSERT INTO network_stats (total_agents, total_sessions, total_marketplace_listings)
VALUES (0, 0, 0)
ON CONFLICT DO NOTHING;

-- ============================================================================
-- SECTION 24: Revoke anon access
-- ============================================================================

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
