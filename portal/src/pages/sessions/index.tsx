import { useState } from "react";

import { PageHeader } from "../../components/common/PageHeader";
import { QueryState } from "../../components/common/QueryState";
import { safeArray, toNumber, type SessionInfo } from "../../lib/adapters";
import { useApiQuery } from "../../lib/api";

type SessionTurn = {
  turn_number?: number;
  model_used?: string;
  latency_ms?: number;
  cost_total_usd?: number;
  content?: string;
  tool_calls?: Array<{ name?: string; function?: { name?: string } }>;
};
type ToolCall = { name?: string; function?: { name?: string } };

export const SessionsPage = () => {
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [limit, setLimit] = useState(50);
  const [offset, setOffset] = useState(0);

  const sessionsQuery = useApiQuery<SessionInfo[]>(`/api/v1/sessions?limit=${limit}&offset=${offset}`);
  const turnsQuery = useApiQuery<SessionTurn[]>(
    `/api/v1/sessions/${selectedSession ?? ""}/turns`,
    Boolean(selectedSession),
  );
  const sessions = safeArray<SessionInfo>(sessionsQuery.data);

  const statusColor = (status: string) => {
    if (status === "success") return "green";
    if (status === "error") return "red";
    return "gray";
  };

  return (
    <div>
      <PageHeader title="Sessions" subtitle="Recent session runs and turn-level traces" />
      <div className="mb-3 flex items-center gap-2">
        <button className="btn-secondary text-xs" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))}>
          Previous
        </button>
        <button className="btn-secondary text-xs" onClick={() => setOffset(offset + limit)}>
          Next
        </button>
        <select
          className="rounded border border-[#2a2a2a] px-2 py-1 text-xs"
          value={limit}
          onChange={(event) => {
            setLimit(Number(event.target.value));
            setOffset(0);
          }}
        >
          <option value={25}>25</option>
          <option value={50}>50</option>
          <option value={100}>100</option>
          <option value={200}>200</option>
        </select>
      </div>

      <QueryState
        loading={sessionsQuery.loading}
        error={sessionsQuery.error}
        isEmpty={sessions.length === 0}
        emptyMessage="No sessions found."
        onRetry={() => void sessionsQuery.refetch()}
      >
        <div className="card">
          <table className="os-table">
            <thead>
              <tr>
                <th>Session</th>
                <th>Agent</th>
                <th>Status</th>
                <th>Turns</th>
                <th>Cost</th>
                <th>Duration</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.session_id}>
                  <td>
                    <span className="font-mono text-xs text-gray-300">{s.session_id.slice(0, 12)}</span>
                  </td>
                  <td><span className="text-gray-400">{s.agent_name ?? "unknown"}</span></td>
                  <td>
                    <span className="badge">{s.status ?? "unknown"}</span>
                  </td>
                  <td><span className="text-gray-400">{toNumber(s.step_count)}</span></td>
                  <td><span className="text-gray-400">${toNumber(s.cost_total_usd).toFixed(4)}</span></td>
                  <td><span className="text-gray-400">{toNumber(s.wall_clock_seconds).toFixed(1)}s</span></td>
                  <td>
                    <button className="btn-primary text-xs" onClick={() => setSelectedSession(s.session_id)}>
                      Turns
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </QueryState>

      {selectedSession ? (
        <div className="card mt-6">
          <p className="font-bold text-white mb-4">Turns for {selectedSession.slice(0, 12)}</p>
          {turnsQuery.loading ? <span className="text-gray-400">Loading turns...</span> : null}
          {turnsQuery.error ? <p className="text-red-500">{turnsQuery.error}</p> : null}
          {safeArray<SessionTurn>(turnsQuery.data).map((turn) => (
            <div key={turn.turn_number} className="border-b border-[#2a2a2a] pb-3 mb-3">
              <div className="flex justify-between mb-1">
                <span className="badge">Turn {turn.turn_number}</span>
                <span className="text-xs text-gray-500">
                  {turn.model_used?.split("/").pop()} · {toNumber(turn.latency_ms).toFixed(0)}ms · ${toNumber(turn.cost_total_usd).toFixed(6)}
                </span>
              </div>
              <p className="text-sm text-gray-300 whitespace-pre-wrap">{turn.content?.slice(0, 500) ?? ""}</p>
              {safeArray<ToolCall>(turn.tool_calls).length > 0 && (
                <div className="mt-1">
                  {safeArray<ToolCall>(turn.tool_calls).map((tc, index) => (
                    <span key={`${tc.name ?? tc.function?.name ?? "tool"}-${index}`} className="badge badge-muted mr-1">
                      {tc.name || tc.function?.name || "tool"}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
          <button className="btn-primary text-xs" onClick={() => setSelectedSession(null)}>Close</button>
        </div>
      ) : null}
    </div>
  );
};
