import { useState, useMemo, useCallback } from "react";
import {
  Plug,
  Search,
  ExternalLink,
  Check,
  Loader2,
  BarChart3,
} from "lucide-react";

import { PageHeader } from "../../components/common/PageHeader";
import { QueryState } from "../../components/common/QueryState";
import { EmptyState } from "../../components/common/EmptyState";
import { useApiQuery, apiGet } from "../../lib/api";
import { useToast } from "../../components/common/ToastProvider";

/* ── Types ──────────────────────────────────────────────────────── */

type ConnectorProvider = {
  name: string;
  display_name?: string;
  category?: string;
  description?: string;
  tool_count?: number;
  connected?: boolean;
  icon_url?: string;
};

type ConnectorTool = {
  name: string;
  provider: string;
  description?: string;
};

type ConnectorUsage = {
  total_calls?: number;
  total_cost_usd?: number;
  by_provider?: Record<string, number>;
};

/* ── Category helpers ───────────────────────────────────────────── */

const CATEGORIES = [
  "All",
  "CRM",
  "Communication",
  "DevOps",
  "Finance",
  "Marketing",
  "Productivity",
  "Storage",
  "Analytics",
  "Other",
] as const;

type Category = (typeof CATEGORIES)[number];

const categoryColors: Record<string, string> = {
  CRM: "bg-chart-blue/15 text-chart-blue border-chart-blue/20",
  Communication: "bg-chart-purple/15 text-chart-purple border-chart-purple/20",
  DevOps: "bg-chart-orange/15 text-chart-orange border-chart-orange/20",
  Finance: "bg-chart-green/15 text-chart-green border-chart-green/20",
  Marketing: "bg-accent-muted text-accent border-accent/20",
  Productivity: "bg-chart-cyan/15 text-chart-cyan border-chart-cyan/20",
  Storage: "bg-status-warning/15 text-status-warning border-status-warning/20",
  Analytics: "bg-status-info/15 text-status-info border-status-info/20",
  Other: "bg-surface-overlay text-text-secondary border-border-default",
};

function getCategoryColor(category?: string): string {
  return categoryColors[category ?? ""] ?? categoryColors.Other;
}

function getInitialColor(category?: string): string {
  const colors: Record<string, string> = {
    CRM: "bg-chart-blue/20 text-chart-blue",
    Communication: "bg-chart-purple/20 text-chart-purple",
    DevOps: "bg-chart-orange/20 text-chart-orange",
    Finance: "bg-chart-green/20 text-chart-green",
    Marketing: "bg-accent-muted text-accent",
    Productivity: "bg-chart-cyan/20 text-chart-cyan",
    Storage: "bg-status-warning/20 text-status-warning",
    Analytics: "bg-status-info/20 text-status-info",
  };
  return colors[category ?? ""] ?? "bg-surface-overlay text-text-secondary";
}

/* ── Component ──────────────────────────────────────────────────── */

export function ConnectorHubPage() {
  const { showToast } = useToast();
  const [searchQuery, setSearchQuery] = useState("");
  const [activeCategory, setActiveCategory] = useState<Category>("All");
  const [connectingApp, setConnectingApp] = useState<string | null>(null);

  /* Queries */
  const providersQuery = useApiQuery<
    { providers: ConnectorProvider[] } | ConnectorProvider[]
  >("/api/v1/connectors/providers");

  const toolsQuery = useApiQuery<
    { tools: ConnectorTool[] } | ConnectorTool[]
  >("/api/v1/connectors/tools");

  const usageQuery = useApiQuery<ConnectorUsage>("/api/v1/connectors/usage");

  const providers: ConnectorProvider[] = useMemo(() => {
    const raw = providersQuery.data;
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    return raw.providers ?? [];
  }, [providersQuery.data]);

  const connectedProviders = useMemo(
    () => providers.filter((p) => p.connected),
    [providers],
  );

  const filteredProviders = useMemo(() => {
    let list = providers;
    if (activeCategory !== "All") {
      list = list.filter(
        (p) =>
          (p.category ?? "Other").toLowerCase() ===
          activeCategory.toLowerCase(),
      );
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter(
        (p) =>
          (p.display_name ?? p.name).toLowerCase().includes(q) ||
          (p.category ?? "").toLowerCase().includes(q),
      );
    }
    return list;
  }, [providers, activeCategory, searchQuery]);

  const usage = usageQuery.data;

  const handleConnect = useCallback(
    async (appName: string) => {
      setConnectingApp(appName);
      try {
        const result = await apiGet<{ auth_url: string }>(
          `/api/v1/connectors/auth/${encodeURIComponent(appName)}`,
        );
        if (result.auth_url) {
          window.open(result.auth_url, "_blank", "noopener,noreferrer");
          showToast(
            "OAuth window opened. Complete authorization and return here.",
            "success",
          );
        }
      } catch {
        showToast("Failed to initiate connection", "error");
      } finally {
        setConnectingApp(null);
      }
    },
    [showToast],
  );

  return (
    <div className="max-w-[1400px] mx-auto">
      <PageHeader
        title="Connector Hub"
        subtitle="Browse and connect 3000+ app integrations via Pipedream"
        icon={<Plug size={20} />}
        onRefresh={() => {
          providersQuery.refetch();
          toolsQuery.refetch();
          usageQuery.refetch();
        }}
      />

      {/* Usage stats */}
      {usage && (
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-[var(--space-3)] mb-[var(--space-6)]">
          <div className="card flex items-center gap-[var(--space-3)] py-[var(--space-3)]">
            <div className="p-2 rounded-lg bg-chart-blue/10">
              <Plug size={16} className="text-chart-blue" />
            </div>
            <div>
              <p className="text-[var(--text-xl)] font-bold text-text-primary font-mono">
                {connectedProviders.length}
              </p>
              <p className="text-[10px] text-text-muted uppercase tracking-wide">
                Connected
              </p>
            </div>
          </div>
          <div className="card flex items-center gap-[var(--space-3)] py-[var(--space-3)]">
            <div className="p-2 rounded-lg bg-accent-muted">
              <BarChart3 size={16} className="text-accent" />
            </div>
            <div>
              <p className="text-[var(--text-xl)] font-bold text-text-primary font-mono">
                {(usage.total_calls ?? 0).toLocaleString()}
              </p>
              <p className="text-[10px] text-text-muted uppercase tracking-wide">
                API Calls (Month)
              </p>
            </div>
          </div>
          <div className="card flex items-center gap-[var(--space-3)] py-[var(--space-3)]">
            <div className="p-2 rounded-lg bg-chart-green/10">
              <BarChart3 size={16} className="text-chart-green" />
            </div>
            <div>
              <p className="text-[var(--text-xl)] font-bold text-text-primary font-mono">
                ${(usage.total_cost_usd ?? 0).toFixed(2)}
              </p>
              <p className="text-[10px] text-text-muted uppercase tracking-wide">
                Cost (Month)
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Connected apps strip */}
      {connectedProviders.length > 0 && (
        <section className="mb-[var(--space-6)]">
          <h2 className="text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-3)]">
            Connected Apps
          </h2>
          <div className="flex flex-wrap gap-[var(--space-2)]">
            {connectedProviders.map((p) => (
              <div
                key={p.name}
                className="inline-flex items-center gap-[var(--space-2)] px-[var(--space-3)] py-[var(--space-2)] rounded-lg bg-surface-raised border border-border-default"
              >
                <div
                  className={`w-6 h-6 rounded-md flex items-center justify-center text-[10px] font-bold ${getInitialColor(p.category)}`}
                >
                  {(p.display_name ?? p.name).charAt(0).toUpperCase()}
                </div>
                <span className="text-[var(--text-sm)] text-text-primary font-medium">
                  {p.display_name ?? p.name}
                </span>
                <Check size={12} className="text-status-live" />
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Search bar */}
      <div className="mb-[var(--space-4)]">
        <div className="relative">
          <Search
            size={16}
            className="absolute left-[var(--space-3)] top-1/2 -translate-y-1/2 text-text-muted pointer-events-none"
          />
          <input
            type="text"
            placeholder="Search connectors..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-10 bg-surface-overlay"
          />
        </div>
      </div>

      {/* Category filter chips */}
      <div className="flex flex-wrap gap-[var(--space-2)] mb-[var(--space-6)]">
        {CATEGORIES.map((cat) => (
          <button
            key={cat}
            onClick={() => setActiveCategory(cat)}
            className={`px-[var(--space-3)] py-[var(--space-2)] rounded-lg text-[var(--text-xs)] font-medium transition-colors min-h-[var(--touch-target-min)] ${
              activeCategory === cat
                ? "bg-accent text-text-inverse"
                : "bg-surface-raised border border-border-default text-text-secondary hover:bg-surface-overlay hover:text-text-primary"
            }`}
          >
            {cat}
          </button>
        ))}
      </div>

      {/* Connector grid */}
      <QueryState
        loading={providersQuery.loading}
        error={providersQuery.error}
        onRetry={providersQuery.refetch}
      >
        {filteredProviders.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-[var(--space-3)]">
            {filteredProviders.map((provider) => (
              <div
                key={provider.name}
                className="card card-hover flex flex-col gap-[var(--space-3)] glass-light relative overflow-hidden"
              >
                <div className="flex items-start gap-[var(--space-3)]">
                  {/* App icon placeholder */}
                  <div
                    className={`w-10 h-10 rounded-xl flex items-center justify-center text-[var(--text-md)] font-bold flex-shrink-0 ${getInitialColor(provider.category)}`}
                  >
                    {(provider.display_name ?? provider.name)
                      .charAt(0)
                      .toUpperCase()}
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-[var(--space-2)]">
                      <h3 className="text-[var(--text-sm)] font-semibold text-text-primary truncate">
                        {provider.display_name ?? provider.name}
                      </h3>
                      {provider.connected && (
                        <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-status-live">
                          <Check size={10} />
                          Connected
                        </span>
                      )}
                    </div>

                    {provider.description && (
                      <p className="text-[var(--text-xs)] text-text-muted line-clamp-2 mt-[var(--space-1)]">
                        {provider.description}
                      </p>
                    )}
                  </div>
                </div>

                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-[var(--space-2)]">
                    {provider.category && (
                      <span
                        className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase border ${getCategoryColor(provider.category)}`}
                      >
                        {provider.category}
                      </span>
                    )}
                    {provider.tool_count != null && (
                      <span className="text-[10px] text-text-muted">
                        {provider.tool_count} tools
                      </span>
                    )}
                  </div>

                  {provider.connected ? (
                    <button className="btn btn-secondary text-[var(--text-xs)] min-h-[var(--touch-target-min)]">
                      Manage
                      <ExternalLink size={10} />
                    </button>
                  ) : (
                    <button
                      onClick={() => handleConnect(provider.name)}
                      disabled={connectingApp === provider.name}
                      className="btn btn-primary text-[var(--text-xs)] min-h-[var(--touch-target-min)]"
                    >
                      {connectingApp === provider.name ? (
                        <>
                          <Loader2 size={12} className="animate-spin" />
                          Connecting...
                        </>
                      ) : (
                        <>
                          <Plug size={12} />
                          Connect
                        </>
                      )}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState
            icon={<Plug size={28} />}
            title="No connectors found"
            description={
              searchQuery
                ? `No connectors match "${searchQuery}"`
                : "No connectors available in this category."
            }
          />
        )}
      </QueryState>
    </div>
  );
}

export { ConnectorHubPage as default };
