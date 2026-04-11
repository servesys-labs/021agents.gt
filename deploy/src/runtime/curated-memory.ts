import type { RuntimeEnv } from "./types";

import { getDb } from "./db";

const ENTRY_DELIMITER = "\n§\n";
const DEFAULT_MEMORY_CHAR_LIMIT = 2200;
const DEFAULT_USER_CHAR_LIMIT = 1375;
const KEY_PREFIX = "curated:";

const INVISIBLE_CHARS = new Set([
  "\u200b", "\u200c", "\u200d", "\u2060", "\ufeff",
  "\u202a", "\u202b", "\u202c", "\u202d", "\u202e",
]);

const THREAT_PATTERNS: Array<{ regex: RegExp; id: string }> = [
  { regex: /ignore\s+(previous|all|above|prior)\s+instructions/i, id: "prompt_injection" },
  { regex: /you\s+are\s+now\s+/i, id: "role_hijack" },
  { regex: /do\s+not\s+tell\s+the\s+user/i, id: "deception_hide" },
  { regex: /system\s+prompt\s+override/i, id: "sys_prompt_override" },
  { regex: /disregard\s+(your|all|any)\s+(instructions|rules|guidelines)/i, id: "disregard_rules" },
  { regex: /curl\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i, id: "exfil_curl" },
  { regex: /wget\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i, id: "exfil_wget" },
  { regex: /authorized_keys/i, id: "ssh_backdoor" },
];

type CuratedTarget = "memory" | "user";
type CuratedAction = "add" | "replace" | "remove";

interface CuratedRow {
  id: string;
  key: string;
  value: string;
  category: string;
  created_at?: string;
}

interface CuratedResult {
  success: boolean;
  target: CuratedTarget;
  usage: string;
  entry_count: number;
  message?: string;
  error?: string;
  matches?: string[];
}

interface CuratedSnapshot {
  memory_block?: string;
  user_block?: string;
}

function charLimitForTarget(target: CuratedTarget): number {
  return target === "user" ? DEFAULT_USER_CHAR_LIMIT : DEFAULT_MEMORY_CHAR_LIMIT;
}

function keyPrefixForTarget(target: CuratedTarget): string {
  return `${KEY_PREFIX}${target}:`;
}

function categoryForTarget(target: CuratedTarget): string {
  return target === "user" ? "user" : "reference";
}

function shortId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

function normalizeEntries(rows: CuratedRow[]): string[] {
  return rows.map((r) => String(r.value || "").trim()).filter(Boolean);
}

function usageString(entries: string[], target: CuratedTarget, limitOverride?: number): string {
  const current = entries.length > 0 ? entries.join(ENTRY_DELIMITER).length : 0;
  const limit = limitOverride || charLimitForTarget(target);
  const pct = Math.min(100, Math.floor((current / limit) * 100));
  return `${pct}% - ${current}/${limit} chars`;
}

function formatPromptBlock(target: CuratedTarget, entries: string[], limitOverride?: number): string {
  if (entries.length === 0) return "";
  const current = entries.join(ENTRY_DELIMITER).length;
  const limit = limitOverride || charLimitForTarget(target);
  const pct = Math.min(100, Math.floor((current / limit) * 100));
  const title = target === "user"
    ? `USER PROFILE (who the user is) [${pct}% - ${current}/${limit} chars]`
    : `MEMORY (persistent notes) [${pct}% - ${current}/${limit} chars]`;
  const sep = "═".repeat(46);
  return `${sep}\n${title}\n${sep}\n${entries.join(ENTRY_DELIMITER)}`;
}

function rowContent(row: CuratedRow): string {
  return String(row.value || "");
}

function isLegacyFactsRow(row: CuratedRow): boolean {
  return String(row.key || "").startsWith(KEY_PREFIX);
}

async function sha256Hex(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const arr = Array.from(new Uint8Array(digest));
  return arr.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function scanMemoryContent(content: string): string | null {
  for (const ch of INVISIBLE_CHARS) {
    if (content.includes(ch)) {
      return `Blocked: content contains invisible unicode character U+${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}.`;
    }
  }
  for (const p of THREAT_PATTERNS) {
    if (p.regex.test(content)) {
      return `Blocked: content matches threat pattern '${p.id}'.`;
    }
  }
  return null;
}

// Fail-closed org resolution — do NOT fall back to "pick any org from the
// orgs table", which was a latent cross-tenant leak. Callers that cannot
// supply an org_id receive an empty string and must return an error.
function resolveOrgIdStrict(orgId?: string): string {
  return String(orgId || "").trim();
}

async function loadRowsForTarget(
  sql: any,
  agentName: string,
  orgId: string,
  target: CuratedTarget,
): Promise<CuratedRow[]> {
  try {
    const rows = await sql`
      SELECT id, target, content, updated_at
      FROM curated_memory
      WHERE agent_name = ${agentName}
        AND org_id = ${orgId}
        AND target = ${target}
      ORDER BY updated_at ASC
      LIMIT 200
    `;
    return (rows as Array<Record<string, unknown>>).map((r) => ({
      id: String(r.id || ""),
      key: "",
      value: String(r.content || ""),
      category: String(r.target || target),
      created_at: r.updated_at ? String(r.updated_at) : undefined,
    }));
  } catch {
    // Backward compatibility for deployments that have not applied SQL migration yet.
    const rows = await sql`
      SELECT id, key, value, category, created_at
      FROM facts
      WHERE agent_name = ${agentName}
        AND org_id = ${orgId}
        AND scope = 'agent'
        AND key LIKE ${`${keyPrefixForTarget(target)}%`}
      ORDER BY created_at ASC
      LIMIT 200
    `;
    return (rows as Array<Record<string, unknown>>).map((r) => ({
      id: String(r.id || ""),
      key: String(r.key || ""),
      value: String(r.value || ""),
      category: String(r.category || ""),
      created_at: r.created_at ? String(r.created_at) : undefined,
    }));
  }
}

async function resolveCharLimits(sql: any, orgId: string, agentName: string): Promise<{ memory: number; user: number }> {
  try {
    const rows = await sql`
      SELECT memory_char_limit, user_char_limit
      FROM curated_memory_config
      WHERE org_id = ${orgId}
        AND agent_name = ${agentName}
      LIMIT 1
    `;
    const row = rows?.[0] || {};
    const memory = Math.max(200, Number(row.memory_char_limit) || DEFAULT_MEMORY_CHAR_LIMIT);
    const user = Math.max(200, Number(row.user_char_limit) || DEFAULT_USER_CHAR_LIMIT);
    return { memory, user };
  } catch {
    return { memory: DEFAULT_MEMORY_CHAR_LIMIT, user: DEFAULT_USER_CHAR_LIMIT };
  }
}

function limitForTarget(target: CuratedTarget, limits: { memory: number; user: number }): number {
  return target === "user" ? limits.user : limits.memory;
}

function buildSuccess(target: CuratedTarget, entries: string[], limit: number, message: string): CuratedResult {
  return {
    success: true,
    target,
    usage: usageString(entries, target, limit),
    entry_count: entries.length,
    message,
  };
}

function buildError(target: CuratedTarget, entries: string[], limit: number, error: string, matches?: string[]): CuratedResult {
  return {
    success: false,
    target,
    usage: usageString(entries, target, limit),
    entry_count: entries.length,
    error,
    ...(matches && matches.length > 0 ? { matches } : {}),
  };
}

export async function curatedMemoryTool(env: RuntimeEnv, args: Record<string, any>): Promise<string> {
  const action = String(args.action || "").toLowerCase() as CuratedAction;
  const target = String(args.target || "memory").toLowerCase() as CuratedTarget;
  const content = String(args.content || "").trim();
  const oldText = String(args.old_text || "").trim();
  if (!["add", "replace", "remove"].includes(action)) {
    return JSON.stringify({ success: false, error: "Unknown action. Use add, replace, or remove." });
  }
  if (!["memory", "user"].includes(target)) {
    return JSON.stringify({ success: false, error: "Invalid target. Use memory or user." });
  }

  const hyperdrive = (env as any).HYPERDRIVE as Hyperdrive | undefined;
  const agentName = (env as any).__agentConfig?.name || "my-assistant";
  const orgFromConfig = (env as any).__agentConfig?.org_id || (env as any).__delegationLineage?.org_id || "";
  if (!hyperdrive) return JSON.stringify({ success: false, error: "Memory unavailable (no database)." });

  const orgId = resolveOrgIdStrict(orgFromConfig);
  if (!orgId) {
    return JSON.stringify({
      success: false,
      error: "Memory unavailable: org_id required — curated memory must not fall back to another tenant.",
    });
  }

  const sql = await getDb(hyperdrive);
  const limits = await resolveCharLimits(sql, orgId, agentName);
  const limit = limitForTarget(target, limits);
  const rows = await loadRowsForTarget(sql, agentName, orgId, target);
  const entries = normalizeEntries(rows);

  if (action === "add") {
    if (!content) return JSON.stringify(buildError(target, entries, limit, "content is required for add."));
    const scanErr = scanMemoryContent(content);
    if (scanErr) return JSON.stringify(buildError(target, entries, limit, scanErr));
    if (entries.includes(content)) return JSON.stringify(buildSuccess(target, entries, limit, "Entry already exists (no duplicate added)."));
    const next = [...entries, content];
    const nextChars = next.join(ENTRY_DELIMITER).length;
    if (nextChars > limit) {
      return JSON.stringify(buildError(target, entries, limit, `Memory at ${usageString(entries, target, limit)}. Adding this entry would exceed limit.`));
    }
    try {
      await sql`
        INSERT INTO curated_memory (id, org_id, agent_name, target, content, content_hash, updated_at)
        VALUES (
          ${shortId()},
          ${orgId},
          ${agentName},
          ${target},
          ${content},
          ${await sha256Hex(content)},
          ${new Date().toISOString()}
        )
      `;
    } catch {
      await sql`
        INSERT INTO facts (id, agent_name, org_id, scope, key, value, category, created_at)
        VALUES (
          ${shortId()},
          ${agentName},
          ${orgId},
          'agent',
          ${`${keyPrefixForTarget(target)}${Date.now().toString(36)}:${shortId().slice(0, 6)}`},
          ${content},
          ${categoryForTarget(target)},
          ${new Date().toISOString()}
        )
      `;
    }
    return JSON.stringify(buildSuccess(target, next, limit, "Entry added."));
  }

  if (!oldText) {
    return JSON.stringify(buildError(target, entries, limit, "old_text is required for replace/remove."));
  }
  const matches = rows
    .map((r, idx) => ({ idx, row: r }))
    .filter((x) => rowContent(x.row).includes(oldText));
  if (matches.length === 0) {
    return JSON.stringify(buildError(target, entries, limit, `No entry matched '${oldText}'.`));
  }
  if (matches.length > 1) {
    const previews = matches.map((m) => rowContent(m.row).slice(0, 80));
    return JSON.stringify(buildError(target, entries, limit, `Multiple entries matched '${oldText}'. Be more specific.`, previews));
  }

  const match = matches[0]!;
  if (action === "remove") {
    if (isLegacyFactsRow(match.row)) {
      await sql`DELETE FROM facts WHERE id = ${match.row.id} AND agent_name = ${agentName} AND org_id = ${orgId}`;
    } else {
      await sql`DELETE FROM curated_memory WHERE id = ${match.row.id} AND agent_name = ${agentName} AND org_id = ${orgId}`;
    }
    const next = entries.filter((_, i) => i !== match.idx);
    return JSON.stringify(buildSuccess(target, next, limit, "Entry removed."));
  }

  if (!content) {
    return JSON.stringify(buildError(target, entries, limit, "content is required for replace."));
  }
  const scanErr = scanMemoryContent(content);
  if (scanErr) return JSON.stringify(buildError(target, entries, limit, scanErr));

  const next = [...entries];
  next[match.idx] = content;
  const nextChars = next.join(ENTRY_DELIMITER).length;
  if (nextChars > limit) {
    return JSON.stringify(buildError(target, entries, limit, `Replacement would exceed limit (${limit} chars).`));
  }
  if (isLegacyFactsRow(match.row)) {
    await sql`
      UPDATE facts
      SET value = ${content}, category = ${categoryForTarget(target)}, updated_at = ${new Date().toISOString()}
      WHERE id = ${match.row.id} AND agent_name = ${agentName} AND org_id = ${orgId}
    `;
  } else {
    await sql`
      UPDATE curated_memory
      SET content = ${content}, content_hash = ${await sha256Hex(content)}, updated_at = ${new Date().toISOString()}
      WHERE id = ${match.row.id} AND agent_name = ${agentName} AND org_id = ${orgId}
    `;
  }
  return JSON.stringify(buildSuccess(target, next, limit, "Entry replaced."));
}

export async function loadCuratedMemorySnapshot(
  env: RuntimeEnv,
  opts: { agent_name?: string; org_id?: string },
): Promise<CuratedSnapshot> {
  const hyperdrive = (env as any).HYPERDRIVE as Hyperdrive | undefined;
  if (!hyperdrive) return {};
  const agentName = String(opts.agent_name || (env as any).__agentConfig?.name || "my-assistant");
  const orgId = resolveOrgIdStrict(opts.org_id || (env as any).__agentConfig?.org_id || "");
  if (!orgId) return {};
  const sql = await getDb(hyperdrive);
  const limits = await resolveCharLimits(sql, orgId, agentName);
  const [memoryRows, userRows] = await Promise.all([
    loadRowsForTarget(sql, agentName, orgId, "memory").catch(() => []),
    loadRowsForTarget(sql, agentName, orgId, "user").catch(() => []),
  ]);
  const memoryEntries = normalizeEntries(memoryRows);
  const userEntries = normalizeEntries(userRows);
  return {
    memory_block: formatPromptBlock("memory", memoryEntries, limits.memory) || undefined,
    user_block: formatPromptBlock("user", userEntries, limits.user) || undefined,
  };
}
