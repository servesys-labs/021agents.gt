import { memo } from "react";
import { type NodeProps } from "@xyflow/react";
import { Database, Wifi, WifiOff } from "lucide-react";
import { BaseNode } from "./BaseNode";

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
    <BaseNode
      accentColor="chart-cyan"
      selectedShadow="shadow-[var(--shadow-node)]"
      stripColor="bg-chart-cyan"
      selected={selected}
    >
      <div className="px-3.5 py-3 flex items-start gap-2.5">
        <div className="w-8 h-8 rounded-lg bg-node-glow-cyan flex items-center justify-center flex-shrink-0">
          <Database size={15} className="text-chart-cyan" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[length:var(--text-base)] font-semibold text-text-primary leading-tight truncate">
            {nodeData.name}
          </div>
          <div className="text-[length:var(--text-2xs)] text-text-muted mt-0.5 font-mono">{dbLabel}</div>
          <div className="flex items-center gap-1.5 mt-1.5">
            <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
            <span className="text-[length:var(--text-2xs)] text-text-muted">{cfg.label}</span>
            {nodeData.tableCount !== undefined && (
              <span className="text-[length:var(--text-2xs)] text-text-muted ml-1">&middot; {nodeData.tableCount} tables</span>
            )}
          </div>
        </div>
      </div>
    </BaseNode>
  );
});

DataSourceNode.displayName = "DataSourceNode";
