import { useEffect, useMemo, type CSSProperties } from "react";
import { useNavigate } from "react-router-dom";
import {
  Bot,
  Activity,
  Zap,
  Clock,
  TrendingUp,
  AlertTriangle,
  ArrowRight,
  Play,
  Brain,
  Server,
  Sparkles,
  ThumbsUp,
  Wrench,
  Globe,
  ChevronRight,
} from "lucide-react";

import { PageHeader } from "../../components/common/PageHeader";
import { StatusBadge } from "../../components/common/StatusBadge";
import { AgentCard, type AgentCardData } from "../../components/common/AgentCard";
import { AssistPanel } from "../../components/common/AssistPanel";
import { SkeletonDashboard } from "../../components/common/Skeleton";
import { PageShell } from "../../components/layout/PageShell";
import { useApiQuery } from "../../lib/api";
import { safeArray, type AgentInfo } from "../../lib/adapters";
import { QuotaWidget } from "../../components/common/QuotaWidget";

type DashStats = {
  total_agents?: number;
  live_agents?: number;
  total_sessions?: number;
  active_sessions?: number;
  total_runs?: number;
  avg_latency_ms?: number;
  total_cost_usd?: number;
  error_rate_pct?: number;
};
type IntelSummary = {
  total_scored_turns?: number;
  avg_quality_score?: number;
  avg_sentiment_score?: number;
  tool_failure_count?: number;
};
type RecentActivity = {
  id: string;
  type: string;
  message: string;
  agent_name?: string;
  timestamp?: string;
};

type OrgSettings = {
  onboarding_complete?: boolean;
  default_connectors?: string[];
  org_name?: string;
};

export const DashboardPage = () => {
  const navigate = useNavigate();

  // Check if onboarding is complete — redirect to /onboarding if not
  const orgSettingsQuery = useApiQuery<OrgSettings>("/api/v1/org/settings");
  const statsQuery = useApiQuery<DashStats>("/api/v1/dashboard/stats");
  const activityQuery = useApiQuery<{ activities: RecentActivity[] }>("/api/v1/dashboard/activity?limit=10");
  const intelQuery = useApiQuery<IntelSummary>("/api/v1/intelligence/summary?since_days=30");
  const agentsQuery = useApiQuery<AgentInfo[]>("/api/v1/agents?limit=6&offset=0");
  const toolsQuery = useApiQuery<Array<{ name: string }>>("/api/v1/tools");
  const toolCount = safeArray(toolsQuery.data).length;
  const stats = statsQuery.data ?? {};
  const intel = intelQuery.data ?? {};
  const activities = useMemo(() => activityQuery.data?.activities ?? [], [activityQuery.data]);
  const agents = useMemo(() => safeArray<AgentInfo>(agentsQuery.data), [agentsQuery.data]);

  const agentCards: AgentCardData[] = useMemo(
    () =>
      agents.slice(0, 6).map((a) => ({
        name: a.name,
        description: a.description,
        status: a.status,
        model: a.model,
        version: a.version,
        tags: a.tags,
        last_active: a.updated_at,
      })),
    [agents],
  );

  const kpis = [
    { label: "Total Agents", value: stats.total_agents ?? 0, icon: Bot, color: "bg-chart-purple/10", iconColor: "text-chart-purple", link: "/agents" },
    { label: "Live Agents", value: stats.live_agents ?? 0, icon: Zap, color: "bg-chart-green/10", iconColor: "text-chart-green", link: "/agents" },
    { label: "Active Sessions", value: stats.active_sessions ?? 0, icon: Activity, color: "bg-chart-blue/10", iconColor: "text-chart-blue", link: "/sessions" },
    { label: "Total Runs", value: stats.total_runs ?? 0, icon: Play, color: "bg-accent/10", iconColor: "text-accent", link: "/runtime" },
    { label: "Avg Latency", value: `${(stats.avg_latency_ms ?? 0).toFixed(0)}ms`, icon: Clock, color: "bg-chart-yellow/10", iconColor: "text-chart-yellow", link: "/evolution" },
    { label: "Error Rate", value: `${(stats.error_rate_pct ?? 0).toFixed(1)}%`, icon: AlertTriangle, color: "bg-status-error/10", iconColor: "text-status-error", link: "/sessions" },
    { label: "Avg Quality", value: `${Math.round((intel.avg_quality_score ?? 0) * 100)}%`, icon: Sparkles, color: "bg-chart-purple/10", iconColor: "text-chart-purple", link: "/intelligence" },
    { label: "Sentiment", value: `${(intel.avg_sentiment_score ?? 0) >= 0 ? "+" : ""}${(intel.avg_sentiment_score ?? 0).toFixed(2)}`, icon: ThumbsUp, color: "bg-chart-cyan/10", iconColor: "text-chart-cyan", link: "/intelligence" },
    { label: "Tools", value: toolCount, icon: Wrench, color: "bg-chart-yellow/10", iconColor: "text-chart-yellow", link: "/tools" },
  ];

  const quickActions = [
    { label: "Create Agent", icon: Bot, path: "/agents", desc: "Build and configure a new agent" },
    { label: "Open Canvas", icon: Brain, path: "/canvas", desc: "Visual agent builder workspace" },
    { label: "Run Eval", icon: TrendingUp, path: "/eval", desc: "Evaluate agent performance" },
    { label: "Manage Integrations", icon: Server, path: "/integrations", desc: "Connect tools and MCP servers" },
    { label: "Browse Tools", icon: Wrench, path: "/tools", desc: "Explore the tool registry" },
    { label: "Discover Agents (A2A)", icon: Globe, path: "/a2a", desc: "Find and interact with A2A agents" },
  ];

  const getActivityIcon = (type: string) => {
    switch (type) {
      case "deploy": return <Zap size={10} className="text-chart-green" />;
      case "error": return <AlertTriangle size={10} className="text-status-error" />;
      case "session": return <Activity size={10} className="text-chart-blue" />;
      default: return <Play size={10} className="text-text-muted" />;
    }
  };

  /* ── First-visit redirect ────────────────────────────────────── */
  const onboardingDone = orgSettingsQuery.data?.onboarding_complete;
  useEffect(() => {
    // Only redirect when we have a definitive answer (not loading, not error)
    if (!orgSettingsQuery.loading && !orgSettingsQuery.error && onboardingDone === false) {
      navigate("/onboarding", { replace: true });
    }
  }, [onboardingDone, orgSettingsQuery.loading, orgSettingsQuery.error, navigate]);

  /* ── Loading / empty-state fork ────────────────────────────────── */
  // Wait for the agents query to resolve before deciding which view to show.
  // This prevents the "flash of dashboard → onboarding" jump.
  if (agentsQuery.loading) {
    return <SkeletonDashboard />;
  }

  const hasAgents = agents.length > 0;

  if (!hasAgents) {
    return (
      <PageShell variant="centered">
        <OnboardingHero onNavigate={navigate} />
      </PageShell>
    );
  }

  return (
    <div>
      <PageHeader
        title="Dashboard"
        subtitle="Control plane overview"
        onRefresh={() => { void statsQuery.refetch(); void activityQuery.refetch(); void intelQuery.refetch(); void agentsQuery.refetch(); void toolsQuery.refetch(); }}
      />

      {/* KPI grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        {kpis.map((kpi, index) => (
          <div
            key={kpi.label}
            className="card flex items-center gap-3 py-3 cursor-pointer hover:border-accent/40 transition-colors stagger-item"
            style={{ "--stagger-index": index } as CSSProperties}
            onClick={() => navigate(kpi.link)}
          >
            <div className={`p-2 rounded-lg ${kpi.color}`}>
              <kpi.icon size={16} className={kpi.iconColor} />
            </div>
            <div>
              <p className="text-xl font-bold text-text-primary font-mono">
                {typeof kpi.value === "number" ? kpi.value.toLocaleString() : kpi.value}
              </p>
              <p className="text-[10px] text-text-muted uppercase tracking-wide">{kpi.label}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Meta-agent assist — compact inline suggestions */}
      <div className="mb-4">
        <AssistPanel compact />
      </div>

      {/* Agent Cards */}
      {agentCards.length > 0 && (
        <div className="mb-6">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-text-primary">Your Agents</h3>
            <button
              className="text-[10px] text-accent hover:underline"
              onClick={() => navigate("/agents")}
            >
              View All
            </button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {agentCards.map((agent, index) => (
              <div className="stagger-item" style={{ "--stagger-index": index } as CSSProperties} key={agent.name}>
                <AgentCard
                  agent={agent}
                  onSelect={(name) => navigate(`/agents?selected=${name}`)}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Quick Actions */}
        <div className="card">
          <h3 className="text-sm font-semibold text-text-primary mb-3">Quick Actions</h3>
          <div className="space-y-2">
            {quickActions.map((action, index) => (
              <button
                key={action.label}
                className="w-full flex items-center gap-3 p-3 bg-surface-base border border-border-default rounded-lg hover:border-accent/40 hover:bg-surface-overlay transition-all text-left group stagger-item"
                style={{ "--stagger-index": index } as CSSProperties}
                onClick={() => navigate(action.path)}
              >
                <div className="p-2 rounded-lg bg-accent/10">
                  <action.icon size={14} className="text-accent" />
                </div>
                <div className="flex-1">
                  <p className="text-sm text-text-primary font-medium">{action.label}</p>
                  <p className="text-[10px] text-text-muted">{action.desc}</p>
                </div>
                <ArrowRight size={14} className="text-text-muted group-hover:text-accent transition-colors" />
              </button>
            ))}
          </div>
        </div>

        {/* Recent Activity */}
        <div className="card">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-text-primary">Recent Activity</h3>
            <button className="text-[10px] text-accent hover:underline" onClick={() => navigate("/sessions")}>View All</button>
          </div>
          {activities.length === 0 ? (
            <div className="text-center py-8">
              <Activity size={24} className="mx-auto text-text-muted mb-2" />
              <p className="text-xs text-text-muted">No recent activity</p>
            </div>
          ) : (
            <div className="space-y-1">
              {activities.map((a) => (
                <div key={a.id} className="flex items-start gap-2 py-2 border-b border-border-default last:border-0">
                  <div className="mt-1">{getActivityIcon(a.type)}</div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-text-secondary truncate">{a.message}</p>
                    <div className="flex items-center gap-2 mt-0.5">
                      {a.agent_name && <span className="text-[10px] text-text-muted">{a.agent_name}</span>}
                      {a.timestamp && <span className="text-[10px] text-text-muted">{new Date(a.timestamp).toLocaleTimeString()}</span>}
                    </div>
                  </div>
                  <StatusBadge status={a.type} />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Quota Usage */}
      <div className="card mt-4">
        <h3 className="text-sm font-semibold text-text-primary mb-3">Usage Quota</h3>
        <QuotaWidget variant="card" />
      </div>

      {/* System Health — live from middleware + health endpoints */}
      <SystemHealthCard />

      {/* Cost Overview */}
      <CostOverviewCard />
    </div>
  );
};

/* ── System Health Card ── */
type MiddlewareEntry = { name: string; order: number; type: string; stats?: Record<string, unknown> };
type HealthResponse = { status?: string; db?: string; uptime_seconds?: number };

function SystemHealthCard() {
  const healthQuery = useApiQuery<HealthResponse>("/api/v1/health");
  const mwQuery = useApiQuery<{ middlewares: MiddlewareEntry[] }>("/api/v1/middleware/status");
  const health = healthQuery.data ?? {};
  const middlewares = mwQuery.data?.middlewares ?? [];

  const services = [
    { label: "API", status: health.status === "ok" ? "healthy" : "unknown" },
    { label: "Database", status: health.db === "ok" ? "healthy" : health.db ? "degraded" : "unknown" },
    ...(middlewares.length > 0
      ? middlewares.slice(0, 4).map((m) => ({ label: m.name, status: "healthy" as string }))
      : [{ label: "Middleware", status: "unknown" }]),
  ];

  return (
    <div className="card card-glass mt-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-text-primary">System Health</h3>
        {health.uptime_seconds != null && (
          <span className="text-[10px] text-text-muted font-mono">
            uptime: {Math.floor(health.uptime_seconds / 3600)}h {Math.floor((health.uptime_seconds % 3600) / 60)}m
          </span>
        )}
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {services.map((s) => (
          <div key={s.label} className="flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full ${s.status === "healthy" ? "bg-status-live" : s.status === "degraded" ? "bg-status-warning" : "bg-text-muted"}`} />
            <span className="text-xs text-text-secondary">{s.label}</span>
            <StatusBadge status={s.status} />
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Onboarding Hero (no agents yet) ── */

const onboardingSteps = [
  {
    step: 1,
    title: "Create your first agent",
    description: "Define an agent with a system prompt, model, and tools. Our wizard generates the config for you.",
    action: "Create Agent",
    path: "/agents/new",
    icon: Bot,
    color: "text-accent",
    bg: "bg-accent/10",
  },
  {
    step: 2,
    title: "Test in the Playground",
    description: "Chat with your agent interactively, inspect traces, and iterate on behavior before going live.",
    action: "Open Playground",
    path: "/agents",
    icon: Play,
    color: "text-chart-green",
    bg: "bg-chart-green/10",
  },
  {
    step: 3,
    title: "Connect tools & integrations",
    description: "Attach tools from the registry or connect external services via MCP servers and connectors.",
    action: "Browse Tools",
    path: "/tools",
    icon: Wrench,
    color: "text-chart-blue",
    bg: "bg-chart-blue/10",
  },
  {
    step: 4,
    title: "Deploy & monitor",
    description: "Deploy to a release channel, set up guardrails, and watch sessions, quality, and costs in real time.",
    action: "View Sessions",
    path: "/sessions",
    icon: Activity,
    color: "text-chart-purple",
    bg: "bg-chart-purple/10",
  },
];

function OnboardingHero({ onNavigate }: { onNavigate: (path: string) => void }) {
  return (
    <div className="w-full">
      {/* ── Welcome header — compact, left-aligned ────────────── */}
      <div className="flex items-start justify-between gap-6 mb-6">
        <div className="flex items-center gap-4">
          <div className="w-11 h-11 rounded-xl bg-accent/15 flex items-center justify-center flex-shrink-0">
            <Bot size={22} className="text-accent" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-text-primary">
              Welcome to AgentOS
            </h1>
            <p className="text-sm text-text-muted mt-0.5">
              Build, deploy, and monitor AI agents in 4 steps
            </p>
          </div>
        </div>
        <button
          className="btn btn-primary text-xs flex-shrink-0"
          onClick={() => onNavigate("/agents/new")}
        >
          <Bot size={14} />
          Create Agent
        </button>
      </div>

      {/* ── Steps — single horizontal row with connectors ────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
        {onboardingSteps.map((s, i) => (
          <button
            key={s.step}
            className="card card-hover text-left p-4 transition-all hover:border-accent/30 group relative stagger-item"
            style={{ "--stagger-index": i } as CSSProperties}
            onClick={() => onNavigate(s.path)}
          >
            {/* Step number + icon row */}
            <div className="flex items-center gap-2 mb-2">
              <span className="text-[9px] font-bold text-text-muted bg-surface-overlay rounded-full w-4 h-4 flex items-center justify-center flex-shrink-0">
                {s.step}
              </span>
              <div className={`p-1.5 rounded-md ${s.bg}`}>
                <s.icon size={14} className={s.color} />
              </div>
            </div>
            <h3 className="text-xs font-semibold text-text-primary mb-1">
              {s.title}
            </h3>
            <p className="text-[11px] text-text-muted leading-relaxed mb-2">
              {s.description}
            </p>
            <span className="text-[11px] text-accent font-medium group-hover:underline">
              {s.action} &rarr;
            </span>

            {/* Connector arrow between steps */}
            {i < onboardingSteps.length - 1 && (
              <div className="hidden lg:flex absolute -right-2 top-1/2 -translate-y-1/2 z-10 w-4 h-4 rounded-full bg-surface-raised border border-border-default items-center justify-center">
                <ChevronRight size={8} className="text-text-muted" />
              </div>
            )}
          </button>
        ))}
      </div>

      {/* ── Templates — start from a proven config ──────────── */}
      <div className="card p-4 mb-4">
        <p className="text-xs font-semibold text-text-primary mb-3">Start from a template</p>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
          {[
            { id: "code-reviewer", label: "Code Reviewer", icon: "🔍" },
            { id: "research-assistant", label: "Research Assistant", icon: "📚" },
            { id: "customer-support", label: "Customer Support", icon: "💬" },
            { id: "data-analyst", label: "Data Analyst", icon: "📊" },
            { id: "devops-agent", label: "DevOps Agent", icon: "🚀" },
          ].map((t) => (
            <button
              key={t.id}
              className="flex items-center gap-2 px-3 py-2.5 rounded-lg border border-border-default bg-surface-base text-xs font-medium text-text-secondary hover:border-accent/30 hover:text-text-primary transition-all"
              onClick={() => onNavigate(`/agents/new?template=${t.id}`)}
            >
              <span>{t.icon}</span>
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Meta-Agent — integrated as secondary path ─────────── */}
      <div className="card p-4 flex items-center gap-4">
        <div className="w-8 h-8 rounded-lg bg-accent/10 flex items-center justify-center flex-shrink-0">
          <Sparkles size={14} className="text-accent" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium text-text-secondary">
            Or describe what you need and the Meta-Agent will build it
          </p>
        </div>
        <AssistPanel
          compact
          customSuggestions={[
            { label: "Support agent", prompt: "Create a customer support agent with tools for order lookup, refund processing, and FAQ search" },
            { label: "Data analyst", prompt: "Create a data analysis agent that can query databases, generate reports, and send summaries via email" },
            { label: "Code reviewer", prompt: "Create a code review agent that analyzes pull requests, checks for security issues, and suggests improvements" },
          ]}
        />
      </div>
    </div>
  );
}

/* ── Cost Overview Card ── */
type CostLedger = { entries?: Array<{ agent_name: string; model: string; cost_usd: number; input_tokens: number; output_tokens: number }> };

function CostOverviewCard() {
  const costQuery = useApiQuery<CostLedger>("/api/v1/observability/cost-ledger");
  const entries = costQuery.data?.entries ?? [];

  if (entries.length === 0) return null;

  const totalCost = entries.reduce((acc, e) => acc + (e.cost_usd || 0), 0);
  const byAgent: Record<string, number> = {};
  for (const e of entries) {
    const name = e.agent_name || "unknown";
    byAgent[name] = (byAgent[name] || 0) + (e.cost_usd || 0);
  }
  const topAgents = Object.entries(byAgent).sort((a, b) => b[1] - a[1]).slice(0, 5);

  return (
    <div className="card card-glass mt-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-text-primary">Cost Overview</h3>
        <span className="text-xs font-mono text-accent">${totalCost.toFixed(4)}</span>
      </div>
      <div className="space-y-2">
        {topAgents.map(([name, cost]) => (
          <div key={name} className="flex items-center gap-3">
            <span className="text-xs text-text-secondary flex-1 truncate">{name}</span>
            <div className="flex-1 h-1.5 bg-surface-overlay rounded-full overflow-hidden">
              <div className="h-full bg-accent rounded-full" style={{ width: `${Math.min(100, (cost / totalCost) * 100)}%` }} />
            </div>
            <span className="text-xs font-mono text-text-muted w-16 text-right">${cost.toFixed(4)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
