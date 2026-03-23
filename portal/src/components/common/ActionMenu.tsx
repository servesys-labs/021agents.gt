import { useState, useRef, useEffect } from "react";
import { MoreVertical } from "lucide-react";

export interface ActionMenuItem {
  label: string;
  icon?: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}

interface ActionMenuProps {
  items: ActionMenuItem[];
}

export function ActionMenu({ items }: ActionMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    if (open) document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  return (
    <div ref={ref} className="relative inline-block">
      <button
        onClick={() => setOpen(!open)}
        className="p-1 rounded-md text-text-muted hover:text-text-primary hover:bg-surface-overlay transition-colors"
      >
        <MoreVertical size={14} />
      </button>

      {open && (
        <div
          className="absolute right-0 top-full mt-1 z-20 min-w-[160px] glass-dropdown border border-border-default rounded-lg py-1"
          style={{ animation: "fadeIn 0.15s ease-out" }}
        >
          {items.map((item, i) => (
            <button
              key={i}
              onClick={() => {
                setOpen(false);
                item.onClick();
              }}
              disabled={item.disabled}
              className={`w-full text-left flex items-center gap-2 px-3 py-1.5 text-xs transition-colors ${
                item.danger
                  ? "text-status-error hover:bg-status-error/10"
                  : "text-text-secondary hover:bg-surface-overlay hover:text-text-primary"
              } ${item.disabled ? "opacity-40 cursor-not-allowed" : ""}`}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
