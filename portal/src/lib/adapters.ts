export type UsageResponse = {
  total_cost_usd?: number;
  total_input_tokens?: number;
  total_output_tokens?: number;
  by_model?: Record<string, number>;
  by_cost_type?: Record<string, number>;
  by_agent?: Record<string, number>;
  inference_cost_usd?: number;
  connector_cost_usd?: number;
  gpu_compute_cost_usd?: number;
};

export type DailyUsageResponse = {
  days?: Array<{
    day: string;
    cost?: number;
    call_count?: number;
  }>;
};

export type SessionSummaryResponse = {
  total_sessions?: number;
  avg_duration_seconds?: number;
};

export type AgentInfo = {
  name: string;
  description?: string;
  model?: string;
  tools?: Array<string | Record<string, unknown>>;
  tags?: string[];
};

export type SessionInfo = {
  session_id: string;
  agent_name?: string;
  status?: string;
  step_count?: number;
  cost_total_usd?: number;
  wall_clock_seconds?: number;
};

export function toMoney(value: unknown): string {
  return `$${(typeof value === "number" ? value : 0).toFixed(4)}`;
}

export function toNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function safeArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

export function summarizeCoverage(paths: string[]): {
  total: number;
  v1: number;
  legacy: number;
} {
  let v1 = 0;
  let legacy = 0;
  for (const path of paths) {
    if (path.startsWith("/api/v1/")) {
      v1 += 1;
    } else {
      legacy += 1;
    }
  }
  return { total: paths.length, v1, legacy };
}
