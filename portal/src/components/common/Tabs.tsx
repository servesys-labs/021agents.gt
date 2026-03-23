import { useState, type ReactNode } from "react";

interface Tab {
  id: string;
  label: string;
  count?: number;
  content: ReactNode;
}

interface TabsProps {
  tabs: Tab[];
  defaultTab?: string;
}

export function Tabs({ tabs, defaultTab }: TabsProps) {
  const [active, setActive] = useState(defaultTab || tabs[0]?.id || "");

  const activeTab = tabs.find((t) => t.id === active);

  return (
    <div>
      <div className="flex items-center gap-0 border-b border-border-default mb-4">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActive(tab.id)}
            className={`px-4 py-2 text-xs font-medium transition-colors border-b-2 -mb-px ${
              active === tab.id
                ? "text-accent border-accent"
                : "text-text-muted border-transparent hover:text-text-secondary hover:border-border-strong"
            }`}
          >
            {tab.label}
            {tab.count !== undefined && (
              <span className="ml-1.5 px-1.5 py-0.5 text-[10px] rounded-full bg-surface-overlay text-text-muted">
                {tab.count}
              </span>
            )}
          </button>
        ))}
      </div>
      {activeTab?.content}
    </div>
  );
}
