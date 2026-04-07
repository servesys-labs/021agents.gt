import { apiRequest } from "./api";

export interface MetaChatMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
}

export interface MetaChatResponse {
  response: string;
  messages: Array<Record<string, unknown>>;
  cost_usd?: number;
  turns?: number;
}

export async function runMetaChat(
  token: string,
  agentName: string,
  messages: MetaChatMessage[],
): Promise<MetaChatResponse> {
  return apiRequest<MetaChatResponse>(
    `/api/v1/agents/${encodeURIComponent(agentName)}/meta-chat`,
    {
      method: "POST",
      body: JSON.stringify({
        messages,
        mode: "live",
      }),
    },
    token,
  );
}

