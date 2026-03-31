-- Migration 026: Observability Enrichment
--
-- Adds columns to turns and sessions that the runtime already collects
-- but currently discards before writing to the DB.
--
-- Affected code paths:
--   workflow.ts  → turnRecords / telemetry queue writes
--   llm.ts       → cache tokens, gateway IDs, stop reason
--   features.ts  → flag snapshots per session
--   cost.ts      → detailed cost breakdown

-- ── TURNS: per-turn LLM metadata ────────────────────────────────

-- LLM response latency (currently hardcoded to 0 in workflow.ts)
ALTER TABLE turns ADD COLUMN IF NOT EXISTS llm_latency_ms INTEGER DEFAULT 0;

-- Stop reason from LLM (stop, length, tool_use, content_filter, refusal)
ALTER TABLE turns ADD COLUMN IF NOT EXISTS stop_reason TEXT;

-- Whether the LLM refused to respond (content policy)
ALTER TABLE turns ADD COLUMN IF NOT EXISTS refusal BOOLEAN DEFAULT false;

-- Cache token metrics (Anthropic prompt caching)
ALTER TABLE turns ADD COLUMN IF NOT EXISTS cache_read_tokens INTEGER DEFAULT 0;
ALTER TABLE turns ADD COLUMN IF NOT EXISTS cache_write_tokens INTEGER DEFAULT 0;

-- AI Gateway correlation ID for cross-referencing CF AI Gateway logs
ALTER TABLE turns ADD COLUMN IF NOT EXISTS gateway_log_id TEXT;

-- ── SESSIONS: session-level observability ────────────────────────

-- Feature flags active during this session (snapshot at bootstrap)
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS feature_flags_json TEXT;

-- Detailed cost breakdown (input/output/cache_write/cache_read/cache_savings)
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS detailed_cost_json TEXT;

-- Total cache tokens for the session (enables cache hit rate calculation)
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS total_cache_read_tokens INTEGER DEFAULT 0;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS total_cache_write_tokens INTEGER DEFAULT 0;

-- Number of conversation repair events (orphaned tool calls fixed)
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS repair_count INTEGER DEFAULT 0;

-- Number of context compressions triggered
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS compaction_count INTEGER DEFAULT 0;

-- ── INDEXES for new observability queries ────────────────────────

-- Meta-agent queries: "show me sessions where caching was effective"
CREATE INDEX IF NOT EXISTS idx_sessions_cache ON sessions(org_id, total_cache_read_tokens)
  WHERE total_cache_read_tokens > 0;

-- Meta-agent queries: "show me turns with refusals"
CREATE INDEX IF NOT EXISTS idx_turns_refusal ON turns(created_at DESC)
  WHERE refusal = true;

-- Dashboard/meta-agent: "latency percentiles by model"
CREATE INDEX IF NOT EXISTS idx_turns_model_latency ON turns(model_used, llm_latency_ms)
  WHERE llm_latency_ms > 0;

-- Meta-agent: "which sessions had conversation repairs?"
CREATE INDEX IF NOT EXISTS idx_sessions_repairs ON sessions(org_id, repair_count)
  WHERE repair_count > 0;
