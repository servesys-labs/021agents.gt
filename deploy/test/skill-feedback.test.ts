/**
 * Phase 6.5 — unit tests for the auto-fire detector.
 *
 * Pure-function coverage of detectEvolveFeedback (threshold, PII scrub,
 * session ID drop, originating-agent injection) plus fireSkillFeedback's
 * fire-and-forget semantics against a spy fetcher.
 *
 * The critical overlay-scope correctness test (appendRule with
 * agentName="" → loadSkillOverlays under a different agent) lives in
 * skill-learning-loop.test.ts because that file already owns the
 * cross-workspace round-trip mock.
 */

import { describe, it, expect } from "vitest";

import {
  detectEvolveFeedback,
  fireSkillFeedback,
  type RuleProposal,
} from "../src/runtime/skill-feedback";

describe("detectEvolveFeedback — threshold filter", () => {
  it("returns one proposal per cluster with count >= 3", () => {
    const report = {
      failure_clusters: [
        { pattern: "tool:web-search", count: 5, severity: 0.8, example_errors: [], affected_sessions: [] },
        { pattern: "llm:rate_limit", count: 3, severity: 0.4, example_errors: [], affected_sessions: [] },
        { pattern: "governance:budget", count: 2, severity: 0.2, example_errors: [], affected_sessions: [] },
      ],
    };
    const proposals = detectEvolveFeedback(report, "foo-bot");
    expect(proposals).toHaveLength(2);
    expect(proposals[0].ruleText).toContain("tool:web-search");
    expect(proposals[0].ruleText).toContain("5 recent");
    expect(proposals[1].ruleText).toContain("llm:rate_limit");
    expect(proposals[1].ruleText).toContain("3 recent");
  });

  it("returns empty array when no cluster meets the threshold", () => {
    const report = {
      failure_clusters: [
        { pattern: "x", count: 1, example_errors: [] },
        { pattern: "y", count: 2, example_errors: [] },
      ],
    };
    expect(detectEvolveFeedback(report, "foo-bot")).toHaveLength(0);
  });

  it("handles null/undefined report without throwing", () => {
    expect(detectEvolveFeedback(null, "foo-bot")).toHaveLength(0);
    expect(detectEvolveFeedback(undefined, "foo-bot")).toHaveLength(0);
    expect(detectEvolveFeedback({}, "foo-bot")).toHaveLength(0);
    expect(detectEvolveFeedback({ failure_clusters: [] }, "foo-bot")).toHaveLength(0);
  });

  it("skips clusters with missing or empty pattern", () => {
    const report = {
      failure_clusters: [
        { pattern: "", count: 5, example_errors: [] },
        { pattern: "valid-pattern", count: 5, example_errors: [] },
      ],
    };
    const proposals = detectEvolveFeedback(report, "foo-bot");
    expect(proposals).toHaveLength(1);
    expect(proposals[0].ruleText).toContain("valid-pattern");
  });
});

describe("detectEvolveFeedback — always targets improve skill", () => {
  it("sets skillName to 'improve' regardless of cluster pattern", () => {
    const report = {
      failure_clusters: [
        { pattern: "tool:web-search", count: 4, example_errors: [] },
      ],
    };
    const [p] = detectEvolveFeedback(report, "foo-bot");
    expect(p.skillName).toBe("improve");
  });

  it("sets source to 'auto-fire:evolve'", () => {
    const [p] = detectEvolveFeedback(
      { failure_clusters: [{ pattern: "x", count: 3, example_errors: [] }] },
      "foo-bot",
    );
    expect(p.source).toBe("auto-fire:evolve");
  });

  it("embeds the pattern, count, and severity in the reason field", () => {
    const [p] = detectEvolveFeedback(
      { failure_clusters: [{ pattern: "tool:db", count: 7, severity: 0.9, example_errors: [] }] },
      "foo-bot",
    );
    expect(p.reason).toContain("pattern=tool:db");
    expect(p.reason).toContain("count=7");
    expect(p.reason).toContain("severity=0.9");
    expect(p.reason).toContain("agent=foo-bot");
  });
});

describe("detectEvolveFeedback — originating agent in text and reason", () => {
  it("embeds originatingAgent in both ruleText and reason", () => {
    const [p] = detectEvolveFeedback(
      { failure_clusters: [{ pattern: "x", count: 3, example_errors: [] }] },
      "research-bot-v2",
    );
    expect(p.ruleText).toContain("research-bot-v2");
    expect(p.reason).toContain("agent=research-bot-v2");
  });

  it("clamps long agent names to 60 chars to keep rule text compact", () => {
    const longName = "a".repeat(200);
    const [p] = detectEvolveFeedback(
      { failure_clusters: [{ pattern: "x", count: 3, example_errors: [] }] },
      longName,
    );
    // agent name slice(0, 60) — rule text and reason should both reference
    // the truncated version, not the 200-char original.
    const expected = "a".repeat(60);
    expect(p.ruleText).toContain(expected);
    expect(p.ruleText).not.toContain("a".repeat(61));
  });

  it("falls back to 'unknown' when originatingAgent is empty", () => {
    const [p] = detectEvolveFeedback(
      { failure_clusters: [{ pattern: "x", count: 3, example_errors: [] }] },
      "",
    );
    expect(p.ruleText).toContain("'unknown'");
  });
});

describe("detectEvolveFeedback — PII scrub and truncation", () => {
  it("redacts OpenAI-style keys in example_errors", () => {
    const [p] = detectEvolveFeedback(
      {
        failure_clusters: [{
          pattern: "tool:web-search",
          count: 4,
          example_errors: ["auth failed with key sk-abc123def456ghi789jkl000"],
        }],
      },
      "foo-bot",
    );
    expect(p.ruleText).toContain("[REDACTED]");
    expect(p.ruleText).not.toContain("sk-abc123");
  });

  it("redacts Anthropic sk-ant keys", () => {
    const [p] = detectEvolveFeedback(
      {
        failure_clusters: [{
          pattern: "llm:auth",
          count: 3,
          example_errors: ["API key sk-ant-api03-abcdef1234567890"],
        }],
      },
      "foo-bot",
    );
    expect(p.ruleText).toContain("[REDACTED]");
    expect(p.ruleText).not.toContain("sk-ant-api03");
  });

  it("redacts Bearer tokens", () => {
    const [p] = detectEvolveFeedback(
      {
        failure_clusters: [{
          pattern: "llm:auth",
          count: 3,
          example_errors: ["Bearer abcdefghij1234567890 rejected"],
        }],
      },
      "foo-bot",
    );
    expect(p.ruleText).toContain("[REDACTED]");
    expect(p.ruleText).not.toContain("abcdefghij1234567890");
  });

  it("redacts email addresses", () => {
    const [p] = detectEvolveFeedback(
      {
        failure_clusters: [{
          pattern: "tool:email",
          count: 3,
          example_errors: ["failed to send to alice@example.com"],
        }],
      },
      "foo-bot",
    );
    expect(p.ruleText).not.toContain("alice@example.com");
    expect(p.ruleText).toContain("[REDACTED]");
  });

  it("truncates example_errors longer than 120 chars", () => {
    const long = "x".repeat(500);
    const [p] = detectEvolveFeedback(
      {
        failure_clusters: [{
          pattern: "tool:long",
          count: 3,
          example_errors: [long],
        }],
      },
      "foo-bot",
    );
    expect(p.ruleText).toContain("…");
    expect(p.ruleText).not.toContain("x".repeat(150));
  });

  it("only includes up to 2 example_errors per cluster", () => {
    const [p] = detectEvolveFeedback(
      {
        failure_clusters: [{
          pattern: "tool:many",
          count: 3,
          example_errors: ["err-one", "err-two", "err-three", "err-four"],
        }],
      },
      "foo-bot",
    );
    expect(p.ruleText).toContain("err-one");
    expect(p.ruleText).toContain("err-two");
    expect(p.ruleText).not.toContain("err-three");
    expect(p.ruleText).not.toContain("err-four");
  });
});

describe("detectEvolveFeedback — session IDs intentionally dropped", () => {
  it("does not include affected_sessions in the rule text", () => {
    const [p] = detectEvolveFeedback(
      {
        failure_clusters: [{
          pattern: "tool:db",
          count: 3,
          example_errors: [],
          affected_sessions: ["sess-abc123", "sess-def456", "sess-ghi789"],
        }],
      },
      "foo-bot",
    );
    expect(p.ruleText).not.toContain("sess-abc123");
    expect(p.ruleText).not.toContain("sess-def456");
    expect(p.ruleText).not.toContain("sess-ghi789");
  });

  it("does not include affected_sessions in the reason field either", () => {
    const [p] = detectEvolveFeedback(
      {
        failure_clusters: [{
          pattern: "tool:db",
          count: 3,
          example_errors: [],
          affected_sessions: ["sess-xxx", "sess-yyy"],
        }],
      },
      "foo-bot",
    );
    expect(p.reason).not.toContain("sess-xxx");
    expect(p.reason).not.toContain("sess-yyy");
  });
});

describe("fireSkillFeedback — service-binding POST semantics", () => {
  it("no-ops on empty proposal array without touching fetch", async () => {
    let called = 0;
    const env = {
      CONTROL_PLANE: {
        fetch: async () => {
          called++;
          return new Response(null, { status: 200 });
        },
      },
      SERVICE_TOKEN: "test-token",
    };
    await fireSkillFeedback(env, { orgId: "org-x" }, []);
    expect(called).toBe(0);
  });

  it("logs and returns when CONTROL_PLANE binding is missing", async () => {
    await expect(
      fireSkillFeedback({ SERVICE_TOKEN: "t" }, { orgId: "org-x" }, [fakeProposal()]),
    ).resolves.toBeUndefined();
  });

  it("logs and returns when SERVICE_TOKEN is missing", async () => {
    let called = 0;
    const env = {
      CONTROL_PLANE: {
        fetch: async () => {
          called++;
          return new Response(null, { status: 200 });
        },
      },
    };
    await fireSkillFeedback(env, { orgId: "org-x" }, [fakeProposal()]);
    expect(called).toBe(0);
  });

  it("POSTs each proposal sequentially with correct headers and body shape", async () => {
    const captured: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
    const env = {
      CONTROL_PLANE: {
        fetch: async (url: string, init: any) => {
          captured.push({
            url,
            headers: init.headers,
            body: JSON.parse(init.body),
          });
          return new Response(JSON.stringify({ appended: true }), { status: 200 });
        },
      },
      SERVICE_TOKEN: "test-token-123",
    };
    const proposals: RuleProposal[] = [
      { skillName: "improve", ruleText: "rule A", source: "auto-fire:evolve", reason: "r=a" },
      { skillName: "improve", ruleText: "rule B", source: "auto-fire:evolve", reason: "r=b" },
    ];
    await fireSkillFeedback(env, { orgId: "org-42" }, proposals);
    expect(captured).toHaveLength(2);
    expect(captured[0].url).toContain("/api/v1/admin/skills/append-rule");
    expect(captured[0].headers["Authorization"]).toBe("Bearer test-token-123");
    expect(captured[0].headers["X-Org-Id"]).toBe("org-42");
    expect(captured[0].body).toEqual({
      skill_name: "improve",
      rule_text: "rule A",
      source: "auto-fire:evolve",
      reason: "r=a",
    });
    expect(captured[1].body.rule_text).toBe("rule B");
  });

  it("fail-open: non-200 response is logged, does not throw", async () => {
    const env = {
      CONTROL_PLANE: {
        fetch: async () =>
          new Response(JSON.stringify({ error: "rate_limited" }), { status: 429 }),
      },
      SERVICE_TOKEN: "t",
    };
    await expect(
      fireSkillFeedback(env, { orgId: "o" }, [fakeProposal()]),
    ).resolves.toBeUndefined();
  });

  it("fail-open: fetch throw is logged, does not throw", async () => {
    const env = {
      CONTROL_PLANE: {
        fetch: async () => {
          throw new Error("network down");
        },
      },
      SERVICE_TOKEN: "t",
    };
    await expect(
      fireSkillFeedback(env, { orgId: "o" }, [fakeProposal()]),
    ).resolves.toBeUndefined();
  });

  it("continues firing remaining proposals after one fails", async () => {
    let callCount = 0;
    const env = {
      CONTROL_PLANE: {
        fetch: async () => {
          callCount++;
          if (callCount === 1) throw new Error("first fails");
          return new Response(JSON.stringify({ appended: true }), { status: 200 });
        },
      },
      SERVICE_TOKEN: "t",
    };
    await fireSkillFeedback(env, { orgId: "o" }, [fakeProposal(), fakeProposal(), fakeProposal()]);
    // All three attempted even though the first threw — detector is
    // best-effort, one broken proposal must not block the others.
    expect(callCount).toBe(3);
  });
});

function fakeProposal(): RuleProposal {
  return {
    skillName: "improve",
    ruleText: "test rule",
    source: "auto-fire:evolve",
    reason: "test",
  };
}
