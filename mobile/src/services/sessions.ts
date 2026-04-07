import { apiRequest } from "./api";

export interface SessionSummary {
  session_id: string;
  agent_name?: string;
  status?: string;
  created_at?: string;
  updated_at?: string;
}

export interface SessionTurn {
  turn_id?: string;
  role?: string;
  content?: string;
  created_at?: string;
}

export async function listSessions(token: string): Promise<SessionSummary[]> {
  return apiRequest<SessionSummary[]>("/api/v1/sessions", { method: "GET" }, token);
}

export async function getSessionTurns(
  token: string,
  sessionId: string,
): Promise<SessionTurn[]> {
  return apiRequest<SessionTurn[]>(
    `/api/v1/sessions/${encodeURIComponent(sessionId)}/turns`,
    { method: "GET" },
    token,
  );
}

