import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Server, Zap, RefreshCw } from "lucide-react";

export type McpServerNodeData = {
  name: string;
  url: string;
  status: "healthy" | "degraded" | "offline";
  toolCount: number;
  lastSync?: string;
};

const statusConfig: Record<string, { dot: string; label: string }> = {
  healthy: { dot: "bg-status-live", label: "HEALTHY" },
  degraded: { dot: "bg-status-warning", label: "DEGRADED" },
  offline: { dot: "bg-status-error", label: "OFFLINE" },
};

export const McpServerNode = memo(({ data, selected }: NodeProps & { data: McpServerNodeData }) => {
  const nodeData = data as McpServerNodeData;
  const status = nodeData.status || "offline";
  const cfg = statusConfig[status] || statusConfig.offline;

  return (
    <div
      className={`
        relative min-w-[190px] max-w-[240px] rounded-xl border transition-all duration-200
        ${selected
          ? "border-chart-blue shadow-[0_0_20px_rgba(59,130,246,0.2)]"
          : "border-border-default hover:border-border-strong"
        }
      `}
      style={{ background: 'rgba(28, 25, 23, 0.82)', backdropFilter: 'blur(20px) saturate(1.5)', WebkitBackdropFilter: 'blur(20px) saturate(1.5)' }}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!w-2.5 !h-2.5 !bg-surface-overlay !border-2 !border-chart-blue !-left-[5px] hover:!bg-chart-blue transition-colors"
      />
      <Handle
        type="source"
        position={Position.Right}
        className="!w-2.5 !h-2.5 !bg-surface-overlay !border-2 !border-chart-blue !-right-[5px] hover:!bg-chart-blue transition-colors"
      />

      {/* Blue accent strip */}
      <div className="absolute top-0 left-4 right-4 h-[2px] rounded-b bg-chart-blue opacity-60" />

      <div className="px-3.5 py-3 flex items-start gap-2.5">
        <div className="w-8 h-8 rounded-lg bg-[rgba(59,130,246,0.1)] flex items-center justify-center flex-shrink-0">
          <Server size={15} className="text-chart-blue" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold text-text-primary leading-tight truncate">
            {nodeData.name}
          </div>
          <div className="text-[10px] text-text-muted mt-0.5 font-mono truncate max-w-[140px]">
            {nodeData.url}
          </div>
          <div className="flex items-center gap-2 mt-1.5">
            <div className="flex items-center gap-1">
              <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
              <span className="text-[10px] text-text-muted">{cfg.label}</span>
            </div>
            {nodeData.toolCount > 0 && (
              <div className="flex items-center gap-1">
                <Zap size={9} className="text-text-muted" />
                <span className="text-[10px] text-text-muted">{nodeData.toolCount}</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Sync button for healthy servers */}
      {status === "healthy" && (
        <div className="px-3.5 pb-2.5">
          <button
            className="flex items-center gap-1.5 text-[10px] text-chart-blue hover:text-blue-400 transition-colors"
            onClick={(e) => e.stopPropagation()}
          >
            <RefreshCw size={9} />
            <span className="font-medium">Sync Tools</span>
          </button>
        </div>
      )}
    </div>
  );
});

McpServerNode.displayName = "McpServerNode";
