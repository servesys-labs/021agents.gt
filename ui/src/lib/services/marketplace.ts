import { api } from "./api";

// ── Types ──────────────────────────────────────────────────────────

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

export interface MarketplaceSearchResult {
  listings: MarketplaceListing[];
  total: number;
  query: string;
  category?: string;
}

// ── API functions ──────────────────────────────────────────────────

export function searchMarketplace(opts: {
  query?: string;
  category?: string;
  limit?: number;
} = {}): Promise<MarketplaceSearchResult> {
  const params = new URLSearchParams();
  params.set("q", opts.query || " ");
  if (opts.category) params.set("category", opts.category);
  if (opts.limit) params.set("limit", String(opts.limit));
  return api.get<MarketplaceSearchResult>(`/marketplace/search?${params.toString()}`);
}

export function getMarketplaceCategories(): Promise<{ categories: string[] }> {
  return api.get<{ categories: string[] }>("/marketplace/categories");
}
