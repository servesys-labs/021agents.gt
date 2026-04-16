-- x402 Payment Records: tracks all agent-to-agent payments
CREATE TABLE IF NOT EXISTS x402_payments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payer_org_id  UUID REFERENCES orgs(org_id),
  payer_user_id UUID REFERENCES users(user_id),
  payee_org_id  UUID REFERENCES orgs(org_id),
  agent_name    TEXT NOT NULL,
  tool_name     TEXT NOT NULL,
  amount_wei    BIGINT NOT NULL,
  amount_usd    NUMERIC(12,6) NOT NULL,
  network       TEXT NOT NULL DEFAULT 'eip155:84532',
  tx_hash       TEXT,
  status        TEXT NOT NULL DEFAULT 'pending', -- pending, confirmed, settled, failed
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_x402_payer ON x402_payments (payer_org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_x402_payee ON x402_payments (payee_org_id, created_at DESC);

-- A2A Task Store: persists A2A protocol tasks
CREATE TABLE IF NOT EXISTS a2a_tasks (
  id            TEXT PRIMARY KEY,
  agent_name    TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'submitted', -- submitted, working, completed, failed
  input_message TEXT,
  output_message TEXT,
  skill         TEXT,
  requester_url TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- MLM Revenue Sharing: multi-level referral tracking
CREATE TABLE IF NOT EXISTS referrals (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_id     UUID NOT NULL REFERENCES users(user_id),
  referred_id     UUID NOT NULL REFERENCES users(user_id),
  referral_code   TEXT NOT NULL,
  tier            INT NOT NULL DEFAULT 1, -- 1 = direct, 2 = second level, 3 = third level
  status          TEXT NOT NULL DEFAULT 'active', -- active, expired, revoked
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(referrer_id, referred_id)
);

CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals (referrer_id);
CREATE INDEX IF NOT EXISTS idx_referrals_code ON referrals (referral_code);

-- Revenue sharing ledger: tracks commission payments
CREATE TABLE IF NOT EXISTS revenue_shares (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_payment_id UUID REFERENCES x402_payments(id),
  beneficiary_id  UUID NOT NULL REFERENCES users(user_id),
  tier            INT NOT NULL, -- which referral tier earned this
  share_pct       NUMERIC(5,2) NOT NULL, -- percentage of original payment
  amount_usd      NUMERIC(12,6) NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending', -- pending, credited, paid_out
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_revenue_shares_beneficiary ON revenue_shares (beneficiary_id, created_at DESC);

-- Referral codes on users
ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code TEXT UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by UUID REFERENCES users(user_id);

-- MLM tier config (platform-level)
CREATE TABLE IF NOT EXISTS mlm_config (
  tier            INT PRIMARY KEY,
  share_pct       NUMERIC(5,2) NOT NULL, -- percentage of each payment
  label           TEXT NOT NULL
);

INSERT INTO mlm_config (tier, share_pct, label) VALUES
  (1, 10.00, 'Direct Referral'),
  (2, 5.00, 'Second Level'),
  (3, 2.50, 'Third Level')
ON CONFLICT (tier) DO NOTHING;
