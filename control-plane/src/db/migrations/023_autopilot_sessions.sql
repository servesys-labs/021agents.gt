-- Autopilot sessions: tracks always-on autonomous agent sessions
CREATE TABLE IF NOT EXISTS autopilot_sessions (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'web',           -- web, telegram, discord, slack
  channel_user_id TEXT DEFAULT '',                -- for chat platform delivery
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'stopped')),
  tick_interval_seconds INTEGER NOT NULL DEFAULT 30,
  last_tick_at TIMESTAMPTZ,
  tick_count INTEGER DEFAULT 0,
  total_cost_usd NUMERIC(12,6) DEFAULT 0,
  system_addendum TEXT DEFAULT '',                -- custom autopilot prompt
  config_json JSONB DEFAULT '{}',                 -- channel-specific config (e.g. telegram chat_id)
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(org_id, agent_name, channel, channel_user_id)
);

CREATE INDEX IF NOT EXISTS idx_autopilot_active ON autopilot_sessions(status, last_tick_at)
  WHERE status = 'active';
