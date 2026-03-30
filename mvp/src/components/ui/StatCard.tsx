interface StatCardProps {
  icon: React.ReactNode;
  label: string;
  value: string | number;
}

export function StatCard({ icon, label, value }: StatCardProps) {
  return (
    <div className="flex items-center gap-3 bg-surface rounded-lg border border-border px-4 py-3 transition-all duration-200 hover:shadow-sm hover:border-primary/20">
      <div className="shrink-0">{icon}</div>
      <div className="min-w-0">
        <p className="text-xs text-text-secondary leading-none">{label}</p>
        <p className="text-lg font-semibold text-text mt-0.5 leading-tight">{value}</p>
      </div>
    </div>
  );
}
