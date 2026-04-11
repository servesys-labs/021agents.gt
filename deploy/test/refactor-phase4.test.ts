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

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

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

// ── Phase 5 audit — non-BUILTIN bundled skills reachable via enabled ─
//
// Phase 4 shipped formatSkillsPrompt + getSkillPrompt with a filter that
// only searched BUILTIN_SKILLS ++ dbSkills. Bundled-but-not-BUILTIN skills
// (code-review, deep-research) were silently unreachable: the catalog
// said they existed, validation accepted them, but the runtime filter
// returned empty. Phase 5 audit fixes that: the opt-in path now searches
// BUILTIN_SKILLS ++ NON_BUILTIN_BUNDLED ++ dbSkills, and getSkillPrompt
// looks up via BUNDLED_SKILLS_BY_NAME instead of the BUILTIN-only array.

describe("Phase 5 audit — non-BUILTIN bundled skills activatable via enabled_skills", () => {
  it("default path (no enabled) does NOT expose code-review", () => {
    // Phase 0 snapshot byte-identity depends on this.
    const out = formatSkillsPrompt([], "standard");
    expect(out).not.toContain("/code-review");
    expect(out).not.toContain("/deep-research");
  });

  it("enabled=['code-review'] exposes code-review in the prompt", () => {
    const out = formatSkillsPrompt([], "standard", ["code-review"]);
    expect(out).toContain("/code-review");
    expect(out).not.toContain("/batch");
  });

  it("enabled=['deep-research'] exposes deep-research in the prompt", () => {
    const out = formatSkillsPrompt([], "standard", ["deep-research"]);
    expect(out).toContain("/deep-research");
  });

  it("enabled mix of BUILTIN and non-BUILTIN works", () => {
    const out = formatSkillsPrompt([], "standard", ["batch", "code-review"]);
    expect(out).toContain("/batch");
    expect(out).toContain("/code-review");
  });

  it("getSkillPrompt resolves a non-BUILTIN skill via bundled lookup", () => {
    // Pre-audit, this returned null because BUILTIN_SKILLS didn't contain
    // code-review. Post-audit, BUNDLED_SKILLS_BY_NAME resolves it.
    const prompt = getSkillPrompt("code-review", "review this", [], ["code-review"]);
    expect(prompt).not.toBeNull();
    expect(typeof prompt).toBe("string");
  });

  it("getSkillPrompt still blocks a non-BUILTIN name NOT in enabled", () => {
    expect(getSkillPrompt("code-review", "args", [], ["batch"])).toBeNull();
  });
});

// ── DB-overlap case ───────────────────────────────────────────────

describe("Phase 4 — enabled_skills + DB skill interaction", () => {
  const dbSkill = {
    name: "custom-deploy",
    description: "Custom org-specific deploy workflow",
    prompt_template: "Deploy {{ARGS}}",
    allowed_tools: ["bash"],
    enabled: true,
    version: "1.0.0",
    category: "custom",
    when_to_use: "when the user says deploy",
  };

  it("DB skill is included when listed in enabled", () => {
    const out = formatSkillsPrompt([dbSkill], "standard", ["custom-deploy"]);
    expect(out).toContain("/custom-deploy");
    expect(out).not.toContain("/batch");
  });

  it("DB skill is filtered out when NOT in enabled", () => {
    const out = formatSkillsPrompt([dbSkill], "standard", ["batch"]);
    expect(out).toContain("/batch");
    expect(out).not.toContain("/custom-deploy");
  });

  it("getSkillPrompt finds DB skill when in enabled", () => {
    const prompt = getSkillPrompt("custom-deploy", "staging", [dbSkill], ["custom-deploy"]);
    expect(prompt).not.toBeNull();
    expect(prompt).toContain("staging");
  });

  it("getSkillPrompt blocks DB skill when NOT in enabled", () => {
    expect(getSkillPrompt("custom-deploy", "args", [dbSkill], ["batch"])).toBeNull();
  });
});

// ── Tool-superset invariant across every agent config ─────────────
//
// Phase 4 de-duped several agents to enabled_skills. Each SKILL.md declares
// an `allowed_tools` list in its frontmatter. An agent that enables a skill
// without also granting that skill's tools will appear to work at prompt-
// injection time but fail at tool-dispatch when the model tries to call a
// tool the config doesn't advertise. Guard the invariant here so future
// dedups can't silently re-introduce the regression.

const REPO_ROOT = join(__dirname, "..", "..");
const SKILLS_ROOT = join(REPO_ROOT, "skills", "public");
const AGENTS_ROOT = join(REPO_ROOT, "agents");

function parseFrontmatter(text: string): Record<string, any> {
  const fm: Record<string, any> = {};
  let currentKey: string | null = null;
  let currentList: string[] | null = null;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\s+$/, "");
    const stripped = line.trim();
    if (!stripped || stripped.startsWith("#")) continue;
    if (stripped.startsWith("- ") && currentKey) {
      if (currentList === null) {
        currentList = [];
        fm[currentKey] = currentList;
      }
      currentList.push(stripped.slice(2).trim());
      continue;
    }
    const ci = stripped.indexOf(":");
    if (ci < 0) continue;
    currentList = null;
    currentKey = stripped.slice(0, ci).trim().replace(/-/g, "_");
    let v = stripped.slice(ci + 1).trim();
    if (v) {
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      fm[currentKey] = v;
    }
  }
  return fm;
}

function skillAllowedTools(name: string): string[] {
  const path = join(SKILLS_ROOT, name, "SKILL.md");
  const raw = readFileSync(path, "utf8");
  const m = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  if (!m) return [];
  const fm = parseFrontmatter(m[1]);
  return Array.isArray(fm.allowed_tools) ? fm.allowed_tools : [];
}

function walkAgentConfigs(): Array<{ path: string; config: any }> {
  const results: Array<{ path: string; config: any }> = [];
  function walk(dir: string): void {
    try {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        const st = statSync(full);
        if (st.isDirectory()) {
          walk(full);
        } else if (entry.endsWith(".json")) {
          try {
            results.push({ path: full, config: JSON.parse(readFileSync(full, "utf8")) });
          } catch {}
        }
      }
    } catch {}
  }
  walk(AGENTS_ROOT);
  return results;
}

describe("Phase 4 — agent tools must superset their enabled_skills' allowed_tools", () => {
  const agents = walkAgentConfigs();

  it("there is at least one agent with enabled_skills (sanity — Phase 4 shipped)", () => {
    const withSkills = agents.filter((a) => Array.isArray(a.config.enabled_skills) && a.config.enabled_skills.length > 0);
    expect(withSkills.length).toBeGreaterThan(0);
  });

  for (const { path, config } of agents) {
    const enabled: string[] = Array.isArray(config.enabled_skills) ? config.enabled_skills : [];
    if (enabled.length === 0) continue;

    const relPath = path.slice(REPO_ROOT.length + 1);
    it(`${relPath}: tools ⊇ union(allowed_tools for each enabled skill)`, () => {
      const agentTools = new Set<string>(Array.isArray(config.tools) ? config.tools : []);
      const neededTools = new Set<string>();
      for (const skillName of enabled) {
        for (const t of skillAllowedTools(skillName)) neededTools.add(t);
      }
      const missing = [...neededTools].filter((t) => !agentTools.has(t));
      expect(
        missing,
        `${config.name} enables [${enabled.join(", ")}] but is missing tools the skills need: ${missing.join(", ")}. ` +
          `Either add these to the agent's tools array, or remove the skill from enabled_skills.`,
      ).toEqual([]);
    });
  }
});
