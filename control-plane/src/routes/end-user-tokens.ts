/**
 * End-user token routes — mint, list, revoke, and query usage for end-user session tokens.
 *
 * SaaS customers use their API key to create short-lived JWTs for their end-users.
 * These tokens grant limited scopes (agents:run only) and carry per-user rate limits.
 *
 * All routes require API key auth (the SaaS customer's key).
 */
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import type { CurrentUser } from "../auth/types";
import { createToken } from "../auth/jwt";
import { getDbForOrg } from "../db/client";
import { requireScope } from "../middleware/auth";

type R = { Bindings: Env; Variables: { user: CurrentUser } };
export const endUserTokenRoutes = new Hono<R>();

// ── Zod schemas ──────────────────────────────────────────────────────────

const MintTokenRequest = z.object({
  end_user_id: z.string().min(1).max(255),
  allowed_agents: z.array(z.string()).optional(),
  expires_in_seconds: z.number().int().positive().max(86400).optional(), // max 24h
  rate_limit_rpm: z.number().int().positive().optional(),
  rate_limit_rpd: z.number().int().positive().optional(),
});

// ── Helpers ──────────────────────────────────────────────────────────────

function generateId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

function ensureUser(user: CurrentUser): boolean {
  return !!user.user_id && !!user.org_id;
}

const DEFAULT_EXPIRY_SECONDS = 3600; // 1 hour
const MAX_EXPIRY_SECONDS = 86400; // 24 hours

// ── POST / — Mint a new end-user token ───────────────────────────────────

endUserTokenRoutes.post("/", requireScope("api_keys:write"), async (c) => {
  const user = c.get("user");
  if (!ensureUser(user)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const body = await c.req.json().catch(() => ({}));
  const parsed = MintTokenRequest.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation failed", detail: parsed.error.issues[0]?.message }, 400);
  }
  const req = parsed.data;

  const expirySeconds = Math.min(req.expires_in_seconds ?? DEFAULT_EXPIRY_SECONDS, MAX_EXPIRY_SECONDS);
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = new Date((now + expirySeconds) * 1000).toISOString();

  // Create the JWT with end-user claims
  const token = await createToken(c.env.AUTH_JWT_SECRET, req.end_user_id, {
    org_id: user.org_id,
    expiry_seconds: expirySeconds,
    extra: {
      type: "end_user",
      api_key_id: user.user_id,
      allowed_agents: req.allowed_agents ?? [],
    },
  });

  // Persist to DB
  const tokenId = generateId();
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  await sql`
    INSERT INTO end_user_tokens (
      token_id, org_id, end_user_id, api_key_id, allowed_agents,
      rate_limit_rpm, rate_limit_rpd, expires_at, is_revoked, created_at
    ) VALUES (
      ${tokenId}, ${user.org_id}, ${req.end_user_id}, ${user.user_id},
      ${JSON.stringify(req.allowed_agents ?? [])},
      ${req.rate_limit_rpm ?? 60}, ${req.rate_limit_rpd ?? 10000},
      ${expiresAt}, ${false}, ${new Date().toISOString()}
    )
  `;

  return c.json({
    token,
    token_id: tokenId,
    end_user_id: req.end_user_id,
    expires_at: expiresAt,
    allowed_agents: req.allowed_agents ?? [],
    rate_limit_rpm: req.rate_limit_rpm ?? 60,
    rate_limit_rpd: req.rate_limit_rpd ?? 10000,
  });
});

// ── GET / — List active end-user tokens for the org ──────────────────────

endUserTokenRoutes.get("/", requireScope("api_keys:read"), async (c) => {
  const user = c.get("user");
  if (!ensureUser(user)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const limit = Math.min(Number(c.req.query("limit") || 50), 200);
  const offset = Number(c.req.query("offset") || 0);
  const endUserId = c.req.query("end_user_id") || "";

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  let rows;
  if (endUserId) {
    rows = await sql`
      SELECT token_id, end_user_id, api_key_id, allowed_agents, rate_limit_rpm,
             rate_limit_rpd, expires_at, is_revoked, created_at
      FROM end_user_tokens
      WHERE org_id = ${user.org_id} AND end_user_id = ${endUserId} AND is_revoked = false
        AND expires_at > now()
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  } else {
    rows = await sql`
      SELECT token_id, end_user_id, api_key_id, allowed_agents, rate_limit_rpm,
             rate_limit_rpd, expires_at, is_revoked, created_at
      FROM end_user_tokens
      WHERE org_id = ${user.org_id} AND is_revoked = false AND expires_at > now()
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  }

  const tokens = rows.map((r: any) => {
    let allowedAgents: string[] = [];
    try {
      allowedAgents = typeof r.allowed_agents === "string"
        ? JSON.parse(r.allowed_agents)
        : Array.isArray(r.allowed_agents) ? r.allowed_agents : [];
    } catch {}

    return {
      token_id: r.token_id,
      end_user_id: r.end_user_id,
      api_key_id: r.api_key_id,
      allowed_agents: allowedAgents,
      rate_limit_rpm: Number(r.rate_limit_rpm || 60),
      rate_limit_rpd: Number(r.rate_limit_rpd || 10000),
      expires_at: r.expires_at,
      is_revoked: Boolean(r.is_revoked),
      created_at: r.created_at,
    };
  });

  return c.json({ tokens });
});

// ── DELETE /:token_id — Revoke a token ───────────────────────────────────

endUserTokenRoutes.delete("/:token_id", requireScope("api_keys:write"), async (c) => {
  const user = c.get("user");
  if (!ensureUser(user)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const tokenId = c.req.param("token_id");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const result = await sql`
    UPDATE end_user_tokens SET is_revoked = true
    WHERE token_id = ${tokenId} AND org_id = ${user.org_id}
    RETURNING token_id
  `;

  if (result.length === 0) {
    return c.json({ error: "Token not found" }, 404);
  }

  return c.json({ revoked: tokenId });
});

// ── GET /usage/:end_user_id — Get usage stats for a specific end-user ────

endUserTokenRoutes.get("/usage/:end_user_id", requireScope("api_keys:read"), async (c) => {
  const user = c.get("user");
  if (!ensureUser(user)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const endUserId = c.req.param("end_user_id");
  const days = Math.min(Number(c.req.query("days") || 30), 90);

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  // Aggregate totals
  const totals = await sql`
    SELECT
      COUNT(*)::int AS total_requests,
      COALESCE(SUM(cost_usd), 0)::float AS total_cost_usd,
      COALESCE(SUM(tokens_used), 0)::int AS total_tokens
    FROM end_user_usage
    WHERE org_id = ${user.org_id} AND end_user_id = ${endUserId}
      AND created_at > now() - ${days + " days"}::interval
  `;

  // Per-agent breakdown
  const byAgent = await sql`
    SELECT
      agent_name,
      COUNT(*)::int AS requests,
      COALESCE(SUM(cost_usd), 0)::float AS cost_usd,
      COALESCE(SUM(tokens_used), 0)::int AS tokens,
      COALESCE(AVG(latency_ms), 0)::float AS avg_latency_ms
    FROM end_user_usage
    WHERE org_id = ${user.org_id} AND end_user_id = ${endUserId}
      AND created_at > now() - ${days + " days"}::interval
    GROUP BY agent_name
    ORDER BY requests DESC
  `;

  const row = totals[0] || {};

  return c.json({
    end_user_id: endUserId,
    period_days: days,
    total_requests: Number(row.total_requests || 0),
    total_cost_usd: Number(row.total_cost_usd || 0),
    total_tokens: Number(row.total_tokens || 0),
    by_agent: byAgent.map((r: any) => ({
      agent_name: r.agent_name,
      requests: Number(r.requests || 0),
      cost_usd: Number(r.cost_usd || 0),
      tokens: Number(r.tokens || 0),
      avg_latency_ms: Math.round(Number(r.avg_latency_ms || 0)),
    })),
  });
});
