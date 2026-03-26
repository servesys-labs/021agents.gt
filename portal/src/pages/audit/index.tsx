import { useCallback, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Download,
  FileText,
  Loader2,
} from "lucide-react";

import { PageHeader } from "../../components/common/PageHeader";
import { QueryState } from "../../components/common/QueryState";
import { EmptyState } from "../../components/common/EmptyState";
import { useApiQuery, apiGet } from "../../lib/api";
import { useToast } from "../../components/common/ToastProvider";

/* -- Types ----------------------------------------------------------- */

type AuditEntry = {
  id?: string;
  timestamp?: string;
  user?: string;
  actor?: string;
  action?: string;
  resource_type?: string;
  resource_id?: string;
  resource?: string;
  details?: Record<string, unknown> | string;
};

type EventType = {
  name: string;
  label?: string;
};

/* -- Component ------------------------------------------------------- */

export function AuditPage() {
  const { showToast } = useToast();
  const [sinceDays, setSinceDays] = useState(30);
  const [actionFilter, setActionFilter] = useState("");
  const [actorFilter, setActorFilter] = useState("");
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const auditQuery = useApiQuery<{ entries: AuditEntry[] } | AuditEntry[]>(
    `/api/v1/audit/log?limit=100&since_days=${sinceDays}`,
  );

  const eventsQuery = useApiQuery<{ events: EventType[] } | EventType[] | string[]>(
    "/api/v1/audit/events",
  );

  const entries: AuditEntry[] = useMemo(() => {
    const raw = auditQuery.data;
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    return raw.entries ?? [];
  }, [auditQuery.data]);

  const eventTypes: string[] = useMemo(() => {
    const raw = eventsQuery.data;
    if (!raw) return [];
    if (Array.isArray(raw)) {
      return raw.map((e) => (typeof e === "string" ? e : e.name ?? e.label ?? ""));
    }
    const list = (raw as { events?: unknown[] }).events;
    if (Array.isArray(list)) {
      return list.map((e) => (typeof e === "string" ? e : (e as EventType).name ?? ""));
    }
    return [];
  }, [eventsQuery.data]);

  /* Derive unique actors from loaded entries */
  const actors = useMemo(() => {
    const set = new Set<string>();
    entries.forEach((e) => {
      const actor = e.actor ?? e.user;
      if (actor) set.add(actor);
    });
    return Array.from(set).sort();
  }, [entries]);

  /* Derive action types from events API or entries fallback */
  const actionTypes = useMemo(() => {
    if (eventTypes.length > 0) return eventTypes;
    const set = new Set<string>();
    entries.forEach((e) => {
      if (e.action) set.add(e.action);
    });
    return Array.from(set).sort();
  }, [entries, eventTypes]);

  const filteredEntries = useMemo(() => {
    return entries.filter((e) => {
      if (actionFilter && (e.action ?? "").toLowerCase() !== actionFilter.toLowerCase()) return false;
      if (actorFilter) {
        const actor = (e.actor ?? e.user ?? "").toLowerCase();
        if (actor !== actorFilter.toLowerCase()) return false;
      }
      return true;
    });
  }, [entries, actionFilter, actorFilter]);

  const handleExport = useCallback(async () => {
    setExporting(true);
    try {
      const data = await apiGet<unknown>("/api/v1/audit/export");
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `audit-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      showToast("Audit log exported with hash chain", "success");
    } catch {
      showToast("Failed to export audit log", "error");
    } finally {
      setExporting(false);
    }
  }, [showToast]);

  return (
    <div className="max-w-[1400px] mx-auto">
      <PageHeader
        title="Audit Log"
        subtitle="Complete audit trail of all actions across the platform"
        actions={
          <button
            onClick={handleExport}
            disabled={exporting}
            className="btn btn-secondary text-[var(--text-xs)] min-h-[var(--touch-target-min)]"
          >
            {exporting ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Download size={14} />
            )}
            Export
          </button>
        }
      />

      {/* Filters row */}
      <div className="flex flex-col sm:flex-row gap-[var(--space-3)] mb-[var(--space-4)]">
        <div className="flex items-center gap-[var(--space-2)]">
          <label className="text-[var(--text-xs)] text-text-muted">Since:</label>
          <select
            value={sinceDays}
            onChange={(e) => setSinceDays(Number(e.target.value))}
            className="w-auto min-w-[120px]"
          >
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
            <option value={365}>Last 365 days</option>
          </select>
        </div>

        <div className="flex items-center gap-[var(--space-2)]">
          <label className="text-[var(--text-xs)] text-text-muted">Event type:</label>
          <select
            value={actionFilter}
            onChange={(e) => setActionFilter(e.target.value)}
            className="w-auto min-w-[160px]"
          >
            <option value="">All events</option>
            {actionTypes.map((at) => (
              <option key={at} value={at}>{at}</option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-[var(--space-2)]">
          <label className="text-[var(--text-xs)] text-text-muted">Actor:</label>
          <select
            value={actorFilter}
            onChange={(e) => setActorFilter(e.target.value)}
            className="w-auto min-w-[160px]"
          >
            <option value="">All actors</option>
            {actors.map((a) => (
              <option key={a} value={a}>{a}</option>
            ))}
          </select>
        </div>

        <div className="flex-1" />

        <button
          onClick={handleExport}
          disabled={exporting}
          className="btn btn-secondary text-[var(--text-xs)] min-h-[var(--touch-target-min)]"
        >
          {exporting ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <Download size={14} />
          )}
          Export with Hash Chain
        </button>
      </div>

      {/* Audit table */}
      <QueryState
        loading={auditQuery.loading}
        error={auditQuery.error}
        onRetry={auditQuery.refetch}
      >
        {filteredEntries.length > 0 ? (
          <div className="card">
            <div className="overflow-x-auto">
              <table>
                <thead>
                  <tr>
                    <th style={{ width: 28 }}></th>
                    <th>Timestamp</th>
                    <th>Actor</th>
                    <th>Action</th>
                    <th>Resource Type</th>
                    <th>Resource ID</th>
                    <th>Details</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredEntries.map((entry, i) => {
                    const rowId = entry.id ?? `${i}`;
                    const isExpanded = expandedRow === rowId;
                    const actor = entry.actor ?? entry.user ?? "--";
                    const resourceType = entry.resource_type ?? entry.resource ?? "--";
                    const resourceId = entry.resource_id ?? "--";
                    const detailStr =
                      typeof entry.details === "string"
                        ? entry.details
                        : entry.details
                          ? JSON.stringify(entry.details)
                          : "--";
                    return (
                      <tr
                        key={rowId}
                        className="cursor-pointer"
                        onClick={() => setExpandedRow(isExpanded ? null : rowId)}
                      >
                        {!isExpanded ? (
                          <>
                            <td>
                              <ChevronRight size={12} className="text-text-muted" />
                            </td>
                            <td className="text-[var(--text-xs)] font-mono text-text-muted whitespace-nowrap">
                              {entry.timestamp
                                ? new Date(entry.timestamp).toLocaleString()
                                : "--"}
                            </td>
                            <td className="text-text-primary text-[var(--text-sm)]">
                              {actor}
                            </td>
                            <td>
                              <span className="inline-block px-2 py-0.5 rounded text-[10px] font-semibold uppercase bg-surface-overlay text-text-secondary border border-border-default">
                                {entry.action ?? "--"}
                              </span>
                            </td>
                            <td className="text-text-secondary text-[var(--text-sm)]">
                              {resourceType}
                            </td>
                            <td className="text-text-muted text-[var(--text-xs)] font-mono">
                              {typeof resourceId === "string" && resourceId.length > 16
                                ? resourceId.slice(0, 16) + "..."
                                : resourceId}
                            </td>
                            <td className="text-text-muted text-[var(--text-xs)] max-w-[200px] truncate">
                              {detailStr.slice(0, 60)}
                              {detailStr.length > 60 ? "..." : ""}
                            </td>
                          </>
                        ) : (
                          <>
                            <td>
                              <ChevronDown size={12} className="text-text-muted" />
                            </td>
                            <td colSpan={6} className="bg-surface-base">
                              <div className="mb-[var(--space-2)]">
                                <span className="text-[var(--text-xs)] text-text-muted">
                                  {entry.timestamp
                                    ? new Date(entry.timestamp).toLocaleString()
                                    : "--"}{" "}
                                  | {actor} | {entry.action ?? "--"} | {resourceType} | {resourceId}
                                </span>
                              </div>
                              <pre className="text-[var(--text-xs)] text-text-secondary font-mono p-[var(--space-3)] overflow-x-auto whitespace-pre-wrap bg-surface-raised rounded-lg border border-border-default">
                                {typeof entry.details === "string"
                                  ? entry.details
                                  : JSON.stringify(entry.details, null, 2)}
                              </pre>
                            </td>
                          </>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <EmptyState
            icon={<FileText size={28} />}
            title="No audit entries"
            description="No audit log entries found for the selected filters and time range."
          />
        )}
      </QueryState>
    </div>
  );
}
