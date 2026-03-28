import { useState, useEffect, useCallback } from "react";
import { Activity, Clock, DollarSign, Users, FlaskConical, Shield, Search, RefreshCw } from "lucide-react";

import { type AgentConfig } from "../../../lib/adapters";
import { apiGet } from "../../../lib/api";

/* ── Props ────────────────────────────────────────────────────── */

type OverviewTabProps = {
  agent: AgentConfig;
};

/* ── Types ────────────────────────────────────────────────────── */

type MetaReport = {
  success_rate?: number;
  avg_latency_ms?: number;
  cost_7d_usd?: number;
  sessions_count?: number;
  open_issues?: number;
};

type RecentSession = {
  session_id: string;
  status?: string;
  created_at?: string;
  cost_total_usd?: number;
  wall_clock_seconds?: number;
};

/* ── Helpers ──────────────────────────────────────────────────── */

function formatDate(iso?: string): string {
  if (!iso) return "-";
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/* ── Component ────────────────────────────────────────────────── */

export const OverviewTab = ({ agent }: OverviewTabProps) => {
  const [report, setReport] = useState<MetaReport | null>(null);
  const [sessions, setSessions] = useState<RecentSession[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [reportData, sessionsData] = await Promise.all([
        apiGet<MetaReport>(`/api/v1/observability/agents/${agent.name}/meta-report`).catch(() => null),
        apiGet<RecentSession[]>(`/api/v1/sessions?agent_name=${agent.name}&limit=5`).catch(() => []),
      ]);
      setReport(reportData);
      setSessions(Array.isArray(sessionsData) ? sessionsData : []);
    } catch {
      /* swallow */
    } finally {
      setLoading(false);
    }
  }, [agent.name]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  /* ── Render ─────────────────────────────────────────────────── */

  return (
    <div className="space-y-6">
      {/* Agent info */}
      <div className="card">
        <h3 className="text-sm font-semibold text-text-primary mb-3">Agent Overview</h3>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div>
            <span className="block text-xs text-text-muted uppercase tracking-wide mb-1">Model</span>
            <span className="text-sm text-text-secondary font-mono">{agent.model}</span>
          </div>
          <div>
            <span className="block text-xs text-text-muted uppercase tracking-wide mb-1">Version</span>
            <span className="text-sm text-text-secondary font-mono">{agent.version || "1.0.0"}</span>
          </div>
          <div>
            <span className="block text-xs text-text-muted uppercase tracking-wide mb-1">Max Tokens</span>
            <span className="text-sm text-text-secondary">{agent.max_tokens?.toLocaleString()}</span>
          </div>
          <div>
            <span className="block text-xs text-text-muted uppercase tracking-wide mb-1">Temperature</span>
            <span className="text-sm text-text-secondary">{agent.temperature}</span>
          </div>
        </div>
      </div>

      {/* Health signals */}
      <div className="card">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-text-primary">Health Signals</h3>
          <button
            type="button"
            onClick={() => void fetchData()}
            className="btn btn-ghost p-1"
            style={{ minWidth: "var(--touch-target-min)", minHeight: "var(--touch-target-min)" }}
            aria-label="Refresh health signals"
          >
            <RefreshCw size={14} />
          </button>
        </div>

        {loading ? (
          <p className="text-xs text-text-muted py-4 text-center">Loading health signals...</p>
        ) : !report ? (
          <p className="text-xs text-text-muted py-4 text-center">No observability data available yet.</p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <div className="flex items-start gap-2">
              <Activity size={16} className="text-text-muted mt-0.5 flex-shrink-0" />
              <div>
                <span className="block text-xs text-text-muted uppercase tracking-wide mb-1">Success Rate</span>
                <span className="text-lg font-semibold text-text-primary">
                  {report.success_rate != null ? `${(report.success_rate * 100).toFixed(1)}%` : "-"}
                </span>
              </div>
            </div>
            <div className="flex items-start gap-2">
              <Clock size={16} className="text-text-muted mt-0.5 flex-shrink-0" />
              <div>
                <span className="block text-xs text-text-muted uppercase tracking-wide mb-1">Avg Latency</span>
                <span className="text-lg font-semibold text-text-primary">
                  {report.avg_latency_ms != null ? `${report.avg_latency_ms.toLocaleString()}ms` : "-"}
                </span>
              </div>
            </div>
            <div className="flex items-start gap-2">
              <DollarSign size={16} className="text-text-muted mt-0.5 flex-shrink-0" />
              <div>
                <span className="block text-xs text-text-muted uppercase tracking-wide mb-1">Cost (7d)</span>
                <span className="text-lg font-semibold text-text-primary">
                  {report.cost_7d_usd != null ? `$${report.cost_7d_usd.toFixed(2)}` : "-"}
                </span>
              </div>
            </div>
            <div className="flex items-start gap-2">
              <Users size={16} className="text-text-muted mt-0.5 flex-shrink-0" />
              <div>
                <span className="block text-xs text-text-muted uppercase tracking-wide mb-1">Sessions</span>
                <span className="text-lg font-semibold text-text-primary">
                  {report.sessions_count != null ? report.sessions_count.toLocaleString() : "-"}
                </span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Open issues */}
      {report?.open_issues != null && report.open_issues > 0 && (
        <div className="card border-status-warning/30" style={{ borderColor: "var(--color-status-warning)" }}>
          <p className="text-sm text-text-secondary">
            <span className="font-semibold text-status-warning">{report.open_issues}</span> open issue{report.open_issues !== 1 ? "s" : ""} detected
          </p>
        </div>
      )}

      {/* Description */}
      {agent.description && (
        <div className="card">
          <h3 className="text-sm font-semibold text-text-primary mb-2">Description</h3>
          <p className="text-sm text-text-secondary leading-relaxed">{agent.description}</p>
        </div>
      )}

      {/* System prompt preview */}
      {agent.system_prompt && (
        <div className="card">
          <h3 className="text-sm font-semibold text-text-primary mb-2">System Prompt</h3>
          <pre className="text-xs font-mono text-text-secondary bg-surface-base border border-border-default rounded-md p-4 overflow-x-auto max-h-60 whitespace-pre-wrap">
            {agent.system_prompt}
          </pre>
        </div>
      )}

      {/* Recent sessions */}
      <div className="card">
        <h3 className="text-sm font-semibold text-text-primary mb-3">Recent Sessions</h3>

        {loading ? (
          <p className="text-xs text-text-muted py-4 text-center">Loading sessions...</p>
        ) : sessions.length === 0 ? (
          <div className="border border-border-default rounded-md p-6 flex items-center justify-center">
            <p className="text-xs text-text-muted">No sessions recorded yet.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {sessions.map((s) => (
              <div
                key={s.session_id}
                className="flex items-center justify-between gap-3 px-3 py-2 bg-surface-base border border-border-default rounded-md"
              >
                <div className="flex items-center gap-3 flex-1 min-w-0">
                  <span className="text-xs font-mono text-text-muted truncate max-w-[10rem]">
                    {s.session_id.slice(0, 8)}...
                  </span>
                  <span
                    className="inline-block text-xs font-medium px-2 py-0.5 rounded-full"
                    style={{
                      backgroundColor:
                        s.status === "completed" ? "var(--color-status-live)" :
                        s.status === "running" ? "var(--color-status-warning)" :
                        "var(--color-surface-overlay)",
                      color: "var(--color-text-primary)",
                    }}
                  >
                    {s.status ?? "unknown"}
                  </span>
                </div>
                <div className="flex items-center gap-4 text-xs text-text-muted flex-shrink-0">
                  {s.cost_total_usd != null && <span>${s.cost_total_usd.toFixed(4)}</span>}
                  {s.wall_clock_seconds != null && <span>{s.wall_clock_seconds.toFixed(1)}s</span>}
                  <span>{formatDate(s.created_at)}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Quick actions */}
      <div className="card">
        <h3 className="text-sm font-semibold text-text-primary mb-3">Quick Actions</h3>
        <div className="flex flex-wrap gap-2">
          <button className="btn btn-secondary text-xs" style={{ minHeight: "var(--touch-target-min)" }}>
            <FlaskConical size={14} />
            Run Eval
          </button>
          <button className="btn btn-secondary text-xs" style={{ minHeight: "var(--touch-target-min)" }}>
            <Shield size={14} />
            Security Scan
          </button>
          <button className="btn btn-secondary text-xs" style={{ minHeight: "var(--touch-target-min)" }}>
            <Search size={14} />
            View Traces
          </button>
        </div>
      </div>
    </div>
  );
};
