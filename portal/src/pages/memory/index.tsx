import { useMemo, useState } from "react";
import {
  Plus,
  Trash2,
  Search,
  Pencil,
  Check,
  X,
  BookOpen,
  Lightbulb,
  Workflow,
} from "lucide-react";

import { PageHeader } from "../../components/common/PageHeader";
import { FormField } from "../../components/common/FormField";
import { SlidePanel } from "../../components/common/SlidePanel";
import { EmptyState } from "../../components/common/EmptyState";
import { ConfirmDialog } from "../../components/common/ConfirmDialog";
import { Tabs } from "../../components/common/Tabs";
import { useToast } from "../../components/common/ToastProvider";
import { safeArray, type AgentInfo } from "../../lib/adapters";
import { apiRequest, useApiQuery } from "../../lib/api";
import { extractList } from "../../lib/normalize";

type Episode = { id?: string; input?: string; output?: string; metadata?: Record<string, unknown> };
type Fact = { key: string; value?: string; content?: string; category?: string; confidence?: number };
type Procedure = { procedure_id?: string; name?: string; success_rate?: number; steps?: unknown[] };

type EpisodesResponse = { episodes?: Episode[] };
type FactsResponse = { facts?: Fact[] };
type ProceduresResponse = { procedures?: Procedure[] };

export const MemoryPage = () => {
  const { showToast } = useToast();

  /* ── Agent selection ──────────────────────────────────────── */
  const agentsQuery = useApiQuery<AgentInfo[]>("/api/v1/agents?limit=100");
  const agents = safeArray<AgentInfo>(agentsQuery.data);
  const [selectedAgent, setAgentName] = useState("default");
  const [query, setQuery] = useState("");

  /* ── Memory queries ───────────────────────────────────────── */
  const episodesQuery = useApiQuery<EpisodesResponse>(
    `/api/v1/memory/${encodeURIComponent(selectedAgent)}/episodes?query=${encodeURIComponent(query)}&limit=50`,
  );
  const factsQuery = useApiQuery<FactsResponse>(
    `/api/v1/memory/${encodeURIComponent(selectedAgent)}/facts?query=${encodeURIComponent(query)}&limit=50`,
  );
  const proceduresQuery = useApiQuery<ProceduresResponse>(
    `/api/v1/memory/${encodeURIComponent(selectedAgent)}/procedures?limit=50`,
  );

  const episodes = useMemo(() => extractList<Episode>(episodesQuery.data, "episodes"), [episodesQuery.data]);
  const facts = useMemo(() => extractList<Fact>(factsQuery.data, "facts"), [factsQuery.data]);
  const procedures = useMemo(() => extractList<Procedure>(proceduresQuery.data, "procedures"), [proceduresQuery.data]);

  /* ── Add episode panel ────────────────────────────────────── */
  const [episodePanelOpen, setEpisodePanelOpen] = useState(false);
  const [episodeForm, setEpisodeForm] = useState({ input: "", output: "" });

  /* ── Add/edit fact panel ──────────────────────────────────── */
  const [factPanelOpen, setFactPanelOpen] = useState(false);
  const [factForm, setFactForm] = useState({ key: "", value: "", category: "" });
  const [factMode, setFactMode] = useState<"create" | "edit">("create");

  /* ── Inline editing ───────────────────────────────────────── */
  const [editingFactKey, setEditingFactKey] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState("");

  /* ── Confirm dialog ───────────────────────────────────────── */
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmAction, setConfirmAction] = useState<{
    title: string;
    desc: string;
    action: () => Promise<void>;
  } | null>(null);

  const refresh = async () => {
    await Promise.all([
      episodesQuery.refetch(),
      factsQuery.refetch(),
      proceduresQuery.refetch(),
    ]);
  };

  /* ── Episode actions ──────────────────────────────────────── */
  const handleCreateEpisode = async () => {
    if (!episodeForm.input.trim()) return;
    try {
      await apiRequest(
        `/api/v1/memory/${encodeURIComponent(selectedAgent)}/episodes`,
        "POST",
        { input: episodeForm.input, output: episodeForm.output },
      );
      showToast("Episode added", "success");
      setEpisodePanelOpen(false);
      setEpisodeForm({ input: "", output: "" });
      void episodesQuery.refetch();
    } catch {
      showToast("Failed to add episode", "error");
    }
  };

  /* ── Fact actions ─────────────────────────────────────────── */
  const handleUpsertFact = async () => {
    if (!factForm.key.trim()) return;
    try {
      await apiRequest(
        `/api/v1/memory/${encodeURIComponent(selectedAgent)}/facts`,
        "POST",
        { key: factForm.key, value: factForm.value, category: factForm.category },
      );
      showToast(factMode === "create" ? "Fact created" : "Fact updated", "success");
      setFactPanelOpen(false);
      setFactForm({ key: "", value: "", category: "" });
      void factsQuery.refetch();
    } catch {
      showToast("Failed to save fact", "error");
    }
  };

  const handleInlineSave = async (key: string) => {
    try {
      await apiRequest(
        `/api/v1/memory/${encodeURIComponent(selectedAgent)}/facts`,
        "POST",
        { key, value: editingValue },
      );
      showToast("Fact updated", "success");
      setEditingFactKey(null);
      void factsQuery.refetch();
    } catch {
      showToast("Update failed", "error");
    }
  };

  const handleDeleteFact = (key: string) => {
    setConfirmAction({
      title: "Delete Fact",
      desc: `Delete fact "${key}"?`,
      action: async () => {
        await apiRequest(
          `/api/v1/memory/${encodeURIComponent(selectedAgent)}/facts/${encodeURIComponent(key)}`,
          "DELETE",
        );
        showToast("Fact deleted", "success");
        void factsQuery.refetch();
      },
    });
    setConfirmOpen(true);
  };

  /* ── Clear section ────────────────────────────────────────── */
  const handleClearSection = (section: string, path: string) => {
    setConfirmAction({
      title: `Clear ${section}`,
      desc: `This will permanently delete all ${section.toLowerCase()} for "${selectedAgent}". Continue?`,
      action: async () => {
        await apiRequest(path, "DELETE");
        showToast(`${section} cleared`, "success");
        void refresh();
      },
    });
    setConfirmOpen(true);
  };

  /* ── Episodes tab ─────────────────────────────────────────── */
  const episodesTab = (
    <div>
      <div className="flex items-center justify-between mb-4">
        <span className="text-xs text-text-muted">{episodes.length} episodes</span>
        <div className="flex items-center gap-2">
          <button
            className="btn btn-primary text-xs"
            onClick={() => {
              setEpisodeForm({ input: "", output: "" });
              setEpisodePanelOpen(true);
            }}
          >
            <Plus size={12} />
            Add Episode
          </button>
          <button
            className="btn btn-secondary text-xs"
            onClick={() =>
              handleClearSection(
                "Episodes",
                `/api/v1/memory/${encodeURIComponent(selectedAgent)}/episodes`,
              )
            }
          >
            <Trash2 size={12} />
            Clear
          </button>
        </div>
      </div>
      {episodes.length === 0 ? (
        <EmptyState
          icon={<BookOpen size={40} />}
          title="No episodes"
          description="Episodes store input/output pairs from agent interactions"
        />
      ) : (
        <div className="space-y-2">
          {episodes.map((ep, i) => (
            <div
              key={ep.id ?? i}
              className="card py-3 px-4"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-text-primary font-medium mb-1">
                    Input
                  </p>
                  <p className="text-xs text-text-secondary mb-2">
                    {(ep.input || "").slice(0, 200)}
                  </p>
                  {ep.output && (
                    <>
                      <p className="text-xs text-text-primary font-medium mb-1">
                        Output
                      </p>
                      <p className="text-xs text-text-muted">
                        {ep.output.slice(0, 200)}
                      </p>
                    </>
                  )}
                </div>
                <span className="text-[10px] text-text-muted font-mono shrink-0">
                  {ep.id?.slice(0, 8)}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  /* ── Facts tab ────────────────────────────────────────────── */
  const factsTab = (
    <div>
      <div className="flex items-center justify-between mb-4">
        <span className="text-xs text-text-muted">{facts.length} facts</span>
        <div className="flex items-center gap-2">
          <button
            className="btn btn-primary text-xs"
            onClick={() => {
              setFactForm({ key: "", value: "", category: "" });
              setFactMode("create");
              setFactPanelOpen(true);
            }}
          >
            <Plus size={12} />
            Add Fact
          </button>
          <button
            className="btn btn-secondary text-xs"
            onClick={() =>
              handleClearSection(
                "Facts",
                `/api/v1/memory/${encodeURIComponent(selectedAgent)}/facts`,
              )
            }
          >
            <Trash2 size={12} />
            Clear
          </button>
        </div>
      </div>
      {facts.length === 0 ? (
        <EmptyState
          icon={<Lightbulb size={40} />}
          title="No facts"
          description="Facts are key-value pairs the agent can reference"
        />
      ) : (
        <div className="card p-0">
          <div className="overflow-x-auto">
            <table>
              <thead>
                <tr>
                  <th>Key</th>
                  <th>Value</th>
                  <th>Category</th>
                  <th style={{ width: "80px" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {facts.map((fact) => (
                  <tr key={fact.key}>
                    <td>
                      <span className="font-mono text-xs text-text-primary">
                        {fact.key}
                      </span>
                    </td>
                    <td>
                      {editingFactKey === fact.key ? (
                        <div className="flex items-center gap-1">
                          <input
                            type="text"
                            value={editingValue}
                            onChange={(e) => setEditingValue(e.target.value)}
                            className="text-xs flex-1"
                            autoFocus
                            onKeyDown={(e) => {
                              if (e.key === "Enter")
                                void handleInlineSave(fact.key);
                              if (e.key === "Escape") setEditingFactKey(null);
                            }}
                          />
                          <button
                            className="p-1 text-status-live hover:bg-status-live/10 rounded"
                            onClick={() => void handleInlineSave(fact.key)}
                          >
                            <Check size={12} />
                          </button>
                          <button
                            className="p-1 text-text-muted hover:bg-surface-overlay rounded"
                            onClick={() => setEditingFactKey(null)}
                          >
                            <X size={12} />
                          </button>
                        </div>
                      ) : (
                        <span className="text-xs text-text-secondary">
                          {(fact.value || fact.content || "").slice(0, 80)}
                        </span>
                      )}
                    </td>
                    <td>
                      {fact.category && (
                        <span className="px-1.5 py-0.5 text-[10px] bg-surface-overlay text-text-muted rounded border border-border-default">
                          {fact.category}
                        </span>
                      )}
                    </td>
                    <td>
                      <div className="flex items-center gap-1">
                        <button
                          className="p-1 text-text-muted hover:text-text-primary hover:bg-surface-overlay rounded transition-colors"
                          onClick={() => {
                            setEditingFactKey(fact.key);
                            setEditingValue(
                              fact.value || fact.content || "",
                            );
                          }}
                          title="Edit inline"
                        >
                          <Pencil size={12} />
                        </button>
                        <button
                          className="p-1 text-text-muted hover:text-status-error hover:bg-status-error/10 rounded transition-colors"
                          onClick={() => handleDeleteFact(fact.key)}
                          title="Delete"
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );

  /* ── Procedures tab ───────────────────────────────────────── */
  const proceduresTab = (
    <div>
      <div className="flex items-center justify-between mb-4">
        <span className="text-xs text-text-muted">
          {procedures.length} procedures
        </span>
        <button
          className="btn btn-secondary text-xs"
          onClick={() =>
            handleClearSection(
              "Procedures",
              `/api/v1/memory/${encodeURIComponent(selectedAgent)}/procedures`,
            )
          }
        >
          <Trash2 size={12} />
          Clear
        </button>
      </div>
      {procedures.length === 0 ? (
        <EmptyState
          icon={<Workflow size={40} />}
          title="No procedures"
          description="Procedures are learned multi-step patterns"
        />
      ) : (
        <div className="card p-0">
          <div className="overflow-x-auto">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Success Rate</th>
                  <th>ID</th>
                </tr>
              </thead>
              <tbody>
                {procedures.map((proc, i) => (
                  <tr key={proc.procedure_id ?? i}>
                    <td>
                      <span className="text-text-primary text-sm">
                        {proc.name || proc.procedure_id || "Unnamed"}
                      </span>
                    </td>
                    <td>
                      <div className="flex items-center gap-2">
                        <div className="w-16 h-1.5 bg-surface-overlay rounded-full overflow-hidden">
                          <div
                            className="h-full bg-chart-green rounded-full"
                            style={{
                              width: `${((proc.success_rate ?? 0) * 100).toFixed(0)}%`,
                            }}
                          />
                        </div>
                        <span className="text-[10px] text-text-muted font-mono">
                          {((proc.success_rate ?? 0) * 100).toFixed(1)}%
                        </span>
                      </div>
                    </td>
                    <td>
                      <span className="font-mono text-[10px] text-text-muted">
                        {proc.procedure_id?.slice(0, 12)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );

  return (
    <div>
      <PageHeader
        title="Memory Management"
        subtitle="Episodes, facts, and procedures"
        onRefresh={() => void refresh()}
      />

      {/* Agent selector & search */}
      <div className="card mb-4">
        <div className="grid gap-3 md:grid-cols-3">
          <FormField label="Agent">
            <select
              value={selectedAgent}
              onChange={(e) => setAgentName(e.target.value)}
              className="text-sm"
            >
              <option value="default">default</option>
              {agents.map((a) => (
                <option key={a.name} value={a.name}>
                  {a.name}
                </option>
              ))}
            </select>
          </FormField>
          <FormField label="Search Query">
            <div className="relative">
              <Search
                size={14}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
              />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search memories..."
                className="pl-8 text-sm"
              />
            </div>
          </FormField>
          <div className="flex items-end">
            <button
              className="btn btn-secondary text-xs w-full"
              onClick={() => void refresh()}
            >
              <Search size={14} />
              Search
            </button>
          </div>
        </div>
      </div>

      {/* Memory stats */}
      <div className="grid grid-cols-3 gap-3 mb-4">
        <div className="card flex items-center gap-3 py-3">
          <div className="p-2 rounded-lg bg-chart-purple/10">
            <BookOpen size={14} className="text-chart-purple" />
          </div>
          <div>
            <p className="text-lg font-bold text-text-primary font-mono">
              {episodes.length}
            </p>
            <p className="text-[10px] text-text-muted uppercase">Episodes</p>
          </div>
        </div>
        <div className="card flex items-center gap-3 py-3">
          <div className="p-2 rounded-lg bg-accent/10">
            <Lightbulb size={14} className="text-accent" />
          </div>
          <div>
            <p className="text-lg font-bold text-text-primary font-mono">
              {facts.length}
            </p>
            <p className="text-[10px] text-text-muted uppercase">Facts</p>
          </div>
        </div>
        <div className="card flex items-center gap-3 py-3">
          <div className="p-2 rounded-lg bg-chart-cyan/10">
            <Workflow size={14} className="text-chart-cyan" />
          </div>
          <div>
            <p className="text-lg font-bold text-text-primary font-mono">
              {procedures.length}
            </p>
            <p className="text-[10px] text-text-muted uppercase">Procedures</p>
          </div>
        </div>
      </div>

      {/* Tabbed content */}
      <Tabs
        tabs={[
          { id: "episodes", label: "Episodes", count: episodes.length, content: episodesTab },
          { id: "facts", label: "Facts", count: facts.length, content: factsTab },
          { id: "procedures", label: "Procedures", count: procedures.length, content: proceduresTab },
        ]}
        defaultTab="facts"
      />

      {/* Add Episode panel */}
      <SlidePanel
        isOpen={episodePanelOpen}
        onClose={() => setEpisodePanelOpen(false)}
        title="Add Episode"
        subtitle="Record an input/output interaction"
        footer={
          <>
            <button
              className="btn btn-secondary text-xs"
              onClick={() => setEpisodePanelOpen(false)}
            >
              Cancel
            </button>
            <button
              className="btn btn-primary text-xs"
              onClick={() => void handleCreateEpisode()}
            >
              Add Episode
            </button>
          </>
        }
      >
        <FormField label="Input" required>
          <textarea
            value={episodeForm.input}
            onChange={(e) =>
              setEpisodeForm({ ...episodeForm, input: e.target.value })
            }
            placeholder="User input or query..."
            rows={4}
            className="text-sm"
          />
        </FormField>
        <FormField label="Output">
          <textarea
            value={episodeForm.output}
            onChange={(e) =>
              setEpisodeForm({ ...episodeForm, output: e.target.value })
            }
            placeholder="Agent response..."
            rows={4}
            className="text-sm"
          />
        </FormField>
      </SlidePanel>

      {/* Add/Edit Fact panel */}
      <SlidePanel
        isOpen={factPanelOpen}
        onClose={() => setFactPanelOpen(false)}
        title={factMode === "create" ? "Add Fact" : "Edit Fact"}
        subtitle="Key-value knowledge the agent can reference"
        footer={
          <>
            <button
              className="btn btn-secondary text-xs"
              onClick={() => setFactPanelOpen(false)}
            >
              Cancel
            </button>
            <button
              className="btn btn-primary text-xs"
              onClick={() => void handleUpsertFact()}
            >
              {factMode === "create" ? "Add Fact" : "Update Fact"}
            </button>
          </>
        }
      >
        <FormField label="Key" required>
          <input
            type="text"
            value={factForm.key}
            onChange={(e) =>
              setFactForm({ ...factForm, key: e.target.value })
            }
            placeholder="user_preference"
            className="text-sm font-mono"
            disabled={factMode === "edit"}
          />
        </FormField>
        <FormField label="Value" required>
          <textarea
            value={factForm.value}
            onChange={(e) =>
              setFactForm({ ...factForm, value: e.target.value })
            }
            placeholder="The fact content..."
            rows={4}
            className="text-sm"
          />
        </FormField>
        <FormField label="Category">
          <input
            type="text"
            value={factForm.category}
            onChange={(e) =>
              setFactForm({ ...factForm, category: e.target.value })
            }
            placeholder="preferences, context, rules..."
            className="text-sm"
          />
        </FormField>
      </SlidePanel>

      {/* Confirm dialog */}
      {confirmOpen && confirmAction && (
        <ConfirmDialog
          title={confirmAction.title}
          description={confirmAction.desc}
          confirmLabel="Confirm"
          tone="danger"
          onConfirm={async () => {
            try {
              await confirmAction.action();
            } catch {
              showToast("Action failed", "error");
            }
            setConfirmOpen(false);
            setConfirmAction(null);
          }}
          onCancel={() => {
            setConfirmOpen(false);
            setConfirmAction(null);
          }}
        />
      )}
    </div>
  );
};
