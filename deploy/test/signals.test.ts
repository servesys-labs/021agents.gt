import { describe, expect, it } from "vitest";

import {
  buildSignalCoordinatorKey,
  deriveSignalEnvelopes,
  getQueuePayload,
} from "../src/runtime/signals";

describe("signal envelope reduction", () => {
  it("normalizes queue payloads from wrapped and flat message shapes", () => {
    expect(getQueuePayload({
      type: "runtime_event",
      payload: { session_id: "s1", event_type: "tool_exec" },
    })).toEqual({ session_id: "s1", event_type: "tool_exec" });

    expect(getQueuePayload({
      type: "runtime_event",
      session_id: "s2",
      event_type: "tool_exec",
    })).toEqual({ session_id: "s2", event_type: "tool_exec" });
  });

  it("derives tool failure signals from runtime_event payloads", () => {
    const envelopes = deriveSignalEnvelopes("runtime_event", {
      org_id: "org-1",
      agent_name: "personal-agent",
      session_id: "sess-1",
      event_type: "tool_exec",
      status: "error",
      node_id: "browser-open",
      details: { tool: "browser-open", url: "https://acme.dev/bug-report?id=42" },
      created_at: 1_700_000_000_000,
    });

    expect(envelopes).toHaveLength(1);
    expect(envelopes[0].feature).toBe("memory");
    expect(envelopes[0].signal_type).toBe("tool_failure");
    expect(envelopes[0].topic).toContain("acme");
    expect(envelopes[0].signature).toHaveLength(40);
  });

  it("derives contradiction and topic recurrence signals from turns", () => {
    const envelopes = deriveSignalEnvelopes("turn", {
      org_id: "org-1",
      agent_name: "personal-agent",
      session_id: "sess-2",
      turn_number: 3,
      created_at: 1_700_000_100_000,
      llm_content: "Correction: the outage was caused by the billing webhook retry storm in Stripe.",
      tool_calls: JSON.stringify([
        {
          id: "call-1",
          name: "session-search",
          arguments: JSON.stringify({ query: "Stripe billing webhook outage" }),
        },
      ]),
      tool_results: JSON.stringify([]),
    });

    expect(envelopes.some((entry) => entry.signal_type === "memory_contradiction")).toBe(true);
    expect(envelopes.some((entry) => entry.signal_type === "topic_recurrence")).toBe(true);
  });

  it("derives loop-detected signals and deterministic coordinator keys", () => {
    const envelopes = deriveSignalEnvelopes("loop_detected", {
      org_id: "org-1",
      agent_name: "personal-agent",
      session_id: "sess-3",
      tool: "memory-recall",
      repeat_count: 4,
      turn: 6,
      created_at: 1_700_000_200_000,
    });

    expect(envelopes).toHaveLength(1);
    expect(envelopes[0].signal_type).toBe("loop_detected");
    expect(buildSignalCoordinatorKey("memory", "org-1", "personal-agent")).toBe("org-1:personal-agent:memory");
  });
});
