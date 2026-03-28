import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { MessageSquare, Clock, TrendingUp, AlertTriangle, RefreshCw } from "lucide-react";
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
  created_at: string;
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
      setSessions(sessionData);
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
    const day = s.created_at?.slice(0, 10) || "unknown";
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
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <StatCard icon={<MessageSquare size={14} className="text-primary" />} label="Sessions" value={totalSessions} />
        <StatCard icon={<Clock size={14} className="text-warning" />} label="Avg latency" value={avgLatencyMs > 0 ? `${avgLatencyMs}ms` : "—"} />
        <StatCard icon={<TrendingUp size={14} className="text-success" />} label="Success rate" value={`${successRate}%`} />
        <StatCard icon={<AlertTriangle size={14} className="text-danger" />} label="Failed" value={failedSessions} />
      </div>

      {/* Charts — only show if we have data */}
      {chartData.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
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
      <h2 className="text-lg font-medium text-text mb-4">Recent Sessions</h2>
      <div className="bg-white rounded-xl border border-border divide-y divide-border">
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
            onClick={() => setSelectedSession(session.session_id)}
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
      <Modal open={!!selectedSession} onClose={() => setSelectedSession(null)} title="Session Detail" wide>
        {selectedSession && (() => {
          const session = sessions.find((s) => s.session_id === selectedSession);
          if (!session) return null;
          return (
            <div className="space-y-3">
              <div className="flex items-center gap-2 mb-4">
                <span className="font-medium text-text font-mono text-sm">{session.session_id}</span>
                <Badge variant={statusVariant[session.status] || "info"}>{session.status}</Badge>
              </div>
              <div className="bg-surface-alt rounded-lg p-4 text-sm text-text-secondary space-y-2">
                <p><span className="font-medium text-text">Status:</span> {session.status}</p>
                <p><span className="font-medium text-text">Cost:</span> ${(session.cost_total_usd || 0).toFixed(4)}</p>
                <p><span className="font-medium text-text">Duration:</span> {(session.wall_clock_seconds || 0).toFixed(1)}s</p>
                <p><span className="font-medium text-text">Created:</span> {new Date(session.created_at).toLocaleString()}</p>
              </div>
            </div>
          );
        })()}
      </Modal>
    </div>
  );
}
