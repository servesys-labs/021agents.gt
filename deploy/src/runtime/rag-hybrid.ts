/**
 * Hybrid RAG Search — BM25 (Postgres FTS) + Dense Vectors (Vectorize) + Contextual Chunking
 *
 * Three major improvements over pure vector search:
 * 1. BM25 keyword search via Postgres tsvector — catches exact matches (unit numbers, names, IDs)
 * 2. Contextual chunk enrichment — LLM-generated context prefix per chunk (Anthropic's technique)
 * 3. Multi-query retrieval — 3 query variants for better recall
 *
 * Fusion: Reciprocal Rank Fusion (RRF) merges BM25 + vector results.
 */

import { log } from "./log";

// ── Types ─────────────────────────────────────────────────────────

export interface HybridSearchResult {
  id: string;
  text: string;
  context_prefix: string;
  source: string;
  pipeline: string;
  chunk_type: string;
  chunk_index: number;
  /** Combined RRF score (higher = better) */
  rrf_score: number;
  /** Individual scores for debugging */
  vector_score?: number;
  bm25_rank?: number;
}

export interface ChunkRecord {
  id: string;
  source: string;
  pipeline: string;
  org_id: string;
  agent_name: string;
  chunk_index: number;
  chunk_type: string;
  text: string;
  context_prefix: string;
}

// ── BM25 Search (Postgres FTS) ────────────────────────────────────

/**
 * Search rag_chunks using Postgres full-text search (BM25-equivalent).
 * Returns ranked results with ts_rank scores.
 */
export async function bm25Search(
  hyperdrive: any,
  query: string,
  opts: { org_id?: string; agent_name?: string; source?: string; pipeline?: string; limit?: number } = {},
): Promise<Array<{ id: string; text: string; context_prefix: string; source: string; pipeline: string; chunk_type: string; chunk_index: number; rank: number }>> {
  const { getDb } = await import("./db");
  const sql = await getDb(hyperdrive);
  const limit = opts.limit || 20;

  // Build tsquery from the search terms
  // Use plainto_tsquery for natural language queries
  try {
    // Build parameterized query with all filters
    const params: any[] = [query];
    const conditions: string[] = ["tsv @@ plainto_tsquery('english', $1)"];

    if (opts.org_id) {
      params.push(opts.org_id);
      conditions.push(`org_id = $${params.length}`);
    }
    if (opts.agent_name) {
      params.push(opts.agent_name);
      conditions.push(`agent_name = $${params.length}`);
    }
    if (opts.source) {
      params.push(opts.source);
      conditions.push(`source = $${params.length}`);
    }
    if (opts.pipeline) {
      params.push(opts.pipeline);
      conditions.push(`pipeline = $${params.length}`);
    }

    const whereClause = conditions.join(" AND ");
    const fullQuery = `
      SELECT id, text, context_prefix, source, pipeline, chunk_type, chunk_index,
             ts_rank(tsv, plainto_tsquery('english', $1)) as rank
      FROM rag_chunks
      WHERE ${whereClause}
      ORDER BY rank DESC
      LIMIT ${limit}
    `;

    const rows = await sql.unsafe(fullQuery, params);

    return rows.map((r: any) => ({
      id: String(r.id),
      text: String(r.text || ""),
      context_prefix: String(r.context_prefix || ""),
      source: String(r.source || ""),
      pipeline: String(r.pipeline || ""),
      chunk_type: String(r.chunk_type || ""),
      chunk_index: Number(r.chunk_index || 0),
      rank: Number(r.rank || 0),
    }));
  } catch (err) {
    log.error(`[rag-hybrid] BM25 search failed: ${err instanceof Error ? err.message : err}`);
    return [];
  }
}

// ── Store Chunks in Postgres (parallel to Vectorize) ──────────────

/**
 * Insert chunks into rag_chunks table for BM25 search.
 * Called alongside Vectorize upsert during ingestion.
 */
export async function storeChunksForBM25(
  hyperdrive: any,
  chunks: ChunkRecord[],
): Promise<number> {
  if (chunks.length === 0) return 0;
  const { getDb } = await import("./db");
  const sql = await getDb(hyperdrive);

  let stored = 0;
  // Batch insert in groups of 50
  for (let i = 0; i < chunks.length; i += 50) {
    const batch = chunks.slice(i, i + 50);
    try {
      for (const chunk of batch) {
        await sql`
          INSERT INTO rag_chunks (id, source, pipeline, org_id, agent_name, chunk_index, chunk_type, text, context_prefix)
          VALUES (${chunk.id}, ${chunk.source}, ${chunk.pipeline}, ${chunk.org_id}, ${chunk.agent_name},
                  ${chunk.chunk_index}, ${chunk.chunk_type}, ${chunk.text}, ${chunk.context_prefix})
          ON CONFLICT (id) DO UPDATE SET text = EXCLUDED.text, context_prefix = EXCLUDED.context_prefix
        `;
        stored++;
      }
    } catch (err) {
      log.error(`[rag-hybrid] BM25 store batch failed: ${err instanceof Error ? err.message : err}`);
    }
  }
  return stored;
}

// ── Reciprocal Rank Fusion ────────────────────────────────────────

/**
 * Merge BM25 and vector search results using Reciprocal Rank Fusion (RRF).
 * RRF score = sum(1 / (k + rank)) across all ranking lists.
 * k=60 is the standard constant that controls how much weight top ranks get.
 */
export function reciprocalRankFusion(
  vectorResults: Array<{ id: string; score: number; text: string; source: string; pipeline: string; chunk_type: string; chunk_index: number; context_prefix?: string }>,
  bm25Results: Array<{ id: string; rank: number; text: string; source: string; pipeline: string; chunk_type: string; chunk_index: number; context_prefix?: string }>,
  k: number = 60,
): HybridSearchResult[] {
  const scoreMap = new Map<string, {
    rrf: number; text: string; context_prefix: string; source: string;
    pipeline: string; chunk_type: string; chunk_index: number;
    vector_score?: number; bm25_rank?: number;
  }>();

  // Score vector results by their rank position
  vectorResults.forEach((r, rank) => {
    const existing = scoreMap.get(r.id);
    const rrfContribution = 1 / (k + rank + 1);
    if (existing) {
      existing.rrf += rrfContribution;
      existing.vector_score = r.score;
    } else {
      scoreMap.set(r.id, {
        rrf: rrfContribution,
        text: r.text,
        context_prefix: r.context_prefix || "",
        source: r.source,
        pipeline: r.pipeline,
        chunk_type: r.chunk_type,
        chunk_index: r.chunk_index,
        vector_score: r.score,
      });
    }
  });

  // Score BM25 results by their rank position
  bm25Results.forEach((r, rank) => {
    const existing = scoreMap.get(r.id);
    const rrfContribution = 1 / (k + rank + 1);
    if (existing) {
      existing.rrf += rrfContribution;
      existing.bm25_rank = rank + 1;
    } else {
      scoreMap.set(r.id, {
        rrf: rrfContribution,
        text: r.text,
        context_prefix: r.context_prefix || "",
        source: r.source,
        pipeline: r.pipeline,
        chunk_type: r.chunk_type,
        chunk_index: r.chunk_index,
        bm25_rank: rank + 1,
      });
    }
  });

  // Sort by RRF score descending
  return Array.from(scoreMap.entries())
    .map(([id, data]) => ({
      id,
      text: data.text,
      context_prefix: data.context_prefix,
      source: data.source,
      pipeline: data.pipeline,
      chunk_type: data.chunk_type,
      chunk_index: data.chunk_index,
      rrf_score: data.rrf,
      vector_score: data.vector_score,
      bm25_rank: data.bm25_rank,
    }))
    .sort((a, b) => b.rrf_score - a.rrf_score);
}

// ── Contextual Chunk Enrichment ───────────────────────────────────

/**
 * Generate a context prefix for a chunk using the MoE model.
 * Example output: "This chunk is from page 3 of a tax assessment report
 * for Majors Place, a 176-unit apartment complex in Greenville, TX."
 */
export async function generateContextPrefix(
  llmUrl: string,
  docSummary: string,
  chunkText: string,
  pageNum: number,
  authHeaders: Record<string, string> = {},
): Promise<string> {
  try {
    const resp = await fetch(`${llmUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify({
        messages: [{
          role: "user",
          content: `<document_summary>${docSummary}</document_summary>\n<chunk>${chunkText.slice(0, 500)}</chunk>\nWrite a short 1-2 sentence context that situates this chunk within the overall document. Include the document type, subject, and any key identifiers (names, numbers, dates). Start with "This chunk is from..." Do not think, just write the context directly.`,
        }],
        max_tokens: 100,
        temperature: 0,
        chat_template_kwargs: { enable_thinking: false },
      }),
    });
    if (!resp.ok) return "";
    const result = await resp.json() as any;
    const text = result?.choices?.[0]?.message?.content || "";
    return text.trim().slice(0, 300);
  } catch {
    return "";
  }
}

/**
 * Generate a document summary from the first ~1000 chars for contextual chunking.
 */
export async function generateDocSummary(
  llmUrl: string,
  fullText: string,
  fileName: string,
  authHeaders: Record<string, string> = {},
): Promise<string> {
  try {
    const resp = await fetch(`${llmUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify({
        messages: [{
          role: "user",
          content: `Summarize this document in 2-3 sentences. Include: document type, subject, key entities (names, addresses, amounts), and purpose. Do not think, just write the summary directly.\n\nFile: ${fileName}\n\n${fullText.slice(0, 2000)}`,
        }],
        max_tokens: 150,
        temperature: 0,
        chat_template_kwargs: { enable_thinking: false },
      }),
    });
    if (!resp.ok) return fileName;
    const result = await resp.json() as any;
    const text = result?.choices?.[0]?.message?.content || "";
    return (text || fileName).trim();
  } catch {
    return fileName;
  }
}

// ── Multi-Query Generation ────────────────────────────────────────

/**
 * Generate 3 query variants for better retrieval coverage.
 */
export async function generateMultiQuery(
  llmUrl: string,
  originalQuery: string,
  authHeaders: Record<string, string> = {},
): Promise<string[]> {
  const queries = [originalQuery];
  try {
    const resp = await fetch(`${llmUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify({
        messages: [{
          role: "user",
          content: `Generate 2 alternative phrasings of this search query. Return ONLY a JSON array of 2 strings, no explanation. Do not think.\n\nOriginal query: "${originalQuery}"`,
        }],
        max_tokens: 100,
        temperature: 0.3,
        chat_template_kwargs: { enable_thinking: false },
      }),
    });
    if (!resp.ok) return queries;
    const result = await resp.json() as any;
    const text = result?.choices?.[0]?.message?.content || "";
    const match = text.match(/\[.*\]/s);
    if (match) {
      const parsed = JSON.parse(match[0]) as string[];
      queries.push(...parsed.filter((q: any) => typeof q === "string" && q.trim()).slice(0, 2));
    }
  } catch { /* fall back to single query */ }
  return queries;
}
