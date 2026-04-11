/**
 * Regression tests for the content-budget → conversation-repair pipeline.
 *
 * The risk this suite guards against: `applyContentBudget` can slice through
 * an assistant(tool_use)/tool_result pair when it chops off the oldest part
 * of the history to fit the budget. If workflow.ts doesn't run
 * `repairConversation` AFTER the budget, the next LLM call fails with
 * "tool_result without matching tool_use" on every major provider.
 *
 * These tests exercise the EXACT pipeline workflow.ts uses:
 *   repairConversation(messages)  →  applyContentBudget(...)  →  repairConversation(messages)
 * and verify the output is always a structurally valid transcript — no
 * orphaned tool_use, no orphaned tool_result, and no swiss-cheese holes.
 */
import { describe, it, expect } from "vitest";
import { applyContentBudget } from "../src/runtime/query-profile";
import { repairConversation } from "../src/runtime/conversation-repair";

type Msg = {
  role: string;
  content: any;
  tool_calls?: Array<{ id: string; name: string; arguments?: string }>;
  tool_call_id?: string;
  name?: string;
};

function pipeline(messages: Msg[], maxNonSystem: number, maxMessage: number): Msg[] {
  const preRepair = repairConversation(messages).messages;
  const budgeted = applyContentBudget(preRepair as any, maxNonSystem, maxMessage).messages as Msg[];
  return repairConversation(budgeted).messages;
}

function toolUseIds(messages: Msg[]): Set<string> {
  const ids = new Set<string>();
  for (const m of messages) {
    if (m.role === "assistant" && m.tool_calls) {
      for (const tc of m.tool_calls) ids.add(tc.id);
    }
  }
  return ids;
}

function toolResultIds(messages: Msg[]): Set<string> {
  const ids = new Set<string>();
  for (const m of messages) {
    if (m.role === "tool" && m.tool_call_id) ids.add(m.tool_call_id);
  }
  return ids;
}

function assertStructurallyValid(messages: Msg[]) {
  const useIds = toolUseIds(messages);
  const resultIds = toolResultIds(messages);
  // Every tool_use must have a matching tool_result (either original or synthetic)
  for (const id of useIds) {
    expect(resultIds.has(id), `tool_use ${id} has no matching tool_result`).toBe(true);
  }
  // Every tool_result must have a matching tool_use
  for (const id of resultIds) {
    expect(useIds.has(id), `tool_result ${id} has no matching tool_use`).toBe(true);
  }
}

describe("budget+repair integration", () => {
  it("heals an assistant(tool_use) sliced off the history head", () => {
    // Budget will drop the oldest assistant+tool_result pair.
    // Without post-budget repair, the remaining assistant(tool_use) at position
    // 3 would still have its tool_result, but if the budget dropped it we'd
    // be in trouble. We construct a case where the budget does slice through.
    const msgs: Msg[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "u1" },
      { role: "assistant", content: "thinking…".repeat(300), tool_calls: [{ id: "tc_a", name: "bash", arguments: "{}" }] },
      { role: "tool", content: "result A".repeat(200), tool_call_id: "tc_a", name: "bash" },
      { role: "assistant", content: "more work".repeat(300), tool_calls: [{ id: "tc_b", name: "read-file", arguments: "{}" }] },
      { role: "tool", content: "result B".repeat(200), tool_call_id: "tc_b", name: "read-file" },
      { role: "user", content: "follow up" },
    ];
    const out = pipeline(msgs, 4000, 1500);
    assertStructurallyValid(out);
    // The system + the newest user follow-up should always survive
    expect(out.some((m) => m.role === "system")).toBe(true);
    expect(out.some((m) => m.role === "user" && m.content === "follow up")).toBe(true);
  });

  it("injects synthetic results when the budget drops a tool_result mid-pair", () => {
    // If the budget trim somehow leaves the assistant(tool_use) but drops
    // the tool_result (e.g. tool_result was enormous), post-repair must
    // inject a synthetic "[interrupted]" result so the transcript is valid.
    const msgs: Msg[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "u1" },
      { role: "assistant", content: "x", tool_calls: [{ id: "tc_huge", name: "bash", arguments: "{}" }] },
      // Very large tool_result that gets truncated but still counts toward budget
      { role: "tool", content: "r".repeat(50000), tool_call_id: "tc_huge", name: "bash" },
      { role: "assistant", content: "done" },
    ];
    const out = pipeline(msgs, 3000, 1500);
    assertStructurallyValid(out);
  });

  it("strips orphaned tool_results created by dropping their tool_use", () => {
    // Force the budget to drop the oldest assistant(tool_use) while keeping
    // the tool_result further down. Post-budget repair must strip the
    // dangling tool_result.
    const msgs: Msg[] = [
      { role: "system", content: "sys" },
      // Huge assistant that the budget will almost certainly drop
      { role: "assistant", content: "bloat".repeat(500), tool_calls: [{ id: "tc_old", name: "bash", arguments: "{}" }] },
      { role: "tool", content: "ok", tool_call_id: "tc_old", name: "bash" },
      { role: "user", content: "newer" },
      { role: "assistant", content: "newer reply" },
    ];
    const out = pipeline(msgs, 800, 400);
    assertStructurallyValid(out);
    // The orphaned tool_result must not survive into the final transcript
    const dangling = out.find((m) => m.role === "tool" && m.tool_call_id === "tc_old");
    // Either the pair survived together or both are gone; never "result only"
    if (dangling) {
      const hasParent = out.some(
        (m) => m.role === "assistant" && m.tool_calls?.some((tc) => tc.id === "tc_old")
      );
      expect(hasParent).toBe(true);
    }
  });

  it("preserves multi-call tool batches atomically under the budget", () => {
    // An assistant turn can issue multiple tool_calls at once. The repair
    // layer should keep them all together with their matching results.
    const msgs: Msg[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "u" },
      {
        role: "assistant",
        content: "batch",
        tool_calls: [
          { id: "tc_1", name: "grep", arguments: "{}" },
          { id: "tc_2", name: "read-file", arguments: "{}" },
          { id: "tc_3", name: "bash", arguments: "{}" },
        ],
      },
      { role: "tool", content: "g".repeat(500), tool_call_id: "tc_1", name: "grep" },
      { role: "tool", content: "f".repeat(500), tool_call_id: "tc_2", name: "read-file" },
      { role: "tool", content: "b".repeat(500), tool_call_id: "tc_3", name: "bash" },
      { role: "user", content: "next" },
    ];
    const out = pipeline(msgs, 4000, 600);
    assertStructurallyValid(out);
  });

  it("is idempotent — running the pipeline twice doesn't change anything the second time", () => {
    const msgs: Msg[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1", tool_calls: [{ id: "tc_1", name: "bash", arguments: "{}" }] },
      { role: "tool", content: "r1".repeat(300), tool_call_id: "tc_1", name: "bash" },
      { role: "assistant", content: "a2" },
      { role: "user", content: "u2" },
      { role: "assistant", content: "a3" },
    ];
    const once = pipeline(msgs, 2500, 800);
    const twice = pipeline(once, 2500, 800);
    assertStructurallyValid(once);
    assertStructurallyValid(twice);
    expect(twice.length).toBe(once.length);
  });

  it("never produces conversation gaps — kept non-system messages stay contiguous", () => {
    // This is the anti-swiss-cheese guarantee. The old buggy walk could
    // keep msg[0] + msg[3] while dropping msg[1] + msg[2]. The fixed walk
    // produces a contiguous newest-first suffix.
    const msgs: Msg[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
      { role: "assistant", content: "a2" },
      { role: "user", content: "u3" },
      { role: "assistant", content: "a3" },
    ];
    const out = pipeline(msgs, 40, 20); // Very tight budget to force drops
    assertStructurallyValid(out);
    // Find the index of each non-system message in the ORIGINAL order it
    // appeared. The kept ones must form a contiguous suffix.
    const keptContent = out.filter((m) => m.role !== "system").map((m) => m.content);
    const originalContent = msgs.filter((m) => m.role !== "system").map((m) => m.content);
    if (keptContent.length > 0) {
      const firstKeptIdx = originalContent.indexOf(keptContent[0]);
      expect(firstKeptIdx).toBeGreaterThanOrEqual(0);
      // Every kept message must be at index firstKeptIdx + i in the original
      for (let i = 0; i < keptContent.length; i++) {
        expect(originalContent[firstKeptIdx + i]).toBe(keptContent[i]);
      }
    }
  });
});
