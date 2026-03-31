-- Migration 022: A2A artifact sharing + cost-plus pricing for skill marketplace
-- Enables agents to share files/projects back to callers and supports flexible pricing models.

-- ── 1. A2A Artifacts — file/project sharing between agents ─────────────────

CREATE TABLE IF NOT EXISTS a2a_artifacts (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  task_id       TEXT NOT NULL REFERENCES a2a_tasks(task_id) ON DELETE CASCADE,
  sender_org_id TEXT NOT NULL,
  sender_agent  TEXT NOT NULL,
  receiver_org_id TEXT NOT NULL,
  receiver_agent  TEXT,

  -- Artifact metadata
  name          TEXT NOT NULL,                    -- human-readable name ("invoice.pdf", "react-app.zip")
  mime_type     TEXT NOT NULL DEFAULT 'application/octet-stream',
  size_bytes    BIGINT DEFAULT 0,
  description   TEXT DEFAULT '',

  -- Storage — R2 object key or signed URL
  storage_key   TEXT NOT NULL,                    -- R2 key: artifacts/{task_id}/{name}
  storage_url   TEXT,                             -- pre-signed URL (expires in 24h, regenerated on access)
  url_expires_at TIMESTAMPTZ,

  -- Lifecycle
  status        TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('uploading', 'available', 'expired', 'deleted')),
  expires_at    TIMESTAMPTZ DEFAULT (now() + interval '30 days'),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_a2a_artifacts_task ON a2a_artifacts(task_id);
CREATE INDEX IF NOT EXISTS idx_a2a_artifacts_receiver ON a2a_artifacts(receiver_org_id, receiver_agent);

-- ── 2. Cost-plus pricing model for marketplace ─────────────────────────────

-- Add pricing_model to marketplace_listings
ALTER TABLE marketplace_listings
  ADD COLUMN IF NOT EXISTS pricing_model TEXT NOT NULL DEFAULT 'fixed'
    CHECK (pricing_model IN ('fixed', 'cost_plus', 'per_token'));

-- For cost_plus: margin percentage on top of actual LLM costs
ALTER TABLE marketplace_listings
  ADD COLUMN IF NOT EXISTS cost_plus_margin_pct NUMERIC(5,2) DEFAULT 0.00;

-- For per_token: explicit input/output token rates
ALTER TABLE marketplace_listings
  ADD COLUMN IF NOT EXISTS price_per_1k_input_tokens_usd NUMERIC(10,6) DEFAULT 0;

ALTER TABLE marketplace_listings
  ADD COLUMN IF NOT EXISTS price_per_1k_output_tokens_usd NUMERIC(10,6) DEFAULT 0;

-- Track actual LLM cost per A2A task (needed for cost_plus settlement)
ALTER TABLE a2a_tasks
  ADD COLUMN IF NOT EXISTS llm_cost_usd NUMERIC(10,6) DEFAULT 0;

ALTER TABLE a2a_tasks
  ADD COLUMN IF NOT EXISTS input_tokens INT DEFAULT 0;

ALTER TABLE a2a_tasks
  ADD COLUMN IF NOT EXISTS output_tokens INT DEFAULT 0;

ALTER TABLE a2a_tasks
  ADD COLUMN IF NOT EXISTS pricing_model TEXT DEFAULT 'fixed';

ALTER TABLE a2a_tasks
  ADD COLUMN IF NOT EXISTS settled_amount_usd NUMERIC(10,6) DEFAULT 0;

-- ── 3. Skill agent category (distinct from general agents) ─────────────────

-- Tag marketplace listings as "skill agents" vs "full agents"
ALTER TABLE marketplace_listings
  ADD COLUMN IF NOT EXISTS agent_type TEXT NOT NULL DEFAULT 'agent'
    CHECK (agent_type IN ('agent', 'skill'));

-- Skill agents are single-purpose, lightweight, composable
-- Full agents are multi-capability, conversational, autonomous
CREATE INDEX IF NOT EXISTS idx_marketplace_agent_type
  ON marketplace_listings(agent_type) WHERE is_published = true;

-- ── 4. Default agent tracking ──────────────────────────────────────────────

-- Track which agents are the org's defaults (personal assistant, meta-agent)
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS agent_role TEXT DEFAULT 'custom'
    CHECK (agent_role IN ('personal_assistant', 'meta_agent', 'skill', 'custom'));

COMMENT ON COLUMN agents.agent_role IS
  'personal_assistant = default PA (Telegram/WhatsApp), meta_agent = org orchestrator, skill = marketplace skill agent, custom = user-created';
