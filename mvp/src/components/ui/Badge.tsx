type Variant = "default" | "success" | "warning" | "danger" | "info";

const styles: Record<Variant, string> = {
  default: "bg-neutral-light text-neutral-dark",
  success: "bg-success-light text-success-dark",
  warning: "bg-warning-light text-warning-dark",
  danger: "bg-danger-light text-danger-dark",
  info: "bg-info-light text-info-dark",
};

interface BadgeProps {
  variant?: Variant;
  children: React.ReactNode;
  className?: string;
}

export function Badge({ variant = "default", children, className = "" }: BadgeProps) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${styles[variant]} ${className}`}>
      {children}
    </span>
  );
}
