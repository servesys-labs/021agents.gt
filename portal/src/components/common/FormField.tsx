import type { ReactNode } from "react";

interface FormFieldProps {
  label: string;
  htmlFor?: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children: ReactNode;
}

export function FormField({
  label,
  htmlFor,
  hint,
  error,
  required,
  children,
}: FormFieldProps) {
  return (
    <div className="mb-4">
      <label
        htmlFor={htmlFor}
        className="block text-xs font-medium text-text-secondary mb-1.5 uppercase tracking-wide"
      >
        {label}
        {required && <span className="text-accent ml-0.5">*</span>}
      </label>
      {children}
      {hint && !error && (
        <p className="mt-1 text-[11px] text-text-muted">{hint}</p>
      )}
      {error && (
        <p className="mt-1 text-[11px] text-status-error">{error}</p>
      )}
    </div>
  );
}
