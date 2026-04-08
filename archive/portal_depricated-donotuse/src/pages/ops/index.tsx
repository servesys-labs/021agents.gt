import { useState, useEffect, useMemo, useCallback } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Clock,
  DollarSign,
  Heart,
  RefreshCw,
  Shield,
  Webhook,
  Layers,
  Users,
  Bot,
  Zap,
  Timer,
} from "lucide-react";

import { PageHeader } from "../../components/common/PageHeader";
import { PageShell } from "../../components/layout/PageShell";
import { useApiQuery } from "../../lib/api";
import { safeArray, type AgentInfo } from "../../lib/adapters";

/* ── Types ──────────────────────────────────────────────────────── */

type AgentHealth = {
  agent_name: string;
  status: "healthy" | "degraded" | "unhealthy";
  latency_ms?: number;
  error_rate_pct?: number;
};

type LatencyPercentiles = {
  p50: number;
  p75: number;
  p95: number;
  p99: number;
};

type ErrorBreakdown = {
  success: number;
  error: number;
  timeout: number;
};

type WebhookHealth = {
  total_delivered: number;
  total_failed: number;
  success_rate_pct: number;
  recent_failures: WebhookFailure[];
};

type WebhookFailure = {
  webhook_id: string;
  url: string;
  status_code: number;
  timestamp: string;
  error?: string;
};

type BatchStatus = {
  pending: number;
  running: number;
  completed: number;
  failed: number;
};

type ConcurrentInfo = {
  active_sessions: number;
  active_users: number;
  active_agents: number;
};

type CostBudget = {
  cost_today_usd: number;
  daily_budget_usd: number;
  budget_pct: number;
};

type RateLimitEntry = {
  key: string;
  breaches_24h: number;
  last_breach?: string;
};

type RateLimitLog = {
  total_breaches_24h: number;
  entries: RateLimitEntry[];
};

type SloEntry = {
  metric: string;
  threshold: string;
  current_value: string;
  status: "pass" | "breach";
  last_checked: string;
};

type Incident = {
  id: string;
  type: string;
  agent_name?: string;
  severity: "low" | "medium" | "high" | "critical";
  message: string;
  timestamp: string;
};

/* ── Helpers ────────────────────────────────────────────────────── */

function timeAgo(seconds: number): string {
  if (seconds < 60) return `${seconds}s ago`;
  const mins = Math.floor(seconds / 60);
  return `${mins}m ${seconds % 60}s ago`;
}

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

function formatTs(ts: string): string {
  try {
    const d = new Date(ts);
    return d.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  } catch {
    return ts;
  }
}

function healthColor(status: string): string {
  switch (status) {
    case "healthy":
      return "bg-status-live";
    case "degraded":
      return "bg-status-warning";
    case "unhealthy":
      return "bg-status-error";
    default:
      return "bg-text-muted";
  }
}

function severityColor(severity: string): string {
  switch (severity) {
    case "critical":
      return "text-status-error";
    case "high":
      return "text-status-error";
    case "medium":
      return "text-status-warning";
    case "low":
      return "text-status-info";
    default:
      return "text-text-muted";
  }
}

function severityBg(severity: string): string {
  switch (severity) {
    case "critical":
      return "bg-status-error/10 border-status-error/20";
    case "high":
      return "bg-status-error/10 border-status-error/20";
    case "medium":
      return "bg-status-warning/10 border-status-warning/20";
    case "low":
      return "bg-status-info/10 border-status-info/20";
    default:
      return "bg-surface-overlay border-border-default";
  }
}

function n(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/* ── Donut Chart (SVG) ──────────────────────────────────────────── */

function DonutChart({
  segments,
  size = 160,
}: {
  segments: { label: string; value: number; color: string }[];
  size?: number;
}) {
  const total = segments.reduce((s, seg) => s + seg.value, 0);
  if (total === 0) {
    return (
      <div className="flex items-center justify-center" style={{ width: size, height: size }}>
        <span className="text-text-muted text-sm">No data</span>
      </div>
    );
  }
  const radius = 56;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;

  return (
    <div className="flex items-center gap-6">
      <svg width={size} height={size} viewBox="0 0 160 160">
        {segments.map((seg, i) => {
          const pct = seg.value / total;
          const dash = pct * circumference;
          const gap = circumference - dash;
          const rotation = (offset / total) * 360 - 90;
          offset += seg.value;
          return (
            <circle
              key={i}
              cx="80"
              cy="80"
              r={radius}
              fill="none"
              stroke={seg.color}
              strokeWidth="20"
              strokeDasharray={`${dash} ${gap}`}
              transform={`rotate(${rotation} 80 80)`}
            />
          );
        })}
        <text x="80" y="76" textAnchor="middle" className="fill-text-primary text-lg font-bold">
          {total.toLocaleString()}
        </text>
        <text x="80" y="96" textAnchor="middle" className="fill-text-muted text-xs">
          total
        </text>
      </svg>
      <div className="flex flex-col gap-2">
        {segments.map((seg, i) => (
          <div key={i} className="flex items-center gap-2 text-sm">
            <span className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: seg.color }} />
            <span className="text-text-secondary">{seg.label}</span>
            <span className="text-text-primary font-medium ml-auto">{seg.value.toLocaleString()}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Horizontal Bar ─────────────────────────────────────────────── */

function HBar({ label, value, max, color }: { label: string; value: number; max: number; color: string }) {
  const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0;
  return (
    <div className="flex items-center gap-3">
      <span className="text-sm text-text-muted w-10 text-right font-mono">{label}</span>
      <div className="flex-1 h-6 bg-surface-overlay rounded overflow-hidden relative">
        <div
          className="h-full rounded transition-all duration-500"
          style={{ width: `${pct}%`, backgroundColor: color }}
        />
        <span className="absolute inset-0 flex items-center justify-center text-xs font-medium text-text-primary">
          {value.toLocaleString()}ms
        </span>
      </div>
    </div>
  );
}

/* ── Progress Bar ───────────────────────────────────────────────── */

function ProgressBar({ value, max, color }: { value: number; max: number; color: string }) {
  const total = max > 0 ? max : 1;
  const pct = Math.min((value / total) * 100, 100);
  return (
    <div className="w-full h-2 bg-surface-overlay rounded-full overflow-hidden">
      <div
        className="h-full rounded-full transition-all duration-500"
        style={{ width: `${pct}%`, backgroundColor: color }}
      />
    </div>
  );
}

/* ── Card Wrapper ───────────────────────────────────────────────── */

function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`card ${className}`}>{children}</div>;
}

function CardTitle({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted flex items-center gap-2 mb-4">
      {icon}
      {children}
    </h3>
  );
}

/* ── Main Page ──────────────────────────────────────────────────── */

export function OpsPage() {
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date>(new Date());
  const [secondsAgo, setSecondsAgo] = useState(0);

  // Data queries
  const agentsQuery = useApiQuery<AgentInfo[]>("/api/v1/agents");
  const latencyQuery = useApiQuery<LatencyPercentiles>("/api/v1/ops/latency-percentiles?since_hours=24");
  const errorQuery = useApiQuery<ErrorBreakdown>("/api/v1/ops/error-breakdown?since_hours=24");
  const webhookQuery = useApiQuery<WebhookHealth>("/api/v1/ops/webhooks/health?window_minutes=60");
  const batchQuery = useApiQuery<BatchStatus>("/api/v1/ops/batch/status");
  const concurrentQuery = useApiQuery<ConcurrentInfo>("/api/v1/ops/concurrent");
  const costQuery = useApiQuery<CostBudget>("/api/v1/ops/cost-budget");
  const rateLimitQuery = useApiQuery<RateLimitLog>("/api/v1/ops/rate-limits/log");
  const sloQuery = useApiQuery<SloEntry[]>("/api/v1/slos/status");
  const incidentQuery = useApiQuery<Incident[]>("/api/v1/observability/incidents?since_hours=24");

  const agents = useMemo(() => safeArray<AgentInfo>(agentsQuery.data), [agentsQuery.data]);

  // Per-agent health queries -- fetch for up to 8 agents
  const agentNames = useMemo(() => agents.slice(0, 8).map((a) => a.name), [agents]);
  const [agentHealthMap, setAgentHealthMap] = useState<Record<string, AgentHealth>>({});

  useEffect(() => {
    if (agentNames.length === 0) return;
    let cancelled = false;
    async function fetchHealth() {
      const results: Record<string, AgentHealth> = {};
      await Promise.allSettled(
        agentNames.map(async (name) => {
          try {
            const resp = await fetch(
              `${import.meta.env.VITE_API_URL ?? ""}/api/v1/ops/agents/${encodeURIComponent(name)}/health`,
              {
                headers: {
                  Authorization: `Bearer ${localStorage.getItem("agentos_token") ?? ""}`,
                  "Content-Type": "application/json",
                },
              },
            );
            if (resp.ok) {
              const data = (await resp.json()) as AgentHealth;
              results[name] = { ...data, agent_name: name };
            } else {
              results[name] = { agent_name: name, status: "unhealthy" };
            }
          } catch {
            results[name] = { agent_name: name, status: "unhealthy" };
          }
        }),
      );
      if (!cancelled) setAgentHealthMap(results);
    }
    void fetchHealth();
    return () => {
      cancelled = true;
    };
  }, [agentNames]);

  // Derived values
  const latencyRaw = latencyQuery.data ?? {};
  const latency: LatencyPercentiles = {
    p50: n((latencyRaw as Partial<LatencyPercentiles>).p50),
    p75: n((latencyRaw as Partial<LatencyPercentiles>).p75),
    p95: n((latencyRaw as Partial<LatencyPercentiles>).p95),
    p99: n((latencyRaw as Partial<LatencyPercentiles>).p99),
  };
  const errorsRaw = errorQuery.data ?? {};
  const errors: ErrorBreakdown = {
    success: n((errorsRaw as Partial<ErrorBreakdown>).success),
    error: n((errorsRaw as Partial<ErrorBreakdown>).error),
    timeout: n((errorsRaw as Partial<ErrorBreakdown>).timeout),
  };
  const webhookRaw = webhookQuery.data ?? {};
  const webhook: WebhookHealth = {
    total_delivered: n((webhookRaw as Partial<WebhookHealth>).total_delivered),
    total_failed: n((webhookRaw as Partial<WebhookHealth>).total_failed),
    success_rate_pct: n((webhookRaw as Partial<WebhookHealth>).success_rate_pct, 100),
    recent_failures: safeArray<WebhookFailure>((webhookRaw as Partial<WebhookHealth>).recent_failures),
  };
  const batchRaw = batchQuery.data ?? {};
  const batch: BatchStatus = {
    pending: n((batchRaw as Partial<BatchStatus>).pending),
    running: n((batchRaw as Partial<BatchStatus>).running),
    completed: n((batchRaw as Partial<BatchStatus>).completed),
    failed: n((batchRaw as Partial<BatchStatus>).failed),
  };
  const concurrentRaw = concurrentQuery.data ?? {};
  const concurrent: ConcurrentInfo = {
    active_sessions: n((concurrentRaw as Partial<ConcurrentInfo>).active_sessions),
    active_users: n((concurrentRaw as Partial<ConcurrentInfo>).active_users),
    active_agents: n((concurrentRaw as Partial<ConcurrentInfo>).active_agents),
  };
  const costRaw = costQuery.data ?? {};
  const cost: CostBudget = {
    cost_today_usd: n((costRaw as Partial<CostBudget>).cost_today_usd),
    daily_budget_usd: n((costRaw as Partial<CostBudget>).daily_budget_usd, 100),
    budget_pct: n((costRaw as Partial<CostBudget>).budget_pct),
  };
  const rateLimitRaw = rateLimitQuery.data ?? {};
  const rateLimit: RateLimitLog = {
    total_breaches_24h: n((rateLimitRaw as Partial<RateLimitLog>).total_breaches_24h),
    entries: safeArray<RateLimitEntry>((rateLimitRaw as Partial<RateLimitLog>).entries),
  };
  const slos = useMemo(() => safeArray<SloEntry>(sloQuery.data), [sloQuery.data]);
  const incidents = useMemo(() => safeArray<Incident>(incidentQuery.data), [incidentQuery.data]);

  const totalRequests = errors.success + errors.error + errors.timeout;
  const errorRatePct = totalRequests > 0 ? ((errors.error + errors.timeout) / totalRequests) * 100 : 0;

  // Refetch all
  const refetchAll = useCallback(() => {
    void agentsQuery.refetch();
    void latencyQuery.refetch();
    void errorQuery.refetch();
    void webhookQuery.refetch();
    void batchQuery.refetch();
    void concurrentQuery.refetch();
    void costQuery.refetch();
    void rateLimitQuery.refetch();
    void sloQuery.refetch();
    void incidentQuery.refetch();
    setLastUpdated(new Date());
  }, [
    agentsQuery, latencyQuery, errorQuery, webhookQuery, batchQuery,
    concurrentQuery, costQuery, rateLimitQuery, sloQuery, incidentQuery,
  ]);

  // Auto-refresh timer
  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(() => {
      refetchAll();
    }, 30_000);
    return () => clearInterval(interval);
  }, [autoRefresh, refetchAll]);

  // Seconds-ago ticker
  useEffect(() => {
    const tick = setInterval(() => {
      setSecondsAgo(Math.floor((Date.now() - lastUpdated.getTime()) / 1000));
    }, 1000);
    return () => clearInterval(tick);
  }, [lastUpdated]);

  const batchTotal = batch.pending + batch.running + batch.completed + batch.failed;

  return (
    <PageShell variant="wide">
      <PageHeader
        title="Operations"
        subtitle="Real-time system health and SRE monitoring"
        icon={<Activity size={18} />}
        onRefresh={refetchAll}
        actions={
          <div className="flex items-center gap-4">
            {/* Last updated */}
            <span className="text-xs text-text-muted">
              Updated {timeAgo(secondsAgo)}
            </span>

            {/* Auto-refresh toggle */}
            <button
              onClick={() => setAutoRefresh((v) => !v)}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                autoRefresh
                  ? "bg-status-live/15 text-status-live border border-status-live/30"
                  : "bg-surface-overlay text-text-secondary border border-border-default hover:border-border-strong"
              }`}
            >
              <RefreshCw size={12} className={autoRefresh ? "animate-spin" : ""} />
              Auto-refresh {autoRefresh ? "ON" : "OFF"}
            </button>
          </div>
        }
      />

      <div className="flex flex-col gap-6">
        {/* ── Row 1: Health Cards ───────────────────────────────────── */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {/* Agent Health */}
          <Card>
            <CardTitle icon={<Heart size={14} />}>Agent Health</CardTitle>
            <div className="flex flex-col gap-2">
              {agentNames.length === 0 && (
                <span className="text-sm text-text-muted">No agents found</span>
              )}
              {agentNames.map((name) => {
                const h = agentHealthMap[name];
                const status = h?.status ?? "unknown";
                return (
                  <div key={name} className="flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full shrink-0 ${healthColor(status)}`} />
                    <span className="text-sm text-text-secondary truncate flex-1">{name}</span>
                    <span className="text-xs text-text-muted capitalize">{status}</span>
                  </div>
                );
              })}
            </div>
          </Card>

          {/* Error Rate */}
          <Card>
            <CardTitle icon={<AlertTriangle size={14} />}>Error Rate</CardTitle>
            <div className="flex items-end gap-2 mb-2">
              <span
                className={`text-3xl font-bold ${
                  errorRatePct > 5 ? "text-status-error" : "text-text-primary"
                }`}
              >
                {errorRatePct.toFixed(1)}%
              </span>
              {errorRatePct > 5 ? (
                <ArrowUp size={16} className="text-status-error mb-1" />
              ) : (
                <ArrowDown size={16} className="text-status-live mb-1" />
              )}
            </div>
            <p className="text-xs text-text-muted">
              {errors.error + errors.timeout} errors / {totalRequests.toLocaleString()} requests (24h)
            </p>
          </Card>

          {/* P95 Latency */}
          <Card>
            <CardTitle icon={<Clock size={14} />}>P95 Latency</CardTitle>
            <div className="flex items-end gap-2 mb-2">
              <span
                className={`text-3xl font-bold ${
                  latency.p95 > 5000 ? "text-status-warning" : "text-text-primary"
                }`}
              >
                {latency.p95.toLocaleString()}
              </span>
              <span className="text-sm text-text-muted mb-1">ms</span>
            </div>
            <p className="text-xs text-text-muted">
              p50: {latency.p50.toLocaleString()}ms | p99: {latency.p99.toLocaleString()}ms
            </p>
          </Card>

          {/* Cost Today */}
          <Card>
            <CardTitle icon={<DollarSign size={14} />}>Cost Today</CardTitle>
            <div className="flex items-end gap-2 mb-3">
              <span className="text-3xl font-bold text-text-primary">
                {formatCurrency(cost.cost_today_usd)}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <ProgressBar
                value={cost.cost_today_usd}
                max={cost.daily_budget_usd}
                color={cost.budget_pct > 90 ? "#EF4444" : cost.budget_pct > 70 ? "#EAB308" : "#22C55E"}
              />
              <span className="text-xs text-text-muted whitespace-nowrap">
                {cost.budget_pct.toFixed(0)}% of {formatCurrency(cost.daily_budget_usd)}
              </span>
            </div>
          </Card>
        </div>

        {/* ── Row 2: Latency Distribution + Error Breakdown ────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Latency Distribution */}
          <Card>
            <CardTitle icon={<Timer size={14} />}>Latency Distribution (24h)</CardTitle>
            <div className="flex flex-col gap-3">
              <HBar label="p50" value={latency.p50} max={latency.p99 || 1} color="#22C55E" />
              <HBar label="p75" value={latency.p75} max={latency.p99 || 1} color="#3B82F6" />
              <HBar label="p95" value={latency.p95} max={latency.p99 || 1} color="#EAB308" />
              <HBar label="p99" value={latency.p99} max={latency.p99 || 1} color="#EF4444" />
            </div>
          </Card>

          {/* Error Breakdown */}
          <Card>
            <CardTitle icon={<AlertTriangle size={14} />}>Error Breakdown (24h)</CardTitle>
            <DonutChart
              segments={[
                { label: "Success", value: errors.success, color: "#22C55E" },
                { label: "Error", value: errors.error, color: "#EF4444" },
                { label: "Timeout", value: errors.timeout, color: "#EAB308" },
              ]}
            />
          </Card>
        </div>

        {/* ── Row 3: Active Sessions + Rate Limits ─────────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Active Sessions */}
          <Card>
            <CardTitle icon={<Users size={14} />}>Active Sessions</CardTitle>
            <div className="grid grid-cols-3 gap-4">
              <div className="flex flex-col items-center gap-1 py-3 rounded-lg bg-surface-overlay">
                <Zap size={18} className="text-chart-blue" />
                <span className="text-2xl font-bold text-text-primary">
                  {concurrent.active_sessions}
                </span>
                <span className="text-xs text-text-muted">Sessions</span>
              </div>
              <div className="flex flex-col items-center gap-1 py-3 rounded-lg bg-surface-overlay">
                <Users size={18} className="text-chart-purple" />
                <span className="text-2xl font-bold text-text-primary">
                  {concurrent.active_users}
                </span>
                <span className="text-xs text-text-muted">Users</span>
              </div>
              <div className="flex flex-col items-center gap-1 py-3 rounded-lg bg-surface-overlay">
                <Bot size={18} className="text-chart-green" />
                <span className="text-2xl font-bold text-text-primary">
                  {concurrent.active_agents}
                </span>
                <span className="text-xs text-text-muted">Agents</span>
              </div>
            </div>
          </Card>

          {/* Rate Limits */}
          <Card>
            <CardTitle icon={<Shield size={14} />}>Rate Limits (24h)</CardTitle>
            <div className="mb-3">
              <span className="text-2xl font-bold text-text-primary">
                {rateLimit.total_breaches_24h}
              </span>
              <span className="text-sm text-text-muted ml-2">breaches</span>
            </div>
            {rateLimit.entries.length === 0 ? (
              <p className="text-sm text-text-muted">No rate limit breaches in the last 24 hours.</p>
            ) : (
              <div className="flex flex-col gap-2 max-h-40 overflow-y-auto">
                {rateLimit.entries.slice(0, 10).map((entry, i) => (
                  <div key={i} className="flex items-center justify-between text-sm">
                    <span className="text-text-secondary font-mono truncate flex-1">{entry.key}</span>
                    <span className="text-status-error font-medium ml-2">
                      {entry.breaches_24h}x
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>

        {/* ── Row 4: Webhook Health + Batch Jobs ───────────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Webhook Health */}
          <Card>
            <CardTitle icon={<Webhook size={14} />}>Webhook Health (60m)</CardTitle>
            <div className="flex items-center gap-4 mb-4">
              <div>
                <span
                  className={`text-2xl font-bold ${
                    webhook.success_rate_pct < 95 ? "text-status-error" : "text-status-live"
                  }`}
                >
                  {webhook.success_rate_pct.toFixed(1)}%
                </span>
                <span className="text-sm text-text-muted ml-2">delivery rate</span>
              </div>
              <div className="text-xs text-text-muted">
                {webhook.total_delivered.toLocaleString()} delivered / {webhook.total_failed.toLocaleString()} failed
              </div>
            </div>
            {webhook.recent_failures.length > 0 && (
              <div className="border-t border-border-default pt-3">
                <p className="text-xs text-text-muted uppercase tracking-wide mb-2">Recent Failures</p>
                <div className="flex flex-col gap-2 max-h-32 overflow-y-auto">
                  {webhook.recent_failures.slice(0, 5).map((f, i) => (
                    <div key={i} className="flex items-center gap-2 text-xs">
                      <span className="text-status-error font-mono">{f.status_code}</span>
                      <span className="text-text-secondary truncate flex-1">{f.url}</span>
                      <span className="text-text-muted">{formatTs(f.timestamp)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </Card>

          {/* Batch Jobs */}
          <Card>
            <CardTitle icon={<Layers size={14} />}>Batch Jobs</CardTitle>
            <div className="flex flex-col gap-4">
              {(
                [
                  { label: "Pending", value: batch.pending, color: "#A8A29E" },
                  { label: "Running", value: batch.running, color: "#3B82F6" },
                  { label: "Completed", value: batch.completed, color: "#22C55E" },
                  { label: "Failed", value: batch.failed, color: "#EF4444" },
                ] as const
              ).map((item) => (
                <div key={item.label}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-sm text-text-secondary">{item.label}</span>
                    <span className="text-sm font-medium text-text-primary">{item.value}</span>
                  </div>
                  <ProgressBar value={item.value} max={batchTotal || 1} color={item.color} />
                </div>
              ))}
            </div>
          </Card>
        </div>

        {/* ── Row 5: SLO Status ────────────────────────────────────── */}
        <Card>
          <CardTitle icon={<Shield size={14} />}>SLO Status</CardTitle>
          {slos.length === 0 ? (
            <p className="text-sm text-text-muted">No SLOs configured.</p>
          ) : (
            <div className="overflow-x-auto">
              <table>
                <thead>
                  <tr>
                    <th>Metric</th>
                    <th>Threshold</th>
                    <th>Current</th>
                    <th>Status</th>
                    <th>Last Checked</th>
                  </tr>
                </thead>
                <tbody>
                  {slos.map((slo, i) => (
                    <tr key={i}>
                      <td className="font-medium text-text-primary">{slo.metric}</td>
                      <td className="font-mono">{slo.threshold}</td>
                      <td className="font-mono">{slo.current_value}</td>
                      <td>
                        <span
                          className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-semibold uppercase tracking-wide ${
                            slo.status === "pass"
                              ? "bg-status-live/15 text-status-live"
                              : "bg-status-error/15 text-status-error"
                          }`}
                        >
                          <span
                            className={`w-1.5 h-1.5 rounded-full ${
                              slo.status === "pass" ? "bg-status-live" : "bg-status-error"
                            }`}
                          />
                          {slo.status}
                        </span>
                      </td>
                      <td className="text-text-muted">{formatTs(slo.last_checked)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {/* ── Row 6: Recent Incidents ──────────────────────────────── */}
        <Card>
          <CardTitle icon={<AlertTriangle size={14} />}>Recent Incidents (24h)</CardTitle>
          {incidents.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-8">
              <Activity size={20} className="text-status-live" />
              <p className="text-sm text-text-muted">No incidents in the last 24 hours.</p>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {incidents.map((inc) => (
                <div
                  key={inc.id}
                  className={`flex items-start gap-3 p-3 rounded-lg border ${severityBg(inc.severity)}`}
                >
                  <AlertTriangle size={16} className={`mt-0.5 shrink-0 ${severityColor(inc.severity)}`} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className={`text-xs font-semibold uppercase ${severityColor(inc.severity)}`}>
                        {inc.severity}
                      </span>
                      <span className="text-xs text-text-muted">{inc.type}</span>
                      {inc.agent_name && (
                        <span className="text-xs font-mono text-text-secondary bg-surface-overlay px-1.5 py-0.5 rounded">
                          {inc.agent_name}
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-text-secondary">{inc.message}</p>
                  </div>
                  <span className="text-xs text-text-muted whitespace-nowrap shrink-0">
                    {formatTs(inc.timestamp)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </PageShell>
  );
}
