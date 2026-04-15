/**
 * End-user JWT resolver.
 *
 * End-user tokens are issued by a parent API key for a specific
 * external user of the customer's product. They carry limited scopes
 * and inherit rate limits + IP allowlist from the parent key.
 *
 * The JWT signature has already been verified by resolve-jwt, so the
 * `claims.org_id` is trustworthy and we can use withOrgDb here — RLS
 * then correctly filters the end_user_tokens and api_keys lookups to
 * the caller's org. A forged org_id on a signed-but-valid JWT would
 * simply not find its token row in the target org and get a 401.
 */
import type { Env } from "../../env";
import type { CurrentUser, TokenClaims } from "../../auth/types";
import { withOrgDb } from "../../db/client";

export async function resolveEndUserToken(
  claims: TokenClaims,
  env: Env,
): Promise<CurrentUser> {
  const orgId = claims.org_id || "";
  if (!orgId) {
    throw Object.assign(new Error("End-user token missing org_id"), { status: 401 });
  }

  const endUserId = claims.sub;
  const apiKeyId = String(claims.api_key_id || "");

  return await withOrgDb(env, orgId, async (sql) => {
    const rows = await sql`
      SELECT token_id, api_key_id, allowed_agents, rate_limit_rpm, rate_limit_rpd, is_revoked, expires_at
      FROM end_user_tokens
      WHERE end_user_id = ${endUserId} AND api_key_id = ${apiKeyId}
        AND is_revoked = false AND expires_at > now()
      ORDER BY created_at DESC LIMIT 1
    `;

    if (rows.length === 0) {
      throw Object.assign(new Error("End-user token revoked or expired"), { status: 401 });
    }

    const row = rows[0];

    // allowed_agents: prefer claims, fall back to DB row
    let allowedAgents: string[] = [];
    try {
      const claimAgents = claims.allowed_agents;
      if (Array.isArray(claimAgents)) {
        allowedAgents = claimAgents.map(String);
      } else if (row.allowed_agents) {
        allowedAgents = typeof row.allowed_agents === "string"
          ? JSON.parse(row.allowed_agents)
          : Array.isArray(row.allowed_agents) ? row.allowed_agents : [];
      }
    } catch {}

    // Inherit parent API key IP allowlist. RLS on api_keys filters by
    // current_org_id() automatically — no WHERE org_id clause needed.
    let ipAllowlist: string[] = [];
    try {
      if (row.api_key_id) {
        const keyRows = await sql`
          SELECT ip_allowlist FROM api_keys
          WHERE key_id = ${String(row.api_key_id)} AND is_active = true
          LIMIT 1
        `;
        const allow = keyRows[0]?.ip_allowlist;
        if (Array.isArray(allow)) {
          ipAllowlist = allow.filter((v: unknown) => typeof v === "string" && v.length > 0);
        } else if (typeof allow === "string" && allow.trim()) {
          try {
            const parsed = JSON.parse(allow);
            if (Array.isArray(parsed)) {
              ipAllowlist = parsed.filter((v: unknown) => typeof v === "string" && v.length > 0);
            }
          } catch {}
        }
      }
    } catch {}

    return {
      user_id: endUserId,
      email: "",
      name: "",
      org_id: orgId,
      project_id: "",
      env: "",
      role: "viewer",
      scopes: ["agents:run"],
      auth_method: "end_user_token",
      rateLimitRpm: Number(row.rate_limit_rpm) || 60,
      rateLimitRpd: Number(row.rate_limit_rpd) || 10000,
      allowedAgents: allowedAgents.length > 0 ? allowedAgents : undefined,
      ipAllowlist: ipAllowlist.length > 0 ? ipAllowlist : undefined,
      endUserApiKeyId: apiKeyId,
    };
  });
}
