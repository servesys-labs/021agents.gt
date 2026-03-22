import { useEffect, useRef, useState } from "react";
import { Chart, registerables } from "chart.js";
import { PageHeader } from "../../components/common/PageHeader";
import { QueryState } from "../../components/common/QueryState";
import { safeArray, summarizeCoverage, toNumber } from "../../lib/adapters";
import type { AgentInfo, DailyUsageResponse, SessionSummaryResponse, UsageResponse } from "../../lib/adapters";
import { useApiQuery } from "../../lib/api";

Chart.register(...registerables);

/* ── Metric Card ─────────────────────────────────────────────── */
function MetricCard({
  label,
  value,
  subtitle,
  live,
}: {
  label: string;
  value: string | number;
  subtitle?: string;
  live?: boolean;
}) {
  return (
    <div className="card">
      <div className="flex items-center justify-between mb-3">
        <span className="text-[11px] font-semibold tracking-wider uppercase text-text-muted">
          {label}
        </span>
        {live && <span className="badge-live">LIVE</span>}
      </div>
      <div className="text-3xl font-bold text-text-primary font-mono tracking-tight">
        {value}
      </div>
      {subtitle && (
        <p className="mt-1.5 text-xs text-text-muted uppercase tracking-wide">
          {subtitle}
        </p>
      )}
    </div>
  );
}

/* ── Time Range Selector ─────────────────────────────────────── */
function TimeRangeSelector({
  active,
  onChange,
}: {
  active: string;
  onChange: (v: string) => void;
}) {
  const ranges = ["7D", "14D", "30D"];
  return (
    <div className="flex items-center gap-1 bg-surface-base rounded-md border border-border-default p-0.5">
      {ranges.map((r) => (
        <button
          key={r}
          onClick={() => onChange(r)}
          className={`px-2.5 py-1 text-[11px] font-medium rounded transition-colors ${
            active === r
              ? "bg-surface-overlay text-text-primary"
              : "text-text-muted hover:text-text-secondary"
          }`}
        >
          {r}
        </button>
      ))}
    </div>
  );
}

/* ── Area Chart Component ────────────────────────────────────── */
function AreaChartWidget({
  data,
  label,
  color,
  valuePrefix,
}: {
  data: { label: string; value: number }[];
  label: string;
  color: string;
  valuePrefix?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<Chart | null>(null);

  useEffect(() => {
    if (!canvasRef.current || data.length === 0) return;

    if (chartRef.current) {
      chartRef.current.destroy();
    }

    const ctx = canvasRef.current.getContext("2d");
    if (!ctx) return;

    const gradient = ctx.createLinearGradient(0, 0, 0, 250);
    gradient.addColorStop(0, color + "30");
    gradient.addColorStop(1, color + "00");

    chartRef.current = new Chart(ctx, {
      type: "line",
      data: {
        labels: data.map((d) => d.label),
        datasets: [
          {
            label,
            data: data.map((d) => d.value),
            borderColor: color,
            backgroundColor: gradient,
            borderWidth: 2,
            fill: true,
            tension: 0.3,
            pointRadius: 0,
            pointHoverRadius: 4,
            pointHoverBackgroundColor: color,
            pointHoverBorderColor: "#fff",
            pointHoverBorderWidth: 2,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: {
          intersect: false,
          mode: "index",
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: "#1C1917",
            titleColor: "#FAFAF9",
            bodyColor: "#A8A29E",
            borderColor: "#292524",
            borderWidth: 1,
            padding: 10,
            displayColors: false,
            callbacks: {
              label: (ctx) => `${valuePrefix || ""}${ctx.parsed.y.toFixed(4)}`,
            },
          },
        },
        scales: {
          x: {
            grid: {
              color: "#292524",
              drawTicks: false,
            },
            border: { display: false },
            ticks: {
              color: "#78716C",
              font: { size: 10, family: "monospace" },
              maxTicksLimit: 8,
            },
          },
          y: {
            grid: {
              color: "#29252440",
            },
            border: { display: false },
            ticks: {
              color: "#78716C",
              font: { size: 10, family: "monospace" },
              callback: (v) => `${valuePrefix || ""}${v}`,
            },
          },
        },
      },
    });

    return () => {
      chartRef.current?.destroy();
    };
  }, [data, label, color, valuePrefix]);

  return <canvas ref={canvasRef} />;
}

/* ── Bar Chart Component ─────────────────────────────────────── */
function BarChartWidget({
  data,
  color,
  valuePrefix,
}: {
  data: { name: string; value: number }[];
  color: string;
  valuePrefix?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<Chart | null>(null);

  useEffect(() => {
    if (!canvasRef.current || data.length === 0) return;

    if (chartRef.current) {
      chartRef.current.destroy();
    }

    chartRef.current = new Chart(canvasRef.current, {
      type: "bar",
      data: {
        labels: data.map((d) => d.name),
        datasets: [
          {
            data: data.map((d) => d.value),
            backgroundColor: color + "CC",
            hoverBackgroundColor: color,
            borderRadius: 3,
            barThickness: 24,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        indexAxis: "y",
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: "#1C1917",
            titleColor: "#FAFAF9",
            bodyColor: "#A8A29E",
            borderColor: "#292524",
            borderWidth: 1,
            callbacks: {
              label: (ctx) => `${valuePrefix || ""}${ctx.parsed.x.toFixed(4)}`,
            },
          },
        },
        scales: {
          x: {
            grid: { color: "#29252440" },
            border: { display: false },
            ticks: {
              color: "#78716C",
              font: { size: 10, family: "monospace" },
              callback: (v) => `${valuePrefix || ""}${v}`,
            },
          },
          y: {
            grid: { display: false },
            border: { display: false },
            ticks: {
              color: "#A8A29E",
              font: { size: 11 },
            },
          },
        },
      },
    });

    return () => {
      chartRef.current?.destroy();
    };
  }, [data, color, valuePrefix]);

  return <canvas ref={canvasRef} />;
}

/* ── Dashboard Page ──────────────────────────────────────────── */
export const DashboardPage = () => {
  const [timeRange, setTimeRange] = useState("30D");
  const [activeTab, setActiveTab] = useState<"cost" | "model" | "type">("cost");

  const usageQuery = useApiQuery<UsageResponse>("/api/v1/billing/usage");
  const dailyQuery = useApiQuery<DailyUsageResponse>("/api/v1/billing/usage/daily");
  const agentsQuery = useApiQuery<AgentInfo[]>("/api/v1/agents");
  const sessionsQuery = useApiQuery<SessionSummaryResponse>("/api/v1/sessions/stats/summary");
  const openApiQuery = useApiQuery<{ paths?: Record<string, unknown> }>("/openapi.json");

  const usageData = usageQuery.data;
  const dailyData = safeArray<{ day: string; cost?: number; call_count?: number }>(dailyQuery.data?.days);
  const agentsList = safeArray<AgentInfo>(agentsQuery.data);
  const stats = sessionsQuery.data;
  const openApiPaths = openApiQuery.data?.paths ? Object.keys(openApiQuery.data.paths) : [];
  const coverage = summarizeCoverage(openApiPaths);

  const chartData = dailyData.map((d) => ({
    label: d.day,
    value: toNumber(d.cost),
  }));

  const sessionChartData = dailyData.map((d) => ({
    label: d.day,
    value: toNumber(d.call_count),
  }));

  const modelCosts = Object.entries(usageData?.by_model ?? {}).map(([name, cost]) => ({
    name: name.split("/").pop() || name,
    value: Number(cost),
  }));

  const costByType = Object.entries(usageData?.by_cost_type ?? {}).map(([name, cost]) => ({
    name,
    value: Number(cost),
  }));

  const isLoading = usageQuery.loading || dailyQuery.loading || agentsQuery.loading || sessionsQuery.loading;
  const error = usageQuery.error ?? dailyQuery.error ?? agentsQuery.error ?? sessionsQuery.error;

  const handleRefresh = () => {
    void usageQuery.refetch();
    void dailyQuery.refetch();
    void agentsQuery.refetch();
    void sessionsQuery.refetch();
  };

  return (
    <div>
      <PageHeader
        title="Dashboard"
        subtitle="Control-plane overview for agents, sessions, and cost"
        liveCount={agentsList.length}
        liveLabel="Agents"
        onRefresh={handleRefresh}
      />

      <QueryState
        loading={isLoading}
        error={error}
        isEmpty={!usageData}
        emptyMessage="No dashboard data yet. Deploy some agents to get started."
        onRetry={handleRefresh}
      >
        {/* KPI Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          <MetricCard
            label="Total Cost"
            value={`$${toNumber(usageData?.total_cost_usd).toFixed(4)}`}
            subtitle="Last 30 days"
            live
          />
          <MetricCard
            label="Sessions"
            value={toNumber(stats?.total_sessions)}
            subtitle={`Avg ${toNumber(stats?.avg_duration_seconds).toFixed(1)}s`}
            live
          />
          <MetricCard
            label="Active Agents"
            value={agentsList.length}
            subtitle="Configured agents"
          />
          <MetricCard
            label="Endpoint Coverage"
            value={coverage.total}
            subtitle={`${coverage.v1} v1 + ${coverage.legacy} legacy`}
          />
        </div>

        {/* Charts Section */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
          {/* Daily Cost Chart */}
          <div className="card">
            <div className="flex items-center justify-between mb-4">
              <div>
                <span className="text-[11px] font-semibold tracking-wider uppercase text-text-muted">
                  Daily Cost
                </span>
                <div className="text-xl font-bold text-text-primary font-mono mt-1">
                  ${toNumber(usageData?.total_cost_usd).toFixed(4)}
                </div>
                <span className="text-xs text-text-muted">TOTAL OVER RANGE</span>
              </div>
              <TimeRangeSelector active={timeRange} onChange={setTimeRange} />
            </div>
            <div className="h-56">
              {chartData.length > 0 ? (
                <AreaChartWidget
                  data={chartData}
                  label="Cost"
                  color="#F97316"
                  valuePrefix="$"
                />
              ) : (
                <div className="flex items-center justify-center h-full text-sm text-text-muted">
                  No usage data yet. Run some agents.
                </div>
              )}
            </div>
          </div>

          {/* Sessions Chart */}
          <div className="card">
            <div className="flex items-center justify-between mb-4">
              <div>
                <span className="text-[11px] font-semibold tracking-wider uppercase text-text-muted">
                  Sessions
                </span>
                <div className="text-xl font-bold text-text-primary font-mono mt-1">
                  {toNumber(stats?.total_sessions)}
                </div>
                <span className="text-xs text-text-muted">TOTAL OVER RANGE</span>
              </div>
            </div>
            <div className="h-56">
              {sessionChartData.length > 0 ? (
                <AreaChartWidget
                  data={sessionChartData}
                  label="Sessions"
                  color="#22C55E"
                />
              ) : (
                <div className="flex items-center justify-center h-full text-sm text-text-muted">
                  No session data yet.
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Tabbed Section */}
        <div className="card">
          <div className="flex items-center gap-1 border-b border-border-default mb-4 -mx-5 px-5">
            {(
              [
                { key: "cost", label: "Cost Over Time" },
                { key: "model", label: "By Model" },
                { key: "type", label: "By Type" },
              ] as const
            ).map((tab) => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px ${
                  activeTab === tab.key
                    ? "border-accent text-accent"
                    : "border-transparent text-text-muted hover:text-text-secondary"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="h-64">
            {activeTab === "cost" && (
              chartData.length > 0 ? (
                <AreaChartWidget data={chartData} label="Daily Cost" color="#F97316" valuePrefix="$" />
              ) : (
                <div className="flex items-center justify-center h-full text-sm text-text-muted">
                  No usage data yet. Run some agents.
                </div>
              )
            )}
            {activeTab === "model" && (
              modelCosts.length > 0 ? (
                <BarChartWidget data={modelCosts} color="#F97316" valuePrefix="$" />
              ) : (
                <div className="flex items-center justify-center h-full text-sm text-text-muted">
                  No model data.
                </div>
              )
            )}
            {activeTab === "type" && (
              costByType.length > 0 ? (
                <BarChartWidget data={costByType} color="#22C55E" valuePrefix="$" />
              ) : (
                <div className="flex items-center justify-center h-full text-sm text-text-muted">
                  No cost data.
                </div>
              )
            )}
          </div>
        </div>
      </QueryState>
    </div>
  );
};
