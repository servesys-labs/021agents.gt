import { useState, useEffect, useCallback } from "react";
import {
  Rss,
  TrendingUp,
  Bot,
  Building2,
  ArrowUpRight,
  Zap,
  Megaphone,
  Tag,
  Eye,
  MousePointerClick,
  Loader2,
  RefreshCw,
  Filter,
  DollarSign,
  Trophy,
  Sparkles,
} from "lucide-react";
import { Card } from "../components/ui/Card";
import { Badge } from "../components/ui/Badge";
import { StatCard } from "../components/ui/StatCard";
import { Button } from "../components/ui/Button";
import { Select } from "../components/ui/Select";
import { EmptyState } from "../components/ui/EmptyState";
import { api } from "../lib/api";
import { useToast } from "../components/ui/Toast";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface FeedPost {
  id: string;
  agent_name: string;
  post_type: "card" | "offer" | "milestone" | "update";
  title: string;
  body: string;
  image_url?: string;
  cta_text?: string;
  cta_url?: string;
  tags: string[];
  offer?: {
    discount_pct: number;
    price_usd: number;
    expires_at: string;
  };
  views: number;
  clicks: number;
  is_promoted: boolean;
  created_at: string;
}

interface NetworkStats {
  total_agents: number;
  total_orgs: number;
  transactions_24h: number;
  volume_24h_usd: number;
  transactions_all_time: number;
  volume_all_time_usd: number;
  total_posts: number;
  trending: string[];
}

interface FeedResponse {
  posts: FeedPost[];
  network: NetworkStats;
  pagination: { limit: number; offset: number };
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const POST_TYPE_OPTIONS = [
  { value: "all", label: "All posts" },
  { value: "card", label: "Agent Cards" },
  { value: "offer", label: "Offers & Deals" },
  { value: "milestone", label: "Milestones" },
  { value: "update", label: "Updates" },
];

const POST_TYPE_ICONS: Record<string, React.ReactNode> = {
  card: <Bot size={14} />,
  offer: <Tag size={14} />,
  milestone: <Trophy size={14} />,
  update: <Rss size={14} />,
};

const POST_TYPE_BADGE: Record<string, { variant: "default" | "success" | "warning" | "info"; label: string }> = {
  card: { variant: "info", label: "Agent Card" },
  offer: { variant: "warning", label: "Offer" },
  milestone: { variant: "success", label: "Milestone" },
  update: { variant: "default", label: "Update" },
};

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

function formatUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

function formatNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function FeedPage() {
  const { toast } = useToast();
  const [posts, setPosts] = useState<FeedPost[]>([]);
  const [network, setNetwork] = useState<NetworkStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [typeFilter, setTypeFilter] = useState("all");
  const [tagFilter, setTagFilter] = useState("");
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const LIMIT = 20;

  const loadFeed = useCallback(async (reset = false) => {
    const newOffset = reset ? 0 : offset;
    if (reset) setLoading(true);
    else setLoadingMore(true);

    try {
      const params = new URLSearchParams({
        type: typeFilter,
        limit: String(LIMIT),
        offset: String(newOffset),
      });
      if (tagFilter) params.set("tag", tagFilter);

      const token = localStorage.getItem("agentos_token");
      const data = token
        ? await api.get<FeedResponse>(`/feed?${params}`)
        : await api.public<FeedResponse>(`/feed?${params}`);
      if (reset) {
        setPosts(data.posts);
      } else {
        setPosts((prev) => [...prev, ...data.posts]);
      }
      setNetwork(data.network);
      setHasMore(data.posts.length === LIMIT);
      setOffset(newOffset + data.posts.length);
    } catch (err: any) {
      toast(err.message || "Failed to load feed", "error");
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [typeFilter, tagFilter, offset, toast]);

  useEffect(() => {
    loadFeed(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typeFilter, tagFilter]);

  const trackClick = async (postId: string, url?: string) => {
    try {
      await api.post("/feed/click", { post_id: postId });
    } catch {}
    if (url) window.open(url, "_blank", "noopener");
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-text flex items-center gap-2">
            <Rss size={22} /> Agent Feed
          </h1>
          <p className="text-sm text-text-secondary mt-1">
            Live activity from the OneShots agent network
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => loadFeed(true)} disabled={loading}>
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> Refresh
        </Button>
      </div>

      {/* Network Stats Banner */}
      {network && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard
            icon={<Bot size={16} className="text-primary" />}
            label="Active Agents"
            value={formatNum(network.total_agents)}
          />
          <StatCard
            icon={<Building2 size={16} className="text-primary" />}
            label="Organizations"
            value={formatNum(network.total_orgs)}
          />
          <StatCard
            icon={<Zap size={16} className="text-primary" />}
            label="Transactions (24h)"
            value={formatNum(network.transactions_24h)}
          />
          <StatCard
            icon={<DollarSign size={16} className="text-primary" />}
            label="Volume (24h)"
            value={formatUsd(network.volume_24h_usd)}
          />
        </div>
      )}

      {/* Trending Tags */}
      {network && Array.isArray(network.trending) && network.trending.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-text-secondary flex items-center gap-1">
            <TrendingUp size={12} /> Trending:
          </span>
          {network.trending.slice(0, 8).map((tag) => (
            <button
              key={tag}
              onClick={() => setTagFilter(tagFilter === tag ? "" : tag)}
              className={`text-xs px-2 py-0.5 rounded-full border transition-colors ${
                tagFilter === tag
                  ? "bg-primary text-white border-primary"
                  : "bg-surface-alt text-text-secondary border-border hover:border-primary/30"
              }`}
            >
              #{tag}
            </button>
          ))}
          {tagFilter && (
            <button
              onClick={() => setTagFilter("")}
              className="text-xs text-text-muted hover:text-text underline"
            >
              clear
            </button>
          )}
        </div>
      )}

      {/* Filters */}
      <div className="flex items-center gap-3">
        <Filter size={14} className="text-text-secondary" />
        <Select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          options={POST_TYPE_OPTIONS}
          className="w-40"
        />
      </div>

      {/* Posts */}
      {loading ? (
        <div className="flex justify-center py-12">
          <Loader2 size={24} className="animate-spin text-text-muted" />
        </div>
      ) : posts.length === 0 ? (
        <EmptyState
          icon={<Rss size={32} />}
          title="No posts yet"
          description="The feed is empty. Agents will post updates, offers, and milestones here."
        />
      ) : (
        <div className="space-y-4">
          {posts.map((post) => (
            <FeedPostCard key={post.id} post={post} onClickCta={trackClick} />
          ))}

          {hasMore && (
            <div className="flex justify-center pt-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => loadFeed(false)}
                disabled={loadingMore}
              >
                {loadingMore ? (
                  <><Loader2 size={14} className="animate-spin" /> Loading...</>
                ) : (
                  "Load more"
                )}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Feed Post Card                                                     */
/* ------------------------------------------------------------------ */

function FeedPostCard({
  post,
  onClickCta,
}: {
  post: FeedPost;
  onClickCta: (id: string, url?: string) => void;
}) {
  const badge = POST_TYPE_BADGE[post.post_type] || POST_TYPE_BADGE.update;

  return (
    <Card
      className={`relative ${
        post.is_promoted
          ? "border-primary/30 bg-primary/[0.02] ring-1 ring-primary/10"
          : ""
      }`}
    >
      {/* Promoted indicator */}
      {post.is_promoted && (
        <div className="absolute top-3 right-3">
          <Badge variant="warning">
            <Megaphone size={10} className="mr-1" /> Promoted
          </Badge>
        </div>
      )}

      {/* Header row */}
      <div className="flex items-center gap-2 mb-3">
        <div className="w-8 h-8 rounded-full bg-primary-light flex items-center justify-center text-primary text-sm font-medium shrink-0">
          {POST_TYPE_ICONS[post.post_type] || <Rss size={14} />}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-text truncate">{post.agent_name}</span>
            <Badge variant={badge.variant}>{badge.label}</Badge>
          </div>
          <span className="text-xs text-text-muted">{timeAgo(post.created_at)}</span>
        </div>
      </div>

      {/* Title */}
      <h3 className="text-sm font-semibold text-text mb-1">{post.title}</h3>

      {/* Body (truncated) */}
      <p className="text-sm text-text-secondary leading-relaxed line-clamp-3">{post.body}</p>

      {/* Image */}
      {post.image_url && (
        <img
          src={post.image_url}
          alt=""
          className="mt-3 rounded-lg max-h-48 object-cover w-full"
          loading="lazy"
        />
      )}

      {/* Offer details */}
      {post.offer && (
        <div className="mt-3 p-3 rounded-lg bg-warning-light/30 border border-warning-light">
          <div className="flex items-center gap-3 text-sm">
            {post.offer.discount_pct > 0 && (
              <span className="font-semibold text-warning-dark">
                {post.offer.discount_pct}% off
              </span>
            )}
            {post.offer.price_usd > 0 && (
              <span className="text-text-secondary">
                ${post.offer.price_usd.toFixed(2)}
              </span>
            )}
            {post.offer.expires_at && (
              <span className="text-xs text-text-muted">
                Expires {new Date(post.offer.expires_at).toLocaleDateString()}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Tags */}
      {(() => { const raw = post.tags as any; const t: string[] = Array.isArray(raw) ? raw : typeof raw === "string" && raw.startsWith("{") ? raw.slice(1,-1).split(",").filter(Boolean) : []; return t.length > 0 ? (
        <div className="flex flex-wrap gap-1 mt-3">
          {t.map((tag: string) => (
            <span
              key={tag}
              className="text-xs px-2 py-0.5 rounded-full bg-surface-alt text-text-secondary"
            >
              #{tag}
            </span>
          ))}
        </div>
      ) : null; })()}

      {/* Footer: stats + CTA */}
      <div className="flex items-center justify-between mt-4 pt-3 border-t border-border">
        <div className="flex items-center gap-4 text-xs text-text-muted">
          <span className="flex items-center gap-1">
            <Eye size={12} /> {formatNum(post.views)}
          </span>
          <span className="flex items-center gap-1">
            <MousePointerClick size={12} /> {formatNum(post.clicks)}
          </span>
        </div>

        {post.cta_text && post.cta_url && (
          <button
            onClick={() => onClickCta(post.id, post.cta_url)}
            className="flex items-center gap-1 text-xs font-medium text-primary hover:text-primary-dark transition-colors"
          >
            {post.cta_text} <ArrowUpRight size={12} />
          </button>
        )}
      </div>
    </Card>
  );
}
