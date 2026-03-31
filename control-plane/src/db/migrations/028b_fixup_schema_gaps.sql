-- Migration 028b: Fix schema gaps for tables that existed before migrations 023/026
-- Skills table is missing org_id, skill_id, prompt columns
-- Turns table has started_at/ended_at instead of created_at
-- marketplace_ratings missing credibility columns

-- ══════════════════════════════════════════════════════════════════════
-- 1. Skills: add missing columns expected by routes/skills.ts
-- ══════════════════════════════════════════════════════════════════════

ALTER TABLE skills ADD COLUMN IF NOT EXISTS skill_id UUID DEFAULT gen_random_uuid();
ALTER TABLE skills ADD COLUMN IF NOT EXISTS org_id TEXT;
ALTER TABLE skills ADD COLUMN IF NOT EXISTS when_to_use TEXT NOT NULL DEFAULT '';
ALTER TABLE skills ADD COLUMN IF NOT EXISTS prompt TEXT NOT NULL DEFAULT '';
ALTER TABLE skills ADD COLUMN IF NOT EXISTS prompt_template TEXT NOT NULL DEFAULT '';
ALTER TABLE skills ADD COLUMN IF NOT EXISTS required_tools JSONB DEFAULT '[]'::jsonb;
ALTER TABLE skills ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE skills ADD COLUMN IF NOT EXISTS created_by TEXT;

-- Add unique constraint on (org_id, name) if not exists — safe via DO block
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'skills_org_id_name_key'
  ) THEN
    -- Can't add unique constraint if org_id has NULLs, so set defaults first
    UPDATE skills SET org_id = 'default' WHERE org_id IS NULL;
    ALTER TABLE skills ADD CONSTRAINT skills_org_id_name_key UNIQUE (org_id, name);
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS idx_skills_org_agent ON skills(org_id, agent_name);
CREATE INDEX IF NOT EXISTS idx_skills_org_name ON skills(org_id, name);

-- ══════════════════════════════════════════════════════════════════════
-- 2. Turns: add created_at (aliased from started_at) + missing columns
-- ══════════════════════════════════════════════════════════════════════

ALTER TABLE turns ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();

-- Backfill created_at from started_at where available
UPDATE turns SET created_at = started_at WHERE created_at IS NULL AND started_at IS NOT NULL;

-- Now add the observability columns from migration 026
ALTER TABLE turns ADD COLUMN IF NOT EXISTS llm_latency_ms INTEGER DEFAULT 0;
ALTER TABLE turns ADD COLUMN IF NOT EXISTS stop_reason TEXT;
ALTER TABLE turns ADD COLUMN IF NOT EXISTS refusal BOOLEAN DEFAULT false;
ALTER TABLE turns ADD COLUMN IF NOT EXISTS cache_read_tokens INTEGER DEFAULT 0;
ALTER TABLE turns ADD COLUMN IF NOT EXISTS cache_write_tokens INTEGER DEFAULT 0;
ALTER TABLE turns ADD COLUMN IF NOT EXISTS gateway_log_id TEXT;

-- Session-level observability columns from 026
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS feature_flags_json TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS detailed_cost_json TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS total_cache_read_tokens INTEGER DEFAULT 0;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS total_cache_write_tokens INTEGER DEFAULT 0;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS repair_count INTEGER DEFAULT 0;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS compaction_count INTEGER DEFAULT 0;

-- ══════════════════════════════════════════════════════════════════════
-- 3. Indexes from migration 026 (now that columns exist)
-- ══════════════════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS idx_sessions_cache ON sessions(org_id, total_cache_read_tokens)
  WHERE total_cache_read_tokens > 0;

CREATE INDEX IF NOT EXISTS idx_turns_refusal ON turns(created_at DESC)
  WHERE refusal = true;

CREATE INDEX IF NOT EXISTS idx_turns_model_latency ON turns(model_used, llm_latency_ms)
  WHERE llm_latency_ms > 0;

CREATE INDEX IF NOT EXISTS idx_sessions_repairs ON sessions(org_id, repair_count)
  WHERE repair_count > 0;

CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id, turn_number);
CREATE INDEX IF NOT EXISTS idx_turns_created ON turns(created_at DESC);

-- ══════════════════════════════════════════════════════════════════════
-- 4. marketplace_ratings: add credibility columns from 023
-- ══════════════════════════════════════════════════════════════════════

ALTER TABLE marketplace_ratings ADD COLUMN IF NOT EXISTS credibility_weight NUMERIC(4, 2) DEFAULT 1.0;
ALTER TABLE marketplace_ratings ADD COLUMN IF NOT EXISTS raw_rating INTEGER;

-- ══════════════════════════════════════════════════════════════════════
-- 5. Audit log: add missing columns (existing table has different schema)
-- ══════════════════════════════════════════════════════════════════════

ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS actor_id TEXT;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS resource_name TEXT;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS details JSONB DEFAULT '{}'::jsonb;
