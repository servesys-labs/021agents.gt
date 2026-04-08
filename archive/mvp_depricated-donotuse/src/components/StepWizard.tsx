import { Check } from "lucide-react";

interface StepWizardProps {
  steps: string[];
  currentStep: number;
  children: React.ReactNode;
}

export function StepWizard({ steps, currentStep, children }: StepWizardProps) {
  return (
    <div>
      {/* Step indicator */}
      <div className="flex items-center justify-center gap-2 mb-8">
        {steps.map((label, i) => (
          <div key={i} className="flex items-center gap-2">
            <div className="flex items-center gap-2">
              <div
                className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-medium transition-colors ${
                  i < currentStep
                    ? "bg-success text-white"
                    : i === currentStep
                    ? "bg-primary text-white"
                    : "bg-neutral-light text-text-muted"
                }`}
              >
                {i < currentStep ? <Check size={14} /> : i + 1}
              </div>
              <span
                className={`text-sm hidden sm:inline ${
                  i === currentStep ? "font-medium text-text" : "text-text-muted"
                }`}
              >
                {label}
              </span>
            </div>
            {i < steps.length - 1 && <div className="w-8 h-px bg-border mx-1" />}
          </div>
        ))}
      </div>

      {/* Content */}
      {children}
    </div>
  );
}
