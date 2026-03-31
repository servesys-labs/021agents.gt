-- Migration 027: Feature flags per org + agent_versions for config history
-- Required by: meta-agent tools (read_feature_flags, set_feature_flag, update_agent_config version snapshots)

-- ── Feature flags ──────────────────────────────────────────────
-- Per-org toggles for runtime behavior (concurrent_tools, context_compression, deferred_tool_loading)
CREATE TABLE IF NOT EXISTS feature_flags (
  org_id       TEXT NOT NULL,
  flag_name    TEXT NOT NULL,
  value        TEXT NOT NULL DEFAULT 'true',
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(org_id, flag_name)
);

CREATE INDEX IF NOT EXISTS idx_feature_flags_org ON feature_flags (org_id);

-- ── Agent versions ─────────────────────────────────────────────
-- Config snapshots created on every meta-agent update for rollback and audit
CREATE TABLE IF NOT EXISTS agent_versions (
  id           SERIAL PRIMARY KEY,
  agent_name   TEXT NOT NULL,
  org_id       TEXT,
  version      TEXT NOT NULL,
  config_json  JSONB,
  created_by   TEXT DEFAULT 'system',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(agent_name, version)
);

CREATE INDEX IF NOT EXISTS idx_agent_versions_name ON agent_versions (agent_name, created_at DESC);

-- ── Add agent_name column to skills if missing ─────────────────
-- The skills table from migration 023 may not have agent_name
ALTER TABLE skills ADD COLUMN IF NOT EXISTS agent_name TEXT;
