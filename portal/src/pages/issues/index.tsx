import { useMemo, useCallback, type CSSProperties } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  AlertCircle,
  AlertTriangle,
  Bug,
  CheckCircle,
  Clock,
  ExternalLink,
  Shield,
  Wrench,
  Zap,
} from "lucide-react";

import { PageHeader } from "../../components/common/PageHeader";
import { QueryState } from "../../components/common/QueryState";
import { EmptyState } from "../../components/common/EmptyState";
import { AssistPanel } from "../../components/common/AssistPanel";
import { useApiQuery } from "../../lib/api";

/* ── Types ──────────────────────────────────────────────────────── */

type Issue = {
  issue_id: string;
  agent_name: string;
  title: string;
  description?: string;
  category?: string;
  severity: string;
  status: string;
  source?: string;
  source_session_id?: string;
  suggested_fix?: string | Record<string, unknown>;
  affected_sessions_count?: number;
  created_at?: number | string;
  updated_at?: number | string;
};

type IssueSummary = {
  total: number;
  by_severity: Record<string, number>;
  by_status: Record<string, number>;
  by_category?: Record<string, number>;
};

/* ── Helpers ─────────────────────────────────────────────────────── */

function timeSince(ts?: number | string): string {
  if (!ts) return "--";
  const date = new Date(typeof ts === "number" && ts < 1e12 ? ts * 1000 : ts);
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function severityOrder(s: string): number {
  switch (s.toLowerCase()) {
    case "critical":
    case "high":
      return 0;
    case "medium":
      return 1;
    case "low":
      return 2;
    default:
      return 3;
  }
}

function severityBadge(severity: string) {
  const s = severity.toLowerCase();
  if (s === "high" || s === "critical") {
    return {
      emoji: "\uD83D\uDD34",
      bg: "bg-status-error/15",
      text: "text-status-error",
      border: "border-status-error/20",
      label: "HIGH",
    };
  }
  if (s === "medium") {
    return {
      emoji: "\uD83D\uDFE1",
      bg: "bg-status-warning/15",
      text: "text-status-warning",
      border: "border-status-warning/20",
      label: "MEDIUM",
    };
  }
  return {
    emoji: "\uD83D\uDFE2",
    bg: "bg-status-live/15",
    text: "text-status-live",
    border: "border-status-live/20",
    label: "LOW",
  };
}

/* ── Issues Queue ────────────────────────────────────────────────── */

export function IssuesPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  /* URL-persisted filters */
  const agentFilter = searchParams.get("agent") ?? "";
  const severityFilter = searchParams.get("severity") ?? "";
  const statusToggle = (searchParams.get("status") ?? "open") as "open" | "resolved";

  const updateParam = useCallback(
    (key: string, value: string) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        if (!value) next.delete(key);
        else next.set(key, value);
        return next;
      }, { replace: true });
    },
    [setSearchParams],
  );

  const setAgentFilter = (v: string) => updateParam("agent", v);
  const setSeverityFilter = (v: string) => updateParam("severity", v);
  const setStatusToggle = (v: "open" | "resolved") => updateParam("status", v === "open" ? "" : v);

  /* Queries */
  const summaryQuery = useApiQuery<IssueSummary>("/api/v1/issues/summary");
  const issuesQuery = useApiQuery<{ issues: Issue[] } | Issue[]>(
    `/api/v1/issues?status=${statusToggle}&limit=100${
      agentFilter ? `&agent_name=${encodeURIComponent(agentFilter)}` : ""
    }${severityFilter ? `&severity=${encodeURIComponent(severityFilter)}` : ""}`,
  );

  const summary = summaryQuery.data;
  const issues: Issue[] = useMemo(() => {
    const raw = issuesQuery.data;
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    return raw.issues ?? [];
  }, [issuesQuery.data]);

  /* Extract unique agent names for filter dropdown */
  const agentNames = useMemo(() => {
    const names = new Set<string>();
    for (const issue of issues) {
      if (issue.agent_name) names.add(issue.agent_name);
    }
    return Array.from(names).sort();
  }, [issues]);

  /* Group by severity */
  const grouped = useMemo(() => {
    const sorted = [...issues].sort(
      (a, b) => severityOrder(a.severity) - severityOrder(b.severity),
    );
    const groups: { severity: string; items: Issue[] }[] = [];
    let currentSev = "";
    for (const issue of sorted) {
      const sev = issue.severity?.toLowerCase() ?? "medium";
      const normalizedSev =
        sev === "critical" || sev === "high"
          ? "high"
          : sev === "medium"
            ? "medium"
            : "low";
      if (normalizedSev !== currentSev) {
        currentSev = normalizedSev;
        groups.push({ severity: normalizedSev, items: [] });
      }
      groups[groups.length - 1].items.push(issue);
    }
    return groups;
  }, [issues]);

  /* Compute resolved this week */
  const resolvedThisWeek = useMemo(() => {
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    return summary?.by_status?.resolved ?? 0;
  }, [summary]);

  const highCount = summary?.by_severity?.high ?? summary?.by_severity?.critical ?? 0;
  const mediumCount = summary?.by_severity?.medium ?? 0;

  return (
    <div className="max-w-[1400px] mx-auto">
      <PageHeader
        title="Issues Queue"
        subtitle="Agent issues detected, triaged, and resolved"
      />

      {/* Signal Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-[var(--space-3)] mb-[var(--space-6)]">
        <div className="card flex items-center gap-[var(--space-3)] py-[var(--space-3)]">
          <div className="p-2 rounded-lg bg-status-error/10">
            <AlertTriangle size={16} className="text-status-error" />
          </div>
          <div>
            <p className="text-[var(--text-xl)] font-bold text-status-error font-mono">
              {highCount}
            </p>
            <p className="text-[10px] text-text-muted uppercase tracking-wide">
              High Severity
            </p>
          </div>
        </div>
        <div className="card flex items-center gap-[var(--space-3)] py-[var(--space-3)]">
          <div className="p-2 rounded-lg bg-status-warning/10">
            <AlertCircle size={16} className="text-status-warning" />
          </div>
          <div>
            <p className="text-[var(--text-xl)] font-bold text-text-primary font-mono">
              {mediumCount}
            </p>
            <p className="text-[10px] text-text-muted uppercase tracking-wide">
              Medium Severity
            </p>
          </div>
        </div>
        <div className="card flex items-center gap-[var(--space-3)] py-[var(--space-3)]">
          <div className="p-2 rounded-lg bg-status-live/10">
            <CheckCircle size={16} className="text-status-live" />
          </div>
          <div>
            <p className="text-[var(--text-xl)] font-bold text-text-primary font-mono">
              {resolvedThisWeek}
            </p>
            <p className="text-[10px] text-text-muted uppercase tracking-wide">
              Resolved This Week
            </p>
          </div>
        </div>
      </div>

      {/* Meta-agent assist */}
      <div className="mb-[var(--space-4)]">
        <AssistPanel compact />
      </div>

      {/* Filters */}
      <div className="flex items-center gap-[var(--space-3)] mb-[var(--space-4)] flex-wrap">
        {/* Agent dropdown */}
        <select
          value={agentFilter}
          onChange={(e) => setAgentFilter(e.target.value)}
          className="px-[var(--space-3)] py-[var(--space-2)] text-[var(--text-xs)] rounded-lg min-h-[var(--touch-target-min)]"
        >
          <option value="">All Agents</option>
          {agentNames.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>

        {/* Severity dropdown */}
        <select
          value={severityFilter}
          onChange={(e) => setSeverityFilter(e.target.value)}
          className="px-[var(--space-3)] py-[var(--space-2)] text-[var(--text-xs)] rounded-lg min-h-[var(--touch-target-min)]"
        >
          <option value="">All Severities</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </select>

        {/* Status toggle */}
        <div className="flex items-center gap-0 rounded-lg border border-border-default overflow-hidden">
          <button
            onClick={() => setStatusToggle("open")}
            className={`px-[var(--space-3)] py-[var(--space-2)] text-[var(--text-xs)] font-medium min-h-[var(--touch-target-min)] transition-colors ${
              statusToggle === "open"
                ? "bg-accent text-text-inverse"
                : "text-text-muted hover:text-text-primary hover:bg-surface-overlay"
            }`}
          >
            Open
          </button>
          <button
            onClick={() => setStatusToggle("resolved")}
            className={`px-[var(--space-3)] py-[var(--space-2)] text-[var(--text-xs)] font-medium min-h-[var(--touch-target-min)] transition-colors ${
              statusToggle === "resolved"
                ? "bg-accent text-text-inverse"
                : "text-text-muted hover:text-text-primary hover:bg-surface-overlay"
            }`}
          >
            Resolved
          </button>
        </div>
      </div>

      {/* Issues List */}
      <QueryState loading={issuesQuery.loading} error={issuesQuery.error}>
        {issues.length === 0 ? (
          <EmptyState
            icon={<CheckCircle size={32} className="text-status-live" />}
            title="No open issues"
            description="Your agents are running smoothly"
          />
        ) : (
          <div className="space-y-[var(--space-6)]">
            {grouped.map((group) => {
              const badge = severityBadge(group.severity);
              return (
                <div key={group.severity}>
                  {/* Group header */}
                  <div className="flex items-center gap-[var(--space-2)] mb-[var(--space-3)]">
                    <span
                      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-semibold uppercase tracking-wide border ${badge.bg} ${badge.text} ${badge.border}`}
                    >
                      {badge.label}
                    </span>
                    <span className="text-[var(--text-xs)] text-text-muted">
                      {group.items.length} issue{group.items.length !== 1 ? "s" : ""}
                    </span>
                  </div>

                  {/* Issue cards */}
                  <div className="space-y-[var(--space-2)]">
                    {group.items.map((issue, i) => (
                      <IssueCard
                        key={issue.issue_id}
                        index={i}
                        issue={issue}
                        onNavigate={() =>
                          navigate(
                            `/agents/${issue.agent_name}/issues/${issue.issue_id}`,
                          )
                        }
                        onAgentClick={() =>
                          navigate(`/agents/${issue.agent_name}`)
                        }
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </QueryState>
    </div>
  );
}

/* ── Issue Card ──────────────────────────────────────────────────── */

function IssueCard({
  issue,
  index,
  onNavigate,
  onAgentClick,
}: {
  issue: Issue;
  index: number;
  onNavigate: () => void;
  onAgentClick: () => void;
}) {
  const badge = severityBadge(issue.severity);
  const hasFix =
    issue.suggested_fix != null &&
    issue.suggested_fix !== "" &&
    (typeof issue.suggested_fix !== "object" ||
      Object.keys(issue.suggested_fix).length > 0);

  const actionLabel = hasFix
    ? "Auto-Fix"
    : issue.status === "open"
      ? "Triage"
      : "View";

  return (
    <div
      className="card card-hover flex items-center gap-[var(--space-3)] py-[var(--space-3)] cursor-pointer transition-all hover:border-accent/30 stagger-item"
      style={{ "--stagger-index": index } as CSSProperties}
      onClick={onNavigate}
    >
      {/* Severity badge */}
      <span
        className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide border flex-shrink-0 ${badge.bg} ${badge.text} ${badge.border}`}
      >
        {badge.label}
      </span>

      {/* Title + agent */}
      <div className="flex-1 min-w-0">
        <p className="text-[var(--text-sm)] text-text-primary font-medium truncate">
          {issue.title}
        </p>
        <div className="flex items-center gap-[var(--space-2)] mt-[var(--space-1)]">
          <button
            onClick={(e) => {
              e.stopPropagation();
              onAgentClick();
            }}
            className="text-[10px] text-accent hover:text-accent-hover transition-colors"
          >
            {issue.agent_name}
          </button>
          {issue.affected_sessions_count != null && (
            <span className="text-[10px] text-text-muted">
              {issue.affected_sessions_count} session
              {issue.affected_sessions_count !== 1 ? "s" : ""} affected
            </span>
          )}
          <span className="text-[10px] text-text-muted">
            {timeSince(issue.created_at)}
          </span>
        </div>
      </div>

      {/* Action button */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onNavigate();
        }}
        className="btn btn-secondary text-[var(--text-xs)] min-h-[var(--touch-target-min)] flex-shrink-0"
      >
        {actionLabel}
        <span className="ml-1">&rarr;</span>
      </button>
    </div>
  );
}

export { IssuesPage as default };
