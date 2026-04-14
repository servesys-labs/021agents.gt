/**
 * Relative time formatting: "2m ago", "3h ago", "1d ago", "Mar 15"
 */
export function timeAgo(date: string | Date | number | null | undefined): string {
  if (!date) return "";
  const d = typeof date === "number" ? new Date(date) : typeof date === "string" ? new Date(date) : date;
  if (isNaN(d.getTime())) return "";
  const now = Date.now();
  const diffMs = now - d.getTime();

  if (diffMs < 0) return "just now";

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;

  // Older than a week: show "Mar 15" style
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/**
 * Duration formatting: "1.2s", "45s", "2m 30s"
 */
export function formatDuration(seconds: number | string | null | undefined): string {
  const s = Number(seconds) || 0;
  if (s < 0) return "0s";
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.round(s)}s`;

  const mins = Math.floor(s / 60);
  const secs = Math.round(s % 60);
  return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
}

/**
 * Cost formatting: "$0.00", "$1.23", "$0.001"
 */
export function formatCost(usd: number | string | null | undefined): string {
  const v = Number(usd) || 0;
  if (v === 0) return "$0.00";
  if (v < 0.01) return `$${v.toFixed(3)}`;
  return `$${v.toFixed(2)}`;
}
