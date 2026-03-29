-- Channel configs: stores connected chat platform credentials/settings per org.
-- Used by Telegram, WhatsApp, Slack, Instagram, Messenger, SMS, Email, Widget integrations.

CREATE TABLE IF NOT EXISTS channel_configs (
  org_id       TEXT NOT NULL,
  channel      TEXT NOT NULL,             -- 'telegram', 'whatsapp', 'slack', 'instagram', 'messenger', 'sms', 'email', 'web_widget'
  agent_name   TEXT NOT NULL DEFAULT '',  -- which agent handles this channel (empty = org default)
  config       JSONB NOT NULL DEFAULT '{}'::jsonb,  -- platform-specific config (phone_number_id, team_id, page_id, etc.)
  is_active    BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (org_id, channel)
);

CREATE INDEX IF NOT EXISTS idx_channel_configs_channel ON channel_configs (channel, is_active);
CREATE INDEX IF NOT EXISTS idx_channel_configs_config ON channel_configs USING gin (config);
