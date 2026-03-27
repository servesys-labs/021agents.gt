-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 007: Enterprise consumption layer
-- File uploads, idempotency, end-user tokens, IP allowlists, API audit log,
-- batch jobs, per-user usage tracking
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Idempotency cache ────────────────────────────────────────────────────
-- Prevents duplicate agent runs on network retries (keyed by client-provided key)
CREATE TABLE IF NOT EXISTS idempotency_cache (
  idempotency_key text PRIMARY KEY,
  org_id text NOT NULL,
  response_body jsonb NOT NULL,
  status_code int NOT NULL DEFAULT 200,
  created_at timestamptz DEFAULT now(),
  expires_at timestamptz DEFAULT (now() + interval '24 hours')
);

CREATE INDEX IF NOT EXISTS idx_idempotency_expires ON idempotency_cache(expires_at);

-- ── File uploads (public API attachments) ────────────────────────────────
CREATE TABLE IF NOT EXISTS file_uploads (
  file_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  agent_name text DEFAULT '',
  original_name text NOT NULL,
  content_type text NOT NULL,
  size_bytes bigint NOT NULL,
  r2_key text NOT NULL,                 -- R2 object key
  r2_url text DEFAULT '',               -- presigned or public URL
  uploaded_by text DEFAULT '',           -- user_id or end_user_id
  metadata jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_file_uploads_org ON file_uploads(org_id, created_at DESC);

-- ── End-user session tokens ──────────────────────────────────────────────
-- SaaS customers mint short-lived tokens for their end-users
CREATE TABLE IF NOT EXISTS end_user_tokens (
  token_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  api_key_id text NOT NULL,             -- parent API key that minted this
  end_user_id text NOT NULL,            -- customer's end-user identifier
  allowed_agents text[] DEFAULT '{}',   -- restrict to specific agents
  scopes text[] DEFAULT '{"agents:run"}',
  rate_limit_rpm int DEFAULT 20,
  rate_limit_rpd int DEFAULT 1000,
  expires_at timestamptz NOT NULL,
  revoked boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_end_user_tokens_org ON end_user_tokens(org_id);
CREATE INDEX IF NOT EXISTS idx_end_user_tokens_user ON end_user_tokens(org_id, end_user_id);
CREATE INDEX IF NOT EXISTS idx_end_user_tokens_expires ON end_user_tokens(expires_at);

-- ── IP allowlists per API key ────────────────────────────────────────────
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS ip_allowlist text[] DEFAULT '{}';
-- Empty array = allow all IPs. Non-empty = only allow listed CIDRs.

-- ── API access audit log ─────────────────────────────────────────────────
-- Every public API call is logged here (fire-and-forget)
CREATE TABLE IF NOT EXISTS api_access_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id text NOT NULL,
  api_key_id text DEFAULT '',
  end_user_id text DEFAULT '',
  method text NOT NULL,
  path text NOT NULL,
  agent_name text DEFAULT '',
  status_code int DEFAULT 200,
  latency_ms int DEFAULT 0,
  ip_address text DEFAULT '',
  user_agent text DEFAULT '',
  idempotency_key text DEFAULT '',
  request_id text DEFAULT '',
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_api_access_log_org ON api_access_log(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_api_access_log_key ON api_access_log(api_key_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_api_access_log_user ON api_access_log(end_user_id, created_at DESC);

-- Partition by month for efficient cleanup (optional, applied manually)
-- CREATE TABLE api_access_log_2026_03 PARTITION OF api_access_log
--   FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');

-- ── Per-end-user usage tracking ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS end_user_usage (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id text NOT NULL,
  end_user_id text NOT NULL,
  agent_name text NOT NULL,
  session_id text DEFAULT '',
  input_tokens int DEFAULT 0,
  output_tokens int DEFAULT 0,
  cost_usd numeric(10,6) DEFAULT 0,
  latency_ms int DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_end_user_usage_org ON end_user_usage(org_id, end_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_end_user_usage_agent ON end_user_usage(org_id, agent_name, created_at DESC);

-- ── Batch jobs ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS batch_jobs (
  batch_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  agent_name text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
  total_tasks int NOT NULL DEFAULT 0,
  completed_tasks int DEFAULT 0,
  failed_tasks int DEFAULT 0,
  callback_url text DEFAULT '',
  callback_secret text DEFAULT '',
  metadata_json jsonb DEFAULT '{}',
  error text DEFAULT '',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_batch_jobs_org ON batch_jobs(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_batch_jobs_status ON batch_jobs(org_id, status);

CREATE TABLE IF NOT EXISTS batch_tasks (
  task_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES batch_jobs(batch_id) ON DELETE CASCADE,
  org_id text NOT NULL,
  task_index int NOT NULL,
  input text NOT NULL,
  file_ids_json jsonb DEFAULT '[]',
  system_prompt text DEFAULT '',
  response_format text DEFAULT '',
  response_schema jsonb,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
  result_json jsonb,
  output text DEFAULT '',
  session_id text DEFAULT '',
  cost_usd numeric(10,6) DEFAULT 0,
  latency_ms int DEFAULT 0,
  error text DEFAULT '',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_batch_tasks_batch ON batch_tasks(batch_id, task_index);
CREATE INDEX IF NOT EXISTS idx_batch_tasks_org ON batch_tasks(org_id);
