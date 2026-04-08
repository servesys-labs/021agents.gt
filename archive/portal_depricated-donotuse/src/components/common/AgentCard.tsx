import { useNavigate } from "react-router-dom";
import { Play, Rocket, Clock } from "lucide-react";

import { StatusBadge } from "./StatusBadge";
import { Sparkline } from "./Sparkline";
import { CopyIdButton } from "./CopyIdButton";
import { VersionBadge } from "./VersionBadge";

/* ── Types ──────────────────────────────────────────────────── */

export interface AgentCardData {
  name: string;
  description?: string;
  status?: string;
  model?: string;
  version?: string;
  tags?: string[];
  sessions_count?: number;
  success_rate?: number;
  last_active?: string;
  /** Last 7 data points for the sparkline (e.g. daily sessions) */
  activity_trend?: number[];
}

interface AgentCardProps {
  agent: AgentCardData;
  onSelect?: (name: string) => void;
}

/* ── Helpers ────────────────────────────────────────────────── */

function timeAgo(dateStr?: string): string {
  if (!dateStr) return "Never";
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

/* ── Component ──────────────────────────────────────────────── */

export function AgentCard({ agent, onSelect }: AgentCardProps) {
  const navigate = useNavigate();

  const trend = agent.activity_trend?.length
    ? agent.activity_trend
    : [0, 1, 2, 1, 3, 2, 4]; // placeholder

  return (
    <div
      className="agent-card"
      onClick={() => onSelect?.(agent.name)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect?.(agent.name);
        }
      }}
    >
      {/* Header row: name + status */}
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          <h3
            className="text-sm font-semibold text-text-primary truncate"
            title={agent.name}
          >
            {agent.name}
          </h3>
          <CopyIdButton value={agent.name} label="name" />
        </div>
        <StatusBadge status={agent.status || "draft"} size="sm" />
      </div>

      {/* Description */}
      {agent.description && (
        <p
          className="text-[10px] text-text-muted mb-3 line-clamp-2"
          title={agent.description}
        >
          {agent.description}
        </p>
      )}

      {/* Badges row: model + version/tags */}
      <div className="flex items-center gap-1.5 flex-wrap mb-3">
        {agent.model && (
          <span className="px-1.5 py-0.5 text-[10px] font-mono bg-surface-overlay text-text-secondary rounded border border-border-default leading-none">
            {agent.model.split("/").pop()}
          </span>
        )}
        {agent.version && <VersionBadge label={agent.version} />}
        {agent.tags?.slice(0, 2).map((tag) => (
          <VersionBadge key={tag} label={tag} />
        ))}
      </div>

      {/* Metrics row */}
      <div className="flex items-center gap-4 text-[10px] text-text-muted mb-2">
        <span title="Sessions">
          <span className="font-mono text-text-secondary">
            {agent.sessions_count ?? 0}
          </span>{" "}
          sessions
        </span>
        <span title="Success rate">
          <span className="font-mono text-text-secondary">
            {agent.success_rate != null
              ? `${Math.round(agent.success_rate)}%`
              : "--"}
          </span>{" "}
          success
        </span>
        <Sparkline data={trend} width={80} height={24} />
      </div>

      {/* Last active */}
      <div className="flex items-center gap-1 text-[10px] text-text-muted">
        <Clock size={10} />
        <span>Last active: {timeAgo(agent.last_active)}</span>
      </div>

      {/* Hover quick actions */}
      <div className="agent-card-actions">
        <button
          className="agent-card-action-btn"
          title="Playground"
          aria-label={`Open ${agent.name} in playground`}
          onClick={(e) => {
            e.stopPropagation();
            navigate(`/agent-chat?agent=${agent.name}`);
          }}
        >
          <Play size={12} />
        </button>
        <button
          className="agent-card-action-btn"
          title="Deploy"
          aria-label={`Deploy ${agent.name}`}
          onClick={(e) => {
            e.stopPropagation();
            navigate(`/releases?agent=${agent.name}`);
          }}
        >
          <Rocket size={12} />
        </button>
      </div>
    </div>
  );
}
