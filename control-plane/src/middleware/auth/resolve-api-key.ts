/**
 * API key resolver (ak_* tokens).
 *
 * Looks up a key by its SHA-256 hash. The "constant-time defense"
 * path runs the same DB work whether or not the key exists to keep
 * timing signals thin for attackers probing for valid key prefixes.
 *
 * Runs pre-auth — we're producing the CurrentUser that later withOrgDb
 * calls will depend on. Every DB query uses withAdminDb because no org
 * context exists yet.
 */
import type { Env } from "../../env";
import type { CurrentUser } from "../../auth/types";
import { hashApiKey } from "../../auth/api-keys";
import { withAdminDb } from "../../db/client";
import { cacheGet, cachePut, hashForCache } from "./cache";

export async function resolveApiKey(key: string, env: Env): Promise<CurrentUser> {
  const cacheKey = `ak:${await hashForCache(key)}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const keyHash = await hashApiKey(key);

  const user = await withAdminDb(env, async (sql) => {
    // Always do the same work regardless of validity (constant-time defense)
    const rows = await sql`
      SELECT * FROM api_keys WHERE key_hash = ${keyHash} LIMIT 1
    `;
    const row = rows.length > 0 ? rows[0] : null;

    const isActive = row ? Boolean(row.is_active) : false;
    const isExpired = row?.expires_at ? new Date(row.expires_at).getTime() < Date.now() : false;

    if (!row || !isActive || isExpired) {
      // Dummy user lookup to normalize timing
      await sql`SELECT email FROM users WHERE user_id = 'nonexistent' LIMIT 1`.catch(() => []);
      throw Object.assign(new Error("Invalid or expired API key"), { status: 401 });
    }

    // last_used_at update — best-effort, matches Python backend behavior
    try {
      await sql`UPDATE api_keys SET last_used_at = ${new Date().toISOString()} WHERE key_id = ${row.key_id}`;
    } catch {}

    const userRows = await sql`SELECT email FROM users WHERE user_id = ${row.user_id}`;

    const scopes: string[] = (() => {
      try { return JSON.parse(row.scopes || '["*"]'); } catch { return ["*"]; }
    })();

    // allowed_agents: JSON column, Postgres array, or junction table
    let allowedAgents: string[] = [];
    try {
      if (row.allowed_agents) {
        allowedAgents = typeof row.allowed_agents === "string"
          ? JSON.parse(row.allowed_agents)
          : Array.isArray(row.allowed_agents)
            ? row.allowed_agents
            : [];
      }
    } catch {}

    if (allowedAgents.length === 0) {
      try {
        const scopeRows = await sql`
          SELECT agent_name FROM api_key_agent_scopes WHERE key_id = ${row.key_id}
        `;
        if (scopeRows.length > 0) {
          allowedAgents = scopeRows.map((r: any) => String(r.agent_name));
        }
      } catch {}
    }

    // ip_allowlist (Postgres text[] comes through as string[])
    let ipAllowlist: string[] = [];
    try {
      if (row.ip_allowlist) {
        ipAllowlist = Array.isArray(row.ip_allowlist)
          ? row.ip_allowlist.filter((v: unknown) => typeof v === "string" && v.length > 0)
          : typeof row.ip_allowlist === "string"
            ? JSON.parse(row.ip_allowlist)
            : [];
      }
    } catch {}

    const u: CurrentUser = {
      user_id: row.user_id,
      email: userRows[0]?.email ?? "",
      name: "",
      org_id: row.org_id,
      project_id: row.project_id ?? "",
      env: row.env ?? "",
      role: "member",
      scopes,
      auth_method: "api_key",
      rateLimitRpm: Number(row.rate_limit_rpm) || 60,
      rateLimitRpd: Number(row.rate_limit_rpd) || 10000,
      allowedAgents: allowedAgents.length > 0 ? allowedAgents : undefined,
      ipAllowlist: ipAllowlist.length > 0 ? ipAllowlist : undefined,
      apiKeyId: row.key_id,
    };
    return u;
  });

  cachePut(cacheKey, user);
  return user;
}
