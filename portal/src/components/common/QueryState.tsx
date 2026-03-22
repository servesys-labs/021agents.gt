import type { ReactNode } from "react";
import { AlertCircle, Inbox, RefreshCw, Loader2 } from "lucide-react";

type QueryStateProps = {
  loading: boolean;
  error: string | null;
  isEmpty?: boolean;
  emptyMessage?: string;
  onRetry?: () => void;
  children: ReactNode;
};

export function QueryState({
  loading,
  error,
  isEmpty = false,
  emptyMessage = "No data available.",
  onRetry,
  children,
}: QueryStateProps) {
  if (loading) {
    return (
      <div className="card">
        <div className="flex items-center gap-3 py-8 justify-center">
          <Loader2 size={18} className="text-accent animate-spin" />
          <span className="text-sm text-text-muted">Loading...</span>
        </div>
      </div>
    );
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
