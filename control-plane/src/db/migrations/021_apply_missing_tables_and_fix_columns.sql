-- Migration 021: Apply all missing tables and document column fixes
-- This migration ensures ALL tables referenced by code actually exist.
-- Previously, migrations 008, 009, 013 were written but never applied.

-- ══════════════════════════════════════════════════════════════════
-- 1. Tables from migration 008 (ops observability)
-- ══════════════════════════════════════════════════════════════════
-- alert_configs, alert_history — applied via 008_ops_observability.sql

-- ══════════════════════════════════════════════════════════════════
-- 2. Tables from migration 009 (compliance)
-- ══════════════════════════════════════════════════════════════════
-- security_events, secrets_key_rotations, etc — applied via 009_compliance.sql

-- ══════════════════════════════════════════════════════════════════
-- 3. Tables from migration 013 (training)
-- ══════════════════════════════════════════════════════════════════
-- training_jobs, training_resources, training_iterations, training_rewards
-- applied via 013_training_system.sql

-- ══════════════════════════════════════════════════════════════════
-- 4. eval_trials — no prior migration existed
-- ══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS eval_trials (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  eval_run_id TEXT,
  agent_name TEXT NOT NULL,
  org_id TEXT NOT NULL,
  task_name TEXT,
  input TEXT,
  expected TEXT,
  actual TEXT,
  passed BOOLEAN DEFAULT false,
  score NUMERIC(5,3) DEFAULT 0,
  reasoning TEXT,
  latency_ms INTEGER DEFAULT 0,
  cost_usd NUMERIC(20,6) DEFAULT 0,
  grader TEXT DEFAULT 'llm_rubric',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_eval_trials_run ON eval_trials(eval_run_id);
CREATE INDEX IF NOT EXISTS idx_eval_trials_agent ON eval_trials(agent_name, org_id);

-- ══════════════════════════════════════════════════════════════════
-- 5. Memory tables (direct DB access from runtime tools)
-- ══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS episodic_memories (
  id TEXT PRIMARY KEY,
  agent_name TEXT NOT NULL,
  org_id TEXT NOT NULL,
  content TEXT NOT NULL,
  source TEXT DEFAULT 'agent',
  metadata_json TEXT DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_episodic_memories_agent ON episodic_memories(agent_name, org_id, created_at DESC);

CREATE TABLE IF NOT EXISTS semantic_facts (
  id TEXT PRIMARY KEY,
  agent_name TEXT NOT NULL,
  org_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  category TEXT DEFAULT 'general',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(agent_name, org_id, key)
);
CREATE INDEX IF NOT EXISTS idx_semantic_facts_agent ON semantic_facts(agent_name, org_id);

-- ══════════════════════════════════════════════════════════════════
-- 6. User profiles (from migration 020)
-- ══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS user_profiles (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  user_identifier TEXT NOT NULL,
  profile_data JSONB NOT NULL DEFAULT '{}',
  preferences JSONB NOT NULL DEFAULT '{}',
  metadata JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(org_id, agent_name, user_identifier)
);
CREATE INDEX IF NOT EXISTS idx_user_profiles_org_agent ON user_profiles(org_id, agent_name);
