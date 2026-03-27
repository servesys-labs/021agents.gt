import { Fragment, useState, useMemo, useCallback } from "react";
import {
  Shield,
  AlertTriangle,
  AlertOctagon,
  Clock,
  Search,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  LogIn,
  LogOut,
  Key,
  UserX,
  Settings,
  Lock,
  Unlock,
  Eye,
  Filter,
  Activity,
} from "lucide-react";

import { PageHeader } from "../../components/common/PageHeader";
import { PageShell } from "../../components/layout/PageShell";
import { useApiQuery } from "../../lib/api";

/* ══════════════════════════════════════════════════════════════════
   Types
   ══════════════════════════════════════════════════════════════════ */

type SecurityEvent = {
  id: string;
  timestamp: string;
  event_type: string;
  actor: string;
  target?: string;
  severity: "critical" | "high" | "medium" | "low" | "info";
  ip_address?: string;
  details?: Record<string, unknown>;
};

type EventSummary = {
  total_24h: number;
  critical_count: number;
  high_count: number;
  failed_logins_24h: number;
};

type TimelineBucket = {
  hour: string;
  count: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
  info: number;
};

/* ══════════════════════════════════════════════════════════════════
   Helpers
   ══════════════════════════════════════════════════════════════════ */

function formatTs(ts: string): string {
  try {
    const d = new Date(ts);
    return d.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  } catch {
    return ts;
  }
}

function formatDateTime(ts: string): string {
  try {
    const d = new Date(ts);
    return `${d.toLocaleDateString()} ${d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })}`;
  } catch {
    return ts;
  }
}

function formatHour(hour: string): string {
  try {
    const d = new Date(hour);
    return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
  } catch {
    return hour;
  }
}

function severityColor(severity: string): string {
  switch (severity) {
    case "critical":
      return "text-status-error";
    case "high":
      return "text-status-error";
    case "medium":
      return "text-status-warning";
    case "low":
      return "text-status-info";
    case "info":
      return "text-text-muted";
    default:
      return "text-text-muted";
  }
}

function severityBadgeClass(severity: string): string {
  switch (severity) {
    case "critical":
      return "bg-status-error/10 text-status-error border-status-error/20";
    case "high":
      return "bg-status-error/10 text-status-error border-status-error/20";
    case "medium":
      return "bg-status-warning/10 text-status-warning border-status-warning/20";
    case "low":
      return "bg-status-info/10 text-status-info border-status-info/20";
    case "info":
      return "bg-surface-overlay text-text-muted border-border-default";
    default:
      return "bg-surface-overlay text-text-muted border-border-default";
  }
}

function severityBarColor(severity: string): string {
  switch (severity) {
    case "critical":
      return "#ef4444";
    case "high":
      return "#f97316";
    case "medium":
      return "#eab308";
    case "low":
      return "#3b82f6";
    case "info":
      return "#6b7280";
    default:
      return "#6b7280";
  }
}

function eventIcon(eventType: string): React.ReactNode {
  const size = 14;
  if (eventType.includes("login_failed") || eventType.includes("auth_failure")) return <UserX size={size} />;
  if (eventType.includes("login") || eventType.includes("auth")) return <LogIn size={size} />;
  if (eventType.includes("logout")) return <LogOut size={size} />;
  if (eventType.includes("key") || eventType.includes("token")) return <Key size={size} />;
  if (eventType.includes("settings") || eventType.includes("config")) return <Settings size={size} />;
  if (eventType.includes("lock")) return <Lock size={size} />;
  if (eventType.includes("unlock")) return <Unlock size={size} />;
  if (eventType.includes("access") || eventType.includes("view")) return <Eye size={size} />;
  return <Shield size={size} />;
}

/* ══════════════════════════════════════════════════════════════════
   Summary Card
   ══════════════════════════════════════════════════════════════════ */

function SummaryCard({
  label,
  value,
  icon,
  color,
}: {
  label: string;
  value: number;
  icon: React.ReactNode;
  color: string;
}) {
  return (
    <div className="card flex items-center gap-4">
      <div className={`p-2.5 rounded-lg ${color}`}>{icon}</div>
      <div>
        <p className="text-2xl font-bold text-text-primary">{value.toLocaleString()}</p>
        <p className="text-xs text-text-muted uppercase tracking-wide">{label}</p>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════
   Timeline Chart (SVG bar chart)
   ══════════════════════════════════════════════════════════════════ */

function TimelineChart({ buckets }: { buckets: TimelineBucket[] }) {
  if (buckets.length === 0) {
    return (
      <div className="flex items-center justify-center py-8">
        <span className="text-sm text-text-muted">No timeline data</span>
      </div>
    );
  }

  const maxCount = Math.max(...buckets.map((b) => b.count), 1);
  const barWidth = 24;
  const gap = 4;
  const chartHeight = 160;
  const chartWidth = buckets.length * (barWidth + gap);
  const labelHeight = 24;

  return (
    <div className="overflow-x-auto">
      <svg width={Math.max(chartWidth, 600)} height={chartHeight + labelHeight} className="block">
        {buckets.map((bucket, i) => {
          const x = i * (barWidth + gap);
          const totalHeight = (bucket.count / maxCount) * chartHeight;

          // Stack segments from bottom: info, low, medium, high, critical
          const segments = [
            { key: "info", count: bucket.info, color: severityBarColor("info") },
            { key: "low", count: bucket.low, color: severityBarColor("low") },
            { key: "medium", count: bucket.medium, color: severityBarColor("medium") },
            { key: "high", count: bucket.high, color: severityBarColor("high") },
            { key: "critical", count: bucket.critical, color: severityBarColor("critical") },
          ];

          let yOffset = chartHeight;

          return (
            <g key={i}>
              {/* Background bar */}
              <rect
                x={x}
                y={0}
                width={barWidth}
                height={chartHeight}
                fill="currentColor"
                className="text-surface-overlay"
                rx={3}
              />
              {/* Stacked severity segments */}
              {segments.map((seg) => {
                if (seg.count === 0) return null;
                const segHeight = (seg.count / maxCount) * chartHeight;
                yOffset -= segHeight;
                return (
                  <rect
                    key={seg.key}
                    x={x}
                    y={yOffset}
                    width={barWidth}
                    height={segHeight}
                    fill={seg.color}
                    rx={3}
                  />
                );
              })}
              {/* Count label above bar */}
              {bucket.count > 0 && (
                <text
                  x={x + barWidth / 2}
                  y={chartHeight - totalHeight - 4}
                  textAnchor="middle"
                  className="fill-text-muted text-[9px]"
                >
                  {bucket.count}
                </text>
              )}
              {/* Hour label */}
              <text
                x={x + barWidth / 2}
                y={chartHeight + 14}
                textAnchor="middle"
                className="fill-text-muted text-[8px]"
              >
                {formatHour(bucket.hour)}
              </text>
            </g>
          );
        })}
      </svg>

      {/* Legend */}
      <div className="flex items-center gap-4 mt-3">
        {[
          { label: "Critical", color: severityBarColor("critical") },
          { label: "High", color: severityBarColor("high") },
          { label: "Medium", color: severityBarColor("medium") },
          { label: "Low", color: severityBarColor("low") },
          { label: "Info", color: severityBarColor("info") },
        ].map((item) => (
          <div key={item.label} className="flex items-center gap-1.5 text-xs text-text-muted">
            <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ backgroundColor: item.color }} />
            {item.label}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════
   Event Types and Severity lists
   ══════════════════════════════════════════════════════════════════ */

const EVENT_TYPES = [
  "All",
  "login_success",
  "login_failed",
  "logout",
  "token_created",
  "token_revoked",
  "settings_changed",
  "mfa_enabled",
  "mfa_disabled",
  "account_locked",
  "permission_changed",
  "data_export",
  "data_deletion",
] as const;

const SEVERITIES = ["All", "critical", "high", "medium", "low", "info"] as const;

/* ══════════════════════════════════════════════════════════════════
   Main Page
   ══════════════════════════════════════════════════════════════════ */

export function SecurityEventsPage() {
  /* ── Filters ───────────────────────────────────────────────────── */
  const [eventTypeFilter, setEventTypeFilter] = useState<string>("All");
  const [severityFilter, setSeverityFilter] = useState<string>("All");
  const [actorSearch, setActorSearch] = useState("");
  const [expandedRow, setExpandedRow] = useState<string | null>(null);

  /* ── Queries ───────────────────────────────────────────────────── */
  const eventsQuery = useApiQuery<SecurityEvent[]>("/api/v1/security-events?since_hours=24&limit=100");
  const summaryQuery = useApiQuery<EventSummary>("/api/v1/security-events/summary");
  const timelineQuery = useApiQuery<TimelineBucket[]>("/api/v1/security-events/timeline");

  const events = useMemo<SecurityEvent[]>(
    () => (Array.isArray(eventsQuery.data) ? eventsQuery.data : []),
    [eventsQuery.data],
  );
  const summary = summaryQuery.data ?? { total_24h: 0, critical_count: 0, high_count: 0, failed_logins_24h: 0 };
  const timeline = useMemo<TimelineBucket[]>(
    () => (Array.isArray(timelineQuery.data) ? timelineQuery.data : []),
    [timelineQuery.data],
  );

  /* ── Filtered events ───────────────────────────────────────────── */
  const filteredEvents = useMemo(() => {
    return events.filter((e) => {
      if (eventTypeFilter !== "All" && e.event_type !== eventTypeFilter) return false;
      if (severityFilter !== "All" && e.severity !== severityFilter) return false;
      if (actorSearch && !e.actor.toLowerCase().includes(actorSearch.toLowerCase())) return false;
      return true;
    });
  }, [events, eventTypeFilter, severityFilter, actorSearch]);

  /* ── Refresh ───────────────────────────────────────────────────── */
  const refetchAll = useCallback(() => {
    void eventsQuery.refetch();
    void summaryQuery.refetch();
    void timelineQuery.refetch();
  }, [eventsQuery, summaryQuery, timelineQuery]);

  /* ── Render ────────────────────────────────────────────────────── */
  const isLoading = eventsQuery.loading || summaryQuery.loading;

  return (
    <PageShell variant="wide">
      <PageHeader
        title="Security Events"
        subtitle="Monitor authentication, access, and configuration changes"
        icon={<Shield size={18} />}
        onRefresh={refetchAll}
      />

      {/* ── Summary Cards ───────────────────────────────────────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <SummaryCard
          label="Total Events (24h)"
          value={summary.total_24h}
          icon={<Activity size={18} className="text-text-primary" />}
          color="bg-surface-overlay"
        />
        <SummaryCard
          label="Critical"
          value={summary.critical_count}
          icon={<AlertOctagon size={18} className="text-status-error" />}
          color="bg-status-error/10"
        />
        <SummaryCard
          label="High"
          value={summary.high_count}
          icon={<AlertTriangle size={18} className="text-status-warning" />}
          color="bg-status-warning/10"
        />
        <SummaryCard
          label="Failed Logins"
          value={summary.failed_logins_24h}
          icon={<UserX size={18} className="text-status-error" />}
          color="bg-status-error/10"
        />
      </div>

      {/* ── Hourly Timeline ─────────────────────────────────────────── */}
      <div className="card mb-6">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted flex items-center gap-2 mb-4">
          <Clock size={14} />
          Event Timeline (Last 24 Hours)
        </h3>
        {timelineQuery.loading ? (
          <div className="flex items-center justify-center py-8">
            <RefreshCw size={14} className="animate-spin text-accent mr-2" />
            <span className="text-xs text-text-muted">Loading timeline...</span>
          </div>
        ) : (
          <TimelineChart buckets={timeline} />
        )}
      </div>

      {/* ── Filters ─────────────────────────────────────────────────── */}
      <div className="card mb-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2 text-xs text-text-muted">
            <Filter size={14} />
            Filters
          </div>

          {/* Event Type */}
          <div className="relative">
            <select
              value={eventTypeFilter}
              onChange={(e) => setEventTypeFilter(e.target.value)}
              className="text-xs pr-8 appearance-none bg-surface-overlay border border-border-default rounded-md px-3 py-1.5 text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/50"
            >
              {EVENT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t === "All" ? "All Types" : t.replace(/_/g, " ")}
                </option>
              ))}
            </select>
            <ChevronDown size={12} className="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" />
          </div>

          {/* Severity */}
          <div className="relative">
            <select
              value={severityFilter}
              onChange={(e) => setSeverityFilter(e.target.value)}
              className="text-xs pr-8 appearance-none bg-surface-overlay border border-border-default rounded-md px-3 py-1.5 text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/50"
            >
              {SEVERITIES.map((s) => (
                <option key={s} value={s}>
                  {s === "All" ? "All Severities" : s.charAt(0).toUpperCase() + s.slice(1)}
                </option>
              ))}
            </select>
            <ChevronDown size={12} className="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" />
          </div>

          {/* Actor Search */}
          <div className="relative flex-1 min-w-[200px] max-w-[320px]">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted" />
            <input
              type="text"
              value={actorSearch}
              onChange={(e) => setActorSearch(e.target.value)}
              placeholder="Search by actor..."
              className="text-xs w-full pl-8 py-1.5"
            />
          </div>

          <span className="text-xs text-text-muted ml-auto">
            {filteredEvents.length} event{filteredEvents.length !== 1 ? "s" : ""}
          </span>
        </div>
      </div>

      {/* ── Events Table ────────────────────────────────────────────── */}
      <div className="card">
        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <RefreshCw size={16} className="animate-spin text-accent mr-2" />
            <span className="text-sm text-text-muted">Loading security events...</span>
          </div>
        ) : filteredEvents.length === 0 ? (
          <div className="text-center py-12">
            <Shield size={40} className="mx-auto text-text-muted mb-3 opacity-30" />
            <p className="text-sm text-text-muted">No security events found</p>
            <p className="text-xs text-text-muted mt-1">Try adjusting your filters</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border-default">
                  <th className="text-left py-2.5 px-2 text-text-muted font-medium uppercase tracking-wide w-[140px]">Timestamp</th>
                  <th className="text-left py-2.5 px-2 text-text-muted font-medium uppercase tracking-wide">Event</th>
                  <th className="text-left py-2.5 px-2 text-text-muted font-medium uppercase tracking-wide">Actor</th>
                  <th className="text-left py-2.5 px-2 text-text-muted font-medium uppercase tracking-wide">Target</th>
                  <th className="text-left py-2.5 px-2 text-text-muted font-medium uppercase tracking-wide w-[80px]">Severity</th>
                  <th className="text-left py-2.5 px-2 text-text-muted font-medium uppercase tracking-wide">IP Address</th>
                  <th className="text-left py-2.5 px-2 text-text-muted font-medium uppercase tracking-wide w-[40px]"></th>
                </tr>
              </thead>
              <tbody>
                {filteredEvents.map((event) => {
                  const isExpanded = expandedRow === event.id;
                  const hasDetails = event.details && Object.keys(event.details).length > 0;

                  return (
                    <Fragment key={event.id}>
                      <tr
                        className={`border-b border-border-default/50 hover:bg-surface-overlay/50 ${hasDetails ? "cursor-pointer" : ""}`}
                        onClick={() => hasDetails && setExpandedRow(isExpanded ? null : event.id)}
                      >
                        <td className="py-2 px-2 text-text-muted font-mono whitespace-nowrap">
                          {formatTs(event.timestamp)}
                        </td>
                        <td className="py-2 px-2">
                          <div className="flex items-center gap-2">
                            <span className={severityColor(event.severity)}>
                              {eventIcon(event.event_type)}
                            </span>
                            <span className="text-text-primary font-medium">
                              {event.event_type.replace(/_/g, " ")}
                            </span>
                          </div>
                        </td>
                        <td className="py-2 px-2 text-text-secondary">{event.actor}</td>
                        <td className="py-2 px-2 text-text-muted">{event.target ?? "--"}</td>
                        <td className="py-2 px-2">
                          <span
                            className={`inline-flex items-center px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide rounded-full border ${severityBadgeClass(event.severity)}`}
                          >
                            {event.severity}
                          </span>
                        </td>
                        <td className="py-2 px-2 text-text-muted font-mono">{event.ip_address ?? "--"}</td>
                        <td className="py-2 px-2 text-text-muted">
                          {hasDetails && (
                            isExpanded
                              ? <ChevronDown size={14} />
                              : <ChevronRight size={14} />
                          )}
                        </td>
                      </tr>
                      {isExpanded && hasDetails && (
                        <tr className="bg-surface-overlay/30">
                          <td colSpan={7} className="py-3 px-4">
                            <div className="text-xs font-mono text-text-secondary bg-surface-primary rounded-lg p-3 border border-border-default overflow-x-auto">
                              <pre className="whitespace-pre-wrap">
                                {JSON.stringify(event.details, null, 2)}
                              </pre>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </PageShell>
  );
}
