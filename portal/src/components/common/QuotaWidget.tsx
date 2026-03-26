import { Link } from "react-router-dom";
import { Zap, Bot, HardDrive, ArrowUpRight } from "lucide-react";

/* ── Types ──────────────────────────────────────────────────────── */

interface QuotaItem {
  label: string;
  icon: React.ReactNode;
  used: number;
  limit: number;
  unit?: string;
}

interface QuotaWidgetProps {
  apiCalls: { used: number; limit: number };
  agents: { used: number; limit: number };
  storage: { used: number; limit: number; unit?: string };
  className?: string;
}

/* ── Helpers ─────────────────────────────────────────────────────── */

function getPercentage(used: number, limit: number): number {
  if (limit <= 0) return 0;
  return Math.min(Math.round((used / limit) * 100), 100);
}

function getBarColor(pct: number): string {
  if (pct >= 90) return "bg-status-error";
  if (pct >= 75) return "bg-status-warning";
  return "bg-status-live";
}

function getBarTrackAccent(pct: number): string {
  if (pct >= 90) return "bg-status-error/10";
  if (pct >= 75) return "bg-status-warning/10";
  return "bg-status-live/10";
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

/* ── Component ──────────────────────────────────────────────────── */

export function QuotaWidget({
  apiCalls,
  agents,
  storage,
  className = "",
}: QuotaWidgetProps) {
  const quotas: QuotaItem[] = [
    {
      label: "API Calls",
      icon: <Zap size={14} />,
      used: apiCalls.used,
      limit: apiCalls.limit,
    },
    {
      label: "Agents",
      icon: <Bot size={14} />,
      used: agents.used,
      limit: agents.limit,
    },
    {
      label: "Storage",
      icon: <HardDrive size={14} />,
      used: storage.used,
      limit: storage.limit,
      unit: storage.unit ?? "MB",
    },
  ];

  const nearLimit = quotas.some(
    (q) => getPercentage(q.used, q.limit) >= 75,
  );

  return (
    <div
      className={`card glass-light ${className}`}
      role="region"
      aria-label="Quota usage"
    >
      <div className="flex items-center justify-between mb-[var(--space-4)]">
        <h3 className="text-[var(--text-xs)] font-semibold text-text-muted uppercase tracking-wide">
          Usage
        </h3>
        {nearLimit && (
          <Link
            to="/billing/pricing"
            className="inline-flex items-center gap-[var(--space-1)] text-[10px] font-semibold text-accent hover:text-accent-hover transition-colors min-h-[var(--touch-target-min)] px-[var(--space-2)]"
          >
            Upgrade
            <ArrowUpRight size={10} />
          </Link>
        )}
      </div>

      <div className="space-y-[var(--space-4)]">
        {quotas.map((quota) => {
          const pct = getPercentage(quota.used, quota.limit);
          const barColor = getBarColor(pct);
          const trackAccent = getBarTrackAccent(pct);

          return (
            <div key={quota.label}>
              <div className="flex items-center justify-between mb-[var(--space-1)]">
                <div className="flex items-center gap-[var(--space-2)] text-[var(--text-xs)] text-text-secondary">
                  <span className="text-text-muted">{quota.icon}</span>
                  {quota.label}
                </div>
                <span className="text-[var(--text-xs)] text-text-muted font-mono">
                  {formatNumber(quota.used)}
                  <span className="text-text-muted/60"> / </span>
                  {formatNumber(quota.limit)}
                  {quota.unit ? ` ${quota.unit}` : ""}
                </span>
              </div>
              <div
                className={`progress-track h-1.5 ${trackAccent}`}
                role="progressbar"
                aria-valuenow={pct}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={`${quota.label}: ${pct}% used`}
              >
                <div
                  className={`h-full rounded-full transition-all duration-300 ${barColor}`}
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export { QuotaWidget as default };
