import type { LucideIcon } from "lucide-react";

type PlaceholderTabProps = {
  title: string;
  description: string;
  icon: LucideIcon;
};

export function PlaceholderTab({ title, description, icon: Icon }: PlaceholderTabProps) {
  return (
    <div className="flex flex-col items-center justify-center py-[var(--space-12)]">
      <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-surface-overlay mb-[var(--space-4)]">
        <Icon size={28} className="text-text-muted" />
      </div>
      <h2 className="text-[var(--text-md)] font-semibold text-text-primary mb-[var(--space-2)]">
        {title}
      </h2>
      <p className="text-[var(--text-sm)] text-text-muted text-center max-w-sm">
        {description}. This tab will be fully built in a future iteration.
      </p>
    </div>
  );
}
