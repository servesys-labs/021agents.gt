/**
 * Reranking provider — GPU box Jina Reranker (primary) + Workers AI BGE reranker (fallback).
 *
 * The reranker scores query-document pairs and reorders results by relevance.
 * Jina Reranker v3 is significantly better than BGE-reranker-base for long chunks
 * and multilingual content.
 */

export interface RerankResult {
  index: number;
  score: number;
}

/**
 * Rerank search results using the best available reranker.
 * Primary: GPU box reranker (Jina v3 via llama-server /v1/rerank)
 * Fallback: Workers AI BGE-reranker-base
 */
export async function rerank(
  query: string,
  documents: string[],
  env: { AI?: any; [key: string]: any },
): Promise<RerankResult[]> {
  if (documents.length === 0) return [];
  if (documents.length === 1) return [{ index: 0, score: 1.0 }];

  const rerankerUrl = ((env as any).RERANKER_URL || "").trim();
  const gpuKey = (env as any).GPU_SERVICE_KEY || (env as any).SERVICE_TOKEN || "";

  // Primary: GPU box reranker (Jina ColBERT v2 via /rerank)
  if (rerankerUrl) {
    try {
      const resp = await fetch(`${rerankerUrl}/rerank`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(gpuKey ? { Authorization: `Bearer ${gpuKey}` } : {}),
        },
        body: JSON.stringify({
          query,
          documents: documents.map(d => d.slice(0, 1000)), // Truncate for reranker context
          top_n: documents.length,
        }),
      });

      if (resp.ok) {
        const result = await resp.json() as any;
        const results = result?.results || result?.data || [];
        if (results.length > 0) {
          return results.map((r: any) => ({
            index: Number(r.index ?? 0),
            score: Number(r.relevance_score ?? r.score ?? 0),
          })).sort((a: RerankResult, b: RerankResult) => b.score - a.score);
        }
      }
    } catch {
      // GPU reranker unavailable — fall through
    }
  }

  // Fallback: Workers AI BGE-reranker-base
  if (env.AI) {
    try {
      const result = await env.AI.run(
        "@cf/baai/bge-reranker-base" as any,
        { query, texts: documents.map(d => d.slice(0, 512)) } as any,
      ) as any;

      let scores: RerankResult[] = [];
      if (Array.isArray(result?.data)) {
        scores = result.data.map((item: any) => ({
          index: Number(item.index ?? 0),
          score: Number(item.score ?? 0),
        }));
      } else if (Array.isArray(result)) {
        scores = result.map((d: any, i: number) => ({
          index: i,
          score: Number(d.score ?? d ?? 0),
        }));
      }
      return scores.sort((a, b) => b.score - a.score);
    } catch {
      // Both rerankers failed
    }
  }

  // Last resort: return original order with uniform scores
  return documents.map((_, i) => ({ index: i, score: 1 - i * 0.01 }));
}
