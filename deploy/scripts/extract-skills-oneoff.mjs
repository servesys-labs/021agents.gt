#!/usr/bin/env node
// One-off Phase-3 extraction helper.
// Reads deploy/src/runtime/skills.ts, evals the BUILTIN_SKILLS array,
// and writes skills/public/<name>/SKILL.md for each named skill requested.
// Usage: node deploy/scripts/extract-skills-oneoff.mjs <name1> [name2 ...]
// Delete this file after Phase 3 completes.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const SKILLS_TS = join(REPO_ROOT, "deploy", "src", "runtime", "skills.ts");
const SKILLS_ROOT = join(REPO_ROOT, "skills", "public");

function loadBuiltinSkills() {
  const src = readFileSync(SKILLS_TS, "utf8");
  const startMarker = "export const BUILTIN_SKILLS: Skill[] = [";
  const startIdx = src.indexOf(startMarker);
  if (startIdx < 0) throw new Error("BUILTIN_SKILLS marker not found");
  // The marker's last char is the opening `[` of the array. The inner `[]`
  // of `Skill[]` would trip a naive indexOf, so anchor to the marker length.
  const arrOpen = startIdx + startMarker.length - 1;

  // Walk to matching `]` honoring backticks, quotes, line comments, and braces.
  let i = arrOpen + 1;
  let depth = 1;
  let mode = "code"; // "code" | "tmpl" | "str" | "line"
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
    // code mode
    if (ch === "/" && next === "/") { mode = "line"; i += 2; continue; }
    if (ch === "`") { mode = "tmpl"; i++; continue; }
    if (ch === '"' || ch === "'") { mode = "str"; strQuote = ch; i++; continue; }
    if (ch === "[") depth++;
    else if (ch === "]") depth--;
    i++;
  }
  if (depth !== 0) throw new Error("unbalanced BUILTIN_SKILLS array");
  const arrClose = i - 1;
  let body = src.slice(arrOpen + 1, arrClose);

  // Replace positional BUNDLED_SKILLS_BY_NAME references with null so the
  // eval succeeds. We only care about the remaining inline object literals.
  body = body.replace(/BUNDLED_SKILLS_BY_NAME\[[^\]]+\]/g, "null");

  // Evaluate via new Function — these literals are pure data.
  const arr = new Function(`return [${body}];`)();
  return arr.filter((x) => x !== null);
}

function quoteYamlScalar(value) {
  if (typeof value !== "string") return String(value);
  if (value === "") return '""';
  // Always double-quote to be safe. Escape backslashes + quotes.
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function emitFrontmatter(skill) {
  const lines = ["---"];
  lines.push(`name: ${skill.name}`);
  lines.push(`description: ${quoteYamlScalar(skill.description)}`);
  if (skill.when_to_use) {
    lines.push(`when_to_use: ${quoteYamlScalar(skill.when_to_use)}`);
  }
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

function writeSkill(skill) {
  const dir = join(SKILLS_ROOT, skill.name);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const fm = emitFrontmatter(skill);
  // Bundler trims ONE trailing newline; SKILL.md ends with the body + "\n".
  const body = skill.prompt_template;
  const content = `${fm}\n${body}\n`;
  const outPath = join(dir, "SKILL.md");
  writeFileSync(outPath, content, "utf8");
  console.log(`[extract] wrote ${outPath} (${body.length} body bytes)`);
}

function main() {
  const targets = process.argv.slice(2);
  if (targets.length === 0) {
    console.error("usage: extract-skills-oneoff.mjs <name1> [name2 ...]");
    process.exit(1);
  }
  const all = loadBuiltinSkills();
  const byName = new Map(all.map((s) => [s.name, s]));
  for (const name of targets) {
    const skill = byName.get(name);
    if (!skill) {
      console.error(`[extract] skill not found in BUILTIN_SKILLS: ${name}`);
      process.exit(2);
    }
    writeSkill(skill);
  }
}

main();
