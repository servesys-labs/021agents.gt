import { memo, useId } from "react";
import { type NodeProps } from "@xyflow/react";
import { Bot, Zap, Play, ChevronRight } from "lucide-react";
import { BaseNode } from "./BaseNode";

export type AgentNodeData = {
  name: string;
  model: string;
  status: "online" | "deploying" | "error" | "draft";
  tools: string[];
  sessions24h?: number;
  efficiency?: number;
  activity?: number[];
  systemPrompt?: string;
};

const statusConfig: Record<string, { bg: string; dot: string; label: string; glow: string }> = {
  online: {
    bg: "bg-node-glow-green",
    dot: "bg-status-live",
    label: "LIVE",
    glow: "",
  },
  deploying: {
    bg: "bg-node-glow-yellow",
    dot: "bg-status-warning",
    label: "DEPLOYING",
    glow: "",
  },
  error: {
    bg: "bg-node-glow-red",
    dot: "bg-status-error",
    label: "ERROR",
    glow: "",
  },
  draft: {
    bg: "bg-node-glow-muted",
    dot: "bg-text-muted",
    label: "DRAFT",
    glow: "",
  },
};

function MiniSparkline({ data, instanceId }: { data: number[]; instanceId: string }) {
  const max = Math.max(...data, 1);
  const width = 80;
  const height = 24;
  const points = data.map((v, i) => {
    const x = (i / Math.max(data.length - 1, 1)) * width;
    const y = height - (v / max) * height;
    return `${x},${y}`;
  });
  const pathD = `M${points.join(" L")}`;
  const areaD = `${pathD} L${width},${height} L0,${height} Z`;
  const gradientId = `sparkline-fill-${instanceId}`;

  return (
    <svg width={width} height={height} className="overflow-visible" aria-hidden="true">
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--color-accent)" stopOpacity="0.2" />
          <stop offset="100%" stopColor="var(--color-accent)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={areaD} fill={`url(#${gradientId})`} />
      <path d={pathD} fill="none" stroke="var(--color-accent)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      {data.length > 0 && (
        <circle
          cx={width}
          cy={height - (data[data.length - 1] / max) * height}
          r="2.5"
          fill="var(--color-accent)"
        />
      )}
    </svg>
  );
}

export const AgentNode = memo(({ data, selected }: NodeProps & { data: AgentNodeData }) => {
  const nodeData = data as AgentNodeData;
  const status = nodeData.status || "draft";
  const activity = nodeData.activity || [3, 5, 8, 4, 7, 12, 9, 6, 11, 8];
  const cfg = statusConfig[status] || statusConfig.draft;
  const sparklineId = useId();

  const statusStrip = status === "online" ? "bg-status-live" : status === "error" ? "bg-status-error" : status === "deploying" ? "bg-status-warning" : "bg-border-default";

  return (
    <BaseNode
      accentColor="accent"
      selectedShadow="shadow-[var(--shadow-node)]"
      stripColor={statusStrip}
      selected={selected}
      widthClasses="min-w-[240px] max-w-[280px]"
    >
      {/* Header */}
      <div className="px-3.5 pt-3.5 pb-2 flex items-start justify-between gap-2">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className={`w-8 h-8 rounded-lg ${cfg.bg} flex items-center justify-center flex-shrink-0 ${cfg.glow}`}>
            <Bot size={16} className="text-accent" />
          </div>
          <div className="min-w-0">
            <div className="text-[length:var(--text-base)] font-semibold text-text-primary leading-tight truncate">
              {nodeData.name}
            </div>
            <div className="text-[length:var(--text-2xs)] text-text-muted mt-0.5 font-mono">{nodeData.model}</div>
          </div>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0 mt-1">
          <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot} ${status === "online" ? "animate-pulse" : ""}`} />
          <span className="text-[length:var(--text-2xs)] font-semibold tracking-wider text-text-muted uppercase">
            {cfg.label}
          </span>
        </div>
      </div>

      {/* Sparkline + Metrics */}
      <div className="px-3.5 pb-2.5">
        <div className="flex items-end justify-between gap-4">
          <div>
            <MiniSparkline data={activity} instanceId={sparklineId} />
            <div className="text-[length:var(--text-2xs)] text-text-muted mt-1 tracking-wider uppercase">24h activity</div>
          </div>
          <div className="text-right">
            {nodeData.efficiency !== undefined && (
              <>
                <div className="text-[length:var(--text-lg)] font-bold text-accent leading-none">{nodeData.efficiency}%</div>
                <div className="text-[length:var(--text-2xs)] text-text-muted tracking-wider uppercase mt-0.5">efficiency</div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Footer: tools + quick actions */}
      <div className="px-3.5 pb-3 flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Zap size={10} className="text-text-muted" />
          <span className="text-[length:var(--text-2xs)] text-text-muted">
            {nodeData.tools?.length || 0} tools
          </span>
        </div>
        {status === "online" && (nodeData as any).onRun && (
          <button
            className="flex items-center gap-1 min-h-[var(--touch-target-min)] text-[length:var(--text-2xs)] text-accent hover:text-accent-hover transition-colors"
            onClick={(e) => {
              e.stopPropagation();
              (nodeData as any).onRun?.();
            }}
            aria-label={`Run agent ${nodeData.name}`}
          >
            <Play size={9} fill="currentColor" />
            <span className="font-medium">Run</span>
            <ChevronRight size={10} />
          </button>
        )}
      </div>
    </BaseNode>
  );
});

AgentNode.displayName = "AgentNode";
