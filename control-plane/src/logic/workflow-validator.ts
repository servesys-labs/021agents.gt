/**
 * Workflow DAG validator — topological sort + cycle detection.
 */

export interface WorkflowStep {
  id: string;
  type?: string;
  agent?: string;
  task?: string;
  depends_on?: string[];
  branches?: string[];
  config?: Record<string, unknown>;
  retries?: number;
  timeout_ms?: number;
  budget_usd?: number;
}

const VALID_TYPES = new Set([
  "llm", "tool", "task", "parallel", "parallel_group",
  "join", "reflect", "verify", "finalize", "plan",
]);

/**
 * Normalize legacy workflow steps into typed nodes.
 */
export function normalizeSteps(steps: WorkflowStep[]): WorkflowStep[] {
  return steps.map((raw, idx) => {
    const stepId = raw.id || raw.agent || `step_${idx + 1}`;
    let nodeType = raw.type || "";
    if (!nodeType) {
      nodeType = raw.agent ? "llm" : "task";
    }
    if (nodeType === "parallel") nodeType = "parallel_group";
    if (nodeType === "task") nodeType = "llm";

    const retries = Math.min(10, Math.max(0, Number(raw.retries || 0) || 0));
    const budgetUsd = Math.max(0, Number(raw.budget_usd || 0) || 0);

    return {
      id: stepId,
      type: nodeType,
      agent: raw.agent || "",
      task: raw.task || "",
      depends_on: raw.depends_on || [],
      branches: raw.branches || [],
      config: raw.config || {},
      retries,
      timeout_ms: Number(raw.timeout_ms || 30000) || 30000,
      budget_usd: budgetUsd,
    };
  });
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  step_count: number;
}

/**
 * Validate a workflow DAG: check step IDs, types, dependencies, and cycles.
 */
export function validateWorkflow(steps: WorkflowStep[]): ValidationResult {
  const errors: string[] = [];
  const stepIds = new Set<string>();

  // Check IDs
  for (const step of steps) {
    const stepId = step.id || "";
    if (!stepId) {
      errors.push("Every step must have an 'id' field");
      continue;
    }
    if (stepIds.has(stepId)) {
      errors.push(`Duplicate step id: '${stepId}'`);
    }
    stepIds.add(stepId);
  }

  // Check types
  for (const step of steps) {
    const stepType = step.type || "";
    if (stepType && !VALID_TYPES.has(stepType)) {
      errors.push(`Step '${step.id}' has unsupported type '${stepType}'`);
    }
  }

  // Build graph and check deps
  const graph: Record<string, string[]> = {};
  for (const step of steps) {
    const deps = step.depends_on || [];
    graph[step.id] = deps;
    for (const dep of deps) {
      if (!stepIds.has(dep)) {
        errors.push(`Step '${step.id}' depends on unknown step '${dep}'`);
      }
    }
  }

  // Cycle detection via DFS
  const visited = new Set<string>();
  const inStack = new Set<string>();

  function hasCycle(node: string): boolean {
    if (inStack.has(node)) return true;
    if (visited.has(node)) return false;
    visited.add(node);
    inStack.add(node);
    for (const dep of graph[node] || []) {
      if (hasCycle(dep)) return true;
    }
    inStack.delete(node);
    return false;
  }

  for (const stepId of stepIds) {
    if (hasCycle(stepId)) {
      errors.push("Circular dependency detected in workflow DAG");
      break;
    }
  }

  return { valid: errors.length === 0, errors, step_count: steps.length };
}

/**
 * Derive run metadata from dag/reflection JSON.
 */
export function deriveRunMetadata(
  dag: Record<string, any>,
  reflection: Record<string, any>,
): Record<string, any> {
  const nodes = Array.isArray(dag?.nodes) ? dag.nodes : [];
  const results = dag?.results && typeof dag.results === "object" ? dag.results : {};
  const nodeTypes = nodes.map((n: any) => String(n?.type || "")).filter(Boolean);
  const executionMode = nodeTypes.includes("parallel_group") ? "parallel" : "sequential";

  const reducerStrategies: string[] = [];
  for (const result of Object.values(results)) {
    if (typeof result !== "object" || !result) continue;
    const meta = (result as any)?.metadata;
    if (typeof meta === "object" && meta?.strategy) {
      reducerStrategies.push(String(meta.strategy));
    }
  }
  const uniqueStrategies = [...new Set(reducerStrategies)].sort();

  const reflectionNodes = reflection?.nodes && typeof reflection.nodes === "object" ? reflection.nodes : {};
  const confidences: number[] = [];
  let reviseCount = 0;
  let continueCount = 0;

  for (const node of Object.values(reflectionNodes)) {
    if (typeof node !== "object" || !node) continue;
    const conf = (node as any)?.confidence;
    if (typeof conf === "number") confidences.push(conf);
    const action = String((node as any)?.action || "");
    if (action === "revise") reviseCount++;
    else if (action === "continue") continueCount++;
  }

  const avgConfidence = confidences.length > 0
    ? Math.round((confidences.reduce((a, b) => a + b, 0) / confidences.length) * 10000) / 10000
    : 0;

  return {
    execution_mode: executionMode,
    reducer_strategies: uniqueStrategies,
    reflection_rollup: {
      avg_confidence: avgConfidence,
      revise_count: reviseCount,
      continue_count: continueCount,
      node_count: Object.keys(reflectionNodes).length,
    },
  };
}
