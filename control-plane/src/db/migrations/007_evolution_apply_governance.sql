-- Evolution apply autopilot: extra ledger context for gates and before/after markers

DO $$ BEGIN
  ALTER TABLE evolution_ledger ADD COLUMN apply_context_json TEXT DEFAULT '{}';
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;
