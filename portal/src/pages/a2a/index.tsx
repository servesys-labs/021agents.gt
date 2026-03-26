import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
  Search,
  Network,
  Filter,
} from "lucide-react";

import { PageHeader } from "../../components/common/PageHeader";
import { QueryState } from "../../components/common/QueryState";
import { EmptyState } from "../../components/common/EmptyState";
import { StatusBadge } from "../../components/common/StatusBadge";
import { useApiQuery } from "../../lib/api";

/* ── Types ──────────────────────────────────────────────────────── */

export type A2AAgent = {
  agent_id: string;
  name: string;
  description?: string;
  url?: string;
  status?: string;
  capabilities?: string[];
  skills?: Array<{ name: string; description?: string }>;
  created_at?: string;
  updated_at?: string;
};

/* ── A2A Agents Page ────────────────────────────────────────────── */

export function A2APage() {
  const navigate = useNavigate();

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");

  const { data, loading, error, refetch } = useApiQuery<A2AAgent[]>(
    "/api/v1/a2a/agents",
  );

  const agents = useMemo(() => data ?? [], [data]);

  const filtered = useMemo(() => {
    let result = agents;
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(
        (a) =>
          a.name.toLowerCase().includes(q) ||
          a.description?.toLowerCase().includes(q),
      );
    }
    if (statusFilter !== "all") {
      result = result.filter((a) => a.status === statusFilter);
    }
    return result;
  }, [agents, search, statusFilter]);

  const statuses = useMemo(() => {
    const set = new Set<string>();
    for (const a of agents) {
      if (a.status) set.add(a.status);
    }
    return Array.from(set).sort();
  }, [agents]);

  return (
    <div>
      <PageHeader
        title="Agent-to-Agent"
        subtitle={`${agents.length} registered A2A agents`}
        onRefresh={() => void refetch()}
        actions={
          <button
            className="btn btn-primary text-xs"
            onClick={() => navigate("/a2a/compose")}
          >
            <Network size={14} />
            Compose Task
          </button>
        }
      />

      {/* Search & Filter bar */}
      <div className="flex items-center gap-3 mb-4">
        <div className="relative flex-1 max-w-xs">
          <Search
            size={14}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
          />
          <input
            type="text"
            placeholder="Search agents..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8 text-xs"
          />
        </div>
        {statuses.length > 0 && (
          <div className="flex items-center gap-2">
            <Filter size={14} className="text-text-muted" />
            <select
              className="text-xs w-auto"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
            >
              <option value="all">All Statuses</option>
              {statuses.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {/* Agent list */}
      <QueryState
        loading={loading}
        error={error}
        isEmpty={agents.length === 0}
        emptyMessage=""
        onRetry={() => void refetch()}
      >
        {filtered.length === 0 ? (
          <EmptyState
            icon={<Network size={40} />}
            title="No A2A agents found"
            description={
              search || statusFilter !== "all"
                ? "Try a different search term or filter"
                : "No agent-to-agent integrations registered yet"
            }
          />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {filtered.map((agent) => (
              <div key={agent.agent_id} className="card hover:border-accent/40 transition-colors">
                <div className="flex items-start justify-between mb-2">
                  <h3 className="text-sm font-semibold text-text-primary truncate">
                    {agent.name}
                  </h3>
                  <StatusBadge status={agent.status || "unknown"} />
                </div>
                <p className="text-xs text-text-muted mb-3 line-clamp-2">
                  {agent.description || "No description"}
                </p>
                {agent.url && (
                  <p className="text-[10px] text-text-muted font-mono truncate mb-2">
                    {agent.url}
                  </p>
                )}
                {agent.skills && agent.skills.length > 0 && (
                  <div className="flex flex-wrap gap-1 mb-2">
                    {agent.skills.slice(0, 4).map((skill) => (
                      <span
                        key={skill.name}
                        className="px-2 py-0.5 text-[10px] bg-surface-overlay text-text-secondary rounded border border-border-default"
                      >
                        {skill.name}
                      </span>
                    ))}
                    {agent.skills.length > 4 && (
                      <span className="text-[10px] text-text-muted">
                        +{agent.skills.length - 4}
                      </span>
                    )}
                  </div>
                )}
                {agent.capabilities && agent.capabilities.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {agent.capabilities.slice(0, 3).map((cap) => (
                      <span
                        key={cap}
                        className="px-1.5 py-0.5 text-[10px] bg-accent/10 text-accent rounded"
                      >
                        {cap}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </QueryState>
    </div>
  );
}

export { A2APage as default };
