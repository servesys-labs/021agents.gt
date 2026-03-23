import { useMemo } from "react";
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
} from "lucide-react";

import { PageHeader } from "../../components/common/PageHeader";
import { StatusBadge } from "../../components/common/StatusBadge";
import { useApiQuery } from "../../lib/api";

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
type RecentActivity = {
  id: string;
  type: string;
  message: string;
  agent_name?: string;
  timestamp?: string;
};

export const DashboardPage = () => {
  const navigate = useNavigate();
  const statsQuery = useApiQuery<DashStats>("/api/v1/dashboard/stats");
  const activityQuery = useApiQuery<{ activities: RecentActivity[] }>("/api/v1/dashboard/activity?limit=10");
  const stats = statsQuery.data ?? {};
  const activities = useMemo(() => activityQuery.data?.activities ?? [], [activityQuery.data]);

  const kpis = [
    { label: "Total Agents", value: stats.total_agents ?? 0, icon: Bot, color: "bg-chart-purple/10", iconColor: "text-chart-purple", link: "/agents" },
    { label: "Live Agents", value: stats.live_agents ?? 0, icon: Zap, color: "bg-chart-green/10", iconColor: "text-chart-green", link: "/agents" },
    { label: "Active Sessions", value: stats.active_sessions ?? 0, icon: Activity, color: "bg-chart-blue/10", iconColor: "text-chart-blue", link: "/sessions" },
    { label: "Total Runs", value: stats.total_runs ?? 0, icon: Play, color: "bg-accent/10", iconColor: "text-accent", link: "/runtime" },
    { label: "Avg Latency", value: `${(stats.avg_latency_ms ?? 0).toFixed(0)}ms`, icon: Clock, color: "bg-chart-yellow/10", iconColor: "text-chart-yellow", link: "/evolution" },
    { label: "Error Rate", value: `${(stats.error_rate_pct ?? 0).toFixed(1)}%`, icon: AlertTriangle, color: "bg-status-error/10", iconColor: "text-status-error", link: "/sessions" },
  ];

  const quickActions = [
    { label: "Create Agent", icon: Bot, path: "/agents", desc: "Build and configure a new agent" },
    { label: "Open Canvas", icon: Brain, path: "/canvas", desc: "Visual agent builder workspace" },
    { label: "Run Eval", icon: TrendingUp, path: "/eval", desc: "Evaluate agent performance" },
    { label: "Manage Integrations", icon: Server, path: "/integrations", desc: "Connect tools and MCP servers" },
  ];

  const getActivityIcon = (type: string) => {
    switch (type) {
      case "deploy": return <Zap size={10} className="text-chart-green" />;
      case "error": return <AlertTriangle size={10} className="text-status-error" />;
      case "session": return <Activity size={10} className="text-chart-blue" />;
      default: return <Play size={10} className="text-text-muted" />;
    }
  };

  return (
    <div>
      <PageHeader
        title="Dashboard"
        subtitle="Control plane overview"
        onRefresh={() => { void statsQuery.refetch(); void activityQuery.refetch(); }}
      />

      {/* KPI grid */}
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 mb-6">
        {kpis.map((kpi) => (
          <div
            key={kpi.label}
            className="card flex items-center gap-3 py-3 cursor-pointer hover:border-accent/40 transition-colors"
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

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Quick Actions */}
        <div className="card">
          <h3 className="text-sm font-semibold text-text-primary mb-3">Quick Actions</h3>
          <div className="space-y-2">
            {quickActions.map((action) => (
              <button
                key={action.label}
                className="w-full flex items-center gap-3 p-3 bg-surface-base border border-border-default rounded-lg hover:border-accent/40 hover:bg-surface-overlay transition-all text-left group"
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

      {/* System Health */}
      <div className="card mt-4">
        <h3 className="text-sm font-semibold text-text-primary mb-3">System Health</h3>
        <div className="grid grid-cols-4 gap-4">
          {[
            { label: "API", status: "healthy" },
            { label: "Database", status: "healthy" },
            { label: "Workers", status: "healthy" },
            { label: "MCP Servers", status: "degraded" },
          ].map((s) => (
            <div key={s.label} className="flex items-center gap-2">
              <div className={`w-2 h-2 rounded-full ${s.status === "healthy" ? "bg-status-live" : s.status === "degraded" ? "bg-status-warning" : "bg-status-error"}`} />
              <span className="text-xs text-text-secondary">{s.label}</span>
              <StatusBadge status={s.status} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
