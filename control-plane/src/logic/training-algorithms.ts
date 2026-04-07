/**
 * Training algorithms — pluggable optimization backends.
 *
 * Each algorithm receives the current state (resources, eval results, rewards)
 * and produces updated resources (e.g., improved system prompts).
 *
 * Inspired by Agent Lightning's Algorithm interface, adapted for CF Workers.
 */
// ── Types ──────────────────────────────────────────────────────────────

export interface TrainingJob {
  job_id: string;
  org_id: string;
  agent_name: string;
  algorithm: string;
  config: Record<string, unknown>;
  current_iteration: number;
  max_iterations: number;
  best_score: number | null;
  best_iteration: number | null;
}

export interface TrainingResource {
  resource_id: string;
  resource_type: string;
  resource_key: string;
  version: number;
  content_text: string | null;
  content: Record<string, unknown> | null;
  is_active: boolean;
  eval_score: number | null;
}

export interface EvalIterationResult {
  eval_run_id: number | null;
  pass_rate: number | null;
  avg_score: number | null;
  avg_latency_ms: number | null;
  total_cost_usd: number | null;
}

export interface IterationHistory {
  iteration_number: number;
  reward_score: number | null;
  pass_rate: number | null;
  resource_version: number | null;
  algorithm_output: Record<string, unknown>;
}

export interface OptimizationContext {
  job: TrainingJob;
  currentIteration: number;
  currentResources: TrainingResource[];
  evalResults: EvalIterationResult;
  rewardScore: number;
  history: IterationHistory[];
}

export interface ResourceUpdate {
  resourceType: string;
  resourceKey: string;
  contentText?: string;
  contentJson?: Record<string, unknown>;
  source: string;
}

export interface OptimizationResult {
  updatedResources: ResourceUpdate[];
  metadata: Record<string, unknown>;
}

// ── Algorithm interface ────────────────────────────────────────────────

export interface TrainingAlgorithm {
  readonly name: string;
  optimize(context: OptimizationContext): Promise<OptimizationResult>;
  /**
   * Determine whether training should continue.
   * NOTE: `context.history` may not include the current iteration's results —
   * it reflects completed iterations at the time the loop queries the algorithm.
   */
  shouldContinue(context: OptimizationContext): boolean;
}

// ── Baseline algorithm ─────────────────────────────────────────────────

/**
 * Baseline: keep the current resources if they score well, otherwise
 * apply small random perturbations (temperature/model swap) to explore.
 * Primarily a reference implementation for testing the training loop.
 */
export class BaselineAlgorithm implements TrainingAlgorithm {
  readonly name = "baseline";

  private perturbations: string[];

  constructor(config: Record<string, unknown> = {}) {
    this.perturbations = (config.perturbations as string[]) ?? [
      "Be more concise in your responses.",
      "Think step by step before answering.",
      "Always cite specific evidence for your claims.",
      "Ask clarifying questions when the user's intent is ambiguous.",
      "Provide structured output with clear headers and bullet points.",
    ];
  }

  async optimize(ctx: OptimizationContext): Promise<OptimizationResult> {
    const promptResource = ctx.currentResources.find(
      (r) => r.resource_type === "system_prompt" && r.resource_key === "main",
    );

    if (!promptResource?.content_text) {
      return { updatedResources: [], metadata: { skipped: true, reason: "no system_prompt resource" } };
    }

    // Pick a perturbation based on iteration number.
    // Strip any previous "Additional instruction:" suffix so the prompt
    // doesn't grow unboundedly across iterations.
    const perturbation = this.perturbations[ctx.currentIteration % this.perturbations.length];
    const marker = "\n\nAdditional instruction:";
    const markerIdx = promptResource.content_text.indexOf(marker);
    const basePrompt = markerIdx !== -1
      ? promptResource.content_text.slice(0, markerIdx)
      : promptResource.content_text;
    const newPrompt = `${basePrompt}\n\nAdditional instruction: ${perturbation}`;

    return {
      updatedResources: [{
        resourceType: "system_prompt",
        resourceKey: "main",
        contentText: newPrompt,
        source: "baseline",
      }],
      metadata: {
        perturbation,
        original_length: promptResource.content_text.length,
        new_length: newPrompt.length,
      },
    };
  }

  shouldContinue(ctx: OptimizationContext): boolean {
    return ctx.currentIteration < ctx.job.max_iterations;
  }
}

// ── APO algorithm ──────────────────────────────────────────────────────

/**
 * Automatic Prompt Optimization (APO): uses an LLM to analyze eval failures,
 * generate a "gradient" (critique), and apply it to rewrite the prompt.
 *
 * Beam search: maintains top-K candidates, branches each into B variants,
 * evaluates all, keeps top-K for next round.
 *
 * Adapted from Yang et al. "Large Language Models as Optimizers" (2023)
 * and Agent Lightning's APO implementation.
 */
export class APOAlgorithm implements TrainingAlgorithm {
  readonly name = "apo";

  private gradientModel: string;
  private editModel: string;
  private beamWidth: number;
  private branchFactor: number;

  constructor(config: Record<string, unknown> = {}) {
    this.gradientModel = (config.gradient_model as string) ?? "@cf/meta/llama-3.1-70b-instruct";
    this.editModel = (config.edit_model as string) ?? "@cf/meta/llama-3.1-70b-instruct";
    this.beamWidth = (config.beam_width as number) ?? 3;
    this.branchFactor = (config.branch_factor as number) ?? 2;
  }

  /**
   * Build the gradient prompt — asks the LLM to critique why the current
   * system prompt led to eval failures.
   */
  buildGradientPrompt(
    currentPrompt: string,
    evalResults: EvalIterationResult,
    history: IterationHistory[],
  ): string {
    const scoreHistory = history
      .map((h) => `  Iteration ${h.iteration_number}: reward=${h.reward_score?.toFixed(3) ?? "N/A"}, pass_rate=${h.pass_rate?.toFixed(3) ?? "N/A"}`)
      .join("\n");

    return `You are an expert prompt engineer. Analyze why the following system prompt is underperforming and provide specific, actionable critique.

CURRENT SYSTEM PROMPT:
"""
${currentPrompt}
"""

EVAL RESULTS:
- Pass rate: ${evalResults.pass_rate?.toFixed(3) ?? "N/A"}
- Average score: ${evalResults.avg_score?.toFixed(3) ?? "N/A"}
- Average latency: ${evalResults.avg_latency_ms?.toFixed(0) ?? "N/A"}ms
- Cost: $${evalResults.total_cost_usd?.toFixed(4) ?? "N/A"}

TRAINING HISTORY:
${scoreHistory || "  (first iteration)"}

Provide a concise critique (2-4 sentences) identifying the most impactful weaknesses. Focus on what changes would most improve the pass rate. Do NOT write a new prompt — only provide the critique.

CRITIQUE:`;
  }

  /**
   * Build the edit prompt — asks the LLM to rewrite the system prompt
   * based on the gradient critique.
   */
  buildEditPrompt(currentPrompt: string, gradient: string): string {
    return `You are an expert prompt engineer. Rewrite the system prompt below to address the critique. Make targeted improvements — don't change what's already working well.

CURRENT SYSTEM PROMPT:
"""
${currentPrompt}
"""

CRITIQUE TO ADDRESS:
"""
${gradient}
"""

Write the improved system prompt. Output ONLY the new system prompt text, nothing else.

IMPROVED SYSTEM PROMPT:`;
  }

  async optimize(ctx: OptimizationContext): Promise<OptimizationResult> {
    const promptResource = ctx.currentResources.find(
      (r) => r.resource_type === "system_prompt" && r.resource_key === "main",
    );

    if (!promptResource?.content_text) {
      return { updatedResources: [], metadata: { skipped: true, reason: "no system_prompt resource" } };
    }

    // APO on CF Workers: we can't call Workers AI directly here (no `env.AI` binding
    // available in logic modules). Instead, we return the prompts and let the route
    // handler execute the LLM calls. This keeps the algorithm pure/testable.
    const gradientPrompt = this.buildGradientPrompt(
      promptResource.content_text,
      ctx.evalResults,
      ctx.history,
    );

    const editPrompt = this.buildEditPrompt(promptResource.content_text, "{{GRADIENT}}");

    // Don't return placeholder resources when LLM calls are required —
    // the route handler builds the real resources after executing the LLM calls.
    return {
      updatedResources: [],
      metadata: {
        gradient_prompt: gradientPrompt,
        edit_prompt_template: editPrompt,
        gradient_model: this.gradientModel,
        edit_model: this.editModel,
        beam_width: this.beamWidth,
        branch_factor: this.branchFactor,
        requires_llm_calls: true,
      },
    };
  }

  shouldContinue(ctx: OptimizationContext): boolean {
    if (ctx.currentIteration >= ctx.job.max_iterations) return false;

    // Early stop if score hasn't improved in 3 iterations
    if (ctx.history.length >= 3) {
      const recent = ctx.history.slice(-3);
      const scores = recent.map((h) => h.reward_score ?? 0);
      const improving = scores[2] > scores[0];
      if (!improving) return false;
    }

    // Stop if pass rate is already very high
    if (ctx.evalResults.pass_rate !== null && ctx.evalResults.pass_rate >= 0.98) return false;

    return true;
  }
}

// ── Multi-dimension optimizer ──────────────────────────────────────────

const REASONING_STRATEGIES = [
  "step-back", "chain-of-thought", "plan-then-execute",
  "verify-then-respond", "decompose",
] as const;

/**
 * Multi-dimension training: optimizes system_prompt + reasoning_strategy
 * + tool_set + model tier together. Uses APO for prompts and grid search
 * for discrete dimensions (strategy, tools, model).
 *
 * Each iteration explores one dimension change. The algorithm cycles:
 * iteration 1 → prompt (APO), iteration 2 → strategy, iteration 3 → tools,
 * iteration 4 → prompt (APO), etc.
 */
export class MultiDimensionAlgorithm implements TrainingAlgorithm {
  readonly name = "multi";

  private apo: APOAlgorithm;
  private dimensions: string[];
  private enableToolOptimization: boolean;

  constructor(config: Record<string, unknown> = {}) {
    this.apo = new APOAlgorithm(config);
    this.dimensions = (config.dimensions as string[]) ?? ["prompt", "strategy", "prompt", "tools"];
    this.enableToolOptimization = (config.enable_tool_optimization as boolean) ?? true;
  }

  async optimize(ctx: OptimizationContext): Promise<OptimizationResult> {
    const dimensionIndex = ctx.currentIteration % this.dimensions.length;
    const dimension = this.dimensions[dimensionIndex];

    switch (dimension) {
      case "prompt":
        return this.apo.optimize(ctx);

      case "strategy":
        return this.optimizeStrategy(ctx);

      case "tools":
        return this.enableToolOptimization
          ? this.optimizeTools(ctx)
          : { updatedResources: [], metadata: { dimension: "tools", skipped: true, reason: "tool optimization disabled" } };

      default:
        return this.apo.optimize(ctx);
    }
  }

  private async optimizeStrategy(ctx: OptimizationContext): Promise<OptimizationResult> {
    const configResource = ctx.currentResources.find(
      (r) => r.resource_type === "reasoning_strategy",
    );
    const current = configResource?.content_text ?? "chain-of-thought";

    // Try the next strategy in the cycle
    const currentIdx = REASONING_STRATEGIES.indexOf(current as any);
    const nextIdx = (currentIdx + 1) % REASONING_STRATEGIES.length;
    const nextStrategy = REASONING_STRATEGIES[nextIdx];

    return {
      updatedResources: [{
        resourceType: "reasoning_strategy",
        resourceKey: "main",
        contentText: nextStrategy,
        source: "multi",
      }],
      metadata: {
        dimension: "strategy",
        from: current,
        to: nextStrategy,
      },
    };
  }

  private async optimizeTools(ctx: OptimizationContext): Promise<OptimizationResult> {
    const toolResource = ctx.currentResources.find(
      (r) => r.resource_type === "tool_set",
    );

    let currentTools: string[];
    try {
      currentTools = toolResource?.content_text
        ? JSON.parse(toolResource.content_text)
        : [];
    } catch {
      currentTools = [];
    }

    if (currentTools.length === 0) {
      return { updatedResources: [], metadata: { dimension: "tools", skipped: true, reason: "no tools configured" } };
    }

    // Analyze failure patterns — if a tool is never used successfully, try removing it
    const failingTools: string[] = [];
    for (const h of ctx.history) {
      const output = h.algorithm_output;
      if (output.failing_tools && Array.isArray(output.failing_tools)) {
        failingTools.push(...(output.failing_tools as string[]));
      }
    }

    // If we have failing tools, try disabling the most problematic one
    if (failingTools.length > 0) {
      const frequency = new Map<string, number>();
      for (const t of failingTools) {
        frequency.set(t, (frequency.get(t) ?? 0) + 1);
      }
      const worst = [...frequency.entries()].sort((a, b) => b[1] - a[1])[0];
      if (worst) {
        const reducedTools = currentTools.filter((t) => t !== worst[0]);
        return {
          updatedResources: [{
            resourceType: "tool_set",
            resourceKey: "main",
            contentText: JSON.stringify(reducedTools),
            source: "multi",
          }],
          metadata: {
            dimension: "tools",
            removed_tool: worst[0],
            failure_count: worst[1],
            remaining_tools: reducedTools.length,
          },
        };
      }
    }

    return { updatedResources: [], metadata: { dimension: "tools", no_changes: true } };
  }

  shouldContinue(ctx: OptimizationContext): boolean {
    return this.apo.shouldContinue(ctx);
  }
}

// ── Registry ───────────────────────────────────────────────────────────

const ALGORITHMS: Record<string, new (config: Record<string, unknown>) => TrainingAlgorithm> = {
  baseline: BaselineAlgorithm,
  apo: APOAlgorithm,
  multi: MultiDimensionAlgorithm,
};

export function getAlgorithm(name: string, config: Record<string, unknown> = {}): TrainingAlgorithm {
  const AlgClass = ALGORITHMS[name];
  if (!AlgClass) {
    throw new Error(`Unknown training algorithm: ${name}. Available: ${Object.keys(ALGORITHMS).join(", ")}`);
  }
  return new AlgClass(config);
}
