import { api } from "./api";

// ── Types ──────────────────────────────────────────────────────────

export interface Session {
  session_id: string;
  agent_name: string;
  status: string;
  input_text: string;
  output_text: string;
  step_count: number;
  cost_total_usd: number;
  wall_clock_seconds: number;
  trace_id: string;
  parent_session_id: string | null;
  depth: number;
  created_at: number;
}

export interface Turn {
  turn_number: number;
  model_used: string;
  input_tokens: number;
  output_tokens: number;
  latency_ms: number;
  content: string;
  cost_total_usd: number;
  tool_calls: unknown[];
  tool_results: unknown[];
  execution_mode: string;
  plan_artifact: Record<string, unknown>;
  reflection: Record<string, unknown>;
  created_at: string | null;
}

// ── API functions ──────────────────────────────────────────────────

export function listSessions(opts: {
  agent_name?: string;
  status?: string;
  limit?: number;
  offset?: number;
} = {}): Promise<Session[]> {
  const params = new URLSearchParams();
  if (opts.agent_name) params.set("agent_name", opts.agent_name);
  if (opts.status) params.set("status", opts.status);
  if (opts.limit) params.set("limit", String(opts.limit));
  if (opts.offset) params.set("offset", String(opts.offset));
  const qs = params.toString();
  return api.get<Session[]>(`/sessions${qs ? `?${qs}` : ""}`);
}

export function getSessionTurns(sessionId: string): Promise<Turn[]> {
  return api.get<Turn[]>(`/sessions/${encodeURIComponent(sessionId)}/turns`);
}

export function submitFeedback(sessionId: string, rating: number, comment?: string): Promise<{ submitted: boolean }> {
  return api.post<{ submitted: boolean }>(`/sessions/${encodeURIComponent(sessionId)}/feedback`, {
    rating,
    comment: comment || "",
  });
}
