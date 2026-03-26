import { useMemo } from "react";
import {
  Shield,
  AlertTriangle,
  CheckCircle2,
  TrendingUp,
} from "lucide-react";

import { PageHeader } from "../../components/common/PageHeader";
import { QueryState } from "../../components/common/QueryState";
import { useApiQuery } from "../../lib/api";

/* ── Types ──────────────────────────────────────────────────────── */

type SecurityReport = {
  total_scans?: number;
  total_findings?: number;
  agents_scanned?: number;
  avg_risk_score?: number;
  risk_distribution?: Record<string, number>;
  findings_by_severity?: Record<string, number>;
  findings_by_category?: Record<string, number>;
  top_vulnerable_agents?: Array<{
    agent_name: string;
    risk_score: number;
    risk_level: string;
    findings_count: number;
  }>;
  recent_scans?: Array<{
    scan_id: string;
    agent_name: string;
    risk_score: number;
    risk_level: string;
    created_at?: string;
  }>;
  summary?: string;
  generated_at?: string;
};

/* ── Helpers ─────────────────────────────────────────────────────── */

function riskColor(level: string) {
  switch (level?.toLowerCase()) {
    case "critical":
      return "text-status-error";
    case "high":
      return "text-chart-orange";
    case "medium":
      return "text-status-warning";
    case "low":
      return "text-status-live";
    default:
      return "text-text-muted";
  }
}

function riskBadgeBg(level: string) {
  switch (level?.toLowerCase()) {
    case "critical":
      return "bg-status-error/15 text-status-error border-status-error/20";
    case "high":
      return "bg-chart-orange/15 text-chart-orange border-chart-orange/20";
    case "medium":
      return "bg-status-warning/15 text-status-warning border-status-warning/20";
    case "low":
      return "bg-status-live/15 text-status-live border-status-live/20";
    default:
      return "bg-surface-overlay text-text-muted border-border-default";
  }
}

/* ── Security Report Page ───────────────────────────────────────── */

export function SecurityReportPage() {
  const { data: report, loading, error, refetch } = useApiQuery<SecurityReport>(
    "/api/v1/security/report",
  );

  const stats = useMemo(() => report ?? {}, [report]);

  const kpis = [
    {
      label: "Total Scans",
      value: stats.total_scans ?? 0,
      icon: Shield,
      color: "bg-chart-blue/10",
      iconColor: "text-chart-blue",
    },
    {
      label: "Agents Scanned",
      value: stats.agents_scanned ?? 0,
      icon: CheckCircle2,
      color: "bg-chart-green/10",
      iconColor: "text-chart-green",
    },
    {
      label: "Total Findings",
      value: stats.total_findings ?? 0,
      icon: AlertTriangle,
      color: "bg-status-warning/10",
      iconColor: "text-status-warning",
    },
    {
      label: "Avg Risk Score",
      value: (stats.avg_risk_score ?? 0).toFixed(1),
      icon: TrendingUp,
      color: "bg-chart-purple/10",
      iconColor: "text-chart-purple",
    },
  ];

  return (
    <div>
      <PageHeader
        title="Security Report"
        subtitle="Aggregate security posture overview"
        onRefresh={() => void refetch()}
      />

      <QueryState
        loading={loading}
        error={error}
        onRetry={() => void refetch()}
      >
        {/* KPI cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
          {kpis.map((kpi) => (
            <div key={kpi.label} className="card flex items-center gap-3 py-3">
              <div className={`p-2 rounded-lg ${kpi.color}`}>
                <kpi.icon size={16} className={kpi.iconColor} />
              </div>
              <div>
                <p className="text-xl font-bold text-text-primary font-mono">
                  {typeof kpi.value === "number"
                    ? kpi.value.toLocaleString()
                    : kpi.value}
                </p>
                <p className="text-[10px] text-text-muted uppercase tracking-wide">
                  {kpi.label}
                </p>
              </div>
            </div>
          ))}
        </div>

        {/* Summary */}
        {stats.summary && (
          <div className="card mb-6">
            <h3 className="text-sm font-semibold text-text-primary mb-2">
              Summary
            </h3>
            <p className="text-xs text-text-secondary leading-relaxed">
              {stats.summary}
            </p>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
          {/* Findings by severity */}
          {stats.findings_by_severity &&
            Object.keys(stats.findings_by_severity).length > 0 && (
              <div className="card">
                <h3 className="text-sm font-semibold text-text-primary mb-3">
                  Findings by Severity
                </h3>
                <div className="space-y-2">
                  {Object.entries(stats.findings_by_severity)
                    .sort(([, a], [, b]) => b - a)
                    .map(([severity, count]) => {
                      const total = stats.total_findings || 1;
                      const pct = Math.round((count / total) * 100);
                      return (
                        <div key={severity} className="flex items-center gap-3">
                          <span
                            className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase border w-20 text-center ${riskBadgeBg(severity)}`}
                          >
                            {severity}
                          </span>
                          <div className="flex-1 h-1.5 bg-surface-overlay rounded-full overflow-hidden">
                            <div
                              className={`h-full rounded-full ${
                                severity.toLowerCase() === "critical"
                                  ? "bg-status-error"
                                  : severity.toLowerCase() === "high"
                                    ? "bg-chart-orange"
                                    : severity.toLowerCase() === "medium"
                                      ? "bg-status-warning"
                                      : "bg-status-live"
                              }`}
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                          <span className="text-xs font-mono text-text-muted w-12 text-right">
                            {count}
                          </span>
                        </div>
                      );
                    })}
                </div>
              </div>
            )}

          {/* Findings by category */}
          {stats.findings_by_category &&
            Object.keys(stats.findings_by_category).length > 0 && (
              <div className="card">
                <h3 className="text-sm font-semibold text-text-primary mb-3">
                  Findings by Category
                </h3>
                <div className="space-y-2">
                  {Object.entries(stats.findings_by_category)
                    .sort(([, a], [, b]) => b - a)
                    .map(([category, count]) => {
                      const total = stats.total_findings || 1;
                      const pct = Math.round((count / total) * 100);
                      return (
                        <div key={category} className="flex items-center gap-3">
                          <span className="text-xs text-text-secondary w-32 truncate">
                            {category}
                          </span>
                          <div className="flex-1 h-1.5 bg-surface-overlay rounded-full overflow-hidden">
                            <div
                              className="h-full rounded-full bg-accent"
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                          <span className="text-xs font-mono text-text-muted w-12 text-right">
                            {count}
                          </span>
                        </div>
                      );
                    })}
                </div>
              </div>
            )}
        </div>

        {/* Top vulnerable agents */}
        {stats.top_vulnerable_agents && stats.top_vulnerable_agents.length > 0 && (
          <div className="card mb-6">
            <h3 className="text-sm font-semibold text-text-primary mb-3">
              Most Vulnerable Agents
            </h3>
            <div className="overflow-x-auto">
              <table>
                <thead>
                  <tr>
                    <th>Agent</th>
                    <th className="text-right">Risk Score</th>
                    <th>Risk Level</th>
                    <th className="text-right">Findings</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.top_vulnerable_agents.map((agent) => (
                    <tr key={agent.agent_name}>
                      <td className="font-medium text-text-primary">
                        {agent.agent_name}
                      </td>
                      <td className="text-right">
                        <span
                          className={`font-mono font-semibold ${riskColor(agent.risk_level)}`}
                        >
                          {agent.risk_score.toFixed(1)}
                        </span>
                      </td>
                      <td>
                        <span
                          className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase border ${riskBadgeBg(agent.risk_level)}`}
                        >
                          {agent.risk_level}
                        </span>
                      </td>
                      <td className="text-right font-mono text-text-muted">
                        {agent.findings_count}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Generated timestamp */}
        {stats.generated_at && (
          <p className="text-[10px] text-text-muted text-right">
            Report generated: {new Date(stats.generated_at).toLocaleString()}
          </p>
        )}
      </QueryState>
    </div>
  );
}

export { SecurityReportPage as default };
