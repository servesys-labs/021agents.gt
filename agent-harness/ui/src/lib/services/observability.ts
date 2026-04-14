import { api } from "./api";

// ── Types ──────────────────────────────────────────────────────────

export interface ModelUsage {
  model: string;
  turns: number;
  input_tokens: number;
  output_tokens: number;
}

export interface AgentUsage {
  agent: string;
  sessions: number;
  steps: number;
  avg_latency: number;
}

export interface DailyActivity {
  day: string;
  sessions: number;
  steps: number;
  cost: number;
}

export interface ObservabilitySummary {
  total_sessions: number;
  total_cost_usd: number;
  avg_latency_seconds: number;
  avg_turn_latency_ms: number;
  success_rate: number;
  error_count: number;
  total_steps: number;
  total_input_tokens: number;
  total_output_tokens: number;
  models_used: number;
  top_models: ModelUsage[];
  top_agents: AgentUsage[];
  daily: DailyActivity[];
  since_days: number;
}

// ── API functions ──────────────────────────────────────────────────

export function getObservabilitySummary(sinceDays = 30): Promise<ObservabilitySummary> {
  return api.get<ObservabilitySummary>(`/observability/summary?since_days=${sinceDays}`);
}
