/**
 * Formats a date string or Date into a relative time label.
 * "2s ago", "5m ago", "3h ago", "2d ago", "1w ago", "Mar 15"
 */
export function timeAgo(date: string | Date | undefined | null): string {
  if (!date) return "";
  const now = Date.now();
  const then = typeof date === "string" ? new Date(date).getTime() : date.getTime();
  if (isNaN(then)) return "";
  const diff = now - then;

  if (diff < 0) return "just now";

  const seconds = Math.floor(diff / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;

  const weeks = Math.floor(days / 7);
  if (weeks < 4) return `${weeks}w ago`;

  // Older than ~4 weeks — show short date
  const d = new Date(then);
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${monthNames[d.getMonth()]} ${d.getDate()}`;
}
