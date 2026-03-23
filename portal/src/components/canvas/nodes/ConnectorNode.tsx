import { memo } from "react";
import { type NodeProps } from "@xyflow/react";
import { Plug, Zap, Shield } from "lucide-react";
import { BaseNode } from "./BaseNode";

export type ConnectorNodeData = {
  name: string;
  app: string;
  status: "authenticated" | "pending" | "error";
  toolCount: number;
};

const statusConfig: Record<string, { dot: string; label: string }> = {
  authenticated: { dot: "bg-status-live", label: "AUTHED" },
  pending: { dot: "bg-status-warning", label: "PENDING" },
  error: { dot: "bg-status-error", label: "ERROR" },
};

export const ConnectorNode = memo(({ data, selected }: NodeProps & { data: ConnectorNodeData }) => {
  const nodeData = data as ConnectorNodeData;
  const status = nodeData.status || "pending";
  const cfg = statusConfig[status] || statusConfig.pending;

  return (
    <BaseNode
      accentColor="chart-green"
      selectedShadow="shadow-[var(--shadow-node)]"
      stripColor="bg-chart-green"
      selected={selected}
    >
      <div className="px-3.5 py-3 flex items-start gap-2.5">
        <div className="w-8 h-8 rounded-lg bg-node-glow-green-strong flex items-center justify-center flex-shrink-0">
          <Plug size={15} className="text-chart-green" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[length:var(--text-base)] font-semibold text-text-primary leading-tight truncate">
            {nodeData.name}
          </div>
          <div className="text-[length:var(--text-2xs)] text-text-muted mt-0.5">{nodeData.app}</div>
          <div className="flex items-center gap-2 mt-1.5">
            <div className="flex items-center gap-1">
              <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
              <span className="text-[length:var(--text-2xs)] text-text-muted">{cfg.label}</span>
            </div>
            {nodeData.toolCount > 0 && (
              <div className="flex items-center gap-1">
                <Zap size={9} className="text-text-muted" />
                <span className="text-[length:var(--text-2xs)] text-text-muted">{nodeData.toolCount} tools</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* OAuth badge for pending */}
      {status === "pending" && (
        <div className="px-3.5 pb-2.5">
          <button
            className="flex items-center gap-1.5 px-2 py-1 min-h-[var(--touch-target-min)] rounded-md bg-node-glow-green border border-node-glow-green-border text-[length:var(--text-2xs)] text-chart-green transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            disabled
            title="Coming soon"
            aria-label="Connect OAuth — coming soon"
            onClick={(e) => e.stopPropagation()}
          >
            <Shield size={10} />
            <span className="font-medium">Connect OAuth</span>
          </button>
        </div>
      )}
    </BaseNode>
  );
});

ConnectorNode.displayName = "ConnectorNode";
