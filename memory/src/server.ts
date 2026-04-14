/**
 * AgentOS Memory Worker — Phase 1 (HTTP API stubs)
 *
 * Owns: RAG, embeddings, episodic memory, memory consolidation, knowledge search.
 *
 * The Agent Core calls this worker via service binding. Each endpoint accepts a
 * JSON body and returns JSON. Phase 1 returns { status: "not_implemented" } stubs
 * with TODO comments referencing the source modules to migrate from.
 *
 * Source modules (deploy/src/runtime/):
 *   - memory.ts         — working memory, episodic search, fact search/extraction, buildMemoryContext
 *   - embeddings.ts     — embed(), embedSingle(), embedForQuery() via Qwen3 / Workers AI fallback
 *   - rag-hybrid.ts     — BM25 + Vectorize hybrid search with RRF fusion
 *   - memory-consolidation.ts — dream consolidation (episode merge, procedure promotion, fact decay)
 */

export interface Env {
  VECTORIZE: VectorizeIndex;
  AI: Ai;
  HYPERDRIVE: Hyperdrive;
  STORAGE: R2Bucket;
}

// ── Helpers ──────────────────────────────────────────────────────

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function readBody<T = Record<string, unknown>>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    return {} as T;
  }
}

function notImplemented(source: string): Response {
  return json({ status: "not_implemented", source }, 501);
}

// ── Router ───────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // ── GET /health ──────────────────────────────────────────────
    if (method === "GET" && path === "/health") {
      return json({
        status: "ok",
        worker: "agentos-memory",
        bindings: {
          vectorize: !!env.VECTORIZE,
          ai: !!env.AI,
          hyperdrive: !!env.HYPERDRIVE,
          storage: !!env.STORAGE,
        },
      });
    }

    // All other routes require POST
    if (method !== "POST") {
      return json({ error: "Method not allowed" }, 405);
    }

    switch (path) {
      // ── POST /search/facts ───────────────────────────────────
      // Search semantic facts by query + org/agent scope.
      // Uses Vectorize embedding similarity with DB keyword fallback.
      //
      // Request body:
      //   { query: string, org_id?: string, agent_name?: string, limit?: number }
      //
      // TODO: Migrate from deploy/src/runtime/memory.ts — searchFacts()
      //       Also incorporate fetchCuratedSemanticFacts() and mergeMemoryFacts()
      //       for combined Vectorize + curated fact results.
      case "/search/facts": {
        const body = await readBody<{
          query: string;
          org_id?: string;
          agent_name?: string;
          limit?: number;
        }>(request);

        if (!body.query) {
          return json({ error: "query is required" }, 400);
        }

        return notImplemented("memory.ts#searchFacts + fetchCuratedSemanticFacts + mergeMemoryFacts");
      }

      // ── POST /search/episodes ────────────────────────────────
      // Search episodic memory (past interaction summaries) by keyword overlap.
      //
      // Request body:
      //   { query: string, org_id?: string, agent_name?: string, limit?: number }
      //
      // TODO: Migrate from deploy/src/runtime/memory.ts — searchEpisodes()
      //       Uses Postgres keyword/ILIKE search, scores by keyword overlap,
      //       deduplicates by session_id.
      case "/search/episodes": {
        const body = await readBody<{
          query: string;
          org_id?: string;
          agent_name?: string;
          limit?: number;
        }>(request);

        if (!body.query) {
          return json({ error: "query is required" }, 400);
        }

        return notImplemented("memory.ts#searchEpisodes");
      }

      // ── POST /context/build ──────────────────────────────────
      // Build the full memory context string for system prompt injection.
      // Combines working memory snapshot, semantic facts, episodic memory,
      // and procedural memory with token budgeting per section.
      //
      // Request body:
      //   {
      //     query: string,
      //     org_id?: string,
      //     agent_name?: string,
      //     maxChars?: number,
      //     working_memory?: Record<string, unknown>
      //   }
      //
      // TODO: Migrate from deploy/src/runtime/memory.ts — buildMemoryContext()
      //       Budget allocation: working 20%, facts 30%, episodes 30%, procedures 20%.
      //       Also uses effectiveConfidence() for time-decay ranking and
      //       memoryFreshnessNote() for staleness hints.
      //       Calls searchFacts, fetchCuratedSemanticFacts, searchEpisodes,
      //       findBestProcedures in parallel.
      case "/context/build": {
        const body = await readBody<{
          query: string;
          org_id?: string;
          agent_name?: string;
          maxChars?: number;
          working_memory?: Record<string, unknown>;
        }>(request);

        if (!body.query) {
          return json({ error: "query is required" }, 400);
        }

        return notImplemented("memory.ts#buildMemoryContext + effectiveConfidence + memoryFreshnessNote");
      }

      // ── POST /extract/facts ──────────────────────────────────
      // Queue fact extraction from user messages using pattern matching.
      // Extracted facts are stored in Vectorize + Postgres.
      //
      // Request body:
      //   {
      //     user_input: string,
      //     session_id: string,
      //     agent_name: string,
      //     org_id: string
      //   }
      //
      // TODO: Migrate from deploy/src/runtime/memory.ts — extractFacts() + queueFactExtraction()
      //       Pattern-based extraction (preferences, knowledge, goals, behavior).
      //       Each fact stored via storeFact() to both Vectorize and Postgres.
      case "/extract/facts": {
        const body = await readBody<{
          user_input: string;
          session_id: string;
          agent_name: string;
          org_id: string;
        }>(request);

        if (!body.user_input) {
          return json({ error: "user_input is required" }, 400);
        }

        return notImplemented("memory.ts#extractFacts + queueFactExtraction + storeFact");
      }

      // ── POST /extract/episode ────────────────────────────────
      // Queue a deterministic session episodic note after substantive runs.
      // Captures session summary, tools used, and outcome for future recall.
      //
      // Request body:
      //   {
      //     session_id: string,
      //     agent_name: string,
      //     org_id: string,
      //     user_input: string,
      //     assistant_output: string,
      //     tool_names: string[],
      //     turns_used: number,
      //     tool_call_count: number
      //   }
      //
      // TODO: Migrate from deploy/src/runtime/memory.ts — queueSessionEpisodicNote()
      //       Only stores if toolCallCount >= 3 or turnsUsed >= 3.
      //       Writes to episodes table in Postgres.
      case "/extract/episode": {
        const body = await readBody<{
          session_id: string;
          agent_name: string;
          org_id: string;
          user_input: string;
          assistant_output: string;
          tool_names: string[];
          turns_used: number;
          tool_call_count: number;
        }>(request);

        if (!body.session_id || !body.agent_name) {
          return json({ error: "session_id and agent_name are required" }, 400);
        }

        return notImplemented("memory.ts#queueSessionEpisodicNote");
      }

      // ── POST /consolidate ────────────────────────────────────
      // Trigger memory consolidation ("dream" pass) for an agent.
      // Three passes: episode merging, procedure promotion, fact decay.
      // Should be called during low-activity periods (autopilot idle, cron).
      //
      // Request body:
      //   { org_id: string, agent_name: string }
      //
      // TODO: Migrate from deploy/src/runtime/memory-consolidation.ts — consolidateMemory()
      //       Pass 1: Episode merging (>60% keyword overlap)
      //       Pass 2: Procedure promotion (same tool sequence 3+ times)
      //       Pass 3: Fact decay (reduce relevance of facts not accessed in 30 days)
      case "/consolidate": {
        const body = await readBody<{
          org_id: string;
          agent_name: string;
        }>(request);

        if (!body.org_id || !body.agent_name) {
          return json({ error: "org_id and agent_name are required" }, 400);
        }

        return notImplemented("memory-consolidation.ts#consolidateMemory");
      }

      // ── POST /embed ──────────────────────────────────────────
      // Generate embeddings for one or more text strings.
      // Primary: Qwen3-Embedding-0.6B (1024-dim, self-hosted GPU).
      // Fallback: Workers AI BGE-base-en-v1.5 (768-dim).
      //
      // Request body:
      //   { texts: string[] }
      //
      // Response:
      //   { vectors: number[][], model: string, dimensions: number }
      //
      // TODO: Migrate from deploy/src/runtime/embeddings.ts — embed()
      //       Batches in groups of 8, truncates to ~2000 chars.
      //       IMPORTANT: Vectorize index is 1024-dim (Qwen3). BGE fallback is
      //       768-dim and search-only (cannot upsert to Vectorize).
      case "/embed": {
        const body = await readBody<{
          texts: string[];
        }>(request);

        if (!body.texts || !Array.isArray(body.texts) || body.texts.length === 0) {
          return json({ error: "texts array is required and must be non-empty" }, 400);
        }

        return notImplemented("embeddings.ts#embed");
      }

      // ── POST /rag/search ─────────────────────────────────────
      // Hybrid RAG search combining BM25 (Postgres FTS) + dense vectors (Vectorize)
      // with Reciprocal Rank Fusion (RRF) for result merging.
      //
      // Request body:
      //   {
      //     query: string,
      //     org_id?: string,
      //     agent_name?: string,
      //     source?: string,
      //     pipeline?: string,
      //     limit?: number
      //   }
      //
      // Response:
      //   { results: HybridSearchResult[] }
      //   where HybridSearchResult = { id, text, context_prefix, source, pipeline,
      //     chunk_type, chunk_index, rrf_score, vector_score?, bm25_rank? }
      //
      // TODO: Migrate from deploy/src/runtime/rag-hybrid.ts
      //       - bm25Search(): Postgres full-text search via tsvector/plainto_tsquery
      //       - Vectorize dense vector query (needs embeddings.ts#embedForQuery)
      //       - reciprocalRankFusion(): RRF merge with k=60
      //       - storeChunksForBM25() also lives here for ingestion
      case "/rag/search": {
        const body = await readBody<{
          query: string;
          org_id?: string;
          agent_name?: string;
          source?: string;
          pipeline?: string;
          limit?: number;
        }>(request);

        if (!body.query) {
          return json({ error: "query is required" }, 400);
        }

        return notImplemented("rag-hybrid.ts#bm25Search + vectorSearch + reciprocalRankFusion");
      }

      default:
        return json({ error: "Not found", path }, 404);
    }
  },
} satisfies ExportedHandler<Env>;
