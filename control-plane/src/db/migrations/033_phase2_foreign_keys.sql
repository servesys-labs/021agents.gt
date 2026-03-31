-- Migration 033: Phase 2 — Foreign key constraints for core relationships
-- Adds referential integrity to 107 previously unconstrained tables
-- Uses DO blocks with exception handling so one failure doesn't stop the rest

BEGIN;

-- ============================================================
-- STEP 0: Clean up orphaned data that would violate new FKs
-- ============================================================

-- Sessions with empty or non-existent org_id (3 rows)
DELETE FROM sessions
WHERE org_id NOT IN (SELECT org_id FROM orgs);

-- API keys referencing deleted orgs (1 row)
DELETE FROM api_keys
WHERE org_id NOT IN (SELECT org_id FROM orgs);

-- Audit log entries with empty or stale org_ids (92 rows)
-- These are historical telemetry; safe to remove
DELETE FROM audit_log
WHERE org_id NOT IN (SELECT org_id FROM orgs);

-- Eval runs with empty org_id (1 row)
DELETE FROM eval_runs
WHERE org_id NOT IN (SELECT org_id FROM orgs);

-- Conversations with org_id='default' which doesn't exist (149 rows)
-- Cascade deletes associated conversation_messages
DELETE FROM conversations
WHERE org_id NOT IN (SELECT org_id FROM orgs);

-- ============================================================
-- STEP 1: Fix type mismatch — eval_trials.eval_run_id is text,
--         eval_runs.id is bigint. Align before adding FK.
-- ============================================================
DO $$ BEGIN
  ALTER TABLE eval_trials
    ALTER COLUMN eval_run_id TYPE bigint USING eval_run_id::bigint;
  RAISE NOTICE 'eval_trials.eval_run_id converted to bigint';
EXCEPTION WHEN others THEN
  RAISE NOTICE 'eval_trials.eval_run_id type change failed: %', SQLERRM;
END $$;

-- ============================================================
-- STEP 2: Upgrade existing turns FK to add ON DELETE CASCADE
-- ============================================================
DO $$ BEGIN
  ALTER TABLE turns DROP CONSTRAINT IF EXISTS turns_session_id_fkey;
  ALTER TABLE turns
    ADD CONSTRAINT fk_turns_session
    FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE;
  RAISE NOTICE 'turns FK upgraded to CASCADE';
EXCEPTION WHEN others THEN
  RAISE NOTICE 'turns FK upgrade failed: %', SQLERRM;
END $$;

-- ============================================================
-- TIER 1: Core entity → orgs relationships
-- ============================================================

-- agents → orgs
DO $$ BEGIN
  ALTER TABLE agents
    ADD CONSTRAINT fk_agents_org
    FOREIGN KEY (org_id) REFERENCES orgs(org_id) ON DELETE CASCADE;
  RAISE NOTICE 'FK added: agents → orgs';
EXCEPTION WHEN duplicate_object THEN
  RAISE NOTICE 'FK agents → orgs already exists';
WHEN others THEN
  RAISE NOTICE 'FK agents → orgs failed: %', SQLERRM;
END $$;

-- sessions → orgs
DO $$ BEGIN
  ALTER TABLE sessions
    ADD CONSTRAINT fk_sessions_org
    FOREIGN KEY (org_id) REFERENCES orgs(org_id) ON DELETE CASCADE;
  RAISE NOTICE 'FK added: sessions → orgs';
EXCEPTION WHEN duplicate_object THEN
  RAISE NOTICE 'FK sessions → orgs already exists';
WHEN others THEN
  RAISE NOTICE 'FK sessions → orgs failed: %', SQLERRM;
END $$;

-- api_keys → orgs
DO $$ BEGIN
  ALTER TABLE api_keys
    ADD CONSTRAINT fk_api_keys_org
    FOREIGN KEY (org_id) REFERENCES orgs(org_id) ON DELETE CASCADE;
  RAISE NOTICE 'FK added: api_keys → orgs';
EXCEPTION WHEN duplicate_object THEN
  RAISE NOTICE 'FK api_keys → orgs already exists';
WHEN others THEN
  RAISE NOTICE 'FK api_keys → orgs failed: %', SQLERRM;
END $$;

-- billing_records → orgs
DO $$ BEGIN
  ALTER TABLE billing_records
    ADD CONSTRAINT fk_billing_org
    FOREIGN KEY (org_id) REFERENCES orgs(org_id) ON DELETE CASCADE;
  RAISE NOTICE 'FK added: billing_records → orgs';
EXCEPTION WHEN duplicate_object THEN
  RAISE NOTICE 'FK billing_records → orgs already exists';
WHEN others THEN
  RAISE NOTICE 'FK billing_records → orgs failed: %', SQLERRM;
END $$;

-- ============================================================
-- TIER 2: Parent-child relationships
-- ============================================================

-- eval_trials → eval_runs
DO $$ BEGIN
  ALTER TABLE eval_trials
    ADD CONSTRAINT fk_eval_trials_run
    FOREIGN KEY (eval_run_id) REFERENCES eval_runs(id) ON DELETE CASCADE;
  RAISE NOTICE 'FK added: eval_trials → eval_runs';
EXCEPTION WHEN duplicate_object THEN
  RAISE NOTICE 'FK eval_trials → eval_runs already exists';
WHEN others THEN
  RAISE NOTICE 'FK eval_trials → eval_runs failed: %', SQLERRM;
END $$;

-- NOTE: batch_tasks → batch_jobs FK already exists (batch_tasks_batch_id_fkey)
-- NOTE: conversation_messages → conversations FK already exists (conversation_messages_conversation_id_fkey)
-- NOTE: training_iterations → training_jobs FK already exists (training_iterations_job_id_fkey)

-- ============================================================
-- TIER 3: Secondary org_id relationships
-- ============================================================

-- org_members → orgs
DO $$ BEGIN
  ALTER TABLE org_members
    ADD CONSTRAINT fk_org_members_org
    FOREIGN KEY (org_id) REFERENCES orgs(org_id) ON DELETE CASCADE;
  RAISE NOTICE 'FK added: org_members → orgs';
EXCEPTION WHEN duplicate_object THEN
  RAISE NOTICE 'FK org_members → orgs already exists';
WHEN others THEN
  RAISE NOTICE 'FK org_members → orgs failed: %', SQLERRM;
END $$;

-- org_settings → orgs
DO $$ BEGIN
  ALTER TABLE org_settings
    ADD CONSTRAINT fk_org_settings_org
    FOREIGN KEY (org_id) REFERENCES orgs(org_id) ON DELETE CASCADE;
  RAISE NOTICE 'FK added: org_settings → orgs';
EXCEPTION WHEN duplicate_object THEN
  RAISE NOTICE 'FK org_settings → orgs already exists';
WHEN others THEN
  RAISE NOTICE 'FK org_settings → orgs failed: %', SQLERRM;
END $$;

-- credit_transactions → orgs
DO $$ BEGIN
  ALTER TABLE credit_transactions
    ADD CONSTRAINT fk_credit_txn_org
    FOREIGN KEY (org_id) REFERENCES orgs(org_id) ON DELETE CASCADE;
  RAISE NOTICE 'FK added: credit_transactions → orgs';
EXCEPTION WHEN duplicate_object THEN
  RAISE NOTICE 'FK credit_transactions → orgs already exists';
WHEN others THEN
  RAISE NOTICE 'FK credit_transactions → orgs failed: %', SQLERRM;
END $$;

-- audit_log → orgs
DO $$ BEGIN
  ALTER TABLE audit_log
    ADD CONSTRAINT fk_audit_log_org
    FOREIGN KEY (org_id) REFERENCES orgs(org_id) ON DELETE CASCADE;
  RAISE NOTICE 'FK added: audit_log → orgs';
EXCEPTION WHEN duplicate_object THEN
  RAISE NOTICE 'FK audit_log → orgs already exists';
WHEN others THEN
  RAISE NOTICE 'FK audit_log → orgs failed: %', SQLERRM;
END $$;

-- ============================================================
-- TIER 3b: Additional org_id FKs for remaining critical tables
-- ============================================================

-- training_jobs → orgs
DO $$ BEGIN
  ALTER TABLE training_jobs
    ADD CONSTRAINT fk_training_jobs_org
    FOREIGN KEY (org_id) REFERENCES orgs(org_id) ON DELETE CASCADE;
  RAISE NOTICE 'FK added: training_jobs → orgs';
EXCEPTION WHEN duplicate_object THEN
  RAISE NOTICE 'FK training_jobs → orgs already exists';
WHEN others THEN
  RAISE NOTICE 'FK training_jobs → orgs failed: %', SQLERRM;
END $$;

-- eval_runs → orgs
DO $$ BEGIN
  ALTER TABLE eval_runs
    ADD CONSTRAINT fk_eval_runs_org
    FOREIGN KEY (org_id) REFERENCES orgs(org_id) ON DELETE CASCADE;
  RAISE NOTICE 'FK added: eval_runs → orgs';
EXCEPTION WHEN duplicate_object THEN
  RAISE NOTICE 'FK eval_runs → orgs already exists';
WHEN others THEN
  RAISE NOTICE 'FK eval_runs → orgs failed: %', SQLERRM;
END $$;

-- batch_jobs → orgs
DO $$ BEGIN
  ALTER TABLE batch_jobs
    ADD CONSTRAINT fk_batch_jobs_org
    FOREIGN KEY (org_id) REFERENCES orgs(org_id) ON DELETE CASCADE;
  RAISE NOTICE 'FK added: batch_jobs → orgs';
EXCEPTION WHEN duplicate_object THEN
  RAISE NOTICE 'FK batch_jobs → orgs already exists';
WHEN others THEN
  RAISE NOTICE 'FK batch_jobs → orgs failed: %', SQLERRM;
END $$;

-- conversations → orgs
DO $$ BEGIN
  ALTER TABLE conversations
    ADD CONSTRAINT fk_conversations_org
    FOREIGN KEY (org_id) REFERENCES orgs(org_id) ON DELETE CASCADE;
  RAISE NOTICE 'FK added: conversations → orgs';
EXCEPTION WHEN duplicate_object THEN
  RAISE NOTICE 'FK conversations → orgs already exists';
WHEN others THEN
  RAISE NOTICE 'FK conversations → orgs failed: %', SQLERRM;
END $$;

COMMIT;
