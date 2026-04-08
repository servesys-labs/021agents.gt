import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  Star,
  ShieldCheck,
  Zap,
  Bot,
  Clock,
  DollarSign,
  Tag,
  Loader2,
  ExternalLink,
  MessageSquare,
} from "lucide-react";
import { Card } from "../components/ui/Card";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { api } from "../lib/api";
import { useToast } from "../components/ui/Toast";

interface ListingDetail {
  agent_name: string;
  display_name: string;
  short_description: string;
  long_description: string;
  category: string;
  tags: string[] | string;
  price_per_task_usd: number;
  quality_score: number;
  avg_rating: number;
  total_ratings: number;
  total_tasks_completed: number;
  is_verified: boolean;
  is_featured: boolean;
  a2a_endpoint_url: string;
  sla_response_time_ms: number | null;
  sla_uptime_pct: number | null;
  recent_ratings: { rating: number; review: string; created_at: string }[];
}

function Stars({ rating }: { rating: number }) {
  return (
    <span className="inline-flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((i) => (
        <Star key={i} size={14} className={i <= Math.round(rating) ? "text-yellow-500 fill-yellow-500" : "text-border"} />
      ))}
    </span>
  );
}

function parseTags(tags: string[] | string): string[] {
  if (Array.isArray(tags)) return tags;
  if (typeof tags === "string" && tags.startsWith("{")) {
    return tags.slice(1, -1).split(",").filter(Boolean);
  }
  return [];
}

export default function AgentDetailPage() {
  const { name } = useParams<{ name: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [listing, setListing] = useState<ListingDetail | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!name) return;
    setLoading(true);
    const token = localStorage.getItem("agentos_token");
    const fetcher = token ? api.get<ListingDetail> : api.public<ListingDetail>;
    fetcher(`/marketplace/listings/${name}`)
      .then(setListing)
      .catch((err) => {
        toast(err.message || "Agent not found", "error");
      })
      .finally(() => setLoading(false));
  }, [name]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 size={24} className="animate-spin text-text-muted" />
      </div>
    );
  }

  if (!listing) {
    return (
      <div className="text-center py-20">
        <p className="text-sm text-text-secondary">Agent not found in the marketplace.</p>
        <Button variant="ghost" size="sm" className="mt-4" onClick={() => navigate(-1)}>
          <ArrowLeft size={14} /> Go back
        </Button>
      </div>
    );
  }

  const tags = parseTags(listing.tags);

  return (
    <div className="max-w-3xl space-y-6">
      {/* Back */}
      <button
        onClick={() => navigate(-1)}
        className="flex items-center gap-1 text-sm text-text-secondary hover:text-text transition-colors"
      >
        <ArrowLeft size={14} /> Back to marketplace
      </button>

      {/* Header */}
      <div className="flex items-start gap-4">
        <div className="w-14 h-14 rounded-xl bg-primary-light flex items-center justify-center text-primary shrink-0">
          <Bot size={28} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-xl font-bold text-text">{listing.display_name}</h1>
            {listing.is_verified && (
              <Badge variant="success"><ShieldCheck size={10} className="mr-1" /> Verified</Badge>
            )}
            {listing.is_featured && (
              <Badge variant="warning">Featured</Badge>
            )}
          </div>
          <p className="text-sm text-text-secondary mt-1">{listing.short_description}</p>
        </div>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Card className="p-4 text-center">
          <DollarSign size={16} className="text-primary mx-auto mb-1" />
          <p className="text-lg font-bold text-text">${listing.price_per_task_usd.toFixed(2)}</p>
          <p className="text-xs text-text-secondary">per task</p>
        </Card>
        <Card className="p-4 text-center">
          <Star size={16} className="text-yellow-500 mx-auto mb-1" />
          <p className="text-lg font-bold text-text">{listing.avg_rating > 0 ? listing.avg_rating.toFixed(1) : "—"}</p>
          <p className="text-xs text-text-secondary">{listing.total_ratings} ratings</p>
        </Card>
        <Card className="p-4 text-center">
          <Zap size={16} className="text-primary mx-auto mb-1" />
          <p className="text-lg font-bold text-text">{listing.total_tasks_completed}</p>
          <p className="text-xs text-text-secondary">tasks completed</p>
        </Card>
        <Card className="p-4 text-center">
          <Clock size={16} className="text-primary mx-auto mb-1" />
          <p className="text-lg font-bold text-text">
            {listing.quality_score > 0 ? `${(listing.quality_score * 100).toFixed(0)}%` : "—"}
          </p>
          <p className="text-xs text-text-secondary">quality score</p>
        </Card>
      </div>

      {/* Description */}
      {listing.long_description && (
        <Card className="p-5">
          <h2 className="text-sm font-semibold text-text mb-2">About</h2>
          <p className="text-sm text-text-secondary leading-relaxed whitespace-pre-line">
            {listing.long_description}
          </p>
        </Card>
      )}

      {/* Tags + Category */}
      <div className="flex items-center gap-2 flex-wrap">
        <Badge variant="info">{listing.category}</Badge>
        {tags.map((tag) => (
          <span key={tag} className="text-xs px-2 py-0.5 rounded-full bg-surface-alt text-text-secondary">
            #{tag}
          </span>
        ))}
      </div>

      {/* SLA */}
      {(listing.sla_response_time_ms || listing.sla_uptime_pct) && (
        <Card className="p-5">
          <h2 className="text-sm font-semibold text-text mb-2">SLA Commitments</h2>
          <div className="flex gap-6 text-sm text-text-secondary">
            {listing.sla_response_time_ms && (
              <span>Response time: <strong className="text-text">{listing.sla_response_time_ms}ms</strong></span>
            )}
            {listing.sla_uptime_pct && (
              <span>Uptime: <strong className="text-text">{listing.sla_uptime_pct}%</strong></span>
            )}
          </div>
        </Card>
      )}

      {/* Actions */}
      <div className="flex gap-3">
        <Button onClick={() => navigate(`/agents/${listing.agent_name}/play`)}>
          <MessageSquare size={14} /> Chat with agent
        </Button>
        {listing.a2a_endpoint_url && (
          <Button variant="secondary" onClick={() => {
            navigator.clipboard.writeText(listing.a2a_endpoint_url);
            toast("A2A endpoint copied to clipboard");
          }}>
            <ExternalLink size={14} /> Copy A2A endpoint
          </Button>
        )}
      </div>

      {/* Recent Ratings */}
      {listing.recent_ratings?.length > 0 && (
        <Card className="p-5">
          <h2 className="text-sm font-semibold text-text mb-3">Recent Ratings</h2>
          <div className="space-y-3">
            {listing.recent_ratings.map((r, i) => (
              <div key={i} className="flex items-start gap-3 pb-3 border-b border-border last:border-0 last:pb-0">
                <Stars rating={r.rating} />
                <div className="flex-1 min-w-0">
                  {r.review && <p className="text-sm text-text-secondary">{r.review}</p>}
                  <p className="text-xs text-text-muted mt-1">
                    {new Date(r.created_at).toLocaleDateString()}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
