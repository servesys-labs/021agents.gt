/**
 * Agent Marketplace — discovery, matching, quality scoring.
 *
 * Replaces the ad model with capability-based matching:
 * - Agents publish capabilities + pricing to the marketplace
 * - Other agents discover them by intent, not keywords
 * - Ranking: quality score × relevance × price (not auction)
 * - Transactions via x-402 credit transfer
 * - Quality loop: ratings after each transaction update scores
 */

import type postgres from "postgres";
type Sql = ReturnType<typeof postgres>;

// ── Types ────────────────────────────────────────────────────

export interface MarketplaceListing {
  id: string;
  agent_name: string;
  org_id: string;
  display_name: string;
  short_description: string;
  category: string;
  tags: string[];
  price_per_task_usd: number;
  quality_score: number;
  total_tasks_completed: number;
  avg_rating: number;
  total_ratings: number;
  is_verified: boolean;
  is_featured: boolean;
  a2a_endpoint_url: string;
  agent_card_url: string;
}

export interface SearchResult {
  listings: MarketplaceListing[];
  total: number;
  query: string;
  category?: string;
}

export const MARKETPLACE_CATEGORIES = [
  "shopping", "research", "legal", "finance", "travel",
  "coding", "creative", "support", "data", "health",
  "education", "marketing", "hr", "operations", "other",
] as const;

export type MarketplaceCategory = typeof MARKETPLACE_CATEGORIES[number];

// ── Discovery ────────────────────────────────────────────────

/**
 * Search the marketplace by natural language query.
 * Ranks by: relevance (text match) × quality_score × inverse price.
 * Featured listings get a boost but don't dominate.
 */
export async function searchMarketplace(
  sql: Sql,
  query: string,
  opts: {
    category?: string;
    max_price_usd?: number;
    min_quality?: number;
    limit?: number;
    querier_org_id?: string;
    querier_agent_name?: string;
  } = {},
): Promise<SearchResult> {
  const limit = Math.min(opts.limit || 20, 100);
  const minQuality = opts.min_quality || 0;

  // Search with relevance scoring
  // ts_rank on description + tags, boosted by quality_score and featured status
  const rows = await sql`
    SELECT
      id, agent_name, org_id, display_name, short_description, category,
      tags, price_per_task_usd, quality_score, total_tasks_completed,
      avg_rating, total_ratings, is_verified, is_featured,
      a2a_endpoint_url, agent_card_url,
      -- Relevance score: text similarity + quality + featured boost
      (
        CASE WHEN to_tsvector('english', short_description) @@ plainto_tsquery('english', ${query}) THEN 0.4 ELSE 0 END +
        CASE WHEN to_tsvector('english', display_name) @@ plainto_tsquery('english', ${query}) THEN 0.3 ELSE 0 END +
        CASE WHEN tags @> ${JSON.stringify([query])}::jsonb THEN 0.2 ELSE 0 END +
        quality_score * 0.3 +
        CASE WHEN is_featured AND featured_until > now() THEN 0.15 ELSE 0 END +
        CASE WHEN is_verified THEN 0.1 ELSE 0 END
      ) AS relevance_score
    FROM marketplace_listings
    WHERE is_published = true
      AND quality_score >= ${minQuality}
      ${opts.category ? sql`AND category = ${opts.category}` : sql``}
      ${opts.max_price_usd ? sql`AND price_per_task_usd <= ${opts.max_price_usd}` : sql``}
    ORDER BY relevance_score DESC, quality_score DESC, total_tasks_completed DESC
    LIMIT ${limit}
  `;

  // Log the query for marketplace analytics
  if (opts.querier_org_id) {
    sql`
      INSERT INTO marketplace_queries (querier_org_id, querier_agent_name, query_text, category_filter, results_count, created_at)
      VALUES (${opts.querier_org_id}, ${opts.querier_agent_name || ''}, ${query.slice(0, 500)}, ${opts.category || ''}, ${rows.length}, now())
    `.catch(() => {});
  }

  return {
    listings: rows.map((r: any) => ({
      id: r.id,
      agent_name: r.agent_name,
      org_id: r.org_id,
      display_name: r.display_name,
      short_description: r.short_description,
      category: r.category,
      tags: r.tags || [],
      price_per_task_usd: Number(r.price_per_task_usd),
      quality_score: Number(r.quality_score),
      total_tasks_completed: Number(r.total_tasks_completed),
      avg_rating: Number(r.avg_rating),
      total_ratings: Number(r.total_ratings),
      is_verified: r.is_verified,
      is_featured: r.is_featured,
      a2a_endpoint_url: r.a2a_endpoint_url || "",
      agent_card_url: r.agent_card_url || "",
    })),
    total: rows.length,
    query,
    category: opts.category,
  };
}

// ── Quality Scoring ──────────────────────────────────────────

/**
 * Recompute quality score for a listing based on:
 * - Task completion rate (40%)
 * - Average rating (30%)
 * - Response time vs SLA (20%)
 * - Verification status (10%)
 */
export async function updateQualityScore(sql: Sql, listingId: string): Promise<number> {
  const [listing] = await sql`SELECT * FROM marketplace_listings WHERE id = ${listingId}`;
  if (!listing) return 0;

  const completed = Number(listing.total_tasks_completed) || 0;
  const failed = Number(listing.total_tasks_failed) || 0;
  const total = completed + failed;

  // Completion rate (0-1)
  const completionRate = total > 0 ? completed / total : 0.5; // neutral if no data

  // Rating score (0-1)
  const avgRating = Number(listing.avg_rating) || 0;
  const ratingScore = avgRating / 5;

  // Response time score (0-1, 1 = fast)
  const slaTarget = Number(listing.sla_response_time_ms) || 30000;
  const avgResponse = Number(listing.avg_response_time_ms) || slaTarget;
  const responseScore = Math.min(1, slaTarget / Math.max(avgResponse, 1));

  // Verification bonus
  const verifiedBonus = listing.is_verified ? 1 : 0;

  // Weighted composite
  const score = completionRate * 0.4 + ratingScore * 0.3 + responseScore * 0.2 + verifiedBonus * 0.1;
  const clamped = Math.max(0, Math.min(1, score));

  await sql`UPDATE marketplace_listings SET quality_score = ${clamped}, updated_at = now() WHERE id = ${listingId}`;

  return clamped;
}

// ── Ratings ──────────────────────────────────────────────────

/**
 * Submit a rating after an A2A transaction.
 * Updates the listing's avg_rating and total_ratings.
 */
export async function submitRating(
  sql: Sql,
  listingId: string,
  raterOrgId: string,
  rating: number,
  opts: { rater_agent_name?: string; task_id?: string; review_text?: string; response_time_ms?: number; credibility_weight?: number; raw_rating?: number } = {},
): Promise<void> {
  rating = Math.max(1, Math.min(5, Math.round(rating)));

  await sql`
    INSERT INTO marketplace_ratings (listing_id, rater_org_id, rater_agent_name, task_id, rating, review_text, response_time_ms)
    VALUES (${listingId}, ${raterOrgId}, ${opts.rater_agent_name || ''}, ${opts.task_id || ''}, ${rating}, ${opts.review_text || ''}, ${opts.response_time_ms || 0})
  `;

  // Update aggregate on listing
  const [agg] = await sql`
    SELECT AVG(rating) as avg, COUNT(*) as cnt FROM marketplace_ratings WHERE listing_id = ${listingId}
  `;

  await sql`
    UPDATE marketplace_listings
    SET avg_rating = ${Number(agg.avg)}, total_ratings = ${Number(agg.cnt)}, updated_at = now()
    WHERE id = ${listingId}
  `;

  // Recompute quality score
  await updateQualityScore(sql, listingId);
}

// ── Featured Placement ───────────────────────────────────────

/**
 * Purchase featured placement for a listing.
 * Deducts credits from the org and marks the listing as featured.
 */
export async function purchaseFeatured(
  sql: Sql,
  listingId: string,
  orgId: string,
  durationDays: number,
  costUsd: number,
): Promise<{ success: boolean; error?: string; featured_until?: string }> {
  // Deduct credits
  const deducted = await sql`
    UPDATE org_credit_balance SET balance_usd = balance_usd - ${costUsd}, updated_at = now()
    WHERE org_id = ${orgId} AND balance_usd >= ${costUsd}
  `;
  if (deducted.count === 0) return { success: false, error: "Insufficient credits" };

  const endsAt = new Date(Date.now() + durationDays * 86400_000).toISOString();

  // Update listing
  await sql`
    UPDATE marketplace_listings SET is_featured = true, featured_until = ${endsAt}, updated_at = now()
    WHERE id = ${listingId} AND org_id = ${orgId}
  `;

  // Record purchase
  await sql`
    INSERT INTO marketplace_featured (listing_id, org_id, category, cost_usd, starts_at, ends_at)
    SELECT id, org_id, category, ${costUsd}, now(), ${endsAt}
    FROM marketplace_listings WHERE id = ${listingId}
  `;

  // Audit — fetch actual balance after deduction
  const [bal] = await sql`SELECT balance_usd FROM org_credit_balance WHERE org_id = ${orgId}`;
  await sql`
    INSERT INTO credit_transactions (org_id, type, amount_usd, balance_after_usd, description, reference_id, reference_type, created_at)
    VALUES (${orgId}, 'burn', ${-costUsd}, ${Number(bal?.balance_usd ?? 0)}, ${'Featured placement: ' + listingId}, ${listingId}, 'marketplace_featured', now())
  `;

  return { success: true, featured_until: endsAt };
}
