/**
 * Phase 0 — Thin Harness / Fat Skills refactor drift guards.
 *
 * This file is the single source of truth for the refactor's correctness gates.
 * It captures the baseline state of three things that later phases must not
 * accidentally drift:
 *
 *   1. Skill body bytes — golden SHA-256 per BUILTIN_SKILL. Extracting a skill
 *      to SKILL.md must reproduce the same hash, or the markdown is wrong.
 *
 *   2. Skills-prompt snapshot — the concatenated string produced by
 *      formatSkillsPrompt() is what actually reaches the model. Any byte
 *      drift in the loader logic or skill order fails this snapshot.
 *
 *   3. LoC + prompt-size budgets — ceilings on files being actively shrunk
 *      (skills.ts, tools.ts, meta-agent-chat.ts, latent-logic TS files).
 *      CI fails if a file exceeds its current ceiling.
 *
 * ## How to update fixtures intentionally
 *
 *   WRITE_SKILL_HASHES=1   pnpm vitest run test/refactor-phase0.test.ts
 *   WRITE_LOC_BUDGET=1     pnpm vitest run test/refactor-phase0.test.ts
 *   WRITE_PROMPT_BUDGET=1  pnpm vitest run test/refactor-phase0.test.ts
 *
 * Each env flag seeds its fixture and skips the assertion. Commit the updated
 * fixture in the same PR that made the legitimate change, with a
 * `-fixture-bump` label in the commit message for auditability.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

import { BUILTIN_SKILLS, formatSkillsPrompt } from "../src/runtime/skills";

const FIXTURES_DIR = join(__dirname, "fixtures");
const DEPLOY_ROOT = join(__dirname, "..");
const REPO_ROOT = join(DEPLOY_ROOT, "..");

// meta-agent-chat.ts lives in the control-plane workspace, which deploy's
// tsconfig doesn't include. For drift detection we measure its size as raw
// text — any content change (good or bad) shows up in the char count, and
// this avoids a cross-workspace TS import.
const META_AGENT_CHAT_PATH = join(
  REPO_ROOT,
  "control-plane/src/prompts/meta-agent-chat.ts",
);

function hashSkill(s: {
  name: string;
  description: string;
  when_to_use?: string;
  prompt_template: string;
}): string {
  const payload = [
    s.name,
    s.description,
    s.when_to_use ?? "",
    s.prompt_template,
  ].join("|");
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

function countLines(relPath: string): number {
  const abs = join(DEPLOY_ROOT, relPath);
  const content = readFileSync(abs, "utf8");
  return content.split("\n").length;
}

describe("refactor Phase 0 — skill body golden hashes", () => {
  const fixturePath = join(FIXTURES_DIR, "skill_hashes.json");

  it("BUILTIN_SKILLS array exists and is non-empty", () => {
    expect(Array.isArray(BUILTIN_SKILLS)).toBe(true);
    expect(BUILTIN_SKILLS.length).toBeGreaterThan(0);
  });

  it("computed hashes match committed fixture (or seeds if WRITE_SKILL_HASHES=1)", () => {
    const computed: Record<string, string> = {};
    for (const s of BUILTIN_SKILLS) {
      computed[s.name] = hashSkill(s);
    }

    if (process.env.WRITE_SKILL_HASHES === "1") {
      const existing = JSON.parse(readFileSync(fixturePath, "utf8"));
      existing.hashes = computed;
      existing._seeded_at = new Date().toISOString();
      existing._skill_count = BUILTIN_SKILLS.length;
      writeFileSync(fixturePath, JSON.stringify(existing, null, 2) + "\n");
      console.log(
        `[seed] wrote ${Object.keys(computed).length} hashes to ${fixturePath}`,
      );
      return;
    }

    const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
    const expected = fixture.hashes as Record<string, string>;

    // Catch missing / extra skills loudly before diffing individual bytes.
    expect(Object.keys(computed).sort()).toEqual(Object.keys(expected).sort());

    for (const name of Object.keys(computed)) {
      expect(
        computed[name],
        `Skill "${name}" body drifted. If intentional, rerun with WRITE_SKILL_HASHES=1 and commit with -fixture-bump label.`,
      ).toBe(expected[name]);
    }
  });
});

describe("refactor Phase 0 — formatSkillsPrompt output snapshot", () => {
  // The string that reaches the model is what we care about. By passing an
  // empty DB-skills array, we isolate BUILTIN_SKILLS contribution. Any drift
  // in skill order, description, when_to_use, or formatting logic fails.

  it("basic plan output is stable", () => {
    const out = formatSkillsPrompt([], "basic");
    expect(out).toMatchSnapshot();
  });

  it("standard plan output is stable", () => {
    const out = formatSkillsPrompt([], "standard");
    expect(out).toMatchSnapshot();
  });

  it("premium plan output is stable", () => {
    const out = formatSkillsPrompt([], "premium");
    expect(out).toMatchSnapshot();
  });
});

describe("refactor Phase 0 — LoC budgets", () => {
  const fixturePath = join(FIXTURES_DIR, "loc_budget.json");

  it("tracked files stay within ceilings (or seeds if WRITE_LOC_BUDGET=1)", () => {
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
    const ceilings = fixture.ceilings as Record<string, number>;
    const measured: Record<string, number> = {};

    for (const path of Object.keys(ceilings)) {
      measured[path] = countLines(path);
    }

    if (process.env.WRITE_LOC_BUDGET === "1") {
      fixture.ceilings = measured;
      fixture._seeded_at = new Date().toISOString();
      writeFileSync(fixturePath, JSON.stringify(fixture, null, 2) + "\n");
      console.log(`[seed] wrote LoC ceilings to ${fixturePath}`);
      return;
    }

    for (const path of Object.keys(ceilings)) {
      expect(
        measured[path],
        `${path} grew past its ceiling (${ceilings[path]} → ${measured[path]}). The refactor only shrinks these files. If this growth is legitimate, raise the ceiling in loc_budget.json with a -fixture-bump label.`,
      ).toBeLessThanOrEqual(ceilings[path]);
    }
  });
});

describe("refactor Phase 0 — meta-agent prompt size budget", () => {
  const fixturePath = join(FIXTURES_DIR, "prompt_budget.json");

  it("meta-agent-chat.ts file size stays within ceiling", () => {
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
    const ceilings = fixture.ceilings_chars as Record<string, number>;

    // Measure the whole source file. This is a superset of the prompt string
    // itself (includes imports, helper exports, mode instructions), but for
    // drift detection the ratio is stable — any prompt growth shows up here.
    const src = readFileSync(META_AGENT_CHAT_PATH, "utf8");

    const measured = {
      meta_agent_chat_live: src.length,
      meta_agent_chat_demo: src.length,
    };

    if (process.env.WRITE_PROMPT_BUDGET === "1") {
      fixture.ceilings_chars = measured;
      fixture._seeded_at = new Date().toISOString();
      fixture._note =
        "Measures meta-agent-chat.ts file size, not a runtime buildMetaAgentChatPrompt call, because deploy/ tsconfig doesn't include control-plane/. Drift detection is equivalent: any prompt growth changes the file.";
      writeFileSync(fixturePath, JSON.stringify(fixture, null, 2) + "\n");
      console.log(`[seed] wrote prompt-size ceiling to ${fixturePath}`);
      return;
    }

    expect(
      measured.meta_agent_chat_live,
      `control-plane/src/prompts/meta-agent-chat.ts grew past ceiling (${ceilings.meta_agent_chat_live} → ${measured.meta_agent_chat_live} chars). Phase 7 shrinks this — it should never grow. If the growth is legitimate, rerun with WRITE_PROMPT_BUDGET=1 and commit with -fixture-bump label.`,
    ).toBeLessThanOrEqual(ceilings.meta_agent_chat_live);
  });
});

describe("refactor Phase 0 — self-test (drift detector sanity)", () => {
  // Proves the hash function is sensitive to the fields we care about.
  // If this fails, the hash function is broken and the golden test is a lie.

  it("hashSkill distinguishes a one-character change", () => {
    const a = {
      name: "test",
      description: "a",
      when_to_use: "x",
      prompt_template: "body",
    };
    const b = { ...a, prompt_template: "bodY" };
    expect(hashSkill(a)).not.toBe(hashSkill(b));
  });

  it("hashSkill is stable across calls", () => {
    const s = {
      name: "test",
      description: "a",
      when_to_use: "x",
      prompt_template: "body",
    };
    expect(hashSkill(s)).toBe(hashSkill(s));
  });

  it("hashSkill treats missing when_to_use as empty string", () => {
    const a = {
      name: "test",
      description: "a",
      prompt_template: "body",
    };
    const b = { ...a, when_to_use: "" };
    expect(hashSkill(a)).toBe(hashSkill(b));
  });
});
