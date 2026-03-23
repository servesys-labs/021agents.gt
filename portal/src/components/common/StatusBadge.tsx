const statusConfig: Record<string, { dot: string; bg: string; text: string; border: string }> = {
  online:        { dot: "bg-status-live",    bg: "bg-status-live/10",    text: "text-status-live",    border: "border-status-live/20" },
  live:          { dot: "bg-status-live",    bg: "bg-status-live/10",    text: "text-status-live",    border: "border-status-live/20" },
  active:        { dot: "bg-status-live",    bg: "bg-status-live/10",    text: "text-status-live",    border: "border-status-live/20" },
  running:       { dot: "bg-status-live",    bg: "bg-status-live/10",    text: "text-status-live",    border: "border-status-live/20" },
  connected:     { dot: "bg-status-live",    bg: "bg-status-live/10",    text: "text-status-live",    border: "border-status-live/20" },
  healthy:       { dot: "bg-status-live",    bg: "bg-status-live/10",    text: "text-status-live",    border: "border-status-live/20" },
  ready:         { dot: "bg-status-live",    bg: "bg-status-live/10",    text: "text-status-live",    border: "border-status-live/20" },
  authenticated: { dot: "bg-status-live",    bg: "bg-status-live/10",    text: "text-status-live",    border: "border-status-live/20" },
  passed:        { dot: "bg-status-live",    bg: "bg-status-live/10",    text: "text-status-live",    border: "border-status-live/20" },
  enabled:       { dot: "bg-status-live",    bg: "bg-status-live/10",    text: "text-status-live",    border: "border-status-live/20" },
  completed:     { dot: "bg-status-info",    bg: "bg-status-info/10",    text: "text-status-info",    border: "border-status-info/20" },
  draft:         { dot: "bg-text-muted",     bg: "bg-surface-overlay",   text: "text-text-muted",     border: "border-border-default" },
  offline:       { dot: "bg-text-muted",     bg: "bg-surface-overlay",   text: "text-text-muted",     border: "border-border-default" },
  disabled:      { dot: "bg-text-muted",     bg: "bg-surface-overlay",   text: "text-text-muted",     border: "border-border-default" },
  pending:       { dot: "bg-status-warning", bg: "bg-status-warning/10", text: "text-status-warning", border: "border-status-warning/20" },
  paused:        { dot: "bg-status-warning", bg: "bg-status-warning/10", text: "text-status-warning", border: "border-status-warning/20" },
  ingesting:     { dot: "bg-status-warning", bg: "bg-status-warning/10", text: "text-status-warning", border: "border-status-warning/20" },
  error:         { dot: "bg-status-error",   bg: "bg-status-error/10",   text: "text-status-error",   border: "border-status-error/20" },
  failed:        { dot: "bg-status-error",   bg: "bg-status-error/10",   text: "text-status-error",   border: "border-status-error/20" },
  cancelled:     { dot: "bg-status-error",   bg: "bg-status-error/10",   text: "text-status-error",   border: "border-status-error/20" },
};

const defaultConfig = { dot: "bg-text-muted", bg: "bg-surface-overlay", text: "text-text-muted", border: "border-border-default" };

interface StatusBadgeProps {
  status: string;
  size?: "sm" | "md";
}

export function StatusBadge({ status, size = "sm" }: StatusBadgeProps) {
  const key = status.toLowerCase();
  const cfg = statusConfig[key] || defaultConfig;
  const label = status.charAt(0).toUpperCase() + status.slice(1).toLowerCase();

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border ${cfg.bg} ${cfg.border} ${cfg.text} ${
        size === "sm" ? "px-2 py-0.5 text-[10px]" : "px-2.5 py-1 text-xs"
      } font-medium uppercase tracking-wide`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
      {label}
    </span>
  );
}
