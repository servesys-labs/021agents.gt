import type { ReactNode } from "react";
import { Component } from "react";
import { AlertCircle } from "lucide-react";

type State = {
  hasError: boolean;
  message: string;
};

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  public state: State = {
    hasError: false,
    message: "",
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, message: error.message };
  }

  public componentDidCatch(error: Error): void {
    console.error("Portal error boundary caught:", error);
  }

  public render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <div className="min-h-screen flex items-center justify-center bg-surface-base p-6">
        <div className="card max-w-lg text-center">
          <AlertCircle size={24} className="text-status-error mx-auto mb-3" />
          <h3 className="text-base font-semibold text-text-primary">Something went wrong in the portal UI.</h3>
          <p className="mt-2 text-sm text-text-secondary">{this.state.message || "Unknown error"}</p>
          <button
            className="btn btn-primary mt-4"
            onClick={() => {
              this.setState({ hasError: false, message: "" });
              window.location.reload();
            }}
          >
            Reload App
          </button>
        </div>
      </div>
    );
  }
}
