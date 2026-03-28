import { useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { ArrowLeft, MessageSquare, Clock, TrendingUp, AlertTriangle, Play, Settings, GitBranch, FlaskConical, BookOpen, Phone } from "lucide-react";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { Badge } from "../components/ui/Badge";
import { SimpleChart } from "../components/SimpleChart";
import { Modal } from "../components/ui/Modal";
import { MOCK_AGENTS, MOCK_CONVERSATIONS, MOCK_DAILY_METRICS } from "../lib/mock-data";

const statusVariant = { completed: "success", active: "info", escalated: "danger" } as const;

export default function AgentActivityPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const agent = MOCK_AGENTS.find((a) => a.id === id);
  const conversations = MOCK_CONVERSATIONS.filter((c) => c.agent_id === id);
  const [selectedConv, setSelectedConv] = useState<string | null>(null);

  if (!agent) {
    return <p className="text-text-secondary">Agent not found. <Link to="/" className="text-primary">Go back</Link></p>;
  }

  const avgResponseMs = Math.round(MOCK_DAILY_METRICS.reduce((s, d) => s + d.avg_response_ms, 0) / MOCK_DAILY_METRICS.length);

  return (
    <div>
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <button onClick={() => navigate("/")} className="p-1.5 rounded-lg hover:bg-surface-alt text-text-secondary">
          <ArrowLeft size={18} />
        </button>
        <div className="flex-1">
          <h1 className="text-xl font-semibold text-text">{agent.name}</h1>
          <p className="text-sm text-text-secondary">{agent.description}</p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" onClick={() => navigate(`/agents/${id}/play`)}><Play size={14} /> Test</Button>
          <Button size="sm" variant="secondary" onClick={() => navigate(`/agents/${id}/flow`)}><GitBranch size={14} /> Flow</Button>
          <Button size="sm" variant="secondary" onClick={() => navigate(`/agents/${id}/tests`)}><FlaskConical size={14} /> Evals</Button>
          <Button size="sm" variant="secondary" onClick={() => navigate(`/agents/${id}/knowledge`)}><BookOpen size={14} /> Knowledge</Button>
          <Button size="sm" variant="secondary" onClick={() => navigate(`/agents/${id}/voice`)}><Phone size={14} /> Voice</Button>
          <Button size="sm" variant="ghost" onClick={() => navigate(`/agents/${id}/settings`)}><Settings size={14} /></Button>
        </div>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <Card>
          <div className="flex items-center gap-2 mb-1">
            <MessageSquare size={14} className="text-primary" />
            <span className="text-xs text-text-secondary">Today</span>
          </div>
          <p className="text-xl font-semibold text-text">{agent.conversations_today}</p>
        </Card>
        <Card>
          <div className="flex items-center gap-2 mb-1">
            <Clock size={14} className="text-warning" />
            <span className="text-xs text-text-secondary">Avg response</span>
          </div>
          <p className="text-xl font-semibold text-text">{avgResponseMs}ms</p>
        </Card>
        <Card>
          <div className="flex items-center gap-2 mb-1">
            <TrendingUp size={14} className="text-success" />
            <span className="text-xs text-text-secondary">Success rate</span>
          </div>
          <p className="text-xl font-semibold text-text">{Math.round(agent.success_rate * 100)}%</p>
        </Card>
        <Card>
          <div className="flex items-center gap-2 mb-1">
            <AlertTriangle size={14} className="text-danger" />
            <span className="text-xs text-text-secondary">Escalations</span>
          </div>
          <p className="text-xl font-semibold text-text">{conversations.filter((c) => c.status === "escalated").length}</p>
        </Card>
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
          <p className="p-6 text-sm text-text-muted text-center">No conversations yet</p>
        )}
        {conversations.map((conv) => (
          <button
            key={conv.id}
            onClick={() => setSelectedConv(conv.id)}
            className="w-full flex items-center gap-4 p-4 hover:bg-surface-alt transition-colors text-left"
          >
            <div className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center text-text-secondary text-xs font-medium">
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
