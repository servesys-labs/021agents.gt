import { api } from "./api";

export interface DashboardStats {
  total_agents: number;
  live_agents: number;
  total_sessions: number;
  active_sessions: number;
  total_cost_usd: number;
  avg_latency_ms: number;
  error_rate_pct: number;
}

export interface ActivityItem {
  id: string;
  type: "session" | "error" | "deploy" | "eval";
  message: string;
  agent_name: string;
  created_at: string;
}

export interface AgentStats {
  agent_name: string;
  sessions: number;
  cost_usd: number;
  avg_latency_ms: number;
  error_rate_pct: number;
}

export interface TrendPoint {
  date: string;
  sessions: number;
  cost_usd: number;
  errors: number;
}

export async function getStats(): Promise<DashboardStats> {
  return api.get<DashboardStats>("/dashboard/stats");
}

export async function getActivity(limit = 10): Promise<{ items: ActivityItem[] }> {
  return api.get<{ items: ActivityItem[] }>(`/dashboard/activity?limit=${limit}`);
}

export async function getAgentStats(): Promise<{ agents: AgentStats[] }> {
  return api.get<{ agents: AgentStats[] }>("/dashboard/stats/by-agent");
}

export async function getTrends(period = "7d"): Promise<{ points: TrendPoint[] }> {
  return api.get<{ points: TrendPoint[] }>(`/dashboard/stats/trends?period=${period}`);
}
