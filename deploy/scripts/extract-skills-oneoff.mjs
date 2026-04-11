#!/usr/bin/env node
// One-off Phase-3 extraction helper.
//
// Usage:
//   node deploy/scripts/extract-skills-oneoff.mjs <name>
//
// For the named skill, this script:
//   1. Writes skills/public/<name>/SKILL.md (frontmatter + body, byte-identical
//      to the runtime string produced by the TS template literal).
//   2. Rewrites deploy/src/runtime/skills.ts in place, replacing the inline
//      object literal with a `BUNDLED_SKILLS_BY_NAME["<name>"],` reference at
//      the original array position (preserves insertion order).
//
// Delete this file after Phase 3 completes.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const SKILLS_TS = join(REPO_ROOT, "deploy", "src", "runtime", "skills.ts");
const SKILLS_ROOT = join(REPO_ROOT, "skills", "public");

// Walks `src` starting at `start` and returns the index just past the matching
// array-closing `]` at depth 0. Honors backticks, quotes, and line comments.
function findArrayEnd(src, arrOpen) {
  let i = arrOpen + 1;
  let depth = 1;
  let mode = "code";
  let strQuote = "";
  while (i < src.length && depth > 0) {
    const ch = src[i];
    const next = src[i + 1];
    if (mode === "line") {
      if (ch === "\n") mode = "code";
      i++;
      continue;
    }
    if (mode === "tmpl") {
      if (ch === "\\") { i += 2; continue; }
      if (ch === "`") { mode = "code"; i++; continue; }
      i++;
      continue;
    }
    if (mode === "str") {
      if (ch === "\\") { i += 2; continue; }
      if (ch === strQuote) { mode = "code"; i++; continue; }
      i++;
      continue;
    }
    if (ch === "/" && next === "/") { mode = "line"; i += 2; continue; }
    if (ch === "`") { mode = "tmpl"; i++; continue; }
    if (ch === '"' || ch === "'") { mode = "str"; strQuote = ch; i++; continue; }
    if (ch === "[") depth++;
    else if (ch === "]") depth--;
    i++;
  }
  return i; // index just past the closing `]`
}

// Walks `src` from `start` (which must be at `{`) and returns the index just
// past the matching `}` at depth 0. Mirrors findArrayEnd's syntax awareness.
function findObjectEnd(src, objStart) {
  let i = objStart + 1;
  let depth = 1;
  let mode = "code";
  let strQuote = "";
  while (i < src.length && depth > 0) {
    const ch = src[i];
    const next = src[i + 1];
    if (mode === "line") {
      if (ch === "\n") mode = "code";
      i++;
      continue;
    }
    if (mode === "tmpl") {
      if (ch === "\\") { i += 2; continue; }
      if (ch === "`") { mode = "code"; i++; continue; }
      i++;
      continue;
    }
    if (mode === "str") {
      if (ch === "\\") { i += 2; continue; }
      if (ch === strQuote) { mode = "code"; i++; continue; }
      i++;
      continue;
    }
    if (ch === "/" && next === "/") { mode = "line"; i += 2; continue; }
    if (ch === "`") { mode = "tmpl"; i++; continue; }
    if (ch === '"' || ch === "'") { mode = "str"; strQuote = ch; i++; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    i++;
  }
  return i;
}

// Parses the BUILTIN_SKILLS array from skills.ts, returning an array of
// { start, end, kind, name, skill? } entries, in source order.
//   kind: "inline" → a `{ ... }` literal; skill is the evaluated object.
//   kind: "ref"    → a `BUNDLED_SKILLS_BY_NAME["x"]` already-extracted entry.
function parseBuiltinSkills(src) {
  const marker = "export const BUILTIN_SKILLS: Skill[] = [";
  const startIdx = src.indexOf(marker);
  if (startIdx < 0) throw new Error("BUILTIN_SKILLS marker not found");
  const arrOpen = startIdx + marker.length - 1; // position of `[`
  const arrEnd = findArrayEnd(src, arrOpen); // index past `]`
  const arrClose = arrEnd - 1;

  const entries = [];
  let i = arrOpen + 1;
  while (i < arrClose) {
    const ch = src[i];
    // Skip whitespace + commas + // line comments between entries.
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === ",") {
      i++;
      continue;
    }
    if (ch === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      i = nl < 0 ? arrClose : nl + 1;
      continue;
    }
    if (ch === "{") {
      const objEnd = findObjectEnd(src, i);
      const body = src.slice(i, objEnd);
      const nameMatch = body.match(/name:\s*"([^"]+)"/);
      const name = nameMatch ? nameMatch[1] : null;
      const skill = evalObjectLiteral(body);
      entries.push({ start: i, end: objEnd, kind: "inline", name, skill });
      i = objEnd;
      continue;
    }
    if (src.startsWith("BUNDLED_SKILLS_BY_NAME[", i)) {
      const end = src.indexOf("]", i) + 1;
      const nameMatch = src.slice(i, end).match(/\["([^"]+)"\]/);
      entries.push({ start: i, end, kind: "ref", name: nameMatch ? nameMatch[1] : null });
      i = end;
      continue;
    }
    // Unknown token — bail loud so we notice.
    throw new Error(`parseBuiltinSkills: unexpected char at ${i}: ${JSON.stringify(src.slice(i, i + 40))}`);
  }
  return { entries, arrOpen, arrEnd };
}

function evalObjectLiteral(text) {
  // text is `{...}` — safe to wrap and eval; pure data.
  return new Function(`return (${text});`)();
}

function quoteYamlScalar(value) {
  if (typeof value !== "string") return String(value);
  if (value === "") return '""';
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function emitFrontmatter(skill) {
  const lines = ["---"];
  lines.push(`name: ${skill.name}`);
  lines.push(`description: ${quoteYamlScalar(skill.description)}`);
  if (skill.when_to_use) lines.push(`when_to_use: ${quoteYamlScalar(skill.when_to_use)}`);
  lines.push(`category: ${skill.category ?? "general"}`);
  lines.push(`version: ${skill.version ?? "1.0.0"}`);
  lines.push(`enabled: ${skill.enabled === false ? "false" : "true"}`);
  if (skill.min_plan) lines.push(`min_plan: ${skill.min_plan}`);
  if (skill.delegate_agent) lines.push(`delegate_agent: ${skill.delegate_agent}`);
  if (Array.isArray(skill.allowed_tools) && skill.allowed_tools.length > 0) {
    lines.push("allowed-tools:");
    for (const tool of skill.allowed_tools) lines.push(`  - ${tool}`);
  }
  lines.push("---");
  return lines.join("\n");
}

function writeSkillMd(skill) {
  const dir = join(SKILLS_ROOT, skill.name);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const fm = emitFrontmatter(skill);
  const body = skill.prompt_template;
  // Bundler trims ONE trailing newline, so we intentionally end with "\n".
  const content = `${fm}\n${body}\n`;
  const outPath = join(dir, "SKILL.md");
  writeFileSync(outPath, content, "utf8");
  console.log(`[extract] wrote ${outPath} (${body.length} body bytes)`);
}

function patchSkillsTs(src, entry) {
  // entry.start..entry.end is the object literal text, NOT including the
  // trailing `,` or the leading indentation. We want to replace from the
  // line start (2-space indent) through the trailing `,\n` to keep the array
  // body clean. Walk backwards to find the line start; walk forwards to
  // skip any `,` and the following newline.
  let lineStart = entry.start;
  while (lineStart > 0 && src[lineStart - 1] !== "\n") lineStart--;

  let cursor = entry.end;
  if (src[cursor] === ",") cursor++;
  if (src[cursor] === "\n") cursor++;

  // Preserve any immediately-preceding `  // ── /name — ... ──\n` comment
  // line by deleting it too — the reference-only entry doesn't need a banner.
  // Walk back over zero or more `  // ...` comment lines attached without
  // blank-line separation.
  while (true) {
    if (lineStart < 2) break;
    // Find the start of the previous line.
    let prevEnd = lineStart - 1; // the `\n` at end of prev line
    if (prevEnd < 0 || src[prevEnd] !== "\n") break;
    let prevStart = prevEnd - 1;
    while (prevStart >= 0 && src[prevStart] !== "\n") prevStart--;
    prevStart++;
    const prevLine = src.slice(prevStart, prevEnd);
    if (/^  \/\/ ── \//.test(prevLine)) {
      lineStart = prevStart;
      continue;
    }
    break;
  }

  const replacement = `  BUNDLED_SKILLS_BY_NAME["${entry.name}"],\n`;
  return src.slice(0, lineStart) + replacement + src.slice(cursor);
}

function main() {
  const target = process.argv[2];
  if (!target) {
    console.error("usage: extract-skills-oneoff.mjs <name>");
    process.exit(1);
  }
  const src = readFileSync(SKILLS_TS, "utf8");
  const { entries } = parseBuiltinSkills(src);
  const match = entries.find((e) => e.kind === "inline" && e.name === target);
  if (!match) {
    console.error(`[extract] inline skill not found: ${target}`);
    process.exit(2);
  }
  writeSkillMd(match.skill);
  const patched = patchSkillsTs(src, match);
  writeFileSync(SKILLS_TS, patched, "utf8");
  console.log(`[extract] patched skills.ts — replaced ${target} literal with BUNDLED_SKILLS_BY_NAME reference`);
}

main();
