-- Add missing settings_json used by onboarding + meta-agent context loading.
ALTER TABLE org_settings
ADD COLUMN IF NOT EXISTS settings_json jsonb DEFAULT '{}';
