-- Migration 023: Create tables required by hardening features
-- Phase 7.8 Skills, Phase 10.4 Audit Trail, Observability Turns
-- All statements use IF NOT EXISTS for safe re-runs.

-- ══════════════════════════════════════════════════════════════════════
-- 1. Skills table — stores reusable prompt-based workflows per org
-- Referenced by: control-plane/src/routes/skills.ts, deploy/src/runtime/skills.ts
-- ══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS skills (
  skill_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      TEXT NOT NULL,
  agent_name  TEXT,           -- NULL = available to all agents in org
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  when_to_use TEXT NOT NULL DEFAULT '',
  prompt      TEXT NOT NULL DEFAULT '',
  prompt_template TEXT NOT NULL DEFAULT '',  -- alias used by runtime skills.ts
  required_tools JSONB DEFAULT '[]'::jsonb,
  allowed_tools  JSONB DEFAULT '[]'::jsonb,  -- alias used by runtime
  version     TEXT NOT NULL DEFAULT '1.0.0',
  category    TEXT NOT NULL DEFAULT 'general',
  is_active   BOOLEAN NOT NULL DEFAULT true,
  enabled     BOOLEAN NOT NULL DEFAULT true,  -- alias used by runtime
  created_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(org_id, name)
);

CREATE INDEX IF NOT EXISTS idx_skills_org_agent ON skills(org_id, agent_name);
CREATE INDEX IF NOT EXISTS idx_skills_org_name ON skills(org_id, name);

-- ══════════════════════════════════════════════════════════════════════
-- 2. Audit log — tracks policy-relevant config changes for compliance
-- Referenced by: control-plane/src/routes/agents.ts (Phase 10.4)
-- ══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS audit_log (
  id          BIGSERIAL PRIMARY KEY,
  org_id      TEXT NOT NULL,
  actor_id    TEXT NOT NULL,        -- user_id who made the change
  action      TEXT NOT NULL,        -- 'config_change', 'skill_create', 'training_start', etc.
  resource_type TEXT NOT NULL,      -- 'agent', 'skill', 'policy', etc.
  resource_name TEXT NOT NULL,      -- agent name, skill name, etc.
  details     JSONB DEFAULT '{}'::jsonb,  -- { field, old_hash, new_hash, version }
  ip_address  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_org ON audit_log(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_resource ON audit_log(org_id, resource_type, resource_name);

-- ══════════════════════════════════════════════════════════════════════
-- 3. Turns table — per-turn telemetry for sessions
-- Referenced by: control-plane/src/routes/dashboard.ts (tool-health query),
--                control-plane/src/routes/sessions.ts (turns endpoint),
--                deploy/src/workflow.ts (telemetry writes)
-- ══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS turns (
  turn_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    TEXT NOT NULL,
  turn_number   INTEGER NOT NULL,
  model_used    TEXT,
  llm_content   TEXT,
  input_tokens  INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  cost_total_usd NUMERIC(12, 6) DEFAULT 0,
  latency_ms    INTEGER DEFAULT 0,
  tool_calls_json  TEXT,       -- JSON array of { name, arguments }
  tool_results_json TEXT,      -- JSON array of { name, result, latency_ms, cost_usd, error }
  errors_json   TEXT,          -- JSON array of error strings
  execution_mode TEXT DEFAULT 'sequential',
  plan_artifact  TEXT,         -- JSON for plan-then-execute strategy output
  reflection     TEXT,         -- JSON for verify-then-respond strategy output
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id, turn_number);
CREATE INDEX IF NOT EXISTS idx_turns_created ON turns(created_at DESC);

-- ══════════════════════════════════════════════════════════════════════
-- 4. Add credibility columns to marketplace_ratings (Phase 10.2)
-- ══════════════════════════════════════════════════════════════════════

ALTER TABLE marketplace_ratings ADD COLUMN IF NOT EXISTS credibility_weight NUMERIC(4, 2) DEFAULT 1.0;
ALTER TABLE marketplace_ratings ADD COLUMN IF NOT EXISTS raw_rating INTEGER;
