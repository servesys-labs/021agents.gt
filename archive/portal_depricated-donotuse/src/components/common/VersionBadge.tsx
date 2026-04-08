/**
 * VersionBadge -- small colored pill for version/tag/environment labels.
 * Uses CSS variables only, no hardcoded colors.
 */

type BadgeVariant = "version" | "draft" | "production" | "staging" | "default";

const variantStyles: Record<BadgeVariant, string> = {
  version:    "bg-chart-purple/10 text-chart-purple border-chart-purple/20",
  draft:      "bg-surface-overlay text-text-muted border-border-default",
  production: "bg-status-live/10 text-status-live border-status-live/20",
  staging:    "bg-status-warning/10 text-status-warning border-status-warning/20",
  default:    "bg-surface-overlay text-text-muted border-border-default",
};

function detectVariant(label: string): BadgeVariant {
  const lower = label.toLowerCase();
  if (lower === "draft") return "draft";
  if (lower === "production" || lower === "prod") return "production";
  if (lower === "staging" || lower === "stage") return "staging";
  if (/^v?\d/.test(lower)) return "version";
  return "default";
}

interface VersionBadgeProps {
  label: string;
  variant?: BadgeVariant;
  className?: string;
}

export function VersionBadge({ label, variant, className }: VersionBadgeProps) {
  const resolved = variant ?? detectVariant(label);
  const styles = variantStyles[resolved] ?? variantStyles.default;

  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded-full border leading-none ${styles} ${className ?? ""}`}
    >
      {label}
    </span>
  );
}
