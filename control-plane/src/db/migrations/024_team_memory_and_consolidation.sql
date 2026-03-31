-- Team memory: shared knowledge across agents in an org
CREATE TABLE IF NOT EXISTS team_facts (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id TEXT NOT NULL,
  author_agent TEXT NOT NULL,
  content TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'general',
  score NUMERIC(4,2) DEFAULT 0.5,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(org_id, content)
);

CREATE TABLE IF NOT EXISTS team_observations (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id TEXT NOT NULL,
  author_agent TEXT NOT NULL,
  target_agent TEXT,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_team_facts_org ON team_facts(org_id, score DESC);
CREATE INDEX IF NOT EXISTS idx_team_obs_org ON team_observations(org_id, created_at DESC);

-- Agent procedures table for dream consolidation (if not exists)
CREATE TABLE IF NOT EXISTS agent_procedures (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  task_pattern TEXT NOT NULL,
  tool_sequence JSONB NOT NULL DEFAULT '[]',
  success_rate NUMERIC(4,2) DEFAULT 0.5,
  avg_turns INTEGER DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(org_id, agent_name, task_pattern)
);
