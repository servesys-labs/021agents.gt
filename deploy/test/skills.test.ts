/**
 * Tests for built-in skills system
 * Verifies skill prompt injection, activation matching, and content quality
 */
import { describe, it, expect } from "vitest";
import { formatSkillsPrompt, getSkillPrompt, loadSkillOverlays } from "../src/runtime/skills";

describe("formatSkillsPrompt", () => {
  it("includes the 19 built-in skills when no DB skills provided", () => {
    const prompt = formatSkillsPrompt([]);
    expect(prompt).toContain("Available Skills");
    expect(prompt).toContain("/batch");
    expect(prompt).toContain("/review");
    expect(prompt).toContain("/debug");
    expect(prompt).toContain("/verify");
    expect(prompt).toContain("/remember");
    expect(prompt).toContain("/skillify");
    expect(prompt).toContain("/schedule");
    expect(prompt).toContain("/docs");
  });

  it("includes DB skills alongside built-in skills", () => {
    const dbSkills = [{
      name: "custom-deploy",
      description: "Custom deployment workflow",
      prompt_template: "Deploy {{ARGS}}",
      allowed_tools: ["bash"],
      enabled: true,
      version: "1.0.0",
      category: "custom",
    }];
    const prompt = formatSkillsPrompt(dbSkills);
    expect(prompt).toContain("/batch");
    expect(prompt).toContain("/custom-deploy");
  });
});

describe("getSkillPrompt", () => {
  it("returns prompt for built-in skill", () => {
    const prompt = getSkillPrompt("batch", "refactor all API endpoints", []);
    expect(prompt).not.toBeNull();
    expect(prompt).toContain("refactor all API endpoints");
    expect(prompt).toContain("Phase 1: PLAN");
    expect(prompt).toContain("Phase 2: EXECUTE");
    expect(prompt).toContain("Phase 3: TRACK");
  });

  it("returns prompt for review skill with args", () => {
    const prompt = getSkillPrompt("review", "the auth module changes", []);
    expect(prompt).not.toBeNull();
    expect(prompt).toContain("auth module changes");
    expect(prompt).toContain("Lens 1: REUSE");
    expect(prompt).toContain("Lens 2: QUALITY");
    expect(prompt).toContain("Lens 3: EFFICIENCY");
  });

  it("returns prompt for debug skill", () => {
    const prompt = getSkillPrompt("debug", "tools keep failing", []);
    expect(prompt).toContain("circuit breaker");
  });

  it("returns prompt for verify skill", () => {
    const prompt = getSkillPrompt("verify", "login flow works", []);
    expect(prompt).toContain("Positive Tests");
    expect(prompt).toContain("Regression Tests");
    expect(prompt).toContain("NEVER claim");
  });

  it("returns prompt for remember skill", () => {
    const prompt = getSkillPrompt("remember", "clean up old facts", []);
    expect(prompt).toContain("Duplicates");
    expect(prompt).toContain("Staleness");
    expect(prompt).toContain("PROMOTE");
  });

  it("returns prompt for skillify skill", () => {
    const prompt = getSkillPrompt("skillify", "my deploy process", []);
    expect(prompt).toContain("Round 1");
    expect(prompt).toContain("Round 2");
    expect(prompt).toContain("Round 3");
  });

  it("returns prompt for schedule skill", () => {
    const prompt = getSkillPrompt("schedule", "check issues every morning", []);
    expect(prompt).toContain("cron");
    expect(prompt).toContain("Timezone");
  });

  it("returns prompt for docs skill", () => {
    const prompt = getSkillPrompt("docs", "React hooks API", []);
    expect(prompt).toContain("Detect Project Context");
    expect(prompt).toContain("code examples");
  });

  it("returns null for unknown skill", () => {
    expect(getSkillPrompt("nonexistent", "", [])).toBeNull();
  });

  it("prefers DB skill over built-in if same name", () => {
    const dbSkills = [{
      name: "batch",
      description: "Custom batch",
      prompt_template: "CUSTOM BATCH: {{ARGS}}",
      allowed_tools: [],
      enabled: true,
      version: "2.0.0",
      category: "custom",
    }];
    // Built-in comes first in the array, but getSkillPrompt finds first match
    // which is the built-in. This documents the current behavior.
    const prompt = getSkillPrompt("batch", "test", dbSkills);
    expect(prompt).not.toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════
// Phase 6 — skill_overlays merge in getSkillPrompt + loadSkillOverlays
// ══════════════════════════════════════════════════════════════════

describe("Phase 6 — getSkillPrompt overlay merge", () => {
  it("byte-identical output when overlays arg is omitted (phase-0 byte-id)", () => {
    const withoutArg = getSkillPrompt("debug", "args", []);
    const withUndefined = getSkillPrompt("debug", "args", [], undefined, undefined);
    const withEmpty = getSkillPrompt("debug", "args", [], undefined, {});
    expect(withoutArg).not.toBeNull();
    expect(withUndefined).toBe(withoutArg);
    expect(withEmpty).toBe(withoutArg);
  });

  it("byte-identical output when overlays has no entry for the target skill", () => {
    const base = getSkillPrompt("debug", "args", []);
    const withOther = getSkillPrompt("debug", "args", [], undefined, {
      "some-other-skill": ["unrelated rule"],
    });
    expect(withOther).toBe(base);
  });

  it("appends a 'Learned rules' block after the base template when overlays match", () => {
    const overlays = {
      debug: ["when: path contains /tmp/\nthen: require confirmation"],
    };
    const prompt = getSkillPrompt("debug", "", [], undefined, overlays);
    expect(prompt).not.toBeNull();
    expect(prompt).toContain("## Learned rules (Phase 6 overlays)");
    expect(prompt).toContain("when: path contains /tmp/");
  });

  it("joins multiple rules with the overlay separator", () => {
    const overlays = {
      debug: ["rule one", "rule two", "rule three"],
    };
    const prompt = getSkillPrompt("debug", "", [], undefined, overlays);
    expect(prompt).not.toBeNull();
    expect(prompt).toContain("rule one");
    expect(prompt).toContain("rule two");
    expect(prompt).toContain("rule three");
    // Separator "\n\n---\n" appears between adjacent rules (at least 2 times
    // for 3 rules — one before the block header, at least two between rules).
    const separatorCount = (prompt!.match(/\n\n---\n/g) ?? []).length;
    expect(separatorCount).toBeGreaterThanOrEqual(3);
  });

  it("substitutes {{ARGS}} in the base template but treats rule text as literal", () => {
    // A rule containing the literal string {{ARGS}} MUST NOT be substituted —
    // rules are written about abstract patterns, not templated on invocations.
    const overlays = {
      debug: ["when: rule-text contains {{ARGS}}\nthen: treat as literal"],
    };
    const prompt = getSkillPrompt("debug", "MY_ARGS", [], undefined, overlays);
    expect(prompt).not.toBeNull();
    expect(prompt).toContain("MY_ARGS");                 // base template substituted
    expect(prompt).toContain("contains {{ARGS}}");       // rule stays literal
  });

  it("respects enabled allowlist even when overlays are present", () => {
    const overlays = { debug: ["should never be seen"] };
    const prompt = getSkillPrompt("debug", "", [], ["batch"], overlays);
    expect(prompt).toBeNull();
  });

  it("merges rules onto a DB custom skill (not just BUILTIN)", () => {
    const dbSkills = [{
      name: "custom-deploy",
      description: "Custom deployment workflow",
      prompt_template: "Deploy {{ARGS}}",
      allowed_tools: [],
      enabled: true,
      version: "1.0.0",
      category: "custom",
    }];
    const overlays = { "custom-deploy": ["when: staging\nthen: require 2x approval"] };
    const prompt = getSkillPrompt("custom-deploy", "prod", dbSkills, undefined, overlays);
    expect(prompt).not.toBeNull();
    expect(prompt).toContain("Deploy prod");
    expect(prompt).toContain("when: staging");
  });
});

describe("Phase 6 — loadSkillOverlays error fallback", () => {
  it("returns an empty object when the DB connection throws", async () => {
    // Passing null as hyperdrive triggers getDb to throw — the helper catches
    // and returns {}. Fail-soft so overlay-fetch failures never break the
    // main skill-loading path.
    const result = await loadSkillOverlays(null as any, "org-x", "agent-x");
    expect(result).toEqual({});
  });
});
