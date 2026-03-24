import { useMemo, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle,
  XCircle,
  Bug,
  Shield,
  Brain,
  Zap,
  Clock,
  Settings,
  RefreshCw,
  Plus,
  Wrench,
} from "lucide-react";

import { PageHeader } from "../../components/common/PageHeader";
import { QueryState } from "../../components/common/QueryState";
import { Tabs } from "../../components/common/Tabs";
import { EmptyState } from "../../components/common/EmptyState";
import { SlidePanel } from "../../components/common/SlidePanel";
import { StatusBadge } from "../../components/common/StatusBadge";
import { useApiQuery, apiRequest } from "../../lib/api";
import { useToast } from "../../components/common/ToastProvider";

/* ── Types ─────────────────────────────────────────────────────── */

type Issue = {
  issue_id: string;
  agent_name: string;
  title: string;
  description: string;
  category: string;
  severity: string;
  status: string;
  source: string;
  source_session_id: string;
  suggested_fix: string;
  assigned_to: string;
  created_at: number;
  updated_at: number;
};

type IssueSummary = {
  total: number;
  by_status: Record<string, number>;
  by_category: Record<string, number>;
  by_severity: Record<string, number>;
};

/* ── Helpers ───────────────────────────────────────────────────── */

const severityColor = (s: string) => {
  switch (s) {
    case "critical": return "text-status-error";
    case "high": return "text-chart-orange";
    case "medium": return "text-status-warning";
    default: return "text-text-muted";
  }
};

const severityIcon = (s: string) => {
  switch (s) {
    case "critical": return <XCircle size={14} />;
    case "high": return <AlertTriangle size={14} />;
    case "medium": return <AlertCircle size={14} />;
    default: return <Bug size={14} />;
  }
};

const categoryIcon = (c: string) => {
  switch (c) {
    case "security": return <Shield size={12} className="text-status-error" />;
    case "tool_failure": return <Zap size={12} className="text-chart-orange" />;
    case "hallucination": return <Brain size={12} className="text-chart-purple" />;
    case "performance": return <Clock size={12} className="text-status-warning" />;
    case "config_drift": return <Settings size={12} className="text-chart-blue" />;
    default: return <Bug size={12} className="text-text-muted" />;
  }
};

const statusColor = (s: string) => {
  switch (s) {
    case "open": return "bg-status-error/10 text-status-error border-status-error/20";
    case "triaged": return "bg-status-warning/10 text-status-warning border-status-warning/20";
    case "fixing": return "bg-chart-blue/10 text-chart-blue border-chart-blue/20";
    case "resolved": return "bg-status-live/10 text-status-live border-status-live/20";
    default: return "bg-text-muted/10 text-text-muted border-text-muted/20";
  }
};

/* ── Main Page ─────────────────────────────────────────────────── */

export const IssuesPage = () => {
  const { showToast } = useToast();
  const [activeTab, setActiveTab] = useState(0);
  const [statusFilter, setStatusFilter] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [selectedIssue, setSelectedIssue] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const issuesQuery = useApiQuery<{ issues: Issue[] }>(
    `/api/v1/issues?status=${statusFilter}&category=${categoryFilter}&limit=100`,
  );
  const summaryQuery = useApiQuery<IssueSummary>("/api/v1/issues/summary");
  const detailQuery = useApiQuery<Issue>(
    `/api/v1/issues/${selectedIssue ?? ""}`,
    Boolean(selectedIssue),
  );

  const issues = useMemo(() => issuesQuery.data?.issues ?? [], [issuesQuery.data]);
  const summary = summaryQuery.data;

  const handleRefresh = () => {
    issuesQuery.refetch();
    summaryQuery.refetch();
  };

  const handleResolve = async (issueId: string) => {
    try {
      await apiRequest(`/api/v1/issues/${issueId}/resolve`, "POST");
      showToast("Issue resolved", "success");
      handleRefresh();
    } catch {
      showToast("Failed to resolve issue", "error");
    }
  };

  const handleTriage = async (issueId: string) => {
    try {
      await apiRequest(`/api/v1/issues/${issueId}/triage`, "POST");
      showToast("Issue triaged", "success");
      handleRefresh();
      if (selectedIssue === issueId) detailQuery.refetch();
    } catch {
      showToast("Failed to triage issue", "error");
    }
  };

  const openCount = issues.filter(i => i.status === "open").length;

  return (
    <div className="max-w-[1400px] mx-auto">
      <PageHeader
        title="Issues"
        subtitle="Automated issue tracking, classification, and remediation"
        liveCount={openCount}
        liveLabel="Open"
        actions={
          <button onClick={handleRefresh} className="btn btn-secondary">
            <RefreshCw size={14} />
          </button>
        }
      />

      {/* Summary KPIs */}
      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          <div className="card flex items-center gap-3">
            <div className="p-2 rounded-lg bg-chart-blue/10"><Bug size={16} className="text-chart-blue" /></div>
            <div>
              <p className="text-lg font-semibold text-text-primary">{summary.total}</p>
              <p className="text-[10px] text-text-muted uppercase">Total Issues</p>
            </div>
          </div>
          <div className="card flex items-center gap-3">
            <div className="p-2 rounded-lg bg-status-error/10"><AlertCircle size={16} className="text-status-error" /></div>
            <div>
              <p className="text-lg font-semibold text-text-primary">{summary.by_status?.open ?? 0}</p>
              <p className="text-[10px] text-text-muted uppercase">Open</p>
            </div>
          </div>
          <div className="card flex items-center gap-3">
            <div className="p-2 rounded-lg bg-status-warning/10"><Wrench size={16} className="text-status-warning" /></div>
            <div>
              <p className="text-lg font-semibold text-text-primary">{(summary.by_status?.triaged ?? 0) + (summary.by_status?.fixing ?? 0)}</p>
              <p className="text-[10px] text-text-muted uppercase">In Progress</p>
            </div>
          </div>
          <div className="card flex items-center gap-3">
            <div className="p-2 rounded-lg bg-status-live/10"><CheckCircle size={16} className="text-status-live" /></div>
            <div>
              <p className="text-lg font-semibold text-text-primary">{summary.by_status?.resolved ?? 0}</p>
              <p className="text-[10px] text-text-muted uppercase">Resolved</p>
            </div>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="flex items-center gap-3 mb-4">
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="px-2 py-1.5 text-xs rounded-lg bg-surface-raised border border-border-default text-text-primary"
        >
          <option value="">All Status</option>
          <option value="open">Open</option>
          <option value="triaged">Triaged</option>
          <option value="fixing">Fixing</option>
          <option value="resolved">Resolved</option>
        </select>
        <select
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
          className="px-2 py-1.5 text-xs rounded-lg bg-surface-raised border border-border-default text-text-primary"
        >
          <option value="">All Categories</option>
          <option value="security">Security</option>
          <option value="tool_failure">Tool Failure</option>
          <option value="hallucination">Hallucination</option>
          <option value="knowledge_gap">Knowledge Gap</option>
          <option value="performance">Performance</option>
          <option value="config_drift">Config Drift</option>
        </select>
      </div>

      {/* Issues list */}
      <QueryState loading={issuesQuery.loading} error={issuesQuery.error}>
        {issues.length > 0 ? (
          <div className="card">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border-default text-text-muted">
                    <th className="text-left py-2 pr-4">Issue</th>
                    <th className="text-center py-2 px-3">Severity</th>
                    <th className="text-center py-2 px-3">Status</th>
                    <th className="text-left py-2 px-3">Category</th>
                    <th className="text-left py-2 px-3">Agent</th>
                    <th className="text-left py-2 px-3">Source</th>
                    <th className="text-center py-2 px-3">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {issues.map((issue) => (
                    <tr
                      key={issue.issue_id}
                      className="border-b border-border-default/50 hover:bg-surface-overlay/30 cursor-pointer"
                      onClick={() => { setSelectedIssue(issue.issue_id); setDrawerOpen(true); }}
                    >
                      <td className="py-2 pr-4">
                        <p className="text-text-primary font-medium text-xs">{issue.title}</p>
                        <p className="text-[10px] text-text-muted font-mono">{issue.issue_id}</p>
                      </td>
                      <td className="py-2 px-3 text-center">
                        <span className={`inline-flex items-center gap-1 ${severityColor(issue.severity)}`}>
                          {severityIcon(issue.severity)}
                          <span className="text-[10px]">{issue.severity}</span>
                        </span>
                      </td>
                      <td className="py-2 px-3 text-center">
                        <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-medium border ${statusColor(issue.status)}`}>
                          {issue.status}
                        </span>
                      </td>
                      <td className="py-2 px-3">
                        <span className="inline-flex items-center gap-1 text-[10px] text-text-secondary">
                          {categoryIcon(issue.category)} {issue.category}
                        </span>
                      </td>
                      <td className="py-2 px-3 text-text-muted">{issue.agent_name || "—"}</td>
                      <td className="py-2 px-3 text-text-muted">{issue.source}</td>
                      <td className="py-2 px-3 text-center space-x-2">
                        {issue.status === "open" && (
                          <button
                            onClick={(e) => { e.stopPropagation(); handleTriage(issue.issue_id); }}
                            className="text-chart-blue hover:underline text-[10px]"
                          >
                            Triage
                          </button>
                        )}
                        {issue.status !== "resolved" && (
                          <button
                            onClick={(e) => { e.stopPropagation(); handleResolve(issue.issue_id); }}
                            className="text-status-live hover:underline text-[10px]"
                          >
                            Resolve
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <EmptyState
            message={statusFilter || categoryFilter ? "No issues match your filters." : "No issues detected yet. Issues are auto-created when problems are found."}
          />
        )}
      </QueryState>

      {/* Detail Drawer */}
      <SlidePanel
        open={drawerOpen}
        onClose={() => { setDrawerOpen(false); setSelectedIssue(null); }}
        title={`Issue — ${detailQuery.data?.title?.slice(0, 40) ?? ""}`}
      >
        {selectedIssue && (
          <QueryState loading={detailQuery.loading} error={detailQuery.error}>
            {detailQuery.data && (() => {
              const issue = detailQuery.data;
              return (
                <div className="space-y-4">
                  <div className="space-y-2">
                    <div className="flex justify-between text-xs">
                      <span className="text-text-muted">ID</span>
                      <span className="font-mono text-text-secondary">{issue.issue_id}</span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-text-muted">Status</span>
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium border ${statusColor(issue.status)}`}>{issue.status}</span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-text-muted">Severity</span>
                      <span className={severityColor(issue.severity)}>{issue.severity}</span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-text-muted">Category</span>
                      <span className="inline-flex items-center gap-1 text-text-secondary">{categoryIcon(issue.category)} {issue.category}</span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-text-muted">Agent</span>
                      <span className="text-text-secondary">{issue.agent_name || "—"}</span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-text-muted">Source</span>
                      <span className="text-text-secondary">{issue.source}</span>
                    </div>
                    {issue.source_session_id && (
                      <div className="flex justify-between text-xs">
                        <span className="text-text-muted">Session</span>
                        <span className="font-mono text-text-secondary">{issue.source_session_id.slice(0, 16)}</span>
                      </div>
                    )}
                  </div>

                  <div>
                    <p className="text-xs text-text-muted mb-1">Description</p>
                    <p className="text-xs text-text-secondary">{issue.description || "No description"}</p>
                  </div>

                  {issue.suggested_fix && (
                    <div>
                      <p className="text-xs text-text-muted mb-1">Suggested Fix</p>
                      <pre className="text-[10px] text-chart-green bg-surface-base rounded-lg p-3 border border-border-default whitespace-pre-wrap">
                        {issue.suggested_fix}
                      </pre>
                    </div>
                  )}

                  <div className="flex gap-2 pt-2">
                    {issue.status === "open" && (
                      <button onClick={() => handleTriage(issue.issue_id)} className="btn btn-secondary text-xs flex-1">
                        Triage
                      </button>
                    )}
                    {issue.status !== "resolved" && (
                      <button onClick={() => handleResolve(issue.issue_id)} className="btn btn-primary text-xs flex-1">
                        Resolve
                      </button>
                    )}
                  </div>
                </div>
              );
            })()}
          </QueryState>
        )}
      </SlidePanel>
    </div>
  );
};
