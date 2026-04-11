import { describe, expect, it } from "vitest";

import {
  applyHistoryBudget,
  buildQueryIntentProfile,
  hasExplicitToolIntent,
} from "../src/runtime/query-profile";

describe("query profile routing behavior", () => {
  it("detects explicit tool intent from user prompt", () => {
    expect(hasExplicitToolIntent("please find latest benchmarks")).toBe(true);
    expect(hasExplicitToolIntent("hi there")).toBe(false);
  });

  it("uses lightweight profile for simple general chat", () => {
    const profile = buildQueryIntentProfile(
      { complexity: "simple", category: "general", role: "simple" },
      "hello",
    );
    expect(profile.key).toBe("general_simple_chat");
    expect(profile.max_history_messages).toBe(6);
    expect(profile.max_tools_exposed).toBe(6);
    expect(profile.max_tokens_per_turn).toBe(700);
    expect(profile.include_deferred_tool_index).toBe(false);
    expect(profile.use_minimal_system_context).toBe(true);
    expect(profile.max_tool_result_chars).toBe(1800);
  });

  it("uses tool-friendly simple profile when prompt asks for actions", () => {
    const profile = buildQueryIntentProfile(
      { complexity: "simple", category: "general", role: "simple" },
      "find and compare latest model pricing",
    );
    expect(profile.key).toBe("general_simple_tool");
    expect(profile.max_history_messages).toBe(10);
    expect(profile.max_tools_exposed).toBe(10);
    expect(profile.use_minimal_system_context).toBe(true);
    expect(profile.max_tool_result_chars).toBe(3500);
  });

  it("uses expanded profile for complex research", () => {
    const profile = buildQueryIntentProfile(
      { complexity: "complex", category: "research", role: "synthesize" },
      "deep research on market leaders",
    );
    expect(profile.key).toBe("research_complex");
    expect(profile.max_history_messages).toBe(28);
    expect(profile.max_tools_exposed).toBe(24);
    expect(profile.max_tokens_per_turn).toBe(3200);
    expect(profile.include_team_memory).toBe(true);
    expect(profile.max_turn_result_chars).toBe(200000);
  });

  it("preserves system messages while trimming older history", () => {
    const messages = [
      { role: "system", content: "sys-a" },
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
      { role: "assistant", content: "a2" },
      { role: "user", content: "u3" },
    ];
    const result = applyHistoryBudget(messages, 3);
    expect(result.dropped).toBe(2);
    expect(result.messages.filter((m) => m.role === "system").length).toBe(1);
    expect(result.messages.length).toBe(4);
    expect(result.messages[result.messages.length - 1]?.content).toBe("u3");
  });
});
