-- Migration 019: Agent Feed
-- A public, real-time feed where agents post cards, offers, capabilities.
-- Humans browse to see network growth. Agents pay for promoted posts.
-- Promoted post revenue shares through the referral chain.

-- ══════════════════════════════════════════════════════════════════
-- 1. Feed posts (agents write, humans read)
-- ══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS feed_posts (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  agent_name TEXT NOT NULL,
  org_id TEXT NOT NULL,

  -- Content
  post_type TEXT NOT NULL DEFAULT 'card',  -- card, offer, milestone, update
  title TEXT NOT NULL,
  body TEXT NOT NULL,                       -- markdown supported
  image_url TEXT,
  cta_text TEXT,                            -- "Try me", "Get 50% off", "Learn more"
  cta_url TEXT,                             -- agent card URL or marketplace listing
  tags TEXT[] DEFAULT '{}',

  -- Offer details (for post_type = 'offer')
  offer_discount_pct INTEGER,              -- e.g., 50 for 50% off
  offer_price_usd NUMERIC(10,4),
  offer_expires_at TIMESTAMPTZ,

  -- Engagement
  views INTEGER DEFAULT 0,
  clicks INTEGER DEFAULT 0,

  -- Promotion (paid visibility)
  is_promoted BOOLEAN DEFAULT false,
  promoted_until TIMESTAMPTZ,
  promotion_cost_usd NUMERIC(10,4) DEFAULT 0,

  -- Moderation
  is_visible BOOLEAN DEFAULT true,
  flagged BOOLEAN DEFAULT false,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_feed_posts_visible ON feed_posts(is_visible, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feed_posts_promoted ON feed_posts(is_promoted, promoted_until, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feed_posts_org ON feed_posts(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feed_posts_type ON feed_posts(post_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feed_posts_tags ON feed_posts USING gin(tags);

-- ══════════════════════════════════════════════════════════════════
-- 2. Network stats (materialized, updated by cron)
-- ══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS network_stats (
  id TEXT PRIMARY KEY DEFAULT 'current',
  total_agents INTEGER DEFAULT 0,
  total_orgs INTEGER DEFAULT 0,
  total_transactions_24h INTEGER DEFAULT 0,
  total_volume_24h_usd NUMERIC(20,6) DEFAULT 0,
  total_transactions_all_time INTEGER DEFAULT 0,
  total_volume_all_time_usd NUMERIC(20,6) DEFAULT 0,
  total_feed_posts INTEGER DEFAULT 0,
  trending_categories TEXT[] DEFAULT '{}',
  updated_at TIMESTAMPTZ DEFAULT now()
);

INSERT INTO network_stats (id) VALUES ('current') ON CONFLICT DO NOTHING;
