import type { ReactNode } from "react";

interface EmptyStateProps {
  icon?: ReactNode;
  title?: string;
  description?: string;
  message?: string;
  action?: ReactNode;
}

export function EmptyState({ icon, title, description, message, action }: EmptyStateProps) {
  const resolvedTitle = title || "Nothing here yet";
  const resolvedDescription = description ?? message;
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      {icon && (
        <div className="mb-4 text-text-muted">{icon}</div>
      )}
      <h3 className="text-sm font-semibold text-text-primary mb-1">{resolvedTitle}</h3>
      {resolvedDescription && (
        <p className="text-xs text-text-muted max-w-sm mb-4">{resolvedDescription}</p>
      )}
      {action}
    </div>
  );
}
