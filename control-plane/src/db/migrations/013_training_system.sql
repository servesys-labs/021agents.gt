-- Training system tables — Agent Lightning-style training loop for AgentOS.
-- Additive migration: new tables only, no changes to existing schema.

-- Training jobs: top-level orchestration entity
CREATE TABLE IF NOT EXISTS training_jobs (
  job_id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  algorithm TEXT NOT NULL DEFAULT 'baseline',
  status TEXT NOT NULL DEFAULT 'created',
  config_json TEXT NOT NULL DEFAULT '{}',

  -- Task/eval binding
  dataset_name TEXT,
  eval_tasks_json TEXT,
  evaluator_config_json TEXT DEFAULT '{}',

  -- Progress
  current_iteration INTEGER DEFAULT 0,
  max_iterations INTEGER DEFAULT 10,
  best_score REAL,
  best_iteration INTEGER,
  best_resource_version INTEGER,

  -- Auto-activate best resource when training completes
  auto_activate BOOLEAN DEFAULT false,

  -- Timing
  created_at TIMESTAMPTZ DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,

  -- Metadata
  created_by TEXT,
  tags TEXT[] DEFAULT '{}',
  metadata_json TEXT DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_training_jobs_org_agent
  ON training_jobs(org_id, agent_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_training_jobs_status
  ON training_jobs(org_id, status);

-- Training iterations: one row per eval→improve cycle
CREATE TABLE IF NOT EXISTS training_iterations (
  iteration_id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  job_id TEXT NOT NULL REFERENCES training_jobs(job_id) ON DELETE CASCADE,
  org_id TEXT NOT NULL,
  iteration_number INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',

  -- Eval results
  eval_run_id INTEGER,
  pass_rate REAL,
  avg_score REAL,
  avg_latency_ms REAL,
  total_cost_usd REAL,

  -- Reward
  reward_score REAL,
  reward_breakdown_json TEXT DEFAULT '{}',

  -- Resources
  resource_version INTEGER,
  resource_snapshot_json TEXT DEFAULT '{}',

  -- Algorithm outputs
  algorithm_output_json TEXT DEFAULT '{}',

  -- Timing
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,

  UNIQUE(job_id, iteration_number)
);

CREATE INDEX IF NOT EXISTS idx_training_iterations_job
  ON training_iterations(job_id, iteration_number);

-- Training resources: versioned artifacts
CREATE TABLE IF NOT EXISTS training_resources (
  resource_id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  job_id TEXT REFERENCES training_jobs(job_id) ON DELETE SET NULL,

  resource_type TEXT NOT NULL,
  resource_key TEXT NOT NULL DEFAULT 'main',
  version INTEGER NOT NULL,

  content_text TEXT,
  content_json TEXT,
  content_r2_key TEXT,

  -- Provenance
  source TEXT DEFAULT 'manual',
  parent_version INTEGER,
  iteration_id TEXT,

  -- Quality
  eval_score REAL,
  is_active BOOLEAN DEFAULT false,

  created_at TIMESTAMPTZ DEFAULT now(),

  UNIQUE(org_id, agent_name, resource_type, resource_key, version)
);

CREATE INDEX IF NOT EXISTS idx_training_resources_active
  ON training_resources(org_id, agent_name, resource_type, resource_key)
  WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_training_resources_job
  ON training_resources(job_id);

-- Reward signals: denormalized from various sources
CREATE TABLE IF NOT EXISTS training_rewards (
  reward_id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  session_id TEXT,

  source TEXT NOT NULL,
  score REAL NOT NULL,
  raw_value TEXT,
  metadata_json TEXT DEFAULT '{}',

  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_training_rewards_agent
  ON training_rewards(org_id, agent_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_training_rewards_session
  ON training_rewards(session_id);
