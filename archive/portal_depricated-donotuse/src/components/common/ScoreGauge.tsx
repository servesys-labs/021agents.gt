/* ── Types ──────────────────────────────────────────────────────── */

export interface ScoreGaugeProps {
  /** Score from 0 to 10 */
  score: number;
  size?: "sm" | "md" | "lg";
  /** Show "3.2/10" text next to the bar */
  showLabel?: boolean;
  className?: string;
}

/* ── Helpers ─────────────────────────────────────────────────────── */

function scoreBarColor(score: number): string {
  if (score >= 7) return "bg-status-error";
  if (score >= 4) return "bg-status-warning";
  return "bg-status-live";
}

function scoreTextColor(score: number): string {
  if (score >= 7) return "text-status-error";
  if (score >= 4) return "text-status-warning";
  return "text-status-live";
}

/* ── Size presets ─────────────────────────────────────────────────── */

const sizeClasses = {
  sm: { bar: "w-12 h-1.5", text: "text-[10px]" },
  md: { bar: "w-16 h-2", text: "text-xs" },
  lg: { bar: "w-20 h-2", text: "text-sm" },
} as const;

/* ── Component ──────────────────────────────────────────────────── */

export function ScoreGauge({
  score,
  size = "lg",
  showLabel = true,
  className = "",
}: ScoreGaugeProps) {
  const pct = Math.min(100, (score / 10) * 100);
  const s = sizeClasses[size];

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <div
        className={`${s.bar} bg-surface-overlay rounded-full overflow-hidden`}
      >
        <div
          className={`h-full rounded-full ${scoreBarColor(score)}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      {showLabel && (
        <span
          className={`font-mono font-semibold ${scoreTextColor(score)} ${s.text}`}
        >
          {score.toFixed(1)}
        </span>
      )}
    </div>
  );
}
