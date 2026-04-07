/**
 * RAG Evaluation (RAGAS-inspired metrics).
 *
 * Scores retrieval quality on 4 dimensions:
 * 1. Context Precision — are the retrieved chunks relevant to the query?
 * 2. Context Recall — do the chunks contain the information needed to answer?
 * 3. Faithfulness — does the generated answer stick to the retrieved context?
 * 4. Answer Relevancy — does the answer actually address the query?
 *
 * Uses the self-hosted MoE as LLM-as-judge (zero cost, fast).
 */

export interface RAGEvalInput {
  query: string;
  answer: string;
  contexts: string[];  // Retrieved chunks
  ground_truth?: string;  // Optional reference answer
}

export interface RAGEvalResult {
  context_precision: number;  // 0-1: are retrieved chunks relevant?
  context_recall: number;     // 0-1: do chunks cover the needed info?
  faithfulness: number;       // 0-1: does answer stick to context?
  answer_relevancy: number;   // 0-1: does answer address the query?
  overall: number;            // Weighted average
  details: {
    relevant_chunks: number;
    total_chunks: number;
    claims_supported: number;
    total_claims: number;
  };
}

/**
 * Evaluate a RAG response using LLM-as-judge.
 */
export async function evaluateRAG(
  input: RAGEvalInput,
  llmUrl: string,
  authHeaders: Record<string, string> = {},
): Promise<RAGEvalResult> {
  const contextText = input.contexts.map((c, i) => `[Chunk ${i + 1}]: ${c.slice(0, 500)}`).join("\n\n");

  // Run all 4 evaluations in parallel
  const [precision, recall, faithfulness, relevancy] = await Promise.all([
    scoreContextPrecision(input.query, input.contexts, llmUrl, authHeaders),
    scoreContextRecall(input.query, input.answer, input.contexts, input.ground_truth, llmUrl, authHeaders),
    scoreFaithfulness(input.answer, input.contexts, llmUrl, authHeaders),
    scoreAnswerRelevancy(input.query, input.answer, llmUrl, authHeaders),
  ]);

  const overall = 0.25 * precision.score + 0.25 * recall.score + 0.3 * faithfulness.score + 0.2 * relevancy.score;

  return {
    context_precision: precision.score,
    context_recall: recall.score,
    faithfulness: faithfulness.score,
    answer_relevancy: relevancy.score,
    overall,
    details: {
      relevant_chunks: precision.relevant,
      total_chunks: input.contexts.length,
      claims_supported: faithfulness.supported,
      total_claims: faithfulness.total,
    },
  };
}

async function llmJudge(
  prompt: string,
  llmUrl: string,
  authHeaders: Record<string, string>,
): Promise<string> {
  try {
    const resp = await fetch(`${llmUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify({
        messages: [{ role: "user", content: prompt }],
        max_tokens: 200,
        temperature: 0,
        chat_template_kwargs: { enable_thinking: false },
      }),
    });
    if (!resp.ok) return "";
    const result = await resp.json() as any;
    return result?.choices?.[0]?.message?.content || "";
  } catch {
    return "";
  }
}

/**
 * Context Precision: For each chunk, is it relevant to the query?
 */
async function scoreContextPrecision(
  query: string,
  contexts: string[],
  llmUrl: string,
  authHeaders: Record<string, string>,
): Promise<{ score: number; relevant: number }> {
  if (contexts.length === 0) return { score: 0, relevant: 0 };

  const chunks = contexts.map((c, i) => `[${i + 1}] ${c.slice(0, 300)}`).join("\n");
  const resp = await llmJudge(
    `Query: "${query}"\n\nRetrieved chunks:\n${chunks}\n\nFor each chunk, respond with ONLY a JSON array of 1 (relevant) or 0 (not relevant). Example: [1, 0, 1]\nNo explanation.`,
    llmUrl, authHeaders,
  );

  try {
    const match = resp.match(/\[[\d,\s]+\]/);
    if (match) {
      const scores = JSON.parse(match[0]) as number[];
      const relevant = scores.filter(s => s === 1).length;
      return { score: relevant / contexts.length, relevant };
    }
  } catch { /* parse failed */ }
  return { score: 0.5, relevant: Math.floor(contexts.length / 2) };
}

/**
 * Context Recall: Do the chunks contain information needed to answer?
 */
async function scoreContextRecall(
  query: string,
  answer: string,
  contexts: string[],
  groundTruth: string | undefined,
  llmUrl: string,
  authHeaders: Record<string, string>,
): Promise<{ score: number }> {
  const reference = groundTruth || answer;
  const contextText = contexts.map(c => c.slice(0, 300)).join("\n---\n");

  const resp = await llmJudge(
    `Reference answer: "${reference.slice(0, 500)}"\n\nRetrieved context:\n${contextText}\n\nRate from 0.0 to 1.0: how much of the reference answer is supported by the retrieved context? Respond with ONLY a number like 0.8. No explanation.`,
    llmUrl, authHeaders,
  );

  const num = parseFloat(resp.trim());
  return { score: isNaN(num) ? 0.5 : Math.max(0, Math.min(1, num)) };
}

/**
 * Faithfulness: Does the answer only contain claims supported by the context?
 */
async function scoreFaithfulness(
  answer: string,
  contexts: string[],
  llmUrl: string,
  authHeaders: Record<string, string>,
): Promise<{ score: number; supported: number; total: number }> {
  const contextText = contexts.map(c => c.slice(0, 300)).join("\n---\n");

  const resp = await llmJudge(
    `Answer: "${answer.slice(0, 500)}"\n\nContext:\n${contextText}\n\nHow many factual claims in the answer are supported by the context? Respond with ONLY JSON: {"supported": N, "total": M}. No explanation.`,
    llmUrl, authHeaders,
  );

  try {
    const match = resp.match(/\{[^}]+\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      const supported = Number(parsed.supported || 0);
      const total = Number(parsed.total || 1);
      return { score: total > 0 ? supported / total : 0, supported, total };
    }
  } catch { /* parse failed */ }
  return { score: 0.5, supported: 0, total: 0 };
}

/**
 * Answer Relevancy: Does the answer address the query?
 */
async function scoreAnswerRelevancy(
  query: string,
  answer: string,
  llmUrl: string,
  authHeaders: Record<string, string>,
): Promise<{ score: number }> {
  const resp = await llmJudge(
    `Query: "${query}"\nAnswer: "${answer.slice(0, 500)}"\n\nRate from 0.0 to 1.0: how well does the answer address the query? 1.0 = perfectly answers the question, 0.0 = completely irrelevant. Respond with ONLY a number like 0.8. No explanation.`,
    llmUrl, authHeaders,
  );

  const num = parseFloat(resp.trim());
  return { score: isNaN(num) ? 0.5 : Math.max(0, Math.min(1, num)) };
}
