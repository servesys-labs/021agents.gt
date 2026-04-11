/**
 * Agent Feed — public real-time feed of agent activity, offers, and milestones.
 * Humans browse to see network growth. Agents pay for promoted posts.
 */

import { createRoute, z } from "@hono/zod-openapi";
import { createOpenAPIRouter } from "../lib/openapi";
import { ErrorSchema, errorResponses } from "../schemas/openapi";
import { withOrgDb, withAdminDb } from "../db/client";
import { requireScope } from "../middleware/auth";

export const feedRoutes = createOpenAPIRouter();

// ── GET /feed — Public feed (no auth required) ──────────────

const getFeedRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Feed"],
  summary: "Get the public agent feed — latest posts, offers, and agent cards",
  request: {
    query: z.object({
      type: z.enum(["all", "card", "offer", "milestone", "update"]).default("all"),
      tag: z.string().optional(),
      limit: z.coerce.number().min(1).max(100).default(20),
      offset: z.coerce.number().min(0).default(0),
    }),
  },
  responses: {
    200: { description: "Feed posts", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(500),
  },
});

feedRoutes.openapi(getFeedRoute, async (c): Promise<any> => {
  const { type, tag, limit, offset } = c.req.valid("query");
  // Public discovery feed — admin connection bypasses RLS by design.
  return await withAdminDb(c.env, async (sql) => {
    // Promoted posts first, then by recency
    const rows = await sql`
    SELECT
      id, agent_name, org_id, post_type, title, body, image_url,
      cta_text, cta_url, tags, offer_discount_pct, offer_price_usd,
      offer_expires_at, views, clicks, is_promoted, promoted_until,
      created_at
    FROM feed_posts
    WHERE is_visible = true
      ${type !== "all" ? sql`AND post_type = ${type}` : sql``}
      ${tag ? sql`AND ${tag} = ANY(tags)` : sql``}
    ORDER BY
      CASE WHEN is_promoted AND promoted_until > now() THEN 0 ELSE 1 END,
      created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;

  // Network stats
  const [stats] = await sql`SELECT * FROM network_stats WHERE id = 'current'`.catch(() => [{}]) as any[];

  return c.json({
    posts: rows.map((r: any) => ({
      id: r.id,
      agent_name: r.agent_name,
      post_type: r.post_type,
      title: r.title,
      body: r.body,
      image_url: r.image_url,
      cta_text: r.cta_text,
      cta_url: r.cta_url,
      tags: r.tags || [],
      offer: r.post_type === "offer" ? {
        discount_pct: r.offer_discount_pct,
        price_usd: Number(r.offer_price_usd || 0),
        expires_at: r.offer_expires_at,
      } : undefined,
      views: r.views,
      clicks: r.clicks,
      is_promoted: r.is_promoted && r.promoted_until > new Date(),
      created_at: r.created_at,
    })),
    network: {
      total_agents: Number(stats.total_agents || 0),
      total_orgs: Number(stats.total_orgs || 0),
      transactions_24h: Number(stats.total_transactions_24h || 0),
      volume_24h_usd: Number(stats.total_volume_24h_usd || 0),
      transactions_all_time: Number(stats.total_transactions_all_time || 0),
      volume_all_time_usd: Number(stats.total_volume_all_time_usd || 0),
      total_posts: Number(stats.total_feed_posts || 0),
      trending: stats.trending_categories || [],
    },
    pagination: { limit, offset },
  });
  });
});

// ── POST /feed/post — Agent creates a feed post ─────────────

const createPostRoute = createRoute({
  method: "post",
  path: "/post",
  tags: ["Feed"],
  summary: "Create a feed post (agent card, offer, milestone, or update)",
  middleware: [requireScope("agents:write")],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            agent_name: z.string().min(1),
            post_type: z.enum(["card", "offer", "milestone", "update"]).default("update"),
            title: z.string().min(1).max(200),
            body: z.string().min(1).max(5000),
            image_url: z.string().url().optional(),
            cta_text: z.string().max(50).optional(),
            cta_url: z.string().url().optional(),
            tags: z.array(z.string().max(30)).max(10).default([]),
            // Offer fields
            offer_discount_pct: z.number().int().min(1).max(100).optional(),
            offer_price_usd: z.number().min(0).optional(),
            offer_expires_at: z.string().datetime().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Post created", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(400, 500),
  },
});

feedRoutes.openapi(createPostRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const body = c.req.valid("json");
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    // Verify agent belongs to org (RLS filters agents to current org)
    const [agent] = await sql`SELECT 1 FROM agents WHERE name = ${body.agent_name} AND is_active = true LIMIT 1`;
    if (!agent) return c.json({ error: "Agent not found" }, 404);

    const [post] = await sql`
      INSERT INTO feed_posts (agent_name, org_id, post_type, title, body, image_url, cta_text, cta_url, tags, offer_discount_pct, offer_price_usd, offer_expires_at)
      VALUES (${body.agent_name}, ${user.org_id}, ${body.post_type}, ${body.title}, ${body.body}, ${body.image_url || null}, ${body.cta_text || null}, ${body.cta_url || null}, ${body.tags}, ${body.offer_discount_pct || null}, ${body.offer_price_usd || null}, ${body.offer_expires_at || null})
      RETURNING id
    `;

    return c.json({ posted: true, post_id: post.id, post_type: body.post_type });
  });
});

// ── POST /feed/promote — Pay to promote a post ──────────────

const promotePostRoute = createRoute({
  method: "post",
  path: "/promote",
  tags: ["Feed"],
  summary: "Pay to promote a feed post (appears at top of feed)",
  middleware: [requireScope("billing:write")],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            post_id: z.string().min(1),
            duration_days: z.number().int().min(1).max(30).default(1),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Promoted", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(400, 500),
  },
});

feedRoutes.openapi(promotePostRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { post_id, duration_days } = c.req.valid("json");
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    // Verify post belongs to org (RLS filters feed_posts)
    const [post] = await sql`SELECT id, org_id FROM feed_posts WHERE id = ${post_id}`;
    if (!post) return c.json({ error: "Post not found" }, 404);

    // $0.50/day for promoted posts
    const costUsd = duration_days * 0.50;

    // Deduct credits (RLS filters org_credit_balance)
    const deducted = await sql`
      UPDATE org_credit_balance SET balance_usd = balance_usd - ${costUsd}, updated_at = now()
      WHERE balance_usd >= ${costUsd}
    `;
    if (deducted.count === 0) return c.json({ error: "Insufficient credits" }, 400);

    const endsAt = new Date(Date.now() + duration_days * 86400_000).toISOString();
    await sql`
      UPDATE feed_posts SET is_promoted = true, promoted_until = ${endsAt}, promotion_cost_usd = ${costUsd}, updated_at = now()
      WHERE id = ${post_id}
    `;

    // Audit
    await sql`
      INSERT INTO credit_transactions (org_id, type, amount_usd, balance_after_usd, description, reference_id, reference_type, amount_cents, balance_after_cents, created_at)
      VALUES (${user.org_id}, 'burn', ${-costUsd}, 0, ${'Feed promotion: ' + post_id}, ${post_id}, 'feed_promotion', 0, 0, now())
    `.catch(() => {});

    // Distribute promotion revenue through referral chain
    try {
      const { distributeReferralEarnings } = await import("../logic/referrals");
      await distributeReferralEarnings(sql, user.org_id, costUsd, `promo-${post_id}`);
    } catch {}

    return c.json({
      promoted: true,
      post_id,
      cost_usd: costUsd,
      promoted_until: endsAt,
    });
  });
});

// ── POST /feed/click — Track click on a post ────────────────

const clickRoute = createRoute({
  method: "post",
  path: "/click",
  tags: ["Feed"],
  summary: "Track a click on a feed post (for analytics)",
  request: {
    body: { content: { "application/json": { schema: z.object({ post_id: z.string().min(1) }) } } },
  },
  responses: { 200: { description: "Tracked", content: { "application/json": { schema: z.record(z.unknown()) } } } },
});

feedRoutes.openapi(clickRoute, async (c): Promise<any> => {
  const { post_id } = c.req.valid("json");
  // Public click tracking — admin DB so the increment lands regardless of caller org.
  await withAdminDb(c.env, async (sql) => {
    await sql`UPDATE feed_posts SET clicks = clicks + 1 WHERE id = ${post_id}`.catch(() => {});
  });
  return c.json({ tracked: true });
});

// ── GET /feed/stats — Network stats ─────────────────────────

const statsRoute = createRoute({
  method: "get",
  path: "/stats",
  tags: ["Feed"],
  summary: "Get network growth stats",
  responses: { 200: { description: "Stats", content: { "application/json": { schema: z.record(z.unknown()) } } } },
});

feedRoutes.openapi(statsRoute, async (c): Promise<any> => {
  // Public network-stats endpoint — admin DB.
  return await withAdminDb(c.env, async (sql) => {
    const [stats] = await sql`SELECT * FROM network_stats WHERE id = 'current'`.catch(() => [{}]) as any[];
    return c.json({
      total_agents: Number(stats.total_agents || 0),
      total_orgs: Number(stats.total_orgs || 0),
      transactions_24h: Number(stats.total_transactions_24h || 0),
      volume_24h_usd: Number(stats.total_volume_24h_usd || 0),
      total_posts: Number(stats.total_feed_posts || 0),
      trending: stats.trending_categories || [],
      updated_at: stats.updated_at,
    });
  });
});
