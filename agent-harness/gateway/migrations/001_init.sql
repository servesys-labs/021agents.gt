-- ============================================================================
-- Agent Harness — Lean Postgres Schema
--
-- Design principles:
--   1. Postgres owns CROSS-AGENT data (auth, billing, marketplace, evals)
--   2. DO SQLite owns PER-AGENT data (messages, workspace, context blocks)
--   3. Queue bridges DO → Postgres (session summaries, billing events)
--   4. R2 is cold storage (archived conversations, workspace snapshots)
--   5. KV is cache, Analytics Engine is telemetry, Vectorize is semantic search
--
-- DO topology: one DO per user-agent pair (org-agent-user)
--   - Conversations rotate inside the DO (active → compacted → R2 archive)
--   - Postgres has conversation HEADERS (index), not messages
--   - Messages stay in DO SQLite; R2 holds archived conversation JSON
--
-- ~25 tables. Previous schema had 130+. Every table here earns its keep.
-- ============================================================================

-- ============================================================================
-- SECTION 1: Identity & Auth
-- ============================================================================

CREATE TABLE IF NOT EXISTS orgs (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name            TEXT NOT NULL DEFAULT '',
  slug            TEXT NOT NULL UNIQUE,
  owner_user_id   TEXT,
  plan            TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro', 'team', 'enterprise')),
  stripe_customer_id TEXT,
  settings        JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id          TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  email           TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL DEFAULT '',
  password_hash   TEXT,
  provider        TEXT NOT NULL DEFAULT 'email' CHECK (provider IN ('email', 'google', 'github')),
  avatar_url      TEXT,
  email_verified  BOOLEAN NOT NULL DEFAULT false,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS org_members (
  org_id    TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role      TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (org_id, user_id)
);

CREATE TABLE IF NOT EXISTS api_keys (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id      TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
  name        TEXT NOT NULL DEFAULT '',
  key_hash    TEXT NOT NULL UNIQUE,
  prefix      TEXT NOT NULL,
  scopes      JSONB NOT NULL DEFAULT '["agent:read", "agent:write"]',
  revoked_at  TIMESTAMPTZ,
  expires_at  TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  token       TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '1 hour'),
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS email_verification_tokens (
  token       TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- SECTION 2: Agent Management
-- ============================================================================

CREATE TABLE IF NOT EXISTS agents (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id      TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  config      JSONB NOT NULL DEFAULT '{}',
  -- Config includes: model, systemPrompt, enableSandbox, skills, budgetUsd,
  -- allowedTools, deniedTools, hooks (preToolUse, postToolUse, onError)
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, name)
);

CREATE TABLE IF NOT EXISTS agent_versions (
  id          BIGSERIAL PRIMARY KEY,
  agent_id    TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  version     INT NOT NULL DEFAULT 1,
  config      JSONB NOT NULL DEFAULT '{}',
  created_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (agent_id, version)
);

-- ============================================================================
-- SECTION 3: Conversations (HEADERS ONLY — messages stay in DO SQLite)
--
-- Written by Queue consumer from DO events. This is the INDEX for
-- listing/searching conversations. Full message replay comes from the DO.
-- Archived conversations have r2_archive_key pointing to cold storage.
-- ============================================================================

CREATE TABLE IF NOT EXISTS conversations (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id          TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id         TEXT REFERENCES users(id) ON DELETE SET NULL,
  agent_name      TEXT NOT NULL,
  channel         TEXT NOT NULL DEFAULT 'portal',
  title           TEXT NOT NULL DEFAULT 'New conversation',
  message_count   INT NOT NULL DEFAULT 0,
  total_cost_usd  NUMERIC(12,6) NOT NULL DEFAULT 0,
  is_deleted      BOOLEAN NOT NULL DEFAULT false,
  -- Archival lifecycle: NULL = active in DO, set = archived to R2
  archived_at     TIMESTAMPTZ,
  r2_archive_key  TEXT,
  last_message_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_conversations_org_agent ON conversations(org_id, agent_name, created_at DESC)
  WHERE is_deleted = false;
CREATE INDEX idx_conversations_user ON conversations(user_id, created_at DESC)
  WHERE is_deleted = false;

-- Session summaries — one row per agent session (turn-level, not message-level)
-- Written by Queue consumer from DO telemetry events
CREATE TABLE IF NOT EXISTS sessions (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id          TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  agent_name      TEXT NOT NULL,
  user_id         TEXT REFERENCES users(id) ON DELETE SET NULL,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  model           TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
  turn_count      INT NOT NULL DEFAULT 0,
  tool_call_count INT NOT NULL DEFAULT 0,
  input_tokens    BIGINT NOT NULL DEFAULT 0,
  output_tokens   BIGINT NOT NULL DEFAULT 0,
  cost_usd        NUMERIC(12,6) NOT NULL DEFAULT 0,
  duration_ms     INT NOT NULL DEFAULT 0,
  error           TEXT,
  metadata        JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ
);

CREATE INDEX idx_sessions_org ON sessions(org_id, created_at DESC);
CREATE INDEX idx_sessions_agent ON sessions(org_id, agent_name, created_at DESC);

-- ============================================================================
-- SECTION 4: Billing & Credits
-- ============================================================================

CREATE TABLE IF NOT EXISTS credit_packages (
  id              BIGSERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  credits_usd     NUMERIC(12,6) NOT NULL,
  price_usd       NUMERIC(12,6) NOT NULL,
  stripe_price_id TEXT,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS credit_transactions (
  id              BIGSERIAL PRIMARY KEY,
  org_id          TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  type            TEXT NOT NULL CHECK (type IN ('purchase', 'burn', 'refund', 'adjustment', 'bonus')),
  amount_usd      NUMERIC(12,6) NOT NULL,
  balance_after   NUMERIC(12,6) NOT NULL DEFAULT 0,
  description     TEXT NOT NULL DEFAULT '',
  agent_name      TEXT,
  session_id      TEXT,
  stripe_payment_intent_id TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_credit_tx_org ON credit_transactions(org_id, created_at DESC);

-- Idempotency for Stripe webhooks
CREATE TABLE IF NOT EXISTS stripe_events_processed (
  event_id      TEXT PRIMARY KEY,
  event_type    TEXT NOT NULL,
  processed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- SECTION 5: Evaluations & Training
-- ============================================================================

CREATE TABLE IF NOT EXISTS eval_test_cases (
  id          BIGSERIAL PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  agent_name  TEXT NOT NULL,
  name        TEXT NOT NULL DEFAULT '',
  input       TEXT NOT NULL,
  expected    TEXT,
  rubric      JSONB NOT NULL DEFAULT '{}',
  tags        JSONB NOT NULL DEFAULT '[]',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS eval_runs (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id      TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  agent_name  TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  config      JSONB NOT NULL DEFAULT '{}',
  summary     JSONB NOT NULL DEFAULT '{}',
  -- summary: { pass_rate, avg_score, total_cost, duration_ms }
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS eval_trials (
  id          BIGSERIAL PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES eval_runs(id) ON DELETE CASCADE,
  test_case_id BIGINT REFERENCES eval_test_cases(id) ON DELETE SET NULL,
  input       TEXT NOT NULL,
  output      TEXT NOT NULL DEFAULT '',
  expected    TEXT,
  score       NUMERIC(5,3),
  passed      BOOLEAN,
  cost_usd    NUMERIC(12,6) NOT NULL DEFAULT 0,
  duration_ms INT NOT NULL DEFAULT 0,
  metadata    JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS training_jobs (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id      TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  agent_name  TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  config      JSONB NOT NULL DEFAULT '{}',
  -- config: { strategy, iterations, learning_rate, dataset_id }
  result      JSONB NOT NULL DEFAULT '{}',
  -- result: { best_score, iterations_completed, cost_usd }
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

-- ============================================================================
-- SECTION 6: Marketplace
-- ============================================================================

CREATE TABLE IF NOT EXISTS marketplace_listings (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id        TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  agent_name    TEXT NOT NULL,
  title         TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  category      TEXT NOT NULL DEFAULT 'general',
  price_usd     NUMERIC(12,6) NOT NULL DEFAULT 0,
  is_free       BOOLEAN NOT NULL DEFAULT true,
  quality_score NUMERIC(5,3) NOT NULL DEFAULT 0,
  install_count INT NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'suspended')),
  config        JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_marketplace_category ON marketplace_listings(category, quality_score DESC)
  WHERE status = 'published';

CREATE TABLE IF NOT EXISTS marketplace_ratings (
  id          BIGSERIAL PRIMARY KEY,
  listing_id  TEXT NOT NULL REFERENCES marketplace_listings(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  score       INT NOT NULL CHECK (score BETWEEN 1 AND 5),
  review      TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (listing_id, user_id)
);

-- ============================================================================
-- SECTION 7: Governance & Skills
-- ============================================================================

CREATE TABLE IF NOT EXISTS guardrail_rules (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id      TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('input', 'output', 'tool', 'cost', 'rate')),
  config      JSONB NOT NULL DEFAULT '{}',
  -- config varies by type:
  --   input:  { blocked_patterns, max_length }
  --   output: { pii_redaction, content_filter }
  --   tool:   { denied_tools, arg_patterns }
  --   cost:   { max_cost_per_session, max_cost_per_day }
  --   rate:   { max_requests_per_minute, max_requests_per_day }
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS skills (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id      TEXT REFERENCES orgs(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  content     TEXT NOT NULL DEFAULT '',
  version     INT NOT NULL DEFAULT 1,
  is_builtin  BOOLEAN NOT NULL DEFAULT false,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, name)
);

CREATE TABLE IF NOT EXISTS tool_registry (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id      TEXT REFERENCES orgs(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  schema      JSONB NOT NULL DEFAULT '{}',
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, name)
);

-- ============================================================================
-- SECTION 8: Feature Flags & Platform Config
-- ============================================================================

CREATE TABLE IF NOT EXISTS feature_flags (
  id          BIGSERIAL PRIMARY KEY,
  org_id      TEXT REFERENCES orgs(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  enabled     BOOLEAN NOT NULL DEFAULT false,
  config      JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, name)
);

-- ============================================================================
-- SECTION 9: Audit & Security (append-only, written by Queue)
-- ============================================================================

-- Lightweight audit log — high-volume events go to Analytics Engine instead
-- This table is for security-sensitive actions only (auth, billing, config changes)
CREATE TABLE IF NOT EXISTS audit_log (
  id          BIGSERIAL PRIMARY KEY,
  org_id      TEXT NOT NULL,
  user_id     TEXT,
  action      TEXT NOT NULL,
  resource    TEXT NOT NULL DEFAULT '',
  detail      JSONB NOT NULL DEFAULT '{}',
  ip_address  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_org ON audit_log(org_id, created_at DESC);

-- ============================================================================
-- SEED DATA
-- ============================================================================

-- Default credit packages
INSERT INTO credit_packages (name, credits_usd, price_usd, stripe_price_id, is_active) VALUES
  ('Starter',    5.00,    5.00,  null, true),
  ('Builder',   25.00,   22.50,  null, true),
  ('Pro',      100.00,   85.00,  null, true),
  ('Team',     500.00,  400.00,  null, true)
ON CONFLICT DO NOTHING;
