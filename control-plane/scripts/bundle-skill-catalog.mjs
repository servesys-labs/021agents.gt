#!/usr/bin/env node
/**
 * bundle-skill-catalog.mjs
 *
 * Reads every skills/public/<name>/SKILL.md, extracts the frontmatter
 * metadata (name, description, when_to_use, min_plan, delegate_agent),
 * and emits control-plane/src/lib/skill-catalog.generated.ts — a typed
 * list the control-plane uses for:
 *
 *   1. Validation: meta-agent-chat.ts drops unknown skill names from
 *      agent configs before persist.
 *   2. Prompt hints: the meta-agent's system prompt references the
 *      catalog so the LLM knows which skills exist and when to activate
 *      them.
 *
 * Only metadata is emitted. The full prompt_template bodies stay in
 * deploy/src/runtime/skills-manifest.generated.ts where the runtime
 * worker needs them. This catalog is lean (~1-2 KB) and safe to ship
 * into the control-plane bundle.
 *
 * Pairs with deploy/scripts/bundle-skills.mjs. Both scripts read the
 * SAME source of truth (skills/public/<name>/SKILL.md) and emit to
 * their respective workspaces.
 *
 * Regenerate:
 *   node control-plane/scripts/bundle-skill-catalog.mjs
 *
 * Or automatically via predev/predeploy/pretest hooks in
 * control-plane/package.json.
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const SKILLS_ROOT = join(REPO_ROOT, "skills", "public");
// Phase 7 commit 7.2a: meta-agent-only skills, consumed by the
// control-plane prompt builder via META_SKILL_BODIES. Scoping is
// DIRECTORY-based, not frontmatter-based — a skill is meta-only
// by virtue of living under skills/meta/. Deploy's bundler does
// NOT walk this root, so a meta skill cannot leak into
// BUILTIN_SKILLS or NON_BUILTIN_BUNDLED by accident.
const META_SKILLS_ROOT = join(REPO_ROOT, "skills", "meta");
const OUT_PATH = join(
  REPO_ROOT,
  "control-plane",
  "src",
  "lib",
  "skill-catalog.generated.ts",
);
const META_OUT_PATH = join(
  REPO_ROOT,
  "control-plane",
  "src",
  "lib",
  "meta-skill-bodies.generated.ts",
);

// Phase 7 commit 7.2b regex fix — symmetric `[ \t]*\n` instead of `\s*\n`.
//
// The original `\s*\n` at both ends is greedy and, because `\s` includes
// `\n`, consumes multiple consecutive newlines on backtrack. Concretely:
// for `---\nname:...\n---\n\n### Body`, the closing `\s*\n` greedy-grabs
// `\n\n`, fails to match the final regex `\n` against `#`, backtracks
// `\s*` to `\n` (one newline), then the regex `\n` matches the second
// `\n`. Net: BOTH newlines after `---` are consumed by match[0], and any
// leading `\n` that was supposed to be the first byte of the body is
// silently stripped.
//
// This was a latent bug in the original `parseSkillMetadata` path because
// metadata-only parsing reads match[1] (the frontmatter capture group),
// not raw.slice(match[0].length). Phase 7 commit 7.2a's `parseMetaSkillBody`
// is the first code path that cares about the post-match offset, and
// Phase 7 commit 7.2b surfaced it when extracting DEMO_MODE_INSTRUCTIONS
// (whose template literal starts with `\n### Demo Mode Behavior`).
//
// Fix: `[ \t]*\n` matches only spaces/tabs before the required `\n`, so
// `\s*` can no longer cross line boundaries. Opening and closing are
// fixed symmetrically — the opening fix is zero-impact for every current
// SKILL.md (none have trailing spaces on their `---` lines) but defends
// against future files with that pattern, and the symmetry makes the
// intent obvious to future maintainers who might be tempted to revert it.
//
// Scope: this regex is only in the control-plane bundler. The deploy
// bundler at deploy/scripts/bundle-skills.mjs is locked to Phase 0
// skill_hashes byte-identity and intentionally left unchanged. Meta
// skills never flow through the deploy bundler, so the two parsers can
// diverge safely. If a future phase wants to align them, it must be a
// deliberate -fixture-bump commit that regenerates Phase 0 hashes.
//
// Verified byte-identical for all 23 existing public SKILL.md files:
// none start with `\n`, so match[1] is unaffected and the catalog
// regeneration produces zero diff.
const FRONTMATTER_RE = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*\n/;

// Mirror the YAML subset parsed by deploy/scripts/bundle-skills.mjs and
// agentos/skills/loader.py. Intentionally minimal — just key/value pairs
// and `- item` lists under a key.
function parseYamlSimple(text) {
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
      currentKey = key.replace(/-/g, "_");
      let value = stripped.slice(colonIdx + 1).trim();
      if (value) {
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        if (value === "true") value = true;
        else if (value === "false") value = false;
        result[currentKey] = value;
      }
    }
  }

  return result;
}

// Parse a meta SKILL.md file and return { name, body }. Body is the raw
// markdown after the closing `---`, with exactly one trailing newline
// trimmed — matches deploy/scripts/bundle-skills.mjs semantics so meta
// skill bodies are byte-identical to how the deploy bundler would read
// them if they ever migrated. `name` is taken from the directory, NOT
// from frontmatter — directory-based scoping per the Phase 7 spec.
function parseMetaSkillBody(path, dirName) {
  const raw = readFileSync(path, "utf8");
  const match = raw.match(FRONTMATTER_RE);
  if (!match) {
    throw new Error(`${path}: missing YAML frontmatter (expected --- ... ---)`);
  }
  let body = raw.slice(match[0].length);
  if (body.endsWith("\n")) body = body.slice(0, -1);
  return { name: dirName, body };
}

function discoverMetaSkillDirs(root) {
  try { statSync(root); } catch { return []; }
  const dirs = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillMd = join(root, entry.name, "SKILL.md");
    try {
      statSync(skillMd);
      dirs.push({ dirName: entry.name, skillMd });
    } catch {
      // no SKILL.md in this subdir — skip silently. README.md at the
      // root of skills/meta/ is not a subdirectory, so it's ignored
      // without needing a special case here.
    }
  }
  return dirs.sort((a, b) => a.dirName.localeCompare(b.dirName));
}

function emitMetaBodies(entries) {
  const lines = [
    "/* AUTO-GENERATED by control-plane/scripts/bundle-skill-catalog.mjs — DO NOT EDIT.",
    " *",
    " * Source of truth: skills/meta/<name>/SKILL.md",
    " * Regenerate: node control-plane/scripts/bundle-skill-catalog.mjs",
    " *",
    " * Phase 7 commit 7.2a: meta-agent-only skill bodies, consumed by",
    " * the control-plane prompt builder (meta-agent-chat.ts). Keys are",
    " * the SKILL.md parent directory name; values are the raw body with",
    " * exactly one trailing newline trimmed.",
    " */",
    "",
    "export const META_SKILL_BODIES: Record<string, string> = {",
  ];
  for (const e of entries) {
    // JSON.stringify handles backticks, ${, backslashes, newlines, etc.
    lines.push(`  ${JSON.stringify(e.name)}: ${JSON.stringify(e.body)},`);
  }
  lines.push("};");
  lines.push("");
  return lines.join("\n");
}

function parseSkillMetadata(path) {
  const raw = readFileSync(path, "utf8");
  const match = raw.match(FRONTMATTER_RE);
  if (!match) {
    throw new Error(`${path}: missing YAML frontmatter (expected --- ... ---)`);
  }

  const fm = parseYamlSimple(match[1]);
  const name = fm.name;
  if (!name) throw new Error(`${path}: frontmatter missing 'name'`);

  // Metadata-only. Deliberately exclude prompt_template, allowed_tools,
  // version, category — the control-plane doesn't need those to validate
  // or hint.
  const entry = {
    name,
    description: fm.description || "",
  };
  if (fm.when_to_use) entry.when_to_use = fm.when_to_use;
  if (fm.min_plan) entry.min_plan = fm.min_plan;
  if (fm.delegate_agent) entry.delegate_agent = fm.delegate_agent;
  return entry;
}

function discoverSkillFiles(root) {
  try {
    statSync(root);
  } catch {
    return [];
  }
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

function emitCatalog(entries) {
  const lines = [
    "/* AUTO-GENERATED by control-plane/scripts/bundle-skill-catalog.mjs — DO NOT EDIT.",
    " *",
    " * Source of truth: skills/public/<name>/SKILL.md",
    " * Regenerate: node control-plane/scripts/bundle-skill-catalog.mjs",
    " *",
    " * Emits metadata ONLY (name, description, when_to_use, min_plan,",
    " * delegate_agent). Full prompt_template bodies live in",
    " * deploy/src/runtime/skills-manifest.generated.ts for the edge worker.",
    " */",
    "",
    "export interface SkillCatalogEntry {",
    "  name: string;",
    "  description: string;",
    "  when_to_use?: string;",
    "  min_plan?: \"basic\" | \"standard\" | \"premium\";",
    "  delegate_agent?: string;",
    "}",
    "",
    "export const SKILL_CATALOG: SkillCatalogEntry[] = [",
  ];

  for (const entry of entries) {
    lines.push("  " + JSON.stringify(entry) + ",");
  }

  lines.push("];");
  lines.push("");
  lines.push("export const SKILL_CATALOG_BY_NAME: Record<string, SkillCatalogEntry> =");
  lines.push("  Object.fromEntries(SKILL_CATALOG.map((s) => [s.name, s]));");
  lines.push("");
  lines.push("/** Lean allowlist for meta-agent validation: just the set of names. */");
  lines.push("export const SKILL_CATALOG_NAMES: ReadonlySet<string> =");
  lines.push("  new Set(SKILL_CATALOG.map((s) => s.name));");
  lines.push("");

  return lines.join("\n");
}

function main() {
  const files = discoverSkillFiles(SKILLS_ROOT);
  if (files.length === 0) {
    console.error(`[bundle-skill-catalog] no SKILL.md files found under ${SKILLS_ROOT}`);
    process.exit(1);
  }

  const entries = files.map(parseSkillMetadata);
  entries.sort((a, b) => a.name.localeCompare(b.name));

  const source = emitCatalog(entries);
  writeFileSync(OUT_PATH, source, "utf8");

  console.log(
    `[bundle-skill-catalog] wrote ${entries.length} skills to ${OUT_PATH}`,
  );
  for (const e of entries) {
    console.log(`  - ${e.name}${e.when_to_use ? " (auto)" : " (manual)"}`);
  }

  // ── Meta-agent-only bodies ──────────────────────────────────────
  // Walk skills/meta/ and emit META_SKILL_BODIES. Empty is valid —
  // at 7.2a this writes an empty map. First content lands in 7.2b.
  const metaDirs = discoverMetaSkillDirs(META_SKILLS_ROOT);
  const metaEntries = metaDirs.map((d) => parseMetaSkillBody(d.skillMd, d.dirName));
  metaEntries.sort((a, b) => a.name.localeCompare(b.name));

  const metaSource = emitMetaBodies(metaEntries);
  writeFileSync(META_OUT_PATH, metaSource, "utf8");

  console.log(
    `[bundle-skill-catalog] wrote ${metaEntries.length} meta skill bodies to ${META_OUT_PATH}`,
  );
  for (const e of metaEntries) {
    console.log(`  - ${e.name} (${e.body.length} bytes)`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { parseSkillMetadata, parseMetaSkillBody };
