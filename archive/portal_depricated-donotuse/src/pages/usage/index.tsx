import { Fragment, useState, useMemo, useCallback } from "react";
import {
  Users,
  Activity,
  DollarSign,
  TrendingUp,
  Search,
  ChevronDown,
  ChevronRight,
  ArrowUpDown,
  Bot,
} from "lucide-react";

import { PageHeader } from "../../components/common/PageHeader";
import { PageShell } from "../../components/layout/PageShell";
import { QueryState } from "../../components/common/QueryState";
import { useApiQuery } from "../../lib/api";

/* ── Types ──────────────────────────────────────────────────────── */

type BillingUsage = {
  total_requests?: number;
  total_cost_usd?: number;
  end_users?: EndUserUsage[];
  by_agent?: AgentUsage[];
};

type EndUserUsage = {
  end_user_id: string;
  request_count: number;
  cost_usd: number;
  last_active?: string;
  top_agent?: string;
  agents?: AgentBreakdown[];
};

type AgentBreakdown = {
  agent_id: string;
  agent_name?: string;
  request_count: number;
  cost_usd: number;
};

type AgentUsage = {
  agent_id: string;
  agent_name?: string;
  request_count: number;
  cost_usd: number;
};

/* ── Sort helpers ───────────────────────────────────────────────── */

type SortKey = "end_user_id" | "request_count" | "cost_usd" | "last_active" | "top_agent";
type SortDir = "asc" | "desc";

function compareValues(a: unknown, b: unknown, dir: SortDir): number {
  const aVal = a ?? "";
  const bVal = b ?? "";
  if (typeof aVal === "number" && typeof bVal === "number") {
    return dir === "asc" ? aVal - bVal : bVal - aVal;
  }
  const aStr = String(aVal);
  const bStr = String(bVal);
  return dir === "asc" ? aStr.localeCompare(bStr) : bStr.localeCompare(aStr);
}

/* ── Formatting helpers ─────────────────────────────────────────── */

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

function formatNumber(n: number): string {
  return new Intl.NumberFormat("en-US").format(n);
}

function formatDate(dateStr?: string): string {
  if (!dateStr) return "--";
  return new Date(dateStr).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/* ── Time range options ─────────────────────────────────────────── */

const TIME_RANGES = [
  { label: "7d", days: 7 },
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
] as const;

/* ── SVG Bar Chart ──────────────────────────────────────────────── */

function AgentBarChart({ agents }: { agents: AgentUsage[] }) {
  if (!agents.length) {
    return (
      <div className="card p-6 flex items-center justify-center">
        <p className="text-xs text-text-muted">No agent usage data available.</p>
      </div>
    );
  }

  const sorted = [...agents].sort((a, b) => b.request_count - a.request_count).slice(0, 10);
  const maxRequests = Math.max(...sorted.map((a) => a.request_count), 1);
  const maxCost = Math.max(...sorted.map((a) => a.cost_usd), 0.01);

  const barHeight = 28;
  const gap = 6;
  const labelWidth = 140;
  const rightPadding = 80;
  const chartWidth = 600;
  const svgHeight = sorted.length * (barHeight + gap) + 8;
  const barArea = chartWidth - labelWidth - rightPadding;

  return (
    <div className="card p-5 overflow-x-auto">
      <svg
        width="100%"
        viewBox={`0 0 ${chartWidth} ${svgHeight}`}
        className="text-xs"
        role="img"
        aria-label="Agent usage bar chart"
      >
        {sorted.map((agent, i) => {
          const y = i * (barHeight + gap) + 4;
          const reqWidth = (agent.request_count / maxRequests) * barArea * 0.7;
          const costWidth = (agent.cost_usd / maxCost) * barArea * 0.3;
          const name = agent.agent_name ?? agent.agent_id;
          const truncated = name.length > 18 ? name.slice(0, 18) + "..." : name;

          return (
            <g key={agent.agent_id}>
              {/* Agent name label */}
              <text
                x={labelWidth - 8}
                y={y + barHeight / 2 + 1}
                textAnchor="end"
                className="fill-text-secondary"
                fontSize="11"
              >
                {truncated}
              </text>
              {/* Request bar */}
              <rect
                x={labelWidth}
                y={y + 2}
                width={Math.max(reqWidth, 2)}
                height={barHeight / 2 - 2}
                rx={2}
                className="fill-chart-blue/70"
              />
              {/* Cost bar */}
              <rect
                x={labelWidth}
                y={y + barHeight / 2 + 1}
                width={Math.max(costWidth, 2)}
                height={barHeight / 2 - 3}
                rx={2}
                className="fill-chart-purple/60"
              />
              {/* Values */}
              <text
                x={labelWidth + Math.max(reqWidth, 2) + 6}
                y={y + barHeight / 2 - 2}
                className="fill-text-muted"
                fontSize="10"
              >
                {formatNumber(agent.request_count)} reqs
              </text>
              <text
                x={labelWidth + Math.max(costWidth, 2) + 6}
                y={y + barHeight - 2}
                className="fill-text-muted"
                fontSize="10"
              >
                {formatCurrency(agent.cost_usd)}
              </text>
            </g>
          );
        })}
      </svg>
      {/* Legend */}
      <div className="flex items-center gap-4 mt-3 px-2">
        <div className="flex items-center gap-1.5">
          <span className="inline-block w-3 h-2 rounded-sm bg-chart-blue/70" />
          <span className="text-[10px] text-text-muted">Requests</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="inline-block w-3 h-2 rounded-sm bg-chart-purple/60" />
          <span className="text-[10px] text-text-muted">Cost</span>
        </div>
      </div>
    </div>
  );
}

/* ── Expanded row ───────────────────────────────────────────────── */

function UserAgentBreakdown({ agents }: { agents: AgentBreakdown[] }) {
  if (!agents.length) {
    return (
      <div className="px-12 py-3">
        <p className="text-xs text-text-muted">No per-agent breakdown available.</p>
      </div>
    );
  }

  return (
    <div className="px-12 py-3 bg-surface-sunken/50">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-border-default">
            <th className="text-left px-3 py-1.5 font-semibold text-text-muted">Agent</th>
            <th className="text-right px-3 py-1.5 font-semibold text-text-muted">Requests</th>
            <th className="text-right px-3 py-1.5 font-semibold text-text-muted">Cost</th>
          </tr>
        </thead>
        <tbody>
          {agents.map((a) => (
            <tr key={a.agent_id} className="border-b border-border-default last:border-0">
              <td className="px-3 py-1.5 text-text-secondary font-mono">
                {a.agent_name ?? a.agent_id}
              </td>
              <td className="px-3 py-1.5 text-text-secondary text-right font-mono">
                {formatNumber(a.request_count)}
              </td>
              <td className="px-3 py-1.5 text-text-secondary text-right font-mono">
                {formatCurrency(a.cost_usd)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ── Page Component ─────────────────────────────────────────────── */

export function UsagePage() {
  const [rangeDays, setRangeDays] = useState(30);
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("cost_usd");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [expandedUser, setExpandedUser] = useState<string | null>(null);

  const { data, loading, error, refetch } = useApiQuery<BillingUsage>(
    `/api/v1/billing/usage?since_days=${rangeDays}`,
  );

  const endUsers = useMemo(() => data?.end_users ?? [], [data]);
  const byAgent = useMemo(() => data?.by_agent ?? [], [data]);

  const totalEndUsers = endUsers.length;
  const totalRequests = data?.total_requests ?? endUsers.reduce((s, u) => s + u.request_count, 0);
  const totalCost = data?.total_cost_usd ?? endUsers.reduce((s, u) => s + u.cost_usd, 0);
  const avgCostPerUser = totalEndUsers > 0 ? totalCost / totalEndUsers : 0;

  /* ── Filtering & sorting ───────────────────────────────────────── */

  const filtered = useMemo(() => {
    let result = endUsers;
    if (search) {
      const q = search.toLowerCase();
      result = result.filter((u) => u.end_user_id.toLowerCase().includes(q));
    }
    return [...result].sort((a, b) =>
      compareValues(a[sortKey as keyof EndUserUsage], b[sortKey as keyof EndUserUsage], sortDir),
    );
  }, [endUsers, search, sortKey, sortDir]);

  const handleSort = useCallback(
    (key: SortKey) => {
      if (sortKey === key) {
        setSortDir((d) => (d === "asc" ? "desc" : "asc"));
      } else {
        setSortKey(key);
        setSortDir("desc");
      }
    },
    [sortKey],
  );

  const toggleExpand = useCallback(
    (userId: string) => {
      setExpandedUser((prev) => (prev === userId ? null : userId));
    },
    [],
  );

  /* ── Column header helper ──────────────────────────────────────── */

  function SortHeader({ label, colKey, align = "left" }: { label: string; colKey: SortKey; align?: "left" | "right" }) {
    const active = sortKey === colKey;
    return (
      <th
        className={`px-4 py-2.5 font-semibold text-text-muted uppercase tracking-wider cursor-pointer select-none hover:text-text-secondary transition-colors ${align === "right" ? "text-right" : "text-left"}`}
        onClick={() => handleSort(colKey)}
      >
        <span className="inline-flex items-center gap-1">
          {label}
          <ArrowUpDown
            size={10}
            className={active ? "text-accent" : "text-text-muted/50"}
          />
          {active && (
            <span className="text-[9px] text-accent">{sortDir === "asc" ? "ASC" : "DESC"}</span>
          )}
        </span>
      </th>
    );
  }

  /* ── KPI cards ─────────────────────────────────────────────────── */

  const kpis = [
    {
      label: "Total End-Users",
      value: formatNumber(totalEndUsers),
      icon: Users,
      color: "bg-chart-purple/10",
      iconColor: "text-chart-purple",
    },
    {
      label: `Requests (${rangeDays}d)`,
      value: formatNumber(totalRequests),
      icon: Activity,
      color: "bg-chart-blue/10",
      iconColor: "text-chart-blue",
    },
    {
      label: `Cost (${rangeDays}d)`,
      value: formatCurrency(totalCost),
      icon: DollarSign,
      color: "bg-chart-green/10",
      iconColor: "text-chart-green",
    },
    {
      label: "Avg Cost / User",
      value: formatCurrency(avgCostPerUser),
      icon: TrendingUp,
      color: "bg-chart-yellow/10",
      iconColor: "text-chart-yellow",
    },
  ];

  return (
    <PageShell variant="wide">
      <PageHeader
        title="End-User Usage"
        subtitle="Analytics across your end users and agents"
        icon={<Users size={18} />}
        onRefresh={() => void refetch()}
        actions={
          <div className="flex items-center bg-surface-raised rounded-lg border border-border-default p-0.5">
            {TIME_RANGES.map((r) => (
              <button
                key={r.days}
                onClick={() => setRangeDays(r.days)}
                className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors ${
                  rangeDays === r.days
                    ? "bg-accent text-white"
                    : "text-text-muted hover:text-text-secondary"
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>
        }
      />

      {/* ── KPI Cards ────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        {kpis.map((kpi) => (
          <div key={kpi.label} className="card p-4 flex items-center gap-3">
            <div className={`p-2.5 rounded-lg ${kpi.color}`}>
              <kpi.icon size={16} className={kpi.iconColor} />
            </div>
            <div>
              <p className="text-xs text-text-muted">{kpi.label}</p>
              <p className="text-lg font-bold text-text-primary font-mono">{kpi.value}</p>
            </div>
          </div>
        ))}
      </div>

      <QueryState loading={loading} error={error} isEmpty={!endUsers.length && !byAgent.length} emptyMessage="No usage data available for this period." onRetry={() => void refetch()}>
        {/* ── Usage by End-User Table ────────────────────────────── */}
        <section className="mb-8">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-text-primary uppercase tracking-wider flex items-center gap-2">
              <Users size={14} className="text-chart-purple" />
              Usage by End-User
            </h2>
            {/* Search */}
            <div className="relative">
              <Search
                size={13}
                className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted"
              />
              <input
                type="text"
                placeholder="Filter by user ID..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="input pl-8 pr-3 py-1.5 text-xs w-56"
              />
            </div>
          </div>

          <div className="card overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border-default bg-surface-sunken">
                  <th className="w-8 px-2" />
                  <SortHeader label="End-User ID" colKey="end_user_id" />
                  <SortHeader label="Requests" colKey="request_count" align="right" />
                  <SortHeader label="Cost ($)" colKey="cost_usd" align="right" />
                  <SortHeader label="Last Active" colKey="last_active" />
                  <SortHeader label="Top Agent" colKey="top_agent" />
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-text-muted">
                      {search ? "No users match your filter." : "No end-user data available."}
                    </td>
                  </tr>
                ) : (
                  filtered.map((user) => {
                    const isExpanded = expandedUser === user.end_user_id;
                    return (
                      <Fragment key={user.end_user_id}>
                        <tr
                          className="border-b border-border-default hover:bg-surface-overlay/50 transition-colors cursor-pointer"
                          onClick={() => toggleExpand(user.end_user_id)}
                        >
                          <td className="px-2 text-center">
                            {isExpanded ? (
                              <ChevronDown size={12} className="text-text-muted inline" />
                            ) : (
                              <ChevronRight size={12} className="text-text-muted inline" />
                            )}
                          </td>
                          <td className="px-4 py-2.5 font-mono text-text-primary">
                            {user.end_user_id}
                          </td>
                          <td className="px-4 py-2.5 text-right font-mono text-text-secondary">
                            {formatNumber(user.request_count)}
                          </td>
                          <td className="px-4 py-2.5 text-right font-mono text-text-secondary">
                            {formatCurrency(user.cost_usd)}
                          </td>
                          <td className="px-4 py-2.5 text-text-muted">
                            {formatDate(user.last_active)}
                          </td>
                          <td className="px-4 py-2.5 text-text-muted flex items-center gap-1">
                            {user.top_agent && <Bot size={10} className="text-text-muted" />}
                            {user.top_agent ?? "--"}
                          </td>
                        </tr>
                        {isExpanded && user.agents && (
                          <tr>
                            <td colSpan={6} className="p-0">
                              <UserAgentBreakdown agents={user.agents} />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </section>

        {/* ── Usage by Agent Chart ───────────────────────────────── */}
        <section className="mb-6">
          <h2 className="text-sm font-semibold text-text-primary uppercase tracking-wider mb-3 flex items-center gap-2">
            <Bot size={14} className="text-chart-blue" />
            Usage by Agent
          </h2>
          <AgentBarChart agents={byAgent} />
        </section>
      </QueryState>
    </PageShell>
  );
}
