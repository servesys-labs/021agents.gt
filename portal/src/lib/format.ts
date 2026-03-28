/* ── Shared formatting utilities ─────────────────────────────────── */

/**
 * Relative time string: "2h ago", "3d ago", etc.
 * Handles epoch-seconds, epoch-milliseconds, and ISO date strings.
 */
export function timeSince(timestamp?: number | string | null): string {
  if (timestamp == null) return "--";
  const date = new Date(
    typeof timestamp === "number" && timestamp < 1e12
      ? timestamp * 1000
      : timestamp,
  );
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** Short date: "Mar 27, 2026" */
export function formatDate(timestamp?: number | string | null): string {
  if (timestamp == null) return "--";
  const d = new Date(
    typeof timestamp === "number" && timestamp < 1e12
      ? timestamp * 1000
      : timestamp,
  );
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** Date + time: "Mar 27, 2026 3:42 PM" */
export function formatDateTime(timestamp?: number | string | null): string {
  if (timestamp == null) return "--";
  const d = new Date(
    typeof timestamp === "number" && timestamp < 1e12
      ? timestamp * 1000
      : timestamp,
  );
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Comma-separated number: 1234 -> "1,234" */
export function formatNumber(n: number): string {
  return n.toLocaleString();
}

/** USD cost: 1.234 -> "$1.23" */
export function formatCost(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

/** Percent display: 0.875 -> "87.5%" */
export function formatPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

/** Latency display: 2400 -> "2.4s", 340 -> "340ms" */
export function formatLatency(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}
