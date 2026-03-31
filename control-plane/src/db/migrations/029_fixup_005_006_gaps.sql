-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 029: Fix gaps from migrations 005 and 006 that failed to apply
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Root causes:
--   005_gap_fixes.sql: settings_json exists as TEXT, migration assumes JSONB
--   006_custom_domains.sql: conversation_messages exists with old schema
--     (agent_name, instance_id, channel) but app expects new schema
--     (conversation_id FK, metadata, cost_usd, model). conversations table
--     missing entirely.
--
-- This migration is idempotent (safe to re-run).
-- ═══════════════════════════════════════════════════════════════════════════

-- ╔═══════════════════════════════════════════════════════════════════════╗
-- ║ PART 1: Fix org_settings.settings_json (from 005_gap_fixes)         ║
-- ╚═══════════════════════════════════════════════════════════════════════╝

-- 1a. Add onboarding_complete column (was in 005, never applied)
ALTER TABLE org_settings ADD COLUMN IF NOT EXISTS onboarding_complete BOOLEAN DEFAULT false;

-- 1b. Convert settings_json from text → jsonb so the backfill works
--     The app uses JSON.parse(String(...)) which handles both types.
DO $$
DECLARE
  col_type text;
BEGIN
  SELECT data_type INTO col_type
  FROM information_schema.columns
  WHERE table_name = 'org_settings' AND column_name = 'settings_json';

  IF col_type = 'text' THEN
    -- First, fix any invalid JSON values to prevent cast failure
    UPDATE org_settings
    SET settings_json = '{}'
    WHERE settings_json IS NULL
       OR settings_json = ''
       OR settings_json !~ '^\s*[\{\[]';

    -- Drop the text default before type conversion
    ALTER TABLE org_settings ALTER COLUMN settings_json DROP DEFAULT;

    -- Cast text → jsonb
    ALTER TABLE org_settings
      ALTER COLUMN settings_json TYPE jsonb USING settings_json::jsonb;

    -- Re-add default as jsonb
    ALTER TABLE org_settings
      ALTER COLUMN settings_json SET DEFAULT '{}'::jsonb;

    RAISE NOTICE 'Converted settings_json from text to jsonb';
  ELSE
    RAISE NOTICE 'settings_json already jsonb, skipping conversion';
  END IF;
END $$;

-- 1c. Backfill settings_json from limits_json + features_json (the 005 UPDATE that failed)
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

-- 1d. Missing indexes from 005
CREATE INDEX IF NOT EXISTS idx_sessions_org_agent
  ON sessions(org_id, agent_name);

CREATE INDEX IF NOT EXISTS idx_eval_runs_org_agent
  ON eval_runs(org_id, agent_name);

CREATE INDEX IF NOT EXISTS idx_billing_records_org_agent
  ON billing_records(org_id, agent_name);

CREATE INDEX IF NOT EXISTS idx_issues_org_agent
  ON issues(org_id, agent_name);

-- ╔═══════════════════════════════════════════════════════════════════════╗
-- ║ PART 2: Fix conversations + conversation_messages (from 006)        ║
-- ╚═══════════════════════════════════════════════════════════════════════╝

-- 2a. Rename old conversation_messages to preserve existing data
DO $$
BEGIN
  -- Only rename if the old-schema table exists (has 'instance_id' column)
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'conversation_messages' AND column_name = 'instance_id'
  ) THEN
    -- Check if we already renamed it
    IF NOT EXISTS (
      SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'conversation_messages_legacy'
    ) THEN
      ALTER TABLE conversation_messages RENAME TO conversation_messages_legacy;
      RAISE NOTICE 'Renamed conversation_messages → conversation_messages_legacy (829 rows preserved)';
    ELSE
      -- Legacy table already exists from previous run, drop the old one
      DROP TABLE IF EXISTS conversation_messages;
      RAISE NOTICE 'Dropped duplicate conversation_messages, legacy already preserved';
    END IF;
  ELSE
    RAISE NOTICE 'conversation_messages already has new schema or does not exist';
  END IF;
END $$;

-- 2b. Create conversations table (from 006)
CREATE TABLE IF NOT EXISTS conversations (
  conversation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  agent_name text NOT NULL,
  external_user_id text DEFAULT '',
  title text DEFAULT '',
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'archived', 'deleted')),
  metadata jsonb DEFAULT '{}',
  message_count int DEFAULT 0,
  last_message_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_conversations_org_agent ON conversations(org_id, agent_name);
CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(org_id, external_user_id);
CREATE INDEX IF NOT EXISTS idx_conversations_status ON conversations(org_id, status);

DO $$ BEGIN
  CREATE TRIGGER update_conversations_updated_at BEFORE UPDATE ON conversations
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 2c. Create conversation_messages with new schema (from 006)
CREATE TABLE IF NOT EXISTS conversation_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content text NOT NULL,
  metadata jsonb DEFAULT '{}',
  cost_usd numeric(10,6) DEFAULT 0,
  model text DEFAULT '',
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_conv_messages_conv ON conversation_messages(conversation_id, created_at);

-- 2d. Migrate legacy data into new tables
-- Each unique (agent_name, instance_id) becomes a conversation
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'conversation_messages_legacy'
  ) THEN
    -- Create a conversation for each distinct agent+instance pair
    INSERT INTO conversations (org_id, agent_name, external_user_id, title, status, message_count, created_at)
    SELECT
      'default',                          -- org_id unknown in old schema
      agent_name,
      instance_id,                        -- map instance_id → external_user_id
      agent_name || '/' || instance_id,   -- readable title
      'active',
      COUNT(*),
      MIN(created_at)
    FROM conversation_messages_legacy
    GROUP BY agent_name, instance_id
    ON CONFLICT DO NOTHING;

    -- Insert messages linked to their new conversation
    INSERT INTO conversation_messages (conversation_id, role, content, metadata, created_at)
    SELECT
      c.conversation_id,
      cml.role,
      cml.content,
      jsonb_build_object('channel', cml.channel, 'legacy_id', cml.id),
      cml.created_at
    FROM conversation_messages_legacy cml
    JOIN conversations c
      ON c.agent_name = cml.agent_name
      AND c.external_user_id = cml.instance_id
    ON CONFLICT DO NOTHING;

    RAISE NOTICE 'Migrated legacy conversation_messages into new schema';
  END IF;
END $$;

-- ╔═══════════════════════════════════════════════════════════════════════╗
-- ║ PART 3: Remaining 006 items (custom_domains, api_key_agent_scopes)  ║
-- ╚═══════════════════════════════════════════════════════════════════════╝

-- 3a. custom_domains (from 006, failed because of conversation_messages crash)
CREATE TABLE IF NOT EXISTS custom_domains (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
  hostname text NOT NULL UNIQUE,
  type text NOT NULL DEFAULT 'subdomain'
    CHECK (type IN ('subdomain', 'custom')),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'active', 'failed', 'removed')),
  ssl_status text DEFAULT 'pending'
    CHECK (ssl_status IN ('pending', 'active', 'failed')),
  cf_custom_hostname_id text,
  verified_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_custom_domains_org ON custom_domains(org_id);
CREATE INDEX IF NOT EXISTS idx_custom_domains_hostname ON custom_domains(hostname);
CREATE INDEX IF NOT EXISTS idx_custom_domains_status ON custom_domains(status);

DO $$ BEGIN
  CREATE TRIGGER update_custom_domains_updated_at BEFORE UPDATE ON custom_domains
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 3b. subdomain column on orgs
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS subdomain text UNIQUE;

-- 3c. api_key_agent_scopes (from 006)
CREATE TABLE IF NOT EXISTS api_key_agent_scopes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key_id text NOT NULL,
  agent_name text NOT NULL,
  created_at timestamptz DEFAULT now(),
  UNIQUE(key_id, agent_name)
);

CREATE INDEX IF NOT EXISTS idx_api_key_agent_scopes_key ON api_key_agent_scopes(key_id);

-- 3d. API key columns from 006
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS rate_limit_rpm int DEFAULT 60;
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS rate_limit_rpd int DEFAULT 10000;
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS allowed_agents text[] DEFAULT '{}';
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS allowed_origins text[] DEFAULT '{}';

-- 3e. Webhook delivery log (from 006, may already exist)
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_id text NOT NULL,
  event_type text NOT NULL,
  status_code int DEFAULT 0,
  success boolean DEFAULT false,
  response_body text DEFAULT '',
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook ON webhook_deliveries(webhook_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_event ON webhook_deliveries(event_type, created_at DESC);

-- ╔═══════════════════════════════════════════════════════════════════════╗
-- ║ PART 4: auth_audit_log (from 005, was dropped in 014, re-create)    ║
-- ╚═══════════════════════════════════════════════════════════════════════╝

-- 028_enable_rls references it in the service-only list.
-- Re-create if it doesn't exist (was intentionally dropped in 014 but
-- the RLS migration needs it, and security audit logging is valuable).
CREATE TABLE IF NOT EXISTS auth_audit_log (
  id bigserial PRIMARY KEY,
  org_id text,
  user_id text,
  email text,
  event_type text NOT NULL,
  ip_address text,
  user_agent text,
  metadata_json jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_auth_audit_org_created
  ON auth_audit_log(org_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_auth_audit_email
  ON auth_audit_log(email, created_at DESC);
