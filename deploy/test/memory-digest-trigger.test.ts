import { describe, it, expect } from "vitest";
import {
  buildMemoryConsolidateParams,
  buildMemoryDigestParams,
  buildPassiveMemoryWorkflowParams,
} from "../src/runtime/memory-digest";

// Feature flag defaults are tested here because the flag gates the trigger in workflow.ts.
// The flag itself lives in features.ts — we import DEFAULTS indirectly by checking the module.
describe("memory agent feature flag", () => {
  it("memory_agent_enabled defaults to true", async () => {
    // Dynamic import to avoid pulling in RuntimeEnv types
    const mod = await import("../src/runtime/features");
    // Without KV, isEnabled returns DEFAULTS[flag].
    const result = await mod.isEnabled({} as any, "memory_agent_enabled", "any-org");
    expect(result).toBe(true);
  });
});

describe("memory digest trigger — buildMemoryDigestParams", () => {
  const SESSION = "abc123";
  const ORG = "org-1";

  it("returns params for a normal agent session", () => {
    const result = buildMemoryDigestParams("my-assistant", SESSION, ORG, 0, true);
    expect(result).not.toBeNull();
    expect(result!.agent_name).toBe("memory-agent");
    expect(result!.input).toContain("session_id=abc123");
    expect(result!.input).toContain("agent_name=my-assistant");
    expect(result!.org_id).toBe(ORG);
    expect(result!.parent_depth).toBe(1);
    expect(result!.channel).toBe("internal");
  });

  it("returns null when agent is memory-agent (infinite loop guard)", () => {
    const result = buildMemoryDigestParams("memory-agent", SESSION, ORG, 0, true);
    expect(result).toBeNull();
  });

  it("returns null when AGENT_RUN_WORKFLOW binding is absent", () => {
    const result = buildMemoryDigestParams("my-assistant", SESSION, ORG, 0, false);
    expect(result).toBeNull();
  });

  it("fires for non-personal agents (global, not personal-only)", () => {
    const result = buildMemoryDigestParams("research-assistant", SESSION, ORG, 0, true);
    expect(result).not.toBeNull();
    expect(result!.input).toContain("agent_name=research-assistant");
  });

  it("increments parent_depth to prevent unbounded delegation", () => {
    const result = buildMemoryDigestParams("my-assistant", SESSION, ORG, 3, true);
    expect(result).not.toBeNull();
    expect(result!.parent_depth).toBe(4);
  });

  it("includes session_id in progress_key for traceability", () => {
    const result = buildMemoryDigestParams("my-assistant", SESSION, ORG, 0, true);
    expect(result).not.toBeNull();
    expect(result!.progress_key).toBe(`memory-digest:${SESSION}`);
  });
});

describe("memory consolidate trigger — buildMemoryConsolidateParams", () => {
  const SESSION = "abc123";
  const ORG = "org-1";

  it("returns params for a normal agent session", () => {
    const result = buildMemoryConsolidateParams("my-assistant", SESSION, ORG, 1, true);
    expect(result).not.toBeNull();
    expect(result!.agent_name).toBe("memory-agent");
    expect(result!.input).toContain("/memory-consolidate");
    expect(result!.input).toContain("session_id=abc123");
    expect(result!.input).toContain("agent_name=my-assistant");
    expect(result!.progress_key).toBe(`memory-consolidate:${SESSION}`);
    expect(result!.parent_depth).toBe(2);
  });

  it("returns null for memory-agent and when workflow binding is absent", () => {
    expect(buildMemoryConsolidateParams("memory-agent", SESSION, ORG, 0, true)).toBeNull();
    expect(buildMemoryConsolidateParams("my-assistant", SESSION, ORG, 0, false)).toBeNull();
  });
});

describe("passive memory signal workflow params", () => {
  it("builds digest params with compressed signal briefing", () => {
    const result = buildPassiveMemoryWorkflowParams(
      "digest",
      "personal-agent",
      "sess-passive",
      "org-1",
      2,
      true,
      {
        signalBriefing: "Recurring billing bug across 4 sessions",
        signalType: "tool_failure",
        signalTopic: "billing bug",
        signalSessionIds: ["sess-passive", "sess-older"],
        signalEntities: ["Stripe", "Billing"],
      },
    );
    expect(result).not.toBeNull();
    expect(result!.input).toContain("/memory-digest");
    expect(result!.input).toContain('signal_briefing="Recurring billing bug across 4 sessions"');
    expect(result!.input).toContain('signal_type="tool_failure"');
    expect(result!.input).toContain('signal_topic="billing bug"');
    expect(result!.input).toContain('signal_session_ids="sess-passive,sess-older"');
    expect(result!.input).toContain('signal_entities="Stripe,Billing"');
    expect(result!.progress_key).toBe("memory-signal-digest:sess-passive");
    expect(result!.parent_depth).toBe(3);
  });

  it("builds consolidate params and keeps memory-agent guard", () => {
    const result = buildPassiveMemoryWorkflowParams(
      "consolidate",
      "personal-agent",
      "sess-passive",
      "org-1",
      0,
      true,
      {
        signalBriefing: "Contradiction churn around refund policy",
        signalType: "memory_contradiction",
        signalTopic: "refund policy",
        signalSessionIds: ["sess-passive"],
        signalEntities: ["Policy"],
      },
    );
    expect(result).not.toBeNull();
    expect(result!.input).toContain("/memory-consolidate");
    expect(buildPassiveMemoryWorkflowParams("digest", "memory-agent", "sess-passive", "org-1", 0, true, {
      signalBriefing: "x",
      signalType: "tool_failure",
      signalTopic: "x",
      signalSessionIds: [],
      signalEntities: [],
    })).toBeNull();
  });
});
