export type ChatEventType =
  | "turn_start"
  | "thinking"
  | "tool_call"
  | "tool_result"
  | "token"
  | "turn_end"
  | "done"
  | "error";

export interface ChatEvent {
  type: ChatEventType;
  data: Record<string, unknown>;
}

export interface ToolCallItem {
  name: string;
  input: string;
  output?: string;
  callId: string;
  latencyMs?: number;
  error?: string;
}

export interface ChatMessageItem {
  id: string;
  role: "user" | "assistant";
  content: string;
  toolCalls?: ToolCallItem[];
  thinking?: string;
  model?: string;
  costUsd?: number;
  done?: boolean;
}

export interface StreamDoneData {
  output?: string;
  cost_usd?: number;
  session_id?: string;
  turns?: number;
  tool_calls?: number;
  model?: string;
}

export interface StreamAgentOptions {
  baseUrl: string;
  token: string;
  agentName: string;
  message: string;
  sessionId?: string;
  history?: Array<{ role: "user" | "assistant" | "system"; content: string }>;
  plan?: "free" | "basic" | "standard" | "premium";
  onEvent: (event: ChatEvent) => void;
}

