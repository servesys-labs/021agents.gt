import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
  Wrench,
  Search,
  Plus,
  Cpu,
  Database,
  Globe,
  Server,
  Puzzle,
  BarChart3,
} from "lucide-react";

import { PageHeader } from "../../components/common/PageHeader";
import { EmptyState } from "../../components/common/EmptyState";

/* -- Types --------------------------------------------------------- */

type ToolCategory = "LLM" | "Data" | "API" | "System" | "Custom";

interface Tool {
  name: string;
  description: string;
  category: ToolCategory;
  version: string;
  usage_count: number;
}

/* -- Category helpers ---------------------------------------------- */

const CATEGORIES: readonly ToolCategory[] = [
  "LLM",
  "Data",
  "API",
  "System",
  "Custom",
];

const categoryMeta: Record<
  ToolCategory,
  { icon: typeof Cpu; color: string; badgeClass: string }
> = {
  LLM: {
    icon: Cpu,
    color: "var(--color-chart-purple)",
    badgeClass: "bg-chart-purple/15 text-chart-purple border-chart-purple/20",
  },
  Data: {
    icon: Database,
    color: "var(--color-chart-blue)",
    badgeClass: "bg-chart-blue/15 text-chart-blue border-chart-blue/20",
  },
  API: {
    icon: Globe,
    color: "var(--color-chart-cyan)",
    badgeClass: "bg-chart-cyan/15 text-chart-cyan border-chart-cyan/20",
  },
  System: {
    icon: Server,
    color: "var(--color-chart-orange)",
    badgeClass: "bg-chart-orange/15 text-chart-orange border-chart-orange/20",
  },
  Custom: {
    icon: Puzzle,
    color: "var(--color-chart-green)",
    badgeClass: "bg-chart-green/15 text-chart-green border-chart-green/20",
  },
};

/* -- Mock data ----------------------------------------------------- */

const MOCK_TOOLS: Tool[] = [
  {
    name: "openai-chat",
    description: "Send chat completions to OpenAI models with streaming support.",
    category: "LLM",
    version: "1.4.0",
    usage_count: 12_843,
  },
  {
    name: "pg-query",
    description: "Execute read-only SQL queries against a Postgres database.",
    category: "Data",
    version: "2.1.0",
    usage_count: 8_421,
  },
  {
    name: "http-request",
    description: "Make HTTP requests to external APIs with configurable auth.",
    category: "API",
    version: "3.0.1",
    usage_count: 15_209,
  },
  {
    name: "file-reader",
    description: "Read files from the agent sandbox filesystem.",
    category: "System",
    version: "1.0.0",
    usage_count: 6_712,
  },
  {
    name: "vector-search",
    description: "Semantic similarity search over vector embeddings.",
    category: "Data",
    version: "1.2.3",
    usage_count: 4_310,
  },
  {
    name: "slack-notify",
    description: "Send messages and notifications to Slack channels.",
    category: "API",
    version: "2.0.0",
    usage_count: 3_890,
  },
  {
    name: "anthropic-chat",
    description: "Send prompts to Anthropic Claude models with tool use.",
    category: "LLM",
    version: "1.1.0",
    usage_count: 9_102,
  },
  {
    name: "custom-transform",
    description: "User-defined data transformation pipeline step.",
    category: "Custom",
    version: "0.3.0",
    usage_count: 1_420,
  },
];

/* -- Component ----------------------------------------------------- */

export function ToolRegistryPage() {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState<ToolCategory | null>(
    null,
  );

  /* In production this would be useApiQuery<Tool[]>("/api/v1/tools") */
  const [tools] = useState<Tool[]>(MOCK_TOOLS);

  const filtered = useMemo(() => {
    let result = tools;
    if (activeCategory) {
      result = result.filter((t) => t.category === activeCategory);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(
        (t) =>
          t.name.toLowerCase().includes(q) ||
          t.description.toLowerCase().includes(q),
      );
    }
    return result;
  }, [tools, search, activeCategory]);

  const isEmpty = tools.length === 0;

  return (
    <div className="p-6 bg-surface-base min-h-screen">
      <PageHeader
        title="Tool Registry"
        subtitle="Browse, test, and manage tools available to your agents."
        icon={<Wrench size={18} />}
        actions={
          <button
            className="btn btn-primary text-xs"
            onClick={() => navigate("/tools/new")}
          >
            <Plus size={14} />
            Create Tool
          </button>
        }
      />

      {isEmpty ? (
        <EmptyState
          icon={<Wrench size={32} />}
          title="No tools registered"
          description="Create your first tool to give your agents new capabilities."
          actionLabel="Create Tool"
          onAction={() => navigate("/tools/new")}
        />
      ) : (
        <>
          {/* Search + Filters */}
          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 mb-6">
            <div className="relative flex-1 max-w-md">
              <Search
                size={14}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none"
              />
              <input
                type="search"
                placeholder="Search tools..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-8 pr-3 py-2 text-sm w-full"
                style={{ minHeight: "var(--touch-target-min)" }}
              />
            </div>

            <div className="flex items-center gap-1.5 flex-wrap">
              <button
                className={`filter-chip ${!activeCategory ? "filter-chip-active" : ""}`}
                onClick={() => setActiveCategory(null)}
              >
                All
              </button>
              {CATEGORIES.map((cat) => {
                const meta = categoryMeta[cat];
                const Icon = meta.icon;
                return (
                  <button
                    key={cat}
                    className={`filter-chip ${activeCategory === cat ? "filter-chip-active" : ""}`}
                    onClick={() =>
                      setActiveCategory(activeCategory === cat ? null : cat)
                    }
                  >
                    <Icon size={10} />
                    {cat}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Tool grid */}
          {filtered.length === 0 ? (
            <EmptyState
              icon={<Search size={28} />}
              title="No tools match your search"
              description="Try a different query or clear the filters."
            />
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {filtered.map((tool, i) => {
                const meta = categoryMeta[tool.category];
                const CatIcon = meta.icon;
                return (
                  <button
                    key={tool.name}
                    className="agent-card card-lift text-left stagger-item"
                    style={
                      {
                        "--stagger-index": i,
                        cursor: "pointer",
                      } as React.CSSProperties
                    }
                    onClick={() => navigate(`/tools/${tool.name}`)}
                    aria-label={`View tool ${tool.name}`}
                  >
                    <div className="p-4 flex flex-col gap-3 h-full">
                      {/* Header row */}
                      <div className="flex items-start justify-between gap-2">
                        <div
                          className="flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center"
                          style={{
                            background: `color-mix(in srgb, ${meta.color} 15%, transparent)`,
                            color: meta.color,
                          }}
                        >
                          <CatIcon size={16} />
                        </div>
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded-full text-2xs font-medium border ${meta.badgeClass}`}
                        >
                          {tool.category}
                        </span>
                      </div>

                      {/* Name + description */}
                      <div className="flex-1 min-w-0">
                        <h3 className="text-sm font-semibold text-text-primary truncate font-mono">
                          {tool.name}
                        </h3>
                        <p className="mt-1 text-xs text-text-muted leading-relaxed line-clamp-2">
                          {tool.description}
                        </p>
                      </div>

                      {/* Footer */}
                      <div className="flex items-center justify-between pt-2 border-t border-border-subtle">
                        <span className="text-2xs text-text-muted font-mono">
                          v{tool.version}
                        </span>
                        <span className="inline-flex items-center gap-1 text-2xs text-text-muted">
                          <BarChart3 size={10} />
                          {tool.usage_count.toLocaleString()}
                        </span>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
