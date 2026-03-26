import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
  Activity,
  Bot,
  CheckCircle2,
  Plus,
} from "lucide-react";
import { useApiQuery } from "../../lib/api";
import { extractList } from "../../lib/normalize";

/* ── Types ──────────────────────────────────────────────────────── */

type Agent = {
  name: string;
  status: string;
  sessions_7d?: number;
  success_rate?: number;
  last_active?: string;
  description?: string;
  model?: string;
  tools?: string[];
};

/* ── Component ──────────────────────────────────────────────────── */

export function AgentListPage() {
  const navigate = useNavigate();
  const agentsQuery = useApiQuery<{ agents: Agent[] } | Agent[]>("/api/v1/agents");
  const agents = useMemo(() => extractList<Agent>(agentsQuery.data, "agents"), [agentsQuery.data]);
  const isLoading = agentsQuery.loading;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh] text-text-muted text-[var(--text-sm)]">
        Loading...
      </div>
    );
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-[var(--space-6)]">
        <div>
          <h1 className="text-[var(--text-lg)] font-bold text-text-primary">Agents</h1>
          <p className="text-[var(--text-sm)] text-text-muted mt-[var(--space-1)]">
            {agents.length} agent{agents.length !== 1 ? "s" : ""}
          </p>
        </div>
        <button
          onClick={() => navigate("/agents/new")}
          className="btn btn-primary min-h-[var(--touch-target-min)]"
        >
          <Plus size={16} />
          Create Agent
        </button>
      </div>

      {/* Empty state */}
      {agents.length === 0 && (
        <div className="flex flex-col items-center justify-center py-[var(--space-12)]">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-surface-overlay mb-[var(--space-4)]">
            <Bot size={32} className="text-text-muted" />
          </div>
          <h2 className="text-[var(--text-md)] font-semibold text-text-primary mb-[var(--space-2)]">
            No agents yet
          </h2>
          <p className="text-[var(--text-sm)] text-text-muted mb-[var(--space-4)]">
            Create your first agent to get started
          </p>
          <button
            onClick={() => navigate("/agents/new")}
            className="btn btn-primary min-h-[var(--touch-target-min)]"
          >
            <Plus size={16} />
            Create Agent
          </button>
        </div>
      )}

      {/* Agent cards grid */}
      {agents.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-[var(--space-4)]">
          {agents.map((agent) => (
            <AgentCard
              key={agent.name}
              agent={agent}
              onClick={() => navigate(`/agents/${agent.name}`)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Agent Card ──────────────────────────────────────────────────── */

function AgentCard({ agent, onClick }: { agent: Agent; onClick: () => void }) {
  const isLive =
    agent.status === "live" || agent.status === "active" || agent.status === "running";
  const successRate =
    agent.success_rate != null ? `${(agent.success_rate * 100).toFixed(0)}%` : "--";
  const lastActive = agent.last_active
    ? new Date(agent.last_active).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "--";

  return (
    <button
      onClick={onClick}
      className="card card-hover text-left w-full cursor-pointer transition-all hover:border-accent/30"
    >
      <div className="flex items-start justify-between mb-[var(--space-3)]">
        <div className="flex items-center gap-[var(--space-2)]">
          <div className="w-8 h-8 rounded-lg bg-accent-muted flex items-center justify-center">
            <Bot size={16} className="text-accent" />
          </div>
          <div>
            <p className="text-[var(--text-sm)] font-semibold text-text-primary">{agent.name}</p>
          </div>
        </div>
        <div className="flex items-center gap-[var(--space-1)]">
          <span
            className={`inline-block w-2 h-2 rounded-full ${
              isLive ? "bg-status-live" : "bg-text-muted"
            }`}
          />
          <span
            className={`text-[10px] uppercase tracking-wide font-medium ${
              isLive ? "text-status-live" : "text-text-muted"
            }`}
          >
            {agent.status || "draft"}
          </span>
        </div>
      </div>

      {agent.description && (
        <p className="text-[var(--text-xs)] text-text-muted mb-[var(--space-3)] line-clamp-2 leading-relaxed">
          {agent.description}
        </p>
      )}

      <div className="flex items-center gap-[var(--space-4)] pt-[var(--space-3)] border-t border-border-subtle">
        <div className="flex items-center gap-[var(--space-1)]">
          <Activity size={12} className="text-text-muted" />
          <span className="text-[var(--text-xs)] text-text-secondary font-mono">
            {agent.sessions_7d ?? 0}
          </span>
          <span className="text-[10px] text-text-muted">sessions</span>
        </div>
        <div className="flex items-center gap-[var(--space-1)]">
          <CheckCircle2 size={12} className="text-text-muted" />
          <span className="text-[var(--text-xs)] text-text-secondary font-mono">{successRate}</span>
        </div>
        <div className="ml-auto text-[10px] text-text-muted">{lastActive}</div>
      </div>
    </button>
  );
}

export { AgentListPage as default };
