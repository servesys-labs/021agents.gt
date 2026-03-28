import { Card } from "./Card";

interface StatCardProps {
  icon: React.ReactNode;
  label: string;
  value: string | number;
}

export function StatCard({ icon, label, value }: StatCardProps) {
  return (
    <Card className="transition-all duration-200 hover:shadow-sm hover:border-primary/20">
      <div className="flex items-center gap-2 mb-1">
        {icon}
        <span className="text-xs text-text-secondary">{label}</span>
      </div>
      <p className="text-xl font-semibold text-text">{value}</p>
    </Card>
  );
}
