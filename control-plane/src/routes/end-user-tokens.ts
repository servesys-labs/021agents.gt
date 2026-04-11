/**
 * End-user token routes — mint, list, revoke, and query usage for end-user session tokens.
 *
 * SaaS customers use their API key to create short-lived JWTs for their end-users.
 * These tokens grant limited scopes (agents:run only) and carry per-user rate limits.
 *
 * All routes require API key auth (the SaaS customer's key).
 */
import { createRoute, z } from "@hono/zod-openapi";
import { createOpenAPIRouter } from "../lib/openapi";
import { ErrorSchema, errorResponses } from "../schemas/openapi";
import type { CurrentUser } from "../auth/types";
import { createToken } from "../auth/jwt";
import { withOrgDb } from "../db/client";
import { requireScope, invalidateAuthCache } from "../middleware/auth";

export const endUserTokenRoutes = createOpenAPIRouter();

// ── Zod schemas ──────────────────────────────────────────────────────────

const MintTokenRequest = z.object({
  end_user_id: z.string().min(1).max(255),
  allowed_agents: z.array(z.string()).optional(),
  expires_in_seconds: z.number().int().positive().max(86400).optional(), // max 24h
  rate_limit_rpm: z.number().int().positive().optional(),
  rate_limit_rpd: z.number().int().positive().optional(),
});

const EndUserTokenSummary = z.object({
  token_id: z.string(),
  end_user_id: z.string(),
  api_key_id: z.string(),
  allowed_agents: z.array(z.string()),
  rate_limit_rpm: z.number(),
  rate_limit_rpd: z.number(),
  expires_at: z.string(),
  is_revoked: z.boolean(),
  created_at: z.string(),
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

const mintTokenRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["End User Tokens"],
  summary: "Mint a new end-user session token",
  middleware: [requireScope("api_keys:write")],
  request: {
    body: {
      content: {
        "application/json": { schema: MintTokenRequest },
      },
    },
  },
  responses: {
    200: {
      description: "Minted token",
      content: {
        "application/json": {
          schema: z.object({
            token: z.string(),
            token_id: z.string(),
            end_user_id: z.string(),
            expires_at: z.string(),
            allowed_agents: z.array(z.string()),
            rate_limit_rpm: z.number(),
            rate_limit_rpd: z.number(),
          }),
        },
      },
    },
    ...errorResponses(400, 401, 500),
  },
});
endUserTokenRoutes.openapi(mintTokenRoute, async (c): Promise<any> => {
  const user = c.get("user");
  if (!ensureUser(user)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const req = c.req.valid("json");

  const expirySeconds = Math.min(req.expires_in_seconds ?? DEFAULT_EXPIRY_SECONDS, MAX_EXPIRY_SECONDS);
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = new Date((now + expirySeconds) * 1000).toISOString();
  const parentApiKeyId = user.apiKeyId || user.user_id;

  // Create the JWT with end-user claims
  const token = await createToken(c.env.AUTH_JWT_SECRET, req.end_user_id, {
    org_id: user.org_id,
    expiry_seconds: expirySeconds,
    extra: {
      type: "end_user",
      // Prefer key_id for API-key auth; fallback keeps legacy JWT flows working.
      api_key_id: parentApiKeyId,
      allowed_agents: req.allowed_agents ?? [],
    },
  });

  // Persist to DB
  const tokenId = generateId();
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    await sql`
      INSERT INTO end_user_tokens (
        token_id, org_id, end_user_id, api_key_id, allowed_agents,
        rate_limit_rpm, rate_limit_rpd, expires_at, revoked, created_at
      ) VALUES (
        ${tokenId}, ${user.org_id}, ${req.end_user_id}, ${parentApiKeyId},
        ${req.allowed_agents ?? []},
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
});

// ── GET / — List active end-user tokens for the org ──────────────────────

const listTokensRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["End User Tokens"],
  summary: "List active end-user tokens",
  middleware: [requireScope("api_keys:read")],
  request: {
    query: z.object({
      limit: z.coerce.number().int().min(1).max(200).default(50).optional(),
      offset: z.coerce.number().int().min(0).default(0).optional(),
      end_user_id: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "Token list",
      content: { "application/json": { schema: z.object({ tokens: z.array(EndUserTokenSummary) }) } },
    },
    ...errorResponses(401, 500),
  },
});
endUserTokenRoutes.openapi(listTokensRoute, async (c): Promise<any> => {
  const user = c.get("user");
  if (!ensureUser(user)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const query = c.req.valid("query");
  const limit = Math.min(Number(query.limit || 50), 200);
  const offset = Number(query.offset || 0);
  const endUserId = query.end_user_id || "";

  return await withOrgDb(c.env, user.org_id, async (sql) => {
    let rows;
    if (endUserId) {
      rows = await sql`
        SELECT token_id, end_user_id, api_key_id, allowed_agents, rate_limit_rpm,
               rate_limit_rpd, expires_at, is_revoked, created_at
        FROM end_user_tokens
        WHERE end_user_id = ${endUserId} AND revoked = false
          AND expires_at > now()
        ORDER BY created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
    } else {
      rows = await sql`
        SELECT token_id, end_user_id, api_key_id, allowed_agents, rate_limit_rpm,
               rate_limit_rpd, expires_at, is_revoked, created_at
        FROM end_user_tokens
        WHERE revoked = false AND expires_at > now()
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
});

// ── DELETE /:token_id — Revoke a token ───────────────────────────────────

const revokeTokenRoute = createRoute({
  method: "delete",
  path: "/{token_id}",
  tags: ["End User Tokens"],
  summary: "Revoke an end-user token",
  middleware: [requireScope("api_keys:write")],
  request: {
    params: z.object({ token_id: z.string() }),
  },
  responses: {
    200: {
      description: "Token revoked",
      content: { "application/json": { schema: z.object({ revoked: z.string() }) } },
    },
    ...errorResponses(401, 404, 500),
  },
});
endUserTokenRoutes.openapi(revokeTokenRoute, async (c): Promise<any> => {
  const user = c.get("user");
  if (!ensureUser(user)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const { token_id: tokenId } = c.req.valid("param");
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const result = await sql`
      UPDATE end_user_tokens SET revoked = true
      WHERE token_id = ${tokenId}
      RETURNING token_id
    `;

    if (result.length === 0) {
      return c.json({ error: "Token not found" }, 404);
    }

    // Invalidate cached auth so revoked token is rejected immediately
    await invalidateAuthCache(c.env);

    return c.json({ revoked: tokenId });
  });
});

// ── GET /usage/:end_user_id — Get usage stats for a specific end-user ────

const getUsageRoute = createRoute({
  method: "get",
  path: "/usage/{end_user_id}",
  tags: ["End User Tokens"],
  summary: "Get usage stats for a specific end-user",
  middleware: [requireScope("api_keys:read")],
  request: {
    params: z.object({ end_user_id: z.string() }),
    query: z.object({
      days: z.coerce.number().int().min(1).max(90).default(30).optional(),
    }),
  },
  responses: {
    200: {
      description: "Usage statistics",
      content: {
        "application/json": {
          schema: z.object({
            end_user_id: z.string(),
            period_days: z.number(),
            total_requests: z.number(),
            total_cost_usd: z.number(),
            total_tokens: z.number(),
            by_agent: z.array(z.object({
              agent_name: z.string(),
              requests: z.number(),
              cost_usd: z.number(),
              tokens: z.number(),
              avg_latency_ms: z.number(),
            })),
          }),
        },
      },
    },
    ...errorResponses(401, 500),
  },
});
endUserTokenRoutes.openapi(getUsageRoute, async (c): Promise<any> => {
  const user = c.get("user");
  if (!ensureUser(user)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const { end_user_id: endUserId } = c.req.valid("param");
  const query = c.req.valid("query");
  const days = Math.min(Number(query.days || 30), 90);

  return await withOrgDb(c.env, user.org_id, async (sql) => {
    // Aggregate totals
    const totals = await sql`
      SELECT
        COUNT(*)::int AS total_requests,
        COALESCE(SUM(cost_usd), 0)::float AS total_cost_usd,
        COALESCE(SUM(input_tokens + output_tokens), 0)::int AS total_tokens
      FROM end_user_usage
      WHERE end_user_id = ${endUserId}
        AND created_at > now() - ${days + " days"}::interval
    `;

    // Per-agent breakdown
    const byAgent = await sql`
      SELECT
        agent_name,
        COUNT(*)::int AS requests,
        COALESCE(SUM(cost_usd), 0)::float AS cost_usd,
        COALESCE(SUM(input_tokens + output_tokens), 0)::int AS tokens,
        COALESCE(AVG(latency_ms), 0)::float AS avg_latency_ms
      FROM end_user_usage
      WHERE end_user_id = ${endUserId}
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
});
