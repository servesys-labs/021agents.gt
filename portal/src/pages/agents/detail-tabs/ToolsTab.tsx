import { useState, useEffect } from "react";
import { Plus, X, Search } from "lucide-react";

import { type AgentConfig, type ToolInfo } from "../../../lib/adapters";
import { apiGet, apiPut } from "../../../lib/api";
import { useToast } from "../../../components/common/ToastProvider";

/* ── Props ────────────────────────────────────────────────────── */

type ToolsTabProps = {
  agent: AgentConfig;
  onAgentUpdated?: () => void;
};

/* ── Component ────────────────────────────────────────────────── */

export const ToolsTab = ({ agent, onAgentUpdated }: ToolsTabProps) => {
  const { showToast } = useToast();

  const [activeTools, setActiveTools] = useState<string[]>(agent.tools ?? []);
  const [availableTools, setAvailableTools] = useState<ToolInfo[]>([]);
  const [loadingAvailable, setLoadingAvailable] = useState(true);
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);

  /* Re-sync when agent changes */
  useEffect(() => {
    setActiveTools(agent.tools ?? []);
  }, [agent]);

  /* Fetch available tools */
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoadingAvailable(true);
      try {
        const data = await apiGet<ToolInfo[]>("/api/v1/tools");
        if (!cancelled) setAvailableTools(Array.isArray(data) ? data : []);
      } catch {
        if (!cancelled) setAvailableTools([]);
      } finally {
        if (!cancelled) setLoadingAvailable(false);
      }
    };
    void load();
    return () => { cancelled = true; };
  }, []);

  /* ── Helpers ────────────────────────────────────────────────── */

  const activeSet = new Set(activeTools);

  const filteredAvailable = availableTools.filter(
    (t) =>
      !activeSet.has(t.name) &&
      (search === "" ||
        t.name.toLowerCase().includes(search.toLowerCase()) ||
        (t.description ?? "").toLowerCase().includes(search.toLowerCase())),
  );

  const persistTools = async (newTools: string[]) => {
    setSaving(true);
    try {
      await apiPut(`/api/v1/agents/${agent.name}`, { tools: newTools });
      setActiveTools(newTools);
      showToast("Tools updated", "success");
      onAgentUpdated?.();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to update tools", "error");
    } finally {
      setSaving(false);
    }
  };

  const addTool = (name: string) => {
    if (activeSet.has(name)) return;
    void persistTools([...activeTools, name]);
  };

  const removeTool = (name: string) => {
    void persistTools(activeTools.filter((t) => t !== name));
  };

  /* ── Render ─────────────────────────────────────────────────── */

  return (
    <div className="space-y-6">
      {/* Active tools */}
      <div className="card">
        <h3 className="text-sm font-semibold text-text-primary mb-3">
          Active Tools ({activeTools.length})
        </h3>

        {activeTools.length === 0 ? (
          <div className="border border-border-default rounded-md p-6 flex items-center justify-center">
            <p className="text-xs text-text-muted">No tools attached. Add one below.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {activeTools.map((tool) => {
              const info = availableTools.find((t) => t.name === tool);
              return (
                <div
                  key={tool}
                  className="flex items-center justify-between gap-3 px-3 py-2 bg-surface-base border border-border-default rounded-md"
                >
                  <div className="flex-1 min-w-0">
                    <span className="text-sm font-mono text-text-secondary">{tool}</span>
                    {info?.description && (
                      <p className="text-xs text-text-muted mt-0.5 truncate">{info.description}</p>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => removeTool(tool)}
                    disabled={saving}
                    className="btn btn-ghost p-1 text-status-error hover:bg-status-error/10 flex-shrink-0"
                    style={{ minWidth: "var(--touch-target-min)", minHeight: "var(--touch-target-min)" }}
                    aria-label={`Remove ${tool}`}
                  >
                    <X size={14} />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Available tools */}
      <div className="card">
        <h3 className="text-sm font-semibold text-text-primary mb-3">Available Tools</h3>

        {/* Search */}
        <div className="relative mb-3">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search tools..."
            className="w-full text-sm pl-8"
            style={{ minHeight: "var(--touch-target-min)" }}
          />
        </div>

        {loadingAvailable ? (
          <p className="text-xs text-text-muted py-4 text-center">Loading tools...</p>
        ) : filteredAvailable.length === 0 ? (
          <p className="text-xs text-text-muted py-4 text-center">
            {search ? "No matching tools found." : "All tools are already added."}
          </p>
        ) : (
          <div className="space-y-2 max-h-[40vh] overflow-y-auto">
            {filteredAvailable.map((tool) => (
              <div
                key={tool.name}
                className="flex items-center justify-between gap-3 px-3 py-2 bg-surface-base border border-border-default rounded-md"
              >
                <div className="flex-1 min-w-0">
                  <span className="text-sm font-mono text-text-secondary">{tool.name}</span>
                  {tool.description && (
                    <p className="text-xs text-text-muted mt-0.5 truncate">{tool.description}</p>
                  )}
                  {tool.category && (
                    <span className="inline-block mt-1 text-[10px] font-medium uppercase tracking-wide text-text-muted bg-surface-overlay px-1.5 py-0.5 rounded">
                      {tool.category}
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => addTool(tool.name)}
                  disabled={saving}
                  className="btn btn-secondary flex-shrink-0"
                  style={{ minWidth: "var(--touch-target-min)", minHeight: "var(--touch-target-min)" }}
                  aria-label={`Add ${tool.name}`}
                >
                  <Plus size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
