-- ============================================================================
-- 002_skill_learning.sql — Phase 6: skill overlays + mutation audit log
-- ============================================================================
--
-- Adds two tables that close the self-improvement loop:
--
--   skill_overlays — per-org, per-agent learned rules that layer on top of
--     BUILTIN (disk-based) SKILL.md files at load time. Separate from the
--     `skills` table (which holds full standalone custom skills) so row
--     semantics aren't overloaded and the shadow bug in formatSkillsPrompt
--     (`[...BUILTIN_SKILLS, ...skills]` emitting duplicates when a DB row
--     shares a name with a BUILTIN) can't be triggered by overlays.
--
--   skill_audit — append-only log of every skill mutation. Used for rate
--     limiting (10 mutations / day / skill), admin revert, and historical
--     reconstruction. before_content/after_content hold the full skill body
--     before and after the mutation; before_sha/after_sha are integrity
--     cross-checks — the revert endpoint MUST assert
--     sha256(before_content) === before_sha before restoring, and refuse if
--     the row was tampered with.
--
-- RLS mirrors the `skills` and `procedures` pattern: per-org isolation via
-- current_org_id(). Both layers (app-level userRole check + DB-level RLS)
-- apply — RLS is the defense-in-depth guarantee.
-- ============================================================================

CREATE TABLE IF NOT EXISTS skill_overlays (
  overlay_id  TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id      TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
  agent_name  TEXT NOT NULL DEFAULT '',
  skill_name  TEXT NOT NULL,
  rule_text   TEXT NOT NULL,
  source      TEXT NOT NULL DEFAULT 'improve',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_skill_overlays_lookup
  ON skill_overlays(org_id, agent_name, skill_name);

CREATE TABLE IF NOT EXISTS skill_audit (
  audit_id        TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id          TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
  skill_name      TEXT NOT NULL,
  agent_name      TEXT NOT NULL DEFAULT '',
  -- Nullable pointer at the overlay row this audit entry describes. Forward
  -- mutations (append_rule) populate it; revert audit rows leave it NULL
  -- since the overlay row has been deleted. Lets revert be a trivial
  -- DELETE FROM skill_overlays WHERE overlay_id = $1 instead of a
  -- reverse-lookup by content hash.
  overlay_id      TEXT REFERENCES skill_overlays(overlay_id) ON DELETE SET NULL,
  before_sha      TEXT NOT NULL,
  after_sha       TEXT NOT NULL,
  before_content  TEXT NOT NULL,
  after_content   TEXT NOT NULL,
  reason          TEXT NOT NULL DEFAULT '',
  source          TEXT NOT NULL DEFAULT 'improve',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_skill_audit_history
  ON skill_audit(org_id, skill_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_skill_audit_ratelimit
  ON skill_audit(skill_name, created_at);

ALTER TABLE skill_overlays ENABLE ROW LEVEL SECURITY;
ALTER TABLE skill_overlays FORCE ROW LEVEL SECURITY;
DO $$ BEGIN CREATE POLICY skill_overlays_org_isolation ON skill_overlays
  FOR ALL USING (org_id = current_org_id());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE skill_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE skill_audit FORCE ROW LEVEL SECURITY;
DO $$ BEGIN CREATE POLICY skill_audit_org_isolation ON skill_audit
  FOR ALL USING (org_id = current_org_id());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
