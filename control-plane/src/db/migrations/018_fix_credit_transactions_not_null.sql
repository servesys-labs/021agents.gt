-- Migration 018: Fix credit_transactions NOT NULL constraint that breaks all audit INSERTs
-- The amount_cents and balance_after_cents columns from migration 011 have NOT NULL
-- without DEFAULT, but all application code only writes amount_usd/balance_after_usd.
-- Every INSERT that omits the _cents columns fails silently.

ALTER TABLE credit_transactions ALTER COLUMN amount_cents SET DEFAULT 0;
ALTER TABLE credit_transactions ALTER COLUMN balance_after_cents SET DEFAULT 0;

-- Also fix org_credit_balance if it has similar issues
DO $$ BEGIN
  ALTER TABLE org_credit_balance ALTER COLUMN balance_cents SET DEFAULT 0;
  ALTER TABLE org_credit_balance ALTER COLUMN lifetime_purchased_cents SET DEFAULT 0;
  ALTER TABLE org_credit_balance ALTER COLUMN lifetime_consumed_cents SET DEFAULT 0;
EXCEPTION WHEN undefined_column THEN NULL;
END $$;
