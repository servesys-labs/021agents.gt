-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 003: Create all 28 missing tables
-- Generated from existing schema.sql + route file SQL query analysis
-- All statements use CREATE TABLE IF NOT EXISTS for safe re-runs
-- ═══════════════════════════════════════════════════════════════════════════

-- Ensure the update_updated_at_column() trigger function exists
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ language 'plpgsql';


-- ═══════════════════════════════════════════════════════════════════════════
-- 1. components — reusable graph element registry
--    Source: schema.sql
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS components (
  component_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  type text NOT NULL CHECK (type IN ('graph', 'prompt', 'tool_set', 'node_template')),
  name text NOT NULL,
  description text DEFAULT '',
  content jsonb NOT NULL DEFAULT '{}',
  tags text[] DEFAULT '{}',
  is_public boolean DEFAULT false,
  created_by text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  version text DEFAULT '1.0.0',
  UNIQUE(org_id, type, name)
);

CREATE INDEX IF NOT EXISTS idx_components_org_type ON components(org_id, type);
CREATE INDEX IF NOT EXISTS idx_components_public ON components(is_public) WHERE is_public = true;

DO $$ BEGIN
  CREATE TRIGGER update_components_updated_at BEFORE UPDATE ON components
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- 2. component_usage — tracks which agents/sessions use components
--    Source: schema.sql
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS component_usage (
  usage_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  component_id uuid REFERENCES components(component_id) ON DELETE CASCADE,
  org_id text NOT NULL,
  used_by text,
  used_at timestamptz DEFAULT now(),
  context jsonb DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_component_usage_component ON component_usage(component_id);


-- ═══════════════════════════════════════════════════════════════════════════
-- 3. subgraph_definitions — nested graph composition
--    Source: schema.sql
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS subgraph_definitions (
  subgraph_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  component_id uuid REFERENCES components(component_id) ON DELETE CASCADE,
  name text NOT NULL,
  version text DEFAULT '1.0.0',
  description text DEFAULT '',
  graph_json jsonb NOT NULL,
  input_schema jsonb DEFAULT '{}',
  output_schema jsonb DEFAULT '{}',
  org_id text NOT NULL,
  is_public boolean DEFAULT false,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(org_id, name, version)
);

CREATE INDEX IF NOT EXISTS idx_subgraph_defs_org ON subgraph_definitions(org_id);

DO $$ BEGIN
  CREATE TRIGGER update_subgraph_defs_updated_at BEFORE UPDATE ON subgraph_definitions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- 4. prompt_versions — prompt A/B testing with traffic splits
--    Source: schema.sql
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS prompt_versions (
  prompt_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  component_id uuid REFERENCES components(component_id) ON DELETE CASCADE,
  version text NOT NULL,
  template text NOT NULL,
  variables text[] DEFAULT '{}',
  eval_score float,
  is_active boolean DEFAULT false,
  traffic_percent int CHECK (traffic_percent BETWEEN 0 AND 100),
  org_id text NOT NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(component_id, version)
);

CREATE INDEX IF NOT EXISTS idx_prompt_versions_active ON prompt_versions(component_id, is_active) WHERE is_active = true;

DO $$ BEGIN
  CREATE TRIGGER update_prompt_versions_updated_at BEFORE UPDATE ON prompt_versions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- 5. graph_snapshots — versioning/caching of compiled graphs
--    Source: schema.sql
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS graph_snapshots (
  snapshot_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_name text NOT NULL,
  org_id text NOT NULL,
  graph_hash text NOT NULL,
  graph_json jsonb NOT NULL,
  expanded_graph jsonb,
  validation_result jsonb,
  created_at timestamptz DEFAULT now(),
  expires_at timestamptz DEFAULT (now() + interval '7 days'),
  UNIQUE(org_id, agent_name, graph_hash)
);

CREATE INDEX IF NOT EXISTS idx_graph_snapshots_hash ON graph_snapshots(org_id, agent_name, graph_hash);


-- ═══════════════════════════════════════════════════════════════════════════
-- 6. node_checkpoints — resumable graph execution state
--    Source: schema.sql
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS node_checkpoints (
  checkpoint_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id text NOT NULL,
  node_id text NOT NULL,
  node_type text,
  input_data jsonb,
  output_data jsonb,
  state_snapshot jsonb,
  created_at timestamptz DEFAULT now(),
  expires_at timestamptz DEFAULT (now() + interval '24 hours')
);

CREATE INDEX IF NOT EXISTS idx_node_checkpoints_session ON node_checkpoints(session_id);


-- ═══════════════════════════════════════════════════════════════════════════
-- 7. langchain_tools — LangChain tool registry
--    Source: schema.sql
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS langchain_tools (
  tool_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  name text NOT NULL,
  description text,
  python_module text,
  python_class text,
  js_package text,
  js_function text,
  config_schema jsonb DEFAULT '{}',
  is_enabled boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  UNIQUE(org_id, name)
);


-- ═══════════════════════════════════════════════════════════════════════════
-- 8. schema_validation_errors — schema mismatch audit log
--    Source: schema.sql
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS schema_validation_errors (
  error_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id text,
  node_id text,
  schema_type text,
  expected_schema jsonb,
  actual_data jsonb,
  error_message text,
  occurred_at timestamptz DEFAULT now()
);


-- ═══════════════════════════════════════════════════════════════════════════
-- 9. codemode_snippets — sandboxed V8 code snippets
--    Source: schema.sql
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS codemode_snippets (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  name text NOT NULL,
  description text DEFAULT '',
  code text NOT NULL,
  scope text NOT NULL CHECK (scope IN (
    'agent', 'graph_node', 'transform', 'validator',
    'webhook', 'middleware', 'orchestrator', 'observability',
    'test', 'mcp_generator'
  )),
  input_schema jsonb,
  output_schema jsonb,
  scope_config jsonb,
  tags jsonb DEFAULT '[]',
  version integer DEFAULT 1,
  is_template boolean DEFAULT false,
  created_at real NOT NULL,
  updated_at real NOT NULL,
  UNIQUE(org_id, name)
);

CREATE INDEX IF NOT EXISTS idx_codemode_snippets_org_scope
  ON codemode_snippets(org_id, scope);
CREATE INDEX IF NOT EXISTS idx_codemode_snippets_org_updated
  ON codemode_snippets(org_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_codemode_snippets_template
  ON codemode_snippets(is_template) WHERE is_template = true;


-- ═══════════════════════════════════════════════════════════════════════════
-- 10. codemode_executions — codemode execution audit log
--     Source: schema.sql
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS codemode_executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  snippet_id text REFERENCES codemode_snippets(id) ON DELETE SET NULL,
  scope text NOT NULL,
  session_id text,
  trace_id text,
  success boolean NOT NULL,
  latency_ms integer,
  tool_call_count integer DEFAULT 0,
  cost_usd real DEFAULT 0,
  error text,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_codemode_executions_org
  ON codemode_executions(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_codemode_executions_snippet
  ON codemode_executions(snippet_id, created_at DESC);


-- ═══════════════════════════════════════════════════════════════════════════
-- 11. session_progress — cross-session progress tracking (harness pattern)
--     Source: schema.sql
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS session_progress (
  session_id text PRIMARY KEY,
  trace_id text NOT NULL DEFAULT '',
  agent_name text NOT NULL,
  org_id text NOT NULL DEFAULT '',
  summary jsonb NOT NULL DEFAULT '{}',
  created_at real NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_session_progress_agent_org
  ON session_progress(agent_name, org_id, created_at DESC);


-- ═══════════════════════════════════════════════════════════════════════════
-- 12. evolution_reports — evolution analyzer results
--     Source: 002_evolution_analyzer.sql
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS evolution_reports (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  agent_name text NOT NULL,
  org_id text NOT NULL DEFAULT '',
  report_json text NOT NULL DEFAULT '{}',
  session_count integer NOT NULL DEFAULT 0,
  created_at real NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_evolution_reports_agent_org
  ON evolution_reports(agent_name, org_id, created_at DESC);


-- ═══════════════════════════════════════════════════════════════════════════
-- 13. workflow_approvals — human-in-the-loop approval gates
--     Source: routes/workflows.ts (inline CREATE TABLE)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS workflow_approvals (
  approval_id text PRIMARY KEY,
  org_id text NOT NULL,
  project_id text DEFAULT '',
  agent_name text NOT NULL,
  run_id text NOT NULL,
  gate_id text NOT NULL,
  checkpoint_id text DEFAULT '',
  status text NOT NULL,
  decision text DEFAULT '',
  reviewer_id text DEFAULT '',
  review_comment text DEFAULT '',
  context_json text DEFAULT '{}',
  workflow_instance_id text DEFAULT '',
  backend_mode text DEFAULT 'checkpoint_fallback',
  idempotency_key text DEFAULT '',
  deadline_at bigint DEFAULT 0,
  decided_at bigint DEFAULT 0,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workflow_approvals_org ON workflow_approvals(org_id);
CREATE INDEX IF NOT EXISTS idx_workflow_approvals_status ON workflow_approvals(org_id, status);
CREATE INDEX IF NOT EXISTS idx_workflow_approvals_agent ON workflow_approvals(org_id, agent_name);


-- ═══════════════════════════════════════════════════════════════════════════
-- 14. risk_profiles — per-agent security risk assessment
--     Source: routes/security.ts (INSERT ... ON CONFLICT (agent_name))
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS risk_profiles (
  agent_name text PRIMARY KEY,
  org_id text NOT NULL,
  risk_score real NOT NULL DEFAULT 0,
  risk_level text NOT NULL DEFAULT 'not_scanned',
  last_scan_id text DEFAULT '',
  findings_summary text DEFAULT '{}',
  updated_at real DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_risk_profiles_org ON risk_profiles(org_id);
CREATE INDEX IF NOT EXISTS idx_risk_profiles_score ON risk_profiles(org_id, risk_score DESC);


-- ═══════════════════════════════════════════════════════════════════════════
-- 15. connector_tokens — OAuth tokens for third-party connectors
--     Source: rls.sql reference; schema inferred from connectors pattern
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS connector_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  provider text NOT NULL DEFAULT '',
  app text NOT NULL DEFAULT '',
  access_token text DEFAULT '',
  refresh_token text DEFAULT '',
  token_type text DEFAULT 'bearer',
  scopes text DEFAULT '',
  expires_at timestamptz,
  user_id text DEFAULT '',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(org_id, provider, app)
);

CREATE INDEX IF NOT EXISTS idx_connector_tokens_org ON connector_tokens(org_id);

DO $$ BEGIN
  CREATE TRIGGER update_connector_tokens_updated_at BEFORE UPDATE ON connector_tokens
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- 16. connector_tools — available tools per connector app
--     Source: routes/connectors.ts (SELECT name, description, app, provider)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS connector_tools (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text DEFAULT '',
  app text NOT NULL DEFAULT '',
  provider text NOT NULL DEFAULT '',
  schema_json jsonb DEFAULT '{}',
  is_enabled boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  UNIQUE(app, name)
);

CREATE INDEX IF NOT EXISTS idx_connector_tools_app ON connector_tools(app);


-- ═══════════════════════════════════════════════════════════════════════════
-- 17. tool_registry — org-scoped custom tool definitions
--     Source: routes/tools.ts (INSERT/SELECT/DELETE queries)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS tool_registry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text DEFAULT '',
  org_id text NOT NULL,
  schema_json text DEFAULT '{}',
  has_handler boolean DEFAULT false,
  handler_code text,
  source text DEFAULT 'user-defined',
  is_builtin boolean DEFAULT false,
  created_at real DEFAULT 0,
  UNIQUE(org_id, name)
);

CREATE INDEX IF NOT EXISTS idx_tool_registry_org ON tool_registry(org_id);
CREATE INDEX IF NOT EXISTS idx_tool_registry_builtin ON tool_registry(is_builtin) WHERE is_builtin = true;


-- ═══════════════════════════════════════════════════════════════════════════
-- 18. tool_executions — tool call audit log with timings
--     Source: routes/tools.ts (INSERT + SELECT queries)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS tool_executions (
  execution_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tool_name text NOT NULL,
  org_id text NOT NULL,
  user_id text DEFAULT '',
  arguments_json text DEFAULT '{}',
  result_json text,
  duration_ms integer DEFAULT 0,
  trace_id text,
  session_id text,
  error text,
  created_at real DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_tool_executions_org ON tool_executions(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tool_executions_tool ON tool_executions(tool_name, org_id);
CREATE INDEX IF NOT EXISTS idx_tool_executions_session ON tool_executions(session_id);


-- ═══════════════════════════════════════════════════════════════════════════
-- 19. dlp_classifications — data classification levels for DLP
--     Source: routes/dlp.ts (INSERT/SELECT/DELETE queries)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS dlp_classifications (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  name text NOT NULL,
  level text NOT NULL,
  description text DEFAULT '',
  patterns text DEFAULT '[]',
  created_at real DEFAULT 0,
  updated_at real DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_dlp_classifications_org ON dlp_classifications(org_id, created_at DESC);


-- ═══════════════════════════════════════════════════════════════════════════
-- 20. dlp_agent_policies — per-agent DLP policy configuration
--     Source: routes/dlp.ts (INSERT ... ON CONFLICT (org_id, agent_name))
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS dlp_agent_policies (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  agent_name text NOT NULL,
  policy_json text DEFAULT '{}',
  created_at real DEFAULT 0,
  updated_at real DEFAULT 0,
  UNIQUE(org_id, agent_name)
);

CREATE INDEX IF NOT EXISTS idx_dlp_agent_policies_org ON dlp_agent_policies(org_id);
CREATE INDEX IF NOT EXISTS idx_dlp_agent_policies_agent ON dlp_agent_policies(org_id, agent_name);


-- ═══════════════════════════════════════════════════════════════════════════
-- 21. project_configs — agentos.yaml config persistence (edge parity)
--     Source: routes/config.ts (INSERT ... ON CONFLICT (org_id))
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS project_configs (
  org_id text PRIMARY KEY,
  config_json text NOT NULL DEFAULT '{}',
  updated_at real DEFAULT 0
);


-- ═══════════════════════════════════════════════════════════════════════════
-- 22. span_feedback — per-span feedback from human reviewers
--     Source: routes/observability.ts (INSERT query)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS span_feedback (
  feedback_id text PRIMARY KEY,
  span_id text NOT NULL,
  org_id text NOT NULL,
  user_id text DEFAULT '',
  rating integer DEFAULT 0,
  score real DEFAULT 0,
  comment text DEFAULT '',
  labels_json text DEFAULT '[]',
  session_id text DEFAULT '',
  turn integer DEFAULT 0,
  source text DEFAULT 'human',
  created_at real DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_span_feedback_org ON span_feedback(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_span_feedback_span ON span_feedback(span_id);
CREATE INDEX IF NOT EXISTS idx_span_feedback_session ON span_feedback(session_id);


-- ═══════════════════════════════════════════════════════════════════════════
-- 23. session_feedback — session-level feedback (thumbs up/down, comments)
--     Source: routes/sessions.ts (INSERT/SELECT queries)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS session_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id text NOT NULL,
  rating integer DEFAULT 0,
  comment text DEFAULT '',
  tags text DEFAULT '',
  created_at real DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_session_feedback_session ON session_feedback(session_id);
CREATE INDEX IF NOT EXISTS idx_session_feedback_created ON session_feedback(created_at DESC);


-- ═══════════════════════════════════════════════════════════════════════════
-- 24. trace_annotations — human annotations on traces/spans
--     Source: routes/observability.ts (INSERT query)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS trace_annotations (
  annotation_id text PRIMARY KEY,
  trace_id text NOT NULL,
  org_id text NOT NULL,
  user_id text DEFAULT '',
  annotation_type text DEFAULT 'note',
  message text DEFAULT '',
  severity text DEFAULT 'info',
  span_id text DEFAULT '',
  node_id text DEFAULT '',
  turn integer DEFAULT 0,
  metadata_json text DEFAULT '{}',
  created_at real DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_trace_annotations_org ON trace_annotations(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trace_annotations_trace ON trace_annotations(trace_id);


-- ═══════════════════════════════════════════════════════════════════════════
-- 25. trace_lineage — provenance tracking for traces (model, prompt, eval)
--     Source: routes/observability.ts (INSERT ... ON CONFLICT (trace_id))
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS trace_lineage (
  trace_id text PRIMARY KEY,
  org_id text NOT NULL,
  session_id text DEFAULT '',
  agent_version text DEFAULT '',
  model text DEFAULT '',
  prompt_hash text DEFAULT '',
  eval_run_id integer DEFAULT 0,
  experiment_id text DEFAULT '',
  dataset_id text DEFAULT '',
  commit_sha text DEFAULT '',
  metadata_json text DEFAULT '{}',
  created_at real DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_trace_lineage_org ON trace_lineage(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trace_lineage_session ON trace_lineage(session_id);
CREATE INDEX IF NOT EXISTS idx_trace_lineage_experiment ON trace_lineage(experiment_id);


-- ═══════════════════════════════════════════════════════════════════════════
-- 26. a2a_agents — A2A protocol agent registration (discovery)
--     Source: rls.sql reference; schema inferred from a2a protocol patterns
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS a2a_agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  agent_name text NOT NULL,
  url text NOT NULL DEFAULT '',
  protocol_version text DEFAULT '1.0',
  capabilities_json text DEFAULT '{}',
  auth_type text DEFAULT 'none',
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(org_id, agent_name)
);

CREATE INDEX IF NOT EXISTS idx_a2a_agents_org ON a2a_agents(org_id);
CREATE INDEX IF NOT EXISTS idx_a2a_agents_active ON a2a_agents(org_id, is_active) WHERE is_active = true;

DO $$ BEGIN
  CREATE TRIGGER update_a2a_agents_updated_at BEFORE UPDATE ON a2a_agents
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- 27. billing_events — discrete billing events (usage metering)
--     Source: rls.sql reference; schema inferred from billing_records pattern
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS billing_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  event_type text NOT NULL DEFAULT '',
  agent_name text DEFAULT '',
  session_id text DEFAULT '',
  description text DEFAULT '',
  amount_usd real DEFAULT 0,
  metadata_json jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_billing_events_org ON billing_events(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_billing_events_type ON billing_events(event_type);
CREATE INDEX IF NOT EXISTS idx_billing_events_agent ON billing_events(agent_name);


-- ═══════════════════════════════════════════════════════════════════════════
-- 28. org_settings — per-org configuration (plan type, feature flags)
--     Source: middleware/quota.ts (SELECT plan_type FROM org_settings)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS org_settings (
  org_id text PRIMARY KEY,
  plan_type text NOT NULL DEFAULT 'free',
  settings_json jsonb DEFAULT '{}',
  features_json jsonb DEFAULT '{}',
  limits_json jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

DO $$ BEGIN
  CREATE TRIGGER update_org_settings_updated_at BEFORE UPDATE ON org_settings
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- Done. All 28 tables created with IF NOT EXISTS guards.
-- ═══════════════════════════════════════════════════════════════════════════
