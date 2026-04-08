-- ============================================================================
-- 004_voice_numbers_fix.sql — Add missing columns to voice_numbers
-- Generated: 2026-04-07
-- Fixes: voice_numbers table was missing agent_name, provider_sid, status,
--        config columns required by control-plane/src/routes/voice.ts
-- ============================================================================

-- Add missing columns
ALTER TABLE voice_numbers ADD COLUMN IF NOT EXISTS agent_name TEXT NOT NULL DEFAULT '';
ALTER TABLE voice_numbers ADD COLUMN IF NOT EXISTS provider_sid TEXT;
ALTER TABLE voice_numbers ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE voice_numbers ADD COLUMN IF NOT EXISTS config JSONB NOT NULL DEFAULT '{}';

-- Set provider default to 'twilio' (was empty string)
UPDATE voice_numbers SET provider = 'twilio' WHERE provider = '';

-- Index for org-scoped queries
CREATE INDEX IF NOT EXISTS idx_voice_numbers_org_agent ON voice_numbers(org_id, agent_name);

-- RLS: org isolation
ALTER TABLE voice_numbers ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY voice_numbers_org_isolation ON voice_numbers
    FOR ALL USING (org_id = current_org_id());
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
