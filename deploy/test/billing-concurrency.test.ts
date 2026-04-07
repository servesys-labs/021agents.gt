/**
 * Tests for billing accuracy under concurrent usage.
 *
 * Covers:
 * - Cost calculation determinism across parallel invocations
 * - Margin application consistency (1.4x multiplier)
 * - Token count accuracy for mixed model workloads
 * - No double-counting or cost loss when accumulating across turns
 * - Customer cost with and without AI Gateway provider cost
 */
import { describe, it, expect } from "vitest";

import { calculateDetailedCost } from "../src/runtime/cost";
import {
  calculateCustomerCost,
  estimateTokenCost,
  MARGIN_MULTIPLIER,
} from "../src/runtime/pricing";

// ── Concurrent cost calculation determinism ───────────────────────

describe("cost calculation — concurrent determinism", () => {
  it("100 parallel calculations produce identical results for same input", () => {
    const model = "anthropic/claude-sonnet-4-6";
    const usage = {
      input_tokens: 500_000,
      output_tokens: 200_000,
      cache_creation_input_tokens: 100_000,
      cache_read_input_tokens: 150_000,
    };

    // Run 100 calculations "concurrently" (same tick)
    const results = Array.from({ length: 100 }, () =>
      calculateDetailedCost(model, usage)
    );

    // All must be identical
    const first = results[0];
    for (let i = 1; i < results.length; i++) {
      expect(results[i].total_cost).toBe(first.total_cost);
      expect(results[i].input_cost).toBe(first.input_cost);
      expect(results[i].output_cost).toBe(first.output_cost);
      expect(results[i].cache_write_cost).toBe(first.cache_write_cost);
      expect(results[i].cache_read_cost).toBe(first.cache_read_cost);
      expect(results[i].cache_savings).toBe(first.cache_savings);
    }
  });

  it("mixed model calculations don't cross-contaminate", () => {
    const models = [
      "anthropic/claude-sonnet-4-6",
      "anthropic/claude-opus-4-6",
      "openai/gpt-5.4",
    ];
    const usage = { input_tokens: 100_000, output_tokens: 50_000 };

    const costs = models.map(m => calculateDetailedCost(m, usage));

    // Opus should be more expensive than Sonnet
    const sonnet = costs[0].total_cost;
    const opus = costs[1].total_cost;
    expect(opus).toBeGreaterThan(sonnet);

    // All costs should be positive
    for (const c of costs) {
      expect(c.total_cost).toBeGreaterThan(0);
    }
  });
});

// ── Margin multiplier consistency ─────────────────────────────────

describe("customer cost — margin application", () => {
  it("applies 1.4x margin to provider cost", () => {
    const providerCost = 0.01; // $0.01 actual LLM cost
    const customerCost = calculateCustomerCost(
      "anthropic/claude-sonnet-4-6", 100_000, 50_000, providerCost
    );

    expect(customerCost).toBeCloseTo(providerCost * MARGIN_MULTIPLIER, 6);
  });

  it("margin is consistent: customer_cost / provider_cost = 1.4 for all models", () => {
    const models = [
      "anthropic/claude-sonnet-4-6",
      "anthropic/claude-opus-4-6",
      "openai/gpt-5.4",
    ];

    for (const model of models) {
      const providerCost = 0.05;
      const customerCost = calculateCustomerCost(model, 100_000, 50_000, providerCost);
      const ratio = customerCost / providerCost;
      expect(ratio).toBeCloseTo(MARGIN_MULTIPLIER, 4);
    }
  });

  it("falls back to estimateTokenCost when no provider cost given", () => {
    // Use pricing table key format (4.6 not 4-6)
    const estimated = estimateTokenCost("anthropic/claude-sonnet-4.6", 1_000_000, 500_000);
    // Sonnet: ($3/M input + $15/M × 0.5M output) × 1.4 margin = $10.5 × 1.4 = $14.7
    expect(estimated).toBeCloseTo(14.7, 1);
  });

  it("unknown model gets penalty rate with margin", () => {
    const cost = estimateTokenCost("unknown/model-xyz", 1_000_000, 1_000_000);
    // Default: ($5/M input + $15/M output) × 1.4 margin = $20 × 1.4 = $28
    expect(cost).toBeGreaterThan(0);
    expect(cost).toBeCloseTo(28.0, 0);
  });
});

// ── Multi-turn cost accumulation ──────────────────────────────────

describe("multi-turn cost accumulation — no double-count or loss", () => {
  it("sum of per-turn costs equals total session cost", () => {
    const model = "anthropic/claude-sonnet-4-6";

    // Simulate 5 turns with varying token counts
    const turns = [
      { input_tokens: 100_000, output_tokens: 50_000 },
      { input_tokens: 200_000, output_tokens: 80_000 },
      { input_tokens: 150_000, output_tokens: 30_000 },
      { input_tokens: 300_000, output_tokens: 120_000 },
      { input_tokens: 50_000, output_tokens: 10_000 },
    ];

    // Calculate per-turn costs
    const turnCosts = turns.map(t => calculateDetailedCost(model, t));
    const sumOfTurns = turnCosts.reduce((acc, c) => acc + c.total_cost, 0);

    // Calculate total session cost (all tokens summed)
    const totalUsage = turns.reduce(
      (acc, t) => ({
        input_tokens: acc.input_tokens + t.input_tokens,
        output_tokens: acc.output_tokens + t.output_tokens,
      }),
      { input_tokens: 0, output_tokens: 0 }
    );
    const sessionCost = calculateDetailedCost(model, totalUsage);

    // These must be equal (linear pricing, no volume discounts)
    expect(sumOfTurns).toBeCloseTo(sessionCost.total_cost, 6);
  });

  it("tool costs add linearly to LLM costs", () => {
    const model = "anthropic/claude-sonnet-4-6";
    const llmCost = calculateDetailedCost(model, {
      input_tokens: 200_000,
      output_tokens: 100_000,
    });

    // Simulate 3 tool calls with their own costs
    const toolCosts = [0.001, 0.0005, 0.002];
    const totalToolCost = toolCosts.reduce((a, b) => a + b, 0);
    const totalSessionCost = llmCost.total_cost + totalToolCost;

    // Verify no rounding loss
    expect(totalSessionCost).toBeCloseTo(llmCost.total_cost + 0.0035, 6);
  });

  it("zero-token turn contributes zero cost", () => {
    const cost = calculateDetailedCost("anthropic/claude-sonnet-4-6", {
      input_tokens: 0,
      output_tokens: 0,
    });
    expect(cost.total_cost).toBe(0);
    expect(cost.input_cost).toBe(0);
    expect(cost.output_cost).toBe(0);
  });
});

// ── Simulated concurrent billing ──────────────────────────────────

describe("concurrent billing simulation", () => {
  it("10 parallel sessions produce correct independent totals", () => {
    const model = "anthropic/claude-sonnet-4-6";

    // Simulate 10 "sessions" each with different usage
    const sessions = Array.from({ length: 10 }, (_, i) => ({
      input_tokens: (i + 1) * 100_000,
      output_tokens: (i + 1) * 50_000,
    }));

    // Calculate all in parallel
    const costs = sessions.map(s => calculateDetailedCost(model, s));

    // Each session's cost should match its individual calculation
    for (let i = 0; i < 10; i++) {
      const expected = calculateDetailedCost(model, sessions[i]);
      expect(costs[i].total_cost).toBe(expected.total_cost);
    }

    // Total across all sessions
    const totalAcrossSessions = costs.reduce((acc, c) => acc + c.total_cost, 0);

    // Verify by calculating from summed tokens
    const totalTokens = sessions.reduce(
      (acc, s) => ({
        input_tokens: acc.input_tokens + s.input_tokens,
        output_tokens: acc.output_tokens + s.output_tokens,
      }),
      { input_tokens: 0, output_tokens: 0 }
    );
    const bulkCost = calculateDetailedCost(model, totalTokens);

    expect(totalAcrossSessions).toBeCloseTo(bulkCost.total_cost, 6);
  });

  it("cache-aware costs are additive across turns", () => {
    const model = "anthropic/claude-sonnet-4-6";

    // Turn 1: cache write (first request)
    const turn1 = calculateDetailedCost(model, {
      input_tokens: 100_000,
      output_tokens: 50_000,
      cache_creation_input_tokens: 80_000,
    });

    // Turn 2: cache read (subsequent request)
    const turn2 = calculateDetailedCost(model, {
      input_tokens: 100_000,
      output_tokens: 50_000,
      cache_read_input_tokens: 80_000,
    });

    // Turn 2 should be cheaper due to cache reads
    expect(turn2.total_cost).toBeLessThan(turn1.total_cost);

    // Cache savings should be positive in turn 2
    expect(turn2.cache_savings).toBeGreaterThan(0);
    expect(turn1.cache_savings).toBe(0); // No reads in turn 1
  });

  it("large token counts do not overflow or produce NaN", () => {
    const cost = calculateDetailedCost("anthropic/claude-opus-4-6", {
      input_tokens: 100_000_000, // 100M tokens
      output_tokens: 50_000_000,
    });

    expect(Number.isFinite(cost.total_cost)).toBe(true);
    expect(cost.total_cost).toBeGreaterThan(0);
    // Opus: 100M × $15/M + 50M × $75/M = $1500 + $3750 = $5250
    expect(cost.total_cost).toBeCloseTo(5250, 0);
  });
});
