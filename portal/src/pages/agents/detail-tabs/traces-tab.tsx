import { useMemo } from "react";
import { ExternalLink } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { useApiQuery } from "../../../lib/api";

type SessionRow = {
  session_id: string;
  status?: string;
  created_at?: string;
  turns?: number;
  wall_clock_seconds?: number;
};

export function TracesTab({ agentName }: { agentName?: string }) {
  const navigate = useNavigate();

  const sessionsQuery = useApiQuery<{ sessions: SessionRow[] } | SessionRow[]>(
    `/api/v1/sessions?agent_name=${agentName ?? ""}&limit=50`,
    Boolean(agentName),
  );

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

  if (sessionsQuery.loading) {
    return <p className="text-[var(--text-sm)] text-text-muted py-[var(--space-6)]">Loading sessions...</p>;
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-[var(--space-4)]">
        <h2 className="text-[var(--text-md)] font-semibold text-text-primary">
          Sessions ({sessions.length})
        </h2>
      </div>

      {sortedSessions.length === 0 ? (
        <p className="text-[var(--text-sm)] text-text-muted">No sessions recorded</p>
      ) : (
        <div className="card">
          <div className="overflow-x-auto">
            <table>
              <thead>
                <tr>
                  <th>Session ID</th>
                  <th>Status</th>
                  <th>Turns</th>
                  <th>Duration</th>
                  <th>Created</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {sortedSessions.map((session) => {
                  const isErr = session.status === "error" || session.status === "failed";
                  return (
                    <tr
                      key={session.session_id}
                      className={`cursor-pointer ${isErr ? "bg-node-glow-red" : ""}`}
                      onClick={() => navigate(`/agents/${agentName}/sessions/${session.session_id}`)}
                    >
                      <td className="font-mono text-[var(--text-xs)]">
                        {session.session_id.slice(0, 16)}...
                      </td>
                      <td>
                        <span
                          className={`inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide ${
                            isErr
                              ? "text-status-error"
                              : session.status === "completed"
                                ? "text-status-live"
                                : "text-text-muted"
                          }`}
                        >
                          <span
                            className={`w-1.5 h-1.5 rounded-full ${
                              isErr
                                ? "bg-status-error"
                                : session.status === "completed"
                                  ? "bg-status-live"
                                  : "bg-text-muted"
                            }`}
                          />
                          {session.status ?? "unknown"}
                        </span>
                      </td>
                      <td className="font-mono">{session.turns ?? "--"}</td>
                      <td className="font-mono">
                        {session.wall_clock_seconds != null
                          ? `${session.wall_clock_seconds.toFixed(1)}s`
                          : "--"}
                      </td>
                      <td>
                        {session.created_at
                          ? new Date(session.created_at).toLocaleDateString(undefined, {
                              month: "short",
                              day: "numeric",
                              hour: "2-digit",
                              minute: "2-digit",
                            })
                          : "--"}
                      </td>
                      <td>
                        <ExternalLink size={12} className="text-text-muted" />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
