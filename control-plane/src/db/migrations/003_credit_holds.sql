-- 003_credit_holds.sql
-- Hold/reservation-based billing primitives for runtime execution.

ALTER TABLE org_credit_balance
  ADD COLUMN IF NOT EXISTS reserved_usd NUMERIC(18,8) NOT NULL DEFAULT 0;

-- CHECK constraints on monetary columns (M2 hardening). Additive, wrapped
-- in DO block so re-running the migration against a db that already has
-- them is safe.
DO $$ BEGIN
  ALTER TABLE org_credit_balance
    ADD CONSTRAINT org_credit_balance_balance_nonneg CHECK (balance_usd >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE org_credit_balance
    ADD CONSTRAINT org_credit_balance_reserved_nonneg CHECK (reserved_usd >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS credit_holds (
  hold_id          TEXT PRIMARY KEY,
  org_id           TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
  session_id       TEXT NOT NULL DEFAULT '',
  parent_hold_id   TEXT REFERENCES credit_holds(hold_id) ON DELETE SET NULL,
  agent_name       TEXT NOT NULL DEFAULT '',
  hold_amount_usd  NUMERIC(18,8) NOT NULL DEFAULT 0 CHECK (hold_amount_usd >= 0),
  status           TEXT NOT NULL CHECK (status IN ('active', 'settled', 'released', 'expired')),
  expires_at       TIMESTAMPTZ NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  settled_at       TIMESTAMPTZ,
  actual_cost_usd  NUMERIC(18,8) CHECK (actual_cost_usd IS NULL OR actual_cost_usd >= 0),
  UNIQUE (org_id, session_id)
);

-- If the table already existed from a prior migration run, add the new
-- updated_at column idempotently.
ALTER TABLE credit_holds ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_credit_holds_expires_active
  ON credit_holds(expires_at)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_credit_holds_org_status
  ON credit_holds(org_id, status)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS billing_exceptions (
  id              BIGSERIAL PRIMARY KEY,
  org_id          TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
  session_id      TEXT,
  hold_id         TEXT REFERENCES credit_holds(hold_id) ON DELETE SET NULL,
  kind            TEXT NOT NULL DEFAULT 'unknown',
  amount_usd      NUMERIC(18,8) NOT NULL DEFAULT 0 CHECK (amount_usd >= 0),
  resolved_at     TIMESTAMPTZ,
  exception_type  TEXT NOT NULL,
  expected_usd    NUMERIC(18,8) NOT NULL DEFAULT 0 CHECK (expected_usd >= 0),
  actual_usd      NUMERIC(18,8) NOT NULL DEFAULT 0 CHECK (actual_usd >= 0),
  charged_usd     NUMERIC(18,8) NOT NULL DEFAULT 0 CHECK (charged_usd >= 0),
  error_message   TEXT NOT NULL DEFAULT '',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE billing_exceptions ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE billing_exceptions ADD COLUMN IF NOT EXISTS amount_usd NUMERIC(18,8) NOT NULL DEFAULT 0;
ALTER TABLE billing_exceptions ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;
ALTER TABLE billing_exceptions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- CHECK constraints on billing_exceptions monetary columns (M2 hardening),
-- wrapped to stay idempotent on re-runs.
DO $$ BEGIN
  ALTER TABLE billing_exceptions
    ADD CONSTRAINT billing_exceptions_amount_nonneg CHECK (amount_usd >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE billing_exceptions
    ADD CONSTRAINT billing_exceptions_expected_nonneg CHECK (expected_usd >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE billing_exceptions
    ADD CONSTRAINT billing_exceptions_actual_nonneg CHECK (actual_usd >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE billing_exceptions
    ADD CONSTRAINT billing_exceptions_charged_nonneg CHECK (charged_usd >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE credit_holds
    ADD CONSTRAINT credit_holds_hold_amount_nonneg CHECK (hold_amount_usd >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE credit_holds
    ADD CONSTRAINT credit_holds_actual_cost_nonneg CHECK (actual_cost_usd IS NULL OR actual_cost_usd >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- updated_at triggers matching the org_credit_balance pattern.
DROP TRIGGER IF EXISTS set_updated_at_credit_holds ON credit_holds;
CREATE TRIGGER set_updated_at_credit_holds BEFORE UPDATE ON credit_holds FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS set_updated_at_billing_exceptions ON billing_exceptions;
CREATE TRIGGER set_updated_at_billing_exceptions BEFORE UPDATE ON billing_exceptions FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE INDEX IF NOT EXISTS idx_billing_exceptions_org_created_at
  ON billing_exceptions(org_id, created_at DESC);

ALTER TABLE credit_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_holds FORCE ROW LEVEL SECURITY;
DO $$ BEGIN CREATE POLICY credit_holds_org_isolation ON credit_holds
  FOR ALL USING (org_id = current_org_id());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE billing_exceptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_exceptions FORCE ROW LEVEL SECURITY;
DO $$ BEGIN CREATE POLICY billing_exceptions_org_isolation ON billing_exceptions
  FOR ALL USING (org_id = current_org_id());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
