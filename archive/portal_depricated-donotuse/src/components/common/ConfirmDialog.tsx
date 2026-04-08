import { Modal } from "./Modal";

export type ConfirmDialogProps = {
  open?: boolean;
  title: string;
  description?: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "default" | "danger";
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

export function ConfirmDialog({
  open = true,
  title,
  description,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  tone = "default",
  destructive = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const resolvedDescription = description || message || "";
  const resolvedTone = destructive ? "danger" : tone;
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      maxWidth="md"
      footer={
        <>
          <button onClick={onCancel} className="btn btn-secondary min-h-[var(--touch-target-min)]">
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            className={`btn min-h-[var(--touch-target-min)] ${
              resolvedTone === "danger"
                ? "bg-status-error text-text-primary hover:bg-status-error/80"
                : "btn-primary"
            }`}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      <p className="text-sm text-text-secondary">{resolvedDescription}</p>
    </Modal>
  );
}
