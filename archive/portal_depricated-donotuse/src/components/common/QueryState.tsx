import type { ReactNode } from "react";
import { AlertCircle, Inbox, RefreshCw } from "lucide-react";
import { SkeletonTable } from "./Skeleton";

type QueryStateProps = {
  loading: boolean;
  error: string | null;
  isEmpty?: boolean;
  emptyMessage?: string;
  onRetry?: () => void;
  /** Custom skeleton to show while loading (defaults to SkeletonTable) */
  skeleton?: ReactNode;
  children: ReactNode;
};

export function QueryState({
  loading,
  error,
  isEmpty = false,
  emptyMessage = "No data available.",
  onRetry,
  skeleton,
  children,
}: QueryStateProps) {
  if (loading) {
    return <>{skeleton ?? <SkeletonTable rows={4} cols={3} />}</>;
  }

  if (error) {
    return (
      <div className="card border-status-error/30">
        <div className="flex flex-col items-center gap-3 py-8">
          <AlertCircle size={20} className="text-status-error" />
          <p className="text-sm text-status-error">{error}</p>
          {onRetry ? (
            <button onClick={onRetry} className="btn btn-secondary text-xs mt-2">
              <RefreshCw size={12} />
              Retry
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  if (isEmpty) {
    return (
      <div className="card">
        <div className="flex flex-col items-center gap-3 py-8">
          <Inbox size={20} className="text-text-muted" />
          <p className="text-sm text-text-muted">{emptyMessage}</p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
