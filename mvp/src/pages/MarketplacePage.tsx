import { useState, useEffect, useCallback } from "react";
import {
  Search,
  Star,
  Copy,
  CheckCircle,
  ShieldCheck,
  Sparkles,
  Loader2,
  AlertCircle,
  RefreshCw,
  Link as LinkIcon,
  ToggleLeft,
  ToggleRight,
  Users,
  DollarSign,
  TrendingUp,
  Hash,
} from "lucide-react";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { Badge } from "../components/ui/Badge";
import { StatCard } from "../components/ui/StatCard";
import { Modal } from "../components/ui/Modal";
import { Input } from "../components/ui/Input";
import { Select } from "../components/ui/Select";
import { TabNav } from "../components/ui/TabNav";
import { api } from "../lib/api";
import { useToast } from "../components/ui/Toast";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface MarketplaceListing {
  agent_name: string;
  display_name: string;
  short_description: string;
  full_description?: string;
  category: string;
  price_per_task_usd: number;
  quality_score: number;
  avg_rating: number;
  total_tasks_completed: number;
  is_verified: boolean;
  is_featured: boolean;
  a2a_endpoint_url?: string;
  sla?: Record<string, unknown>;
  skills?: string[];
  recent_ratings?: { rating: number; comment: string; created_at: string }[];
  revenue_total_usd?: number;
  is_published?: boolean;
}

interface ReferralStats {
  // Matches backend getReferralStats() response shape
  referrals: { org_id: string; org_name: string; since: string }[];
  total_referrals: number;
  earnings: {
    total_transactions: number;
    total_earned_usd: number;
    l1_earned_usd: number;
    l2_earned_usd: number;
    earning_sources: number;
  };
  codes: { code: string; label: string; uses: number; max_uses: number | null; active: boolean }[];
}

const CATEGORIES = [
  { value: "", label: "All categories" },
  { value: "shopping", label: "Shopping" },
  { value: "research", label: "Research" },
  { value: "legal", label: "Legal" },
  { value: "finance", label: "Finance" },
  { value: "travel", label: "Travel" },
  { value: "coding", label: "Coding" },
  { value: "creative", label: "Creative" },
  { value: "support", label: "Support" },
  { value: "data", label: "Data" },
  { value: "health", label: "Health" },
  { value: "education", label: "Education" },
  { value: "marketing", label: "Marketing" },
];

const TABS = [
  { key: "browse", label: "Browse" },
  { key: "my-listings", label: "My Listings" },
  { key: "referrals", label: "My Referrals" },
];

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function Stars({ rating, size = 14 }: { rating: number; size?: number }) {
  return (
    <span className="inline-flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((i) => (
        <Star
          key={i}
          size={size}
          className={i <= Math.round(rating) ? "text-amber-400 fill-amber-400" : "text-text-muted"}
        />
      ))}
    </span>
  );
}

function categoryBadgeVariant(cat: string): "default" | "info" | "success" | "warning" {
  const map: Record<string, "info" | "success" | "warning"> = {
    coding: "info",
    finance: "success",
    legal: "warning",
    health: "success",
    data: "info",
  };
  return map[cat] || "default";
}

/* ------------------------------------------------------------------ */
/*  Main page                                                          */
/* ------------------------------------------------------------------ */

export default function MarketplacePage() {
  const { toast } = useToast();
  const [tab, setTab] = useState("browse");

  /* ---------- Browse state ---------- */
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [results, setResults] = useState<MarketplaceListing[]>([]);
  const [searching, setSearching] = useState(false);

  /* ---------- Detail modal ---------- */
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [detail, setDetail] = useState<MarketplaceListing | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  /* ---------- Rating state ---------- */
  const [ratingValue, setRatingValue] = useState(5);
  const [ratingComment, setRatingComment] = useState("");
  const [submittingRating, setSubmittingRating] = useState(false);

  /* ---------- My Listings state ---------- */
  const [myListings, setMyListings] = useState<MarketplaceListing[]>([]);
  const [myListingsLoading, setMyListingsLoading] = useState(false);
  const [togglingAgent, setTogglingAgent] = useState<string | null>(null);

  /* ---------- Referrals state ---------- */
  const [referralStats, setReferralStats] = useState<ReferralStats | null>(null);
  const [referralsLoading, setReferralsLoading] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);

  /* ---------------------------------------------------------------- */
  /*  Search                                                           */
  /* ---------------------------------------------------------------- */

  const doSearch = useCallback(async () => {
    setSearching(true);
    try {
      const params = new URLSearchParams();
      if (query) params.set("q", query);
      if (category) params.set("category", category);
      if (maxPrice) params.set("max_price", maxPrice);
      const qs = params.toString();
      const data = await api.get<MarketplaceListing[]>(`/marketplace/search${qs ? `?${qs}` : ""}`);
      setResults(Array.isArray(data) ? data : []);
    } catch {
      setResults([]);
      toast("Search failed -- please try again");
    } finally {
      setSearching(false);
    }
  }, [query, category, maxPrice, toast]);

  useEffect(() => {
    doSearch();
  }, []); // initial load

  /* ---------------------------------------------------------------- */
  /*  Detail modal                                                     */
  /* ---------------------------------------------------------------- */

  const openDetail = async (agentName: string) => {
    setSelectedAgent(agentName);
    setDetailLoading(true);
    setDetail(null);
    setRatingValue(5);
    setRatingComment("");
    try {
      const data = await api.get<MarketplaceListing>(`/marketplace/listings/${encodeURIComponent(agentName)}`);
      setDetail(data);
    } catch {
      toast("Could not load agent details");
      setSelectedAgent(null);
    } finally {
      setDetailLoading(false);
    }
  };

  const closeDetail = () => {
    setSelectedAgent(null);
    setDetail(null);
  };

  const copyEndpoint = () => {
    if (detail?.a2a_endpoint_url) {
      navigator.clipboard.writeText(detail.a2a_endpoint_url);
      toast("Endpoint URL copied to clipboard");
    }
  };

  const submitRating = async () => {
    if (!detail) return;
    setSubmittingRating(true);
    try {
      await api.post("/marketplace/rate", {
        agent_name: detail.agent_name,
        rating: ratingValue,
        comment: ratingComment,
      });
      toast("Rating submitted");
      // Refresh detail
      openDetail(detail.agent_name);
    } catch {
      toast("Failed to submit rating");
    } finally {
      setSubmittingRating(false);
    }
  };

  /* ---------------------------------------------------------------- */
  /*  My Listings                                                      */
  /* ---------------------------------------------------------------- */

  const loadMyListings = useCallback(async () => {
    setMyListingsLoading(true);
    try {
      const data = await api.get<MarketplaceListing[]>("/marketplace/search?mine=true");
      setMyListings(Array.isArray(data) ? data : []);
    } catch {
      setMyListings([]);
    } finally {
      setMyListingsLoading(false);
    }
  }, []);

  const togglePublish = async (listing: MarketplaceListing) => {
    setTogglingAgent(listing.agent_name);
    try {
      if (listing.is_published) {
        await api.post("/marketplace/unpublish", { agent_name: listing.agent_name });
        toast("Agent unpublished");
      } else {
        await api.post("/marketplace/publish", { agent_name: listing.agent_name });
        toast("Agent published");
      }
      loadMyListings();
    } catch {
      toast("Failed to update listing");
    } finally {
      setTogglingAgent(null);
    }
  };

  /* ---------------------------------------------------------------- */
  /*  Referrals                                                        */
  /* ---------------------------------------------------------------- */

  const loadReferrals = useCallback(async () => {
    setReferralsLoading(true);
    try {
      const data = await api.get<ReferralStats>("/referrals/stats");
      setReferralStats(data);
    } catch {
      setReferralStats(null);
    } finally {
      setReferralsLoading(false);
    }
  }, []);

  const copyReferralCode = () => {
    const code = referralStats?.codes?.[0]?.code;
    if (code) {
      navigator.clipboard.writeText(`https://app.oneshots.co/login?ref=${encodeURIComponent(code)}`);
      setCopiedCode(true);
      toast("Referral link copied");
      setTimeout(() => setCopiedCode(false), 2000);
    }
  };

  /* ---------------------------------------------------------------- */
  /*  Tab switching side-effects                                       */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    if (tab === "my-listings") loadMyListings();
    if (tab === "referrals") loadReferrals();
  }, [tab, loadMyListings, loadReferrals]);

  /* ================================================================ */
  /*  RENDER                                                           */
  /* ================================================================ */

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-text tracking-tight">Marketplace</h1>
        <p className="text-sm text-text-secondary mt-1 leading-relaxed">
          Discover, publish, and monetize AI agents.
        </p>
      </div>

      <TabNav tabs={TABS} active={tab} onChange={setTab} />

      {/* ============================================================ */}
      {/*  Browse tab                                                   */}
      {/* ============================================================ */}
      {tab === "browse" && (
        <>
          {/* Search bar */}
          <div className="flex flex-col sm:flex-row gap-3 mb-6">
            <div className="relative flex-1">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
              <input
                type="text"
                placeholder="Search agents..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && doSearch()}
                className="w-full rounded-lg border border-border pl-9 pr-3 py-2 text-sm bg-white placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-colors"
              />
            </div>
            <Select
              options={CATEGORIES}
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="sm:w-44"
            />
            <div className="sm:w-36">
              <Input
                type="number"
                placeholder="Max price ($)"
                value={maxPrice}
                onChange={(e) => setMaxPrice(e.target.value)}
                min="0"
                step="0.01"
              />
            </div>
            <Button onClick={doSearch} disabled={searching} className="shrink-0">
              {searching ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />}
              Search
            </Button>
          </div>

          {/* Results */}
          {searching && (
            <div className="flex items-center justify-center py-20">
              <Loader2 size={24} className="animate-spin text-primary" />
              <span className="ml-2 text-sm text-text-secondary">Searching...</span>
            </div>
          )}

          {!searching && results.length === 0 && (
            <Card className="text-center py-14 px-6 max-w-lg mx-auto border-dashed">
              <Search size={44} className="text-text-muted mx-auto mb-4 opacity-80" />
              <h3 className="text-lg font-semibold text-text mb-2">No agents found</h3>
              <p className="text-sm text-text-secondary leading-relaxed">
                Try broadening your search or clearing the filters.
              </p>
            </Card>
          )}

          {!searching && results.length > 0 && (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {results.map((listing) => (
                <Card
                  key={listing.agent_name}
                  hover
                  onClick={() => openDetail(listing.agent_name)}
                >
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <h3 className="text-sm font-semibold text-text truncate">{listing.display_name}</h3>
                    <div className="flex items-center gap-1 shrink-0">
                      {listing.is_verified && (
                        <ShieldCheck size={14} className="text-primary" />
                      )}
                      {listing.is_featured && (
                        <Sparkles size={14} className="text-amber-500" />
                      )}
                    </div>
                  </div>

                  <p className="text-xs text-text-secondary line-clamp-2 mb-3">{listing.short_description}</p>

                  <div className="flex flex-wrap items-center gap-2 mb-3">
                    <Badge variant={categoryBadgeVariant(listing.category)}>{listing.category}</Badge>
                    <span className="text-sm font-medium text-text">${listing.price_per_task_usd.toFixed(2)}<span className="text-text-muted font-normal">/task</span></span>
                  </div>

                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-muted">
                    <span className="inline-flex items-center gap-1">
                      <Stars rating={listing.avg_rating} size={12} />
                      <span>{listing.avg_rating.toFixed(1)}</span>
                    </span>
                    <span>{Math.round(listing.quality_score * 100)}% quality</span>
                    <span>{listing.total_tasks_completed.toLocaleString()} tasks</span>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </>
      )}

      {/* ============================================================ */}
      {/*  My Listings tab                                              */}
      {/* ============================================================ */}
      {tab === "my-listings" && (
        <>
          {myListingsLoading && (
            <div className="flex items-center justify-center py-20">
              <Loader2 size={24} className="animate-spin text-primary" />
              <span className="ml-2 text-sm text-text-secondary">Loading your listings...</span>
            </div>
          )}

          {!myListingsLoading && myListings.length === 0 && (
            <Card className="text-center py-14 px-6 max-w-lg mx-auto border-dashed">
              <AlertCircle size={44} className="text-text-muted mx-auto mb-4 opacity-80" />
              <h3 className="text-lg font-semibold text-text mb-2">No listings yet</h3>
              <p className="text-sm text-text-secondary leading-relaxed">
                Publish one of your agents to the marketplace to start earning.
              </p>
            </Card>
          )}

          {!myListingsLoading && myListings.length > 0 && (
            <div className="space-y-4">
              {/* Summary stats */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
                <StatCard
                  icon={<DollarSign size={16} className="text-success" />}
                  label="Total Revenue"
                  value={`$${myListings.reduce((s, l) => s + (l.revenue_total_usd || 0), 0).toFixed(2)}`}
                />
                <StatCard
                  icon={<Hash size={16} className="text-primary" />}
                  label="Tasks Completed"
                  value={myListings.reduce((s, l) => s + l.total_tasks_completed, 0).toLocaleString()}
                />
                <StatCard
                  icon={<Star size={16} className="text-amber-400" />}
                  label="Avg Rating"
                  value={
                    myListings.length > 0
                      ? (myListings.reduce((s, l) => s + l.avg_rating, 0) / myListings.length).toFixed(1)
                      : "--"
                  }
                />
              </div>

              {/* Listing cards */}
              {myListings.map((listing) => (
                <Card key={listing.agent_name}>
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <h3 className="text-sm font-semibold text-text truncate">{listing.display_name}</h3>
                        <Badge variant={listing.is_published ? "success" : "default"}>
                          {listing.is_published ? "Published" : "Draft"}
                        </Badge>
                      </div>
                      <p className="text-xs text-text-secondary line-clamp-1">{listing.short_description}</p>
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-muted mt-2">
                        <span>${listing.price_per_task_usd.toFixed(2)}/task</span>
                        <span>{listing.total_tasks_completed.toLocaleString()} tasks</span>
                        <span className="inline-flex items-center gap-1">
                          <Stars rating={listing.avg_rating} size={11} />
                          {listing.avg_rating.toFixed(1)}
                        </span>
                        {listing.revenue_total_usd != null && (
                          <span>${listing.revenue_total_usd.toFixed(2)} earned</span>
                        )}
                      </div>
                    </div>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={togglingAgent === listing.agent_name}
                      onClick={() => togglePublish(listing)}
                      className="shrink-0"
                    >
                      {togglingAgent === listing.agent_name ? (
                        <Loader2 size={14} className="animate-spin" />
                      ) : listing.is_published ? (
                        <ToggleRight size={14} />
                      ) : (
                        <ToggleLeft size={14} />
                      )}
                      {listing.is_published ? "Unpublish" : "Publish"}
                    </Button>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </>
      )}

      {/* ============================================================ */}
      {/*  Referrals tab                                                */}
      {/* ============================================================ */}
      {tab === "referrals" && (
        <>
          {referralsLoading && (
            <div className="flex items-center justify-center py-20">
              <Loader2 size={24} className="animate-spin text-primary" />
              <span className="ml-2 text-sm text-text-secondary">Loading referral data...</span>
            </div>
          )}

          {!referralsLoading && !referralStats && (
            <Card className="text-center py-14 px-6 max-w-lg mx-auto border-dashed">
              <Users size={44} className="text-text-muted mx-auto mb-4 opacity-80" />
              <h3 className="text-lg font-semibold text-text mb-2">No referral data</h3>
              <p className="text-sm text-text-secondary leading-relaxed">
                Referral stats could not be loaded. Try again later.
              </p>
              <Button onClick={loadReferrals} variant="secondary" className="mt-4">
                <RefreshCw size={14} /> Retry
              </Button>
            </Card>
          )}

          {!referralsLoading && referralStats && (
            <div className="space-y-6">
              {/* Referral code */}
              <Card>
                <h3 className="text-sm font-semibold text-text mb-3">Your Referral Link</h3>
                <div className="flex flex-col sm:flex-row gap-3">
                  <div className="flex-1 flex items-center gap-2 px-3 py-2 rounded-lg border border-border bg-surface-alt text-sm font-mono text-text-secondary truncate">
                    <LinkIcon size={14} className="shrink-0 text-text-muted" />
                    <span className="truncate">{referralStats.codes?.[0]?.code ? `https://app.oneshots.co/login?ref=${referralStats.codes[0].code}` : "No referral code"}</span>
                  </div>
                  <Button variant="secondary" size="sm" onClick={copyReferralCode} className="shrink-0">
                    {copiedCode ? <CheckCircle size={14} className="text-success" /> : <Copy size={14} />}
                    {copiedCode ? "Copied" : "Copy link"}
                  </Button>
                </div>
                <p className="text-xs text-text-muted mt-2">
                  Code: <span className="font-mono font-medium text-text">{referralStats.codes?.[0]?.code || "—"}</span>
                  {referralStats.codes?.[0] && <span className="text-text-muted"> ({referralStats.codes[0].uses}/{referralStats.codes[0].max_uses ?? "∞"} used)</span>}
                </p>
              </Card>

              {/* Earnings */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <StatCard
                  icon={<DollarSign size={16} className="text-success" />}
                  label="Total Earnings"
                  value={`$${(referralStats.earnings?.total_earned_usd || 0).toFixed(2)}`}
                />
                <StatCard
                  icon={<TrendingUp size={16} className="text-primary" />}
                  label="L1 Earnings"
                  value={`$${(referralStats.earnings?.l1_earned_usd || 0).toFixed(2)}`}
                />
                <StatCard
                  icon={<TrendingUp size={16} className="text-warning" />}
                  label="L2 Earnings"
                  value={`$${(referralStats.earnings?.l2_earned_usd || 0).toFixed(2)}`}
                />
              </div>

              {/* Referred orgs */}
              <Card>
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-semibold text-text">
                    Referred Organizations ({referralStats.total_referrals})
                  </h3>
                </div>
                {(referralStats.referrals || []).length === 0 ? (
                  <p className="text-xs text-text-muted">No referrals yet. Share your link to start earning.</p>
                ) : (
                  <div className="divide-y divide-border">
                    {(referralStats.referrals || []).map((org) => (
                      <div key={org.org_name} className="flex items-center justify-between py-2 text-sm">
                        <span className="text-text font-medium">{org.org_name}</span>
                        <div className="flex items-center gap-3 text-xs text-text-muted">
                          <span className="text-text-muted">{new Date(org.since).toLocaleDateString()}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            </div>
          )}
        </>
      )}

      {/* ============================================================ */}
      {/*  Detail modal                                                 */}
      {/* ============================================================ */}
      <Modal open={!!selectedAgent} onClose={closeDetail} title={detail?.display_name || "Agent Details"} wide>
        {detailLoading && (
          <div className="flex items-center justify-center py-10">
            <Loader2 size={24} className="animate-spin text-primary" />
          </div>
        )}

        {!detailLoading && detail && (
          <div className="space-y-5">
            {/* Header badges */}
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={categoryBadgeVariant(detail.category)}>{detail.category}</Badge>
              {detail.is_verified && (
                <Badge variant="success">
                  <ShieldCheck size={12} className="mr-1" /> Verified
                </Badge>
              )}
              {detail.is_featured && (
                <Badge variant="warning">
                  <Sparkles size={12} className="mr-1" /> Featured
                </Badge>
              )}
            </div>

            {/* Description */}
            <div>
              <h4 className="text-xs font-medium text-text-muted uppercase tracking-wider mb-1">Description</h4>
              <p className="text-sm text-text-secondary leading-relaxed whitespace-pre-line">
                {detail.full_description || detail.short_description}
              </p>
            </div>

            {/* Pricing & stats */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="rounded-lg bg-surface-alt px-3 py-2">
                <p className="text-xs text-text-muted">Price</p>
                <p className="text-sm font-semibold text-text">${detail.price_per_task_usd.toFixed(2)}/task</p>
              </div>
              <div className="rounded-lg bg-surface-alt px-3 py-2">
                <p className="text-xs text-text-muted">Quality</p>
                <p className="text-sm font-semibold text-text">{Math.round(detail.quality_score * 100)}%</p>
              </div>
              <div className="rounded-lg bg-surface-alt px-3 py-2">
                <p className="text-xs text-text-muted">Tasks Done</p>
                <p className="text-sm font-semibold text-text">{detail.total_tasks_completed.toLocaleString()}</p>
              </div>
              <div className="rounded-lg bg-surface-alt px-3 py-2">
                <p className="text-xs text-text-muted">Rating</p>
                <div className="flex items-center gap-1">
                  <Stars rating={detail.avg_rating} size={12} />
                  <span className="text-sm font-semibold text-text">{detail.avg_rating.toFixed(1)}</span>
                </div>
              </div>
            </div>

            {/* SLA */}
            {detail.sla && Object.keys(detail.sla).length > 0 && (
              <div>
                <h4 className="text-xs font-medium text-text-muted uppercase tracking-wider mb-1">SLA</h4>
                <div className="flex flex-wrap gap-2">
                  {Object.entries(detail.sla).map(([k, v]) => (
                    <span key={k} className="text-xs bg-surface-alt rounded-lg px-2 py-1 text-text-secondary">
                      {k}: <span className="font-medium text-text">{String(v)}</span>
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Skills */}
            {detail.skills && detail.skills.length > 0 && (
              <div>
                <h4 className="text-xs font-medium text-text-muted uppercase tracking-wider mb-1">Skills</h4>
                <div className="flex flex-wrap gap-2">
                  {detail.skills.map((skill) => (
                    <Badge key={skill} variant="info">{skill}</Badge>
                  ))}
                </div>
              </div>
            )}

            {/* Use this agent button */}
            <div className="flex flex-wrap gap-2 pt-2 border-t border-border">
              <Button onClick={copyEndpoint}>
                <Copy size={14} /> Use this agent
              </Button>
              {detail.a2a_endpoint_url && (
                <p className="text-xs text-text-muted self-center">Copies A2A endpoint URL</p>
              )}
            </div>

            {/* Recent ratings */}
            {detail.recent_ratings && detail.recent_ratings.length > 0 && (
              <div>
                <h4 className="text-xs font-medium text-text-muted uppercase tracking-wider mb-2">Recent Ratings</h4>
                <div className="space-y-2 max-h-40 overflow-y-auto">
                  {detail.recent_ratings.map((r, i) => (
                    <div key={i} className="flex items-start gap-2 text-sm">
                      <Stars rating={r.rating} size={11} />
                      <div className="min-w-0">
                        <p className="text-text-secondary text-xs leading-relaxed">{r.comment || "No comment"}</p>
                        <p className="text-[10px] text-text-muted">{new Date(r.created_at).toLocaleDateString()}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Submit rating */}
            <div className="pt-3 border-t border-border">
              <h4 className="text-xs font-medium text-text-muted uppercase tracking-wider mb-2">Rate this agent</h4>
              <div className="flex flex-col sm:flex-row items-start gap-3">
                <div className="flex items-center gap-1">
                  {[1, 2, 3, 4, 5].map((i) => (
                    <button
                      key={i}
                      type="button"
                      onClick={() => setRatingValue(i)}
                      className="p-0.5 rounded hover:bg-surface-alt transition-colors"
                      aria-label={`Rate ${i} star${i > 1 ? "s" : ""}`}
                    >
                      <Star
                        size={18}
                        className={i <= ratingValue ? "text-amber-400 fill-amber-400" : "text-text-muted"}
                      />
                    </button>
                  ))}
                </div>
                <div className="flex-1 w-full">
                  <Input
                    placeholder="Optional comment..."
                    value={ratingComment}
                    onChange={(e) => setRatingComment(e.target.value)}
                  />
                </div>
                <Button size="sm" onClick={submitRating} disabled={submittingRating} className="shrink-0">
                  {submittingRating ? <Loader2 size={14} className="animate-spin" /> : null}
                  Submit
                </Button>
              </div>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
