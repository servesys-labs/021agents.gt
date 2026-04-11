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
