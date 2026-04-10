-- ============================================================================
-- 007_turn_ttft_column.sql — Add TTFT (time to first token) column to turns
-- Generated: 2026-04-10
-- Purpose: capture TTFT proxy (time from request init to response headers)
--          alongside the existing llm_latency_ms (full body latency).
--          Useful for streaming UX diagnostics and gateway routing analysis.
-- ============================================================================

ALTER TABLE IF EXISTS turns
  ADD COLUMN IF NOT EXISTS ttft_ms INT;

-- Note: no index — TTFT is rolled up via AVG() in observability summaries
-- and rarely queried by exact value. Index can be added later if needed.
