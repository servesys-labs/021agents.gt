import { useMemo } from "react";
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  CheckCircle2,
  Clock,
  DollarSign,
  ExternalLink,
  XCircle,
} from "lucide-react";
import { useNavigate } from "react-router-dom";

import { useApiQuery } from "../../../lib/api";

type MetaReport = {
  sessions_7d?: number;
  success_rate?: number;
  success_rate_prev?: number;
  avg_latency_ms?: number;
  avg_latency_ms_prev?: number;
  total_cost_7d?: number;
  open_issues?: number;
  daily_success_rates?: Array<{ day: string; rate: number }>;
};

type Issue = {
  issue_id?: string;
  id?: string;
  title: string;
  severity?: string;
  status?: string;
  category?: string;
  affected_sessions_count?: number;
  created_at?: string;
};

type SessionRow = {
  session_id: string;
  status?: string;
  created_at?: string;
  error_summary?: string;
  turns?: number;
  wall_clock_seconds?: number;
};

export function OverviewTab({ agentName }: { agentName?: string }) {
  const navigate = useNavigate();

  const metaQuery = useApiQuery<MetaReport>(
    `/api/v1/observability/agents/${agentName ?? ""}/meta-report`,
    Boolean(agentName),
  );

  const issuesQuery = useApiQuery<{ issues: Issue[] } | Issue[]>(
    `/api/v1/issues?agent_name=${agentName ?? ""}&status=open&limit=10`,
    Boolean(agentName),
  );

  const sessionsQuery = useApiQuery<{ sessions: SessionRow[] } | SessionRow[]>(
    `/api/v1/sessions?agent_name=${agentName ?? ""}&limit=10`,
    Boolean(agentName),
  );

  const meta = metaQuery.data;

  const issues: Issue[] = useMemo(() => {
    const raw = issuesQuery.data;
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    return raw.issues ?? [];
  }, [issuesQuery.data]);

  const sessions: SessionRow[] = useMemo(() => {
    const raw = sessionsQuery.data;
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    return raw.sessions ?? [];
  }, [sessionsQuery.data]);

  const sortedSessions = useMemo(() => {
    return [...sessions].sort((a, b) => {
      const aErr = a.status === "error" || a.status === "failed" ? 0 : 1;
      const bErr = b.status === "error" || b.status === "failed" ? 0 : 1;
      if (aErr !== bErr) return aErr - bErr;
      return (b.created_at ?? "").localeCompare(a.created_at ?? "");
    });
  }, [sessions]);

  const failingSessions = useMemo(
    () => sortedSessions.filter((s) => s.status === "error" || s.status === "failed"),
    [sortedSessions],
  );

  const signals = useMemo(() => {
    const sr = meta?.success_rate ?? 0;
    const srPrev = meta?.success_rate_prev;
    const lat = meta?.avg_latency_ms ?? 0;
    const latPrev = meta?.avg_latency_ms_prev;

    return [
      {
        label: "Success Rate",
        value: `${(sr * 100).toFixed(1)}%`,
        icon: CheckCircle2,
        iconColor: sr < 0.9 ? "text-status-error" : "text-chart-green",
        bgColor: sr < 0.9 ? "bg-status-error/10" : "bg-chart-green/10",
        trend: srPrev != null ? (
          <TrendIndicator current={sr} previous={srPrev} higherIsBetter />
        ) : null,
      },
      {
        label: "Avg Latency",
        value: `${lat.toFixed(0)}ms`,
        icon: Clock,
        iconColor: "text-chart-blue",
        bgColor: "bg-chart-blue/10",
        trend: latPrev != null ? (
          <TrendIndicator current={lat} previous={latPrev} higherIsBetter={false} />
        ) : null,
      },
      {
        label: "Cost (7d)",
        value: `$${(meta?.total_cost_7d ?? 0).toFixed(2)}`,
        icon: DollarSign,
        iconColor: "text-accent",
        bgColor: "bg-accent/10",
        trend: null,
      },
      {
        label: "Open Issues",
        value: meta?.open_issues ?? issues.length,
        icon: AlertTriangle,
        iconColor: (meta?.open_issues ?? issues.length) > 0 ? "text-status-warning" : "text-text-muted",
        bgColor: (meta?.open_issues ?? issues.length) > 0 ? "bg-status-warning/10" : "bg-surface-overlay",
        trend: null,
      },
    ];
  }, [meta, issues.length]);

  const sparklinePoints = useMemo(() => {
    const rates = meta?.daily_success_rates ?? [];
    if (rates.length === 0) return null;
    return rates.map((d) => d.rate);
  }, [meta]);

  return (
    <div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-[var(--space-3)] mb-[var(--space-6)]">
        {signals.map((signal) => (
          <div key={signal.label} className="card flex items-center gap-[var(--space-3)] py-[var(--space-3)]">
            <div className={`p-2 rounded-lg ${signal.bgColor}`}>
              <signal.icon size={16} className={signal.iconColor} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-[var(--space-1)]">
                <p className="text-[var(--text-lg)] font-bold text-text-primary font-mono">
                  {typeof signal.value === "number" ? signal.value.toLocaleString() : signal.value}
                </p>
                {signal.trend}
              </div>
              <p className="text-[10px] text-text-muted uppercase tracking-wide">{signal.label}</p>
            </div>
          </div>
        ))}
      </div>

      {sparklinePoints && (
        <div className="card mb-[var(--space-4)]">
          <h3 className="text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-3)]">
            Success Rate (7 Days)
          </h3>
          <SparklineChart points={sparklinePoints} height={80} />
        </div>
      )}

      <div className="card mb-[var(--space-4)]">
        <div className="flex items-center justify-between mb-[var(--space-3)]">
          <h3 className="text-[var(--text-xs)] text-text-muted uppercase tracking-wide">
            Open Issues ({issues.length})
          </h3>
        </div>
        {issues.length === 0 ? (
          <p className="text-[var(--text-sm)] text-text-muted">No open issues</p>
        ) : (
          <div className="space-y-[var(--space-2)]">
            {issues.map((issue) => {
              const issueId = issue.issue_id ?? issue.id ?? "";
              return (
                <IssueRow
                  key={issueId || issue.title}
                  issue={issue}
                  onNavigate={() => {
                    if (!issueId) return;
                    navigate(`/agents/${agentName}/issues/${issueId}`);
                  }}
                />
              );
            })}
          </div>
        )}
      </div>

      <div className="card">
        <h3 className="text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-3)]">
          Recent Failing Sessions ({failingSessions.length})
        </h3>
        {failingSessions.length === 0 ? (
          <p className="text-[var(--text-sm)] text-text-muted">No failing sessions in recent history</p>
        ) : (
          <div className="space-y-[var(--space-1)]">
            {failingSessions.slice(0, 10).map((session) => (
              <button
                key={session.session_id}
                onClick={() => navigate(`/agents/${agentName}/sessions/${session.session_id}`)}
                className="w-full flex items-center gap-[var(--space-3)] p-[var(--space-2)] rounded-lg hover:bg-surface-overlay transition-colors text-left min-h-[var(--touch-target-min)]"
              >
                <XCircle size={12} className="text-status-error flex-shrink-0" />
                <span className="text-[var(--text-xs)] font-mono text-text-secondary flex-1 truncate">
                  {session.session_id.slice(0, 16)}...
                </span>
                {session.error_summary && (
                  <span className="text-[10px] text-status-error truncate max-w-[200px]">
                    {session.error_summary}
                  </span>
                )}
                <span className="text-[10px] text-text-muted flex-shrink-0">
                  {session.created_at
                    ? new Date(session.created_at).toLocaleDateString(undefined, {
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })
                    : "--"}
                </span>
                <ExternalLink size={10} className="text-text-muted flex-shrink-0" />
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function TrendIndicator({
  current,
  previous,
  higherIsBetter,
}: {
  current: number;
  previous: number;
  higherIsBetter: boolean;
}) {
  if (Math.abs(current - previous) < 0.001) return null;
  const up = current > previous;
  const good = higherIsBetter ? up : !up;

  return (
    <span className={`inline-flex items-center ${good ? "text-status-live" : "text-status-error"}`}>
      {up ? <ArrowUpRight size={14} /> : <ArrowDownRight size={14} />}
    </span>
  );
}

function SparklineChart({ points, height = 80 }: { points: number[]; height?: number }) {
  const width = 400;
  const padding = 4;
  const denominator = Math.max(points.length - 1, 1);
  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;

  const polyline = points
    .map((val, i) => {
      const x = padding + (i / denominator) * (width - padding * 2);
      const y = padding + (1 - (val - min) / range) * (height - padding * 2);
      return `${x},${y}`;
    })
    .join(" ");

  const firstX = padding;
  const lastX = padding + ((points.length - 1) / denominator) * (width - padding * 2);
  const fillPoints = `${firstX},${height} ${polyline} ${lastX},${height}`;

  const latest = points[points.length - 1];
  const strokeColor = latest < 0.9 ? "var(--color-status-error)" : "var(--color-status-live)";
  const fillColor = latest < 0.9 ? "rgba(239, 68, 68, 0.08)" : "rgba(34, 197, 94, 0.08)";

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full" preserveAspectRatio="none">
      <line
        x1={padding}
        x2={width - padding}
        y1={padding + (1 - (0.9 - min) / range) * (height - padding * 2)}
        y2={padding + (1 - (0.9 - min) / range) * (height - padding * 2)}
        stroke="var(--color-status-warning)"
        strokeWidth="1"
        strokeDasharray="4 4"
        opacity="0.4"
      />
      <polygon points={fillPoints} fill={fillColor} />
      <polyline
        points={polyline}
        fill="none"
        stroke={strokeColor}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {points.map((val, i) => {
        const x = padding + (i / denominator) * (width - padding * 2);
        const y = padding + (1 - (val - min) / range) * (height - padding * 2);
        return (
          <circle
            key={i}
            cx={x}
            cy={y}
            r="3"
            fill={val < 0.9 ? "var(--color-status-error)" : strokeColor}
            stroke="var(--color-surface-raised)"
            strokeWidth="1.5"
          />
        );
      })}
    </svg>
  );
}

function IssueRow({ issue, onNavigate }: { issue: Issue; onNavigate: () => void }) {
  const sev = (issue.severity ?? "medium").toLowerCase();
  const sevColor =
    sev === "high" || sev === "critical"
      ? "bg-status-error text-status-error border-status-error/20 bg-status-error/10"
      : sev === "low"
        ? "bg-status-live/10 text-status-live border-status-live/20"
        : "bg-status-warning/10 text-status-warning border-status-warning/20";

  return (
    <div className="flex items-center gap-[var(--space-3)] p-[var(--space-2)] rounded-lg hover:bg-surface-overlay transition-colors">
      <span
        className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide border ${sevColor}`}
      >
        {sev}
      </span>
      <span className="text-[var(--text-sm)] text-text-primary flex-1 truncate">{issue.title}</span>
      {issue.affected_sessions_count != null && (
        <span className="text-[10px] text-text-muted">
          {issue.affected_sessions_count} session{issue.affected_sessions_count !== 1 ? "s" : ""}
        </span>
      )}
      <button
        onClick={onNavigate}
        className="btn btn-ghost text-[var(--text-xs)] min-h-[var(--touch-target-min)] px-[var(--space-3)]"
      >
        View
        <ExternalLink size={10} />
      </button>
    </div>
  );
}
