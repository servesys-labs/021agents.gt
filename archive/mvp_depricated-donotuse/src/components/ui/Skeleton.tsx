const variantClasses = {
  text: "h-4 rounded",
  card: "h-24 rounded-xl",
  avatar: "w-8 h-8 rounded-full",
  chart: "h-40 rounded-xl",
} as const;

type SkeletonVariant = keyof typeof variantClasses;

interface SkeletonProps {
  variant?: SkeletonVariant;
  className?: string;
  width?: string;
  height?: string;
}

export function Skeleton({ variant = "text", className = "", width, height }: SkeletonProps) {
  return (
    <div
      className={`animate-pulse bg-neutral-light ${variantClasses[variant]} ${className}`}
      style={{ width, height }}
    />
  );
}
