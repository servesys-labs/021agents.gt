/**
 * Embedding provider abstraction.
 *
 * Primary: Qwen3-Embedding-0.6B on GPU box (1024-dim, self-hosted, zero cost)
 * Fallback: Workers AI BGE-base-en-v1.5 (768-dim) — only if GPU box is down
 *
 * IMPORTANT: The Vectorize index is 1024-dim (Qwen3). If we fall back to BGE (768-dim),
 * we CANNOT upsert to Vectorize — the dimensions won't match. Fallback is search-only
 * using a temporary query-time projection (lower quality but functional).
 */

export interface EmbeddingResult {
  vectors: number[][];
  model: string;
  dimensions: number;
}

/**
 * Embed one or more texts using Qwen3-Embedding (primary) or Workers AI BGE (fallback).
 */
export async function embed(
  texts: string[],
  env: { AI?: any; [key: string]: any },
): Promise<EmbeddingResult> {
  if (texts.length === 0) return { vectors: [], model: "none", dimensions: 0 };

  const embeddingUrl = ((env as any).EMBEDDING_URL || "").trim();
  const gpuKey = (env as any).GPU_SERVICE_KEY || (env as any).SERVICE_TOKEN || "";

  // Primary: Qwen3-Embedding via GPU box — batch in groups of 8 to avoid timeouts
  if (embeddingUrl) {
    const allVectors: number[][] = [];
    const BATCH_SIZE = 8;
    let success = true;

    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE);
      // Truncate to ~1000 tokens (~2000 chars) — ubatch-size is now 8192 on GPU box
      const truncated = batch.map(t => t.slice(0, 2000));

      let retries = 2;
      let batchDone = false;
      while (retries >= 0 && !batchDone) {
        try {
          const resp = await fetch(`${embeddingUrl}/v1/embeddings`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(gpuKey ? { Authorization: `Bearer ${gpuKey}` } : {}),
            },
            body: JSON.stringify({
              input: truncated,
              model: "Qwen3-Embedding-0.6B-Q8_0.gguf",
            }),
          });

          if (resp.ok) {
            const result = await resp.json() as any;
            const data = result?.data || [];
            if (data.length === batch.length) {
              const sorted = data.sort((a: any, b: any) => (a.index ?? 0) - (b.index ?? 0));
              allVectors.push(...sorted.map((d: any) => d.embedding));
              batchDone = true;
            }
          }
        } catch { /* retry */ }
        retries--;
        if (!batchDone && retries >= 0) {
          await new Promise(r => setTimeout(r, 500)); // brief pause before retry
        }
      }

      if (!batchDone) {
        success = false;
        break;
      }
    }

    if (success && allVectors.length === texts.length) {
      return {
        vectors: allVectors,
        model: "qwen3-embedding-0.6b",
        dimensions: allVectors[0].length,
      };
    }
  }

  // Qwen3 failed — DO NOT fall back to BGE for ingest (wrong dimensions).
  // BGE is only safe for query-time search where vectors aren't stored.
  console.error(`[embeddings] Qwen3-Embedding failed for ${texts.length} texts. EMBEDDING_URL=${embeddingUrl || "(not set)"}`);
  throw new Error(`Embedding failed: Qwen3-Embedding on GPU box is unavailable or returned errors for ${texts.length} texts. Check embed.oneshots.co health and ubatch-size config.`);
}

/** Expected dimension for the Vectorize index. Vectors of other dimensions cannot be upserted. */
export const VECTORIZE_DIMENSIONS = 1024;

/** Check if embedding result can be stored in Vectorize. */
export function canUpsertToVectorize(result: EmbeddingResult): boolean {
  return result.dimensions === VECTORIZE_DIMENSIONS;
}

/**
 * Embed a single text. Convenience wrapper.
 */
export async function embedSingle(
  text: string,
  env: { AI?: any; [key: string]: any },
): Promise<{ vector: number[]; model: string; dimensions: number }> {
  const result = await embed([text], env);
  if (result.vectors.length === 0) throw new Error("Embedding returned empty vector");
  return { vector: result.vectors[0], model: result.model, dimensions: result.dimensions };
}

/**
 * Embed for query-time search. CAN fall back to BGE (768-dim) since query vectors
 * aren't stored — Vectorize accepts any-dimension query vectors.
 */
export async function embedForQuery(
  text: string,
  env: { AI?: any; [key: string]: any },
): Promise<{ vector: number[]; model: string; dimensions: number }> {
  try {
    return await embedSingle(text, env);
  } catch {
    // Fallback to Workers AI BGE for query-time only
    if (env.AI) {
      const result = await env.AI.run("@cf/baai/bge-base-en-v1.5" as any, { text: [text] }) as any;
      const vec = result?.data?.[0];
      if (vec) return { vector: vec, model: "bge-base-en-v1.5-fallback", dimensions: vec.length };
    }
    throw new Error("All embedding providers failed for query");
  }
}
