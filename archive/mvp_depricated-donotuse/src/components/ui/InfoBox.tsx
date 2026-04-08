interface InfoBoxProps {
  variant?: "info" | "warning" | "success" | "danger";
  icon?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

const variantStyles = {
  info: "bg-info-light text-info",
  warning: "bg-warning-light text-warning-dark",
  success: "bg-success-light text-success-dark",
  danger: "bg-danger-light text-danger-dark",
};

export function InfoBox({ variant = "info", icon, children, className = "" }: InfoBoxProps) {
  return (
    <div className={`flex items-center gap-2 px-4 py-2.5 rounded-lg text-xs ${variantStyles[variant]} ${className}`}>
      {icon}
      <span>{children}</span>
    </div>
  );
}
