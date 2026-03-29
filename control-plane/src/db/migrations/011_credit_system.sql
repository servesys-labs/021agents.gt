-- Credit balance per org (atomic updates via UPDATE ... SET balance = balance - X)
CREATE TABLE IF NOT EXISTS org_credit_balance (
  org_id text PRIMARY KEY,
  balance_cents int NOT NULL DEFAULT 0,        -- current balance in cents ($1 = 100 cents)
  lifetime_purchased_cents int DEFAULT 0,       -- total ever purchased
  lifetime_consumed_cents int DEFAULT 0,        -- total ever consumed
  last_purchase_at timestamptz,
  last_deduction_at timestamptz,
  updated_at timestamptz DEFAULT now()
);

-- Credit transaction log (immutable audit trail)
CREATE TABLE IF NOT EXISTS credit_transactions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id text NOT NULL,
  type text NOT NULL CHECK (type IN ('purchase', 'burn', 'refund', 'adjustment', 'bonus')),
  amount_cents int NOT NULL,                    -- positive for credit, negative for debit
  balance_after_cents int NOT NULL,             -- balance snapshot after this transaction
  description text DEFAULT '',
  reference_id text DEFAULT '',                 -- stripe session ID, session_id, etc.
  reference_type text DEFAULT '',               -- 'stripe_checkout', 'agent_run', 'manual', etc.
  agent_name text DEFAULT '',
  session_id text DEFAULT '',
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_credit_tx_org ON credit_transactions(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_credit_tx_type ON credit_transactions(org_id, type);

-- Stripe event deduplication
CREATE TABLE IF NOT EXISTS stripe_events_processed (
  event_id text PRIMARY KEY,
  event_type text NOT NULL,
  processed_at timestamptz DEFAULT now()
);

-- Credit packages (what customers can buy)
CREATE TABLE IF NOT EXISTS credit_packages (
  id text PRIMARY KEY,
  name text NOT NULL,
  credits_cents int NOT NULL,                   -- how many credit-cents you get
  price_cents int NOT NULL,                     -- how much it costs in real USD cents
  stripe_price_id text DEFAULT '',
  bonus_pct int DEFAULT 0,                      -- e.g., 10 means 10% bonus credits
  is_active boolean DEFAULT true,
  sort_order int DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

-- Seed default packages
INSERT INTO credit_packages (id, name, credits_cents, price_cents, bonus_pct, sort_order) VALUES
  ('starter', 'Starter', 1000, 1000, 0, 1),         -- $10 -> 1000 credits ($10.00)
  ('growth', 'Growth', 5500, 5000, 10, 2),           -- $50 -> 5500 credits (10% bonus)
  ('scale', 'Scale', 12000, 10000, 20, 3)            -- $100 -> 12000 credits (20% bonus)
ON CONFLICT (id) DO NOTHING;
