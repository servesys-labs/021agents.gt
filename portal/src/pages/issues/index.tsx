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
import { StatCard } from "../../components/common/StatCard";
import { SeverityBadge, getSeverityColors, normalizeLevel } from "../../components/common/SeverityBadge";
import { FilterBar, type FilterConfig } from "../../components/common/FilterBar";
import { useApiQuery } from "../../lib/api";
import { timeSince } from "../../lib/format";

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

type Incident = {
  incident_key: string;
  kind: "integrity_breach" | "loop_halt" | "loop_warn" | "circuit_block";
  severity: "critical" | "high" | "medium" | "low" | "info";
  title: string;
  opened_at: string;
  trace_id: string | null;
  session_id: string | null;
};

type IncidentResponse = {
  counts?: {
    total?: number;
    by_kind?: Record<string, number>;
    by_severity?: Record<string, number>;
  };
  incidents?: Incident[];
};

/* ── Helpers ─────────────────────────────────────────────────────── */

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
  const incidentsQuery = useApiQuery<IncidentResponse>(
    "/api/v1/observability/incidents?since_hours=24&limit=8&include_suppressed=false",
  );

  const summary = summaryQuery.data;
  const issues: Issue[] = useMemo(() => {
    const raw = issuesQuery.data;
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    return raw.issues ?? [];
  }, [issuesQuery.data]);
  const incidents = useMemo(
    () => (Array.isArray(incidentsQuery.data?.incidents) ? incidentsQuery.data?.incidents ?? [] : []),
    [incidentsQuery.data],
  );

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
  const incidentHigh = incidentsQuery.data?.counts?.by_severity?.high ?? 0;
  const incidentCritical = incidentsQuery.data?.counts?.by_severity?.critical ?? 0;

  return (
    <div>
      <PageHeader
        title="Issues Queue"
        subtitle="Agent issues detected, triaged, and resolved"
      />

      {/* Signal Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 mb-6">
        <StatCard
          label="High Severity"
          value={highCount}
          icon={<AlertTriangle size={16} className="text-status-error" />}
          color="bg-status-error/10"
          iconColor="text-status-error"
        />
        <StatCard
          label="Medium Severity"
          value={mediumCount}
          icon={<AlertCircle size={16} className="text-status-warning" />}
          color="bg-status-warning/10"
          iconColor="text-status-warning"
        />
        <StatCard
          label="Resolved This Week"
          value={resolvedThisWeek}
          icon={<CheckCircle size={16} className="text-status-live" />}
          color="bg-status-live/10"
          iconColor="text-status-live"
        />
      </div>

      {/* Meta-agent assist */}
      <div className="mb-[var(--space-4)]">
        <AssistPanel compact />
      </div>

      {/* Operational incidents from observability pipeline */}
      <div className="card mb-[var(--space-4)]">
        <div className="flex items-center justify-between mb-[var(--space-3)]">
          <div>
            <p className="text-[10px] text-text-muted uppercase tracking-wide">Runtime incidents (24h)</p>
            <p className="text-[var(--text-sm)] text-text-primary font-semibold">
              {incidentsQuery.data?.counts?.total ?? 0} incidents
            </p>
          </div>
          <button
            className="btn btn-secondary text-[var(--text-xs)]"
            onClick={() => navigate("/observability/trace-integrity")}
          >
            Trace Integrity
            <ExternalLink size={12} />
          </button>
        </div>
        <QueryState loading={incidentsQuery.loading} error={incidentsQuery.error}>
          <div className="flex items-center gap-[var(--space-3)] mb-[var(--space-3)]">
            <span className="text-[10px] text-status-error uppercase">
              Critical: {incidentCritical}
            </span>
            <span className="text-[10px] text-status-warning uppercase">
              High: {incidentHigh}
            </span>
          </div>
          {incidents.length === 0 ? (
            <p className="text-[var(--text-xs)] text-text-muted">No active incidents in the selected window.</p>
          ) : (
            <div className="space-y-[var(--space-2)]">
              {incidents.slice(0, 5).map((inc) => (
                <button
                  key={inc.incident_key}
                  onClick={() => {
                    if (inc.kind === "integrity_breach" && inc.trace_id) {
                      navigate(`/observability/trace-integrity?trace_id=${encodeURIComponent(inc.trace_id)}`);
                      return;
                    }
                    if (inc.session_id) {
                      navigate(`/sessions?q=${encodeURIComponent(inc.session_id)}`);
                      return;
                    }
                    navigate("/sessions");
                  }}
                  className="w-full text-left rounded-lg border border-border-default px-[var(--space-3)] py-[var(--space-2)] hover:bg-surface-overlay transition-colors"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-[var(--text-xs)] text-text-primary">{inc.title}</span>
                    <span className="text-[10px] text-text-muted uppercase">{inc.kind}</span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </QueryState>
      </div>

      {/* Filters */}
      <FilterBar
        className="mb-4"
        filters={[
          {
            key: "agent",
            label: "Agent",
            value: agentFilter,
            onChange: setAgentFilter,
            options: [
              { value: "", label: "All Agents" },
              ...agentNames.map((name) => ({ value: name, label: name })),
            ],
          },
          {
            key: "severity",
            label: "Severity",
            value: severityFilter,
            onChange: setSeverityFilter,
            options: [
              { value: "", label: "All Severities" },
              { value: "high", label: "High" },
              { value: "medium", label: "Medium" },
              { value: "low", label: "Low" },
            ],
          },
        ] satisfies FilterConfig[]}
      />

      {/* Status toggle */}
      <div className="flex items-center gap-0 rounded-lg border border-border-default overflow-hidden mb-4 w-fit">
        <button
          onClick={() => setStatusToggle("open")}
          className={`px-3 py-2 text-xs font-medium min-h-[44px] transition-colors ${
            statusToggle === "open"
              ? "bg-accent text-text-inverse"
              : "text-text-muted hover:text-text-primary hover:bg-surface-overlay"
          }`}
        >
          Open
        </button>
        <button
          onClick={() => setStatusToggle("resolved")}
          className={`px-3 py-2 text-xs font-medium min-h-[44px] transition-colors ${
            statusToggle === "resolved"
              ? "bg-accent text-text-inverse"
              : "text-text-muted hover:text-text-primary hover:bg-surface-overlay"
          }`}
        >
          Resolved
        </button>
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
          <div className="space-y-6">
            {grouped.map((group) => {
              const level = normalizeLevel(group.severity);
              return (
                <div key={group.severity}>
                  {/* Group header */}
                  <div className="flex items-center gap-2 mb-3">
                    <SeverityBadge level={level} />
                    <span className="text-xs text-text-muted">
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
  const level = normalizeLevel(issue.severity);
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
      <SeverityBadge level={level} size="sm" className="flex-shrink-0" />

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
