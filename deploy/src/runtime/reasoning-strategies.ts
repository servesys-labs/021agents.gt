/**
 * Reasoning Strategy Snippets — pre-built codemode middleware for the pre_llm hook.
 *
 * These snippets inject reasoning strategies into the agent's context before
 * each LLM call. They implement techniques from the AI research literature:
 *
 * - Step-back prompting: "Before answering, step back and think about the general principle"
 * - Chain-of-thought: "Think step by step"
 * - Plan-then-execute: "First outline your plan, then execute it"
 * - Reflection prompting: "After your initial answer, critique it and improve"
 * - Task decomposition: "Break this into smaller sub-tasks"
 *
 * Usage: Set the snippet ID in agent config:
 *   { "codemode_middleware": { "pre_llm": "<snippet_id>" } }
 *
 * Or use the built-in strategy names directly via the reasoning_strategy config field.
 */

// ── Strategy Definitions ──────────────────────────────────────

export interface ReasoningStrategy {
  name: string;
  description: string;
  /** The system message injected before the LLM call. */
  prompt: string;
  /** When to apply: always, complex_only, or first_turn_only. */
  trigger: "always" | "complex_only" | "first_turn_only";
  /** Heuristic: minimum task length to consider "complex". */
  complexity_threshold: number;
}

export const REASONING_STRATEGIES: Record<string, ReasoningStrategy> = {
  "step-back": {
    name: "Step-Back Prompting",
    description:
      "Before diving into the specific task, step back and identify the general " +
      "principle or high-level approach. This improves accuracy on complex tasks " +
      "by grounding the response in first principles.",
    prompt:
      "[Reasoning Strategy: Step-Back]\n" +
      "Before answering, take a step back and consider:\n" +
      "1. What is the core principle or concept behind this task?\n" +
      "2. What high-level approach would an expert take?\n" +
      "3. What common mistakes should I avoid?\n" +
      "Then proceed with your answer, grounded in this understanding.",
    trigger: "complex_only",
    complexity_threshold: 100,
  },

  "chain-of-thought": {
    name: "Chain of Thought",
    description:
      "Think through the problem step by step before producing a final answer. " +
      "Particularly effective for multi-step reasoning, math, and logic tasks.",
    prompt:
      "[Reasoning Strategy: Chain of Thought]\n" +
      "Think through this step by step:\n" +
      "1. Identify what is being asked\n" +
      "2. Break down the problem into logical steps\n" +
      "3. Work through each step carefully\n" +
      "4. Verify your reasoning before giving the final answer",
    trigger: "complex_only",
    complexity_threshold: 80,
  },

  "plan-then-execute": {
    name: "Plan Then Execute",
    description:
      "Outline a concrete plan before taking any actions. Prevents the common " +
      "failure mode where agents start executing immediately without thinking " +
      "about the overall approach.",
    prompt:
      "[Reasoning Strategy: Plan Then Execute]\n" +
      "Before using any tools or writing any code:\n" +
      "1. State what you need to accomplish\n" +
      "2. List the specific steps you'll take (in order)\n" +
      "3. Identify which tools you'll use for each step\n" +
      "4. Note any risks or failure points\n" +
      "Then execute your plan step by step, checking progress after each step.",
    trigger: "first_turn_only",
    complexity_threshold: 0,
  },

  "verify-then-respond": {
    name: "Verify Then Respond",
    description:
      "After forming an answer, verify it against the original question before " +
      "responding. Catches errors where the agent answers a slightly different " +
      "question than what was asked.",
    prompt:
      "[Reasoning Strategy: Verify Then Respond]\n" +
      "Before giving your final answer:\n" +
      "1. Re-read the original question/task carefully\n" +
      "2. Check: does your answer actually address what was asked?\n" +
      "3. Are there any assumptions you made that might be wrong?\n" +
      "4. Is your answer complete, or did you miss any parts of the request?",
    trigger: "always",
    complexity_threshold: 0,
  },

  "decompose": {
    name: "Task Decomposition",
    description:
      "Break complex tasks into smaller, manageable sub-tasks before starting. " +
      "Effective for large implementation tasks that would otherwise overwhelm " +
      "the agent's working memory.",
    prompt:
      "[Reasoning Strategy: Decompose]\n" +
      "This task may be complex. Before starting:\n" +
      "1. Break it into 3-5 smaller sub-tasks\n" +
      "2. Order them by dependency (what must be done first?)\n" +
      "3. Identify which sub-task is most critical\n" +
      "4. Start with that sub-task and complete it fully before moving on\n" +
      "Do NOT try to do everything at once.",
    trigger: "complex_only",
    complexity_threshold: 200,
  },
};

// ── Strategy Selection ────────────────────────────────────────

/**
 * Select the appropriate reasoning strategy based on task characteristics.
 * Returns the strategy prompt to inject, or null if no strategy applies.
 */
export function selectReasoningStrategy(
  strategyName: string | undefined,
  task: string,
  turn: number,
): string | null {
  if (!strategyName) return null;

  const strategy = REASONING_STRATEGIES[strategyName];
  if (!strategy) return null;

  // Check trigger conditions
  if (strategy.trigger === "first_turn_only" && turn > 1) return null;
  if (strategy.trigger === "complex_only" && task.length < strategy.complexity_threshold) return null;

  return strategy.prompt;
}

/**
 * Auto-select a reasoning strategy based on task content.
 * Used when no explicit strategy is configured — provides a sensible default.
 */
export function autoSelectStrategy(task: string, toolCount: number): string | null {
  const lower = task.toLowerCase();

  // Code/implementation tasks → plan-then-execute
  if (lower.includes("implement") || lower.includes("build") || lower.includes("create") ||
      lower.includes("refactor") || lower.includes("migrate")) {
    if (task.length > 150) return REASONING_STRATEGIES["plan-then-execute"].prompt;
  }

  // Debugging/investigation → step-back
  if (lower.includes("debug") || lower.includes("fix") || lower.includes("investigate") ||
      lower.includes("why") || lower.includes("root cause")) {
    return REASONING_STRATEGIES["step-back"].prompt;
  }

  // Multi-step tasks with many tools → decompose
  if (toolCount > 10 && task.length > 200) {
    return REASONING_STRATEGIES["decompose"].prompt;
  }

  // Complex analytical tasks → chain-of-thought
  if (lower.includes("analyze") || lower.includes("compare") || lower.includes("evaluate") ||
      lower.includes("calculate") || lower.includes("determine")) {
    if (task.length > 100) return REASONING_STRATEGIES["chain-of-thought"].prompt;
  }

  return null;
}

/**
 * Codemode snippet code for the pre_llm middleware hook.
 * This is what gets stored as a codemode_snippets row and referenced by snippet ID.
 *
 * The snippet receives `input` with: { messages, turn, cumulative_cost_usd, strategy, task, tool_count }
 * It returns: { action: "inject", modified: "<strategy prompt>" } or { action: "continue" }
 */
export const REASONING_STRATEGY_SNIPPET_CODE = `
// Reasoning strategy middleware — runs before each LLM call.
// Selects and injects an appropriate reasoning prompt based on task characteristics.

const { strategy, task, turn, tool_count } = input;

// Strategy name → prompt mapping
const STRATEGIES = {
  "step-back": "[Reasoning Strategy: Step-Back]\\nBefore answering, take a step back and consider:\\n1. What is the core principle or concept behind this task?\\n2. What high-level approach would an expert take?\\n3. What common mistakes should I avoid?\\nThen proceed with your answer, grounded in this understanding.",
  "chain-of-thought": "[Reasoning Strategy: Chain of Thought]\\nThink through this step by step:\\n1. Identify what is being asked\\n2. Break down the problem into logical steps\\n3. Work through each step carefully\\n4. Verify your reasoning before giving the final answer",
  "plan-then-execute": "[Reasoning Strategy: Plan Then Execute]\\nBefore using any tools or writing any code:\\n1. State what you need to accomplish\\n2. List the specific steps you'll take (in order)\\n3. Identify which tools you'll use for each step\\n4. Note any risks or failure points\\nThen execute your plan step by step.",
  "verify-then-respond": "[Reasoning Strategy: Verify Then Respond]\\nBefore giving your final answer:\\n1. Re-read the original question/task carefully\\n2. Check: does your answer actually address what was asked?\\n3. Are there any assumptions you made that might be wrong?\\n4. Is your answer complete?",
  "decompose": "[Reasoning Strategy: Decompose]\\nThis task may be complex. Before starting:\\n1. Break it into 3-5 smaller sub-tasks\\n2. Order them by dependency\\n3. Start with the most critical sub-task\\n4. Do NOT try to do everything at once.",
};

// If explicit strategy is set, use it
if (strategy && STRATEGIES[strategy]) {
  // first_turn_only check
  if (strategy === "plan-then-execute" && turn > 1) return { action: "continue" };
  return { action: "inject", modified: STRATEGIES[strategy] };
}

// Auto-select based on task content
const lower = (task || "").toLowerCase();
if (lower.includes("implement") || lower.includes("build") || lower.includes("refactor")) {
  if (task.length > 150) return { action: "inject", modified: STRATEGIES["plan-then-execute"] };
}
if (lower.includes("debug") || lower.includes("fix") || lower.includes("investigate")) {
  return { action: "inject", modified: STRATEGIES["step-back"] };
}
if (tool_count > 10 && task.length > 200) {
  return { action: "inject", modified: STRATEGIES["decompose"] };
}
if (lower.includes("analyze") || lower.includes("compare") || lower.includes("evaluate")) {
  if (task.length > 100) return { action: "inject", modified: STRATEGIES["chain-of-thought"] };
}

return { action: "continue" };
`;
