import { api } from "./api";

export interface Session {
  session_id: string;
  agent_name?: string;
  status?: string;
  input_text?: string;
  output_text?: string;
  model?: string;
  step_count?: number;
  action_count?: number;
  cost_total_usd?: number;
  wall_clock_seconds?: number;
  trace_id?: string;
  parent_session_id?: string;
  depth?: number;
  created_at?: string | number;
}

export interface Turn {
  turn_number: number;
  model_used?: string;
  input_tokens?: number;
  output_tokens?: number;
  latency_ms?: number;
  content?: string;
  llm_content?: string;
  cost_total_usd?: number;
  tool_calls?: TurnToolCall[] | string;
  tool_results?: TurnToolResult[] | string;
  errors_json?: string;
  execution_mode?: string;
  plan_artifact?: string;
  reflection?: string;
  created_at?: string | number;
}

export interface TurnToolCall {
  name: string;
  arguments?: Record<string, unknown> | string;
}

export interface TurnToolResult {
  name: string;
  result?: string;
  latency_ms?: number;
  cost_usd?: number;
  error?: string;
}

export interface Feedback {
  id: string;
  session_id: string;
  rating: number | string;
  comment?: string;
  created_at?: string | number;
}

export async function listSessions(
  agentName: string,
  limit = 50,
  status?: string
): Promise<Session[]> {
  const params = new URLSearchParams({ agent_name: agentName, limit: String(limit) });
  if (status && status !== "all") params.set("status", status);
  const data = await api.get<Session[] | { sessions: Session[] }>(`/sessions?${params}`);
  return Array.isArray(data) ? data : (data.sessions ?? []);
}

export async function getSession(sessionId: string): Promise<Session | null> {
  const data = await api.get<Session | { session: Session }>(`/sessions/${encodeURIComponent(sessionId)}`);
  if (!data) return null;
  return (data as { session: Session }).session ?? (data as Session);
}

export async function getSessionTurns(sessionId: string): Promise<Turn[]> {
  const data = await api.get<Turn[] | { turns: Turn[] }>(`/sessions/${encodeURIComponent(sessionId)}/turns`);
  return Array.isArray(data) ? data : (data.turns ?? []);
}

export async function getSessionFeedback(sessionId: string): Promise<Feedback[]> {
  const data = await api.get<Feedback[] | { feedback: Feedback[] }>(`/sessions/${encodeURIComponent(sessionId)}/feedback`);
  return Array.isArray(data) ? data : (data.feedback ?? []);
}

export async function submitFeedback(
  sessionId: string,
  rating: "up" | "down",
  comment?: string
): Promise<void> {
  await api.post(`/sessions/${encodeURIComponent(sessionId)}/feedback`, {
    rating: rating === "up" ? 5 : 1,
    comment: comment || "",
  });
}
