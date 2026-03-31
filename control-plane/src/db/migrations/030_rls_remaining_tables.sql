-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 030: Enable RLS on remaining 67 tables not covered by 028
-- ═══════════════════════════════════════════════════════════════════════════
-- 028 covered ~72 tables. This catches the remaining ones.
-- Uses the same pattern: org-scoped for tables with org_id,
-- service-only for tables without.
-- ═══════════════════════════════════════════════════════════════════════════

-- Recreate helper (028 dropped it)
CREATE OR REPLACE FUNCTION enable_org_rls(tbl TEXT) RETURNS VOID AS $$
BEGIN
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tbl);
  BEGIN
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL TO service_role USING (true) WITH CHECK (true)',
      tbl || '_service_role', tbl
    );
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
  BEGIN
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL TO authenticated USING (org_id = auth.jwt() ->> ''org_id'') WITH CHECK (org_id = auth.jwt() ->> ''org_id'')',
      tbl || '_org_isolation', tbl
    );
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
END;
$$ LANGUAGE plpgsql;

-- ═══════════════════════════════════════════════════════════════════════
-- 1. Tables with org_id — org-scoped RLS (50 tables)
-- ═══════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOR tbl IN
    SELECT unnest(ARRAY[
      'agent_policies',
      'agent_procedures',
      'autoresearch_experiments',
      'autoresearch_runs',
      'billing_events',
      'canary_splits',
      'codemode_snippets',
      'compliance_checks',
      'component_usage',
      'components',
      'conversation_analytics',
      'conversation_scores',
      'conversations',
      'dlp_agent_policies',
      'dlp_classifications',
      'gold_images',
      'gpu_endpoints',
      'issues',
      'job_queue',
      'marketplace_featured',
      'mcp_servers',
      'meta_proposals',
      'org_members',
      'orgs',
      'policy_templates',
      'project_canvas_layouts',
      'project_configs',
      'projects',
      'release_channels',
      'retention_policies',
      'risk_profiles',
      'runtime_events',
      'secrets',
      'security_findings',
      'security_scans',
      'session_progress',
      'slo_definitions',
      'span_feedback',
      'subgraph_definitions',
      'team_facts',
      'team_observations',
      'trace_annotations',
      'trace_lineage',
      'vapi_calls',
      'vapi_events',
      'voice_calls',
      'voice_events',
      'webhooks',
      'workflow_approvals',
      'workflows'
    ])
  LOOP
    BEGIN
      PERFORM enable_org_rls(tbl);
    EXCEPTION WHEN undefined_table THEN
      RAISE NOTICE 'Skipping % (table does not exist)', tbl;
    END;
  END LOOP;
END $$;

-- ═══════════════════════════════════════════════════════════════════════
-- 2. Tables without org_id — service-role only (17 tables)
-- ═══════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOR tbl IN
    SELECT unnest(ARRAY[
      'connector_tools',
      'conversation_messages',
      'conversation_messages_legacy',
      'cost_ledger',
      'environments',
      'episodes',
      'event_types',
      'evolution_entries',
      'facts',
      'marketplace_queries',
      'middleware_events',
      'otel_events',
      'pricing_catalog',
      'procedures',
      'session_feedback',
      'users',
      'workflow_runs'
    ])
  LOOP
    BEGIN
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
      EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tbl);
      BEGIN
        EXECUTE format(
          'CREATE POLICY %I ON %I FOR ALL TO service_role USING (true) WITH CHECK (true)',
          tbl || '_service_only', tbl
        );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END;
    EXCEPTION WHEN undefined_table THEN
      RAISE NOTICE 'Skipping % (table does not exist)', tbl;
    END;
  END LOOP;
END $$;

-- ═══════════════════════════════════════════════════════════════════════
-- 3. Revoke anon on all tables (catch any new ones since 028)
-- ═══════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  tbl RECORD;
BEGIN
  FOR tbl IN
    SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  LOOP
    BEGIN
      EXECUTE format('REVOKE ALL ON %I FROM anon', tbl.tablename);
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END LOOP;
END $$;

-- Cleanup
DROP FUNCTION IF EXISTS enable_org_rls(TEXT);
