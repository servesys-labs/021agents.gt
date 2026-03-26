-- Migration: Evolution Analyzer tables
-- Extends the evolution system with analysis reports, evidence tracking,
-- and richer ledger entries for the full observe → analyze → propose → apply loop.

-- Add evidence_json and priority to evolution_proposals (if not present)
DO $$ BEGIN
  ALTER TABLE evolution_proposals ADD COLUMN evidence_json TEXT DEFAULT '{}';
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE evolution_proposals ADD COLUMN priority REAL DEFAULT 0.5;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE evolution_proposals ADD COLUMN config_diff_json TEXT DEFAULT '{}';
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE evolution_proposals ADD COLUMN rationale TEXT DEFAULT '';
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE evolution_proposals ADD COLUMN category TEXT DEFAULT 'prompt';
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

-- Ensure proposal_id column exists (some schemas use 'id' instead)
DO $$ BEGIN
  ALTER TABLE evolution_proposals ADD COLUMN proposal_id TEXT DEFAULT '';
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

-- Add config snapshots and metrics to evolution_ledger
DO $$ BEGIN
  ALTER TABLE evolution_ledger ADD COLUMN previous_config_json TEXT DEFAULT '{}';
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE evolution_ledger ADD COLUMN new_config_json TEXT DEFAULT '{}';
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE evolution_ledger ADD COLUMN metrics_before_json TEXT DEFAULT '{}';
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE evolution_ledger ADD COLUMN metrics_after_json TEXT DEFAULT '{}';
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

-- Evolution reports table (stores analysis results)
CREATE TABLE IF NOT EXISTS evolution_reports (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  agent_name TEXT NOT NULL,
  org_id TEXT NOT NULL DEFAULT '',
  report_json TEXT NOT NULL DEFAULT '{}',
  session_count INTEGER NOT NULL DEFAULT 0,
  created_at REAL NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_evolution_reports_agent_org
  ON evolution_reports(agent_name, org_id, created_at DESC);

-- Indexes for faster proposal queries
CREATE INDEX IF NOT EXISTS idx_evolution_proposals_agent_status
  ON evolution_proposals(agent_name, org_id, status);

CREATE INDEX IF NOT EXISTS idx_evolution_proposals_priority
  ON evolution_proposals(agent_name, org_id, priority DESC);
