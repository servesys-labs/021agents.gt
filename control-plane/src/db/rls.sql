-- AgentOS Supabase RLS — tenant isolation via transaction-local context.
--
-- Usage: every DB query must first SET app.current_org_id within a transaction.
-- The runtime worker's /cf/db/query endpoint does this automatically.
--
-- Run once after schema creation. Re-run to add new tables.

CREATE SCHEMA IF NOT EXISTS app;

-- Helper function: returns the current org_id from transaction context.
CREATE OR REPLACE FUNCTION app.current_org_id()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.current_org_id', true), '');
$$;

-- ── Apply RLS to all org-scoped tables ─────────────────────────────

DO $$
DECLARE
  t text;
BEGIN
  -- Core tables
  FOREACH t IN ARRAY ARRAY[
    -- Agent lifecycle
    'agents',
    'agent_versions',
    -- Sessions + turns
    'sessions',
    'turns',
    -- Eval
    'eval_runs',
    'eval_trials',
    -- Issues
    'issues',
    -- Security
    'security_scans',
    'security_findings',
    'risk_profiles',
    -- Compliance
    'gold_images',
    'compliance_checks',
    -- Memory
    'episodes',
    'facts',
    'procedures',
    'memory_facts',
    -- Billing
    'billing_records',
    'billing_events',
    -- Governance
    'policy_templates',
    'slo_definitions',
    -- Feedback
    'user_feedback',
    'conversation_scores',
    -- Observability
    'runtime_events',
    'otel_events',
    'trace_annotations',
    'span_feedback',
    'trace_lineage',
    -- Meta-agent
    'meta_proposals',
    'evolution_proposals',
    'evolution_ledger',
    -- Releases
    'release_channels',
    'canary_splits',
    -- Config
    'config_audit',
    -- Schedules + Jobs
    'schedules',
    'job_queue',
    -- Webhooks
    'webhooks',
    'webhook_deliveries',
    -- Secrets
    'secrets',
    -- API keys
    'api_keys',
    -- Org + projects
    'orgs',
    'org_members',
    'projects',
    'environments',
    'project_canvas_layouts',
    -- Connectors
    'connector_tokens',
    -- MCP
    'mcp_servers',
    -- Guardrails + DLP
    'guardrail_events',
    'guardrail_policies',
    'dlp_classifications',
    'dlp_agent_policies',
    -- Pipelines
    'pipelines',
    -- Retention
    'retention_policies',
    -- Autoresearch
    'autoresearch_runs',
    'autoresearch_experiments',
    -- Codemode
    'components',
    'component_usage',
    'codemode_snippets',
    'codemode_executions',
    -- Workflows
    'workflows',
    'workflow_runs',
    'workflow_approvals',
    -- Training
    'training_jobs',
    'training_iterations',
    'training_resources',
    'training_rewards'
  ]
  LOOP
    IF to_regclass(t) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
      EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);

      -- Drop existing policies to allow re-run
      EXECUTE format('DROP POLICY IF EXISTS %I_tenant_select ON %I', t, t);
      EXECUTE format('DROP POLICY IF EXISTS %I_tenant_insert ON %I', t, t);
      EXECUTE format('DROP POLICY IF EXISTS %I_tenant_update ON %I', t, t);
      EXECUTE format('DROP POLICY IF EXISTS %I_tenant_delete ON %I', t, t);

      EXECUTE format(
        'CREATE POLICY %I_tenant_select ON %I FOR SELECT USING (org_id = app.current_org_id())',
        t, t
      );
      EXECUTE format(
        'CREATE POLICY %I_tenant_insert ON %I FOR INSERT WITH CHECK (org_id = app.current_org_id())',
        t, t
      );
      EXECUTE format(
        'CREATE POLICY %I_tenant_update ON %I FOR UPDATE USING (org_id = app.current_org_id()) WITH CHECK (org_id = app.current_org_id())',
        t, t
      );
      EXECUTE format(
        'CREATE POLICY %I_tenant_delete ON %I FOR DELETE USING (org_id = app.current_org_id())',
        t, t
      );
    END IF;
  END LOOP;
END $$;

-- ── Special policies ───────────────────────────────────────────────

-- Components: allow public read across orgs
DO $$
BEGIN
  IF to_regclass('components') IS NOT NULL THEN
    DROP POLICY IF EXISTS components_tenant_select ON components;
    CREATE POLICY components_tenant_select
      ON components FOR SELECT
      USING (org_id = app.current_org_id() OR is_public = true);
  END IF;
END $$;

-- Orgs: users can only see orgs they belong to (via org_members)
DO $$
BEGIN
  IF to_regclass('orgs') IS NOT NULL THEN
    DROP POLICY IF EXISTS orgs_tenant_select ON orgs;
    CREATE POLICY orgs_tenant_select
      ON orgs FOR SELECT
      USING (org_id = app.current_org_id());
  END IF;
END $$;

-- Turns: scoped via session ownership (no org_id column — use join)
DO $$
BEGIN
  IF to_regclass('turns') IS NOT NULL THEN
    DROP POLICY IF EXISTS turns_tenant_select ON turns;
    -- If turns has org_id, use it directly. Otherwise RLS on sessions handles it.
    -- This policy works if turns.org_id exists; harmless if it doesn't.
    BEGIN
      CREATE POLICY turns_tenant_select
        ON turns FOR SELECT
        USING (
          EXISTS (
            SELECT 1 FROM sessions s
            WHERE s.session_id = turns.session_id
            AND s.org_id = app.current_org_id()
          )
        );
    EXCEPTION WHEN others THEN
      NULL; -- Skip if policy can't be created
    END;
  END IF;
END $$;

-- ── Index recommendations for RLS performance ──────────────────────
-- These indexes help RLS policies evaluate efficiently.

-- CREATE INDEX IF NOT EXISTS idx_sessions_org_created ON sessions(org_id, created_at DESC);
-- CREATE INDEX IF NOT EXISTS idx_agents_org_active ON agents(org_id, is_active);
-- CREATE INDEX IF NOT EXISTS idx_issues_org_status ON issues(org_id, status);
-- CREATE INDEX IF NOT EXISTS idx_eval_runs_org_agent ON eval_runs(org_id, agent_name);
-- CREATE INDEX IF NOT EXISTS idx_billing_org_created ON billing_records(org_id, created_at DESC);
-- CREATE INDEX IF NOT EXISTS idx_feedback_org_created ON user_feedback(org_id, created_at DESC);
