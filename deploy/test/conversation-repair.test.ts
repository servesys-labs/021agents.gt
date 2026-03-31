/**
 * Tests for deploy/src/runtime/conversation-repair.ts
 * Phase 9.1: Tool use/result pairing validation & repair
 */
import { describe, it, expect } from "vitest";
import { repairConversation } from "../src/runtime/conversation-repair";

describe("repairConversation", () => {
  it("returns clean messages unchanged", () => {
    const messages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi!", tool_calls: [{ id: "tc1", name: "grep", arguments: "{}" }] },
      { role: "tool", content: "result", tool_call_id: "tc1", name: "grep" },
    ];
    const { messages: repaired, repairs } = repairConversation(messages);
    expect(repairs.orphanedUses).toBe(0);
    expect(repairs.orphanedResults).toBe(0);
    expect(repairs.duplicateIds).toBe(0);
    expect(repairs.emptyResults).toBe(0);
    expect(repaired.length).toBe(3);
  });

  it("injects synthetic result for orphaned tool_use", () => {
    const messages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "", tool_calls: [{ id: "tc1", name: "bash", arguments: "{}" }] },
      // Missing tool result for tc1!
    ];
    const { messages: repaired, repairs } = repairConversation(messages);
    expect(repairs.orphanedUses).toBe(1);
    const synthetic = repaired.find(m => m.role === "tool" && m.tool_call_id === "tc1");
    expect(synthetic).toBeDefined();
    expect(synthetic!.content).toContain("interrupted");
  });

  it("strips orphaned tool_results (result without matching call)", () => {
    const messages = [
      { role: "user", content: "Hello" },
      { role: "tool", content: "stale result", tool_call_id: "tc_nonexistent", name: "grep" },
      { role: "assistant", content: "OK" },
    ];
    const { messages: repaired, repairs } = repairConversation(messages);
    expect(repairs.orphanedResults).toBe(1);
    expect(repaired.some(m => m.tool_call_id === "tc_nonexistent")).toBe(false);
  });

  it("deduplicates tool_call IDs across messages", () => {
    const messages = [
      { role: "assistant", content: "", tool_calls: [{ id: "dup1", name: "grep", arguments: "{}" }] },
      { role: "tool", content: "r1", tool_call_id: "dup1", name: "grep" },
      { role: "assistant", content: "", tool_calls: [{ id: "dup1", name: "bash", arguments: "{}" }] },
      { role: "tool", content: "r2", tool_call_id: "dup1", name: "bash" },
    ];
    const { repairs } = repairConversation(messages);
    expect(repairs.duplicateIds).toBe(1);
  });

  it("guards empty tool results with descriptive placeholder", () => {
    const messages = [
      { role: "assistant", content: "", tool_calls: [{ id: "tc1", name: "grep", arguments: "{}" }] },
      { role: "tool", content: "", tool_call_id: "tc1", name: "grep" },
    ];
    const { messages: repaired, repairs } = repairConversation(messages);
    expect(repairs.emptyResults).toBe(1);
    const toolMsg = repaired.find(m => m.role === "tool");
    expect(toolMsg!.content).toContain("completed with no output");
  });

  it("guards whitespace-only tool results", () => {
    const messages = [
      { role: "assistant", content: "", tool_calls: [{ id: "tc1", name: "bash", arguments: "{}" }] },
      { role: "tool", content: "   \n  ", tool_call_id: "tc1", name: "bash" },
    ];
    const { messages: repaired, repairs } = repairConversation(messages);
    expect(repairs.emptyResults).toBe(1);
    expect(repaired.find(m => m.role === "tool")!.content).toContain("completed with no output");
  });

  it("handles multiple orphaned uses at once", () => {
    const messages = [
      { role: "assistant", content: "", tool_calls: [
        { id: "tc1", name: "grep", arguments: "{}" },
        { id: "tc2", name: "bash", arguments: "{}" },
        { id: "tc3", name: "read-file", arguments: "{}" },
      ]},
      // Only tc1 has a result
      { role: "tool", content: "found", tool_call_id: "tc1", name: "grep" },
    ];
    const { messages: repaired, repairs } = repairConversation(messages);
    expect(repairs.orphanedUses).toBe(2);
    expect(repaired.filter(m => m.role === "tool").length).toBe(3);
  });
});
