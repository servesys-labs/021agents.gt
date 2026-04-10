-- ============================================================================
-- 006_turn_phase_timing_columns.sql — Dedicated per-turn phase timing columns
-- Generated: 2026-04-07
-- Purpose: promote phase timings from JSON blobs to typed columns on turns
-- ============================================================================

ALTER TABLE IF EXISTS turns
  ADD COLUMN IF NOT EXISTS pre_llm_ms INT,
  ADD COLUMN IF NOT EXISTS tool_exec_ms INT;

-- Optional index for latency drill-down queries by model and recency.
CREATE INDEX IF NOT EXISTS idx_turns_model_pre_llm
  ON turns(model_used, pre_llm_ms, created_at DESC);
