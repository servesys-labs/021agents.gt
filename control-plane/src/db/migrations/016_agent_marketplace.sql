-- Migration 016: Agent Marketplace
-- Enables agents to publish to a public directory, be discovered by other agents,
-- and transact via x-402 credits. Replaces the ad model with capability matching.

-- ══════════════════════════════════════════════════════════════════
-- 1. Marketplace listings (agents published for discovery)
-- ══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS marketplace_listings (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  agent_name TEXT NOT NULL,
  org_id TEXT NOT NULL,

  -- Discovery metadata
  display_name TEXT NOT NULL,
  short_description TEXT NOT NULL,        -- max 200 chars, shown in search results
  long_description TEXT,                  -- full description for detail page
  category TEXT NOT NULL,                 -- shopping, research, legal, finance, travel, coding, creative, support, data, other
  subcategory TEXT,
  tags TEXT[] DEFAULT '{}',

  -- Pricing (x-402)
  price_per_task_usd NUMERIC(10,4) NOT NULL DEFAULT 0,
  price_per_1k_tokens_usd NUMERIC(10,6) DEFAULT 0,
  free_tier_tasks INTEGER DEFAULT 0,      -- number of free tasks before charging

  -- Quality signals (computed, updated by cron)
  quality_score NUMERIC(5,3) DEFAULT 0,   -- 0.000 to 1.000
  total_tasks_completed INTEGER DEFAULT 0,
  total_tasks_failed INTEGER DEFAULT 0,
  avg_response_time_ms INTEGER DEFAULT 0,
  avg_rating NUMERIC(3,2) DEFAULT 0,      -- 0.00 to 5.00
  total_ratings INTEGER DEFAULT 0,
  total_revenue_usd NUMERIC(20,6) DEFAULT 0,

  -- Visibility
  is_published BOOLEAN NOT NULL DEFAULT false,  -- true = visible in marketplace
  is_verified BOOLEAN DEFAULT false,            -- platform-verified quality
  is_featured BOOLEAN DEFAULT false,            -- paid featured placement
  featured_until TIMESTAMPTZ,

  -- SLA commitments
  sla_response_time_ms INTEGER,           -- max response time commitment
  sla_uptime_pct NUMERIC(5,2),            -- uptime commitment (e.g., 99.9)

  -- Agent Card URL (for A2A protocol)
  agent_card_url TEXT,
  a2a_endpoint_url TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE(agent_name, org_id)
);

CREATE INDEX IF NOT EXISTS idx_marketplace_published ON marketplace_listings(is_published, category, quality_score DESC);
CREATE INDEX IF NOT EXISTS idx_marketplace_search ON marketplace_listings USING gin(tags);

-- ══════════════════════════════════════════════════════════════════
-- 2. Marketplace ratings (agent-to-agent feedback after A2A tasks)
-- ══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS marketplace_ratings (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  listing_id TEXT NOT NULL REFERENCES marketplace_listings(id),
  rater_org_id TEXT NOT NULL,
  rater_agent_name TEXT,
  task_id TEXT,                            -- links to a2a_tasks
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  review_text TEXT,
  task_completed BOOLEAN DEFAULT true,
  response_time_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ratings_listing ON marketplace_ratings(listing_id, created_at DESC);

-- ══════════════════════════════════════════════════════════════════
-- 3. Featured placement purchases (the "ads" equivalent)
-- ══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS marketplace_featured (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  listing_id TEXT NOT NULL REFERENCES marketplace_listings(id),
  org_id TEXT NOT NULL,
  category TEXT NOT NULL,                  -- featured in this category
  cost_usd NUMERIC(10,4) NOT NULL,
  starts_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ends_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',   -- active, expired, cancelled
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ══════════════════════════════════════════════════════════════════
-- 4. Discovery queries log (for marketplace analytics)
-- ══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS marketplace_queries (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  querier_org_id TEXT NOT NULL,
  querier_agent_name TEXT,
  query_text TEXT NOT NULL,
  category_filter TEXT,
  results_count INTEGER DEFAULT 0,
  selected_listing_id TEXT,               -- which listing was chosen
  converted BOOLEAN DEFAULT false,         -- did a transaction happen?
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_queries_org ON marketplace_queries(querier_org_id, created_at DESC);
