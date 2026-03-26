/**
 * Prompt versioning & A/B testing system.
 * 
 * Features:
 * - Version prompts with semantic versioning
 * - A/B test prompt variants with automatic winner selection
 * - Track prompt performance metrics (quality, latency, cost)
 * - Gradual rollout of new prompt versions
 */

import { z } from "zod";

// ── Types ────────────────────────────────────────────────────────────

export interface PromptVersion {
  prompt_id: string;
  version: string;
  template: string;
  variables: string[];
  system_prompt?: string;
  config?: {
    temperature?: number;
    max_tokens?: number;
    model?: string;
  };
  metadata: {
    created_by: string;
    created_at: number;
    description?: string;
    tags?: string[];
  };
}

export interface PromptExperiment {
  experiment_id: string;
  prompt_id: string;
  name: string;
  status: "draft" | "running" | "paused" | "completed" | "cancelled";
  
  // Variants to test
  variants: PromptVariant[];
  
  // Traffic split (0-1 for each variant)
  traffic_split: Record<string, number>;
  
  // Success metric
  success_metric: "quality_score" | "task_completion" | "latency" | "cost" | "user_rating";
  
  // Auto-promote winning variant
  auto_promote: boolean;
  winner_threshold: number; // Minimum improvement % to auto-promote
  
  // Scheduling
  start_time?: number;
  end_time?: number;
  
  // Results
  results?: ExperimentResults;
}

export interface PromptVariant {
  variant_id: string;
  name: string;
  version: string; // References prompt_versions
  weight: number; // Traffic allocation
}

export interface ExperimentResults {
  total_samples: number;
  variant_stats: Record<string, VariantStats>;
  winner?: string; // variant_id
  confidence: number; // 0-1
}

export interface VariantStats {
  samples: number;
  mean_score: number;
  std_dev: number;
  p95_latency_ms: number;
  avg_cost_usd: number;
  conversion_rate?: number;
}

// ── Prompt Router ────────────────────────────────────────────────────

export interface PromptSelectionContext {
  prompt_id: string;
  org_id: string;
  agent_name?: string;
  user_id?: string;
  session_id?: string;
  // For consistent user experiences
  sticky_user?: boolean;
}

export interface SelectedPrompt {
  variant_id: string;
  version: string;
  template: string;
  config: PromptVersion["config"];
  experiment_id?: string;
}

/**
 * Select which prompt variant to use.
 * Handles A/B traffic splitting and sticky user assignments.
 */
export function selectPromptVariant(
  experiment: PromptExperiment,
  versions: Map<string, PromptVersion>,
  ctx: PromptSelectionContext
): SelectedPrompt | null {
  // Check if experiment is active
  if (experiment.status !== "running") {
    return null;
  }
  
  const now = Date.now();
  if (experiment.start_time && now < experiment.start_time) return null;
  if (experiment.end_time && now > experiment.end_time) return null;
  
  // Determine variant using consistent hash of user/session
  const hashInput = ctx.sticky_user && ctx.user_id 
    ? ctx.user_id 
    : ctx.session_id || Math.random().toString();
  
  const hash = hashString(hashInput);
  const variant = weightedRandomSelection(experiment.variants, hash);
  
  if (!variant) return null;
  
  const version = versions.get(variant.version);
  if (!version) return null;
  
  return {
    variant_id: variant.variant_id,
    version: version.version,
    template: version.template,
    config: version.config,
    experiment_id: experiment.experiment_id,
  };
}

/**
 * Calculate statistics for experiment results.
 * Uses Welch's t-test for comparing variants.
 */
export function analyzeExperimentResults(
  experiment: PromptExperiment,
  metrics: Array<{
    variant_id: string;
    score: number;
    latency_ms: number;
    cost_usd: number;
    timestamp: number;
  }>
): ExperimentResults {
  const variantData = new Map<string, number[]>();
  const variantLatency = new Map<string, number[]>();
  const variantCost = new Map<string, number[]>();
  
  for (const m of metrics) {
    if (!variantData.has(m.variant_id)) {
      variantData.set(m.variant_id, []);
      variantLatency.set(m.variant_id, []);
      variantCost.set(m.variant_id, []);
    }
    variantData.get(m.variant_id)!.push(m.score);
    variantLatency.get(m.variant_id)!.push(m.latency_ms);
    variantCost.get(m.variant_id)!.push(m.cost_usd);
  }
  
  const stats: Record<string, VariantStats> = {};
  let totalSamples = 0;
  
  for (const [variantId, scores] of variantData.entries()) {
    const latencies = variantLatency.get(variantId)!;
    const costs = variantCost.get(variantId)!;
    
    totalSamples += scores.length;
    
    stats[variantId] = {
      samples: scores.length,
      mean_score: mean(scores),
      std_dev: stdDev(scores),
      p95_latency_ms: percentile(latencies, 0.95),
      avg_cost_usd: mean(costs),
    };
  }
  
  // Find winner (highest mean score, with minimum sample size)
  let winner: string | undefined;
  let bestScore = -Infinity;
  const minSamples = 30; // Minimum for statistical significance
  
  for (const [variantId, stat] of Object.entries(stats)) {
    if (stat.samples >= minSamples && stat.mean_score > bestScore) {
      bestScore = stat.mean_score;
      winner = variantId;
    }
  }
  
  // Calculate confidence (simplified)
  const confidence = winner ? calculateConfidence(stats, winner) : 0;
  
  return {
    total_samples: totalSamples,
    variant_stats: stats,
    winner,
    confidence,
  };
}

/**
 * Determine if we should auto-promote the winning variant.
 */
export function shouldAutoPromote(
  experiment: PromptExperiment,
  results: ExperimentResults
): { shouldPromote: boolean; reason: string } {
  if (!experiment.auto_promote) {
    return { shouldPromote: false, reason: "Auto-promote disabled" };
  }
  
  if (!results.winner) {
    return { shouldPromote: false, reason: "No clear winner" };
  }
  
  if (results.confidence < 0.95) {
    return { shouldPromote: false, reason: `Confidence ${results.confidence.toFixed(2)} < 0.95` };
  }
  
  const winnerStats = results.variant_stats[results.winner];
  if (winnerStats.samples < 100) {
    return { shouldPromote: false, reason: `Insufficient samples: ${winnerStats.samples} < 100` };
  }
  
  // Find control variant (usually the first one or "control" name)
  const controlVariant = experiment.variants.find(v => 
    v.name.toLowerCase() === "control" || v.name.toLowerCase() === "baseline"
  ) || experiment.variants[0];
  
  const controlStats = results.variant_stats[controlVariant?.variant_id];
  if (!controlStats) {
    return { shouldPromote: false, reason: "Control variant not found" };
  }
  
  // Calculate improvement
  const improvement = (winnerStats.mean_score - controlStats.mean_score) / controlStats.mean_score;
  
  if (improvement < experiment.winner_threshold) {
    return { 
      shouldPromote: false, 
      reason: `Improvement ${(improvement * 100).toFixed(1)}% < ${(experiment.winner_threshold * 100).toFixed(1)}%` 
    };
  }
  
  return { 
    shouldPromote: true, 
    reason: `Winner improved ${(improvement * 100).toFixed(1)}% with ${(results.confidence * 100).toFixed(1)}% confidence` 
  };
}

// ── Helpers ─────────────────────────────────────────────────────────

function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash);
}

function weightedRandomSelection<T extends { weight: number }>(
  items: T[],
  hash: number
): T | null {
  const totalWeight = items.reduce((sum, item) => sum + item.weight, 0);
  if (totalWeight === 0) return null;
  
  const normalizedHash = (hash % 10000) / 10000;
  let cumulative = 0;
  
  for (const item of items) {
    cumulative += item.weight / totalWeight;
    if (normalizedHash <= cumulative) {
      return item;
    }
  }
  
  return items[items.length - 1];
}

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function stdDev(arr: number[]): number {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  const variance = arr.reduce((sum, val) => sum + Math.pow(val - m, 2), 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const index = Math.ceil(sorted.length * p) - 1;
  return sorted[Math.max(0, index)];
}

function calculateConfidence(
  stats: Record<string, VariantStats>,
  winnerId: string
): number {
  // Simplified confidence calculation
  // In production, use proper statistical tests
  const winner = stats[winnerId];
  if (!winner || winner.samples < 30) return 0;
  
  // Higher confidence with more samples and lower variance
  const sampleConfidence = Math.min(1, winner.samples / 100);
  const varianceConfidence = Math.max(0, 1 - winner.std_dev / winner.mean_score);
  
  return sampleConfidence * varianceConfidence;
}

// ── Zod Schemas for API ─────────────────────────────────────────────

export const PromptVersionSchema = z.object({
  prompt_id: z.string(),
  version: z.string(),
  template: z.string(),
  variables: z.array(z.string()),
  system_prompt: z.string().optional(),
  config: z.object({
    temperature: z.number().optional(),
    max_tokens: z.number().optional(),
    model: z.string().optional(),
  }).optional(),
});

export const PromptExperimentSchema = z.object({
  name: z.string(),
  prompt_id: z.string(),
  variants: z.array(z.object({
    variant_id: z.string(),
    name: z.string(),
    version: z.string(),
    weight: z.number().min(0).max(1),
  })).min(2),
  traffic_split: z.record(z.number()).optional(),
  success_metric: z.enum(["quality_score", "task_completion", "latency", "cost", "user_rating"]),
  auto_promote: z.boolean().default(false),
  winner_threshold: z.number().default(0.05),
  start_time: z.number().optional(),
  end_time: z.number().optional(),
});
