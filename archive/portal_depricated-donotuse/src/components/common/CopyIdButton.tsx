import { useState, useCallback } from "react";
import { Copy, Check } from "lucide-react";

interface CopyIdButtonProps {
  /** The text to copy to clipboard */
  value: string;
  /** Optional label shown before the icon */
  label?: string;
  className?: string;
}

/**
 * CopyIdButton -- small inline copy icon that copies a value to clipboard
 * and shows a brief "Copied!" tooltip.
 */
export function CopyIdButton({ value, label, className }: CopyIdButtonProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Fallback for older browsers
      const el = document.createElement("textarea");
      el.value = value;
      el.style.position = "fixed";
      el.style.opacity = "0";
      document.body.appendChild(el);
      el.select();
      document.execCommand("copy");
      document.body.removeChild(el);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }, [value]);

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        void handleCopy();
      }}
      className={`copy-id-btn ${className ?? ""}`}
      title={copied ? "Copied!" : `Copy ${label ?? "ID"}`}
      aria-label={copied ? "Copied!" : `Copy ${label ?? "ID"}`}
    >
      {copied ? (
        <Check size={11} className="text-status-live" />
      ) : (
        <Copy size={11} className="text-text-muted" />
      )}
      {copied && <span className="copy-id-tooltip">Copied!</span>}
    </button>
  );
}
