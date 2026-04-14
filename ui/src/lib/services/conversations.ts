/**
 * Conversation persistence service — API calls for durable chat history.
 */
import { api } from "./api";

export interface Conversation {
  id: string;
  org_id: string;
  user_id: string;
  agent_name: string;
  channel: string;
  title: string;
  message_count: number;
  total_cost_usd: number;
  created_at: string;
  updated_at: string;
}

export interface ConversationMessage {
  id: number;
  conversation_id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  model: string | null;
  token_count: number;
  cost_usd: number;
  session_id: string | null;
  tool_calls: unknown[];
  tool_results: unknown[];
  metadata: Record<string, unknown>;
  created_at: string;
}

export async function listConversations(
  agentName: string,
  limit = 50,
  cursor?: string,
): Promise<{ conversations: Conversation[]; has_more: boolean; cursor?: string }> {
  const params = new URLSearchParams({ agent_name: agentName, limit: String(limit) });
  if (cursor) params.set("cursor", cursor);
  return api.get<{ conversations: Conversation[]; has_more: boolean; cursor?: string }>(
    `/conversations?${params}`,
  );
}

export async function getConversationMessages(
  conversationId: string,
  afterId?: number,
  limit = 100,
): Promise<{ messages: ConversationMessage[]; has_more: boolean; after_id?: number }> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (afterId) params.set("after_id", String(afterId));
  return api.get<{ messages: ConversationMessage[]; has_more: boolean; after_id?: number }>(
    `/conversations/${conversationId}/messages?${params}`,
  );
}

export async function createConversation(
  agentName: string,
  channel = "portal",
): Promise<Conversation> {
  return api.post<Conversation>("/conversations", { agent_name: agentName, channel });
}

export async function deleteConversation(id: string): Promise<void> {
  await api.del(`/conversations/${id}`);
}

export async function updateTitle(id: string, title: string): Promise<void> {
  await api.put(`/conversations/${id}`, { title });
}
