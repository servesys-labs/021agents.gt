/**
 * Phase 7.2: Per-Model Cost Tracking with Cache Awareness
 *
 * NOTE: Wire into workflow.ts telemetry by replacing calculateCustomerCost()
 * calls with calculateDetailedCost() to capture cache_savings. Requires
 * extracting cache_creation_input_tokens from Anthropic response headers.
 *
 * Tracks 6 token categories per model: input, output, cache write (1.25x),
 * cache read (0.1x), thinking, web search. Makes prompt cache ROI measurable.
 *
 * Inspired by Claude Code's multi-tier cost tracking with ModelCosts interface.
 */

// ── Per-Model Pricing (USD per million tokens) ──────────────────────

interface ModelPricing {
  input_per_mtok: number;
  output_per_mtok: number;
  cache_write_per_mtok: number;   // Typically 1.25x input
  cache_read_per_mtok: number;    // Typically 0.1x input
}

const MODEL_COSTS: Record<string, ModelPricing> = {
  // Anthropic
  "anthropic/claude-sonnet-4-6":    { input_per_mtok: 3.0,  output_per_mtok: 15.0,  cache_write_per_mtok: 3.75,  cache_read_per_mtok: 0.30 },
  "anthropic/claude-opus-4-6":      { input_per_mtok: 15.0, output_per_mtok: 75.0,  cache_write_per_mtok: 18.75, cache_read_per_mtok: 1.50 },
  "anthropic/claude-haiku-4-5":     { input_per_mtok: 0.80, output_per_mtok: 4.0,   cache_write_per_mtok: 1.00,  cache_read_per_mtok: 0.08 },

  // OpenAI
  "openai/gpt-5.4":                { input_per_mtok: 2.50, output_per_mtok: 10.0,  cache_write_per_mtok: 2.50,  cache_read_per_mtok: 1.25 },
  "openai/gpt-5.4-mini":           { input_per_mtok: 0.15, output_per_mtok: 0.60,  cache_write_per_mtok: 0.15,  cache_read_per_mtok: 0.075 },

  // DeepSeek
  "deepseek/deepseek-v3.2":        { input_per_mtok: 0.27, output_per_mtok: 1.10,  cache_write_per_mtok: 0.27,  cache_read_per_mtok: 0.07 },

  // Google
  "google-ai-studio/gemini-3.1-pro": { input_per_mtok: 1.25, output_per_mtok: 5.0, cache_write_per_mtok: 1.25, cache_read_per_mtok: 0.32 },
};

// ── Detailed Cost Calculation ───────────────────────────────────────

export interface DetailedCost {
  input_cost: number;
  output_cost: number;
  cache_write_cost: number;
  cache_read_cost: number;
  total_cost: number;
  cache_savings: number;      // What you saved vs no-cache
}

export interface DetailedUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/**
 * Calculate detailed cost breakdown with cache awareness.
 */
export function calculateDetailedCost(model: string, usage: DetailedUsage): DetailedCost {
  const pricing = MODEL_COSTS[model];
  if (!pricing) {
    // Fallback: estimate at Sonnet pricing
    const fallback = MODEL_COSTS["anthropic/claude-sonnet-4-6"];
    return calculateDetailedCost("anthropic/claude-sonnet-4-6", usage);
  }

  const inputCost = (usage.input_tokens / 1_000_000) * pricing.input_per_mtok;
  const outputCost = (usage.output_tokens / 1_000_000) * pricing.output_per_mtok;
  const cacheWriteCost = ((usage.cache_creation_input_tokens || 0) / 1_000_000) * pricing.cache_write_per_mtok;
  const cacheReadCost = ((usage.cache_read_input_tokens || 0) / 1_000_000) * pricing.cache_read_per_mtok;

  // Cache savings = what those tokens would have cost at full input price
  const cacheReadTokens = usage.cache_read_input_tokens || 0;
  const cacheSavings = (cacheReadTokens / 1_000_000) * (pricing.input_per_mtok - pricing.cache_read_per_mtok);

  return {
    input_cost: inputCost,
    output_cost: outputCost,
    cache_write_cost: cacheWriteCost,
    cache_read_cost: cacheReadCost,
    total_cost: inputCost + outputCost + cacheWriteCost + cacheReadCost,
    cache_savings: cacheSavings,
  };
}
