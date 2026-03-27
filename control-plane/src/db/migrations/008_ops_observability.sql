-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 008: Ops observability — alert configs, alert history, budget columns
-- Enables configurable metric alerts with webhook delivery and cooldowns.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Alert configurations ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS alert_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  name text NOT NULL,
  type text NOT NULL CHECK (type IN ('error_rate', 'latency_p95', 'cost_daily', 'agent_down', 'webhook_failures', 'batch_failures')),
  agent_name text DEFAULT '',              -- empty = all agents
  threshold numeric NOT NULL,
  comparison text NOT NULL DEFAULT 'gte' CHECK (comparison IN ('gte', 'lte', 'gt', 'lt')),
  window_minutes int DEFAULT 60,
  webhook_url text DEFAULT '',
  webhook_secret text DEFAULT '',
  enabled boolean DEFAULT true,
  last_triggered_at timestamptz,
  cooldown_minutes int DEFAULT 15,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_alert_configs_org ON alert_configs(org_id, enabled);

-- ── Alert history ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS alert_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id text NOT NULL,
  alert_config_id uuid REFERENCES alert_configs(id),
  type text NOT NULL,
  agent_name text DEFAULT '',
  metric_value numeric NOT NULL,
  threshold numeric NOT NULL,
  status text DEFAULT 'fired' CHECK (status IN ('fired', 'resolved', 'acknowledged')),
  webhook_delivered boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_alert_history_org ON alert_history(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_alert_history_config ON alert_history(alert_config_id, created_at DESC);

-- ── Budget columns on org_settings ─────────────────────────────────────────
ALTER TABLE org_settings ADD COLUMN IF NOT EXISTS monthly_budget_usd numeric(10,2) DEFAULT 0;
ALTER TABLE org_settings ADD COLUMN IF NOT EXISTS daily_budget_usd numeric(10,2) DEFAULT 0;
ALTER TABLE org_settings ADD COLUMN IF NOT EXISTS budget_alert_pct int DEFAULT 80;
