-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 006: Custom domains for org-level API URLs
-- Enables: acme.agentos.dev (auto-subdomain) and agents.acme.com (CNAME)
-- ═══════════════════════════════════════════════════════════════════════════

-- Custom domains table — maps hostnames to orgs
CREATE TABLE IF NOT EXISTS custom_domains (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
  hostname text NOT NULL UNIQUE,          -- e.g. "acme.agentos.dev" or "agents.acme.com"
  type text NOT NULL DEFAULT 'subdomain'  -- 'subdomain' (auto) or 'custom' (CNAME)
    CHECK (type IN ('subdomain', 'custom')),
  status text NOT NULL DEFAULT 'pending'  -- 'pending', 'active', 'failed', 'removed'
    CHECK (status IN ('pending', 'active', 'failed', 'removed')),
  ssl_status text DEFAULT 'pending'       -- 'pending', 'active', 'failed'
    CHECK (ssl_status IN ('pending', 'active', 'failed')),
  cf_custom_hostname_id text,             -- Cloudflare for SaaS custom hostname ID
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

-- Add subdomain column to orgs for quick auto-subdomain lookup
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS subdomain text UNIQUE;

-- Conversations table — thread management for public API
CREATE TABLE IF NOT EXISTS conversations (
  conversation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  agent_name text NOT NULL,
  external_user_id text DEFAULT '',        -- customer's end-user ID
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

-- Conversation messages — individual messages in a thread
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

-- API key agent scoping — restrict a key to specific agents
CREATE TABLE IF NOT EXISTS api_key_agent_scopes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key_id text NOT NULL,
  agent_name text NOT NULL,
  created_at timestamptz DEFAULT now(),
  UNIQUE(key_id, agent_name)
);

CREATE INDEX IF NOT EXISTS idx_api_key_agent_scopes_key ON api_key_agent_scopes(key_id);

-- Rate limit config per API key
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS rate_limit_rpm int DEFAULT 60;
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS rate_limit_rpd int DEFAULT 10000;
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS allowed_agents text[] DEFAULT '{}';
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS allowed_origins text[] DEFAULT '{}';

-- Webhook delivery log — tracks each delivery attempt
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
