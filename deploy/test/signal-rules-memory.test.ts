import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

import {
  cooldownKey,
  evaluateMemorySignalRules,
  summarizeMemoryCluster,
} from "../src/runtime/signal-rules-memory";
import type { SignalEnvelope } from "../src/runtime/signals";

const NOW = 1_700_000_000_000;

function makeEnvelope(overrides: Partial<SignalEnvelope> = {}): SignalEnvelope {
  return {
    id: overrides.id || randomUUID(),
    feature: "memory",
    signal_type: overrides.signal_type || "tool_failure",
    source_type: overrides.source_type || "runtime_event",
    org_id: overrides.org_id || "org-1",
    agent_name: overrides.agent_name || "personal-agent",
    session_id: overrides.session_id || "sess-1",
    created_at_ms: overrides.created_at_ms || NOW,
    signature: overrides.signature || "sig-tool",
    topic: overrides.topic || "billing outage",
    summary: overrides.summary || "Repeated billing outage failures",
    severity: overrides.severity ?? 0.8,
    entities: overrides.entities || ["Stripe"],
    metadata: overrides.metadata || {},
  };
}

describe("memory signal rules", () => {
  it("summarizes envelopes into exact cluster counts and sessions", () => {
    const cluster = summarizeMemoryCluster([
      makeEnvelope({ session_id: "s1", created_at_ms: NOW - 1000 }),
      makeEnvelope({ session_id: "s2", created_at_ms: NOW }),
      makeEnvelope({ session_id: "s2", created_at_ms: NOW + 1000 }),
    ]);

    expect(cluster).not.toBeNull();
    expect(cluster!.count).toBe(3);
    expect(cluster!.distinct_sessions).toBe(2);
    expect(cluster!.entities).toContain("Stripe");
  });

  it("fires digest for repeated tool failures and consolidate for contradictions", () => {
    const actions = evaluateMemorySignalRules({
      nowMs: NOW,
      activeCooldowns: new Set(),
      clusters: [
        {
          feature: "memory",
          signature: "sig-tool",
          signal_type: "tool_failure",
          topic: "billing outage",
          count: 3,
          distinct_sessions: 3,
          first_seen_ms: NOW - 5_000,
          last_seen_ms: NOW - 100,
          max_severity: 0.9,
          sample_summaries: ["failure 1"],
          entities: ["Stripe"],
        },
        {
          feature: "memory",
          signature: "sig-contradiction",
          signal_type: "memory_contradiction",
          topic: "refund policy",
          count: 2,
          distinct_sessions: 2,
          first_seen_ms: NOW - 8_000,
          last_seen_ms: NOW - 100,
          max_severity: 0.7,
          sample_summaries: ["contradiction 1"],
          entities: ["Policy"],
        },
      ],
    });

    expect(actions.map((action) => action.workflow_kind)).toEqual(["digest", "consolidate"]);
    expect(actions[0].briefing).toContain("Repeated tool failures");
    expect(actions[1].briefing).toContain("corrections");
  });

  it("leaves cooldown suppression to the coordinator DO", () => {
    const dedupe = cooldownKey("tool_failure", "sig-tool");
    const actions = evaluateMemorySignalRules({
      nowMs: NOW,
      activeCooldowns: new Set([dedupe]),
      clusters: [
        {
          feature: "memory",
          signature: "sig-tool",
          signal_type: "tool_failure",
          topic: "billing outage",
          count: 5,
          distinct_sessions: 4,
          first_seen_ms: NOW - 10_000,
          last_seen_ms: NOW - 100,
          max_severity: 0.9,
          sample_summaries: [],
          entities: [],
        },
      ],
    });

    expect(actions).toHaveLength(1);
    expect(actions[0].dedupe_key).toBe(dedupe);
  });
});
