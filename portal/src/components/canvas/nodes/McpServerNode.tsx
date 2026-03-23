import { memo } from "react";
import { type NodeProps } from "@xyflow/react";
import { Server, Zap, RefreshCw } from "lucide-react";
import { BaseNode } from "./BaseNode";

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
    <BaseNode
      accentColor="chart-blue"
      selectedShadow="shadow-[var(--shadow-node)]"
      stripColor="bg-chart-blue"
      selected={selected}
      widthClasses="min-w-[190px] max-w-[240px]"
    >
      <div className="px-3.5 py-3 flex items-start gap-2.5">
        <div className="w-8 h-8 rounded-lg bg-node-glow-blue flex items-center justify-center flex-shrink-0">
          <Server size={15} className="text-chart-blue" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[length:var(--text-base)] font-semibold text-text-primary leading-tight truncate">
            {nodeData.name}
          </div>
          <div className="text-[length:var(--text-2xs)] text-text-muted mt-0.5 font-mono truncate max-w-[140px]">
            {nodeData.url}
          </div>
          <div className="flex items-center gap-2 mt-1.5">
            <div className="flex items-center gap-1">
              <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
              <span className="text-[length:var(--text-2xs)] text-text-muted">{cfg.label}</span>
            </div>
            {nodeData.toolCount > 0 && (
              <div className="flex items-center gap-1">
                <Zap size={9} className="text-text-muted" />
                <span className="text-[length:var(--text-2xs)] text-text-muted">{nodeData.toolCount}</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Sync button for healthy servers */}
      {status === "healthy" && (
        <div className="px-3.5 pb-2.5">
          <button
            className="flex items-center gap-1.5 min-h-[var(--touch-target-min)] text-[length:var(--text-2xs)] text-chart-blue transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            disabled
            title="Coming soon"
            aria-label="Sync Tools — coming soon"
            onClick={(e) => e.stopPropagation()}
          >
            <RefreshCw size={9} />
            <span className="font-medium">Sync Tools</span>
          </button>
        </div>
      )}
    </BaseNode>
  );
});

McpServerNode.displayName = "McpServerNode";
