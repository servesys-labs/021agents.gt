import type React from "react";

/* ── Types ──────────────────────────────────────────────────────── */

export type Level = "critical" | "high" | "medium" | "low" | "info" | "none";

export interface SeverityBadgeProps {
  level: Level;
  /** sm = compact pill, md = standard (default) */
  size?: "sm" | "md";
  /** Prefix with a colored dot */
  showIcon?: boolean;
  className?: string;
}

/* ── Color mapping ──────────────────────────────────────────────── */

export function getSeverityColors(level: Level): {
  bg: string;
  text: string;
  border: string;
  dot: string;
} {
  switch (level) {
    case "critical":
      return {
        bg: "bg-status-error/15",
        text: "text-status-error",
        border: "border-status-error/20",
        dot: "bg-status-error",
      };
    case "high":
      return {
        bg: "bg-chart-orange/15",
        text: "text-chart-orange",
        border: "border-chart-orange/20",
        dot: "bg-chart-orange",
      };
    case "medium":
      return {
        bg: "bg-status-warning/15",
        text: "text-status-warning",
        border: "border-status-warning/20",
        dot: "bg-status-warning",
      };
    case "low":
      return {
        bg: "bg-status-live/15",
        text: "text-status-live",
        border: "border-status-live/20",
        dot: "bg-status-live",
      };
    case "info":
      return {
        bg: "bg-chart-blue/15",
        text: "text-chart-blue",
        border: "border-chart-blue/20",
        dot: "bg-chart-blue",
      };
    case "none":
    default:
      return {
        bg: "bg-surface-overlay",
        text: "text-text-muted",
        border: "border-border-default",
        dot: "bg-text-muted",
      };
  }
}

/**
 * Normalize arbitrary severity/risk strings into a typed Level.
 * Handles "HIGH", "Critical", "info", etc.
 */
export function normalizeLevel(raw: string): Level {
  const l = raw?.toLowerCase() ?? "none";
  if (l === "critical") return "critical";
  if (l === "high") return "high";
  if (l === "medium") return "medium";
  if (l === "low") return "low";
  if (l === "info") return "info";
  return "none";
}

/* ── Component ──────────────────────────────────────────────────── */

export function SeverityBadge({
  level,
  size = "md",
  showIcon = false,
  className = "",
}: SeverityBadgeProps) {
  const colors = getSeverityColors(level);
  const isSm = size === "sm";

  return (
    <span
      className={[
        "inline-flex items-center gap-1.5 rounded-full font-semibold uppercase tracking-wide border",
        isSm ? "px-1.5 py-0.5 text-[9px]" : "px-2.5 py-1 text-[10px]",
        colors.bg,
        colors.text,
        colors.border,
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {showIcon && (
        <span
          className={`inline-block w-1.5 h-1.5 rounded-full ${colors.dot}`}
          aria-hidden="true"
        />
      )}
      {level}
    </span>
  );
}
