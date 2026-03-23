import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Plug, Zap, Shield } from "lucide-react";

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
    <div
      className={`
        relative min-w-[190px] max-w-[220px] rounded-xl border transition-all duration-200
        ${selected
          ? "border-chart-green shadow-[0_0_20px_rgba(34,197,94,0.2)]"
          : "border-border-default hover:border-border-strong"
        }
      `}
      style={{ background: 'rgba(28, 25, 23, 0.45)', backdropFilter: 'blur(40px) saturate(1.8)', WebkitBackdropFilter: 'blur(40px) saturate(1.8)' }}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!w-2.5 !h-2.5 !bg-surface-overlay !border-2 !border-chart-green !-left-[5px] hover:!bg-chart-green transition-colors"
      />
      <Handle
        type="source"
        position={Position.Right}
        className="!w-2.5 !h-2.5 !bg-surface-overlay !border-2 !border-chart-green !-right-[5px] hover:!bg-chart-green transition-colors"
      />

      {/* Green accent strip */}
      <div className="absolute top-0 left-4 right-4 h-[2px] rounded-b bg-chart-green opacity-60" />

      <div className="px-3.5 py-3 flex items-start gap-2.5">
        <div className="w-8 h-8 rounded-lg bg-[rgba(34,197,94,0.1)] flex items-center justify-center flex-shrink-0">
          <Plug size={15} className="text-chart-green" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold text-text-primary leading-tight truncate">
            {nodeData.name}
          </div>
          <div className="text-[10px] text-text-muted mt-0.5">{nodeData.app}</div>
          <div className="flex items-center gap-2 mt-1.5">
            <div className="flex items-center gap-1">
              <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
              <span className="text-[10px] text-text-muted">{cfg.label}</span>
            </div>
            {nodeData.toolCount > 0 && (
              <div className="flex items-center gap-1">
                <Zap size={9} className="text-text-muted" />
                <span className="text-[10px] text-text-muted">{nodeData.toolCount} tools</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* OAuth badge for pending */}
      {status === "pending" && (
        <div className="px-3.5 pb-2.5">
          <button
            className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-[rgba(34,197,94,0.08)] border border-[rgba(34,197,94,0.2)] text-[10px] text-chart-green hover:bg-[rgba(34,197,94,0.15)] transition-colors"
            onClick={(e) => e.stopPropagation()}
          >
            <Shield size={10} />
            <span className="font-medium">Connect OAuth</span>
          </button>
        </div>
      )}
    </div>
  );
});

ConnectorNode.displayName = "ConnectorNode";
