import { memo } from "react";
import { Handle, Position, useNodeConnections, type NodeProps } from "@xyflow/react";
import { Bot, Zap, Play, ChevronRight } from "lucide-react";

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
    bg: "bg-[rgba(34,197,94,0.08)]",
    dot: "bg-status-live",
    label: "LIVE",
    glow: "shadow-[0_0_8px_rgba(34,197,94,0.3)]",
  },
  deploying: {
    bg: "bg-[rgba(234,179,8,0.08)]",
    dot: "bg-status-warning",
    label: "DEPLOYING",
    glow: "",
  },
  error: {
    bg: "bg-[rgba(239,68,68,0.08)]",
    dot: "bg-status-error",
    label: "ERROR",
    glow: "",
  },
  draft: {
    bg: "bg-[rgba(120,113,108,0.08)]",
    dot: "bg-text-muted",
    label: "DRAFT",
    glow: "",
  },
};

function MiniSparkline({ data }: { data: number[] }) {
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

  return (
    <svg width={width} height={height} className="overflow-visible">
      <defs>
        <linearGradient id="sparkline-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--color-accent)" stopOpacity="0.2" />
          <stop offset="100%" stopColor="var(--color-accent)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={areaD} fill="url(#sparkline-fill)" />
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

  const sourceConns = useNodeConnections({ handleType: "source" });
  const targetConns = useNodeConnections({ handleType: "target" });
  const hideHandles = !!(data as any).hideHandles;
  const hasSource = !hideHandles && sourceConns.length > 0;
  const hasTarget = !hideHandles && targetConns.length > 0;

  return (
    <div
      className={`
        relative min-w-[240px] max-w-[280px] rounded-xl border transition-all duration-200
        ${selected
          ? "border-accent shadow-[0_0_24px_rgba(249,115,22,0.2)]"
          : "border-border-default hover:border-border-strong"
        }
        bg-glass-heavy backdrop-blur-[20px] backdrop-saturate-[1.5]
      `}
      style={{ background: 'rgba(28, 25, 23, 0.45)', backdropFilter: 'blur(40px) saturate(1.8)', WebkitBackdropFilter: 'blur(40px) saturate(1.8)' }}
    >
      {/* Connection handles — only visible when connected */}
      <Handle
        type="target"
        position={Position.Left}
        className={`!w-2.5 !h-2.5 !border-2 !border-accent !-left-[5px] transition-all ${
          hasTarget ? "!bg-surface-overlay hover:!bg-accent !opacity-100" : "!opacity-0 !pointer-events-none"
        }`}
      />
      <Handle
        type="source"
        position={Position.Right}
        className={`!w-2.5 !h-2.5 !border-2 !border-accent !-right-[5px] transition-all ${
          hasSource ? "!bg-surface-overlay hover:!bg-accent !opacity-100" : "!opacity-0 !pointer-events-none"
        }`}
      />

      {/* Status indicator strip */}
      <div className={`absolute top-0 left-4 right-4 h-[2px] rounded-b ${status === "online" ? "bg-status-live" : status === "error" ? "bg-status-error" : status === "deploying" ? "bg-status-warning" : "bg-border-default"}`} />

      {/* Header */}
      <div className="px-3.5 pt-3.5 pb-2 flex items-start justify-between gap-2">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className={`w-8 h-8 rounded-lg ${cfg.bg} flex items-center justify-center flex-shrink-0 ${cfg.glow}`}>
            <Bot size={16} className="text-accent" />
          </div>
          <div className="min-w-0">
            <div className="text-[13px] font-semibold text-text-primary leading-tight truncate">
              {nodeData.name}
            </div>
            <div className="text-[10px] text-text-muted mt-0.5 font-mono">{nodeData.model}</div>
          </div>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0 mt-1">
          <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot} ${status === "online" ? "animate-pulse" : ""}`} />
          <span className="text-[9px] font-semibold tracking-wider text-text-muted uppercase">
            {cfg.label}
          </span>
        </div>
      </div>

      {/* Sparkline + Metrics */}
      <div className="px-3.5 pb-2.5">
        <div className="flex items-end justify-between gap-4">
          <div>
            <MiniSparkline data={activity} />
            <div className="text-[9px] text-text-muted mt-1 tracking-wider uppercase">24h activity</div>
          </div>
          <div className="text-right">
            {nodeData.efficiency !== undefined && (
              <>
                <div className="text-[18px] font-bold text-accent leading-none">{nodeData.efficiency}%</div>
                <div className="text-[9px] text-text-muted tracking-wider uppercase mt-0.5">efficiency</div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Footer: tools + quick actions */}
      <div className="px-3.5 pb-3 flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Zap size={10} className="text-text-muted" />
          <span className="text-[10px] text-text-muted">
            {nodeData.tools?.length || 0} tools
          </span>
        </div>
        {status === "online" && (
          <button
            className="flex items-center gap-1 text-[10px] text-accent hover:text-accent-hover transition-colors"
            onClick={(e) => e.stopPropagation()}
          >
            <Play size={9} fill="currentColor" />
            <span className="font-medium">Run</span>
            <ChevronRight size={10} />
          </button>
        )}
      </div>
    </div>
  );
});

AgentNode.displayName = "AgentNode";
