/**
 * Phase 3 hygiene invariants.
 *
 * Guards the post-Phase-3 state where BUILTIN_SKILLS is a derived view over
 * skills/public/<name>/SKILL.md files on disk. These tests catch failure modes
 * that Phase 0's hash/snapshot guards don't: a SKILL.md added to disk but
 * never wired into BUILTIN_SKILL_ORDER, or a malformed SKILL.md that the
 * bundler should refuse.
 */

import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BUILTIN_SKILLS } from "../src/runtime/skills";
// @ts-expect-error — bundle-skills.mjs is ESM JS without type declarations.
import { parseSkillMd } from "../scripts/bundle-skills.mjs";

const REPO_ROOT = join(__dirname, "..", "..");
const SKILLS_ROOT = join(REPO_ROOT, "skills", "public");

// Skills that live in skills/public/ but are intentionally NOT in
// BUILTIN_SKILL_ORDER — they're DB-seeded, example fixtures, or opt-in
// meta-skills activated via enabled_skills on specific agents. Keep this
// list deliberately tight so that a forgotten wiring (P3-F2 failure)
// surfaces here.
//
// diarize (Phase 6): cross-source profile synthesis, invoked explicitly by
//   /improve and by meta-agent workflows — never auto-surfaced in the
//   default prompt, so it stays out of BUILTIN_SKILL_ORDER.
// improve (Phase 6): reads feedback and proposes rules via manage_skills
//   append_rule. Also meta-only — invoked deliberately by owners/admins,
//   never auto-triggered.
const NON_BUILTIN_ALLOWLIST = new Set([
  "code-review", "deep-research", "diarize", "improve",
  "memory-digest", "memory-consolidate", "memory-recall-deep",
]);

describe("Phase 3 — SKILL.md directory invariants", () => {
  it("every SKILL.md on disk is wired into BUILTIN_SKILLS or explicitly allowlisted", () => {
    const dirs = readdirSync(SKILLS_ROOT, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    const builtinNames = new Set(BUILTIN_SKILLS.map((s) => s.name));
    const orphans = dirs.filter(
      (name) => !builtinNames.has(name) && !NON_BUILTIN_ALLOWLIST.has(name),
    );
    expect(
      orphans,
      `Orphan SKILL.md directories: ${orphans.join(", ")}. Add each to BUILTIN_SKILL_ORDER in src/runtime/skills.ts, or to NON_BUILTIN_ALLOWLIST if it is intentionally DB-only.`,
    ).toEqual([]);
  });
});

describe("Phase 3 — bundler parseSkillMd required-field validation", () => {
  let tmpDir: string;

  function writeTmp(name: string, content: string): string {
    const path = join(tmpDir, name);
    writeFileSync(path, content, "utf8");
    return path;
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "bundle-skills-test-"));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("rejects a SKILL.md with no frontmatter", () => {
    const path = writeTmp("no-frontmatter.md", "just a body, no ---\n");
    expect(() => parseSkillMd(path)).toThrow(/missing YAML frontmatter/);
  });

  it("rejects a SKILL.md with frontmatter but no name field", () => {
    const path = writeTmp(
      "no-name.md",
      "---\ndescription: missing name field\n---\nbody\n",
    );
    expect(() => parseSkillMd(path)).toThrow(/missing 'name'/);
  });

  it("accepts a minimal valid SKILL.md and trims exactly one trailing newline", () => {
    const path = writeTmp(
      "ok.md",
      `---\nname: demo\ndescription: demo skill\n---\nhello world\n`,
    );
    const skill = parseSkillMd(path);
    expect(skill.name).toBe("demo");
    expect(skill.description).toBe("demo skill");
    expect(skill.prompt_template).toBe("hello world");
  });
});

