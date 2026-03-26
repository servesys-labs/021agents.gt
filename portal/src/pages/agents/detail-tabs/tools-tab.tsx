import { useCallback, useMemo, useState } from "react";
import { Plus, Search, Wrench, X } from "lucide-react";

import type { AgentConfig } from "../../../lib/adapters";
import { apiPut, useApiQuery } from "../../../lib/api";
import { EmptyState } from "../../../components/common/EmptyState";
import { QueryState } from "../../../components/common/QueryState";
import { useToast } from "../../../components/common/ToastProvider";

type ToolRegistryItem = {
  name: string;
  description?: string;
  source?: string;
  category?: string;
  input_schema?: Record<string, unknown>;
  examples?: string[];
  oauth_status?: string;
};

export function ToolsTab({
  agentName,
  config,
  onConfigUpdate,
}: {
  agentName?: string;
  config: AgentConfig | null;
  onConfigUpdate: () => Promise<void>;
}) {
  const { showToast } = useToast();
  const [searchQuery, setSearchQuery] = useState("");
  const [detailTool, setDetailTool] = useState<ToolRegistryItem | null>(null);

  const registryQuery = useApiQuery<{ tools: ToolRegistryItem[] } | ToolRegistryItem[]>("/api/v1/tools");

  const allTools: ToolRegistryItem[] = useMemo(() => {
    const raw = registryQuery.data;
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    return raw.tools ?? [];
  }, [registryQuery.data]);

  const activeToolNames = useMemo(() => new Set(config?.tools ?? []), [config]);

  const activeTools = useMemo(
    () =>
      (config?.tools ?? []).map((name) => {
        const reg = allTools.find((t) => t.name === name);
        return {
          name,
          description: reg?.description,
          source: reg?.source,
          oauth_status: reg?.oauth_status,
        };
      }),
    [config, allTools],
  );

  const filteredAvailable = useMemo(() => {
    let list = allTools.filter((t) => !activeToolNames.has(t.name));
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter(
        (t) =>
          t.name.toLowerCase().includes(q) ||
          (t.description ?? "").toLowerCase().includes(q) ||
          (t.category ?? "").toLowerCase().includes(q),
      );
    }
    return list;
  }, [allTools, activeToolNames, searchQuery]);

  const handleAddTool = useCallback(
    async (toolName: string) => {
      if (!agentName || !config) return;
      try {
        const newTools = [...(config.tools ?? []), toolName];
        await apiPut(`/api/v1/agents/${encodeURIComponent(agentName)}`, {
          tools: newTools,
        });
        showToast(`Added ${toolName}`, "success");
        await onConfigUpdate();
      } catch {
        showToast("Failed to add tool", "error");
      }
    },
    [agentName, config, showToast, onConfigUpdate],
  );

  const handleRemoveTool = useCallback(
    async (toolName: string) => {
      if (!agentName || !config) return;
      try {
        const newTools = (config.tools ?? []).filter((t) => t !== toolName);
        await apiPut(`/api/v1/agents/${encodeURIComponent(agentName)}`, {
          tools: newTools,
        });
        showToast(`Removed ${toolName}`, "success");
        await onConfigUpdate();
      } catch {
        showToast("Failed to remove tool", "error");
      }
    },
    [agentName, config, showToast, onConfigUpdate],
  );

  const categoryBadgeColor = (cat?: string) => {
    switch (cat?.toLowerCase()) {
      case "builtin":
        return "bg-chart-blue/15 text-chart-blue border-chart-blue/20";
      case "plugin":
        return "bg-chart-purple/15 text-chart-purple border-chart-purple/20";
      case "connector":
        return "bg-chart-orange/15 text-chart-orange border-chart-orange/20";
      default:
        return "bg-surface-overlay text-text-secondary border-border-default";
    }
  };

  return (
    <div className="max-w-4xl">
      <section className="mb-[var(--space-8)]">
        <h2 className="text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-3)]">
          Active Tools ({activeTools.length})
        </h2>
        {activeTools.length > 0 ? (
          <div className="space-y-[var(--space-2)]">
            {activeTools.map((tool) => (
              <div
                key={tool.name}
                className="card flex items-center gap-[var(--space-3)] py-[var(--space-3)]"
              >
                <div className="p-2 rounded-lg bg-accent-muted flex-shrink-0">
                  <Wrench size={14} className="text-accent" />
                </div>
                <div className="flex-1 min-w-0">
                  <button
                    onClick={() => {
                      const reg = allTools.find((t) => t.name === tool.name);
                      if (reg) setDetailTool(reg);
                    }}
                    className="text-[var(--text-sm)] font-medium text-text-primary hover:text-accent transition-colors text-left"
                  >
                    {tool.name}
                  </button>
                  {tool.description && (
                    <p className="text-[var(--text-xs)] text-text-muted truncate">{tool.description}</p>
                  )}
                </div>
                {tool.source === "pipedream" && tool.oauth_status && (
                  <span className="inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold border bg-chart-purple/15 text-chart-purple border-chart-purple/20">
                    via Pipedream
                  </span>
                )}
                <button
                  onClick={() => handleRemoveTool(tool.name)}
                  className="btn btn-ghost text-status-error p-[var(--space-1)] min-h-[var(--touch-target-min)] min-w-[var(--touch-target-min)]"
                  aria-label={`Remove ${tool.name}`}
                >
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState
            icon={<Wrench size={24} />}
            title="No tools assigned"
            description="Add tools from the library below."
          />
        )}
      </section>

      <section>
        <h2 className="text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-3)]">
          Tool Library
        </h2>

        <div className="relative mb-[var(--space-4)]">
          <Search
            size={16}
            className="absolute left-[var(--space-3)] top-1/2 -translate-y-1/2 text-text-muted pointer-events-none"
          />
          <input
            type="text"
            placeholder="Search tools..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-10 bg-surface-overlay"
          />
        </div>

        <QueryState loading={registryQuery.loading} error={registryQuery.error} onRetry={registryQuery.refetch}>
          {filteredAvailable.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-[var(--space-2)]">
              {filteredAvailable.map((tool) => (
                <div
                  key={tool.name}
                  className="card card-hover flex items-start gap-[var(--space-3)] py-[var(--space-3)]"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-[var(--space-2)] mb-[var(--space-1)]">
                      <button
                        onClick={() => setDetailTool(tool)}
                        className="text-[var(--text-sm)] font-medium text-text-primary hover:text-accent transition-colors text-left"
                      >
                        {tool.name}
                      </button>
                      {tool.category && (
                        <span
                          className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase border ${categoryBadgeColor(tool.category)}`}
                        >
                          {tool.category}
                        </span>
                      )}
                    </div>
                    {tool.description && (
                      <p className="text-[var(--text-xs)] text-text-muted line-clamp-2">{tool.description}</p>
                    )}
                    {tool.source === "pipedream" && (
                      <span className="inline-flex items-center gap-1 text-[10px] text-chart-purple mt-[var(--space-1)]">
                        via Pipedream
                      </span>
                    )}
                  </div>
                  <button
                    onClick={() => handleAddTool(tool.name)}
                    className="btn btn-secondary text-[var(--text-xs)] min-h-[var(--touch-target-min)] flex-shrink-0"
                  >
                    <Plus size={12} />
                    Add
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState
              icon={<Wrench size={24} />}
              title="No available tools"
              description={
                searchQuery ? `No tools match "${searchQuery}"` : "All tools are already assigned."
              }
            />
          )}
        </QueryState>
      </section>

      {detailTool && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div className="absolute inset-0 glass-backdrop" onClick={() => setDetailTool(null)} />
          <div className="relative w-full max-w-md h-full overflow-y-auto glass-medium border-l border-border-default shadow-panel p-[var(--space-6)]">
            <div className="flex items-center justify-between mb-[var(--space-6)]">
              <h2 className="text-[var(--text-md)] font-bold text-text-primary">{detailTool.name}</h2>
              <button
                onClick={() => setDetailTool(null)}
                className="btn btn-ghost p-[var(--space-2)] min-h-[var(--touch-target-min)] min-w-[var(--touch-target-min)]"
                aria-label="Close"
              >
                <X size={16} />
              </button>
            </div>

            <div className="space-y-[var(--space-4)]">
              {detailTool.description && (
                <div>
                  <label className="block text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-1)]">
                    Description
                  </label>
                  <p className="text-[var(--text-sm)] text-text-primary">{detailTool.description}</p>
                </div>
              )}
              {detailTool.category && (
                <div>
                  <label className="block text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-1)]">
                    Category
                  </label>
                  <span
                    className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase border ${categoryBadgeColor(detailTool.category)}`}
                  >
                    {detailTool.category}
                  </span>
                </div>
              )}
              {detailTool.source && (
                <div>
                  <label className="block text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-1)]">
                    Source
                  </label>
                  <p className="text-[var(--text-sm)] text-text-primary">{detailTool.source}</p>
                </div>
              )}
              {detailTool.input_schema && (
                <div>
                  <label className="block text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-1)]">
                    Input Parameters
                  </label>
                  <pre className="text-[var(--text-xs)] text-text-secondary bg-surface-base rounded-lg p-[var(--space-3)] overflow-x-auto font-mono">
                    {JSON.stringify(detailTool.input_schema, null, 2)}
                  </pre>
                </div>
              )}
              {detailTool.examples && detailTool.examples.length > 0 && (
                <div>
                  <label className="block text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-1)]">
                    Examples
                  </label>
                  <ul className="space-y-[var(--space-1)]">
                    {detailTool.examples.map((ex, i) => (
                      <li
                        key={i}
                        className="text-[var(--text-xs)] text-text-secondary font-mono bg-surface-base rounded px-[var(--space-2)] py-[var(--space-1)]"
                      >
                        {ex}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            <div className="mt-[var(--space-6)]">
              {activeToolNames.has(detailTool.name) ? (
                <button
                  onClick={() => {
                    handleRemoveTool(detailTool.name);
                    setDetailTool(null);
                  }}
                  className="btn btn-secondary text-status-error text-[var(--text-xs)] w-full min-h-[var(--touch-target-min)]"
                >
                  <X size={14} />
                  Remove from Agent
                </button>
              ) : (
                <button
                  onClick={() => {
                    handleAddTool(detailTool.name);
                    setDetailTool(null);
                  }}
                  className="btn btn-primary text-[var(--text-xs)] w-full min-h-[var(--touch-target-min)]"
                >
                  <Plus size={14} />
                  Add to Agent
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
