import { api } from "./api";

// ── Types ──────────────────────────────────────────────────────────

export interface EvalRun {
  run_id: number;
  agent_name: string;
  pass_rate: number;
  avg_score: number;
  avg_latency_ms: number;
  total_cost_usd: number;
  total_tasks: number;
  total_trials: number;
}

export interface EvalTrial {
  trial_number: number;
  task_name: string;
  input: string;
  expected: string;
  actual: string;
  passed: boolean;
  score: number;
  latency_ms: number;
  cost_usd: number;
}

// ── API functions ──────────────────────────────────────────────────

export function listEvalRuns(agentName?: string, limit = 20): Promise<EvalRun[]> {
  const params = new URLSearchParams();
  if (agentName) params.set("agent_name", agentName);
  params.set("limit", String(limit));
  return api.get<EvalRun[]>(`/eval/runs?${params.toString()}`);
}

export function getEvalTrials(runId: number): Promise<{ run_id: number; trials: EvalTrial[] }> {
  return api.get<{ run_id: number; trials: EvalTrial[] }>(`/eval/runs/${runId}/trials`);
}
