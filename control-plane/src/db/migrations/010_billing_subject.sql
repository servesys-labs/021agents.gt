-- Attribution for usage-based billing (portal user, end-user id, or channel id + API key)

ALTER TABLE billing_records ADD COLUMN IF NOT EXISTS billing_user_id text NOT NULL DEFAULT '';
ALTER TABLE billing_records ADD COLUMN IF NOT EXISTS api_key_id text NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_billing_records_org_billing_user
  ON billing_records(org_id, billing_user_id)
  WHERE billing_user_id != '';

CREATE INDEX IF NOT EXISTS idx_billing_records_org_api_key
  ON billing_records(org_id, api_key_id)
  WHERE api_key_id != '';
