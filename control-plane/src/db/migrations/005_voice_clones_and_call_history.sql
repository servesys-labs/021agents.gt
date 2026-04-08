-- ============================================================================
-- 005_voice_clones_and_call_history.sql — Voice clones table + call history indexes
-- Generated: 2026-04-08
-- Supports: /clone/list, /clone/:id DELETE, agent-scoped call history
-- ============================================================================

-- Voice clones: tracks uploaded reference audio for voice cloning (Chatterbox)
CREATE TABLE IF NOT EXISTS voice_clones (
  id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id       TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
  agent_name   TEXT NOT NULL DEFAULT '',
  name         TEXT NOT NULL DEFAULT '',
  r2_key       TEXT NOT NULL,
  size_bytes   INT NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'active'
               CHECK (status IN ('active', 'processing', 'failed', 'deleted')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_voice_clones_org_agent ON voice_clones(org_id, agent_name);

-- RLS
ALTER TABLE voice_clones ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY voice_clones_org_isolation ON voice_clones
    FOR ALL USING (org_id = current_org_id());
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Call history indexes for agent-scoped queries
CREATE INDEX IF NOT EXISTS idx_voice_calls_org_agent ON voice_calls(org_id, agent_name);
CREATE INDEX IF NOT EXISTS idx_voice_calls_created ON voice_calls(created_at DESC);
