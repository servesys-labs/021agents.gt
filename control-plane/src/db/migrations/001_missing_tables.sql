-- Migration: Create tables required by control-plane that don't exist in Supabase yet.
-- These were previously SQLite-only in the Python backend.
-- Run this against Supabase to enable all control-plane features.

-- eval_runs: add org_id if missing
DO $$ BEGIN
  ALTER TABLE eval_runs ADD COLUMN org_id TEXT DEFAULT '';
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

-- schedules
CREATE TABLE IF NOT EXISTS schedules (
  schedule_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL DEFAULT '',
  agent_name TEXT NOT NULL DEFAULT '',
  task TEXT NOT NULL DEFAULT '',
  cron TEXT NOT NULL DEFAULT '',
  is_enabled INTEGER NOT NULL DEFAULT 1,
  run_count INTEGER NOT NULL DEFAULT 0,
  last_run_at REAL,
  last_status TEXT DEFAULT '',
  last_error TEXT DEFAULT '',
  next_run_at REAL,
  created_at REAL NOT NULL DEFAULT 0,
  updated_at REAL NOT NULL DEFAULT 0
);

-- user_feedback
CREATE TABLE IF NOT EXISTS user_feedback (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL DEFAULT '',
  turn_number INTEGER NOT NULL DEFAULT 0,
  rating TEXT NOT NULL DEFAULT 'neutral',
  comment TEXT NOT NULL DEFAULT '',
  message_preview TEXT NOT NULL DEFAULT '',
  user_id TEXT NOT NULL DEFAULT '',
  org_id TEXT NOT NULL DEFAULT '',
  agent_name TEXT NOT NULL DEFAULT '',
  channel TEXT NOT NULL DEFAULT '',
  created_at REAL NOT NULL DEFAULT 0
);

-- pipelines
CREATE TABLE IF NOT EXISTS pipelines (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'pipeline',
  config_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'draft',
  cf_resource_id TEXT DEFAULT '',
  created_at REAL NOT NULL DEFAULT 0,
  updated_at REAL NOT NULL DEFAULT 0
);

-- guardrail_events
CREATE TABLE IF NOT EXISTS guardrail_events (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL DEFAULT '',
  agent_name TEXT NOT NULL DEFAULT '',
  event_type TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL DEFAULT '',
  direction TEXT NOT NULL DEFAULT '',
  text_preview TEXT NOT NULL DEFAULT '',
  matches_json TEXT NOT NULL DEFAULT '[]',
  policy_id TEXT DEFAULT '',
  created_at REAL NOT NULL DEFAULT 0
);

-- guardrail_policies
CREATE TABLE IF NOT EXISTS guardrail_policies (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  agent_scope TEXT NOT NULL DEFAULT '',
  config_json TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at REAL NOT NULL DEFAULT 0
);

-- meta_proposals (may already exist from Python)
CREATE TABLE IF NOT EXISTS meta_proposals (
  id TEXT PRIMARY KEY,
  agent_name TEXT NOT NULL DEFAULT '',
  org_id TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  rationale TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  priority REAL NOT NULL DEFAULT 0,
  modification_json TEXT NOT NULL DEFAULT '{}',
  evidence_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  review_note TEXT DEFAULT '',
  reviewed_at REAL,
  created_at REAL NOT NULL DEFAULT 0
);

-- evolution_proposals
CREATE TABLE IF NOT EXISTS evolution_proposals (
  id TEXT PRIMARY KEY,
  agent_name TEXT NOT NULL DEFAULT '',
  org_id TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  rationale TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  priority REAL NOT NULL DEFAULT 0,
  config_diff_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  note TEXT DEFAULT '',
  created_at REAL NOT NULL DEFAULT 0
);

-- evolution_ledger
CREATE TABLE IF NOT EXISTS evolution_ledger (
  id TEXT PRIMARY KEY,
  agent_name TEXT NOT NULL DEFAULT '',
  org_id TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL DEFAULT '',
  proposal_id TEXT DEFAULT '',
  proposal_title TEXT DEFAULT '',
  note TEXT DEFAULT '',
  changed_by TEXT DEFAULT '',
  created_at REAL NOT NULL DEFAULT 0
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_schedules_org ON schedules(org_id);
CREATE INDEX IF NOT EXISTS idx_user_feedback_org ON user_feedback(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pipelines_org ON pipelines(org_id);
CREATE INDEX IF NOT EXISTS idx_guardrail_events_org ON guardrail_events(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_meta_proposals_org ON meta_proposals(org_id, agent_name);
CREATE INDEX IF NOT EXISTS idx_eval_runs_org ON eval_runs(org_id, agent_name);
