-- Migration 015: Delegation observability + A2A persistence + schema fixes
-- Adds tables for tracking multi-agent delegation chains and A2A transactions.
-- Fixes critical schema mismatches that caused silent failures.

-- ══════════════════════════════════════════════════════════════════
-- 1. Fix credit_transactions CHECK constraint to allow transfers
-- ══════════════════════════════════════════════════════════════════

-- Drop the old constraint and add a new one with transfer types
ALTER TABLE credit_transactions DROP CONSTRAINT IF EXISTS credit_transactions_type_check;
ALTER TABLE credit_transactions ADD CONSTRAINT credit_transactions_type_check
  CHECK (type IN ('purchase', 'burn', 'refund', 'adjustment', 'bonus', 'transfer_in', 'transfer_out'));

-- ══════════════════════════════════════════════════════════════════
-- 2. Ensure credit columns use _usd (code uses _usd everywhere)
-- ══════════════════════════════════════════════════════════════════

-- Add _usd columns if they don't exist (migration is idempotent)
DO $$ BEGIN
  -- org_credit_balance: add _usd columns if missing
  ALTER TABLE org_credit_balance ADD COLUMN IF NOT EXISTS balance_usd NUMERIC(20,6) DEFAULT 0;
  ALTER TABLE org_credit_balance ADD COLUMN IF NOT EXISTS lifetime_purchased_usd NUMERIC(20,6) DEFAULT 0;
  ALTER TABLE org_credit_balance ADD COLUMN IF NOT EXISTS lifetime_consumed_usd NUMERIC(20,6) DEFAULT 0;
  ALTER TABLE org_credit_balance ADD COLUMN IF NOT EXISTS last_deduction_at TIMESTAMPTZ;
  ALTER TABLE org_credit_balance ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

  -- credit_transactions: add _usd columns if missing
  ALTER TABLE credit_transactions ADD COLUMN IF NOT EXISTS amount_usd NUMERIC(20,6) DEFAULT 0;
  ALTER TABLE credit_transactions ADD COLUMN IF NOT EXISTS balance_after_usd NUMERIC(20,6) DEFAULT 0;
  ALTER TABLE credit_transactions ADD COLUMN IF NOT EXISTS reference_type TEXT DEFAULT '';
  ALTER TABLE credit_transactions ADD COLUMN IF NOT EXISTS agent_name TEXT DEFAULT '';
  ALTER TABLE credit_transactions ADD COLUMN IF NOT EXISTS session_id TEXT DEFAULT '';
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

-- ══════════════════════════════════════════════════════════════════
-- 3. Delegation events table
-- ══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS delegation_events (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  parent_session_id TEXT NOT NULL,
  child_session_id TEXT NOT NULL,
  parent_agent_name TEXT NOT NULL,
  child_agent_name TEXT NOT NULL,
  org_id TEXT NOT NULL,
  depth INTEGER NOT NULL DEFAULT 0,
  correlation_id TEXT,
  status TEXT NOT NULL DEFAULT 'running',  -- running, completed, failed, timeout
  child_cost_usd NUMERIC(20,6) DEFAULT 0,
  input_preview TEXT,       -- first 500 chars of delegated task
  output_preview TEXT,      -- first 500 chars of child output
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_delegation_events_parent ON delegation_events(parent_session_id);
CREATE INDEX IF NOT EXISTS idx_delegation_events_org ON delegation_events(org_id, created_at DESC);

-- ══════════════════════════════════════════════════════════════════
-- 4. A2A tasks table (persistent, replaces in-memory Map)
-- ══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS a2a_tasks (
  task_id TEXT PRIMARY KEY,
  caller_org_id TEXT NOT NULL,
  callee_org_id TEXT NOT NULL,
  caller_agent_name TEXT,
  callee_agent_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'working',  -- working, completed, failed, cancelled
  input_text TEXT,
  output_text TEXT,
  transfer_id TEXT,         -- links to credit_transactions.reference_id
  amount_usd NUMERIC(20,6) DEFAULT 0,
  cost_usd NUMERIC(20,6) DEFAULT 0,
  error_message TEXT,
  metadata_json TEXT DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_a2a_tasks_caller ON a2a_tasks(caller_org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_a2a_tasks_callee ON a2a_tasks(callee_org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_a2a_tasks_transfer ON a2a_tasks(transfer_id);

-- ══════════════════════════════════════════════════════════════════
-- 5. A2A transaction summary view (for revenue/cost queries)
-- ══════════════════════════════════════════════════════════════════

CREATE OR REPLACE VIEW a2a_revenue_summary AS
SELECT
  callee_org_id AS org_id,
  callee_agent_name AS agent_name,
  COUNT(*) AS total_tasks,
  COUNT(*) FILTER (WHERE status = 'completed') AS completed_tasks,
  COALESCE(SUM(amount_usd) FILTER (WHERE status = 'completed'), 0) AS total_revenue_usd,
  COALESCE(AVG(cost_usd) FILTER (WHERE status = 'completed'), 0) AS avg_cost_per_task_usd
FROM a2a_tasks
GROUP BY callee_org_id, callee_agent_name;
