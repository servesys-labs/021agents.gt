-- Migration: Evolution scheduling tables
-- Enables automated evolution analysis on a configurable schedule per agent.

CREATE TABLE IF NOT EXISTS evolution_schedules (
  id TEXT PRIMARY KEY,
  agent_name TEXT NOT NULL,
  org_id TEXT NOT NULL DEFAULT '',
  enabled BOOLEAN NOT NULL DEFAULT true,
  interval_days INTEGER NOT NULL DEFAULT 7,
  min_sessions INTEGER NOT NULL DEFAULT 10,
  last_run_at REAL,
  next_run_at REAL,
  created_at REAL NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_evolution_schedules_agent_org
  ON evolution_schedules(agent_name, org_id);

CREATE INDEX IF NOT EXISTS idx_evolution_schedules_next_run
  ON evolution_schedules(enabled, next_run_at);
