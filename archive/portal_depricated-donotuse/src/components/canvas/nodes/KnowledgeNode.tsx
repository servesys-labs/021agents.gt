import { memo } from "react";
import { type NodeProps } from "@xyflow/react";
import { FileText, Upload } from "lucide-react";
import { BaseNode } from "./BaseNode";

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
    <BaseNode
      accentColor="chart-purple"
      selectedShadow="shadow-[var(--shadow-node)]"
      stripColor="bg-chart-purple"
      selected={selected}
    >
      <div className="px-3.5 py-3 flex items-start gap-2.5">
        <div className="w-8 h-8 rounded-lg bg-node-glow-purple flex items-center justify-center flex-shrink-0">
          <FileText size={15} className="text-chart-purple" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[length:var(--text-base)] font-semibold text-text-primary leading-tight truncate">
            {nodeData.name}
          </div>
          <div className="flex items-center gap-1.5 mt-1.5">
            <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot} ${status === "ingesting" ? "animate-pulse" : ""}`} />
            <span className="text-[length:var(--text-2xs)] text-text-muted">{cfg.label}</span>
          </div>
        </div>
      </div>

      {/* Stats row */}
      <div className="px-3.5 pb-3 flex items-center gap-3">
        <div className="flex items-center gap-1">
          <Upload size={9} className="text-text-muted" />
          <span className="text-[length:var(--text-2xs)] text-text-muted">{nodeData.docCount} docs</span>
        </div>
        <span className="text-[length:var(--text-2xs)] text-text-muted">{nodeData.totalSize}</span>
        {nodeData.chunkCount !== undefined && (
          <span className="text-[length:var(--text-2xs)] text-text-muted">{nodeData.chunkCount} chunks</span>
        )}
      </div>
    </BaseNode>
  );
});

KnowledgeNode.displayName = "KnowledgeNode";
