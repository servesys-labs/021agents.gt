import { useState, type ReactNode } from "react";

interface ContentTab {
  id: string;
  label: string;
  count?: number;
  content: ReactNode;
}

interface TabsProps {
  tabs: ContentTab[] | string[];
  activeIndex?: number;
  onChange?: (index: number) => void;
  defaultTab?: string;
}

export function Tabs({ tabs, activeIndex, onChange, defaultTab }: TabsProps) {
  const isSimpleTabs = typeof tabs[0] === "string";
  const contentTabs = (isSimpleTabs ? [] : tabs) as ContentTab[];
  const stringTabs = (isSimpleTabs ? tabs : []) as string[];

  const [internalIndex, setInternalIndex] = useState(
    activeIndex ?? Math.max(0, contentTabs.findIndex((t) => t.id === defaultTab)),
  );
  const resolvedIndex = activeIndex ?? internalIndex;

  const [activeId, setActiveId] = useState(defaultTab || contentTabs[0]?.id || "");
  const activeTab = contentTabs.find((t) => t.id === activeId);

  const setIndex = (idx: number) => {
    if (onChange) onChange(idx);
    if (activeIndex === undefined) setInternalIndex(idx);
  };

  return (
    <div>
      <div className="flex items-center gap-0 border-b border-border-default mb-4">
        {isSimpleTabs
          ? stringTabs.map((label, idx) => (
              <button
                key={`${label}-${idx}`}
                onClick={() => setIndex(idx)}
                className={`px-4 py-2 text-xs font-medium transition-colors border-b-2 -mb-px ${
                  resolvedIndex === idx
                    ? "text-accent border-accent"
                    : "text-text-muted border-transparent hover:text-text-secondary hover:border-border-strong"
                }`}
              >
                {label}
              </button>
            ))
          : contentTabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveId(tab.id)}
                className={`px-4 py-2 text-xs font-medium transition-colors border-b-2 -mb-px ${
                  activeId === tab.id
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
      {!isSimpleTabs && activeTab?.content}
    </div>
  );
}
