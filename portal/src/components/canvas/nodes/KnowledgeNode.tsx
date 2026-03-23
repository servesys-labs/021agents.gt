import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { FileText, Upload } from "lucide-react";

export type KnowledgeNodeData = {
  name: string;
  docCount: number;
  totalSize: string;
  status: "ready" | "ingesting" | "error" | "empty";
  chunkCount?: number;
};

const statusConfig: Record<string, { dot: string; label: string }> = {
  ready: { dot: "bg-status-live", label: "READY" },
  ingesting: { dot: "bg-status-warning", label: "INGESTING" },
  error: { dot: "bg-status-error", label: "ERROR" },
  empty: { dot: "bg-text-muted", label: "EMPTY" },
};

export const KnowledgeNode = memo(({ data, selected }: NodeProps & { data: KnowledgeNodeData }) => {
  const nodeData = data as KnowledgeNodeData;
  const status = nodeData.status || "empty";
  const cfg = statusConfig[status] || statusConfig.empty;

  return (
    <div
      className={`
        relative min-w-[190px] max-w-[220px] rounded-xl border transition-all duration-200
        ${selected
          ? "border-chart-purple shadow-[0_0_20px_rgba(168,85,247,0.2)]"
          : "border-border-default hover:border-border-strong"
        }
      `}
      style={{ background: 'rgba(28, 25, 23, 0.82)', backdropFilter: 'blur(20px) saturate(1.5)', WebkitBackdropFilter: 'blur(20px) saturate(1.5)' }}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!w-2.5 !h-2.5 !bg-surface-overlay !border-2 !border-chart-purple !-left-[5px] hover:!bg-chart-purple transition-colors"
      />
      <Handle
        type="source"
        position={Position.Right}
        className="!w-2.5 !h-2.5 !bg-surface-overlay !border-2 !border-chart-purple !-right-[5px] hover:!bg-chart-purple transition-colors"
      />

      {/* Purple accent strip */}
      <div className="absolute top-0 left-4 right-4 h-[2px] rounded-b bg-chart-purple opacity-60" />

      <div className="px-3.5 py-3 flex items-start gap-2.5">
        <div className="w-8 h-8 rounded-lg bg-[rgba(168,85,247,0.1)] flex items-center justify-center flex-shrink-0">
          <FileText size={15} className="text-chart-purple" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold text-text-primary leading-tight truncate">
            {nodeData.name}
          </div>
          <div className="flex items-center gap-1.5 mt-1.5">
            <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot} ${status === "ingesting" ? "animate-pulse" : ""}`} />
            <span className="text-[10px] text-text-muted">{cfg.label}</span>
          </div>
        </div>
      </div>

      {/* Stats row */}
      <div className="px-3.5 pb-3 flex items-center gap-3">
        <div className="flex items-center gap-1">
          <Upload size={9} className="text-text-muted" />
          <span className="text-[10px] text-text-muted">{nodeData.docCount} docs</span>
        </div>
        <span className="text-[10px] text-text-muted">{nodeData.totalSize}</span>
        {nodeData.chunkCount !== undefined && (
          <span className="text-[10px] text-text-muted">{nodeData.chunkCount} chunks</span>
        )}
      </div>
    </div>
  );
});

KnowledgeNode.displayName = "KnowledgeNode";
