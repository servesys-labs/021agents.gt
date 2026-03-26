-- AgentOS Database Schema Extensions
-- Run this in Supabase to create required tables for new features

-- Components registry for reusable graph elements
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

-- Component usage tracking
CREATE TABLE IF NOT EXISTS component_usage (
  usage_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  component_id uuid REFERENCES components(component_id) ON DELETE CASCADE,
  org_id text NOT NULL,
  used_by text,
  used_at timestamptz DEFAULT now(),
  context jsonb DEFAULT '{}' -- session_id, agent_name, etc.
);

-- Subgraph definitions (for nested graph composition)
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

-- Prompt versions with A/B testing support
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

-- Graph snapshots for versioning/caching
CREATE TABLE IF NOT EXISTS graph_snapshots (
  snapshot_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_name text NOT NULL,
  org_id text NOT NULL,
  graph_hash text NOT NULL, -- SHA256 of canonical graph JSON
  graph_json jsonb NOT NULL,
  expanded_graph jsonb, -- After subgraph expansion
  validation_result jsonb, -- Cache validation results
  created_at timestamptz DEFAULT now(),
  expires_at timestamptz DEFAULT (now() + interval '7 days'),
  UNIQUE(org_id, agent_name, graph_hash)
);

-- Node execution state for resumable graphs
CREATE TABLE IF NOT EXISTS node_checkpoints (
  checkpoint_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id text NOT NULL,
  node_id text NOT NULL,
  node_type text,
  input_data jsonb,
  output_data jsonb,
  state_snapshot jsonb, -- Full execution state
  created_at timestamptz DEFAULT now(),
  expires_at timestamptz DEFAULT (now() + interval '24 hours')
);

-- LangChain tool registry
CREATE TABLE IF NOT EXISTS langchain_tools (
  tool_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  name text NOT NULL,
  description text,
  python_module text, -- For Python tools: module.path
  python_class text,  -- For Python tools: ClassName
  js_package text,    -- For JS tools: npm package
  js_function text,   -- For JS tools: function name
  config_schema jsonb DEFAULT '{}',
  is_enabled boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  UNIQUE(org_id, name)
);

-- Schema validation errors log
CREATE TABLE IF NOT EXISTS schema_validation_errors (
  error_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id text,
  node_id text,
  schema_type text, -- 'input' or 'output'
  expected_schema jsonb,
  actual_data jsonb,
  error_message text,
  occurred_at timestamptz DEFAULT now()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_components_org_type ON components(org_id, type);
CREATE INDEX IF NOT EXISTS idx_components_public ON components(is_public) WHERE is_public = true;
CREATE INDEX IF NOT EXISTS idx_component_usage_component ON component_usage(component_id);
CREATE INDEX IF NOT EXISTS idx_subgraph_defs_org ON subgraph_definitions(org_id);
CREATE INDEX IF NOT EXISTS idx_graph_snapshots_hash ON graph_snapshots(org_id, agent_name, graph_hash);
CREATE INDEX IF NOT EXISTS idx_node_checkpoints_session ON node_checkpoints(session_id);
CREATE INDEX IF NOT EXISTS idx_prompt_versions_active ON prompt_versions(component_id, is_active) WHERE is_active = true;

-- Update triggers for updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_components_updated_at BEFORE UPDATE ON components
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_subgraph_defs_updated_at BEFORE UPDATE ON subgraph_definitions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_prompt_versions_updated_at BEFORE UPDATE ON prompt_versions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Helper function to get subgraph with input/output schema
CREATE OR REPLACE FUNCTION get_subgraph_with_schema(p_subgraph_id uuid)
RETURNS TABLE (
  subgraph_id uuid,
  name text,
  version text,
  graph_json jsonb,
  input_schema jsonb,
  output_schema jsonb,
  org_id text
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    sd.subgraph_id,
    sd.name,
    sd.version,
    sd.graph_json,
    sd.input_schema,
    sd.output_schema,
    sd.org_id
  FROM subgraph_definitions sd
  WHERE sd.subgraph_id = p_subgraph_id;
END;
$$ LANGUAGE plpgsql;

-- Function to find prompt version by traffic split
CREATE OR REPLACE FUNCTION select_prompt_version(p_component_id uuid)
RETURNS TABLE (prompt_id uuid, template text, variables text[]) AS $$
DECLARE
  rand float;
  cum_percent int := 0;
  rec record;
BEGIN
  -- Get active versions ordered by traffic_percent
  rand := random() * 100;
  
  FOR rec IN 
    SELECT pv.prompt_id, pv.template, pv.variables, pv.traffic_percent
    FROM prompt_versions pv
    WHERE pv.component_id = p_component_id AND pv.is_active = true
    ORDER BY pv.traffic_percent DESC
  LOOP
    cum_percent := cum_percent + rec.traffic_percent;
    IF rand <= cum_percent THEN
      prompt_id := rec.prompt_id;
      template := rec.template;
      variables := rec.variables;
      RETURN NEXT;
      RETURN;
    END IF;
  END LOOP;
  
  -- Fallback to highest traffic version
  SELECT pv.prompt_id, pv.template, pv.variables
  INTO prompt_id, template, variables
  FROM prompt_versions pv
  WHERE pv.component_id = p_component_id AND pv.is_active = true
  ORDER BY pv.traffic_percent DESC
  LIMIT 1;
  
  IF FOUND THEN
    RETURN NEXT;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- ── Codemode Snippets ──────────────────────────────────────────────────
-- Stored user-defined code for sandboxed V8 execution across the platform.
-- Used by graph nodes, transforms, validators, webhooks, middleware, orchestrators.

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

-- Codemode execution audit log
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
-- COST LEDGER — persistent cost tracking per session
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS cost_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id text NOT NULL,
  agent_id text NOT NULL DEFAULT '',
  agent_name text NOT NULL DEFAULT '',
  model text NOT NULL DEFAULT '',
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  cost_usd real NOT NULL DEFAULT 0.0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cost_ledger_agent ON cost_ledger(agent_id);
CREATE INDEX IF NOT EXISTS idx_cost_ledger_created ON cost_ledger(created_at);
CREATE INDEX IF NOT EXISTS idx_cost_ledger_session ON cost_ledger(session_id);

-- ═══════════════════════════════════════════════════════════════════════════
-- BILLING — customer billing aggregation for charging
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS billing_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Who
  org_id text NOT NULL DEFAULT '',
  customer_id text NOT NULL DEFAULT '',
  agent_name text NOT NULL DEFAULT '',
  -- What
  cost_type text NOT NULL DEFAULT 'inference',  -- inference / gpu_compute / tool / eval
  description text NOT NULL DEFAULT '',
  -- Inference costs
  model text NOT NULL DEFAULT '',
  provider text NOT NULL DEFAULT '',
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  inference_cost_usd real NOT NULL DEFAULT 0.0,
  -- GPU compute costs (dedicated endpoints)
  gpu_type text NOT NULL DEFAULT '',  -- h100 / h200 / '' for serverless
  gpu_hours real NOT NULL DEFAULT 0.0,
  gpu_cost_usd real NOT NULL DEFAULT 0.0,
  -- Total
  total_cost_usd real NOT NULL DEFAULT 0.0,
  -- Trace
  session_id text NOT NULL DEFAULT '',
  trace_id text NOT NULL DEFAULT '',
  -- Pricing snapshot for invoice-grade reproducibility
  pricing_source text NOT NULL DEFAULT 'fallback_env',  -- catalog / fallback_env
  pricing_key text NOT NULL DEFAULT '',                   -- e.g. llm:gmi:model or tool:web-search
  unit text NOT NULL DEFAULT '',                          -- input_token / call / second
  unit_price_usd real NOT NULL DEFAULT 0.0,
  quantity real NOT NULL DEFAULT 0.0,
  pricing_version text NOT NULL DEFAULT '',               -- catalog version hash/label
  -- Time
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_billing_records_org ON billing_records(org_id);
CREATE INDEX IF NOT EXISTS idx_billing_records_customer ON billing_records(customer_id);
CREATE INDEX IF NOT EXISTS idx_billing_records_created ON billing_records(created_at);
CREATE INDEX IF NOT EXISTS idx_billing_records_type ON billing_records(cost_type);
CREATE INDEX IF NOT EXISTS idx_billing_records_agent ON billing_records(agent_name);
CREATE INDEX IF NOT EXISTS idx_billing_records_session ON billing_records(session_id);

-- ═══════════════════════════════════════════════════════════════════════════
-- PRICING CATALOG — pricing configuration for billing
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS pricing_catalog (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL DEFAULT '',
  model text NOT NULL DEFAULT '',
  resource_type text NOT NULL DEFAULT '',      -- llm / tool / sandbox / connector
  operation text NOT NULL DEFAULT '',          -- infer / web-search / exec
  unit text NOT NULL DEFAULT '',               -- input_token / output_token / call / second
  unit_price_usd real NOT NULL DEFAULT 0.0,
  currency text NOT NULL DEFAULT 'USD',
  source text NOT NULL DEFAULT 'manual',       -- manual / synced
  pricing_version text NOT NULL DEFAULT '',
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to timestamptz,
  is_active boolean NOT NULL DEFAULT true,
  metadata_json jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pricing_catalog_lookup ON pricing_catalog(resource_type, provider, model, operation, unit, is_active, effective_from);
CREATE INDEX IF NOT EXISTS idx_pricing_catalog_effective ON pricing_catalog(effective_from, effective_to);

CREATE TRIGGER update_pricing_catalog_updated_at BEFORE UPDATE ON pricing_catalog
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
