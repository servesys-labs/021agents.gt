import { useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";

type CollapsibleSectionProps = {
  title: string;
  /** Item count shown as a badge next to the title */
  count?: number;
  /** Whether the section starts expanded */
  defaultOpen?: boolean;
  /** Optional icon before the title */
  icon?: ReactNode;
  children: ReactNode;
};

export function CollapsibleSection({
  title,
  count,
  defaultOpen = false,
  icon,
  children,
}: CollapsibleSectionProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="card">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between py-1 text-left"
        aria-expanded={open}
      >
        <div className="flex items-center gap-2">
          <ChevronRight
            size={14}
            className={`text-text-muted transition-transform duration-150 ${open ? "rotate-90" : ""}`}
          />
          {icon}
          <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
          {count != null && count > 0 && (
            <span className="px-1.5 py-0.5 text-[10px] font-bold bg-accent/10 text-accent rounded-full">
              {count}
            </span>
          )}
        </div>
      </button>

      <div
        className="grid transition-all duration-200 ease-out"
        style={{
          gridTemplateRows: open ? "1fr" : "0fr",
          opacity: open ? 1 : 0,
        }}
      >
        <div className="overflow-hidden">
          <div className="pt-4">{children}</div>
        </div>
      </div>
    </div>
  );
}
