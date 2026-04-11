/**
 * Phase 4 — enabled_skills allowlist filter.
 *
 * Guards the agent-level allowlist behavior added in Phase 4:
 *   - formatSkillsPrompt with an empty/undefined `enabled` arg is
 *     byte-identical to Phase 0 (covered by refactor-phase0 snapshots —
 *     this file just re-asserts the contract).
 *   - formatSkillsPrompt with a non-empty `enabled` returns only the
 *     listed skills, in original BUILTIN_SKILL_ORDER.
 *   - getSkillPrompt with a non-empty `enabled` rejects activation of
 *     skills not in the allowlist, even if they exist in BUILTIN_SKILLS.
 *   - Empty list is treated as "all" (backward compat), matching
 *     formatSkillsPrompt's behavior.
 */

import { describe, it, expect } from "vitest";

import {
  formatSkillsPrompt,
  getSkillPrompt,
  BUILTIN_SKILLS,
} from "../src/runtime/skills";

describe("Phase 4 — formatSkillsPrompt enabled_skills filter", () => {
  it("undefined enabled = all skills (backward-compatible)", () => {
    const out = formatSkillsPrompt([], "standard");
    for (const s of BUILTIN_SKILLS) {
      expect(out).toContain(`/${s.name}`);
    }
  });

  it("empty enabled = all skills (backward-compatible)", () => {
    const out = formatSkillsPrompt([], "standard", []);
    for (const s of BUILTIN_SKILLS) {
      expect(out).toContain(`/${s.name}`);
    }
  });

  it("single-name enabled = only that skill", () => {
    const out = formatSkillsPrompt([], "standard", ["batch"]);
    expect(out).toContain("/batch");
    expect(out).not.toContain("/review");
    expect(out).not.toContain("/pdf");
    expect(out).not.toContain("/docs");
  });

  it("multi-name enabled = only those skills", () => {
    const out = formatSkillsPrompt([], "standard", ["pdf", "review"]);
    expect(out).toContain("/pdf");
    expect(out).toContain("/review");
    expect(out).not.toContain("/batch");
    expect(out).not.toContain("/debug");
  });

  it("unknown name in enabled = filtered to empty, returns empty string", () => {
    const out = formatSkillsPrompt([], "standard", ["not-a-real-skill"]);
    expect(out).toBe("");
  });

  it("enabled order does NOT change output order (insertion-order stable)", () => {
    // Passing pdf first should NOT make pdf appear before review;
    // BUILTIN_SKILL_ORDER has review at index 1 and pdf at index 12.
    const out = formatSkillsPrompt([], "standard", ["pdf", "review"]);
    const pdfIdx = out.indexOf("/pdf ");
    const reviewIdx = out.indexOf("/review ");
    expect(pdfIdx).toBeGreaterThan(-1);
    expect(reviewIdx).toBeGreaterThan(-1);
    expect(reviewIdx).toBeLessThan(pdfIdx);
  });
});

describe("Phase 4 — getSkillPrompt enabled_skills allowlist enforcement", () => {
  it("undefined enabled = all skills resolvable (backward-compatible)", () => {
    expect(getSkillPrompt("batch", "args", [])).not.toBeNull();
    expect(getSkillPrompt("pdf", "args", [])).not.toBeNull();
  });

  it("empty enabled = all skills resolvable (backward-compatible)", () => {
    expect(getSkillPrompt("batch", "args", [], [])).not.toBeNull();
  });

  it("skill in enabled list = resolves", () => {
    expect(getSkillPrompt("pdf", "args", [], ["pdf"])).not.toBeNull();
  });

  it("skill NOT in enabled list = null (blocked activation)", () => {
    expect(getSkillPrompt("pdf", "args", [], ["batch"])).toBeNull();
    expect(getSkillPrompt("review", "args", [], ["batch", "pdf"])).toBeNull();
  });

  it("unknown skill in enabled list = still null (guard is name-based)", () => {
    expect(getSkillPrompt("not-a-real-skill", "args", [], ["not-a-real-skill"])).toBeNull();
  });
});
