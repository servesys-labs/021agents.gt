import type { ReactNode } from "react";
import { Component } from "react";
import { AlertCircle, Copy, RefreshCw, RotateCcw } from "lucide-react";

/**
 * Generate a short error ID for support reference
 * Format: ERR-XXXXXX (6 alphanumeric chars)
 */
function generateErrorId(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let result = "ERR-";
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

type ErrorInfo = {
  message: string;
  stack?: string;
  componentStack?: string;
  timestamp: string;
  url: string;
  userAgent: string;
};

type State = {
  hasError: boolean;
  errorId: string;
  errorInfo: ErrorInfo | null;
  copied: boolean;
};

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  public state: State = {
    hasError: false,
    errorId: "",
    errorInfo: null,
    copied: false,
  };

  public static getDerivedStateFromError(error: Error): Partial<State> {
    return {
      hasError: true,
      errorId: generateErrorId(),
      errorInfo: {
        message: error.message,
        stack: error.stack,
        timestamp: new Date().toISOString(),
        url: window.location.href,
        userAgent: navigator.userAgent,
      },
    };
  }

  public componentDidCatch(error: Error, errorInfo: { componentStack?: string }): void {
    console.error("Portal error boundary caught:", error);
    console.error("Component stack:", errorInfo.componentStack);
    
    this.setState((prev) => ({
      errorInfo: prev.errorInfo
        ? { ...prev.errorInfo, componentStack: errorInfo.componentStack }
        : null,
    }));

    // Could send to error reporting service here
    // reportError({ errorId: this.state.errorId, error, errorInfo });
  }

  private handleRetry = (): void => {
    this.setState({ hasError: false, errorId: "", errorInfo: null, copied: false });
  };

  private handleReload = (): void => {
    window.location.reload();
  };

  private handleCopyError = async (): Promise<void> => {
    const { errorId, errorInfo } = this.state;
    if (!errorInfo) return;

    const text = `Error ID: ${errorId}
Message: ${errorInfo.message}
URL: ${errorInfo.url}
Time: ${errorInfo.timestamp}
User Agent: ${errorInfo.userAgent}
${errorInfo.stack ? `\nStack:\n${errorInfo.stack}` : ""}`;

    try {
      await navigator.clipboard.writeText(text);
      this.setState({ copied: true });
      setTimeout(() => this.setState({ copied: false }), 2000);
    } catch {
      // Fallback: do nothing
    }
  };

  public render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    const { errorId, errorInfo, copied } = this.state;

    return (
      <div className="min-h-screen flex items-center justify-center bg-surface-base p-6">
        <div className="card max-w-xl w-full">
          <div className="text-center">
            <div className="w-16 h-16 rounded-2xl bg-status-error/10 flex items-center justify-center mx-auto mb-4">
              <AlertCircle size={32} className="text-status-error" />
            </div>
            
            <h3 className="text-lg font-semibold text-text-primary mb-2">
              Something went wrong
            </h3>
            
            <p className="text-sm text-text-secondary mb-4">
              The portal encountered an unexpected error. We've generated an error ID for support.
            </p>

            {/* Error ID badge */}
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-surface-overlay border border-border-default mb-4">
              <span className="text-xs text-text-muted">Error ID:</span>
              <code className="text-xs font-mono text-accent">{errorId}</code>
            </div>

            {/* Error details (collapsible) */}
            {errorInfo && (
              <details className="text-left mb-6">
                <summary className="text-xs text-text-muted cursor-pointer hover:text-text-secondary transition-colors">
                  Error details
                </summary>
                <div className="mt-2 p-3 rounded-lg bg-surface-overlay border border-border-default overflow-auto">
                  <p className="text-xs font-mono text-status-error mb-2 break-all">
                    {errorInfo.message}
                  </p>
                  <p className="text-[10px] text-text-muted">
                    {errorInfo.url}
                  </p>
                </div>
              </details>
            )}

            {/* Action buttons */}
            <div className="flex flex-wrap items-center justify-center gap-3">
              <button
                onClick={this.handleRetry}
                className="btn btn-primary flex items-center gap-2"
              >
                <RotateCcw size={16} />
                Try Again
              </button>
              
              <button
                onClick={this.handleReload}
                className="btn btn-secondary flex items-center gap-2"
              >
                <RefreshCw size={16} />
                Reload Page
              </button>
              
              <button
                onClick={this.handleCopyError}
                className="btn btn-ghost flex items-center gap-2 text-text-secondary"
                aria-label="Copy error details to clipboard"
              >
                <Copy size={16} />
                {copied ? "Copied!" : "Copy Details"}
              </button>
            </div>

            <p className="mt-4 text-[10px] text-text-muted">
              If the problem persists, contact support with error ID <code className="font-mono text-text-secondary">{errorId}</code>
            </p>
          </div>
        </div>
      </div>
    );
  }
}
