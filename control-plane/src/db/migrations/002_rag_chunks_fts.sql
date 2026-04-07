-- rag_chunks: BM25 full-text search index for hybrid RAG
-- Parallel to Vectorize (dense vectors) — stores chunk text with tsvector for keyword search.
-- Used by /cf/rag/query for Reciprocal Rank Fusion (BM25 + vector).

CREATE TABLE IF NOT EXISTS rag_chunks (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  pipeline TEXT NOT NULL DEFAULT 'text',
  org_id TEXT NOT NULL DEFAULT '',
  agent_name TEXT NOT NULL DEFAULT '',
  chunk_index INTEGER NOT NULL DEFAULT 0,
  chunk_type TEXT NOT NULL DEFAULT 'prose',
  text TEXT NOT NULL,
  context_prefix TEXT NOT NULL DEFAULT '',
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(context_prefix, '') || ' ' || text)) STORED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rag_chunks_tsv ON rag_chunks USING GIN (tsv);
CREATE INDEX IF NOT EXISTS idx_rag_chunks_source ON rag_chunks (source);
CREATE INDEX IF NOT EXISTS idx_rag_chunks_org ON rag_chunks (org_id, agent_name);
