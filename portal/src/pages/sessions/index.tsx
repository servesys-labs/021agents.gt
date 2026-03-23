import { useState } from "react";
import {
  Search,
  Play,
  XCircle,
  Clock,
  DollarSign,
  Layers,
  Filter,
} from "lucide-react";

import { PageHeader } from "../../components/common/PageHeader";
import { QueryState } from "../../components/common/QueryState";
import { SlidePanel } from "../../components/common/SlidePanel";
import { StatusBadge } from "../../components/common/StatusBadge";
import { EmptyState } from "../../components/common/EmptyState";
import { ActionMenu, type ActionMenuItem } from "../../components/common/ActionMenu";
import { ConfirmDialog } from "../../components/common/ConfirmDialog";
import { useToast } from "../../components/common/ToastProvider";
import { safeArray, toNumber, type SessionInfo } from "../../lib/adapters";
import { useApiQuery, apiRequest } from "../../lib/api";

type SessionTurn = {
  turn_number?: number;
  model_used?: string;
  latency_ms?: number;
  cost_total_usd?: number;
  content?: string;
  role?: string;
  tool_calls?: Array<{ name?: string; function?: { name?: string } }>;
  execution_mode?: string;
  plan_artifact?: {
    complexity?: string;
    tool_candidates?: string[];
    reasoning?: { strategy?: string };
    prioritization?: { backlog?: Array<{ id?: string; status?: string; title?: string }> };
    dag?: {
      nodes?: Array<{ id?: string; type?: string; status?: string }>;
      edges?: Array<{ from?: string; to?: string }>;
    };
  };
  reflection?: {
    confidence?: number;
    next_action?: string;
    action?: string;
    tool_failures?: string[];
    issues?: string[];
    error?: string;
  };
};

type ToolCall = { name?: string; function?: { name?: string } };
type TraceResponse = {
  trace_id?: string;
  sessions?: TraceSession[];
  cost_rollup?: {
    total_cost_usd?: number;
    by_agent?: Record<string, number>;
  };
};
type TraceSession = {
  session_id?: string;
  agent_name?: string;
  status?: string;
  step_count?: number;
  created_at?: number;
  cost_total_usd?: number;
};

export const SessionsPage = () => {
  const { showToast } = useToast();

  const [limit, setLimit] = useState(50);
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");

  /* ── Detail drawer ────────────────────────────────────────── */
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [traceCursor, setTraceCursor] = useState(0);

  /* ── Confirm dialog ───────────────────────────────────────── */
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [terminateTarget, setTerminateTarget] = useState<string | null>(null);

  /* ── Queries ──────────────────────────────────────────────── */
  const sessionsQuery = useApiQuery<SessionInfo[]>(
    `/api/v1/sessions?limit=${limit}&offset=${offset}`,
  );
  const turnsQuery = useApiQuery<SessionTurn[]>(
    `/api/v1/sessions/${selectedSession ?? ""}/turns`,
    Boolean(selectedSession),
  );
  const traceQuery = useApiQuery<TraceResponse>(
    `/api/v1/sessions/${selectedSession ?? ""}/trace`,
    Boolean(selectedSession),
  );

  const sessions = safeArray<SessionInfo>(sessionsQuery.data);

  /* ── Filtering ────────────────────────────────────────────── */
  const filtered = sessions.filter((s) => {
    if (search) {
      const q = search.toLowerCase();
      if (
        !s.session_id.toLowerCase().includes(q) &&
        !(s.agent_name ?? "").toLowerCase().includes(q)
      )
        return false;
    }
    if (statusFilter !== "all" && s.status !== statusFilter) return false;
    return true;
  });

  /* ── Actions ──────────────────────────────────────────────── */
  const openDetail = (sessionId: string) => {
    setSelectedSession(sessionId);
    setTraceCursor(0);
    setDrawerOpen(true);
  };

  const handleTerminate = async () => {
    if (!terminateTarget) return;
    try {
      await apiRequest(`/api/v1/sessions/${terminateTarget}/cancel`, "POST");
      showToast(`Session ${terminateTarget.slice(0, 12)} terminated`, "success");
      setConfirmOpen(false);
      setTerminateTarget(null);
      void sessionsQuery.refetch();
    } catch {
      showToast("Failed to terminate session", "error");
    }
  };

  const handleReplay = async (sessionId: string) => {
    try {
      await apiRequest(`/api/v1/sessions/${sessionId}/replay`, "POST");
      showToast("Replay started", "success");
      void sessionsQuery.refetch();
    } catch {
      showToast("Replay failed", "error");
    }
  };

  const getRowActions = (s: SessionInfo): ActionMenuItem[] => [
    {
      label: "View Turns",
      icon: <Layers size={12} />,
      onClick: () => openDetail(s.session_id),
    },
    {
      label: "Replay",
      icon: <Play size={12} />,
      onClick: () => void handleReplay(s.session_id),
    },
    {
      label: "Terminate",
      icon: <XCircle size={12} />,
      onClick: () => {
        setTerminateTarget(s.session_id);
        setConfirmOpen(true);
      },
      danger: true,
      disabled: s.status !== "running" && s.status !== "active",
    },
  ];

  /* ── Stats ────────────────────────────────────────────────── */
  const activeCount = sessions.filter(
    (s) => s.status === "running" || s.status === "active",
  ).length;
  const totalCost = sessions.reduce(
    (sum, s) => sum + toNumber(s.cost_total_usd),
    0,
  );

  const turns = safeArray<SessionTurn>(turnsQuery.data);
  const traceSessions = safeArray<TraceSession>(traceQuery.data?.sessions);
  const traceStep = traceSessions[traceCursor] ?? null;

  return (
    <div>
      <PageHeader
        title="Sessions"
        subtitle="Recent session runs and turn-level traces"
        liveCount={activeCount}
        liveLabel="Active"
        onRefresh={() => void sessionsQuery.refetch()}
      />

      {/* Stats row */}
      <div className="grid grid-cols-3 gap-3 mb-4">
        <div className="card flex items-center gap-3 py-3">
          <div className="p-2 rounded-lg bg-status-info/10">
            <Layers size={14} className="text-status-info" />
          </div>
          <div>
            <p className="text-lg font-bold text-text-primary font-mono">
              {sessions.length}
            </p>
            <p className="text-[10px] text-text-muted uppercase">Total Sessions</p>
          </div>
        </div>
        <div className="card flex items-center gap-3 py-3">
          <div className="p-2 rounded-lg bg-accent/10">
            <Clock size={14} className="text-accent" />
          </div>
          <div>
            <p className="text-lg font-bold text-text-primary font-mono">
              {sessions.length > 0
                ? (
                    sessions.reduce(
                      (sum, s) => sum + toNumber(s.wall_clock_seconds),
                      0,
                    ) / sessions.length
                  ).toFixed(1)
                : "0"}
              s
            </p>
            <p className="text-[10px] text-text-muted uppercase">Avg Duration</p>
          </div>
        </div>
        <div className="card flex items-center gap-3 py-3">
          <div className="p-2 rounded-lg bg-chart-green/10">
            <DollarSign size={14} className="text-chart-green" />
          </div>
          <div>
            <p className="text-lg font-bold text-text-primary font-mono">
              ${totalCost.toFixed(4)}
            </p>
            <p className="text-[10px] text-text-muted uppercase">Total Cost</p>
          </div>
        </div>
      </div>

      {/* Search & filter bar */}
      <div className="flex items-center justify-between mb-4 gap-3">
        <div className="flex items-center gap-3 flex-1">
          <div className="relative flex-1 max-w-xs">
            <Search
              size={14}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
            />
            <input
              type="text"
              placeholder="Search by ID or agent..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8 text-xs"
            />
          </div>
          <div className="flex items-center gap-1.5">
            <Filter size={12} className="text-text-muted" />
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="text-xs w-auto"
            >
              <option value="all">All Status</option>
              <option value="success">Success</option>
              <option value="error">Error</option>
              <option value="running">Running</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            className="btn btn-secondary text-xs"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - limit))}
          >
            Previous
          </button>
          <button
            className="btn btn-secondary text-xs"
            onClick={() => setOffset(offset + limit)}
          >
            Next
          </button>
          <select
            className="text-xs w-auto"
            value={limit}
            onChange={(e) => {
              setLimit(Number(e.target.value));
              setOffset(0);
            }}
          >
            <option value={25}>25</option>
            <option value={50}>50</option>
            <option value={100}>100</option>
            <option value={200}>200</option>
          </select>
        </div>
      </div>

      {/* Sessions table */}
      <QueryState
        loading={sessionsQuery.loading}
        error={sessionsQuery.error}
        isEmpty={sessions.length === 0}
        emptyMessage=""
        onRetry={() => void sessionsQuery.refetch()}
      >
        {filtered.length === 0 ? (
          <EmptyState
            icon={<Play size={40} />}
            title="No sessions found"
            description={
              search || statusFilter !== "all"
                ? "Try adjusting your filters"
                : "Sessions will appear here when agents are run"
            }
          />
        ) : (
          <div className="card p-0">
            <div className="overflow-x-auto">
              <table>
                <thead>
                  <tr>
                    <th>Session ID</th>
                    <th>Agent</th>
                    <th>Status</th>
                    <th>Turns</th>
                    <th>Cost</th>
                    <th>Duration</th>
                    <th style={{ width: "48px" }}></th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((s) => (
                    <tr key={s.session_id}>
                      <td>
                        <button
                          className="font-mono text-xs text-text-primary hover:text-accent transition-colors"
                          onClick={() => openDetail(s.session_id)}
                        >
                          {s.session_id.slice(0, 12)}...
                        </button>
                      </td>
                      <td>
                        <span className="text-text-secondary text-sm">
                          {s.agent_name ?? "unknown"}
                        </span>
                      </td>
                      <td>
                        <StatusBadge status={s.status ?? "unknown"} />
                      </td>
                      <td>
                        <span className="text-text-muted text-sm font-mono">
                          {toNumber(s.step_count)}
                        </span>
                      </td>
                      <td>
                        <span className="text-text-muted text-sm font-mono">
                          ${toNumber(s.cost_total_usd).toFixed(4)}
                        </span>
                      </td>
                      <td>
                        <span className="text-text-muted text-sm font-mono">
                          {toNumber(s.wall_clock_seconds).toFixed(1)}s
                        </span>
                      </td>
                      <td>
                        <ActionMenu items={getRowActions(s)} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </QueryState>

      {/* Session detail drawer */}
      <SlidePanel
        isOpen={drawerOpen}
        onClose={() => {
          setDrawerOpen(false);
          setSelectedSession(null);
        }}
        title={`Session ${selectedSession?.slice(0, 12) ?? ""}...`}
        subtitle="Turn-by-turn execution trace"
        width="560px"
      >
        <div className="mb-3 border border-border-default rounded-lg p-3 bg-surface-base">
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs font-semibold text-text-primary">Trace Step-Through</p>
            <span className="text-[10px] text-text-muted font-mono">
              {traceSessions.length > 0 ? `${traceCursor + 1}/${traceSessions.length}` : "0/0"}
            </span>
          </div>
          {traceQuery.loading ? (
            <p className="text-[11px] text-text-muted">Loading trace chain...</p>
          ) : traceQuery.error ? (
            <p className="text-[11px] text-text-muted">No trace chain available for this session.</p>
          ) : traceStep ? (
            <>
              <div className="grid grid-cols-2 gap-2 text-[11px] text-text-secondary">
                <p>Agent: <span className="text-text-primary">{traceStep.agent_name ?? "unknown"}</span></p>
                <p>Status: <span className="text-text-primary">{traceStep.status ?? "unknown"}</span></p>
                <p>Turns: <span className="font-mono">{toNumber(traceStep.step_count)}</span></p>
                <p>Cost: <span className="font-mono">${toNumber(traceStep.cost_total_usd).toFixed(6)}</span></p>
              </div>
              <div className="mt-2 flex items-center gap-2">
                <button
                  className="btn btn-secondary text-[11px] px-2 py-1"
                  disabled={traceCursor <= 0}
                  onClick={() => setTraceCursor((v) => Math.max(0, v - 1))}
                >
                  Previous Step
                </button>
                <button
                  className="btn btn-secondary text-[11px] px-2 py-1"
                  disabled={traceCursor >= traceSessions.length - 1}
                  onClick={() => setTraceCursor((v) => Math.min(traceSessions.length - 1, v + 1))}
                >
                  Next Step
                </button>
                <span className="text-[10px] text-text-muted ml-auto">
                  trace: {traceQuery.data?.trace_id?.slice(0, 10) ?? "n/a"}...
                </span>
              </div>
            </>
          ) : (
            <p className="text-[11px] text-text-muted">Trace chain is empty.</p>
          )}
        </div>
        {turnsQuery.loading && (
          <p className="text-sm text-text-muted">Loading turns...</p>
        )}
        {turnsQuery.error && (
          <p className="text-sm text-status-error">{turnsQuery.error}</p>
        )}
        {turns.length === 0 && !turnsQuery.loading && !turnsQuery.error && (
          <p className="text-sm text-text-muted">No turns recorded.</p>
        )}
        <div className="space-y-3">
          {turns.map((turn) => (
            <div
              key={turn.turn_number}
              className="border border-border-default rounded-lg p-3 bg-surface-base"
            >
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className="px-2 py-0.5 text-[10px] font-semibold bg-accent/10 text-accent rounded-full">
                    Turn {turn.turn_number}
                  </span>
                  <span className="px-2 py-0.5 text-[10px] font-semibold bg-surface-overlay text-text-muted rounded-full border border-border-default uppercase">
                    {turn.execution_mode ?? "sequential"}
                  </span>
                  {turn.role && (
                    <span className="text-[10px] text-text-muted uppercase">
                      {turn.role}
                    </span>
                  )}
                </div>
                <span className="text-[10px] text-text-muted font-mono">
                  {turn.model_used?.split("/").pop()} ·{" "}
                  {toNumber(turn.latency_ms).toFixed(0)}ms · $
                  {toNumber(turn.cost_total_usd).toFixed(6)}
                </span>
              </div>
              <p className="text-xs text-text-secondary whitespace-pre-wrap leading-relaxed">
                {turn.content?.slice(0, 800) ?? ""}
              </p>
              <div className="mt-2 text-[10px] text-text-muted flex flex-wrap gap-2">
                <span>
                  Confidence: {((toNumber(turn.reflection?.confidence) || 0) * 100).toFixed(1)}%
                </span>
                <span>
                  Action: {turn.reflection?.action ?? turn.reflection?.next_action ?? "n/a"}
                </span>
                <span>
                  DAG nodes: {safeArray<{ type?: string }>(turn.plan_artifact?.dag?.nodes).length}
                </span>
                <span>
                  Reasoning: {turn.plan_artifact?.reasoning?.strategy ?? "direct"}
                </span>
                <span>
                  Backlog items: {safeArray<{ id?: string }>(turn.plan_artifact?.prioritization?.backlog).length}
                </span>
              </div>
              {safeArray<string>(turn.reflection?.tool_failures).length > 0 && (
                <div className="mt-1 text-[10px] text-status-warning">
                  Tool failures: {safeArray<string>(turn.reflection?.tool_failures).join(", ")}
                </div>
              )}
              {safeArray<string>(turn.reflection?.issues).length > 0 && (
                <div className="mt-1 text-[10px] text-status-warning">
                  Issues: {safeArray<string>(turn.reflection?.issues).slice(0, 5).join(", ")}
                </div>
              )}
              {safeArray<{ id?: string; type?: string }>(turn.plan_artifact?.dag?.nodes).length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {safeArray<{ id?: string; type?: string }>(turn.plan_artifact?.dag?.nodes).map((node, i) => (
                    <span
                      key={`${node.id ?? node.type ?? "node"}-${i}`}
                      className="px-1.5 py-0.5 text-[10px] bg-surface-overlay text-text-muted rounded border border-border-default"
                    >
                      {node.type ?? "node"}:{node.id ?? `n${i + 1}`}
                    </span>
                  ))}
                </div>
              )}
              {safeArray<ToolCall>(turn.tool_calls).length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {safeArray<ToolCall>(turn.tool_calls).map((tc, i) => (
                    <span
                      key={`${tc.name ?? tc.function?.name ?? "tool"}-${i}`}
                      className="px-1.5 py-0.5 text-[10px] bg-surface-overlay text-text-muted rounded border border-border-default"
                    >
                      {tc.name || tc.function?.name || "tool"}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </SlidePanel>

      {/* Terminate confirmation */}
      {confirmOpen && terminateTarget && (
        <ConfirmDialog
          title="Terminate Session"
          description={`Are you sure you want to terminate session ${terminateTarget.slice(0, 12)}...? This will stop all running operations.`}
          confirmLabel="Terminate"
          tone="danger"
          onConfirm={() => void handleTerminate()}
          onCancel={() => {
            setConfirmOpen(false);
            setTerminateTarget(null);
          }}
        />
      )}
    </div>
  );
};
