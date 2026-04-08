/**
 * Skeleton loading components.
 *
 * Each variant matches a common UI pattern (card, table row, text block,
 * avatar) and uses a CSS shimmer animation defined in index.css so there
 * is zero JS-driven animation overhead.
 */

import type { CSSProperties } from "react";

/* ── Base shimmer block ──────────────────────────────────────────── */

type SkeletonBaseProps = {
  className?: string;
  style?: CSSProperties;
  /** Accessible label (defaults to "Loading") */
  label?: string;
};

function SkeletonBase({ className = "", style, label = "Loading" }: SkeletonBaseProps) {
  return (
    <div
      className={`skeleton-shimmer rounded ${className}`}
      style={style}
      role="status"
      aria-label={label}
      aria-busy="true"
    />
  );
}

/* ── SkeletonText ────────────────────────────────────────────────── */

type SkeletonTextProps = {
  /** Number of lines to render (default 3) */
  lines?: number;
  /** If true the last line is shorter for a natural look */
  lastShort?: boolean;
  className?: string;
};

export function SkeletonText({ lines = 3, lastShort = true, className = "" }: SkeletonTextProps) {
  return (
    <div className={`flex flex-col gap-2 ${className}`} role="status" aria-label="Loading text">
      {Array.from({ length: lines }).map((_, i) => {
        const isLast = i === lines - 1;
        const width = isLast && lastShort ? "60%" : "100%";
        return <SkeletonBase key={i} className="h-3 rounded" style={{ width }} />;
      })}
    </div>
  );
}

/* ── SkeletonAvatar ──────────────────────────────────────────────── */

type SkeletonAvatarProps = {
  /** Pixel size (default 40) */
  size?: number;
  /** Shape variant */
  shape?: "circle" | "rounded";
  className?: string;
};

export function SkeletonAvatar({ size = 40, shape = "circle", className = "" }: SkeletonAvatarProps) {
  const radius = shape === "circle" ? "rounded-full" : "rounded-lg";
  return (
    <SkeletonBase
      className={`flex-shrink-0 ${radius} ${className}`}
      style={{ width: size, height: size }}
      label="Loading avatar"
    />
  );
}

/* ── SkeletonCard ────────────────────────────────────────────────── */

type SkeletonCardProps = {
  /** Show an icon placeholder at top-left (default true) */
  showIcon?: boolean;
  className?: string;
  style?: CSSProperties;
};

export function SkeletonCard({ showIcon = true, className = "", style }: SkeletonCardProps) {
  return (
    <div
      className={`card flex items-center gap-3 py-3 ${className}`}
      style={style}
      role="status"
      aria-label="Loading card"
      aria-busy="true"
    >
      {showIcon && (
        <SkeletonBase className="rounded-lg flex-shrink-0" style={{ width: 36, height: 36 }} />
      )}
      <div className="flex-1 min-w-0">
        <SkeletonBase className="h-5 rounded mb-1.5" style={{ width: "50%" }} />
        <SkeletonBase className="h-2.5 rounded" style={{ width: "70%" }} />
      </div>
    </div>
  );
}

/* ── SkeletonTable ───────────────────────────────────────────────── */

type SkeletonTableProps = {
  /** Number of rows (default 5) */
  rows?: number;
  /** Number of columns (default 4) */
  cols?: number;
  className?: string;
};

export function SkeletonTable({ rows = 5, cols = 4, className = "" }: SkeletonTableProps) {
  return (
    <div className={`card p-0 ${className}`} role="status" aria-label="Loading table" aria-busy="true">
      <div className="overflow-x-auto">
        <table>
          <thead>
            <tr>
              {Array.from({ length: cols }).map((_, c) => (
                <th key={c}>
                  <SkeletonBase className="h-2.5 rounded" style={{ width: `${50 + c * 10}%` }} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: rows }).map((_, r) => (
              <tr key={r} className="skeleton-stagger" style={{ "--stagger-index": r } as CSSProperties}>
                {Array.from({ length: cols }).map((_, c) => (
                  <td key={c}>
                    <SkeletonBase
                      className="h-3 rounded"
                      style={{ width: c === 0 ? "70%" : `${40 + ((c * 15) % 30)}%` }}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ── SkeletonDashboard ───────────────────────────────────────────── */
/* Pre-composed skeleton matching the Dashboard KPI grid layout */

export function SkeletonDashboard() {
  return (
    <div role="status" aria-label="Loading dashboard" aria-busy="true">
      {/* KPI grid skeleton */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        {Array.from({ length: 8 }).map((_, i) => (
          <SkeletonCard key={i} className="skeleton-stagger" style={{ "--stagger-index": i } as unknown as CSSProperties} />
        ))}
      </div>

      {/* Two-column skeleton */}
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="card">
          <SkeletonBase className="h-3.5 rounded mb-4" style={{ width: "40%" }} />
          <div className="space-y-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 skeleton-stagger" style={{ "--stagger-index": i } as CSSProperties}>
                <SkeletonBase className="rounded-lg flex-shrink-0" style={{ width: 36, height: 36 }} />
                <div className="flex-1">
                  <SkeletonBase className="h-3 rounded mb-1" style={{ width: "60%" }} />
                  <SkeletonBase className="h-2 rounded" style={{ width: "80%" }} />
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="card">
          <SkeletonBase className="h-3.5 rounded mb-4" style={{ width: "35%" }} />
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex items-center gap-2 py-2 skeleton-stagger" style={{ "--stagger-index": i } as CSSProperties}>
                <SkeletonAvatar size={20} shape="circle" />
                <SkeletonBase className="h-2.5 rounded flex-1" style={{ width: "100%" }} />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── SkeletonAgentList ───────────────────────────────────────────── */
/* Pre-composed skeleton matching the Agents table layout */

export function SkeletonAgentList() {
  return <SkeletonTable rows={6} cols={5} />;
}

/* ── SkeletonKPIGrid ───────────────────────────────────────────── */
/* Matches the KPI stat card row used on Sessions, Issues, etc. */

export function SkeletonKPIGrid({ count = 3 }: { count?: number }) {
  return (
    <div className={`grid grid-cols-${count} gap-3 mb-4`} role="status" aria-label="Loading stats" aria-busy="true">
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonCard
          key={i}
          className="skeleton-stagger"
          style={{ "--stagger-index": i } as unknown as CSSProperties}
        />
      ))}
    </div>
  );
}

/* ── SkeletonAgentGrid ─────────────────────────────────────────── */
/* Matches the agent card grid layout */

export function SkeletonAgentGrid({ count = 6 }: { count?: number }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3" role="status" aria-label="Loading agents" aria-busy="true">
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="card skeleton-stagger"
          style={{ "--stagger-index": i } as CSSProperties}
        >
          <div className="flex items-center gap-3 mb-3">
            <SkeletonBase className="rounded-lg flex-shrink-0" style={{ width: 32, height: 32 }} />
            <div className="flex-1">
              <SkeletonBase className="h-3.5 rounded mb-1" style={{ width: "60%" }} />
              <SkeletonBase className="h-2 rounded" style={{ width: "40%" }} />
            </div>
          </div>
          <SkeletonBase className="h-2.5 rounded mb-1.5" style={{ width: "90%" }} />
          <SkeletonBase className="h-2.5 rounded" style={{ width: "65%" }} />
          <div className="flex gap-1.5 mt-3">
            <SkeletonBase className="h-5 rounded-full" style={{ width: 48 }} />
            <SkeletonBase className="h-5 rounded-full" style={{ width: 36 }} />
          </div>
        </div>
      ))}
    </div>
  );
}
