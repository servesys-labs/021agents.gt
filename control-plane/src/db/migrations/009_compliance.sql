-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 009: Enterprise compliance features
-- Account deletion, session timeouts, SLO history, immutable audit,
-- security events, PII redaction, secrets rotation
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Account deletion requests (GDPR Art. 17) ────────────────────────────
CREATE TABLE IF NOT EXISTS account_deletion_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  org_id text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  requested_by text NOT NULL,           -- user_id of requester (self or admin)
  reason text DEFAULT '',
  tables_purged text[] DEFAULT '{}',    -- which tables were cleaned
  rows_deleted int DEFAULT 0,
  error text DEFAULT '',
  requested_at timestamptz DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_deletion_requests_org ON account_deletion_requests(org_id);
CREATE INDEX IF NOT EXISTS idx_deletion_requests_user ON account_deletion_requests(user_id);

-- ── Session activity tracking (for idle timeout) ────────────────────────
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_activity_at timestamptz;

-- Track last API activity per user for session timeout enforcement
CREATE TABLE IF NOT EXISTS user_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  org_id text NOT NULL,
  token_hash text NOT NULL,             -- SHA-256 of the JWT/API key
  last_activity_at timestamptz DEFAULT now(),
  ip_address text DEFAULT '',
  user_agent text DEFAULT '',
  expires_at timestamptz NOT NULL,
  revoked boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id, revoked);
CREATE INDEX IF NOT EXISTS idx_user_sessions_token ON user_sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_user_sessions_expires ON user_sessions(expires_at);

-- ── SLO evaluation history ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS slo_evaluations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id text NOT NULL,
  slo_id text NOT NULL,
  metric text NOT NULL,
  agent_name text DEFAULT '',
  threshold numeric NOT NULL,
  actual_value numeric NOT NULL,
  breached boolean NOT NULL,
  window_hours int DEFAULT 24,
  evaluated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_slo_evaluations_org ON slo_evaluations(org_id, evaluated_at DESC);
CREATE INDEX IF NOT EXISTS idx_slo_evaluations_slo ON slo_evaluations(slo_id, evaluated_at DESC);

-- Error budget tracking per SLO per month
CREATE TABLE IF NOT EXISTS slo_error_budgets (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id text NOT NULL,
  slo_id text NOT NULL,
  month text NOT NULL,                  -- '2026-03'
  total_evaluations int DEFAULT 0,
  breaches int DEFAULT 0,
  budget_remaining_pct numeric(5,2) DEFAULT 100.0,
  updated_at timestamptz DEFAULT now(),
  UNIQUE(org_id, slo_id, month)
);

-- ── Immutable audit log mode ────────────────────────────────────────────
-- When enabled, audit_log rows cannot be deleted (only retained per policy)
ALTER TABLE org_settings ADD COLUMN IF NOT EXISTS immutable_audit boolean DEFAULT false;
-- When true: DELETE FROM audit_log is blocked by application logic
-- Retention policies will archive to R2 before deletion

-- ── Security event types (enriched audit) ───────────────────────────────
CREATE TABLE IF NOT EXISTS security_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id text NOT NULL,
  event_type text NOT NULL
    CHECK (event_type IN (
      'login.success', 'login.failed', 'login.mfa_required', 'login.mfa_verified',
      'logout', 'session.expired', 'session.revoked',
      'api_key.created', 'api_key.revoked', 'api_key.rotated', 'api_key.expired',
      'user.invited', 'user.removed', 'user.role_changed',
      'account.deletion_requested', 'account.deletion_completed',
      'policy.created', 'policy.updated', 'policy.deleted',
      'guardrail.triggered', 'guardrail.blocked',
      'pii.detected', 'pii.redacted',
      'ip.blocked', 'rate_limit.exceeded',
      'webhook.delivery_failed', 'secrets.rotated',
      'mfa.enabled', 'mfa.disabled'
    )),
  actor_id text DEFAULT '',             -- who performed the action
  actor_type text DEFAULT 'user'        -- 'user', 'system', 'api_key', 'end_user'
    CHECK (actor_type IN ('user', 'system', 'api_key', 'end_user')),
  target_id text DEFAULT '',            -- what was acted upon
  target_type text DEFAULT '',          -- 'user', 'api_key', 'agent', 'policy', etc.
  ip_address text DEFAULT '',
  user_agent text DEFAULT '',
  details jsonb DEFAULT '{}',
  severity text DEFAULT 'info'
    CHECK (severity IN ('critical', 'high', 'medium', 'low', 'info')),
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_security_events_org ON security_events(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_security_events_type ON security_events(org_id, event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_security_events_actor ON security_events(actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_security_events_severity ON security_events(org_id, severity, created_at DESC);

-- ── PII redaction settings ──────────────────────────────────────────────
ALTER TABLE org_settings ADD COLUMN IF NOT EXISTS auto_redact_pii boolean DEFAULT false;
-- When true: conversations, session inputs/outputs are run through PII detector before storage

-- ── Secrets encryption key rotation tracking ────────────────────────────
CREATE TABLE IF NOT EXISTS secrets_key_rotations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL DEFAULT 'global',
  old_key_hash text NOT NULL,           -- SHA-256 of old key (for verification)
  new_key_hash text NOT NULL,           -- SHA-256 of new key
  secrets_re_encrypted int DEFAULT 0,
  status text DEFAULT 'pending'
    CHECK (status IN ('pending', 'in_progress', 'completed', 'failed')),
  initiated_by text DEFAULT '',
  error text DEFAULT '',
  started_at timestamptz DEFAULT now(),
  completed_at timestamptz
);

-- ── CF Zero Trust MFA state tracking ────────────────────────────────────
-- We rely on CF Access for MFA, but track enforcement state per org
ALTER TABLE org_settings ADD COLUMN IF NOT EXISTS mfa_required boolean DEFAULT false;
ALTER TABLE org_settings ADD COLUMN IF NOT EXISTS mfa_enforcement text DEFAULT 'optional'
  CHECK (mfa_enforcement IN ('optional', 'required_admins', 'required_all'));
-- 'optional': MFA not enforced (CF Access may still require it)
-- 'required_admins': admin/owner roles must pass CF Access MFA
-- 'required_all': all users must pass CF Access MFA

-- Track which users have completed MFA verification via CF Access
ALTER TABLE org_members ADD COLUMN IF NOT EXISTS mfa_verified boolean DEFAULT false;
ALTER TABLE org_members ADD COLUMN IF NOT EXISTS mfa_verified_at timestamptz;
ALTER TABLE org_members ADD COLUMN IF NOT EXISTS last_login_at timestamptz;
ALTER TABLE org_members ADD COLUMN IF NOT EXISTS last_login_ip text DEFAULT '';

-- ── Data export tracking (GDPR Art. 20) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS data_export_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  requested_by text NOT NULL,
  status text DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'expired')),
  format text DEFAULT 'json',
  r2_key text DEFAULT '',               -- where the export archive is stored
  download_url text DEFAULT '',
  size_bytes bigint DEFAULT 0,
  tables_included text[] DEFAULT '{}',
  expires_at timestamptz DEFAULT (now() + interval '7 days'),
  requested_at timestamptz DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_data_exports_org ON data_export_requests(org_id, requested_at DESC);
