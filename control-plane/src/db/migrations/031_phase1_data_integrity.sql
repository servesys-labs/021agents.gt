-- Migration 031: Phase 1 Data Integrity
-- Converts text _json columns to jsonb, fixes org_id NOT NULL,
-- fixes created_at types/nullability, adds PKs, fixes nullable status.
-- Each unit wrapped in DO block with exception handling.

-----------------------------------------------------------------------
-- SECTION 1: Convert *_json text columns to jsonb (95 columns)
-----------------------------------------------------------------------

-- Array-valued columns get '[]'::jsonb default; object-valued get '{}'::jsonb.
-- Array columns: tags, tools, steps, intents, topics, matches, errors,
--   tool_calls, tool_results, middleware_warnings, eval_conditions, eval_tasks,
--   skills_active, middleware_chain, feature_flags, failure_patterns

-- Helper: object-default conversions
DO $$ BEGIN
  UPDATE a2a_tasks SET metadata_json = '{}' WHERE metadata_json IS NULL OR metadata_json = '' OR metadata_json !~ '^\s*[\[\{]';
  ALTER TABLE a2a_tasks ALTER COLUMN metadata_json DROP DEFAULT;
  ALTER TABLE a2a_tasks ALTER COLUMN metadata_json TYPE jsonb USING metadata_json::jsonb;
  ALTER TABLE a2a_tasks ALTER COLUMN metadata_json SET DEFAULT '{}'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert a2a_tasks.metadata_json: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE agent_policies SET config_json = '{}' WHERE config_json IS NULL OR config_json = '' OR config_json !~ '^\s*[\[\{]';
  ALTER TABLE agent_policies ALTER COLUMN config_json DROP DEFAULT;
  ALTER TABLE agent_policies ALTER COLUMN config_json TYPE jsonb USING config_json::jsonb;
  ALTER TABLE agent_policies ALTER COLUMN config_json SET DEFAULT '{}'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert agent_policies.config_json: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE agent_versions SET config_json = '{}' WHERE config_json IS NULL OR config_json = '' OR config_json !~ '^\s*[\[\{]';
  ALTER TABLE agent_versions ALTER COLUMN config_json DROP DEFAULT;
  ALTER TABLE agent_versions ALTER COLUMN config_json TYPE jsonb USING config_json::jsonb;
  ALTER TABLE agent_versions ALTER COLUMN config_json SET DEFAULT '{}'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert agent_versions.config_json: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE agents SET config_json = '{}' WHERE config_json IS NULL OR config_json = '' OR config_json !~ '^\s*[\[\{]';
  ALTER TABLE agents ALTER COLUMN config_json DROP DEFAULT;
  ALTER TABLE agents ALTER COLUMN config_json TYPE jsonb USING config_json::jsonb;
  ALTER TABLE agents ALTER COLUMN config_json SET DEFAULT '{}'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert agents.config_json: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE audit_log SET changes_json = '{}' WHERE changes_json IS NULL OR changes_json = '' OR changes_json !~ '^\s*[\[\{]';
  ALTER TABLE audit_log ALTER COLUMN changes_json DROP DEFAULT;
  ALTER TABLE audit_log ALTER COLUMN changes_json TYPE jsonb USING changes_json::jsonb;
  ALTER TABLE audit_log ALTER COLUMN changes_json SET DEFAULT '{}'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert audit_log.changes_json: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE autoresearch_experiments SET all_metrics_json = '{}' WHERE all_metrics_json IS NULL OR all_metrics_json = '' OR all_metrics_json !~ '^\s*[\[\{]';
  ALTER TABLE autoresearch_experiments ALTER COLUMN all_metrics_json DROP DEFAULT;
  ALTER TABLE autoresearch_experiments ALTER COLUMN all_metrics_json TYPE jsonb USING all_metrics_json::jsonb;
  ALTER TABLE autoresearch_experiments ALTER COLUMN all_metrics_json SET DEFAULT '{}'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert autoresearch_experiments.all_metrics_json: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE autoresearch_experiments SET config_after_json = '{}' WHERE config_after_json IS NULL OR config_after_json = '' OR config_after_json !~ '^\s*[\[\{]';
  ALTER TABLE autoresearch_experiments ALTER COLUMN config_after_json DROP DEFAULT;
  ALTER TABLE autoresearch_experiments ALTER COLUMN config_after_json TYPE jsonb USING config_after_json::jsonb;
  ALTER TABLE autoresearch_experiments ALTER COLUMN config_after_json SET DEFAULT '{}'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert autoresearch_experiments.config_after_json: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE autoresearch_experiments SET config_before_json = '{}' WHERE config_before_json IS NULL OR config_before_json = '' OR config_before_json !~ '^\s*[\[\{]';
  ALTER TABLE autoresearch_experiments ALTER COLUMN config_before_json DROP DEFAULT;
  ALTER TABLE autoresearch_experiments ALTER COLUMN config_before_json TYPE jsonb USING config_before_json::jsonb;
  ALTER TABLE autoresearch_experiments ALTER COLUMN config_before_json SET DEFAULT '{}'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert autoresearch_experiments.config_before_json: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE autoresearch_experiments SET modification_json = '{}' WHERE modification_json IS NULL OR modification_json = '' OR modification_json !~ '^\s*[\[\{]';
  ALTER TABLE autoresearch_experiments ALTER COLUMN modification_json DROP DEFAULT;
  ALTER TABLE autoresearch_experiments ALTER COLUMN modification_json TYPE jsonb USING modification_json::jsonb;
  ALTER TABLE autoresearch_experiments ALTER COLUMN modification_json SET DEFAULT '{}'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert autoresearch_experiments.modification_json: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE autoresearch_runs SET best_config_json = '{}' WHERE best_config_json IS NULL OR best_config_json = '' OR best_config_json !~ '^\s*[\[\{]';
  ALTER TABLE autoresearch_runs ALTER COLUMN best_config_json DROP DEFAULT;
  ALTER TABLE autoresearch_runs ALTER COLUMN best_config_json TYPE jsonb USING best_config_json::jsonb;
  ALTER TABLE autoresearch_runs ALTER COLUMN best_config_json SET DEFAULT '{}'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert autoresearch_runs.best_config_json: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE compliance_checks SET drift_details_json = '{}' WHERE drift_details_json IS NULL OR drift_details_json = '' OR drift_details_json !~ '^\s*[\[\{]';
  ALTER TABLE compliance_checks ALTER COLUMN drift_details_json DROP DEFAULT;
  ALTER TABLE compliance_checks ALTER COLUMN drift_details_json TYPE jsonb USING drift_details_json::jsonb;
  ALTER TABLE compliance_checks ALTER COLUMN drift_details_json SET DEFAULT '{}'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert compliance_checks.drift_details_json: %', SQLERRM;
END $$;

-- conversation_analytics: failure_patterns is array-like, intents/topics are arrays
DO $$ BEGIN
  UPDATE conversation_analytics SET failure_patterns_json = '[]' WHERE failure_patterns_json IS NULL OR failure_patterns_json = '' OR failure_patterns_json !~ '^\s*[\[\{]';
  ALTER TABLE conversation_analytics ALTER COLUMN failure_patterns_json DROP DEFAULT;
  ALTER TABLE conversation_analytics ALTER COLUMN failure_patterns_json TYPE jsonb USING failure_patterns_json::jsonb;
  ALTER TABLE conversation_analytics ALTER COLUMN failure_patterns_json SET DEFAULT '[]'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert conversation_analytics.failure_patterns_json: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE conversation_analytics SET intents_json = '[]' WHERE intents_json IS NULL OR intents_json = '' OR intents_json !~ '^\s*[\[\{]';
  ALTER TABLE conversation_analytics ALTER COLUMN intents_json DROP DEFAULT;
  ALTER TABLE conversation_analytics ALTER COLUMN intents_json TYPE jsonb USING intents_json::jsonb;
  ALTER TABLE conversation_analytics ALTER COLUMN intents_json SET DEFAULT '[]'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert conversation_analytics.intents_json: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE conversation_analytics SET topics_json = '[]' WHERE topics_json IS NULL OR topics_json = '' OR topics_json !~ '^\s*[\[\{]';
  ALTER TABLE conversation_analytics ALTER COLUMN topics_json DROP DEFAULT;
  ALTER TABLE conversation_analytics ALTER COLUMN topics_json TYPE jsonb USING topics_json::jsonb;
  ALTER TABLE conversation_analytics ALTER COLUMN topics_json SET DEFAULT '[]'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert conversation_analytics.topics_json: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE dlp_agent_policies SET policy_json = '{}' WHERE policy_json IS NULL OR policy_json = '' OR policy_json !~ '^\s*[\[\{]';
  ALTER TABLE dlp_agent_policies ALTER COLUMN policy_json DROP DEFAULT;
  ALTER TABLE dlp_agent_policies ALTER COLUMN policy_json TYPE jsonb USING policy_json::jsonb;
  ALTER TABLE dlp_agent_policies ALTER COLUMN policy_json SET DEFAULT '{}'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert dlp_agent_policies.policy_json: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE environments SET provider_config_json = '{}' WHERE provider_config_json IS NULL OR provider_config_json = '' OR provider_config_json !~ '^\s*[\[\{]';
  ALTER TABLE environments ALTER COLUMN provider_config_json DROP DEFAULT;
  ALTER TABLE environments ALTER COLUMN provider_config_json TYPE jsonb USING provider_config_json::jsonb;
  ALTER TABLE environments ALTER COLUMN provider_config_json SET DEFAULT '{}'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert environments.provider_config_json: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE environments SET secrets_json = '{}' WHERE secrets_json IS NULL OR secrets_json = '' OR secrets_json !~ '^\s*[\[\{]';
  ALTER TABLE environments ALTER COLUMN secrets_json DROP DEFAULT;
  ALTER TABLE environments ALTER COLUMN secrets_json TYPE jsonb USING secrets_json::jsonb;
  ALTER TABLE environments ALTER COLUMN secrets_json SET DEFAULT '{}'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert environments.secrets_json: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE episodes SET metadata_json = '{}' WHERE metadata_json IS NULL OR metadata_json = '' OR metadata_json !~ '^\s*[\[\{]';
  ALTER TABLE episodes ALTER COLUMN metadata_json DROP DEFAULT;
  ALTER TABLE episodes ALTER COLUMN metadata_json TYPE jsonb USING metadata_json::jsonb;
  ALTER TABLE episodes ALTER COLUMN metadata_json SET DEFAULT '{}'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert episodes.metadata_json: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE episodic_memories SET metadata_json = '{}' WHERE metadata_json IS NULL OR metadata_json = '' OR metadata_json !~ '^\s*[\[\{]';
  ALTER TABLE episodic_memories ALTER COLUMN metadata_json DROP DEFAULT;
  ALTER TABLE episodic_memories ALTER COLUMN metadata_json TYPE jsonb USING metadata_json::jsonb;
  ALTER TABLE episodic_memories ALTER COLUMN metadata_json SET DEFAULT '{}'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert episodic_memories.metadata_json: %', SQLERRM;
END $$;

-- eval_runs: eval_conditions is array-like
DO $$ BEGIN
  UPDATE eval_runs SET eval_conditions_json = '[]' WHERE eval_conditions_json IS NULL OR eval_conditions_json = '' OR eval_conditions_json !~ '^\s*[\[\{]';
  ALTER TABLE eval_runs ALTER COLUMN eval_conditions_json DROP DEFAULT;
  ALTER TABLE eval_runs ALTER COLUMN eval_conditions_json TYPE jsonb USING eval_conditions_json::jsonb;
  ALTER TABLE eval_runs ALTER COLUMN eval_conditions_json SET DEFAULT '[]'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert eval_runs.eval_conditions_json: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE event_types SET schema_json = '{}' WHERE schema_json IS NULL OR schema_json = '' OR schema_json !~ '^\s*[\[\{]';
  ALTER TABLE event_types ALTER COLUMN schema_json DROP DEFAULT;
  ALTER TABLE event_types ALTER COLUMN schema_json TYPE jsonb USING schema_json::jsonb;
  ALTER TABLE event_types ALTER COLUMN schema_json SET DEFAULT '{}'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert event_types.schema_json: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE evolution_entries SET impact_json = '{}' WHERE impact_json IS NULL OR impact_json = '' OR impact_json !~ '^\s*[\[\{]';
  ALTER TABLE evolution_entries ALTER COLUMN impact_json DROP DEFAULT;
  ALTER TABLE evolution_entries ALTER COLUMN impact_json TYPE jsonb USING impact_json::jsonb;
  ALTER TABLE evolution_entries ALTER COLUMN impact_json SET DEFAULT '{}'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert evolution_entries.impact_json: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE evolution_entries SET metrics_after_json = '{}' WHERE metrics_after_json IS NULL OR metrics_after_json = '' OR metrics_after_json !~ '^\s*[\[\{]';
  ALTER TABLE evolution_entries ALTER COLUMN metrics_after_json DROP DEFAULT;
  ALTER TABLE evolution_entries ALTER COLUMN metrics_after_json TYPE jsonb USING metrics_after_json::jsonb;
  ALTER TABLE evolution_entries ALTER COLUMN metrics_after_json SET DEFAULT '{}'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert evolution_entries.metrics_after_json: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE evolution_entries SET metrics_before_json = '{}' WHERE metrics_before_json IS NULL OR metrics_before_json = '' OR metrics_before_json !~ '^\s*[\[\{]';
  ALTER TABLE evolution_entries ALTER COLUMN metrics_before_json DROP DEFAULT;
  ALTER TABLE evolution_entries ALTER COLUMN metrics_before_json TYPE jsonb USING metrics_before_json::jsonb;
  ALTER TABLE evolution_entries ALTER COLUMN metrics_before_json SET DEFAULT '{}'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert evolution_entries.metrics_before_json: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE evolution_entries SET modification_json = '{}' WHERE modification_json IS NULL OR modification_json = '' OR modification_json !~ '^\s*[\[\{]';
  ALTER TABLE evolution_entries ALTER COLUMN modification_json DROP DEFAULT;
  ALTER TABLE evolution_entries ALTER COLUMN modification_json TYPE jsonb USING modification_json::jsonb;
  ALTER TABLE evolution_entries ALTER COLUMN modification_json SET DEFAULT '{}'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert evolution_entries.modification_json: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE evolution_entries SET new_config_json = '{}' WHERE new_config_json IS NULL OR new_config_json = '' OR new_config_json !~ '^\s*[\[\{]';
  ALTER TABLE evolution_entries ALTER COLUMN new_config_json DROP DEFAULT;
  ALTER TABLE evolution_entries ALTER COLUMN new_config_json TYPE jsonb USING new_config_json::jsonb;
  ALTER TABLE evolution_entries ALTER COLUMN new_config_json SET DEFAULT '{}'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert evolution_entries.new_config_json: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE evolution_entries SET previous_config_json = '{}' WHERE previous_config_json IS NULL OR previous_config_json = '' OR previous_config_json !~ '^\s*[\[\{]';
  ALTER TABLE evolution_entries ALTER COLUMN previous_config_json DROP DEFAULT;
  ALTER TABLE evolution_entries ALTER COLUMN previous_config_json TYPE jsonb USING previous_config_json::jsonb;
  ALTER TABLE evolution_entries ALTER COLUMN previous_config_json SET DEFAULT '{}'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert evolution_entries.previous_config_json: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE evolution_ledger SET metrics_after_json = '{}' WHERE metrics_after_json IS NULL OR metrics_after_json = '' OR metrics_after_json !~ '^\s*[\[\{]';
  ALTER TABLE evolution_ledger ALTER COLUMN metrics_after_json DROP DEFAULT;
  ALTER TABLE evolution_ledger ALTER COLUMN metrics_after_json TYPE jsonb USING metrics_after_json::jsonb;
  ALTER TABLE evolution_ledger ALTER COLUMN metrics_after_json SET DEFAULT '{}'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert evolution_ledger.metrics_after_json: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE evolution_ledger SET metrics_before_json = '{}' WHERE metrics_before_json IS NULL OR metrics_before_json = '' OR metrics_before_json !~ '^\s*[\[\{]';
  ALTER TABLE evolution_ledger ALTER COLUMN metrics_before_json DROP DEFAULT;
  ALTER TABLE evolution_ledger ALTER COLUMN metrics_before_json TYPE jsonb USING metrics_before_json::jsonb;
  ALTER TABLE evolution_ledger ALTER COLUMN metrics_before_json SET DEFAULT '{}'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert evolution_ledger.metrics_before_json: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE evolution_ledger SET new_config_json = '{}' WHERE new_config_json IS NULL OR new_config_json = '' OR new_config_json !~ '^\s*[\[\{]';
  ALTER TABLE evolution_ledger ALTER COLUMN new_config_json DROP DEFAULT;
  ALTER TABLE evolution_ledger ALTER COLUMN new_config_json TYPE jsonb USING new_config_json::jsonb;
  ALTER TABLE evolution_ledger ALTER COLUMN new_config_json SET DEFAULT '{}'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert evolution_ledger.new_config_json: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE evolution_ledger SET previous_config_json = '{}' WHERE previous_config_json IS NULL OR previous_config_json = '' OR previous_config_json !~ '^\s*[\[\{]';
  ALTER TABLE evolution_ledger ALTER COLUMN previous_config_json DROP DEFAULT;
  ALTER TABLE evolution_ledger ALTER COLUMN previous_config_json TYPE jsonb USING previous_config_json::jsonb;
  ALTER TABLE evolution_ledger ALTER COLUMN previous_config_json SET DEFAULT '{}'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert evolution_ledger.previous_config_json: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE evolution_proposals SET config_diff_json = '{}' WHERE config_diff_json IS NULL OR config_diff_json = '' OR config_diff_json !~ '^\s*[\[\{]';
  ALTER TABLE evolution_proposals ALTER COLUMN config_diff_json DROP DEFAULT;
  ALTER TABLE evolution_proposals ALTER COLUMN config_diff_json TYPE jsonb USING config_diff_json::jsonb;
  ALTER TABLE evolution_proposals ALTER COLUMN config_diff_json SET DEFAULT '{}'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert evolution_proposals.config_diff_json: %', SQLERRM;
END $$;

-- evidence is array-like
DO $$ BEGIN
  UPDATE evolution_proposals SET evidence_json = '[]' WHERE evidence_json IS NULL OR evidence_json = '' OR evidence_json !~ '^\s*[\[\{]';
  ALTER TABLE evolution_proposals ALTER COLUMN evidence_json DROP DEFAULT;
  ALTER TABLE evolution_proposals ALTER COLUMN evidence_json TYPE jsonb USING evidence_json::jsonb;
  ALTER TABLE evolution_proposals ALTER COLUMN evidence_json SET DEFAULT '[]'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert evolution_proposals.evidence_json: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE evolution_proposals SET impact_json = '{}' WHERE impact_json IS NULL OR impact_json = '' OR impact_json !~ '^\s*[\[\{]';
  ALTER TABLE evolution_proposals ALTER COLUMN impact_json DROP DEFAULT;
  ALTER TABLE evolution_proposals ALTER COLUMN impact_json TYPE jsonb USING impact_json::jsonb;
  ALTER TABLE evolution_proposals ALTER COLUMN impact_json SET DEFAULT '{}'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert evolution_proposals.impact_json: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE evolution_reports SET report_json = '{}' WHERE report_json IS NULL OR report_json = '' OR report_json !~ '^\s*[\[\{]';
  ALTER TABLE evolution_reports ALTER COLUMN report_json DROP DEFAULT;
  ALTER TABLE evolution_reports ALTER COLUMN report_json TYPE jsonb USING report_json::jsonb;
  ALTER TABLE evolution_reports ALTER COLUMN report_json SET DEFAULT '{}'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert evolution_reports.report_json: %', SQLERRM;
END $$;

-- facts: embedding is array, value/metadata are objects
DO $$ BEGIN
  UPDATE facts SET embedding_json = '[]' WHERE embedding_json IS NULL OR embedding_json = '' OR embedding_json !~ '^\s*[\[\{]';
  ALTER TABLE facts ALTER COLUMN embedding_json DROP DEFAULT;
  ALTER TABLE facts ALTER COLUMN embedding_json TYPE jsonb USING embedding_json::jsonb;
  ALTER TABLE facts ALTER COLUMN embedding_json SET DEFAULT '[]'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert facts.embedding_json: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE facts SET metadata_json = '{}' WHERE metadata_json IS NULL OR metadata_json = '' OR metadata_json !~ '^\s*[\[\{]';
  ALTER TABLE facts ALTER COLUMN metadata_json DROP DEFAULT;
  ALTER TABLE facts ALTER COLUMN metadata_json TYPE jsonb USING metadata_json::jsonb;
  ALTER TABLE facts ALTER COLUMN metadata_json SET DEFAULT '{}'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert facts.metadata_json: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE facts SET value_json = '{}' WHERE value_json IS NULL OR value_json = '' OR value_json !~ '^\s*[\[\{]';
  ALTER TABLE facts ALTER COLUMN value_json DROP DEFAULT;
  ALTER TABLE facts ALTER COLUMN value_json TYPE jsonb USING value_json::jsonb;
  ALTER TABLE facts ALTER COLUMN value_json SET DEFAULT '{}'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert facts.value_json: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE gold_images SET config_json = '{}' WHERE config_json IS NULL OR config_json = '' OR config_json !~ '^\s*[\[\{]';
  ALTER TABLE gold_images ALTER COLUMN config_json DROP DEFAULT;
  ALTER TABLE gold_images ALTER COLUMN config_json TYPE jsonb USING config_json::jsonb;
  ALTER TABLE gold_images ALTER COLUMN config_json SET DEFAULT '{}'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert gold_images.config_json: %', SQLERRM;
END $$;

-- matches is array-like
DO $$ BEGIN
  UPDATE guardrail_events SET matches_json = '[]' WHERE matches_json IS NULL OR matches_json = '' OR matches_json !~ '^\s*[\[\{]';
  ALTER TABLE guardrail_events ALTER COLUMN matches_json DROP DEFAULT;
  ALTER TABLE guardrail_events ALTER COLUMN matches_json TYPE jsonb USING matches_json::jsonb;
  ALTER TABLE guardrail_events ALTER COLUMN matches_json SET DEFAULT '[]'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert guardrail_events.matches_json: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE guardrail_policies SET config_json = '{}' WHERE config_json IS NULL OR config_json = '' OR config_json !~ '^\s*[\[\{]';
  ALTER TABLE guardrail_policies ALTER COLUMN config_json DROP DEFAULT;
  ALTER TABLE guardrail_policies ALTER COLUMN config_json TYPE jsonb USING config_json::jsonb;
  ALTER TABLE guardrail_policies ALTER COLUMN config_json SET DEFAULT '{}'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert guardrail_policies.config_json: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE issues SET metadata_json = '{}' WHERE metadata_json IS NULL OR metadata_json = '' OR metadata_json !~ '^\s*[\[\{]';
  ALTER TABLE issues ALTER COLUMN metadata_json DROP DEFAULT;
  ALTER TABLE issues ALTER COLUMN metadata_json TYPE jsonb USING metadata_json::jsonb;
  ALTER TABLE issues ALTER COLUMN metadata_json SET DEFAULT '{}'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert issues.metadata_json: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE job_queue SET result_json = '{}' WHERE result_json IS NULL OR result_json = '' OR result_json !~ '^\s*[\[\{]';
  ALTER TABLE job_queue ALTER COLUMN result_json DROP DEFAULT;
  ALTER TABLE job_queue ALTER COLUMN result_json TYPE jsonb USING result_json::jsonb;
  ALTER TABLE job_queue ALTER COLUMN result_json SET DEFAULT '{}'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert job_queue.result_json: %', SQLERRM;
END $$;

-- tools is array-like
DO $$ BEGIN
  UPDATE mcp_servers SET tools_json = '[]' WHERE tools_json IS NULL OR tools_json = '' OR tools_json !~ '^\s*[\[\{]';
  ALTER TABLE mcp_servers ALTER COLUMN tools_json DROP DEFAULT;
  ALTER TABLE mcp_servers ALTER COLUMN tools_json TYPE jsonb USING tools_json::jsonb;
  ALTER TABLE mcp_servers ALTER COLUMN tools_json SET DEFAULT '[]'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert mcp_servers.tools_json: %', SQLERRM;
END $$;

-- evidence is array-like
DO $$ BEGIN
  UPDATE meta_proposals SET evidence_json = '[]' WHERE evidence_json IS NULL OR evidence_json = '' OR evidence_json !~ '^\s*[\[\{]';
  ALTER TABLE meta_proposals ALTER COLUMN evidence_json DROP DEFAULT;
  ALTER TABLE meta_proposals ALTER COLUMN evidence_json TYPE jsonb USING evidence_json::jsonb;
  ALTER TABLE meta_proposals ALTER COLUMN evidence_json SET DEFAULT '[]'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert meta_proposals.evidence_json: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE meta_proposals SET modification_json = '{}' WHERE modification_json IS NULL OR modification_json = '' OR modification_json !~ '^\s*[\[\{]';
  ALTER TABLE meta_proposals ALTER COLUMN modification_json DROP DEFAULT;
  ALTER TABLE meta_proposals ALTER COLUMN modification_json TYPE jsonb USING modification_json::jsonb;
  ALTER TABLE meta_proposals ALTER COLUMN modification_json SET DEFAULT '{}'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert meta_proposals.modification_json: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE middleware_events SET details_json = '{}' WHERE details_json IS NULL OR details_json = '' OR details_json !~ '^\s*[\[\{]';
  ALTER TABLE middleware_events ALTER COLUMN details_json DROP DEFAULT;
  ALTER TABLE middleware_events ALTER COLUMN details_json TYPE jsonb USING details_json::jsonb;
  ALTER TABLE middleware_events ALTER COLUMN details_json SET DEFAULT '{}'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert middleware_events.details_json: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE orgs SET settings_json = '{}' WHERE settings_json IS NULL OR settings_json = '' OR settings_json !~ '^\s*[\[\{]';
  ALTER TABLE orgs ALTER COLUMN settings_json DROP DEFAULT;
  ALTER TABLE orgs ALTER COLUMN settings_json TYPE jsonb USING settings_json::jsonb;
  ALTER TABLE orgs ALTER COLUMN settings_json SET DEFAULT '{}'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert orgs.settings_json: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE otel_events SET details_json = '{}' WHERE details_json IS NULL OR details_json = '' OR details_json !~ '^\s*[\[\{]';
  ALTER TABLE otel_events ALTER COLUMN details_json DROP DEFAULT;
  ALTER TABLE otel_events ALTER COLUMN details_json TYPE jsonb USING details_json::jsonb;
  ALTER TABLE otel_events ALTER COLUMN details_json SET DEFAULT '{}'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert otel_events.details_json: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE pipelines SET config_json = '{}' WHERE config_json IS NULL OR config_json = '' OR config_json !~ '^\s*[\[\{]';
  ALTER TABLE pipelines ALTER COLUMN config_json DROP DEFAULT;
  ALTER TABLE pipelines ALTER COLUMN config_json TYPE jsonb USING config_json::jsonb;
  ALTER TABLE pipelines ALTER COLUMN config_json SET DEFAULT '{}'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert pipelines.config_json: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE policy_templates SET policy_json = '{}' WHERE policy_json IS NULL OR policy_json = '' OR policy_json !~ '^\s*[\[\{]';
  ALTER TABLE policy_templates ALTER COLUMN policy_json DROP DEFAULT;
  ALTER TABLE policy_templates ALTER COLUMN policy_json TYPE jsonb USING policy_json::jsonb;
  ALTER TABLE policy_templates ALTER COLUMN policy_json SET DEFAULT '{}'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert policy_templates.policy_json: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE pricing_catalog SET metadata_json = '{}' WHERE metadata_json IS NULL OR metadata_json = '' OR metadata_json !~ '^\s*[\[\{]';
  ALTER TABLE pricing_catalog ALTER COLUMN metadata_json DROP DEFAULT;
  ALTER TABLE pricing_catalog ALTER COLUMN metadata_json TYPE jsonb USING metadata_json::jsonb;
  ALTER TABLE pricing_catalog ALTER COLUMN metadata_json SET DEFAULT '{}'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert pricing_catalog.metadata_json: %', SQLERRM;
END $$;

-- steps is array-like
DO $$ BEGIN
  UPDATE procedures SET steps_json = '[]' WHERE steps_json IS NULL OR steps_json = '' OR steps_json !~ '^\s*[\[\{]';
  ALTER TABLE procedures ALTER COLUMN steps_json DROP DEFAULT;
  ALTER TABLE procedures ALTER COLUMN steps_json TYPE jsonb USING steps_json::jsonb;
  ALTER TABLE procedures ALTER COLUMN steps_json SET DEFAULT '[]'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert procedures.steps_json: %', SQLERRM;
END $$;

-- assignments is array-like
DO $$ BEGIN
  UPDATE project_canvas_layouts SET assignments_json = '[]' WHERE assignments_json IS NULL OR assignments_json = '' OR assignments_json !~ '^\s*[\[\{]';
  ALTER TABLE project_canvas_layouts ALTER COLUMN assignments_json DROP DEFAULT;
  ALTER TABLE project_canvas_layouts ALTER COLUMN assignments_json TYPE jsonb USING assignments_json::jsonb;
  ALTER TABLE project_canvas_layouts ALTER COLUMN assignments_json SET DEFAULT '[]'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert project_canvas_layouts.assignments_json: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE project_canvas_layouts SET layout_json = '{}' WHERE layout_json IS NULL OR layout_json = '' OR layout_json !~ '^\s*[\[\{]';
  ALTER TABLE project_canvas_layouts ALTER COLUMN layout_json DROP DEFAULT;
  ALTER TABLE project_canvas_layouts ALTER COLUMN layout_json TYPE jsonb USING layout_json::jsonb;
  ALTER TABLE project_canvas_layouts ALTER COLUMN layout_json SET DEFAULT '{}'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert project_canvas_layouts.layout_json: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE project_configs SET config_json = '{}' WHERE config_json IS NULL OR config_json = '' OR config_json !~ '^\s*[\[\{]';
  ALTER TABLE project_configs ALTER COLUMN config_json DROP DEFAULT;
  ALTER TABLE project_configs ALTER COLUMN config_json TYPE jsonb USING config_json::jsonb;
  ALTER TABLE project_configs ALTER COLUMN config_json SET DEFAULT '{}'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert project_configs.config_json: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE projects SET settings_json = '{}' WHERE settings_json IS NULL OR settings_json = '' OR settings_json !~ '^\s*[\[\{]';
  ALTER TABLE projects ALTER COLUMN settings_json DROP DEFAULT;
  ALTER TABLE projects ALTER COLUMN settings_json TYPE jsonb USING settings_json::jsonb;
  ALTER TABLE projects ALTER COLUMN settings_json SET DEFAULT '{}'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert projects.settings_json: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE release_channels SET config_json = '{}' WHERE config_json IS NULL OR config_json = '' OR config_json !~ '^\s*[\[\{]';
  ALTER TABLE release_channels ALTER COLUMN config_json DROP DEFAULT;
  ALTER TABLE release_channels ALTER COLUMN config_json TYPE jsonb USING config_json::jsonb;
  ALTER TABLE release_channels ALTER COLUMN config_json SET DEFAULT '{}'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert release_channels.config_json: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE runtime_events SET payload_json = '{}' WHERE payload_json IS NULL OR payload_json = '' OR payload_json !~ '^\s*[\[\{]';
  ALTER TABLE runtime_events ALTER COLUMN payload_json DROP DEFAULT;
  ALTER TABLE runtime_events ALTER COLUMN payload_json TYPE jsonb USING payload_json::jsonb;
  ALTER TABLE runtime_events ALTER COLUMN payload_json SET DEFAULT '{}'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert runtime_events.payload_json: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE sessions SET composition_json = '{}' WHERE composition_json IS NULL OR composition_json = '' OR composition_json !~ '^\s*[\[\{]';
  ALTER TABLE sessions ALTER COLUMN composition_json DROP DEFAULT;
  ALTER TABLE sessions ALTER COLUMN composition_json TYPE jsonb USING composition_json::jsonb;
  ALTER TABLE sessions ALTER COLUMN composition_json SET DEFAULT '{}'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert sessions.composition_json: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE sessions SET detailed_cost_json = '{}' WHERE detailed_cost_json IS NULL OR detailed_cost_json = '' OR detailed_cost_json !~ '^\s*[\[\{]';
  ALTER TABLE sessions ALTER COLUMN detailed_cost_json DROP DEFAULT;
  ALTER TABLE sessions ALTER COLUMN detailed_cost_json TYPE jsonb USING detailed_cost_json::jsonb;
  ALTER TABLE sessions ALTER COLUMN detailed_cost_json SET DEFAULT '{}'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert sessions.detailed_cost_json: %', SQLERRM;
END $$;

-- eval_conditions, skills_active, middleware_chain, feature_flags are array-like
DO $$ BEGIN
  UPDATE sessions SET eval_conditions_json = '[]' WHERE eval_conditions_json IS NULL OR eval_conditions_json = '' OR eval_conditions_json !~ '^\s*[\[\{]';
  ALTER TABLE sessions ALTER COLUMN eval_conditions_json DROP DEFAULT;
  ALTER TABLE sessions ALTER COLUMN eval_conditions_json TYPE jsonb USING eval_conditions_json::jsonb;
  ALTER TABLE sessions ALTER COLUMN eval_conditions_json SET DEFAULT '[]'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert sessions.eval_conditions_json: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE sessions SET feature_flags_json = '{}' WHERE feature_flags_json IS NULL OR feature_flags_json = '' OR feature_flags_json !~ '^\s*[\[\{]';
  ALTER TABLE sessions ALTER COLUMN feature_flags_json DROP DEFAULT;
  ALTER TABLE sessions ALTER COLUMN feature_flags_json TYPE jsonb USING feature_flags_json::jsonb;
  ALTER TABLE sessions ALTER COLUMN feature_flags_json SET DEFAULT '{}'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert sessions.feature_flags_json: %', SQLERRM;
END $$;

-- middleware_chain is array-like
DO $$ BEGIN
  UPDATE sessions SET middleware_chain_json = '[]' WHERE middleware_chain_json IS NULL OR middleware_chain_json = '' OR middleware_chain_json !~ '^\s*[\[\{]';
  ALTER TABLE sessions ALTER COLUMN middleware_chain_json DROP DEFAULT;
  ALTER TABLE sessions ALTER COLUMN middleware_chain_json TYPE jsonb USING middleware_chain_json::jsonb;
  ALTER TABLE sessions ALTER COLUMN middleware_chain_json SET DEFAULT '[]'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert sessions.middleware_chain_json: %', SQLERRM;
END $$;

-- skills_active is array-like
DO $$ BEGIN
  UPDATE sessions SET skills_active_json = '[]' WHERE skills_active_json IS NULL OR skills_active_json = '' OR skills_active_json !~ '^\s*[\[\{]';
  ALTER TABLE sessions ALTER COLUMN skills_active_json DROP DEFAULT;
  ALTER TABLE sessions ALTER COLUMN skills_active_json TYPE jsonb USING skills_active_json::jsonb;
  ALTER TABLE sessions ALTER COLUMN skills_active_json SET DEFAULT '[]'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert sessions.skills_active_json: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE span_feedback SET labels_json = '{}' WHERE labels_json IS NULL OR labels_json = '' OR labels_json !~ '^\s*[\[\{]';
  ALTER TABLE span_feedback ALTER COLUMN labels_json DROP DEFAULT;
  ALTER TABLE span_feedback ALTER COLUMN labels_json TYPE jsonb USING labels_json::jsonb;
  ALTER TABLE span_feedback ALTER COLUMN labels_json SET DEFAULT '{}'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert span_feedback.labels_json: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE tool_executions SET arguments_json = '{}' WHERE arguments_json IS NULL OR arguments_json = '' OR arguments_json !~ '^\s*[\[\{]';
  ALTER TABLE tool_executions ALTER COLUMN arguments_json DROP DEFAULT;
  ALTER TABLE tool_executions ALTER COLUMN arguments_json TYPE jsonb USING arguments_json::jsonb;
  ALTER TABLE tool_executions ALTER COLUMN arguments_json SET DEFAULT '{}'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert tool_executions.arguments_json: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE tool_executions SET result_json = '{}' WHERE result_json IS NULL OR result_json = '' OR result_json !~ '^\s*[\[\{]';
  ALTER TABLE tool_executions ALTER COLUMN result_json DROP DEFAULT;
  ALTER TABLE tool_executions ALTER COLUMN result_json TYPE jsonb USING result_json::jsonb;
  ALTER TABLE tool_executions ALTER COLUMN result_json SET DEFAULT '{}'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert tool_executions.result_json: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE tool_registry SET schema_json = '{}' WHERE schema_json IS NULL OR schema_json = '' OR schema_json !~ '^\s*[\[\{]';
  ALTER TABLE tool_registry ALTER COLUMN schema_json DROP DEFAULT;
  ALTER TABLE tool_registry ALTER COLUMN schema_json TYPE jsonb USING schema_json::jsonb;
  ALTER TABLE tool_registry ALTER COLUMN schema_json SET DEFAULT '{}'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert tool_registry.schema_json: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE trace_annotations SET metadata_json = '{}' WHERE metadata_json IS NULL OR metadata_json = '' OR metadata_json !~ '^\s*[\[\{]';
  ALTER TABLE trace_annotations ALTER COLUMN metadata_json DROP DEFAULT;
  ALTER TABLE trace_annotations ALTER COLUMN metadata_json TYPE jsonb USING metadata_json::jsonb;
  ALTER TABLE trace_annotations ALTER COLUMN metadata_json SET DEFAULT '{}'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert trace_annotations.metadata_json: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE trace_lineage SET metadata_json = '{}' WHERE metadata_json IS NULL OR metadata_json = '' OR metadata_json !~ '^\s*[\[\{]';
  ALTER TABLE trace_lineage ALTER COLUMN metadata_json DROP DEFAULT;
  ALTER TABLE trace_lineage ALTER COLUMN metadata_json TYPE jsonb USING metadata_json::jsonb;
  ALTER TABLE trace_lineage ALTER COLUMN metadata_json SET DEFAULT '{}'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert trace_lineage.metadata_json: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE training_iterations SET algorithm_output_json = '{}' WHERE algorithm_output_json IS NULL OR algorithm_output_json = '' OR algorithm_output_json !~ '^\s*[\[\{]';
  ALTER TABLE training_iterations ALTER COLUMN algorithm_output_json DROP DEFAULT;
  ALTER TABLE training_iterations ALTER COLUMN algorithm_output_json TYPE jsonb USING algorithm_output_json::jsonb;
  ALTER TABLE training_iterations ALTER COLUMN algorithm_output_json SET DEFAULT '{}'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert training_iterations.algorithm_output_json: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE training_iterations SET resource_snapshot_json = '{}' WHERE resource_snapshot_json IS NULL OR resource_snapshot_json = '' OR resource_snapshot_json !~ '^\s*[\[\{]';
  ALTER TABLE training_iterations ALTER COLUMN resource_snapshot_json DROP DEFAULT;
  ALTER TABLE training_iterations ALTER COLUMN resource_snapshot_json TYPE jsonb USING resource_snapshot_json::jsonb;
  ALTER TABLE training_iterations ALTER COLUMN resource_snapshot_json SET DEFAULT '{}'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert training_iterations.resource_snapshot_json: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE training_iterations SET reward_breakdown_json = '{}' WHERE reward_breakdown_json IS NULL OR reward_breakdown_json = '' OR reward_breakdown_json !~ '^\s*[\[\{]';
  ALTER TABLE training_iterations ALTER COLUMN reward_breakdown_json DROP DEFAULT;
  ALTER TABLE training_iterations ALTER COLUMN reward_breakdown_json TYPE jsonb USING reward_breakdown_json::jsonb;
  ALTER TABLE training_iterations ALTER COLUMN reward_breakdown_json SET DEFAULT '{}'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert training_iterations.reward_breakdown_json: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE training_jobs SET config_json = '{}' WHERE config_json IS NULL OR config_json = '' OR config_json !~ '^\s*[\[\{]';
  ALTER TABLE training_jobs ALTER COLUMN config_json DROP DEFAULT;
  ALTER TABLE training_jobs ALTER COLUMN config_json TYPE jsonb USING config_json::jsonb;
  ALTER TABLE training_jobs ALTER COLUMN config_json SET DEFAULT '{}'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert training_jobs.config_json: %', SQLERRM;
END $$;

-- eval_tasks is array-like
DO $$ BEGIN
  UPDATE training_jobs SET eval_tasks_json = '[]' WHERE eval_tasks_json IS NULL OR eval_tasks_json = '' OR eval_tasks_json !~ '^\s*[\[\{]';
  ALTER TABLE training_jobs ALTER COLUMN eval_tasks_json DROP DEFAULT;
  ALTER TABLE training_jobs ALTER COLUMN eval_tasks_json TYPE jsonb USING eval_tasks_json::jsonb;
  ALTER TABLE training_jobs ALTER COLUMN eval_tasks_json SET DEFAULT '[]'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert training_jobs.eval_tasks_json: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE training_jobs SET evaluator_config_json = '{}' WHERE evaluator_config_json IS NULL OR evaluator_config_json = '' OR evaluator_config_json !~ '^\s*[\[\{]';
  ALTER TABLE training_jobs ALTER COLUMN evaluator_config_json DROP DEFAULT;
  ALTER TABLE training_jobs ALTER COLUMN evaluator_config_json TYPE jsonb USING evaluator_config_json::jsonb;
  ALTER TABLE training_jobs ALTER COLUMN evaluator_config_json SET DEFAULT '{}'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert training_jobs.evaluator_config_json: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE training_jobs SET metadata_json = '{}' WHERE metadata_json IS NULL OR metadata_json = '' OR metadata_json !~ '^\s*[\[\{]';
  ALTER TABLE training_jobs ALTER COLUMN metadata_json DROP DEFAULT;
  ALTER TABLE training_jobs ALTER COLUMN metadata_json TYPE jsonb USING metadata_json::jsonb;
  ALTER TABLE training_jobs ALTER COLUMN metadata_json SET DEFAULT '{}'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert training_jobs.metadata_json: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE training_resources SET content_json = '{}' WHERE content_json IS NULL OR content_json = '' OR content_json !~ '^\s*[\[\{]';
  ALTER TABLE training_resources ALTER COLUMN content_json DROP DEFAULT;
  ALTER TABLE training_resources ALTER COLUMN content_json TYPE jsonb USING content_json::jsonb;
  ALTER TABLE training_resources ALTER COLUMN content_json SET DEFAULT '{}'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert training_resources.content_json: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE training_rewards SET metadata_json = '{}' WHERE metadata_json IS NULL OR metadata_json = '' OR metadata_json !~ '^\s*[\[\{]';
  ALTER TABLE training_rewards ALTER COLUMN metadata_json DROP DEFAULT;
  ALTER TABLE training_rewards ALTER COLUMN metadata_json TYPE jsonb USING metadata_json::jsonb;
  ALTER TABLE training_rewards ALTER COLUMN metadata_json SET DEFAULT '{}'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert training_rewards.metadata_json: %', SQLERRM;
END $$;

-- turns: errors, tool_calls, tool_results, middleware_warnings are array-like; plan, reflection are objects
DO $$ BEGIN
  UPDATE turns SET errors_json = '[]' WHERE errors_json IS NULL OR errors_json = '' OR errors_json !~ '^\s*[\[\{]';
  ALTER TABLE turns ALTER COLUMN errors_json DROP DEFAULT;
  ALTER TABLE turns ALTER COLUMN errors_json TYPE jsonb USING errors_json::jsonb;
  ALTER TABLE turns ALTER COLUMN errors_json SET DEFAULT '[]'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert turns.errors_json: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE turns SET middleware_warnings_json = '[]' WHERE middleware_warnings_json IS NULL OR middleware_warnings_json = '' OR middleware_warnings_json !~ '^\s*[\[\{]';
  ALTER TABLE turns ALTER COLUMN middleware_warnings_json DROP DEFAULT;
  ALTER TABLE turns ALTER COLUMN middleware_warnings_json TYPE jsonb USING middleware_warnings_json::jsonb;
  ALTER TABLE turns ALTER COLUMN middleware_warnings_json SET DEFAULT '[]'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert turns.middleware_warnings_json: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE turns SET plan_json = '{}' WHERE plan_json IS NULL OR plan_json = '' OR plan_json !~ '^\s*[\[\{]';
  ALTER TABLE turns ALTER COLUMN plan_json DROP DEFAULT;
  ALTER TABLE turns ALTER COLUMN plan_json TYPE jsonb USING plan_json::jsonb;
  ALTER TABLE turns ALTER COLUMN plan_json SET DEFAULT '{}'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert turns.plan_json: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE turns SET reflection_json = '{}' WHERE reflection_json IS NULL OR reflection_json = '' OR reflection_json !~ '^\s*[\[\{]';
  ALTER TABLE turns ALTER COLUMN reflection_json DROP DEFAULT;
  ALTER TABLE turns ALTER COLUMN reflection_json TYPE jsonb USING reflection_json::jsonb;
  ALTER TABLE turns ALTER COLUMN reflection_json SET DEFAULT '{}'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert turns.reflection_json: %', SQLERRM;
END $$;

-- tool_calls and tool_results are arrays
DO $$ BEGIN
  UPDATE turns SET tool_calls_json = '[]' WHERE tool_calls_json IS NULL OR tool_calls_json = '' OR tool_calls_json !~ '^\s*[\[\{]';
  ALTER TABLE turns ALTER COLUMN tool_calls_json DROP DEFAULT;
  ALTER TABLE turns ALTER COLUMN tool_calls_json TYPE jsonb USING tool_calls_json::jsonb;
  ALTER TABLE turns ALTER COLUMN tool_calls_json SET DEFAULT '[]'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert turns.tool_calls_json: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE turns SET tool_results_json = '[]' WHERE tool_results_json IS NULL OR tool_results_json = '' OR tool_results_json !~ '^\s*[\[\{]';
  ALTER TABLE turns ALTER COLUMN tool_results_json DROP DEFAULT;
  ALTER TABLE turns ALTER COLUMN tool_results_json TYPE jsonb USING tool_results_json::jsonb;
  ALTER TABLE turns ALTER COLUMN tool_results_json SET DEFAULT '[]'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert turns.tool_results_json: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE vapi_calls SET metadata_json = '{}' WHERE metadata_json IS NULL OR metadata_json = '' OR metadata_json !~ '^\s*[\[\{]';
  ALTER TABLE vapi_calls ALTER COLUMN metadata_json DROP DEFAULT;
  ALTER TABLE vapi_calls ALTER COLUMN metadata_json TYPE jsonb USING metadata_json::jsonb;
  ALTER TABLE vapi_calls ALTER COLUMN metadata_json SET DEFAULT '{}'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert vapi_calls.metadata_json: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE vapi_events SET payload_json = '{}' WHERE payload_json IS NULL OR payload_json = '' OR payload_json !~ '^\s*[\[\{]';
  ALTER TABLE vapi_events ALTER COLUMN payload_json DROP DEFAULT;
  ALTER TABLE vapi_events ALTER COLUMN payload_json TYPE jsonb USING payload_json::jsonb;
  ALTER TABLE vapi_events ALTER COLUMN payload_json SET DEFAULT '{}'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert vapi_events.payload_json: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE voice_calls SET metadata_json = '{}' WHERE metadata_json IS NULL OR metadata_json = '' OR metadata_json !~ '^\s*[\[\{]';
  ALTER TABLE voice_calls ALTER COLUMN metadata_json DROP DEFAULT;
  ALTER TABLE voice_calls ALTER COLUMN metadata_json TYPE jsonb USING metadata_json::jsonb;
  ALTER TABLE voice_calls ALTER COLUMN metadata_json SET DEFAULT '{}'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert voice_calls.metadata_json: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE voice_events SET payload_json = '{}' WHERE payload_json IS NULL OR payload_json = '' OR payload_json !~ '^\s*[\[\{]';
  ALTER TABLE voice_events ALTER COLUMN payload_json DROP DEFAULT;
  ALTER TABLE voice_events ALTER COLUMN payload_json TYPE jsonb USING payload_json::jsonb;
  ALTER TABLE voice_events ALTER COLUMN payload_json SET DEFAULT '{}'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert voice_events.payload_json: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE webhook_deliveries SET payload_json = '{}' WHERE payload_json IS NULL OR payload_json = '' OR payload_json !~ '^\s*[\[\{]';
  ALTER TABLE webhook_deliveries ALTER COLUMN payload_json DROP DEFAULT;
  ALTER TABLE webhook_deliveries ALTER COLUMN payload_json TYPE jsonb USING payload_json::jsonb;
  ALTER TABLE webhook_deliveries ALTER COLUMN payload_json SET DEFAULT '{}'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert webhook_deliveries.payload_json: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE workflow_approvals SET context_json = '{}' WHERE context_json IS NULL OR context_json = '' OR context_json !~ '^\s*[\[\{]';
  ALTER TABLE workflow_approvals ALTER COLUMN context_json DROP DEFAULT;
  ALTER TABLE workflow_approvals ALTER COLUMN context_json TYPE jsonb USING context_json::jsonb;
  ALTER TABLE workflow_approvals ALTER COLUMN context_json SET DEFAULT '{}'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert workflow_approvals.context_json: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE workflow_runs SET dag_json = '{}' WHERE dag_json IS NULL OR dag_json = '' OR dag_json !~ '^\s*[\[\{]';
  ALTER TABLE workflow_runs ALTER COLUMN dag_json DROP DEFAULT;
  ALTER TABLE workflow_runs ALTER COLUMN dag_json TYPE jsonb USING dag_json::jsonb;
  ALTER TABLE workflow_runs ALTER COLUMN dag_json SET DEFAULT '{}'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert workflow_runs.dag_json: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE workflow_runs SET reflection_json = '{}' WHERE reflection_json IS NULL OR reflection_json = '' OR reflection_json !~ '^\s*[\[\{]';
  ALTER TABLE workflow_runs ALTER COLUMN reflection_json DROP DEFAULT;
  ALTER TABLE workflow_runs ALTER COLUMN reflection_json TYPE jsonb USING reflection_json::jsonb;
  ALTER TABLE workflow_runs ALTER COLUMN reflection_json SET DEFAULT '{}'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert workflow_runs.reflection_json: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE workflow_runs SET steps_status_json = '{}' WHERE steps_status_json IS NULL OR steps_status_json = '' OR steps_status_json !~ '^\s*[\[\{]';
  ALTER TABLE workflow_runs ALTER COLUMN steps_status_json DROP DEFAULT;
  ALTER TABLE workflow_runs ALTER COLUMN steps_status_json TYPE jsonb USING steps_status_json::jsonb;
  ALTER TABLE workflow_runs ALTER COLUMN steps_status_json SET DEFAULT '{}'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert workflow_runs.steps_status_json: %', SQLERRM;
END $$;

-- steps is array-like
DO $$ BEGIN
  UPDATE workflows SET steps_json = '[]' WHERE steps_json IS NULL OR steps_json = '' OR steps_json !~ '^\s*[\[\{]';
  ALTER TABLE workflows ALTER COLUMN steps_json DROP DEFAULT;
  ALTER TABLE workflows ALTER COLUMN steps_json TYPE jsonb USING steps_json::jsonb;
  ALTER TABLE workflows ALTER COLUMN steps_json SET DEFAULT '[]'::jsonb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert workflows.steps_json: %', SQLERRM;
END $$;

-----------------------------------------------------------------------
-- SECTION 2: Fix org_id NOT NULL on 14 tables
-----------------------------------------------------------------------

DO $$ BEGIN
  UPDATE a2a_revenue_summary SET org_id = 'default' WHERE org_id IS NULL;
  ALTER TABLE a2a_revenue_summary ALTER COLUMN org_id SET NOT NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to fix org_id NOT NULL on a2a_revenue_summary: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE auth_audit_log SET org_id = 'default' WHERE org_id IS NULL;
  ALTER TABLE auth_audit_log ALTER COLUMN org_id SET NOT NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to fix org_id NOT NULL on auth_audit_log: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE canary_splits SET org_id = 'default' WHERE org_id IS NULL;
  ALTER TABLE canary_splits ALTER COLUMN org_id SET NOT NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to fix org_id NOT NULL on canary_splits: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE eval_runs SET org_id = 'default' WHERE org_id IS NULL;
  ALTER TABLE eval_runs ALTER COLUMN org_id SET NOT NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to fix org_id NOT NULL on eval_runs: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE evolution_ledger SET org_id = 'default' WHERE org_id IS NULL;
  ALTER TABLE evolution_ledger ALTER COLUMN org_id SET NOT NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to fix org_id NOT NULL on evolution_ledger: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE evolution_proposals SET org_id = 'default' WHERE org_id IS NULL;
  ALTER TABLE evolution_proposals ALTER COLUMN org_id SET NOT NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to fix org_id NOT NULL on evolution_proposals: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE guardrail_events SET org_id = 'default' WHERE org_id IS NULL;
  ALTER TABLE guardrail_events ALTER COLUMN org_id SET NOT NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to fix org_id NOT NULL on guardrail_events: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE guardrail_policies SET org_id = 'default' WHERE org_id IS NULL;
  ALTER TABLE guardrail_policies ALTER COLUMN org_id SET NOT NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to fix org_id NOT NULL on guardrail_policies: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE meta_proposals SET org_id = 'default' WHERE org_id IS NULL;
  ALTER TABLE meta_proposals ALTER COLUMN org_id SET NOT NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to fix org_id NOT NULL on meta_proposals: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE pipelines SET org_id = 'default' WHERE org_id IS NULL;
  ALTER TABLE pipelines ALTER COLUMN org_id SET NOT NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to fix org_id NOT NULL on pipelines: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE referral_summary SET org_id = 'default' WHERE org_id IS NULL;
  ALTER TABLE referral_summary ALTER COLUMN org_id SET NOT NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to fix org_id NOT NULL on referral_summary: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE schedules SET org_id = 'default' WHERE org_id IS NULL;
  ALTER TABLE schedules ALTER COLUMN org_id SET NOT NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to fix org_id NOT NULL on schedules: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE skills SET org_id = 'default' WHERE org_id IS NULL;
  ALTER TABLE skills ALTER COLUMN org_id SET NOT NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to fix org_id NOT NULL on skills: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE user_feedback SET org_id = 'default' WHERE org_id IS NULL;
  ALTER TABLE user_feedback ALTER COLUMN org_id SET NOT NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to fix org_id NOT NULL on user_feedback: %', SQLERRM;
END $$;

-----------------------------------------------------------------------
-- SECTION 3: Fix created_at type mismatches
-----------------------------------------------------------------------

-- workflow_approvals.created_at: bigint (epoch ms) -> timestamptz
DO $$ BEGIN
  ALTER TABLE workflow_approvals
    ALTER COLUMN created_at TYPE timestamptz
    USING to_timestamp(created_at / 1000.0);
  ALTER TABLE workflow_approvals
    ALTER COLUMN created_at SET DEFAULT now();
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert workflow_approvals.created_at from bigint: %', SQLERRM;
END $$;

-- evolution_schedules.created_at: real (epoch seconds) -> timestamptz
-- Must drop default first since the real default can't auto-cast to timestamptz
DO $$ BEGIN
  ALTER TABLE evolution_schedules ALTER COLUMN created_at DROP DEFAULT;
  ALTER TABLE evolution_schedules
    ALTER COLUMN created_at TYPE timestamptz
    USING to_timestamp(created_at);
  ALTER TABLE evolution_schedules
    ALTER COLUMN created_at SET DEFAULT now();
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to convert evolution_schedules.created_at from real: %', SQLERRM;
END $$;

-----------------------------------------------------------------------
-- SECTION 4: Add created_at to 17 tables missing it
-----------------------------------------------------------------------

DO $$ BEGIN
  ALTER TABLE account_deletion_requests ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to add created_at to account_deletion_requests: %', SQLERRM;
END $$;

DO $$ BEGIN
  ALTER TABLE autoresearch_runs ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to add created_at to autoresearch_runs: %', SQLERRM;
END $$;

DO $$ BEGIN
  ALTER TABLE component_usage ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to add created_at to component_usage: %', SQLERRM;
END $$;

DO $$ BEGIN
  ALTER TABLE data_export_requests ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to add created_at to data_export_requests: %', SQLERRM;
END $$;

DO $$ BEGIN
  ALTER TABLE feature_flags ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to add created_at to feature_flags: %', SQLERRM;
END $$;

DO $$ BEGIN
  ALTER TABLE network_stats ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to add created_at to network_stats: %', SQLERRM;
END $$;

DO $$ BEGIN
  ALTER TABLE org_credit_balance ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to add created_at to org_credit_balance: %', SQLERRM;
END $$;

DO $$ BEGIN
  ALTER TABLE procedures ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to add created_at to procedures: %', SQLERRM;
END $$;

DO $$ BEGIN
  ALTER TABLE project_canvas_layouts ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to add created_at to project_canvas_layouts: %', SQLERRM;
END $$;

DO $$ BEGIN
  ALTER TABLE project_configs ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to add created_at to project_configs: %', SQLERRM;
END $$;

DO $$ BEGIN
  ALTER TABLE risk_profiles ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to add created_at to risk_profiles: %', SQLERRM;
END $$;

DO $$ BEGIN
  ALTER TABLE secrets_key_rotations ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to add created_at to secrets_key_rotations: %', SQLERRM;
END $$;

DO $$ BEGIN
  ALTER TABLE slo_error_budgets ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to add created_at to slo_error_budgets: %', SQLERRM;
END $$;

DO $$ BEGIN
  ALTER TABLE slo_evaluations ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to add created_at to slo_evaluations: %', SQLERRM;
END $$;

DO $$ BEGIN
  ALTER TABLE stripe_events_processed ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to add created_at to stripe_events_processed: %', SQLERRM;
END $$;

DO $$ BEGIN
  ALTER TABLE training_iterations ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to add created_at to training_iterations: %', SQLERRM;
END $$;

DO $$ BEGIN
  ALTER TABLE workflow_runs ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to add created_at to workflow_runs: %', SQLERRM;
END $$;

-----------------------------------------------------------------------
-- SECTION 5: Set created_at NOT NULL on all tables that have it nullable
-----------------------------------------------------------------------

DO $$ BEGIN UPDATE agent_policies SET created_at = now() WHERE created_at IS NULL; ALTER TABLE agent_policies ALTER COLUMN created_at SET NOT NULL; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Failed NOT NULL created_at on agent_policies: %', SQLERRM; END $$;
DO $$ BEGIN UPDATE agent_procedures SET created_at = now() WHERE created_at IS NULL; ALTER TABLE agent_procedures ALTER COLUMN created_at SET NOT NULL; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Failed NOT NULL created_at on agent_procedures: %', SQLERRM; END $$;
DO $$ BEGIN UPDATE alert_configs SET created_at = now() WHERE created_at IS NULL; ALTER TABLE alert_configs ALTER COLUMN created_at SET NOT NULL; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Failed NOT NULL created_at on alert_configs: %', SQLERRM; END $$;
DO $$ BEGIN UPDATE alert_history SET created_at = now() WHERE created_at IS NULL; ALTER TABLE alert_history ALTER COLUMN created_at SET NOT NULL; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Failed NOT NULL created_at on alert_history: %', SQLERRM; END $$;
DO $$ BEGIN UPDATE api_access_log SET created_at = now() WHERE created_at IS NULL; ALTER TABLE api_access_log ALTER COLUMN created_at SET NOT NULL; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Failed NOT NULL created_at on api_access_log: %', SQLERRM; END $$;
DO $$ BEGIN UPDATE api_key_agent_scopes SET created_at = now() WHERE created_at IS NULL; ALTER TABLE api_key_agent_scopes ALTER COLUMN created_at SET NOT NULL; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Failed NOT NULL created_at on api_key_agent_scopes: %', SQLERRM; END $$;
DO $$ BEGIN UPDATE audit_log SET created_at = now() WHERE created_at IS NULL; ALTER TABLE audit_log ALTER COLUMN created_at SET NOT NULL; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Failed NOT NULL created_at on audit_log: %', SQLERRM; END $$;
DO $$ BEGIN UPDATE auth_audit_log SET created_at = now() WHERE created_at IS NULL; ALTER TABLE auth_audit_log ALTER COLUMN created_at SET NOT NULL; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Failed NOT NULL created_at on auth_audit_log: %', SQLERRM; END $$;
DO $$ BEGIN UPDATE autopilot_sessions SET created_at = now() WHERE created_at IS NULL; ALTER TABLE autopilot_sessions ALTER COLUMN created_at SET NOT NULL; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Failed NOT NULL created_at on autopilot_sessions: %', SQLERRM; END $$;
DO $$ BEGIN UPDATE batch_jobs SET created_at = now() WHERE created_at IS NULL; ALTER TABLE batch_jobs ALTER COLUMN created_at SET NOT NULL; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Failed NOT NULL created_at on batch_jobs: %', SQLERRM; END $$;
DO $$ BEGIN UPDATE batch_tasks SET created_at = now() WHERE created_at IS NULL; ALTER TABLE batch_tasks ALTER COLUMN created_at SET NOT NULL; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Failed NOT NULL created_at on batch_tasks: %', SQLERRM; END $$;
DO $$ BEGIN UPDATE billing_events SET created_at = now() WHERE created_at IS NULL; ALTER TABLE billing_events ALTER COLUMN created_at SET NOT NULL; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Failed NOT NULL created_at on billing_events: %', SQLERRM; END $$;
DO $$ BEGIN UPDATE canary_splits SET created_at = now() WHERE created_at IS NULL; ALTER TABLE canary_splits ALTER COLUMN created_at SET NOT NULL; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Failed NOT NULL created_at on canary_splits: %', SQLERRM; END $$;
DO $$ BEGIN UPDATE components SET created_at = now() WHERE created_at IS NULL; ALTER TABLE components ALTER COLUMN created_at SET NOT NULL; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Failed NOT NULL created_at on components: %', SQLERRM; END $$;
DO $$ BEGIN UPDATE connector_tokens SET created_at = now() WHERE created_at IS NULL; ALTER TABLE connector_tokens ALTER COLUMN created_at SET NOT NULL; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Failed NOT NULL created_at on connector_tokens: %', SQLERRM; END $$;
DO $$ BEGIN UPDATE connector_tools SET created_at = now() WHERE created_at IS NULL; ALTER TABLE connector_tools ALTER COLUMN created_at SET NOT NULL; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Failed NOT NULL created_at on connector_tools: %', SQLERRM; END $$;
DO $$ BEGIN UPDATE conversation_messages SET created_at = now() WHERE created_at IS NULL; ALTER TABLE conversation_messages ALTER COLUMN created_at SET NOT NULL; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Failed NOT NULL created_at on conversation_messages: %', SQLERRM; END $$;
DO $$ BEGIN UPDATE conversations SET created_at = now() WHERE created_at IS NULL; ALTER TABLE conversations ALTER COLUMN created_at SET NOT NULL; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Failed NOT NULL created_at on conversations: %', SQLERRM; END $$;
DO $$ BEGIN UPDATE credit_packages SET created_at = now() WHERE created_at IS NULL; ALTER TABLE credit_packages ALTER COLUMN created_at SET NOT NULL; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Failed NOT NULL created_at on credit_packages: %', SQLERRM; END $$;
DO $$ BEGIN UPDATE credit_transactions SET created_at = now() WHERE created_at IS NULL; ALTER TABLE credit_transactions ALTER COLUMN created_at SET NOT NULL; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Failed NOT NULL created_at on credit_transactions: %', SQLERRM; END $$;
DO $$ BEGIN UPDATE custom_domains SET created_at = now() WHERE created_at IS NULL; ALTER TABLE custom_domains ALTER COLUMN created_at SET NOT NULL; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Failed NOT NULL created_at on custom_domains: %', SQLERRM; END $$;
DO $$ BEGIN UPDATE dlp_agent_policies SET created_at = now() WHERE created_at IS NULL; ALTER TABLE dlp_agent_policies ALTER COLUMN created_at SET NOT NULL; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Failed NOT NULL created_at on dlp_agent_policies: %', SQLERRM; END $$;
DO $$ BEGIN UPDATE dlp_classifications SET created_at = now() WHERE created_at IS NULL; ALTER TABLE dlp_classifications ALTER COLUMN created_at SET NOT NULL; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Failed NOT NULL created_at on dlp_classifications: %', SQLERRM; END $$;
DO $$ BEGIN UPDATE end_user_tokens SET created_at = now() WHERE created_at IS NULL; ALTER TABLE end_user_tokens ALTER COLUMN created_at SET NOT NULL; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Failed NOT NULL created_at on end_user_tokens: %', SQLERRM; END $$;
DO $$ BEGIN UPDATE end_user_usage SET created_at = now() WHERE created_at IS NULL; ALTER TABLE end_user_usage ALTER COLUMN created_at SET NOT NULL; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Failed NOT NULL created_at on end_user_usage: %', SQLERRM; END $$;
DO $$ BEGIN UPDATE environments SET created_at = now() WHERE created_at IS NULL; ALTER TABLE environments ALTER COLUMN created_at SET NOT NULL; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Failed NOT NULL created_at on environments: %', SQLERRM; END $$;
DO $$ BEGIN UPDATE event_types SET created_at = now() WHERE created_at IS NULL; ALTER TABLE event_types ALTER COLUMN created_at SET NOT NULL; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Failed NOT NULL created_at on event_types: %', SQLERRM; END $$;
DO $$ BEGIN UPDATE evolution_ledger SET created_at = now() WHERE created_at IS NULL; ALTER TABLE evolution_ledger ALTER COLUMN created_at SET NOT NULL; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Failed NOT NULL created_at on evolution_ledger: %', SQLERRM; END $$;
DO $$ BEGIN UPDATE evolution_proposals SET created_at = now() WHERE created_at IS NULL; ALTER TABLE evolution_proposals ALTER COLUMN created_at SET NOT NULL; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Failed NOT NULL created_at on evolution_proposals: %', SQLERRM; END $$;
DO $$ BEGIN UPDATE file_uploads SET created_at = now() WHERE created_at IS NULL; ALTER TABLE file_uploads ALTER COLUMN created_at SET NOT NULL; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Failed NOT NULL created_at on file_uploads: %', SQLERRM; END $$;
DO $$ BEGIN UPDATE github_webhook_subscriptions SET created_at = now() WHERE created_at IS NULL; ALTER TABLE github_webhook_subscriptions ALTER COLUMN created_at SET NOT NULL; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Failed NOT NULL created_at on github_webhook_subscriptions: %', SQLERRM; END $$;
DO $$ BEGIN UPDATE guardrail_events SET created_at = now() WHERE created_at IS NULL; ALTER TABLE guardrail_events ALTER COLUMN created_at SET NOT NULL; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Failed NOT NULL created_at on guardrail_events: %', SQLERRM; END $$;
DO $$ BEGIN UPDATE guardrail_policies SET created_at = now() WHERE created_at IS NULL; ALTER TABLE guardrail_policies ALTER COLUMN created_at SET NOT NULL; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Failed NOT NULL created_at on guardrail_policies: %', SQLERRM; END $$;
DO $$ BEGIN UPDATE idempotency_cache SET created_at = now() WHERE created_at IS NULL; ALTER TABLE idempotency_cache ALTER COLUMN created_at SET NOT NULL; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Failed NOT NULL created_at on idempotency_cache: %', SQLERRM; END $$;
DO $$ BEGIN UPDATE issues SET created_at = now() WHERE created_at IS NULL; ALTER TABLE issues ALTER COLUMN created_at SET NOT NULL; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Failed NOT NULL created_at on issues: %', SQLERRM; END $$;
DO $$ BEGIN UPDATE meta_proposals SET created_at = now() WHERE created_at IS NULL; ALTER TABLE meta_proposals ALTER COLUMN created_at SET NOT NULL; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Failed NOT NULL created_at on meta_proposals: %', SQLERRM; END $$;
DO $$ BEGIN UPDATE org_settings SET created_at = now() WHERE created_at IS NULL; ALTER TABLE org_settings ALTER COLUMN created_at SET NOT NULL; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Failed NOT NULL created_at on org_settings: %', SQLERRM; END $$;
DO $$ BEGIN UPDATE pipelines SET created_at = now() WHERE created_at IS NULL; ALTER TABLE pipelines ALTER COLUMN created_at SET NOT NULL; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Failed NOT NULL created_at on pipelines: %', SQLERRM; END $$;
DO $$ BEGIN UPDATE projects SET created_at = now() WHERE created_at IS NULL; ALTER TABLE projects ALTER COLUMN created_at SET NOT NULL; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Failed NOT NULL created_at on projects: %', SQLERRM; END $$;
DO $$ BEGIN UPDATE release_channels SET created_at = now() WHERE created_at IS NULL; ALTER TABLE release_channels ALTER COLUMN created_at SET NOT NULL; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Failed NOT NULL created_at on release_channels: %', SQLERRM; END $$;
DO $$ BEGIN UPDATE schedules SET created_at = now() WHERE created_at IS NULL; ALTER TABLE schedules ALTER COLUMN created_at SET NOT NULL; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Failed NOT NULL created_at on schedules: %', SQLERRM; END $$;
DO $$ BEGIN UPDATE security_events SET created_at = now() WHERE created_at IS NULL; ALTER TABLE security_events ALTER COLUMN created_at SET NOT NULL; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Failed NOT NULL created_at on security_events: %', SQLERRM; END $$;
DO $$ BEGIN UPDATE security_findings SET created_at = now() WHERE created_at IS NULL; ALTER TABLE security_findings ALTER COLUMN created_at SET NOT NULL; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Failed NOT NULL created_at on security_findings: %', SQLERRM; END $$;
DO $$ BEGIN UPDATE security_scans SET created_at = now() WHERE created_at IS NULL; ALTER TABLE security_scans ALTER COLUMN created_at SET NOT NULL; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Failed NOT NULL created_at on security_scans: %', SQLERRM; END $$;
DO $$ BEGIN UPDATE session_feedback SET created_at = now() WHERE created_at IS NULL; ALTER TABLE session_feedback ALTER COLUMN created_at SET NOT NULL; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Failed NOT NULL created_at on session_feedback: %', SQLERRM; END $$;
DO $$ BEGIN UPDATE span_feedback SET created_at = now() WHERE created_at IS NULL; ALTER TABLE span_feedback ALTER COLUMN created_at SET NOT NULL; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Failed NOT NULL created_at on span_feedback: %', SQLERRM; END $$;
DO $$ BEGIN UPDATE subgraph_definitions SET created_at = now() WHERE created_at IS NULL; ALTER TABLE subgraph_definitions ALTER COLUMN created_at SET NOT NULL; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Failed NOT NULL created_at on subgraph_definitions: %', SQLERRM; END $$;
DO $$ BEGIN UPDATE team_facts SET created_at = now() WHERE created_at IS NULL; ALTER TABLE team_facts ALTER COLUMN created_at SET NOT NULL; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Failed NOT NULL created_at on team_facts: %', SQLERRM; END $$;
DO $$ BEGIN UPDATE team_observations SET created_at = now() WHERE created_at IS NULL; ALTER TABLE team_observations ALTER COLUMN created_at SET NOT NULL; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Failed NOT NULL created_at on team_observations: %', SQLERRM; END $$;
DO $$ BEGIN UPDATE tool_executions SET created_at = now() WHERE created_at IS NULL; ALTER TABLE tool_executions ALTER COLUMN created_at SET NOT NULL; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Failed NOT NULL created_at on tool_executions: %', SQLERRM; END $$;
DO $$ BEGIN UPDATE tool_registry SET created_at = now() WHERE created_at IS NULL; ALTER TABLE tool_registry ALTER COLUMN created_at SET NOT NULL; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Failed NOT NULL created_at on tool_registry: %', SQLERRM; END $$;
DO $$ BEGIN UPDATE trace_annotations SET created_at = now() WHERE created_at IS NULL; ALTER TABLE trace_annotations ALTER COLUMN created_at SET NOT NULL; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Failed NOT NULL created_at on trace_annotations: %', SQLERRM; END $$;
DO $$ BEGIN UPDATE trace_lineage SET created_at = now() WHERE created_at IS NULL; ALTER TABLE trace_lineage ALTER COLUMN created_at SET NOT NULL; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Failed NOT NULL created_at on trace_lineage: %', SQLERRM; END $$;
DO $$ BEGIN UPDATE training_jobs SET created_at = now() WHERE created_at IS NULL; ALTER TABLE training_jobs ALTER COLUMN created_at SET NOT NULL; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Failed NOT NULL created_at on training_jobs: %', SQLERRM; END $$;
DO $$ BEGIN UPDATE training_resources SET created_at = now() WHERE created_at IS NULL; ALTER TABLE training_resources ALTER COLUMN created_at SET NOT NULL; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Failed NOT NULL created_at on training_resources: %', SQLERRM; END $$;
DO $$ BEGIN UPDATE training_rewards SET created_at = now() WHERE created_at IS NULL; ALTER TABLE training_rewards ALTER COLUMN created_at SET NOT NULL; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Failed NOT NULL created_at on training_rewards: %', SQLERRM; END $$;
DO $$ BEGIN UPDATE turns SET created_at = now() WHERE created_at IS NULL; ALTER TABLE turns ALTER COLUMN created_at SET NOT NULL; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Failed NOT NULL created_at on turns: %', SQLERRM; END $$;
DO $$ BEGIN UPDATE user_feedback SET created_at = now() WHERE created_at IS NULL; ALTER TABLE user_feedback ALTER COLUMN created_at SET NOT NULL; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Failed NOT NULL created_at on user_feedback: %', SQLERRM; END $$;
DO $$ BEGIN UPDATE user_sessions SET created_at = now() WHERE created_at IS NULL; ALTER TABLE user_sessions ALTER COLUMN created_at SET NOT NULL; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Failed NOT NULL created_at on user_sessions: %', SQLERRM; END $$;
DO $$ BEGIN UPDATE vapi_calls SET created_at = now() WHERE created_at IS NULL; ALTER TABLE vapi_calls ALTER COLUMN created_at SET NOT NULL; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Failed NOT NULL created_at on vapi_calls: %', SQLERRM; END $$;
DO $$ BEGIN UPDATE vapi_events SET created_at = now() WHERE created_at IS NULL; ALTER TABLE vapi_events ALTER COLUMN created_at SET NOT NULL; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Failed NOT NULL created_at on vapi_events: %', SQLERRM; END $$;
DO $$ BEGIN UPDATE voice_calls SET created_at = now() WHERE created_at IS NULL; ALTER TABLE voice_calls ALTER COLUMN created_at SET NOT NULL; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Failed NOT NULL created_at on voice_calls: %', SQLERRM; END $$;
DO $$ BEGIN UPDATE voice_events SET created_at = now() WHERE created_at IS NULL; ALTER TABLE voice_events ALTER COLUMN created_at SET NOT NULL; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Failed NOT NULL created_at on voice_events: %', SQLERRM; END $$;
DO $$ BEGIN UPDATE voice_numbers SET created_at = now() WHERE created_at IS NULL; ALTER TABLE voice_numbers ALTER COLUMN created_at SET NOT NULL; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Failed NOT NULL created_at on voice_numbers: %', SQLERRM; END $$;
DO $$ BEGIN UPDATE workflows SET created_at = now() WHERE created_at IS NULL; ALTER TABLE workflows ALTER COLUMN created_at SET NOT NULL; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Failed NOT NULL created_at on workflows: %', SQLERRM; END $$;

-----------------------------------------------------------------------
-- SECTION 6: Add PK to feature_flags
-----------------------------------------------------------------------

DO $$ BEGIN
  -- Already has UNIQUE(org_id, flag_name) — promote to PK
  ALTER TABLE feature_flags DROP CONSTRAINT IF EXISTS feature_flags_org_id_flag_name_key;
  ALTER TABLE feature_flags ADD PRIMARY KEY (org_id, flag_name);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to add PK to feature_flags: %', SQLERRM;
END $$;

-----------------------------------------------------------------------
-- SECTION 7: Fix nullable status on critical tables
-----------------------------------------------------------------------

DO $$ BEGIN
  UPDATE alert_history SET status = 'pending' WHERE status IS NULL;
  ALTER TABLE alert_history ALTER COLUMN status SET NOT NULL;
  ALTER TABLE alert_history ALTER COLUMN status SET DEFAULT 'pending';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to fix status NOT NULL on alert_history: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE data_export_requests SET status = 'pending' WHERE status IS NULL;
  ALTER TABLE data_export_requests ALTER COLUMN status SET NOT NULL;
  ALTER TABLE data_export_requests ALTER COLUMN status SET DEFAULT 'pending';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to fix status NOT NULL on data_export_requests: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE evolution_proposals SET status = 'pending' WHERE status IS NULL;
  ALTER TABLE evolution_proposals ALTER COLUMN status SET NOT NULL;
  ALTER TABLE evolution_proposals ALTER COLUMN status SET DEFAULT 'pending';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to fix status NOT NULL on evolution_proposals: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE meta_proposals SET status = 'pending' WHERE status IS NULL;
  ALTER TABLE meta_proposals ALTER COLUMN status SET NOT NULL;
  ALTER TABLE meta_proposals ALTER COLUMN status SET DEFAULT 'pending';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to fix status NOT NULL on meta_proposals: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE pipelines SET status = 'pending' WHERE status IS NULL;
  ALTER TABLE pipelines ALTER COLUMN status SET NOT NULL;
  ALTER TABLE pipelines ALTER COLUMN status SET DEFAULT 'pending';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to fix status NOT NULL on pipelines: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE secrets_key_rotations SET status = 'pending' WHERE status IS NULL;
  ALTER TABLE secrets_key_rotations ALTER COLUMN status SET NOT NULL;
  ALTER TABLE secrets_key_rotations ALTER COLUMN status SET DEFAULT 'pending';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to fix status NOT NULL on secrets_key_rotations: %', SQLERRM;
END $$;

DO $$ BEGIN
  UPDATE voice_numbers SET status = 'pending' WHERE status IS NULL;
  ALTER TABLE voice_numbers ALTER COLUMN status SET NOT NULL;
  ALTER TABLE voice_numbers ALTER COLUMN status SET DEFAULT 'pending';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to fix status NOT NULL on voice_numbers: %', SQLERRM;
END $$;

-- Done: Migration 031 Phase 1 Data Integrity complete.
