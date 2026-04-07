-- Migration 003: Referral anti-gaming safeguards
-- Adds: minimum transaction threshold, transfer rate limits, circular transfer detection, minimum activity gate

-- Track transfer pairs for circular detection
CREATE TABLE IF NOT EXISTS transfer_pairs (
  id              BIGSERIAL PRIMARY KEY,
  from_org_id     TEXT NOT NULL,
  to_org_id       TEXT NOT NULL,
  amount_usd      NUMERIC(12,8) NOT NULL DEFAULT 0,
  transfer_id     TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_transfer_pairs_orgs
  ON transfer_pairs (from_org_id, to_org_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_transfer_pairs_window
  ON transfer_pairs (created_at DESC);

-- Track per-org transfer rate limits
CREATE TABLE IF NOT EXISTS transfer_rate_limits (
  org_id          TEXT PRIMARY KEY,
  transfers_this_hour INT NOT NULL DEFAULT 0,
  hour_window     TIMESTAMPTZ NOT NULL DEFAULT date_trunc('hour', NOW()),
  volume_today_usd NUMERIC(12,8) NOT NULL DEFAULT 0,
  day_window      DATE NOT NULL DEFAULT CURRENT_DATE,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Track referred org activity for minimum activity gate
-- Referral payouts only activate after the referred org reaches the threshold
ALTER TABLE referrals
  ADD COLUMN IF NOT EXISTS referral_activated BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS referred_task_count INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS referred_volume_usd NUMERIC(12,8) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS activated_at TIMESTAMPTZ;
