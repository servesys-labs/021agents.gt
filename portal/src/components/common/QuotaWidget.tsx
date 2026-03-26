import { useApiQuery } from "../../lib/api";

type QuotaData = {
  used: number;
  limit: number;
  unit?: string;
};

/**
 * Quota usage indicator. Supports three variants:
 * - default: compact icon-rail style for sidebar
 * - compact: minimal bar only
 * - card: wider dashboard-style with labels
 */
export function QuotaWidget({ compact = false, variant = "default" }: { compact?: boolean; variant?: "default" | "compact" | "card" }) {
  const quotaQuery = useApiQuery<QuotaData>("/api/v1/billing/quota");
  const quota = quotaQuery.data;

  if (!quota || quotaQuery.loading) return null;

  const pct = quota.limit > 0 ? Math.min(100, (quota.used / quota.limit) * 100) : 0;
  const isWarning = pct >= 80;
  const isCritical = pct >= 95;

  const barColor = isCritical
    ? "bg-status-error"
    : isWarning
      ? "bg-status-warning"
      : "bg-accent";

  const unit = quota.unit ?? "credits";

  /* Card variant for dashboard */
  if (variant === "card") {
    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between text-xs">
          <span className="text-text-secondary">{quota.used.toLocaleString()} / {quota.limit.toLocaleString()} {unit}</span>
          <span className={`font-mono font-semibold ${isCritical ? "text-status-error" : isWarning ? "text-status-warning" : "text-text-primary"}`}>
            {Math.round(pct)}%
          </span>
        </div>
        <div className="h-2 rounded-full bg-surface-overlay overflow-hidden">
          <div className={`h-full rounded-full ${barColor} transition-all`} style={{ width: `${pct}%` }} />
        </div>
        {isCritical && (
          <p className="text-[10px] text-status-error">Approaching quota limit. Consider upgrading your plan.</p>
        )}
      </div>
    );
  }

  /* Compact variant: bar only */
  if (compact) {
    return (
      <div className="w-11 px-1.5" title={`${quota.used} / ${quota.limit} ${unit} used`}>
        <div className="h-1 rounded-full bg-surface-overlay overflow-hidden">
          <div className={`h-full rounded-full ${barColor} transition-all`} style={{ width: `${pct}%` }} />
        </div>
      </div>
    );
  }

  /* Default: sidebar icon-rail style */
  return (
    <div className="w-11 flex flex-col items-center gap-0.5 group relative" title={`${quota.used} / ${quota.limit} ${unit}`}>
      <div className="w-7 h-1 rounded-full bg-surface-overlay overflow-hidden">
        <div className={`h-full rounded-full ${barColor} transition-all`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[8px] text-text-muted font-mono">{Math.round(pct)}%</span>
      {/* Tooltip */}
      <span className="absolute left-full ml-2 px-2 py-1 rounded-md bg-surface-overlay text-text-primary text-[11px] whitespace-nowrap opacity-0 pointer-events-none group-hover:opacity-100 transition-opacity z-50 shadow-dropdown border border-border-default">
        {quota.used} / {quota.limit} {unit}
      </span>
    </div>
  );
}
