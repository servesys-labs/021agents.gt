import type { ReactNode } from "react";
import { Component } from "react";
import { Button, Card, Text } from "@tremor/react";

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
    // Keep lightweight logging for client diagnostics.
    console.error("Portal error boundary caught:", error);
  }

  public render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 p-6">
        <Card className="max-w-lg">
          <Text className="font-semibold">Something went wrong in the portal UI.</Text>
          <Text className="mt-2 text-gray-600">{this.state.message || "Unknown error"}</Text>
          <Button
            className="mt-4"
            onClick={() => {
              this.setState({ hasError: false, message: "" });
              window.location.reload();
            }}
          >
            Reload App
          </Button>
        </Card>
      </div>
    );
  }
}
