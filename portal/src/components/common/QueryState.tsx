import { Button, Card, Text } from "@tremor/react";
import type { ReactNode } from "react";

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
      <Card>
        <div className="space-y-2 animate-pulse">
          <div className="h-4 w-1/3 rounded bg-gray-200" />
          <div className="h-3 w-full rounded bg-gray-100" />
          <div className="h-3 w-5/6 rounded bg-gray-100" />
          <div className="h-3 w-4/6 rounded bg-gray-100" />
        </div>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <Text className="text-red-600">{error}</Text>
        {onRetry ? (
          <Button size="xs" className="mt-3" onClick={onRetry}>
            Retry
          </Button>
        ) : null}
      </Card>
    );
  }

  if (isEmpty) {
    return (
      <Card>
        <Text>{emptyMessage}</Text>
      </Card>
    );
  }

  return <>{children}</>;
}
