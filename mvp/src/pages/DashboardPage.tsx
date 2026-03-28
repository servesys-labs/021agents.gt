import { useNavigate } from "react-router-dom";
import { Plus, MessageSquare, TrendingUp, Bot } from "lucide-react";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { Badge } from "../components/ui/Badge";
import { StatCard } from "../components/ui/StatCard";
import { MOCK_AGENTS, MOCK_DAILY_METRICS } from "../lib/mock-data";

const statusVariant = { active: "success", draft: "default", paused: "warning" } as const;

export default function DashboardPage() {
  const navigate = useNavigate();
  const today = MOCK_DAILY_METRICS[MOCK_DAILY_METRICS.length - 1];
  const totalConversations = MOCK_DAILY_METRICS.reduce((s, d) => s + d.conversations, 0);

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-text">Dashboard</h1>
          <p className="text-sm text-text-secondary mt-1">Your AI agents at a glance</p>
        </div>
        <Button onClick={() => navigate("/agents/new")} className="bg-gradient-to-r from-primary to-blue-500 hover:from-primary/90 hover:to-blue-500/90 shadow-md shadow-primary/20">
          <Plus size={16} /> New Agent
        </Button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
        <StatCard icon={<Bot size={16} className="text-primary" />} label="Total Agents" value={MOCK_AGENTS.length} />
        <StatCard icon={<MessageSquare size={16} className="text-success" />} label="Conversations Today" value={today.conversations} />
        <StatCard icon={<TrendingUp size={16} className="text-warning" />} label="This Week" value={totalConversations} />
      </div>

      {/* Agent list */}
      <h2 className="text-lg font-semibold text-text mb-4 pb-3 border-b border-border">My Agents</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {MOCK_AGENTS.map((agent) => (
          <Card key={agent.id} hover onClick={() => navigate(`/agents/${agent.id}/activity`)}>
            <div className="flex items-start justify-between mb-3">
              <div>
                <h3 className="text-sm font-semibold text-text">{agent.name}</h3>
                <p className="text-xs text-text-secondary mt-0.5">{agent.description}</p>
              </div>
              <Badge variant={statusVariant[agent.status]}>{agent.status}</Badge>
            </div>
            <div className="flex items-center gap-4 text-xs text-text-muted">
              <span>{agent.conversations_today} conversations today</span>
              {agent.success_rate > 0 && <span>{Math.round(agent.success_rate * 100)}% success</span>}
            </div>
            <div className="flex gap-2 mt-4">
              <Button size="sm" variant="secondary" onClick={(e) => { e.stopPropagation(); navigate(`/agents/${agent.id}/play`); }}>
                Test
              </Button>
              <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); navigate(`/agents/${agent.id}/flow`); }}>
                Edit Flow
              </Button>
              <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); navigate(`/agents/${agent.id}/tests`); }}>
                Evals
              </Button>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
