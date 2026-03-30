-- Migration 017: Agentic Referral Program
-- Referrers earn a share of platform fees when agents they referred transact.
-- Capped at 2 levels. No buy-in. Revenue from real transactions only.
--
-- Fee split on every A2A credit transfer:
--   10% platform fee total
--   → 5% to L1 referrer (who referred the earning agent's org)
--   → 2% to L2 referrer (who referred the L1 referrer)
--   → 3% retained by platform
--   If no referrer: platform keeps full 10%

-- ══════════════════════════════════════════════════════════════════
-- 1. Referral relationships (who referred whom)
-- ══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS referrals (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  referrer_org_id TEXT NOT NULL,         -- the org that made the referral
  referred_org_id TEXT NOT NULL UNIQUE,  -- the org that was referred (1 referrer per org)
  referrer_user_id TEXT,                 -- specific user who shared the link
  referral_code TEXT NOT NULL,           -- the code used
  status TEXT NOT NULL DEFAULT 'active', -- active, revoked
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_org_id);
CREATE INDEX IF NOT EXISTS idx_referrals_code ON referrals(referral_code);

-- ══════════════════════════════════════════════════════════════════
-- 2. Referral codes (each org gets one, can create custom ones)
-- ══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS referral_codes (
  code TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  user_id TEXT,
  label TEXT,                            -- "My Twitter link", "Conference card"
  uses INTEGER NOT NULL DEFAULT 0,
  max_uses INTEGER,                      -- null = unlimited
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_referral_codes_org ON referral_codes(org_id);

-- ══════════════════════════════════════════════════════════════════
-- 3. Referral earnings (audit trail of every payout)
-- ══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS referral_earnings (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  earner_org_id TEXT NOT NULL,           -- who earned
  source_org_id TEXT NOT NULL,           -- whose transaction generated the earning
  transfer_id TEXT NOT NULL,             -- the A2A transfer that triggered this
  level INTEGER NOT NULL,                -- 1 = direct referral, 2 = second level
  platform_fee_usd NUMERIC(20,6) NOT NULL,  -- total platform fee on the transfer
  earning_usd NUMERIC(20,6) NOT NULL,       -- amount earned by this referrer
  earning_rate NUMERIC(5,4) NOT NULL,       -- 0.05 for L1, 0.02 for L2
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_referral_earnings_earner ON referral_earnings(earner_org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_referral_earnings_source ON referral_earnings(source_org_id);

-- ══════════════════════════════════════════════════════════════════
-- 4. Referral summary view (for dashboard)
-- ══════════════════════════════════════════════════════════════════

CREATE OR REPLACE VIEW referral_summary AS
SELECT
  earner_org_id AS org_id,
  COUNT(DISTINCT source_org_id) AS referred_orgs,
  COUNT(*) AS total_earnings,
  COALESCE(SUM(earning_usd), 0) AS total_earned_usd,
  COALESCE(SUM(earning_usd) FILTER (WHERE level = 1), 0) AS l1_earned_usd,
  COALESCE(SUM(earning_usd) FILTER (WHERE level = 2), 0) AS l2_earned_usd,
  MAX(created_at) AS last_earning_at
FROM referral_earnings
GROUP BY earner_org_id;

-- Seed: auto-create a default referral code for every existing org
INSERT INTO referral_codes (code, org_id, label)
SELECT
  LOWER(SUBSTRING(org_id FROM 1 FOR 8)),
  org_id,
  'Default'
FROM orgs
WHERE org_id NOT IN (SELECT org_id FROM referral_codes)
ON CONFLICT DO NOTHING;
