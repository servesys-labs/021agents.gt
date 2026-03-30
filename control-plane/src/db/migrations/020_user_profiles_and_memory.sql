-- User profiles: persistent per-user learning across conversations
-- Stores preferences, communication style, expertise, recurring needs
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
CREATE INDEX IF NOT EXISTS idx_user_profiles_org_agent
  ON user_profiles(org_id, agent_name);

-- Memory facts: semantic memory for agent knowledge
CREATE TABLE IF NOT EXISTS memory_facts (
  id BIGSERIAL PRIMARY KEY,
  org_id TEXT NOT NULL DEFAULT '',
  agent_name TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'general',
  confidence REAL NOT NULL DEFAULT 1.0,
  source TEXT NOT NULL DEFAULT 'agent',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(org_id, agent_name, content_hash)
);
CREATE INDEX IF NOT EXISTS idx_memory_facts_agent
  ON memory_facts(org_id, agent_name);

-- Procedures: learned tool sequences with success tracking
CREATE TABLE IF NOT EXISTS procedures (
  id BIGSERIAL PRIMARY KEY,
  org_id TEXT NOT NULL DEFAULT '',
  agent_name TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  steps_json JSONB NOT NULL DEFAULT '[]',
  success_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  last_used TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_procedures_agent
  ON procedures(org_id, agent_name);
