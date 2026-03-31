/**
 * Tests for deploy/src/runtime/cost.ts
 * Phase 7.2: Per-model cost tracking with cache awareness
 */
import { describe, it, expect } from "vitest";
import { calculateDetailedCost } from "../src/runtime/cost";

describe("calculateDetailedCost", () => {
  it("calculates Sonnet pricing correctly", () => {
    const cost = calculateDetailedCost("anthropic/claude-sonnet-4-6", {
      input_tokens: 1_000_000,
      output_tokens: 500_000,
    });
    expect(cost.input_cost).toBeCloseTo(3.0, 2); // $3/M input
    expect(cost.output_cost).toBeCloseTo(7.5, 2); // $15/M output × 0.5M
    expect(cost.cache_write_cost).toBe(0);
    expect(cost.cache_read_cost).toBe(0);
    expect(cost.total_cost).toBeCloseTo(10.5, 2);
    expect(cost.cache_savings).toBe(0);
  });

  it("calculates cache write and read costs", () => {
    const cost = calculateDetailedCost("anthropic/claude-sonnet-4-6", {
      input_tokens: 500_000,
      output_tokens: 100_000,
      cache_creation_input_tokens: 200_000,
      cache_read_input_tokens: 300_000,
    });
    // Cache write: 200K × $3.75/M = $0.75
    expect(cost.cache_write_cost).toBeCloseTo(0.75, 2);
    // Cache read: 300K × $0.30/M = $0.09
    expect(cost.cache_read_cost).toBeCloseTo(0.09, 2);
    // Cache savings: 300K tokens saved at $3.0 - $0.30 = $2.70/M → $0.81
    expect(cost.cache_savings).toBeCloseTo(0.81, 2);
  });

  it("handles Opus pricing (5x Sonnet)", () => {
    const cost = calculateDetailedCost("anthropic/claude-opus-4-6", {
      input_tokens: 100_000,
      output_tokens: 50_000,
    });
    expect(cost.input_cost).toBeCloseTo(1.5, 2); // $15/M × 0.1M
    expect(cost.output_cost).toBeCloseTo(3.75, 2); // $75/M × 0.05M
  });

  it("handles GPT pricing", () => {
    const cost = calculateDetailedCost("openai/gpt-5.4", {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    });
    expect(cost.input_cost).toBeCloseTo(2.5, 2);
    expect(cost.output_cost).toBeCloseTo(10.0, 2);
  });

  it("falls back to Sonnet pricing for unknown models", () => {
    const cost = calculateDetailedCost("unknown/model-xyz", {
      input_tokens: 1_000_000,
      output_tokens: 0,
    });
    // Should use Sonnet fallback
    expect(cost.input_cost).toBeCloseTo(3.0, 2);
  });

  it("handles zero tokens", () => {
    const cost = calculateDetailedCost("anthropic/claude-sonnet-4-6", {
      input_tokens: 0,
      output_tokens: 0,
    });
    expect(cost.total_cost).toBe(0);
    expect(cost.cache_savings).toBe(0);
  });
});
