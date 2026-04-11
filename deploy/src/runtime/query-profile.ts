export interface QueryIntentProfile {
  key: string;
  max_history_messages: number;
  max_tools_exposed: number;
  max_tokens_per_turn: number;
  include_deferred_tool_index: boolean;
  use_minimal_system_context: boolean;
  include_team_memory: boolean;
  include_channel_guidelines: boolean;
  include_reasoning_prompts: boolean;
  max_tool_result_chars: number;
  max_turn_result_chars: number;
  max_non_system_chars: number;
  max_message_chars: number;
}

export interface QueryRouteLike {
  complexity?: string;
  category?: string;
  role?: string;
}

export function hasExplicitToolIntent(input: string): boolean {
  const q = String(input || "").toLowerCase();
  return /\b(read|search|find|fetch|check|run|execute|build|debug|fix|write file|edit file|analy[sz]e|investigate|compare)\b/.test(q);
}

export function buildQueryIntentProfile(
  route: QueryRouteLike,
  input: string,
): QueryIntentProfile {
  const complexity = String(route?.complexity || "moderate").toLowerCase();
  const category = String(route?.category || "general").toLowerCase();
  const role = String(route?.role || "").toLowerCase();
  const explicitToolIntent = hasExplicitToolIntent(input);

  if (category === "general" && complexity === "simple") {
    return {
      key: explicitToolIntent ? "general_simple_tool" : "general_simple_chat",
      max_history_messages: explicitToolIntent ? 10 : 6,
      max_tools_exposed: explicitToolIntent ? 10 : 6,
      max_tokens_per_turn: explicitToolIntent ? 1000 : 700,
      include_deferred_tool_index: false,
      use_minimal_system_context: true,
      include_team_memory: false,
      include_channel_guidelines: false,
      include_reasoning_prompts: false,
      max_tool_result_chars: explicitToolIntent ? 3500 : 1800,
      max_turn_result_chars: explicitToolIntent ? 8000 : 4000,
      max_non_system_chars: explicitToolIntent ? 10000 : 5000,
      max_message_chars: explicitToolIntent ? 2000 : 1200,
    };
  }

  if (category === "research") {
    return {
      key: complexity === "complex" ? "research_complex" : "research",
      max_history_messages: complexity === "complex" ? 28 : 20,
      max_tools_exposed: 24,
      max_tokens_per_turn: complexity === "complex" ? 3200 : 2400,
      include_deferred_tool_index: true,
      use_minimal_system_context: false,
      include_team_memory: true,
      include_channel_guidelines: true,
      include_reasoning_prompts: true,
      max_tool_result_chars: 30000,
      max_turn_result_chars: 200000,
      max_non_system_chars: 80000,
      max_message_chars: 12000,
    };
  }

  if (category === "coding") {
    return {
      key: role === "planner" ? "coding_planner" : "coding",
      max_history_messages: role === "planner" ? 16 : 24,
      max_tools_exposed: 20,
      max_tokens_per_turn: role === "planner" ? 1800 : 2600,
      include_deferred_tool_index: true,
      use_minimal_system_context: role === "planner",
      include_team_memory: role !== "planner",
      include_channel_guidelines: true,
      include_reasoning_prompts: role !== "planner",
      max_tool_result_chars: role === "planner" ? 12000 : 25000,
      max_turn_result_chars: role === "planner" ? 60000 : 180000,
      max_non_system_chars: role === "planner" ? 25000 : 70000,
      max_message_chars: role === "planner" ? 5000 : 12000,
    };
  }

  return {
    key: "default",
    max_history_messages: 18,
    max_tools_exposed: 16,
    max_tokens_per_turn: 1800,
    include_deferred_tool_index: true,
    use_minimal_system_context: false,
    include_team_memory: true,
    include_channel_guidelines: true,
    include_reasoning_prompts: true,
    max_tool_result_chars: 20000,
    max_turn_result_chars: 140000,
    max_non_system_chars: 50000,
    max_message_chars: 10000,
  };
}

export function applyHistoryBudget<T extends { role: string }>(
  messages: T[],
  maxHistoryMessages: number,
): { messages: T[]; dropped: number } {
  if (maxHistoryMessages <= 0) return { messages, dropped: 0 };

  const systemMessages = messages.filter((m) => m.role === "system");
  const nonSystemMessages = messages.filter((m) => m.role !== "system");
  if (nonSystemMessages.length <= maxHistoryMessages) {
    return { messages, dropped: 0 };
  }

  const keptNonSystem = nonSystemMessages.slice(-maxHistoryMessages);
  return {
    messages: [...systemMessages, ...keptNonSystem],
    dropped: nonSystemMessages.length - keptNonSystem.length,
  };
}

function contentCharLen(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (Array.isArray(content)) {
    let total = 0;
    for (const part of content) {
      if (typeof part === "string") total += part.length;
      else if (part && typeof part === "object") {
        const text = (part as { text?: unknown }).text;
        if (typeof text === "string") total += text.length;
      }
    }
    return total;
  }
  return 0;
}

/**
 * Trim conversation history to fit a char budget while preserving conversational
 * integrity. Drops from the OLDEST side (keeps a contiguous newest suffix) so
 * assistant↔tool_result pairing isn't shredded mid-stream. Caller must still run
 * repairConversation afterwards because the suffix boundary can split a
 * tool_use/tool_result group.
 */
export function applyContentBudget<T extends { role: string; content?: unknown }>(
  messages: T[],
  maxNonSystemChars: number,
  maxMessageChars: number,
): { messages: T[]; droppedMessages: number; truncatedMessages: number; nonSystemChars: number } {
  if (maxNonSystemChars <= 0 || maxMessageChars <= 0) {
    return { messages, droppedMessages: 0, truncatedMessages: 0, nonSystemChars: 0 };
  }

  const out = [...messages];
  let truncatedMessages = 0;
  for (let i = 0; i < out.length; i++) {
    const msg = out[i];
    if (msg.role === "system") continue;
    if (typeof msg.content !== "string") continue;
    if (msg.content.length > maxMessageChars) {
      const nextContent = `${msg.content.slice(0, maxMessageChars)}\n[message truncated for context budget]`;
      out[i] = { ...msg, content: nextContent };
      truncatedMessages++;
    }
  }

  let totalNonSystemChars = 0;
  for (const msg of out) {
    if (msg.role === "system") continue;
    totalNonSystemChars += contentCharLen(msg.content);
  }
  if (totalNonSystemChars <= maxNonSystemChars) {
    return { messages: out, droppedMessages: 0, truncatedMessages, nonSystemChars: totalNonSystemChars };
  }

  // Walk newest-first and STOP at the first message that doesn't fit — this
  // produces a contiguous suffix of recent messages instead of a swiss-cheese
  // history with dropped middle turns. System messages are always retained.
  const keepNonSystem = new Array<boolean>(out.length).fill(false);
  let runningNonSystemChars = 0;
  let suffixClosed = false;
  for (let i = out.length - 1; i >= 0; i--) {
    const msg = out[i];
    if (msg.role === "system") continue;
    if (suffixClosed) continue;
    const msgChars = contentCharLen(msg.content);
    if (runningNonSystemChars + msgChars > maxNonSystemChars) {
      suffixClosed = true;
      continue;
    }
    keepNonSystem[i] = true;
    runningNonSystemChars += msgChars;
  }

  const kept: T[] = [];
  let droppedMessages = 0;
  for (let i = 0; i < out.length; i++) {
    const msg = out[i];
    if (msg.role === "system" || keepNonSystem[i]) {
      kept.push(msg);
    } else {
      droppedMessages++;
    }
  }

  return {
    messages: kept,
    droppedMessages,
    truncatedMessages,
    nonSystemChars: runningNonSystemChars,
  };
}
