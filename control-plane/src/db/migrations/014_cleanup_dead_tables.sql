-- Migration 014: Drop dead tables and unused columns
-- These tables have zero code references after the graph system was deleted
-- and the platform migrated to Cloudflare Workflows.

-- Dead tables (zero reads, zero writes in any .ts file)
DROP TABLE IF EXISTS graph_snapshots;
DROP TABLE IF EXISTS node_checkpoints;
DROP TABLE IF EXISTS langchain_tools;
DROP TABLE IF EXISTS schema_validation_errors;
DROP TABLE IF EXISTS codemode_executions;
DROP TABLE IF EXISTS a2a_agents;
DROP TABLE IF EXISTS auth_audit_log;
DROP TABLE IF EXISTS prompt_versions;

-- Graph component tables (routes/components.ts deleted)
DROP TABLE IF EXISTS component_usage;
DROP TABLE IF EXISTS components;
DROP TABLE IF EXISTS subgraph_definitions;

-- Unused columns on org_settings (added in migration 008 but never read/written)
-- Using IF EXISTS to be safe on different Postgres versions
DO $$ BEGIN
  ALTER TABLE org_settings DROP COLUMN IF EXISTS budget_alert_pct;
  ALTER TABLE org_settings DROP COLUMN IF EXISTS daily_budget_usd;
  ALTER TABLE org_settings DROP COLUMN IF EXISTS monthly_budget_usd;
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

-- Unused columns on org_members (added in migration 009 but never used)
DO $$ BEGIN
  ALTER TABLE org_members DROP COLUMN IF EXISTS last_login_at;
  ALTER TABLE org_members DROP COLUMN IF EXISTS last_login_ip;
EXCEPTION WHEN undefined_table THEN NULL;
END $$;
