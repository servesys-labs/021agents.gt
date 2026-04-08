import { useState, type ReactNode } from "react";

interface Tab {
  id: string;
  label: string;
  count?: number;
  content?: ReactNode;
}

interface TabsProps {
  tabs: Tab[] | string[];
  defaultTab?: string;
  activeIndex?: number;
  onChange?: (index: number) => void;
}

export function Tabs({ tabs, defaultTab, activeIndex, onChange }: TabsProps) {
  const isLegacy = typeof tabs[0] === "string";
  const stringTabs = isLegacy ? (tabs as string[]) : [];
  const objectTabs = !isLegacy ? (tabs as Tab[]) : [];
  
  const [active, setActive] = useState(defaultTab || objectTabs[0]?.id || "");
  const [legacyActive, setLegacyActive] = useState(activeIndex ?? 0);

  const handleLegacyClick = (index: number) => {
    setLegacyActive(index);
    onChange?.(index);
  };

  // Legacy API (string array with activeIndex/onChange)
  if (isLegacy) {
    return (
      <div className="flex items-center gap-0 border-b border-border-default mb-4">
        {stringTabs.map((label, index) => (
          <button
            key={label}
            onClick={() => handleLegacyClick(index)}
            role="tab"
            aria-selected={legacyActive === index}
            className={`tab-underline px-4 py-2 text-xs font-medium transition-colors border-b-2 -mb-px ${
              legacyActive === index
                ? "text-accent border-accent"
                : "text-text-muted border-transparent hover:text-text-secondary"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
    );
  }

  // New API (Tab objects with content)
  const activeTab = objectTabs.find((t) => t.id === active);

  return (
    <div>
      <div className="flex items-center gap-0 border-b border-border-default mb-4">
        {objectTabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActive(tab.id)}
            role="tab"
            aria-selected={active === tab.id}
            className={`tab-underline px-4 py-2 text-xs font-medium transition-colors border-b-2 -mb-px ${
              active === tab.id
                ? "text-accent border-transparent"
                : "text-text-muted border-transparent hover:text-text-secondary"
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
