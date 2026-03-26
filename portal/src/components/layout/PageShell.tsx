import type { ReactNode } from "react";

/*
 * PageShell — centralized page layout wrapper.
 *
 * Every page renders inside this shell (via the app Sidebar).
 * It provides consistent max-width, centering, and vertical rhythm
 * so individual pages never define their own container constraints.
 *
 * Variants:
 *   "default"  — standard content pages (max-width, centered, padded)
 *   "wide"     — data-heavy pages that need more room (wider max-width)
 *   "full"     — canvas/editor pages (no constraints, fills viewport)
 *   "centered" — empty states, onboarding (vertically + horizontally centered)
 */

type Variant = "default" | "wide" | "full" | "centered";

type PageShellProps = {
  children: ReactNode;
  /** Layout variant. Defaults to "default". */
  variant?: Variant;
  /** Additional className on the content wrapper */
  className?: string;
};

const variantStyles: Record<Variant, string> = {
  default: "max-w-[1400px] mx-auto px-6 py-6",
  wide: "max-w-[1600px] mx-auto px-6 py-6",
  full: "h-full",
  centered: "max-w-5xl mx-auto px-6 min-h-[calc(100vh-2rem)] flex flex-col justify-center",
};

export function PageShell({ children, variant = "default", className = "" }: PageShellProps) {
  return (
    <div className={`${variantStyles[variant]} ${className}`}>
      {children}
    </div>
  );
}
