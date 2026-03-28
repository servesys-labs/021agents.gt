import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { MessageSquare, Clock, TrendingUp, AlertTriangle } from "lucide-react";
import { Card } from "../components/ui/Card";
import { Badge } from "../components/ui/Badge";
import { StatCard } from "../components/ui/StatCard";
import { EmptyState } from "../components/ui/EmptyState";
import { SimpleChart } from "../components/SimpleChart";
import { Modal } from "../components/ui/Modal";
import { AgentNav } from "../components/AgentNav";
import { AgentNotFound } from "../components/AgentNotFound";
import { MOCK_AGENTS, MOCK_CONVERSATIONS, MOCK_DAILY_METRICS } from "../lib/mock-data";

const statusVariant = { completed: "success", active: "info", escalated: "danger" } as const;

export default function AgentActivityPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const agent = MOCK_AGENTS.find((a) => a.id === id);
  const conversations = MOCK_CONVERSATIONS.filter((c) => c.agent_id === id);
  const [selectedConv, setSelectedConv] = useState<string | null>(null);

  if (!agent) return <AgentNotFound />;

  const avgResponseMs = Math.round(MOCK_DAILY_METRICS.reduce((s, d) => s + d.avg_response_ms, 0) / MOCK_DAILY_METRICS.length);

  return (
    <div>
      <AgentNav agentName={agent.name} />

      {/* Stats row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <StatCard icon={<MessageSquare size={14} className="text-primary" />} label="Today" value={agent.conversations_today} />
        <StatCard icon={<Clock size={14} className="text-warning" />} label="Avg response" value={`${avgResponseMs}ms`} />
        <StatCard icon={<TrendingUp size={14} className="text-success" />} label="Success rate" value={`${Math.round(agent.success_rate * 100)}%`} />
        <StatCard icon={<AlertTriangle size={14} className="text-danger" />} label="Escalations" value={conversations.filter((c) => c.status === "escalated").length} />
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
        <Card>
          <p className="text-sm font-medium text-text mb-3">Conversations this week</p>
          <SimpleChart
            data={MOCK_DAILY_METRICS.map((d) => ({ label: d.date.slice(5), value: d.conversations }))}
            type="bar"
            color="var(--color-primary)"
          />
        </Card>
        <Card>
          <p className="text-sm font-medium text-text mb-3">Success rate</p>
          <SimpleChart
            data={MOCK_DAILY_METRICS.map((d) => ({ label: d.date.slice(5), value: Math.round(d.success_rate * 100) }))}
            type="line"
            color="var(--color-success)"
          />
        </Card>
      </div>

      {/* Conversations */}
      <h2 className="text-lg font-medium text-text mb-4">Recent Conversations</h2>
      <div className="bg-white rounded-xl border border-border divide-y divide-border">
        {conversations.length === 0 && (
          <EmptyState icon={<MessageSquare size={24} />} title="No conversations yet" description="Conversations will appear here once customers start chatting" />
        )}
        {conversations.map((conv) => (
          <button
            key={conv.id}
            onClick={() => setSelectedConv(conv.id)}
            className="w-full flex items-center gap-4 p-4 hover:bg-surface-alt transition-colors text-left"
          >
            <div className="w-8 h-8 rounded-full bg-neutral-light flex items-center justify-center text-text-secondary text-xs font-medium">
              {conv.user_name[0]}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-text">{conv.user_name}</span>
                <Badge variant={statusVariant[conv.status]}>{conv.status}</Badge>
              </div>
              <p className="text-xs text-text-muted truncate mt-0.5">{conv.preview}</p>
            </div>
            <div className="text-right shrink-0">
              <p className="text-xs text-text-muted">{conv.messages} msgs</p>
              <p className="text-xs text-text-muted">{new Date(conv.started_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</p>
            </div>
          </button>
        ))}
      </div>

      {/* Conversation detail modal */}
      <Modal open={!!selectedConv} onClose={() => setSelectedConv(null)} title="Conversation" wide>
        {selectedConv && (() => {
          const conv = conversations.find((c) => c.id === selectedConv);
          if (!conv) return null;
          return (
            <div className="space-y-3">
              <div className="flex items-center gap-2 mb-4">
                <span className="font-medium text-text">{conv.user_name}</span>
                <Badge variant={statusVariant[conv.status]}>{conv.status}</Badge>
                <span className="text-xs text-text-muted ml-auto">{conv.messages} messages</span>
              </div>
              <div className="bg-surface-alt rounded-lg p-4 text-sm text-text-secondary">
                <p className="font-medium text-text mb-2">Customer:</p>
                <p>{conv.preview}</p>
                <p className="font-medium text-text mt-4 mb-2">Agent:</p>
                <p>Thanks for reaching out! I'd be happy to help with that. Let me look into this for you...</p>
              </div>
            </div>
          );
        })()}
      </Modal>
    </div>
  );
}
