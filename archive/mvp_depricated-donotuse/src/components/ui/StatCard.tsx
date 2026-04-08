interface StatCardProps {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  subtitle?: string;
}

export function StatCard({ icon, label, value, subtitle }: StatCardProps) {
  return (
    <div className="bg-surface rounded-xl border border-border px-4 py-3.5 transition-all duration-200 hover:shadow-sm hover:border-primary/20">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-medium text-text-muted uppercase tracking-wide leading-none">{label}</p>
          <p className="text-2xl font-bold text-text mt-1.5 leading-tight tabular-nums">{value}</p>
          {subtitle && (
            <p className="text-[10px] text-text-muted mt-1 leading-tight">{subtitle}</p>
          )}
        </div>
        <div className="shrink-0 w-9 h-9 rounded-lg bg-surface-alt flex items-center justify-center">
          {icon}
        </div>
      </div>
    </div>
  );
}
