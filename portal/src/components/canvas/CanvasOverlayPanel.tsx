import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

interface CanvasOverlayPanelProps {
  open: boolean;
  onClose: () => void;
  title: string;
  icon?: ReactNode;
  children: ReactNode;
  width?: string;
}

export function CanvasOverlayPanel({ open, onClose, title, icon, children, width = "720px" }: CanvasOverlayPanelProps) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };

    document.addEventListener("keydown", handleKeyDown);
    closeRef.current?.focus();

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-40 glass-backdrop" onClick={onClose} aria-hidden="true" />

      {/* Panel — centered modal */}
      <div
        className="fixed top-[5%] left-1/2 z-50 flex flex-col glass-medium border border-border-default rounded-xl overflow-hidden relative"
        style={{
          width,
          maxWidth: "calc(100vw - 80px)",
          maxHeight: "90vh",
          transform: "translateX(-50%)",
          animation: "overlayIn 0.2s ease-out",
          boxShadow: "var(--shadow-panel)",
        }}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-border-default flex-shrink-0">
          {icon && (
            <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-surface-overlay" aria-hidden="true">
              {icon}
            </div>
          )}
          <h2 className="text-sm font-semibold text-text-primary flex-1">{title}</h2>
          <button
            ref={closeRef}
            onClick={onClose}
            className="flex items-center justify-center min-w-[var(--touch-target-min)] min-h-[var(--touch-target-min)] rounded-md text-text-muted hover:bg-surface-overlay hover:text-text-primary transition-colors"
            aria-label="Close panel"
          >
            <X size={14} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-5">
          {children}
        </div>
      </div>

      <style>{`
        @keyframes overlayIn {
          from { transform: translateX(-50%) translateY(-10px); opacity: 0; }
          to { transform: translateX(-50%) translateY(0); opacity: 1; }
        }
      `}</style>
    </>
  );
}
