-- ============================================================================
-- 007_observability_turn_enrichment.sql
-- Generated: 2026-04-07
-- Purpose: add first-class observability metrics for latency/cost/reliability
-- ============================================================================

ALTER TABLE IF EXISTS sessions
  ADD COLUMN IF NOT EXISTS termination_reason TEXT;

ALTER TABLE IF EXISTS turns
  ADD COLUMN IF NOT EXISTS llm_retry_count INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS llm_cost_usd NUMERIC(18,8) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tool_cost_usd NUMERIC(18,8) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tokens_per_sec NUMERIC(12,4),
  ADD COLUMN IF NOT EXISTS queue_delay_ms INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS compaction_triggered BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS messages_dropped INT NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_turns_queue_delay_created
  ON turns(queue_delay_ms, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_turns_retry_created
  ON turns(llm_retry_count, created_at DESC);
