import { apiRequest } from "./api";

export interface EvalRunSummary {
  run_id: number;
  agent_name: string;
  pass_rate?: number;
  total_trials?: number;
  total_tasks?: number;
  avg_latency_ms?: number;
  total_cost_usd?: number;
}

export interface EvalTask {
  name?: string;
  input: string;
  expected?: string;
  grader?: string;
}

export async function listEvalRuns(token: string, agentName?: string): Promise<EvalRunSummary[]> {
  const q = agentName ? `?agent_name=${encodeURIComponent(agentName)}` : "";
  return apiRequest<EvalRunSummary[]>(`/api/v1/eval/runs${q}`, { method: "GET" }, token);
}

export async function getEvalRunDetail(token: string, runId: number): Promise<Record<string, unknown>> {
  return apiRequest<Record<string, unknown>>(
    `/api/v1/eval/runs/${runId}`,
    { method: "GET" },
    token,
  );
}

export async function startEvalRun(
  token: string,
  agentName: string,
  tasks: EvalTask[],
  trials = 3,
): Promise<Record<string, unknown>> {
  return apiRequest<Record<string, unknown>>(
    "/api/v1/eval/run",
    {
      method: "POST",
      body: JSON.stringify({
        agent_name: agentName,
        eval_name: "mobile-eval",
        trials,
        tasks,
      }),
    },
    token,
  );
}

