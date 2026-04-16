-- ============================================================================
-- Migration 003: Email + Phone channels for agents
--
-- Each agent gets an email address ({handle}@021agents.ai) and optionally
-- a phone number. Email routing uses Cloudflare Email Workers; phone uses
-- Twilio/Vonage via webhook (future).
-- ============================================================================

ALTER TABLE agents ADD COLUMN IF NOT EXISTS email_address TEXT UNIQUE;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS phone_number TEXT UNIQUE;

-- Populate email addresses for existing agents from their name
UPDATE agents SET email_address = LOWER(REPLACE(name, ' ', '-')) || '@021agents.ai'
  WHERE email_address IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_email ON agents(email_address) WHERE email_address IS NOT NULL;
