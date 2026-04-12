// Skills loader: SKILL.md → runtime, injected into system prompt with allowed-tools + template.

import { getDb } from "./db";
import { log } from "./log";
import { BUNDLED_SKILLS_BY_NAME } from "./skills-manifest.generated";

export interface Skill {
  name: string;
  description: string;
  prompt_template: string;
  allowed_tools: string[];
  enabled: boolean;
  version: string;
  category: string;
  when_to_use?: string;                              // auto-activate trigger if set
  min_plan?: "basic" | "standard" | "premium";       // below this, route to delegate_agent
  delegate_agent?: string;                           // target for plan-based delegation
}

const skillCache = new Map<string, { skills: Skill[]; expiresAt: number }>();
const SKILL_CACHE_TTL_MS = 60_000; // 1 minute

// Load per-(org,agent) DB skills. TTL-cached; overlays are loaded separately (loadSkillOverlays).
export async function loadSkills(
  hyperdrive: Hyperdrive,
  orgId: string,
  agentName: string,
): Promise<Skill[]> {
  const cacheKey = `${orgId}:${agentName}`;
  const cached = skillCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.skills;

  try {
    const sql = await getDb(hyperdrive);
    const rows = await sql`
      SELECT name, description, prompt_template, allowed_tools, version, category, when_to_use
      FROM skills
      WHERE org_id = ${orgId}
        AND (agent_name = ${agentName} OR agent_name IS NULL)
        AND enabled = true
      ORDER BY name
    `;

    const skills: Skill[] = rows.map((r: any) => ({
      name: r.name,
      description: r.description || "",
      prompt_template: r.prompt_template || "",
      allowed_tools: (() => {
        try { return JSON.parse(r.allowed_tools || "[]"); } catch { return []; }
      })(),
      enabled: true,
      version: r.version || "1.0.0",
      category: r.category || "general",
      when_to_use: r.when_to_use || undefined,
    }));

    skillCache.set(cacheKey, { skills, expiresAt: Date.now() + SKILL_CACHE_TTL_MS });

    if (skillCache.size > 256) {
      const oldest = [...skillCache.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt);
      for (let i = 0; i < 64; i++) skillCache.delete(oldest[i][0]);
    }

    return skills;
  } catch (err) {
    log.warn("[skills] Failed to load skills:", err);
    return cached?.skills ?? [];
  }
}

// Phase 6: load skill_overlays for (org, agent) as { skillName: rule_texts[] }. Merged into getSkillPrompt output.
export async function loadSkillOverlays(hyperdrive: Hyperdrive, orgId: string, agentName: string): Promise<Record<string, string[]>> {
  try {
    const sql = await getDb(hyperdrive);
    const rows = await sql`SELECT skill_name, rule_text FROM skill_overlays WHERE org_id = ${orgId} AND (agent_name = ${agentName} OR agent_name = '') ORDER BY created_at ASC`;
    const out: Record<string, string[]> = {};
    for (const r of rows as any[]) (out[r.skill_name] ??= []).push(r.rule_text);
    return out;
  } catch (err) { log.warn("[skills] loadSkillOverlays failed:", err); return {}; }
}

/** Format skills section. Default=BUILTIN_SKILLS (Phase 0 byte-id). Opt-in adds NON_BUILTIN_BUNDLED. */
export function formatSkillsPrompt(skills: Skill[], plan?: string, enabled?: readonly string[]): string {
  const merged = enabled?.length
    ? [...BUILTIN_SKILLS, ...NON_BUILTIN_BUNDLED, ...skills]
    : [...BUILTIN_SKILLS, ...skills];
  const all = merged.filter(s => !enabled?.length || enabled.includes(s.name));
  if (all.length === 0) return "";

  const planTier = (plan || "standard").toLowerCase();
  const planRank: Record<string, number> = { basic: 0, standard: 1, premium: 2 };
  const userRank = planRank[planTier] ?? 1;

  // Partition into auto-detect (has when_to_use) and manual (explicit /command only)
  const autoSkills = all.filter(s => s.when_to_use);
  const manualSkills = all.filter(s => !s.when_to_use);

  const lines = [
    "",
    "## Available Skills",
    "",
    "When the user's request matches a skill below, activate it by starting your response with: <activate-skill name=\"skill-name\">user's request</activate-skill>",
    "",
  ];

  if (autoSkills.length > 0) {
    lines.push("**Auto-detect skills** (activate when criteria match):");
    for (const s of autoSkills) {
      let line = `- /${s.name} — ${s.description} USE WHEN: ${s.when_to_use}`;
      if (s.min_plan && s.delegate_agent && userRank < (planRank[s.min_plan] ?? 1)) {
        line += ` *(${s.min_plan}+ plan recommended; auto-delegates to \`${s.delegate_agent}\` on current plan)*`;
      }
      lines.push(line);
    }
    lines.push("");
  }

  if (manualSkills.length > 0) {
    lines.push("**Manual skills** (invoke with /command):");
    for (const s of manualSkills) {
      let line = `- /${s.name} — ${s.description}`;
      if (s.min_plan && s.delegate_agent && userRank < (planRank[s.min_plan] ?? 1)) {
        line += ` *(${s.min_plan}+ plan recommended; auto-delegates to \`${s.delegate_agent}\` on current plan)*`;
      }
      lines.push(line);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/** Get skill body by name. Honors `enabled` allowlist. Phase 6: appends overlays[skillName] learned rules after the template. */
export function getSkillPrompt(skillName: string, args: string, skills: Skill[], enabled?: readonly string[], overlays?: Record<string, string[]>): string | null {
  if (enabled?.length && !enabled.includes(skillName)) return null;
  const skill = BUNDLED_SKILLS_BY_NAME[skillName] ?? skills.find(s => s.name === skillName);
  if (!skill) return null;

  let prompt = skill.prompt_template;
  if (args) prompt = prompt.replace("{{ARGS}}", args).replace("{{INPUT}}", args);
  const rules = overlays?.[skillName];
  if (rules?.length) prompt += "\n\n---\n## Learned rules (Phase 6 overlays)\n\n" + rules.join("\n\n---\n");
  return prompt;
}

// Order is load-bearing — snapshot-tested by Phase 0. Bodies come from skills/public/<name>/SKILL.md.
const BUILTIN_SKILL_ORDER = [
  "batch",
  "review",
  "debug",
  "verify",
  "remember",
  "skillify",
  "schedule",
  "docs",
  "research",
  "report",
  "design",
  "chart",
  "pdf",
  "spreadsheet",
  "analyze",
  "website",
  "build-app",
  "game",
  "docx",
  "pptx",
] as const;

export const BUILTIN_SKILLS: Skill[] = BUILTIN_SKILL_ORDER.map((name) => {
  const s = BUNDLED_SKILLS_BY_NAME[name];
  if (!s) throw new Error(`[skills] BUILTIN_SKILL_ORDER references unbundled "${name}" — add skills/public/${name}/SKILL.md and run the bundler`);
  return s;
});

// Bundled skills NOT in BUILTIN_SKILL_ORDER. Opt-in only via enabled_skills.
const NON_BUILTIN_BUNDLED: Skill[] = Object.values(BUNDLED_SKILLS_BY_NAME)
  .filter((s) => !(BUILTIN_SKILL_ORDER as readonly string[]).includes(s.name));

