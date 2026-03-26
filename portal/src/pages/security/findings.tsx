import { useState, useMemo } from "react";
import {
  Search,
  ShieldAlert,
  Filter,
} from "lucide-react";

import { PageHeader } from "../../components/common/PageHeader";
import { QueryState } from "../../components/common/QueryState";
import { EmptyState } from "../../components/common/EmptyState";
import { useApiQuery } from "../../lib/api";

/* ── Types ──────────────────────────────────────────────────────── */

type Finding = {
  id: string;
  title: string;
  description?: string;
  severity: string;
  category?: string;
  agent_name?: string;
  scan_id?: string;
  probe_name?: string;
  status?: string;
  recommendation?: string;
  created_at?: string;
};

/* ── Helpers ─────────────────────────────────────────────────────── */

function severityColor(severity: string) {
  switch (severity?.toLowerCase()) {
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

function formatDate(dateStr?: string): string {
  if (!dateStr) return "--";
  return new Date(dateStr).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/* ── Findings Page ──────────────────────────────────────────────── */

export function FindingsPage() {
  const [search, setSearch] = useState("");
  const [severityFilter, setSeverityFilter] = useState<string>("all");

  const { data, loading, error, refetch } = useApiQuery<Finding[]>(
    "/api/v1/security/findings",
  );

  const findings = useMemo(() => data ?? [], [data]);

  const filtered = useMemo(() => {
    let result = findings;
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(
        (f) =>
          f.title.toLowerCase().includes(q) ||
          f.description?.toLowerCase().includes(q) ||
          f.agent_name?.toLowerCase().includes(q) ||
          f.probe_name?.toLowerCase().includes(q),
      );
    }
    if (severityFilter !== "all") {
      result = result.filter(
        (f) => f.severity.toLowerCase() === severityFilter,
      );
    }
    return result;
  }, [findings, search, severityFilter]);

  const severityCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const f of findings) {
      const sev = f.severity?.toLowerCase() || "unknown";
      counts[sev] = (counts[sev] || 0) + 1;
    }
    return counts;
  }, [findings]);

  return (
    <div>
      <PageHeader
        title="Security Findings"
        subtitle={`${findings.length} findings`}
        onRefresh={() => void refetch()}
      />

      {/* Severity summary cards */}
      {findings.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
          {["critical", "high", "medium", "low"].map((sev) => (
            <div
              key={sev}
              className={`card py-3 cursor-pointer transition-colors ${
                severityFilter === sev ? "border-accent" : ""
              }`}
              onClick={() =>
                setSeverityFilter(severityFilter === sev ? "all" : sev)
              }
            >
              <p className="text-xl font-bold text-text-primary font-mono">
                {severityCounts[sev] || 0}
              </p>
              <p className="text-[10px] text-text-muted uppercase tracking-wide">
                {sev}
              </p>
            </div>
          ))}
        </div>
      )}

      {/* Search & Filter bar */}
      <div className="flex items-center gap-3 mb-4">
        <div className="relative flex-1 max-w-xs">
          <Search
            size={14}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
          />
          <input
            type="text"
            placeholder="Search findings..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8 text-xs"
          />
        </div>
        <div className="flex items-center gap-2">
          <Filter size={14} className="text-text-muted" />
          <select
            className="text-xs w-auto"
            value={severityFilter}
            onChange={(e) => setSeverityFilter(e.target.value)}
          >
            <option value="all">All Severities</option>
            <option value="critical">Critical</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
        </div>
      </div>

      <QueryState
        loading={loading}
        error={error}
        isEmpty={findings.length === 0}
        emptyMessage=""
        onRetry={() => void refetch()}
      >
        {filtered.length === 0 ? (
          <EmptyState
            icon={<ShieldAlert size={40} />}
            title="No findings found"
            description={
              search || severityFilter !== "all"
                ? "Try a different search term or filter"
                : "No security findings detected -- run a scan to check"
            }
          />
        ) : (
          <div className="card p-0">
            <div className="overflow-x-auto">
              <table>
                <thead>
                  <tr>
                    <th>Finding</th>
                    <th>Severity</th>
                    <th>Agent</th>
                    <th>Category</th>
                    <th>Status</th>
                    <th>Date</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((finding) => (
                    <tr key={finding.id}>
                      <td>
                        <div>
                          <span className="font-medium text-text-primary text-xs">
                            {finding.title}
                          </span>
                          {finding.description && (
                            <p className="text-[10px] text-text-muted mt-0.5 truncate max-w-[300px]">
                              {finding.description}
                            </p>
                          )}
                        </div>
                      </td>
                      <td>
                        <span
                          className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase border ${severityColor(finding.severity)}`}
                        >
                          {finding.severity}
                        </span>
                      </td>
                      <td className="text-xs text-text-muted">
                        {finding.agent_name || "--"}
                      </td>
                      <td className="text-xs text-text-muted">
                        {finding.category || "--"}
                      </td>
                      <td className="text-xs text-text-muted">
                        {finding.status || "open"}
                      </td>
                      <td className="text-[10px] text-text-muted">
                        {formatDate(finding.created_at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </QueryState>
    </div>
  );
}

export { FindingsPage as default };
