import type { ReactNode } from "react";

interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
  action?: ReactNode;
}

export function EmptyState({
  icon,
  title,
  description,
  actionLabel,
  onAction,
  action,
}: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center empty-state-gradient rounded-xl">
      {icon && (
        <div className="empty-state-icon mb-6 p-5 rounded-2xl bg-surface-overlay/40 border border-border-default">
          <div className="text-text-muted">{icon}</div>
        </div>
      )}
      <h3 className="text-base font-semibold text-text-primary mb-2">{title}</h3>
      {description && (
        <p className="text-sm text-text-muted max-w-md mb-6 leading-relaxed">
          {description}
        </p>
      )}
      {actionLabel && onAction ? (
        <button className="btn btn-primary text-xs" onClick={onAction}>
          {actionLabel}
        </button>
      ) : (
        action
      )}
    </div>
  );
}

/* ── Get Started Stepper ─────────────────────────────────── */

export interface StepDef {
  icon: ReactNode;
  label: string;
  description: string;
}

interface GetStartedGuideProps {
  steps: StepDef[];
  onStart?: () => void;
  startLabel?: string;
}

export function GetStartedGuide({
  steps,
  onStart,
  startLabel = "Get Started",
}: GetStartedGuideProps) {
  return (
    <div className="card mb-6">
      <div className="flex items-center justify-between mb-5">
        <div>
          <h3 className="text-sm font-semibold text-text-primary">
            Quick Start Guide
          </h3>
          <p className="text-xs text-text-muted mt-0.5">
            Get up and running in three steps
          </p>
        </div>
        {onStart && (
          <button className="btn btn-primary text-xs" onClick={onStart}>
            {startLabel}
          </button>
        )}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {steps.map((step, i) => (
          <div key={i} className="relative flex items-start gap-3 p-4 rounded-xl bg-surface-base border border-border-default">
            {/* Step number badge */}
            <div className="flex-shrink-0 w-8 h-8 rounded-lg bg-accent/10 border border-accent/20 flex items-center justify-center">
              <span className="text-xs font-bold text-accent">{i + 1}</span>
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-text-muted">{step.icon}</span>
                <span className="text-sm font-medium text-text-primary">
                  {step.label}
                </span>
              </div>
              <p className="text-xs text-text-muted leading-relaxed">
                {step.description}
              </p>
            </div>
            {/* Connector arrow between steps (hidden on last + mobile) */}
            {i < steps.length - 1 && (
              <div className="hidden md:flex absolute -right-3 top-1/2 -translate-y-1/2 z-10 w-6 h-6 rounded-full bg-surface-raised border border-border-default items-center justify-center">
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 10 10"
                  fill="none"
                  className="text-text-muted"
                >
                  <path
                    d="M3.5 2L6.5 5L3.5 8"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
