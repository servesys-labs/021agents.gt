-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 034: Enable RLS on do_conversation_messages
-- ═══════════════════════════════════════════════════════════════════════════
-- This table was created dynamically by the runtime (deploy/src/runtime/db.ts)
-- and was missed by migrations 028 and 030. It has no org_id column, so it
-- gets the service-role-only pattern: only the service_role key can access it.
-- The anon key and authenticated users without service_role get zero rows.
-- ═══════════════════════════════════════════════════════════════════════════

-- Enable RLS (idempotent — safe to re-run)
ALTER TABLE IF EXISTS do_conversation_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS do_conversation_messages FORCE ROW LEVEL SECURITY;

-- Service-role full access (same pattern as 028/030 service-only tables)
DO $$
BEGIN
  CREATE POLICY do_conversation_messages_service_only
    ON do_conversation_messages
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Revoke anon access (belt + suspenders)
REVOKE ALL ON do_conversation_messages FROM anon;
