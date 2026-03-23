import { useEffect, useRef } from "react";

type ConfirmDialogProps = {
  open?: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "default" | "danger";
  onConfirm: () => void;
  onCancel: () => void;
};

export function ConfirmDialog({
  open = true,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  tone = "default",
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Focus trap + Escape handler
  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onCancel();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    // Focus the cancel button on open
    cancelRef.current?.focus();

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, onCancel]);

  if (!open) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 glass-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
      aria-describedby="confirm-dialog-desc"
    >
      <div className="card w-full max-w-md glass-medium relative border border-border-default">
        <h3 id="confirm-dialog-title" className="text-base font-semibold text-text-primary">{title}</h3>
        <p id="confirm-dialog-desc" className="mt-2 text-sm text-text-secondary">{description}</p>
        <div className="mt-5 flex justify-end gap-2">
          <button ref={cancelRef} onClick={onCancel} className="btn btn-secondary min-h-[var(--touch-target-min)]">
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            className={`btn min-h-[var(--touch-target-min)] ${
              tone === "danger"
                ? "bg-status-error text-text-primary hover:bg-status-error/80"
                : "btn-primary"
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
