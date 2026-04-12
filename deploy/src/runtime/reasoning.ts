/**
 * Reasoning strategy selection — picks and injects reasoning prompts.
 *
 * Strategy definitions (names, descriptions, when-to-use) live in
 * skills/meta/pick-reasoning/SKILL.md. This file contains only the
 * execution code: the strategy→prompt map and selection functions.
 */

export interface ReasoningStrategy {
  name: string;
  description: string;
  prompt: string;
  trigger: "always" | "complex_only" | "first_turn_only";
  complexity_threshold: number;
}

export const REASONING_STRATEGIES: Record<string, ReasoningStrategy> = {
  "step-back": {
    name: "Step-Back Prompting",
    description: "Step back and identify the general principle before answering.",
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
    description: "Think step by step before producing a final answer.",
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
    description: "Outline a plan before taking actions.",
    prompt:
      "[Reasoning Strategy: Plan Then Execute]\n" +
      "MANDATORY: Your FIRST response must be a visible plan — NOT a tool call. Output a structured plan like this:\n\n" +
      "## Plan\n" +
      "1. **Step name** — what you'll do (tool: `tool-name`)\n" +
      "2. **Step name** — what you'll do (tool: `tool-name`)\n" +
      "...\n\n" +
      "Then say 'Executing now.' and start calling tools to execute each step.\n" +
      "DO NOT skip the plan. DO NOT start with a tool call. The user must see the plan FIRST.",
    trigger: "first_turn_only",
    complexity_threshold: 0,
  },
  "verify-then-respond": {
    name: "Verify Then Respond",
    description: "Verify answer against the original question before responding.",
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
    description: "Break complex tasks into smaller sub-tasks.",
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

/** Select reasoning strategy by name. Returns prompt or null. */
export function selectReasoningStrategy(
  strategyName: string | undefined,
  task: string,
  turn: number,
): string | null {
  if (!strategyName) return null;
  const strategy = REASONING_STRATEGIES[strategyName];
  if (!strategy) return null;
  if (strategy.trigger === "first_turn_only" && turn > 1) return null;
  if (strategy.trigger === "complex_only" && task.length < strategy.complexity_threshold) return null;
  return strategy.prompt;
}

/** Auto-select a reasoning strategy from task content heuristics. */
export function autoSelectStrategy(task: string, toolCount: number): string | null {
  const lower = task.toLowerCase();

  if (lower.includes("implement") || lower.includes("build") || lower.includes("create") ||
      lower.includes("refactor") || lower.includes("migrate")) {
    if (task.length > 150) return REASONING_STRATEGIES["plan-then-execute"].prompt;
  }
  if (lower.includes("debug") || lower.includes("fix") || lower.includes("investigate") ||
      lower.includes("why") || lower.includes("root cause")) {
    return REASONING_STRATEGIES["step-back"].prompt;
  }
  if (toolCount > 10 && task.length > 200) {
    return REASONING_STRATEGIES["decompose"].prompt;
  }
  if (lower.includes("analyze") || lower.includes("compare") || lower.includes("evaluate") ||
      lower.includes("calculate") || lower.includes("determine")) {
    if (task.length > 100) return REASONING_STRATEGIES["chain-of-thought"].prompt;
  }
  return null;
}

/** Codemode snippet for the pre_llm middleware hook. */
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
