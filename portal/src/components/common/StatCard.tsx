import type React from "react";

/* ── Types ──────────────────────────────────────────────────────── */

export interface StatCardProps {
  label: string;
  value: string | number;
  icon: React.ReactNode;
  /** Tailwind bg class for icon wrapper, e.g. "bg-accent/10" */
  color?: string;
  /** Tailwind text class for the icon, e.g. "text-accent" */
  iconColor?: string;
  onClick?: () => void;
  trend?: { direction: "up" | "down" | "flat"; label: string };
  className?: string;
  style?: React.CSSProperties;
}

/* ── Component ──────────────────────────────────────────────────── */

export function StatCard({
  label,
  value,
  icon,
  color = "bg-accent/10",
  iconColor = "text-accent",
  onClick,
  trend,
  className = "",
  style,
}: StatCardProps) {
  const isClickable = !!onClick;

  return (
    <div
      role={isClickable ? "button" : undefined}
      tabIndex={isClickable ? 0 : undefined}
      onClick={onClick}
      style={style}
      onKeyDown={
        isClickable
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onClick?.();
              }
            }
          : undefined
      }
      className={[
        "card flex items-center gap-3 py-3",
        isClickable &&
          "cursor-pointer hover:border-accent/40 transition-colors min-h-[44px]",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {/* Icon */}
      <div className={`p-2 rounded-lg ${color}`}>{icon}</div>

      {/* Value + label */}
      <div>
        <p className="text-xl font-bold text-text-primary font-mono">
          {typeof value === "number" ? value.toLocaleString() : value}
        </p>
        <p className="text-[10px] text-text-muted uppercase tracking-wide">
          {label}
        </p>
        {trend && (
          <p
            className={`text-[10px] mt-0.5 ${
              trend.direction === "up"
                ? "text-status-live"
                : trend.direction === "down"
                  ? "text-status-error"
                  : "text-text-muted"
            }`}
          >
            {trend.direction === "up"
              ? "\u2191"
              : trend.direction === "down"
                ? "\u2193"
                : "\u2192"}{" "}
            {trend.label}
          </p>
        )}
      </div>
    </div>
  );
}
