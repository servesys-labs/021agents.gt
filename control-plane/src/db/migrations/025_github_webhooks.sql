CREATE TABLE IF NOT EXISTS github_webhook_subscriptions (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  repo_url TEXT NOT NULL,
  events JSONB DEFAULT '["push", "pull_request", "issues"]',
  secret TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(org_id, repo_url)
);
