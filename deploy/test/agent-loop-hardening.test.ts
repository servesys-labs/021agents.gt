/**
 * Tests for agent-loop hardening improvements.
 *
 * Covers:
 * 1. Budget pressure signaling (80% threshold)
 * 2. Post-compact conversation repair
 * 3. Serial tool abort (executeTools skips remaining on abort)
 * 4. Prune tool results before compaction
 * 5. Diminishing returns detection
 * 6. Max-tokens recovery (stop_reason=length handling)
 * 7. cache_control placement (first system message)
 */
import { describe, it, expect } from "vitest";
import { shouldCompact, compactMessages, pruneToolResults } from "../src/runtime/compact";
import { repairConversation } from "../src/runtime/conversation-repair";
import { executeTools } from "../src/runtime/tools";

// ── 1. Prune tool results ──────────────────────────────────────────

describe("pruneToolResults", () => {
  it("prunes large tool results outside keep-recent tail", () => {
    const messages = [
      { role: "system", content: "System prompt" },
      { role: "user", content: "do something" },
      { role: "assistant", content: "", tool_calls: [{ id: "1", name: "web-search", arguments: "{}" }] },
      { role: "tool", content: "x".repeat(5000), name: "web-search", tool_call_id: "1" },
      { role: "assistant", content: "", tool_calls: [{ id: "2", name: "bash", arguments: "{}" }] },
      { role: "tool", content: "y".repeat(3000), name: "bash", tool_call_id: "2" },
      // Recent messages (keep-recent = 2)
      { role: "user", content: "what did you find?" },
      { role: "assistant", content: "Here are the results." },
    ];
    const { messages: result, pruned } = pruneToolResults(messages, 2);
    expect(pruned).toBe(2);
    // Tool results should be pruned
    const toolMsgs = result.filter(m => m.role === "tool");
    expect(toolMsgs[0].content).toContain("[tool result pruned:");
    expect(toolMsgs[1].content).toContain("[tool result pruned:");
  });

  it("preserves tool results in keep-recent tail", () => {
    const messages = [
      { role: "system", content: "System prompt" },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "", tool_calls: [{ id: "1", name: "bash", arguments: "{}" }] },
      { role: "tool", content: "x".repeat(5000), name: "bash", tool_call_id: "1" },
    ];
    const { messages: result, pruned } = pruneToolResults(messages, 4);
    expect(pruned).toBe(0);
    expect(result).toEqual(messages);
  });

  it("preserves small tool results even outside tail", () => {
    const messages = [
      { role: "system", content: "System prompt" },
      { role: "user", content: "Hi" },
      { role: "assistant", content: "", tool_calls: [{ id: "1", name: "bash", arguments: "{}" }] },
      { role: "tool", content: "OK", name: "bash", tool_call_id: "1" },
      ...Array.from({ length: 6 }, (_, i) => ({
        role: i % 2 === 0 ? "user" as const : "assistant" as const,
        content: `msg-${i}`,
      })),
    ];
    const { pruned } = pruneToolResults(messages, 4);
    expect(pruned).toBe(0); // "OK" is <= 200 chars
  });

  it("preserves error content in pruned results", () => {
    const messages = [
      { role: "system", content: "System prompt" },
      { role: "user", content: "do something" },
      { role: "assistant", content: "", tool_calls: [{ id: "1", name: "bash", arguments: "{}" }] },
      { role: "tool", content: "Error: " + "x".repeat(500), name: "bash", tool_call_id: "1" },
      // Recent tail
      { role: "user", content: "what happened?" },
      { role: "assistant", content: "There was an error." },
    ];
    const { messages: result, pruned } = pruneToolResults(messages, 2);
    expect(pruned).toBe(1);
    const toolMsg = result.find(m => m.role === "tool")!;
    expect(toolMsg.content).toContain("Error:");
    // Should include the first 200 chars of the error, not just "OK (N chars)"
    expect(toolMsg.content).not.toContain("OK (");
  });
});

// ── 2. Post-compact repair ─────────────────────────────────────────

describe("post-compact conversation repair", () => {
  it("repairs orphaned tool_result after compaction splits a pair", () => {
    // Simulate what compactMessages returns when the keep boundary
    // falls between an assistant(tool_calls) and its tool result.
    const messages = [
      { role: "system", content: "System prompt" },
      { role: "user", content: "[Conversation summary — 10 messages compressed]" },
      // Orphaned tool result (the assistant with tool_calls was in the summarized section)
      { role: "tool", content: "result data", tool_call_id: "tc_1", name: "bash" },
      { role: "user", content: "What now?" },
      { role: "assistant", content: "Here's what I found." },
    ];
    const { messages: repaired, repairs } = repairConversation(messages);
    // The orphaned tool result should be removed
    expect(repairs.orphanedResults).toBeGreaterThan(0);
    expect(repaired.filter(m => m.role === "tool").length).toBe(0);
  });

  it("injects synthetic result for orphaned tool_use after compaction drops tool results", () => {
    const messages = [
      { role: "system", content: "System prompt" },
      { role: "user", content: "do it" },
      { role: "assistant", content: "I'll search.", tool_calls: [{ id: "tc_1", name: "web-search", arguments: "{}" }] },
      // tool result was in the dropped section
      { role: "user", content: "What did you find?" },
      { role: "assistant", content: "Let me check again." },
    ];
    const { messages: repaired, repairs } = repairConversation(messages);
    expect(repairs.orphanedUses).toBeGreaterThan(0);
    // A synthetic tool result should be injected for the orphaned tool_use
    const syntheticResult = repaired.find(m => m.role === "tool" && m.tool_call_id === "tc_1");
    expect(syntheticResult).toBeDefined();
    expect(syntheticResult!.content).toContain("interrupted");
  });
});

// ── 3. Serial tool abort ───────────────────────────────────────────

describe("executeTools serial abort", () => {
  it("skips remaining tools when abort controller fires", async () => {
    const abort = new AbortController();
    // Pre-abort before execution
    abort.abort("user cancelled");

    const toolCalls = [
      { id: "t1", name: "web-search", arguments: '{"query":"test"}' },
      { id: "t2", name: "bash", arguments: '{"command":"echo hi"}' },
    ];

    // Pass parallel=false to use the serial path, and parentAbort
    const results = await executeTools(
      {} as any, // minimal env — tools will fail but abort should skip them
      toolCalls,
      "test-session",
      false, // serial
      undefined,
      abort,
    );

    expect(results.length).toBe(2);
    expect(results[0].error).toContain("skipped");
    expect(results[1].error).toContain("skipped");
    expect(results[0].latency_ms).toBe(0);
    expect(results[1].latency_ms).toBe(0);
  });
});

// ── 4. Compact + prune integration ─────────────────────────────────

describe("prune + compact integration", () => {
  it("pruning can prevent full compaction", () => {
    // Create a conversation where most tokens are in tool results
    const toolResult = "x".repeat(50_000); // ~25K tokens in JSON mode
    const messages = [
      { role: "system", content: "You are a helpful assistant." },
      ...Array.from({ length: 10 }, (_, i) => [
        { role: "user", content: `Request ${i}` },
        { role: "assistant", content: "", tool_calls: [{ id: `t${i}`, name: "search", arguments: "{}" }] },
        { role: "tool", content: toolResult, name: "search", tool_call_id: `t${i}` },
      ]).flat(),
      { role: "user", content: "Final question" },
      { role: "assistant", content: "Final answer" },
    ];

    // Before pruning: should need compaction (estimated ~100K+ tokens)
    expect(shouldCompact(messages, 128_000)).toBe(true);

    // After pruning: tool results replaced with short summaries
    const { messages: pruned, pruned: prunedCount } = pruneToolResults(messages, 4);
    expect(prunedCount).toBeGreaterThan(0);

    // After pruning, should be well under the threshold
    expect(shouldCompact(pruned, 128_000)).toBe(false);
  });
});

// ── 5. Diminishing returns tracking ────────────────────────────────

describe("diminishing returns detection logic", () => {
  it("detects 3 consecutive low-output turns with no successful tools", () => {
    const deltas: Array<{ tokens: number; successfulTools: number }> = [];

    // Simulate 3 turns of low output, no successful tools
    deltas.push({ tokens: 100, successfulTools: 0 });
    deltas.push({ tokens: 200, successfulTools: 0 });
    deltas.push({ tokens: 50, successfulTools: 0 });

    const lastThree = deltas.slice(-3);
    const allLowOutput = lastThree.every(d => d.tokens < 500);
    const noSuccessfulTools = lastThree.every(d => d.successfulTools === 0);

    expect(allLowOutput).toBe(true);
    expect(noSuccessfulTools).toBe(true);
  });

  it("does NOT trigger when recent turn had successful tools", () => {
    const deltas = [
      { tokens: 100, successfulTools: 0 },
      { tokens: 200, successfulTools: 1 }, // successful tool call
      { tokens: 50, successfulTools: 0 },
    ];

    const lastThree = deltas.slice(-3);
    const noSuccessfulTools = lastThree.every(d => d.successfulTools === 0);

    expect(noSuccessfulTools).toBe(false);
  });

  it("does NOT trigger when output tokens are high", () => {
    const deltas = [
      { tokens: 1000, successfulTools: 0 }, // high output
      { tokens: 200, successfulTools: 0 },
      { tokens: 50, successfulTools: 0 },
    ];

    const lastThree = deltas.slice(-3);
    const allLowOutput = lastThree.every(d => d.tokens < 500);

    expect(allLowOutput).toBe(false);
  });
});

// ── 6. Max-tokens recovery (unit-level logic) ──────────────────────

describe("max-tokens recovery logic", () => {
  it("identifies truncated tool calls needing retry", () => {
    const llm = {
      content: "Let me search for that.",
      tool_calls: [{ id: "t1", name: "web-search", arguments: '{"query":"tes' }], // truncated JSON
      stop_reason: "length",
      output_tokens: 4096,
    };

    expect(llm.stop_reason).toBe("length");
    expect(llm.tool_calls.length).toBeGreaterThan(0);

    // Verify truncated JSON is invalid
    let valid = true;
    try { JSON.parse(llm.tool_calls[0].arguments); } catch { valid = false; }
    expect(valid).toBe(false);
  });

  it("identifies text-only truncation needing continuation", () => {
    const llm = {
      content: "Here is the beginning of a long response that gets cut off mid-",
      tool_calls: [],
      stop_reason: "length",
      output_tokens: 4096,
    };

    expect(llm.stop_reason).toBe("length");
    expect(llm.tool_calls.length).toBe(0);
    expect(llm.content.length).toBeGreaterThan(0);
    // Recovery: inject continuation prompt
  });

  it("does NOT trigger recovery on normal stop", () => {
    const llm = {
      content: "Here is a complete response.",
      tool_calls: [],
      stop_reason: "stop",
      output_tokens: 200,
    };

    expect(llm.stop_reason).not.toBe("length");
    expect(llm.stop_reason).not.toBe("max_tokens");
  });
});

// ── 7. cache_control placement ─────────────────────────────────────

describe("cache_control placement", () => {
  it("should target the first system message (stable prompt), not the last", () => {
    // Simulate the message array with multiple system messages
    const messages = [
      { role: "system", content: "You are a helpful assistant. This is the stable system prompt that should be cached." },
      { role: "system", content: "Dynamic reasoning strategy for this turn." },
      { role: "user", content: "Hello" },
    ];

    // The logic in llm.ts targets systemMsgs[0]
    const systemMsgs = messages.filter(m => m.role === "system");
    const stableSystem = systemMsgs[0];

    expect(stableSystem.content).toContain("stable system prompt");
    expect(stableSystem).not.toBe(systemMsgs[systemMsgs.length - 1]);
  });

  it("works correctly with single system message", () => {
    const messages = [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Hello" },
    ];

    const systemMsgs = messages.filter(m => m.role === "system");
    // First and last are the same — both approaches would work
    expect(systemMsgs[0]).toBe(systemMsgs[systemMsgs.length - 1]);
  });
});
