import { api } from "./api";

// ── Types ──────────────────────────────────────────────────────────

export interface ObservabilitySummary {
  total_sessions: number;
  total_cost_usd: number;
  avg_latency_seconds: number;
  success_rate: number;
  total_input_tokens: number;
  total_output_tokens: number;
  since_days: number;
}

export interface DailyUsageDay {
  day: string;
  cost: number;
  input_tokens: number;
  output_tokens: number;
  call_count: number;
}

// ── API functions ──────────────────────────────────────────────────

export function getObservabilitySummary(sinceDays = 30): Promise<ObservabilitySummary> {
  return api.get<ObservabilitySummary>(`/observability/summary?since_days=${sinceDays}`);
}

export function getDailyUsage(days = 30): Promise<{ days: DailyUsageDay[] }> {
  return api.get<{ days: DailyUsageDay[] }>(`/billing/usage/daily?days=${days}`);
}
