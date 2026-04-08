/* ── Types ──────────────────────────────────────────────────────── */

export interface FilterOption {
  value: string;
  label: string;
}

export interface FilterConfig {
  key: string;
  label: string;
  options: FilterOption[];
  value: string;
  onChange: (value: string) => void;
}

export interface FilterBarProps {
  filters: FilterConfig[];
  className?: string;
}

/* ── Component ──────────────────────────────────────────────────── */

export function FilterBar({ filters, className = "" }: FilterBarProps) {
  return (
    <div
      className={`flex items-center gap-3 flex-wrap ${className}`}
    >
      {filters.map((filter) => (
        <select
          key={filter.key}
          value={filter.value}
          onChange={(e) => filter.onChange(e.target.value)}
          aria-label={filter.label}
          className="px-3 py-2 text-xs rounded-lg bg-surface-base border border-border-default text-text-primary min-h-[44px] transition-colors hover:border-accent/40 focus:outline-none focus:ring-2 focus:ring-accent/40"
        >
          {filter.options.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      ))}
    </div>
  );
}
