import { Modal } from "./Modal";

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
              tone === "danger"
                ? "bg-status-error text-text-primary hover:bg-status-error/80"
                : "btn-primary"
            }`}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      <p className="text-sm text-text-secondary">{description}</p>
    </Modal>
  );
}
