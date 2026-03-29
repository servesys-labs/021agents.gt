-- Voice phone numbers provisioned via Twilio (or other telephony providers)
-- Links a phone number to an org + agent for inbound call routing.

CREATE TABLE IF NOT EXISTS voice_numbers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  agent_name text NOT NULL,
  phone_number text NOT NULL UNIQUE,
  provider text NOT NULL DEFAULT 'twilio',
  provider_sid text DEFAULT '',
  status text DEFAULT 'active',
  config jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_voice_numbers_org ON voice_numbers(org_id);
CREATE INDEX IF NOT EXISTS idx_voice_numbers_phone ON voice_numbers(phone_number);
CREATE INDEX IF NOT EXISTS idx_voice_numbers_agent ON voice_numbers(org_id, agent_name);
