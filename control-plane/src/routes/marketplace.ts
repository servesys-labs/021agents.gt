/**
 * Agent Marketplace routes — publish, discover, rate, feature.
 *
 * Public endpoints (no auth): search, browse categories
 * Authenticated endpoints: publish, update, rate, purchase featured
 */

import { createRoute, z } from "@hono/zod-openapi";
import { createOpenAPIRouter } from "../lib/openapi";
import { ErrorSchema, errorResponses } from "../schemas/openapi";
import { getDbForOrg } from "../db/client";
import { requireScope } from "../middleware/auth";
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
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user?.org_id || "public");

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
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  // Verify agent exists
  const agentRows = await sql`
    SELECT name FROM agents WHERE name = ${body.agent_name} AND org_id = ${user.org_id} AND is_active = 1 LIMIT 1
  `;
  if (agentRows.length === 0) return c.json({ error: "Agent not found or inactive" }, 404);

  const baseUrl = `https://api.oneshots.co/api/v1`;

  try {
    const [listing] = await sql`
      INSERT INTO marketplace_listings (
        agent_name, org_id, display_name, short_description, long_description,
        category, subcategory, tags, price_per_task_usd, price_per_1k_tokens_usd,
        free_tier_tasks, sla_response_time_ms, sla_uptime_pct,
        agent_card_url, a2a_endpoint_url, is_published
      ) VALUES (
        ${body.agent_name}, ${user.org_id}, ${body.display_name}, ${body.short_description},
        ${body.long_description || ''}, ${body.category}, ${body.subcategory || ''},
        ${body.tags}, ${body.price_per_task_usd}, ${body.price_per_1k_tokens_usd},
        ${body.free_tier_tasks}, ${body.sla_response_time_ms || null}, ${body.sla_uptime_pct || null},
        ${baseUrl + '/.well-known/agent.json?agent=' + body.agent_name},
        ${baseUrl + '/a2a?org=' + user.org_id + '&agent=' + body.agent_name},
        true
      )
      ON CONFLICT (agent_name, org_id) DO UPDATE SET
        display_name = ${body.display_name}, short_description = ${body.short_description},
        long_description = ${body.long_description || ''}, category = ${body.category},
        tags = ${body.tags}, price_per_task_usd = ${body.price_per_task_usd},
        price_per_1k_tokens_usd = ${body.price_per_1k_tokens_usd},
        free_tier_tasks = ${body.free_tier_tasks}, is_published = true, updated_at = now()
      RETURNING id
    `;

    // Sync pricing to agent's config_json (the x-402 gate reads from here)
    if (body.price_per_task_usd > 0 || body.price_per_1k_tokens_usd > 0) {
      try {
        const [agentRow] = await sql`SELECT config_json FROM agents WHERE name = ${body.agent_name} AND org_id = ${user.org_id}`;
        const cfg = typeof agentRow.config_json === "string" ? JSON.parse(agentRow.config_json) : agentRow.config_json || {};
        cfg.pricing = {
          price_per_task_usd: body.price_per_task_usd,
          price_per_1k_tokens_usd: body.price_per_1k_tokens_usd,
        };
        await sql`UPDATE agents SET config_json = ${JSON.stringify(cfg)}, updated_at = now() WHERE name = ${body.agent_name} AND org_id = ${user.org_id}`;
      } catch {} // non-blocking — listing is still created
    }

    return c.json({
      published: true,
      listing_id: listing.id,
      agent_name: body.agent_name,
      org_id: user.org_id,
      category: body.category,
      price_per_task_usd: body.price_per_task_usd,
      agent_card_url: baseUrl + '/.well-known/agent.json?agent=' + body.agent_name,
      a2a_endpoint_url: baseUrl + '/a2a?org=' + user.org_id + '&agent=' + body.agent_name,
    });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
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
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  // Prevent self-rating
  const [listing] = await sql`SELECT org_id FROM marketplace_listings WHERE id = ${body.listing_id} LIMIT 1`;
  if (listing && String(listing.org_id) === user.org_id) {
    return c.json({ error: "Cannot rate your own agent" }, 403);
  }

  await submitRating(sql, body.listing_id, user.org_id, body.rating, {
    task_id: body.task_id,
    review_text: body.review_text,
    response_time_ms: body.response_time_ms,
  });

  return c.json({ rated: true, listing_id: body.listing_id, rating: body.rating });
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
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

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
  const user = c.get("user") as any;
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user?.org_id || "public");

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
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const updated = await sql`
    UPDATE marketplace_listings SET is_published = false, is_featured = false, updated_at = now()
    WHERE agent_name = ${agent_name} AND org_id = ${user.org_id}
  `;

  if (updated.count === 0) return c.json({ error: "Listing not found" }, 404);
  return c.json({ unpublished: true, agent_name });
});
