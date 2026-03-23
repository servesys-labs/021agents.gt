/* eslint-disable react-refresh/only-export-components */
import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { CheckCircle2, AlertCircle, Info, X } from "lucide-react";

type ToastTone = "success" | "error" | "info";

type ToastItem = {
  id: string;
  message: string;
  tone: ToastTone;
};

type ToastContextValue = {
  showToast: (message: string, tone?: ToastTone) => void;
};

const toneConfig = {
  success: { icon: CheckCircle2, color: "text-status-live", bg: "bg-status-live/10", border: "border-status-live/20" },
  error: { icon: AlertCircle, color: "text-status-error", bg: "bg-status-error/10", border: "border-status-error/20" },
  info: { icon: Info, color: "text-status-info", bg: "bg-status-info/10", border: "border-status-info/20" },
};

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const showToast = useCallback((message: string, tone: ToastTone = "info") => {
    const id = crypto.randomUUID();
    setItems((prev) => [...prev, { id, message, tone }]);
    window.setTimeout(() => {
      setItems((prev) => prev.filter((item) => item.id !== id));
    }, 3200);
  }, []);

  const dismiss = useCallback((id: string) => {
    setItems((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const value = useMemo(() => ({ showToast }), [showToast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        className="fixed bottom-10 right-4 z-[60] flex max-w-sm flex-col gap-2"
        role="status"
        aria-live="polite"
        aria-label="Notifications"
      >
        {items.map((item) => {
          const cfg = toneConfig[item.tone];
          const Icon = cfg.icon;
          return (
            <div
              key={item.id}
              className={`flex items-start gap-2.5 rounded-lg ${cfg.bg} border ${cfg.border} px-3 py-2.5 backdrop-blur-xl backdrop-saturate-150 animate-[slideIn_0.2s_ease-out]`}
            >
              <Icon size={16} className={`${cfg.color} mt-0.5 flex-shrink-0`} aria-hidden="true" />
              <p className="text-sm text-text-primary flex-1">{item.message}</p>
              <button
                onClick={() => dismiss(item.id)}
                className="text-text-muted hover:text-text-secondary transition-colors flex-shrink-0 p-1 min-w-[var(--touch-target-min)] min-h-[var(--touch-target-min)] flex items-center justify-center"
                aria-label="Dismiss notification"
              >
                <X size={14} />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast must be used inside ToastProvider");
  }
  return ctx;
}
