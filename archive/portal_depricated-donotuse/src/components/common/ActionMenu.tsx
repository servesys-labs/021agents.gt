import { useState, useRef, useEffect, useCallback } from "react";
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
  const [focusIndex, setFocusIndex] = useState(-1);
  const ref = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    if (open) document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  // Focus management for keyboard nav
  useEffect(() => {
    if (open && focusIndex >= 0 && itemRefs.current[focusIndex]) {
      itemRefs.current[focusIndex]?.focus();
    }
  }, [focusIndex, open]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!open) return;
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setFocusIndex((prev) => (prev + 1) % items.length);
          break;
        case "ArrowUp":
          e.preventDefault();
          setFocusIndex((prev) => (prev - 1 + items.length) % items.length);
          break;
        case "Escape":
          e.preventDefault();
          setOpen(false);
          setFocusIndex(-1);
          break;
        case "Home":
          e.preventDefault();
          setFocusIndex(0);
          break;
        case "End":
          e.preventDefault();
          setFocusIndex(items.length - 1);
          break;
      }
    },
    [open, items.length],
  );

  const toggleMenu = () => {
    setOpen((prev) => {
      if (!prev) setFocusIndex(0);
      return !prev;
    });
  };

  return (
    <div ref={ref} className="relative inline-block" onKeyDown={handleKeyDown}>
      <button
        onClick={toggleMenu}
        className="p-2 min-w-[var(--touch-target-min)] min-h-[var(--touch-target-min)] rounded-md text-text-muted hover:text-text-primary hover:bg-surface-overlay transition-colors flex items-center justify-center"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Actions menu"
      >
        <MoreVertical size={14} />
      </button>

      {open && (
        <div
          className="absolute right-0 top-full mt-1 z-20 min-w-[160px] glass-dropdown border border-border-default rounded-lg py-1"
          style={{ animation: "fadeIn 0.15s ease-out" }}
          role="menu"
          aria-label="Actions"
        >
          {items.map((item, i) => (
            <button
              key={i}
              ref={(el) => { itemRefs.current[i] = el; }}
              onClick={() => {
                setOpen(false);
                item.onClick();
              }}
              disabled={item.disabled}
              role="menuitem"
              tabIndex={focusIndex === i ? 0 : -1}
              className={`w-full text-left flex items-center gap-2 px-3 py-2 min-h-[var(--touch-target-min)] text-xs transition-colors ${
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
