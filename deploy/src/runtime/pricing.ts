/**
 * Model pricing table — per 1M tokens in USD.
 * Source: OpenRouter API (https://openrouter.ai/api/v1/models) as of March 2026.
 * Used to calculate real LLM cost at runtime.
 * No rounding, no minimums — exact cost to $0.000001.
 */

const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  // ── OpenAI GPT-5.4 family ─────────────────────────────────────
  "openai/gpt-5.4-pro":    { input: 30.00, output: 180.00 },  // $0.00003/tok in, $0.00018/tok out
  "openai/gpt-5.4":        { input: 2.50,  output: 15.00 },   // $0.0000025/tok in, $0.000015/tok out
  "openai/gpt-5.4-mini":   { input: 0.75,  output: 4.50 },    // $0.00000075/tok in, $0.0000045/tok out
  "openai/gpt-5.4-nano":   { input: 0.20,  output: 1.25 },    // $0.0000002/tok in, $0.00000125/tok out

  // ── Anthropic Claude 4.6 ──────────────────────────────────────
  "anthropic/claude-opus-4.6":   { input: 5.00,  output: 25.00 },  // $0.000005/tok in, $0.000025/tok out
  "anthropic/claude-sonnet-4.6": { input: 3.00,  output: 15.00 },  // $0.000003/tok in, $0.000015/tok out

  // ── Google Gemini 3.1 ─────────────────────────────────────────
  "google/gemini-3.1-pro-preview":        { input: 2.00,  output: 12.00 },  // $0.000002/tok in, $0.000012/tok out
  "google/gemini-3.1-flash-lite-preview": { input: 0.25,  output: 1.50 },   // $0.00000025/tok in, $0.0000015/tok out
  "google/gemini-3-flash-preview":        { input: 0.50,  output: 3.00 },   // $0.0000005/tok in, $0.000003/tok out

  // ── DeepSeek ──────────────────────────────────────────────────
  "deepseek/deepseek-chat-v3-0324": { input: 0.27, output: 1.10 },
  "deepseek/deepseek-chat":         { input: 0.27, output: 1.10 },
  "deepseek/deepseek-reasoner":     { input: 0.55, output: 2.19 },

  // ── Mistral ───────────────────────────────────────────────────
  "mistralai/mistral-large-latest": { input: 2.00, output: 6.00 },
  "mistralai/mistral-small-latest": { input: 0.20, output: 0.60 },

  // ── Workers AI (Cloudflare on-edge) ───────────────────────────
  "@cf/moonshotai/kimi-k2.5":                  { input: 0.10, output: 0.40 },
  "@cf/zai-org/glm-4.7-flash":                 { input: 0.05, output: 0.20 },
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast":  { input: 0.10, output: 0.20 },
  "@cf/mistral/mistral-7b-instruct-v0.2-lora": { input: 0.01, output: 0.03 },
};

const DEFAULT_PRICING = { input: 1.00, output: 3.00 };

/**
 * Estimate token count from text when the API doesn't report usage.
 * More accurate than simple chars/4:
 * - Splits on whitespace + punctuation boundaries
 * - Code/JSON tokens tend to be shorter (more tokens per word)
 * - Adds 10% safety margin to avoid undercharging
 */
export function estimateTokensFromText(text: string): number {
  if (!text) return 0;
  // Count words (split on whitespace)
  const words = text.split(/\s+/).filter(Boolean).length;
  // Count code-like characters (braces, brackets, operators) — these often tokenize individually
  const codeChars = (text.match(/[{}[\]();:,<>=!&|+\-*/%]/g) || []).length;
  // CJK characters typically tokenize to ~1 token each
  const cjkChars = (text.match(/[\u3000-\u9fff\uac00-\ud7af]/g) || []).length;
  // Base: ~1.3 tokens per English word + code chars + CJK chars
  const estimate = Math.ceil(words * 1.3) + codeChars + cjkChars;
  // Add 10% safety margin to avoid undercharging
  return Math.ceil(estimate * 1.1);
}

/**
 * Estimate LLM token cost from model name and token counts.
 * Returns cost in USD with full precision.
 */
export function estimateTokenCost(model: string, inputTokens: number, outputTokens: number): number {
  let pricing = MODEL_PRICING[model];
  if (!pricing) {
    // Prefix match for versioned model names
    const key = Object.keys(MODEL_PRICING).find((k) => model.startsWith(k) || k.startsWith(model));
    pricing = key ? MODEL_PRICING[key] : undefined;
    if (!pricing) {
      // Unknown model — use default but log for operator awareness
      console.warn(`[pricing] Unknown model '${model}' — using default pricing ($${DEFAULT_PRICING.input}/$${DEFAULT_PRICING.output} per 1M tokens). Add to MODEL_PRICING to prevent over/undercharging.`);
      pricing = DEFAULT_PRICING;
    }
  }
  return (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output;
}
