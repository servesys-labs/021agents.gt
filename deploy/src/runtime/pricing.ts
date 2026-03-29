/**
 * Model pricing table — per 1M tokens in USD.
 * Used to calculate real LLM cost at runtime.
 * No rounding, no minimums — exact cost to $0.000001.
 */

const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  // ── Anthropic ──────────────────────────────────────────────────
  "anthropic/claude-opus-4-6":    { input: 15.00, output: 75.00 },
  "anthropic/claude-sonnet-4-6":  { input: 3.00,  output: 15.00 },
  "anthropic/claude-sonnet-4-5":  { input: 3.00,  output: 15.00 },
  "anthropic/claude-haiku-4-5":   { input: 0.80,  output: 4.00 },
  // ── OpenAI ─────────────────────────────────────────────────────
  "openai/gpt-5.4":              { input: 5.00,  output: 15.00 },
  "openai/gpt-5-mini":           { input: 0.30,  output: 1.25 },
  "openai/gpt-5-nano":           { input: 0.10,  output: 0.40 },
  "openai/o3":                   { input: 10.00, output: 40.00 },
  "openai/o3-mini":              { input: 1.10,  output: 4.40 },
  "openai/o4-mini":              { input: 1.10,  output: 4.40 },
  // ── Google Gemini 3.1 ──────────────────────────────────────────
  "google/gemini-3.1-pro":                    { input: 1.25, output: 10.00 },
  "google/gemini-3.1-flash":                  { input: 0.15, output: 0.60 },
  "google-ai-studio/gemini-3.1-pro":          { input: 1.25, output: 10.00 },
  "google-ai-studio/gemini-3.1-flash":        { input: 0.15, output: 0.60 },
  "google-ai-studio/gemini-3.1-flash-image":  { input: 0.15, output: 0.60 },
  // ── Google Gemini 2.5 (legacy) ─────────────────────────────────
  "google/gemini-2.5-pro":                    { input: 1.25, output: 10.00 },
  "google/gemini-2.5-flash":                  { input: 0.15, output: 0.60 },
  "google-ai-studio/gemini-2.5-flash":        { input: 0.15, output: 0.60 },
  "google-ai-studio/gemini-2.5-flash-image":  { input: 0.15, output: 0.60 },
  "google-ai-studio/gemini-2.5-pro":          { input: 1.25, output: 10.00 },
  // ── DeepSeek ───────────────────────────────────────────────────
  "deepseek/deepseek-chat-v3-0324": { input: 0.27, output: 1.10 },
  "deepseek/deepseek-chat":         { input: 0.27, output: 1.10 },
  "deepseek/deepseek-reasoner":     { input: 0.55, output: 2.19 },
  // ── Mistral ────────────────────────────────────────────────────
  "mistralai/mistral-large-latest": { input: 2.00, output: 6.00 },
  "mistralai/mistral-small-latest": { input: 0.20, output: 0.60 },
  // ── Workers AI (Cloudflare on-edge) ────────────────────────────
  "@cf/moonshotai/kimi-k2.5":                  { input: 0.10, output: 0.40 },
  "@cf/zai-org/glm-4.7-flash":                 { input: 0.05, output: 0.20 },
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast":  { input: 0.10, output: 0.20 },
  "@cf/mistral/mistral-7b-instruct-v0.2-lora": { input: 0.01, output: 0.03 },
};

const DEFAULT_PRICING = { input: 1.00, output: 3.00 };

/**
 * Estimate LLM token cost from model name and token counts.
 * Returns cost in USD with full precision.
 */
export function estimateTokenCost(model: string, inputTokens: number, outputTokens: number): number {
  let pricing = MODEL_PRICING[model];
  if (!pricing) {
    // Prefix match for versioned model names
    const key = Object.keys(MODEL_PRICING).find((k) => model.startsWith(k) || k.startsWith(model));
    pricing = key ? MODEL_PRICING[key] : DEFAULT_PRICING;
  }
  return (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output;
}
