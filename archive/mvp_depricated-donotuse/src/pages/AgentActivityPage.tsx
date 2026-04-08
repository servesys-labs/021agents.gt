import { useState, useEffect, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { MessageSquare, Clock, TrendingUp, AlertTriangle, RefreshCw, Loader2, Wrench } from "lucide-react";
import { Card } from "../components/ui/Card";
import { Badge } from "../components/ui/Badge";
import { StatCard } from "../components/ui/StatCard";
import { EmptyState } from "../components/ui/EmptyState";
import { SimpleChart } from "../components/SimpleChart";
import { Modal } from "../components/ui/Modal";
import { AgentNav } from "../components/AgentNav";
import { AgentNotFound } from "../components/AgentNotFound";
import { Button } from "../components/ui/Button";
import { api } from "../lib/api";
import { agentPathSegment } from "../lib/agent-path";
import { ensureArray } from "../lib/ensure-array";

interface AgentDetail {
  name: string;
  description: string;
  config_json: Record<string, any>;
  is_active: boolean;
  version: number;
}

interface Session {
  session_id: string;
  status: string;
  cost_total_usd: number;
  wall_clock_seconds: number;
  created_at: string | number;
}

const statusVariant: Record<string, "success" | "info" | "danger" | "warning"> = {
  completed: "success",
  active: "info",
  running: "info",
  failed: "danger",
  escalated: "danger",
  pending: "warning",
};

export default function AgentActivityPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<{ input: string; output: string; turns: any[] } | null>(null);
  const [transcriptLoading, setTranscriptLoading] = useState(false);

  const loadTranscript = useCallback(async (sessionId: string) => {
    setTranscriptLoading(true);
    setTranscript(null);
    try {
      const [detail, turns] = await Promise.all([
        api.get<any>(`/sessions/${sessionId}`).catch(() => ({})),
        api.get<any[]>(`/sessions/${sessionId}/turns`).catch(() => []),
      ]);
      setTranscript({
        input: detail.input_text || "",
        output: detail.output_text || "",
        turns: Array.isArray(turns) ? turns : [],
      });
    } catch {
      setTranscript({ input: "", output: "", turns: [] });
    } finally {
      setTranscriptLoading(false);
    }
  }, []);

  const selectSession = useCallback((sessionId: string) => {
    setSelectedSession(sessionId);
    loadTranscript(sessionId);
  }, [loadTranscript]);

  const fetchData = async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    const seg = agentPathSegment(id);
    const q = encodeURIComponent(id.trim());
    try {
      const [agentData, sessionData] = await Promise.all([
        api.get<AgentDetail>(`/agents/${seg}`),
        api.get<Session[]>(`/sessions?agent_name=${q}&limit=20`),
      ]);
      setAgent(agentData);
      setSessions(ensureArray<Session>(sessionData));
    } catch (err: any) {
      if (err.status === 404) {
        setAgent(null);
      } else {
        setError(err.message || "Failed to load data");
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (id) fetchData();
  }, [id]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-20">
        <p className="text-text-secondary text-sm mb-4">{error}</p>
        <Button variant="secondary" onClick={fetchData}>
          <RefreshCw size={14} /> Retry
        </Button>
      </div>
    );
  }

  if (!agent) return <AgentNotFound />;

  // Compute stats from sessions
  const completedSessions = sessions.filter((s) => s.status === "completed");
  const totalSessions = sessions.length;
  const avgLatencyMs = completedSessions.length > 0
    ? Math.round(completedSessions.reduce((sum, s) => sum + s.wall_clock_seconds, 0) / completedSessions.length * 1000)
    : 0;
  const totalCost = sessions.reduce((sum, s) => sum + (s.cost_total_usd || 0), 0);
  const successRate = totalSessions > 0
    ? Math.round((completedSessions.length / totalSessions) * 100)
    : 0;
  const failedSessions = sessions.filter((s) => s.status === "failed" || s.status === "escalated").length;

  // Build daily chart data from sessions grouped by date
  const dailyMap = new Map<string, { count: number; successCount: number }>();
  sessions.forEach((s) => {
    const created = s.created_at;
    const day =
      typeof created === "string"
        ? created.slice(0, 10)
        : typeof created === "number"
          ? new Date(created).toISOString().slice(0, 10)
          : "unknown";
    const entry = dailyMap.get(day) || { count: 0, successCount: 0 };
    entry.count++;
    if (s.status === "completed") entry.successCount++;
    dailyMap.set(day, entry);
  });
  const sortedDays = Array.from(dailyMap.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  const chartData = sortedDays.map(([date, data]) => ({ label: date.slice(5), value: data.count }));
  const successChartData = sortedDays.map(([date, data]) => ({
    label: date.slice(5),
    value: data.count > 0 ? Math.round((data.successCount / data.count) * 100) : 0,
  }));

  return (
    <div>
      <AgentNav agentName={agent.name} />

      {/* Stats row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
        <StatCard icon={<MessageSquare size={14} className="text-primary" />} label="Sessions" value={totalSessions} />
        <StatCard icon={<Clock size={14} className="text-warning" />} label="Avg latency" value={avgLatencyMs > 0 ? `${avgLatencyMs}ms` : "—"} />
        <StatCard icon={<TrendingUp size={14} className="text-success" />} label="Success rate" value={`${successRate}%`} />
        <StatCard icon={<AlertTriangle size={14} className="text-danger" />} label="Failed" value={failedSessions} />
      </div>

      {/* Charts — only show if we have data */}
      {chartData.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-6">
          <Card>
            <p className="text-sm font-medium text-text mb-3">Sessions by day</p>
            <SimpleChart
              data={chartData}
              type="bar"
              color="var(--color-primary)"
            />
          </Card>
          <Card>
            <p className="text-sm font-medium text-text mb-3">Success rate</p>
            <SimpleChart
              data={successChartData}
              type="line"
              color="var(--color-success)"
            />
          </Card>
        </div>
      )}

      {/* Sessions list */}
      <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-3">Recent Sessions</h2>
      <div className="bg-surface rounded-xl border border-border divide-y divide-border">
        {sessions.length === 0 && (
          <EmptyState
            icon={<MessageSquare size={24} />}
            title="No activity yet"
            description="Try your agent in the playground to see sessions here"
          />
        )}
        {sessions.map((session) => (
          <button
            key={session.session_id}
            onClick={() => selectSession(session.session_id)}
            className="w-full flex items-center gap-4 p-4 hover:bg-surface-alt transition-colors text-left"
          >
            <div className="w-8 h-8 rounded-full bg-neutral-light flex items-center justify-center text-text-secondary text-xs font-medium">
              {(session.status || "?")[0].toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-text font-mono">{session.session_id.slice(0, 8)}...</span>
                <Badge variant={statusVariant[session.status] || "info"}>{session.status}</Badge>
              </div>
              <p className="text-xs text-text-muted truncate mt-0.5">
                Cost: ${(session.cost_total_usd || 0).toFixed(4)} &middot; {(session.wall_clock_seconds || 0).toFixed(1)}s
              </p>
            </div>
            <div className="text-right shrink-0">
              <p className="text-xs text-text-muted">
                {session.created_at ? new Date(session.created_at).toLocaleDateString() : ""}
              </p>
              <p className="text-xs text-text-muted">
                {session.created_at ? new Date(session.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""}
              </p>
            </div>
          </button>
        ))}
      </div>

      {/* Session detail modal */}
      <Modal open={!!selectedSession} onClose={() => { setSelectedSession(null); setTranscript(null); }} title="Session Detail" wide>
        {selectedSession && (() => {
          const session = sessions.find((s) => s.session_id === selectedSession);
          if (!session) return null;
          return (
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs text-text-muted">{session.session_id}</span>
                <Badge variant={statusVariant[session.status] || "info"}>{session.status}</Badge>
              </div>
              <div className="grid grid-cols-4 gap-3 text-xs">
                <div className="bg-surface-alt rounded-lg p-3 text-center">
                  <p className="font-bold text-text">${(session.cost_total_usd || 0).toFixed(4)}</p>
                  <p className="text-text-muted">Cost</p>
                </div>
                <div className="bg-surface-alt rounded-lg p-3 text-center">
                  <p className="font-bold text-text">{(session.wall_clock_seconds || 0).toFixed(1)}s</p>
                  <p className="text-text-muted">Duration</p>
                </div>
                <div className="bg-surface-alt rounded-lg p-3 text-center">
                  <p className="font-bold text-text">{transcript?.turns.length || 0}</p>
                  <p className="text-text-muted">Turns</p>
                </div>
                <div className="bg-surface-alt rounded-lg p-3 text-center">
                  <p className="font-bold text-text">{new Date(session.created_at).toLocaleDateString()}</p>
                  <p className="text-text-muted">Date</p>
                </div>
              </div>

              {/* Conversation Transcript */}
              <div className="border-t border-border pt-3">
                <p className="text-xs font-medium text-text mb-2">Conversation</p>
                {transcriptLoading ? (
                  <div className="flex items-center justify-center py-6">
                    <Loader2 size={16} className="animate-spin text-text-muted" />
                  </div>
                ) : transcript ? (
                  <div className="space-y-2 max-h-80 overflow-y-auto">
                    {/* User input */}
                    {transcript.input && (
                      <div className="flex justify-end">
                        <div className="max-w-[75%] px-3 py-2 rounded-xl rounded-br-sm bg-primary text-white text-xs">
                          {transcript.input}
                        </div>
                      </div>
                    )}
                    {/* Per-turn details */}
                    {transcript.turns.map((turn: any, i: number) => (
                      <div key={i} className="space-y-1">
                        {turn.tool_calls?.length > 0 && (
                          <div className="flex items-center gap-1 text-[10px] text-text-muted px-1">
                            <Wrench size={10} />
                            {turn.tool_calls.map((tc: any) => tc.function?.name || tc.name || "tool").join(", ")}
                            <span className="ml-auto">{turn.latency_ms}ms | ${(turn.cost_total_usd || 0).toFixed(4)}</span>
                          </div>
                        )}
                        {turn.content && (
                          <div className="flex justify-start">
                            <div className="max-w-[75%] px-3 py-2 rounded-xl rounded-bl-sm bg-surface-alt text-text text-xs whitespace-pre-wrap">
                              {turn.content}
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                    {/* Final output (if no turns or turns didn't capture it) */}
                    {transcript.output && transcript.turns.length === 0 && (
                      <div className="flex justify-start">
                        <div className="max-w-[75%] px-3 py-2 rounded-xl rounded-bl-sm bg-surface-alt text-text text-xs whitespace-pre-wrap">
                          {transcript.output}
                        </div>
                      </div>
                    )}
                    {!transcript.input && !transcript.output && transcript.turns.length === 0 && (
                      <p className="text-xs text-text-muted text-center py-4">No transcript available for this session.</p>
                    )}
                  </div>
                ) : null}
              </div>
            </div>
          );
        })()}
      </Modal>
    </div>
  );
}
