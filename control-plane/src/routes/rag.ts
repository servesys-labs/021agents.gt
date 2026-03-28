/**
 * RAG router — document ingestion via R2, chunking, vectorize embedding.
 * Ported from agentos/api/routers/rag.py
 */
import { createRoute, z } from "@hono/zod-openapi";
import { createOpenAPIRouter } from "../lib/openapi";
import { ErrorSchema, errorResponses } from "../schemas/openapi";
import { requireScope } from "../middleware/auth";

export const ragRoutes = createOpenAPIRouter();

/**
 * Simple text chunker — splits by paragraphs then by size.
 */
function chunkText(text: string, chunkSize: number): string[] {
  const chunks: string[] = [];
  const paragraphs = text.split(/\n\n+/);
  let current = "";
  for (const para of paragraphs) {
    if (current.length + para.length + 2 > chunkSize && current.length > 0) {
      chunks.push(current.trim());
      current = "";
    }
    if (para.length > chunkSize) {
      // Split long paragraphs
      if (current) { chunks.push(current.trim()); current = ""; }
      for (let i = 0; i < para.length; i += chunkSize) {
        chunks.push(para.slice(i, i + chunkSize).trim());
      }
    } else {
      current += (current ? "\n\n" : "") + para;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.filter(Boolean);
}

// ── POST /:agent_name/ingest — ingest documents ──────────────────────

const ingestRoute = createRoute({
  method: "post",
  path: "/{agent_name}/ingest",
  tags: ["RAG"],
  summary: "Ingest documents for RAG (multipart/form-data)",
  middleware: [requireScope("rag:write")],
  request: {
    params: z.object({ agent_name: z.string() }),
  },
  responses: {
    200: {
      description: "Ingestion result",
      content: {
        "application/json": {
          schema: z.object({
            documents: z.number(),
            chunks: z.number(),
            sources: z.array(z.string()),
          }),
        },
      },
    },
    ...errorResponses(400),
  },
});
ragRoutes.openapi(ingestRoute, async (c): Promise<any> => {
  const { agent_name: agentName } = c.req.valid("param");
  const user = c.get("user");
  const formData = await c.req.formData();
  const chunkSize = Number(formData.get("chunk_size")) || 512;

  const documents: string[] = [];
  const metadatas: { source: string; filename: string; agent: string }[] = [];

  for (const [, value] of formData.entries()) {
    if (typeof value === "string") continue;
    const content = await (value as any).text();
    if (!content.trim()) continue;
    const fileName = (value as any).name || "unknown";
    documents.push(content);
    metadatas.push({ source: fileName, filename: fileName, agent: agentName });
  }

  if (documents.length === 0) {
    return c.json({ error: "No valid documents to ingest" }, 400);
  }

  // Store documents in R2
  let totalChunks = 0;
  const allChunks: { text: string; metadata: any }[] = [];

  for (let i = 0; i < documents.length; i++) {
    const chunks = chunkText(documents[i], chunkSize);
    totalChunks += chunks.length;
    for (const chunk of chunks) {
      allChunks.push({ text: chunk, metadata: metadatas[i] });
    }

    // Store raw document in R2
    const key = `rag/${agentName}/documents/${metadatas[i].filename}`;
    await c.env.STORAGE.put(key, documents[i], {
      httpMetadata: { contentType: "text/plain" },
    });
  }

  // Store index metadata in R2
  const indexData = {
    agent: agentName,
    chunk_size: chunkSize,
    documents: documents.map((d, i) => ({ length: d.length, metadata: metadatas[i] })),
    total_chunks: totalChunks,
    source_files: metadatas.map((m) => m.source),
    updated_at: Date.now() / 1000,
  };
  await c.env.STORAGE.put(`rag/${agentName}/index.json`, JSON.stringify(indexData, null, 2), {
    httpMetadata: { contentType: "application/json" },
  });

  // Vectorize embeddings if available
  try {
    const vectors = [];
    for (let i = 0; i < allChunks.length; i++) {
      vectors.push({
        id: `${agentName}-chunk-${i}-${Date.now()}`,
        values: [], // Will be filled by AI embedding
        metadata: {
          text: allChunks[i].text.slice(0, 1000),
          source: allChunks[i].metadata.source,
          agent: agentName,
        },
      });
    }

    // Use AI binding for embeddings
    const texts = allChunks.map((ch) => ch.text);
    const embeddingResult = await c.env.AI.run("@cf/baai/bge-base-en-v1.5", {
      text: texts.slice(0, 100), // Limit batch size
    }) as any;

    if (embeddingResult?.data) {
      const embeddedVectors = (embeddingResult.data as number[][]).map((embedding: number[], idx: number) => ({
        id: `${agentName}-${Date.now()}-${idx}`,
        values: embedding,
        metadata: {
          text: allChunks[idx]?.text.slice(0, 500) || "",
          source: allChunks[idx]?.metadata.source || "",
          agent: agentName,
        },
      }));

      if (embeddedVectors.length > 0) {
        await c.env.VECTORIZE.upsert(embeddedVectors);
      }
    }
  } catch {
    // Vectorize is best-effort
  }

  return c.json({
    documents: documents.length,
    chunks: totalChunks,
    sources: metadatas.map((m) => m.filename),
  });
});

// ── GET /:agent_name/status — RAG index status ──────────────────────

const statusRoute = createRoute({
  method: "get",
  path: "/{agent_name}/status",
  tags: ["RAG"],
  summary: "Get RAG index status for an agent",
  middleware: [requireScope("rag:read")],
  request: {
    params: z.object({ agent_name: z.string() }),
  },
  responses: {
    200: {
      description: "RAG status",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
  },
});
ragRoutes.openapi(statusRoute, async (c): Promise<any> => {
  const { agent_name: agentName } = c.req.valid("param");
  const indexObj = await c.env.STORAGE.get(`rag/${agentName}/index.json`);
  if (!indexObj) {
    return c.json({ indexed: false, documents: 0, chunks: 0 });
  }

  try {
    const data = await indexObj.json() as any;
    return c.json({
      indexed: true,
      agent: data.agent || "",
      documents: (data.documents || []).length,
      chunks: data.total_chunks || 0,
      chunk_size: data.chunk_size || 512,
      sources: data.source_files || [],
    });
  } catch {
    return c.json({ indexed: false, documents: 0, chunks: 0 });
  }
});

// ── GET /:agent_name/documents — list indexed documents ─────────────

const listDocumentsRoute = createRoute({
  method: "get",
  path: "/{agent_name}/documents",
  tags: ["RAG"],
  summary: "List indexed documents for an agent",
  middleware: [requireScope("rag:read")],
  request: {
    params: z.object({ agent_name: z.string() }),
  },
  responses: {
    200: {
      description: "Document list",
      content: { "application/json": { schema: z.object({ documents: z.array(z.record(z.unknown())) }) } },
    },
  },
});
ragRoutes.openapi(listDocumentsRoute, async (c): Promise<any> => {
  const { agent_name: agentName } = c.req.valid("param");
  const indexObj = await c.env.STORAGE.get(`rag/${agentName}/index.json`);
  if (!indexObj) return c.json({ documents: [] });

  try {
    const data = await indexObj.json() as any;
    return c.json({ documents: data.documents || [] });
  } catch {
    return c.json({ documents: [] });
  }
});
