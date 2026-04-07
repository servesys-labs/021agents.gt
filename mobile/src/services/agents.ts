import { apiRequest } from "./api";

export interface AgentSummary {
  agent_id?: string;
  name: string;
  description?: string;
}

export async function listAgents(token: string): Promise<AgentSummary[]> {
  return apiRequest<AgentSummary[]>("/api/v1/agents", { method: "GET" }, token);
}

