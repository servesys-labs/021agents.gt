/**
 * Agent Marketplace routes — publish, discover, rate, feature.
 *
 * Public endpoints (no auth): search, browse categories
 * Authenticated endpoints: publish, update, rate, purchase featured
 */

import { createRoute, z } from "@hono/zod-openapi";
import { createOpenAPIRouter } from "../lib/openapi";
import { ErrorSchema, errorResponses } from "../schemas/openapi";
import { withOrgDb, withAdminDb } from "../db/client";
import { requireScope } from "../middleware/auth";
import { failSafe } from "../lib/error-response";
import {
  searchMarketplace,
  submitRating,
  purchaseFeatured,
  updateQualityScore,
  MARKETPLACE_CATEGORIES,
} from "../logic/marketplace";

export const marketplaceRoutes = createOpenAPIRouter();

// ── GET /search — Public agent discovery ─────────────────────

const searchRoute = createRoute({
  method: "get",
  path: "/search",
  tags: ["Marketplace"],
  summary: "Search the agent marketplace by natural language query",
  request: {
    query: z.object({
      q: z.string().min(1).max(500),
      category: z.string().optional(),
      max_price: z.coerce.number().optional(),
      min_quality: z.coerce.number().min(0).max(1).optional(),
      limit: z.coerce.number().min(1).max(100).default(20),
    }),
  },
  responses: {
    200: { description: "Search results", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(400, 500),
  },
});

marketplaceRoutes.openapi(searchRoute, async (c): Promise<any> => {
  const { q, category, max_price, min_quality, limit } = c.req.valid("query");
  const user = c.get("user") as any;

  // Public discovery endpoint — no auth required. The marketplace_listings
  // RLS policy permits cross-org reads where is_published = true, but the
  // search query intentionally aggregates broadly across all published
  // listings, so withAdminDb is the right tool.
  return await withAdminDb(c.env, async (sql) => {
    const results = await searchMarketplace(sql, q, {
      category,
      max_price_usd: max_price,
      min_quality: min_quality,
      limit,
      querier_org_id: user?.org_id,
      querier_agent_name: user?.agent_name,
    });

    return c.json(results);
  });
});

// ── GET /categories — List marketplace categories ────────────

const categoriesRoute = createRoute({
  method: "get",
  path: "/categories",
  tags: ["Marketplace"],
  summary: "List available marketplace categories",
  responses: {
    200: { description: "Categories", content: { "application/json": { schema: z.record(z.unknown()) } } },
  },
});

marketplaceRoutes.openapi(categoriesRoute, async (c): Promise<any> => {
  return c.json({ categories: MARKETPLACE_CATEGORIES });
});

// ── POST /publish — Publish agent to marketplace ─────────────

const publishRoute = createRoute({
  method: "post",
  path: "/publish",
  tags: ["Marketplace"],
  summary: "Publish an agent to the marketplace",
  middleware: [requireScope("agents:write")],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            agent_name: z.string().min(1),
            display_name: z.string().min(1).max(100),
            short_description: z.string().min(10).max(200),
            long_description: z.string().max(5000).optional(),
            category: z.enum(MARKETPLACE_CATEGORIES as any),
            subcategory: z.string().max(50).optional(),
            tags: z.array(z.string()).max(10).default([]),
            price_per_task_usd: z.number().min(0).max(1000).default(0),
            price_per_1k_tokens_usd: z.number().min(0).max(100).default(0),
            free_tier_tasks: z.number().int().min(0).max(1000).default(0),
            pricing_model: z.enum(["fixed", "cost_plus", "per_token"]).default("fixed"),
            cost_plus_margin_pct: z.number().min(0).max(500).default(0),
            price_per_1k_input_tokens_usd: z.number().min(0).max(100).default(0),
            price_per_1k_output_tokens_usd: z.number().min(0).max(100).default(0),
            agent_type: z.enum(["agent", "skill"]).default("agent"),
            sla_response_time_ms: z.number().int().optional(),
            sla_uptime_pct: z.number().min(0).max(100).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Published listing", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(400, 409, 500),
  },
});

marketplaceRoutes.openapi(publishRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const body = c.req.valid("json");

  return await withOrgDb(c.env, user.org_id, async (sql) => {
    // Verify agent exists
    const agentRows = await sql`
      SELECT name FROM agents WHERE name = ${body.agent_name} AND is_active = true LIMIT 1
    `;
    if (agentRows.length === 0) return c.json({ error: "Agent not found or inactive" }, 404);

    const baseUrl = `https://api.oneshots.co/api/v1`;

    try {
      const [listing] = await sql`
      INSERT INTO marketplace_listings (
        agent_name, org_id, display_name, short_description, description,
        category, tags, price_per_task_usd, pricing_model, cost_plus_margin_pct,
        agent_type, sla_response_time_ms,
        agent_card_url, a2a_endpoint_url, is_published
      ) VALUES (
        ${body.agent_name}, ${user.org_id}, ${body.display_name}, ${body.short_description},
        ${body.long_description || ''}, ${body.category},
        ${JSON.stringify(body.tags)}::jsonb, ${body.price_per_task_usd}, ${body.pricing_model}, ${body.cost_plus_margin_pct},
        ${body.agent_type}, ${body.sla_response_time_ms || null},
        ${baseUrl + '/.well-known/agent.json?agent=' + body.agent_name},
        ${baseUrl + '/a2a?org=' + user.org_id + '&agent=' + body.agent_name},
        true
      )
      ON CONFLICT (agent_name, org_id) DO UPDATE SET
        display_name = ${body.display_name}, short_description = ${body.short_description},
        description = ${body.long_description || ''}, category = ${body.category},
        tags = ${JSON.stringify(body.tags)}::jsonb, price_per_task_usd = ${body.price_per_task_usd},
        pricing_model = ${body.pricing_model},
        cost_plus_margin_pct = ${body.cost_plus_margin_pct},
        agent_type = ${body.agent_type}, is_published = true, updated_at = now()
      RETURNING id
    `;

      // Sync pricing to agent's config (the x-402 gate reads from here)
      if (body.price_per_task_usd > 0 || body.price_per_1k_tokens_usd > 0) {
        try {
          const [agentRow] = await sql`SELECT config FROM agents WHERE name = ${body.agent_name}`;
          const cfg = typeof agentRow.config === "string" ? JSON.parse(agentRow.config) : agentRow.config || {};
          cfg.pricing = {
            price_per_task_usd: body.price_per_task_usd,
            price_per_1k_tokens_usd: body.price_per_1k_tokens_usd,
          };
          await sql`UPDATE agents SET config = ${JSON.stringify(cfg)}, updated_at = now() WHERE name = ${body.agent_name}`;
        } catch {} // non-blocking — listing is still created
      }

      return c.json({
        published: true,
        listing_id: listing.id,
        agent_name: body.agent_name,
        org_id: user.org_id,
        category: body.category,
        agent_type: body.agent_type,
        pricing_model: body.pricing_model,
        price_per_task_usd: body.price_per_task_usd,
        cost_plus_margin_pct: body.cost_plus_margin_pct,
        agent_card_url: baseUrl + '/.well-known/agent.json?agent=' + body.agent_name,
        a2a_endpoint_url: baseUrl + '/a2a?org=' + user.org_id + '&agent=' + body.agent_name,
      });
    } catch (err) {
      return c.json(failSafe(err, "marketplace/publish", { userMessage: "Couldn't publish the agent to the marketplace. Please try again in a moment." }), 500);
    }
  });
});

// ── POST /rate — Rate an agent after A2A transaction ─────────

const rateRoute = createRoute({
  method: "post",
  path: "/rate",
  tags: ["Marketplace"],
  summary: "Rate an agent after using it via A2A",
  middleware: [requireScope("agents:read")],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            listing_id: z.string().min(1),
            rating: z.number().int().min(1).max(5),
            review_text: z.string().max(1000).optional(),
            task_id: z.string().optional(),
            response_time_ms: z.number().int().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Rating submitted", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(400, 500),
  },
});

marketplaceRoutes.openapi(rateRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const body = c.req.valid("json");

  return await withOrgDb(c.env, user.org_id, async (sql) => {
    // Prevent self-rating. marketplace_listings RLS allows cross-org reads
    // for is_published rows, so this lookup still works under withOrgDb.
    const [listing] = await sql`SELECT org_id FROM marketplace_listings WHERE id = ${body.listing_id} LIMIT 1`;
    if (listing && String(listing.org_id) === user.org_id) {
      return c.json({ error: "Cannot rate your own agent" }, 403);
    }

    // Phase 10.2: Anti-fraud — velocity checks. RLS on marketplace_ratings
    // filters by rater_org_id automatically.
    const recentRatings = await sql`
      SELECT COUNT(*) as cnt FROM marketplace_ratings
      WHERE listing_id = ${body.listing_id}
        AND created_at > NOW() - INTERVAL '24 hours'
    `;
    if (Number(recentRatings[0]?.cnt || 0) >= 3) {
      return c.json({ error: "Rating limit: max 3 ratings per listing per 24h" }, 429);
    }
    const hourlyRatings = await sql`
      SELECT COUNT(*) as cnt FROM marketplace_ratings
      WHERE listing_id = ${body.listing_id}
        AND created_at > NOW() - INTERVAL '1 hour'
    `;
    if (Number(hourlyRatings[0]?.cnt || 0) >= 10) {
      return c.json({ error: "This listing has reached its hourly rating limit" }, 429);
    }

    // Phase 10.2: Rating credibility weight based on account age + spend
    let credibilityWeight = 1.0;
    try {
      const orgAge = await sql`
        SELECT EXTRACT(EPOCH FROM (NOW() - created_at)) / 86400 as age_days
        FROM organizations WHERE org_id = ${user.org_id} LIMIT 1
      `;
      const ageDays = Number(orgAge[0]?.age_days || 0);
      if (ageDays < 7) credibilityWeight = 0.1;
      else if (ageDays < 30) credibilityWeight = 0.5;
      // Spend check: weight by total spend
      const spend = await sql`
        SELECT COALESCE(SUM(amount_usd), 0) as total FROM credit_transactions
        WHERE type = 'burn'
      `;
      const totalSpend = Number(spend[0]?.total || 0);
      if (totalSpend < 1) credibilityWeight *= 0.2;
      else if (totalSpend < 10) credibilityWeight *= 0.7;
    } catch { /* best-effort — default full weight */ }

    // Apply credibility weight: weighted_rating = raw_rating * weight
    // Low-credibility ratings contribute less to the average
    const weightedRating = Math.round(body.rating * credibilityWeight * 100) / 100;

    await submitRating(sql, body.listing_id, user.org_id, weightedRating, {
      task_id: body.task_id,
      review_text: body.review_text,
      response_time_ms: body.response_time_ms,
      credibility_weight: credibilityWeight,
      raw_rating: body.rating,
    });

    return c.json({ rated: true, listing_id: body.listing_id, rating: body.rating, credibility_weight: credibilityWeight });
  });
});

// ── POST /feature — Purchase featured placement ──────────────

const featureRoute = createRoute({
  method: "post",
  path: "/feature",
  tags: ["Marketplace"],
  summary: "Purchase featured placement for a marketplace listing",
  middleware: [requireScope("billing:write")],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            listing_id: z.string().min(1),
            duration_days: z.number().int().min(1).max(90).default(7),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Featured placement purchased", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(400, 500),
  },
});

marketplaceRoutes.openapi(featureRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const body = c.req.valid("json");

  return await withOrgDb(c.env, user.org_id, async (sql) => {
    // Pricing: $1/day for featured placement
    const costUsd = body.duration_days * 1.0;

    const result = await purchaseFeatured(sql, body.listing_id, user.org_id, body.duration_days, costUsd);

    if (!result.success) return c.json({ error: result.error }, 400);

    return c.json({
      featured: true,
      listing_id: body.listing_id,
      duration_days: body.duration_days,
      cost_usd: costUsd,
      featured_until: result.featured_until,
    });
  });
});

// ── GET /listings/:agent_name — Get listing detail ───────────

const listingDetailRoute = createRoute({
  method: "get",
  path: "/listings/{agent_name}",
  tags: ["Marketplace"],
  summary: "Get marketplace listing detail for an agent",
  request: { params: z.object({ agent_name: z.string() }) },
  responses: {
    200: { description: "Listing detail", content: { "application/json": { schema: z.record(z.unknown()) } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    ...errorResponses(500),
  },
});

marketplaceRoutes.openapi(listingDetailRoute, async (c): Promise<any> => {
  const { agent_name } = c.req.valid("param");

  // Public listing detail endpoint — no auth required. Aggregates ratings
  // across all rater orgs, so withAdminDb is the right tool.
  return await withAdminDb(c.env, async (sql) => {
    const [listing] = await sql`
      SELECT * FROM marketplace_listings WHERE agent_name = ${agent_name} AND is_published = true LIMIT 1
    `;
    if (!listing) return c.json({ error: "Listing not found" }, 404);

    // Get recent ratings
    const ratings = await sql`
      SELECT rating, review_text, created_at FROM marketplace_ratings
      WHERE listing_id = ${listing.id} ORDER BY created_at DESC LIMIT 10
    `;

    return c.json({
      ...listing,
      price_per_task_usd: Number(listing.price_per_task_usd),
      quality_score: Number(listing.quality_score),
      avg_rating: Number(listing.avg_rating),
      total_ratings: Number(listing.total_ratings),
      recent_ratings: ratings.map((r: any) => ({
        rating: r.rating,
        review: r.review_text,
        date: r.created_at,
      })),
    });
  });
});

// ── POST /unpublish — Remove agent from marketplace ──────────

const unpublishRoute = createRoute({
  method: "post",
  path: "/unpublish",
  tags: ["Marketplace"],
  summary: "Remove an agent from the marketplace",
  middleware: [requireScope("agents:write")],
  request: {
    body: { content: { "application/json": { schema: z.object({ agent_name: z.string().min(1) }) } } },
  },
  responses: {
    200: { description: "Unpublished", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(400, 404, 500),
  },
});

marketplaceRoutes.openapi(unpublishRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { agent_name } = c.req.valid("json");

  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const updated = await sql`
      UPDATE marketplace_listings SET is_published = false, is_featured = false, updated_at = now()
      WHERE agent_name = ${agent_name}
    `;

    if (updated.count === 0) return c.json({ error: "Listing not found" }, 404);
    return c.json({ unpublished: true, agent_name });
  });
});
