#!/usr/bin/env node
/**
 * bundle-skills.mjs
 *
 * Reads every skills/public/<name>/SKILL.md, parses YAML frontmatter + markdown
 * body, and emits deploy/src/runtime/skills-manifest.generated.ts — a TypeScript
 * file that exports a BUNDLED_SKILLS_BY_NAME lookup the runtime uses to splice
 * bundled skills into BUILTIN_SKILLS at their original positions.
 *
 * Frontmatter fields consumed (matching agentos/skills/loader.py schema plus
 * the extra fields skills.ts needs):
 *
 *   name            (required) — matches the /slash command
 *   description     (required) — one-line summary for formatSkillsPrompt
 *   when_to_use     (optional) — auto-detect trigger; hash input
 *   category        (optional, default "general")
 *   version         (optional, default "1.0.0")
 *   enabled         (optional, default true)
 *   min_plan        (optional) — "basic" | "standard" | "premium"
 *   delegate_agent  (optional) — name of a skill-agent to delegate to
 *   allowed-tools   (optional list) — tool allowlist
 *
 * Body (everything after the closing `---`) becomes the prompt_template.
 *
 * CRITICAL: the golden hash in deploy/test/fixtures/skill_hashes.json is
 * computed over `name|description|when_to_use|prompt_template`. If the
 * markdown file drifts by a single byte, that hash changes and phase0 fails.
 * The bundler is intentionally dumb: it reads bytes, parses frontmatter, and
 * dumps the raw body. No normalization.
 */

import { readFileSync, readdirSync, writeFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const SKILLS_ROOT = join(REPO_ROOT, "skills", "public");
const OUT_PATH = join(
  REPO_ROOT,
  "deploy",
  "src",
  "runtime",
  "skills-manifest.generated.ts",
);

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n/;

function parseYamlSimple(text) {
  // Intentionally minimal — matches agentos/skills/loader.py._parse_yaml_simple.
  // Handles: key: value, key: "value", and `- item` lists under a key.
  const result = {};
  let currentKey = null;
  let currentList = null;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\s+$/, "");
    const stripped = line.trim();
    if (!stripped || stripped.startsWith("#")) continue;

    if (stripped.startsWith("- ") && currentKey) {
      if (currentList === null) {
        currentList = [];
        result[currentKey] = currentList;
      }
      currentList.push(stripped.slice(2).trim());
      continue;
    }

    const colonIdx = stripped.indexOf(":");
    if (colonIdx >= 0) {
      currentList = null;
      const key = stripped.slice(0, colonIdx).trim();
      // Normalize `allowed-tools` → `allowed_tools` to match the TS Skill shape.
      currentKey = key.replace(/-/g, "_");
      let value = stripped.slice(colonIdx + 1).trim();
      if (value) {
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        // Coerce booleans — frontmatter has `enabled: true`.
        if (value === "true") value = true;
        else if (value === "false") value = false;
        result[currentKey] = value;
      }
    }
  }

  return result;
}

function parseSkillMd(path) {
  const raw = readFileSync(path, "utf8");
  const match = raw.match(FRONTMATTER_RE);
  if (!match) {
    throw new Error(`${path}: missing YAML frontmatter (expected --- ... ---)`);
  }

  const frontmatter = parseYamlSimple(match[1]);
  // Body is everything after the closing ---. Strip EXACTLY one trailing
  // newline if present — this lets SKILL.md files end naturally with a
  // newline (as editors and VCS prefer) while matching the byte sequence of
  // the original TS template literals (which ended at the last content char).
  // If two phases of the refactor need different trimming rules, this is the
  // single place to revisit.
  let body = raw.slice(match[0].length);
  if (body.endsWith("\n")) body = body.slice(0, -1);

  const name = frontmatter.name;
  if (!name) throw new Error(`${path}: frontmatter missing 'name'`);
  const description = frontmatter.description ?? "";

  const skill = {
    name,
    description,
    prompt_template: body,
    allowed_tools: Array.isArray(frontmatter.allowed_tools)
      ? frontmatter.allowed_tools
      : [],
    enabled: frontmatter.enabled === false ? false : true,
    version: frontmatter.version ?? "1.0.0",
    category: frontmatter.category ?? "general",
  };

  if (frontmatter.when_to_use) skill.when_to_use = frontmatter.when_to_use;
  if (frontmatter.min_plan) skill.min_plan = frontmatter.min_plan;
  if (frontmatter.delegate_agent)
    skill.delegate_agent = frontmatter.delegate_agent;

  return skill;
}

function discoverSkillFiles(root) {
  if (!statSync(root, { throwIfNoEntry: false })) return [];
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillMd = join(root, entry.name, "SKILL.md");
    try {
      statSync(skillMd);
      files.push(skillMd);
    } catch {
      // no SKILL.md in this subdir — skip silently
    }
  }
  return files.sort();
}

function emitManifest(skills) {
  // JSON.stringify handles ALL escape cases: backticks, ${, backslashes,
  // newlines, quotes, unicode. The resulting TS source is boring and safe.
  const lines = [
    "/* AUTO-GENERATED by deploy/scripts/bundle-skills.mjs — DO NOT EDIT.",
    " *",
    " * Source of truth: skills/public/<name>/SKILL.md",
    " * Regenerate: node deploy/scripts/bundle-skills.mjs",
    " */",
    "",
    'import type { Skill } from "./skills";',
    "",
    "export const BUNDLED_SKILLS: Skill[] = [",
  ];

  for (const skill of skills) {
    lines.push("  " + JSON.stringify(skill) + ",");
  }

  lines.push("];");
  lines.push("");
  lines.push("export const BUNDLED_SKILLS_BY_NAME: Record<string, Skill> =");
  lines.push(
    "  Object.fromEntries(BUNDLED_SKILLS.map((s) => [s.name, s]));",
  );
  lines.push("");

  return lines.join("\n");
}

function main() {
  const files = discoverSkillFiles(SKILLS_ROOT);
  if (files.length === 0) {
    console.error(`[bundle-skills] no SKILL.md files found under ${SKILLS_ROOT}`);
    process.exit(1);
  }

  const skills = files.map(parseSkillMd);
  skills.sort((a, b) => a.name.localeCompare(b.name));

  const source = emitManifest(skills);
  writeFileSync(OUT_PATH, source, "utf8");

  console.log(
    `[bundle-skills] wrote ${skills.length} skills to ${OUT_PATH}`,
  );
  for (const s of skills) {
    console.log(`  - ${s.name} (${s.prompt_template.length} bytes)`);
  }
}

main();
