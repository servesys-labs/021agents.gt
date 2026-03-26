-- Supabase / Postgres RLS baseline for AgentOS multi-tenant tables.
-- Applies tenant isolation based on transaction-local context:
--   set_config('app.current_org_id', '<org-id>', true)
--
-- Recommended execution:
-- 1) Run this script after schema creation.
-- 2) Ensure service workers set app.current_org_id per request/transaction.

CREATE SCHEMA IF NOT EXISTS app;

CREATE OR REPLACE FUNCTION app.current_org_id()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.current_org_id', true), '');
$$;

-- Generic tenant policy set for tables that are strictly org-scoped.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'components',
    'component_usage',
    'subgraph_definitions',
    'prompt_versions',
    'graph_snapshots',
    'langchain_tools',
    'codemode_snippets',
    'codemode_executions',
    'workflow_approvals'
  ]
  LOOP
    IF to_regclass(t) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
      EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);

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

-- Components can be publicly readable across orgs when is_public = true.
DO $$
BEGIN
  IF to_regclass('components') IS NOT NULL THEN
    DROP POLICY IF EXISTS components_tenant_select ON components;
    CREATE POLICY components_tenant_select
      ON components
      FOR SELECT
      USING (org_id = app.current_org_id() OR is_public = true);
  END IF;
END $$;

-- Optional hardening note:
-- If additional tenant tables are added, include them here immediately.
