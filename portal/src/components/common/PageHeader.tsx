import type { ReactNode } from "react";
import { RefreshCw } from "lucide-react";

interface PageHeaderProps {
  title: string;
  subtitle?: string;
  description?: string;
  icon?: ReactNode;
  actions?: ReactNode;
  liveCount?: number;
  liveLabel?: string;
  onRefresh?: () => void;
}

export function PageHeader({
  title,
  subtitle,
  description,
  icon,
  actions,
  liveCount,
  liveLabel,
  onRefresh,
}: PageHeaderProps) {
  const subtitleText = subtitle ?? description;
  return (
    <div className="flex items-start justify-between mb-6">
      <div>
        <h1 className="text-lg font-bold text-text-primary uppercase tracking-wide flex items-center gap-2">
          {icon && <span className="text-text-muted">{icon}</span>}
          {title}
        </h1>
        {subtitleText && (
          <p className="mt-1 text-sm text-text-muted">{subtitleText}</p>
        )}
      </div>
      <div className="flex items-center gap-3">
        {onRefresh && (
          <button
            onClick={onRefresh}
            className="p-2 rounded-md text-text-muted hover:bg-surface-overlay hover:text-text-secondary transition-colors"
            title="Refresh"
          >
            <RefreshCw size={14} />
          </button>
        )}
        {liveCount !== undefined && (
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-surface-raised border border-border-default">
            <span className="badge-live" style={{ padding: "2px 8px", fontSize: "10px" }}>
              LIVE
            </span>
            <span className="text-xs font-semibold text-text-primary font-mono">
              {liveCount}
            </span>
            <span className="text-xs text-text-muted uppercase">
              {liveLabel || "Active"}
            </span>
          </div>
        )}
        {actions}
      </div>
    </div>
  );
}
