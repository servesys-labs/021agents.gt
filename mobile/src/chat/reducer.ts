import type { ChatEvent, ChatMessageItem, ToolCallItem } from "./types";

export interface ChatState {
  messages: ChatMessageItem[];
  sessionId?: string;
  streaming: boolean;
  error?: string;
}

export const initialChatState: ChatState = {
  messages: [],
  streaming: false,
};

function trimEmptyAssistantTail(messages: ChatMessageItem[]): ChatMessageItem[] {
  if (messages.length === 0) return messages;
  const last = messages[messages.length - 1];
  const hasToolCalls = Boolean(last.toolCalls && last.toolCalls.length > 0);
  const hasThinking = Boolean(last.thinking && last.thinking.trim().length > 0);
  const hasContent = Boolean(last.content && last.content.trim().length > 0);
  if (last.role === "assistant" && !hasToolCalls && !hasThinking && !hasContent) {
    return messages.slice(0, -1);
  }
  return messages;
}

function createAssistantMessage(): ChatMessageItem {
  return {
    id: `assistant-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role: "assistant",
    content: "",
    toolCalls: [],
    thinking: "",
  };
}

function getLastAssistant(messages: ChatMessageItem[]): ChatMessageItem | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") return messages[i];
  }
  return undefined;
}

function upsertToolCall(
  toolCalls: ToolCallItem[] | undefined,
  incoming: Partial<ToolCallItem> & { callId: string; name: string },
): ToolCallItem[] {
  const next = [...(toolCalls ?? [])];
  const idx = next.findIndex((t) => t.callId === incoming.callId);
  const merged: ToolCallItem = {
    name: incoming.name,
    callId: incoming.callId,
    input: incoming.input ?? "",
    output: incoming.output,
    latencyMs: incoming.latencyMs,
    error: incoming.error,
  };
  if (idx === -1) {
    next.push(merged);
  } else {
    next[idx] = { ...next[idx], ...merged };
  }
  return next;
}

function withAssistant(
  state: ChatState,
  update: (assistant: ChatMessageItem) => ChatMessageItem,
): ChatState {
  const messages = [...state.messages];
  let assistant = getLastAssistant(messages);
  if (!assistant || assistant.done) {
    assistant = createAssistantMessage();
    messages.push(assistant);
  }
  const idx = messages.findIndex((m) => m.id === assistant.id);
  messages[idx] = update(messages[idx]);
  return { ...state, messages };
}

export function addUserMessage(state: ChatState, content: string): ChatState {
  const userMsg: ChatMessageItem = {
    id: `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role: "user",
    content,
    done: true,
  };
  return {
    ...state,
    streaming: true,
    error: undefined,
    messages: [...state.messages, userMsg, createAssistantMessage()],
  };
}

export function applyStreamEvent(state: ChatState, event: ChatEvent): ChatState {
  switch (event.type) {
    case "turn_start":
      return withAssistant({ ...state, streaming: true, error: undefined }, (assistant) => ({
        ...assistant,
        model: String(event.data.model ?? assistant.model ?? ""),
      }));

    case "token":
      return withAssistant(state, (assistant) => ({
        ...assistant,
        content: `${assistant.content}${String(event.data.content ?? "")}`,
      }));

    case "thinking":
      return withAssistant(state, (assistant) => ({
        ...assistant,
        thinking: `${assistant.thinking ?? ""}${String(event.data.content ?? "")}`,
      }));

    case "tool_call":
      return withAssistant(state, (assistant) => ({
        ...assistant,
        toolCalls: upsertToolCall(assistant.toolCalls, {
          callId: String(event.data.tool_call_id ?? event.data.call_id ?? ""),
          name: String(event.data.name ?? "tool"),
          input: String(event.data.args_preview ?? event.data.input ?? ""),
        }),
      }));

    case "tool_result":
      return withAssistant(state, (assistant) => ({
        ...assistant,
        toolCalls: upsertToolCall(assistant.toolCalls, {
          callId: String(event.data.tool_call_id ?? event.data.call_id ?? ""),
          name: String(event.data.name ?? "tool"),
          output: String(event.data.result ?? ""),
          latencyMs: Number(event.data.latency_ms ?? 0),
          error: event.data.error ? String(event.data.error) : undefined,
        }),
      }));

    case "turn_end":
      return withAssistant(state, (assistant) => ({
        ...assistant,
        done: true,
      }));

    case "done":
      return withAssistant({ ...state, streaming: false }, (assistant) => ({
        ...assistant,
        content: assistant.content || String(event.data.output ?? assistant.content ?? ""),
        model: String(event.data.model ?? assistant.model ?? ""),
        costUsd:
          event.data.cost_usd !== undefined
            ? Number(event.data.cost_usd)
            : assistant.costUsd,
        done: true,
      }));

    case "error":
      return {
        ...state,
        streaming: false,
        error: String(event.data.message ?? "Unknown stream error"),
        messages: trimEmptyAssistantTail(state.messages),
      };

    default:
      return state;
  }
}

