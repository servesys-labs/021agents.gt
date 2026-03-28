import { Skeleton } from "./Skeleton";

export function PageSkeleton() {
  return (
    <div className="space-y-6 animate-in">
      {/* Stat cards row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="bg-white rounded-xl border border-border p-5 space-y-3">
            <div className="flex items-center gap-2">
              <Skeleton variant="avatar" className="w-5 h-5" />
              <Skeleton variant="text" className="w-20" />
            </div>
            <Skeleton variant="text" className="w-16 h-6" />
          </div>
        ))}
      </div>

      {/* Chart skeleton */}
      <div className="bg-white rounded-xl border border-border p-5 space-y-3">
        <Skeleton variant="text" className="w-32 h-5" />
        <Skeleton variant="chart" />
      </div>

      {/* List skeleton */}
      <div className="bg-white rounded-xl border border-border p-5 space-y-4">
        <Skeleton variant="text" className="w-24 h-5" />
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3">
            <Skeleton variant="avatar" />
            <div className="flex-1 space-y-2">
              <Skeleton variant="text" className="w-3/4" />
              <Skeleton variant="text" className="w-1/2" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
