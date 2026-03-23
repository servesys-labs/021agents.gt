import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Database, Wifi, WifiOff } from "lucide-react";

export type DataSourceNodeData = {
  name: string;
  type: "postgres" | "mysql" | "snowflake" | "mongodb" | "bigquery" | "redis" | string;
  status: "connected" | "disconnected" | "error";
  tableCount?: number;
};

const statusConfig: Record<string, { dot: string; label: string; icon: typeof Wifi }> = {
  connected: { dot: "bg-status-live", label: "CONNECTED", icon: Wifi },
  disconnected: { dot: "bg-text-muted", label: "DISCONNECTED", icon: WifiOff },
  error: { dot: "bg-status-error", label: "ERROR", icon: WifiOff },
};

const dbLabels: Record<string, string> = {
  postgres: "PostgreSQL",
  mysql: "MySQL",
  snowflake: "Snowflake",
  mongodb: "MongoDB",
  bigquery: "BigQuery",
  redis: "Redis",
};

export const DataSourceNode = memo(({ data, selected }: NodeProps & { data: DataSourceNodeData }) => {
  const nodeData = data as DataSourceNodeData;
  const status = nodeData.status || "disconnected";
  const cfg = statusConfig[status] || statusConfig.disconnected;
  const dbLabel = dbLabels[nodeData.type] || nodeData.type;

  return (
    <div
      className={`
        relative min-w-[190px] max-w-[220px] rounded-xl border transition-all duration-200
        ${selected
          ? "border-chart-cyan shadow-[0_0_20px_rgba(6,182,212,0.2)]"
          : "border-border-default hover:border-border-strong"
        }
      `}
      style={{ background: 'rgba(28, 25, 23, 0.82)', backdropFilter: 'blur(20px) saturate(1.5)', WebkitBackdropFilter: 'blur(20px) saturate(1.5)' }}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!w-2.5 !h-2.5 !bg-surface-overlay !border-2 !border-chart-cyan !-left-[5px] hover:!bg-chart-cyan transition-colors"
      />
      <Handle
        type="source"
        position={Position.Right}
        className="!w-2.5 !h-2.5 !bg-surface-overlay !border-2 !border-chart-cyan !-right-[5px] hover:!bg-chart-cyan transition-colors"
      />

      {/* Cyan accent strip */}
      <div className="absolute top-0 left-4 right-4 h-[2px] rounded-b bg-chart-cyan opacity-60" />

      <div className="px-3.5 py-3 flex items-start gap-2.5">
        <div className="w-8 h-8 rounded-lg bg-[rgba(6,182,212,0.1)] flex items-center justify-center flex-shrink-0">
          <Database size={15} className="text-chart-cyan" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold text-text-primary leading-tight truncate">
            {nodeData.name}
          </div>
          <div className="text-[10px] text-text-muted mt-0.5 font-mono">{dbLabel}</div>
          <div className="flex items-center gap-1.5 mt-1.5">
            <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
            <span className="text-[10px] text-text-muted">{cfg.label}</span>
            {nodeData.tableCount !== undefined && (
              <span className="text-[10px] text-text-muted ml-1">&middot; {nodeData.tableCount} tables</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
});

DataSourceNode.displayName = "DataSourceNode";
