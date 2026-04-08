/**
 * Model pricing + margin — per 1M tokens in USD.
 *
 * All LLM calls route through CF AI Gateway which reports actual cost.
 * When the gateway returns cost data, we use that (source of truth).
 * This table is ONLY the fallback when gateway doesn't report cost.
 *
 * REVENUE MODEL:
 *   Customer pays: actual_cost × MARGIN_MULTIPLIER
 *   Platform keeps: actual_cost × (MARGIN_MULTIPLIER - 1)
 *
 * Example at 1.4x margin:
 *   LLM cost = $0.001 → Customer pays $0.0014 → Platform earns $0.0004
 *   On $100K monthly LLM spend → $40K gross margin
 *
 * Source: OpenRouter API pricing as of March 2026.
 */

// ── Margin ──────────────────────────────────────────────────────
// Applied to ALL costs (LLM + tools). This is how OneShots makes money.
// 1.4x = 40% gross margin on compute costs.
export const MARGIN_MULTIPLIER = 1.4;

// ── Model pricing (fallback when AI Gateway doesn't report cost) ──
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  // ── OpenAI GPT-5.4 family ─────────────────────────────────────
  "openai/gpt-5.4-pro":    { input: 30.00, output: 180.00 },
  "openai/gpt-5.4":        { input: 2.50,  output: 15.00 },
  "openai/gpt-5.4-mini":   { input: 0.75,  output: 4.50 },
  "openai/gpt-5.4-nano":   { input: 0.20,  output: 1.25 },
  "openai/gpt-5.4-20260305": { input: 2.50,  output: 15.00 },

  // ── Anthropic Claude 4.6 ──────────────────────────────────────
  "anthropic/claude-opus-4.6":   { input: 5.00,  output: 25.00 },
  "anthropic/claude-sonnet-4.6": { input: 3.00,  output: 15.00 },
  "anthropic/claude-haiku-4.5":  { input: 0.80,  output: 4.00 },

  // ── Google Gemini 3.1 ─────────────────────────────────────────
  "google/gemini-3.1-pro-preview":        { input: 2.00,  output: 12.00 },
  "google/gemini-3.1-flash-lite-preview": { input: 0.25,  output: 1.50 },
  "google/gemini-3.1-flash-preview":      { input: 0.50,  output: 3.00 },
  "google/gemini-3-flash-preview":        { input: 0.50,  output: 3.00 },
  "google/gemini-3-pro-preview":          { input: 2.00,  output: 12.00 },
  "google/gemini-3.1-flash-lite-preview-20260303": { input: 0.25, output: 1.50 },

  // ── DeepSeek ──────────────────────────────────────────────────
  "deepseek/deepseek-chat-v3-0324": { input: 0.27, output: 1.10 },
  "deepseek/deepseek-chat":         { input: 0.27, output: 1.10 },
  "deepseek/deepseek-reasoner":     { input: 0.55, output: 2.19 },

  // ── Mistral ───────────────────────────────────────────────────
  "mistralai/mistral-large-latest": { input: 2.00, output: 6.00 },
  "mistralai/mistral-small-latest": { input: 0.20, output: 0.60 },

  // ── Meta Llama ────────────────────────────────────────────────
  "meta-llama/llama-4-maverick": { input: 0.20, output: 0.60 },
  "meta-llama/llama-4-scout":    { input: 0.15, output: 0.45 },

  // ── Workers AI (Cloudflare on-edge, near-zero cost) ───────────
  "@cf/google/gemma-4-26b-a4b-it":              { input: 0.00, output: 0.00 },   // Workers AI free tier
  "@cf/moonshotai/kimi-k2.5":                  { input: 0.10, output: 0.40 },
  "@cf/zai-org/glm-4.7-flash":                 { input: 0.05, output: 0.20 },
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast":  { input: 0.10, output: 0.20 },
  "@cf/mistral/mistral-7b-instruct-v0.2-lora": { input: 0.01, output: 0.03 },

  // ── Self-hosted GPU (priced to recoup hardware + electricity) ──
  // Dual RTX PRO 6000: ~$0.50/hr amortized. At 155 tok/s MoE = 558K tok/hr.
  // Priced 5-10x below OpenRouter equivalents, comparable to Workers AI.
  "gemma-4-31b":                               { input: 0.13, output: 0.40 },   // Dense: slower, premium
  "gemma-4-31B-it-Q8_0.gguf":                  { input: 0.13, output: 0.40 },
  "gemma-4-26b-moe":                           { input: 0.05, output: 0.15 },   // MoE: fast, default
  "gemma-4-26B-A4B-it-Q8_0.gguf":               { input: 0.05, output: 0.15 },
  "gemma-4-26B-A4B-it-Q4_K_M.gguf":             { input: 0.05, output: 0.15 },
  "search-gemma4":                               { input: 0.05, output: 0.15 },
};

// ── Voice / Audio Service Pricing ──────────────────────────────────
// Per-unit costs for STT, TTS, OCR, and other GPU services.
// These are added to tool costs in the billing pipeline.

export const VOICE_PRICING = {
  // STT: per second of audio processed
  "whisper-v3-turbo-gpu":  0.00004,   // $0.04 per 1000 seconds (~$2.40/hr) — Groq charges $0.03-0.06/hr
  "groq":                  0.00003,   // Groq API pricing
  "workers-ai-whisper":    0.00000,   // Workers AI free tier

  // TTS: per 1000 characters of text
  "kokoro":                0.005,     // $0.005/1K chars — ElevenLabs charges $0.30/1K chars
  "chatterbox":            0.008,     // $0.008/1K chars (voice cloning is heavier)
  "sesame-csm":            0.010,     // $0.010/1K chars (most compute-intensive)
  "workers-ai-deepgram":   0.000,     // Workers AI free tier

  // OCR: per page
  "glm-ocr":               0.002,     // $0.002/page — cloud OCR charges $0.01-0.05/page
  "gemma4-vision-ocr":     0.005,     // $0.005/page (31B Dense is slower)

  // Embedding: per 1K tokens
  "qwen3-embedding":       0.00002,   // $0.02/Mtok — OpenAI charges $0.02-0.13/Mtok

  // Reranking: per query (batch of documents)
  "colbert-rerank":        0.0001,    // $0.10/1K queries

  // Search: per query (includes Serper API + GPU synthesis)
  "web-search":            0.0005,    // $0.50/1K queries (Serper: $0.30 + GPU: $0.20)

  // PDF rendering: per page
  "pdf-render":            0.0005,    // $0.50/1K pages

  // Voice calls: per minute (Twilio SIP passthrough)
  "twilio-sip-inbound":   0.0085,    // Twilio's actual rate: $0.0085/min
  "twilio-sip-outbound":  0.014,     // Twilio outbound: ~$0.014/min
  "voice-gpu-compute":    0.005,     // GPU STT+TTS compute per call-minute
};

/**
 * Estimate token count from text when the API doesn't report usage.
 * More accurate than simple chars/4:
 * - Splits on whitespace + punctuation boundaries
 * - Code/JSON tokens tend to be shorter (more tokens per word)
 * - Adds 10% safety margin to avoid undercharging
 */
export function estimateTokensFromText(text: string): number {
  if (!text) return 0;
  const words = text.split(/\s+/).filter(Boolean).length;
  const codeChars = (text.match(/[{}[\]();:,<>=!&|+\-*/%]/g) || []).length;
  const cjkChars = (text.match(/[\u3000-\u9fff\uac00-\ud7af]/g) || []).length;
  const estimate = Math.ceil(words * 1.3) + codeChars + cjkChars;
  return Math.ceil(estimate * 1.1);
}

/**
 * Calculate the cost the customer pays for an LLM call.
 *
 * Priority:
 *   1. If AI Gateway returned actual cost (providerCost > 0), use that × margin
 *   2. Else estimate from token counts × model pricing × margin
 *
 * All costs include the platform margin (MARGIN_MULTIPLIER).
 */
export function calculateCustomerCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  providerCost: number = 0,
): number {
  // If gateway reported actual cost, apply margin and return
  if (providerCost > 0) {
    return providerCost * MARGIN_MULTIPLIER;
  }

  // Fallback: estimate from token counts
  return estimateTokenCost(model, inputTokens, outputTokens);
}

/**
 * Estimate LLM token cost from model name and token counts.
 * Returns cost in USD WITH margin applied.
 */
export function estimateTokenCost(model: string, inputTokens: number, outputTokens: number): number {
  let pricing = MODEL_PRICING[model];
  if (!pricing) {
    // Prefix match for versioned model names (e.g., "openai/gpt-5.4-20260305" → "openai/gpt-5.4")
    const key = Object.keys(MODEL_PRICING).find((k) => model.startsWith(k) || k.startsWith(model));
    if (key) pricing = MODEL_PRICING[key];
    if (!pricing) {
      // Workers AI and self-hosted models are free
      if (model.startsWith("@cf/") || model.startsWith("gemma-4")) {
        pricing = { input: 0.00, output: 0.00 };
      } else {
        console.warn(`[pricing] Unknown model '${model}' — charging penalty rate. Add to MODEL_PRICING.`);
        pricing = { input: 5.00, output: 15.00 };
      }
    }
  }
  const baseCost = (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output;
  return baseCost * MARGIN_MULTIPLIER;
}
