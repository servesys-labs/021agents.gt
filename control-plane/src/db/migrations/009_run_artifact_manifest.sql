-- First-class run artifact manifest for auditable artifact tracking.
CREATE TABLE IF NOT EXISTS run_artifacts (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL,
  org_id TEXT NOT NULL DEFAULT '',
  agent_name TEXT NOT NULL DEFAULT '',
  turn_number INT NOT NULL DEFAULT 0,
  artifact_name TEXT NOT NULL,
  artifact_kind TEXT NOT NULL DEFAULT 'generic',
  mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  size_bytes BIGINT NOT NULL DEFAULT 0,
  storage_key TEXT NOT NULL DEFAULT '',
  source_tool TEXT NOT NULL DEFAULT '',
  source_event TEXT NOT NULL DEFAULT '',
  schema_version TEXT,
  status TEXT NOT NULL DEFAULT 'available',
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_run_artifacts_session
    FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE,
  CONSTRAINT uq_run_artifacts_identity
    UNIQUE (session_id, artifact_name, storage_key)
);

CREATE INDEX IF NOT EXISTS idx_run_artifacts_session ON run_artifacts(session_id);
CREATE INDEX IF NOT EXISTS idx_run_artifacts_org_created ON run_artifacts(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_run_artifacts_storage_key ON run_artifacts(storage_key);
