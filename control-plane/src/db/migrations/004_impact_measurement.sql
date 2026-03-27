-- Migration: Impact measurement columns for post-apply evolution tracking.
-- Adds impact data, rollback metadata to evolution_proposals so we can
-- measure whether an applied proposal actually improved the agent.

-- Store measured impact data on the proposal itself
DO $$ BEGIN
  ALTER TABLE evolution_proposals ADD COLUMN impact_json TEXT DEFAULT NULL;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

-- Track when a proposal was rolled back
DO $$ BEGIN
  ALTER TABLE evolution_proposals ADD COLUMN rolled_back_at REAL DEFAULT NULL;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

-- Reason for rollback (human-readable)
DO $$ BEGIN
  ALTER TABLE evolution_proposals ADD COLUMN rollback_reason TEXT DEFAULT NULL;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

-- Index for quickly finding applied proposals that need impact measurement
CREATE INDEX IF NOT EXISTS idx_evolution_proposals_applied
  ON evolution_proposals(agent_name, org_id, status) WHERE status IN ('applied', 'rolled_back');
