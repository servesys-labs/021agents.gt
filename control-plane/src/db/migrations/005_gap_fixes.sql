-- 004_gap_fixes.sql
-- Adds settings_json, onboarding_complete to org_settings, backfills data,
-- creates missing indexes, and adds auth_audit_log table.

-- ── 1. Add new columns to org_settings ──────────────────────────────────────

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'org_settings' AND column_name = 'settings_json'
  ) THEN
    ALTER TABLE org_settings ADD COLUMN settings_json jsonb DEFAULT '{}';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'org_settings' AND column_name = 'onboarding_complete'
  ) THEN
    ALTER TABLE org_settings ADD COLUMN onboarding_complete boolean DEFAULT false;
  END IF;
END $$;

-- ── 2. Backfill settings_json from limits_json + features_json ──────────────

UPDATE org_settings
SET settings_json = COALESCE(limits_json, '{}'::jsonb) || COALESCE(
  CASE
    WHEN jsonb_typeof(features_json) = 'array'
    THEN jsonb_build_object('features', features_json)
    ELSE features_json
  END,
  '{}'::jsonb
)
WHERE settings_json IS NULL OR settings_json = '{}'::jsonb;

-- ── 3. Add missing indexes for common query patterns ────────────────────────

CREATE INDEX IF NOT EXISTS idx_sessions_org_agent
  ON sessions(org_id, agent_name);

CREATE INDEX IF NOT EXISTS idx_eval_runs_org_agent
  ON eval_runs(org_id, agent_name);

CREATE INDEX IF NOT EXISTS idx_billing_records_org_agent
  ON billing_records(org_id, agent_name);

CREATE INDEX IF NOT EXISTS idx_issues_org_agent
  ON issues(org_id, agent_name);

CREATE INDEX IF NOT EXISTS idx_turns_session
  ON turns(session_id);

-- ── 4. Auth audit log table ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS auth_audit_log (
  id bigserial PRIMARY KEY,
  org_id text,
  user_id text,
  email text,
  event_type text NOT NULL,  -- signup, login, login_failed, password_change, cf_access_exchange, logout, api_key_used
  ip_address text,
  user_agent text,
  metadata_json jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_auth_audit_org_created
  ON auth_audit_log(org_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_auth_audit_email
  ON auth_audit_log(email, created_at DESC);
