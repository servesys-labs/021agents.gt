import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

/* ── Focus trap hook ────────────────────────────────────────────── */

function useFocusTrap(containerRef: React.RefObject<HTMLElement | null>, isActive: boolean) {
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!isActive) return;
    previousFocusRef.current = document.activeElement as HTMLElement;

    const container = containerRef.current;
    if (!container) return;

    const getFocusable = () =>
      container.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );

    const handleTab = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const els = getFocusable();
      if (els.length === 0) return;
      const first = els[0];
      const last = els[els.length - 1];

      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        const event = new CustomEvent("modal-escape");
        container.dispatchEvent(event);
      }
    };

    container.addEventListener("keydown", handleTab);
    container.addEventListener("keydown", handleEsc);

    // Focus first focusable on open
    requestAnimationFrame(() => {
      const els = getFocusable();
      els[0]?.focus();
    });

    return () => {
      container.removeEventListener("keydown", handleTab);
      container.removeEventListener("keydown", handleEsc);
      previousFocusRef.current?.focus();
    };
  }, [isActive, containerRef]);
}

/* ── Modal ──────────────────────────────────────────────────────── */

type ModalProps = {
  /** Whether the modal is open */
  open: boolean;
  /** Called when the user closes the modal (backdrop click, Escape, X button) */
  onClose: () => void;
  /** Modal title — renders in a header bar with a close button */
  title?: string;
  /** Max width class: "sm" | "md" | "lg" | "xl" | "2xl" | "3xl" | "4xl" | "5xl" */
  maxWidth?: string;
  /** Modal body */
  children: ReactNode;
  /** Optional footer (action buttons) */
  footer?: ReactNode;
};

const MAX_WIDTH_MAP: Record<string, string> = {
  sm: "max-w-sm",
  md: "max-w-md",
  lg: "max-w-lg",
  xl: "max-w-xl",
  "2xl": "max-w-2xl",
  "3xl": "max-w-3xl",
  "4xl": "max-w-4xl",
  "5xl": "max-w-5xl",
};

export function Modal({
  open,
  onClose,
  title,
  maxWidth = "2xl",
  children,
  footer,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef, open);

  // Listen for the escape event dispatched by focus trap
  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (!panel) return;

    const handleEscape = () => onClose();
    panel.addEventListener("modal-escape", handleEscape);
    return () => panel.removeEventListener("modal-escape", handleEscape);
  }, [open, onClose]);

  // Lock body scroll
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  if (!open) return null;

  const widthClass = MAX_WIDTH_MAP[maxWidth] ?? `max-w-${maxWidth}`;

  return (
    <div
      className="modal-overlay glass-backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div
        ref={panelRef}
        className={`relative z-10 w-full ${widthClass} rounded-xl border border-border-default shadow-panel glass-medium`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        {title && (
          <div className="flex items-center justify-between px-6 py-4 border-b border-border-default">
            <h2 className="text-sm font-bold text-text-primary">{title}</h2>
            <button
              onClick={onClose}
              className="p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-surface-overlay transition-colors min-h-[var(--touch-target-min)] min-w-[var(--touch-target-min)] flex items-center justify-center"
              aria-label="Close"
            >
              <X size={16} />
            </button>
          </div>
        )}

        {/* Body */}
        <div className="px-6 py-5">
          {children}
        </div>

        {/* Footer */}
        {footer && (
          <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-border-default">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
