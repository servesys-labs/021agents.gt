import { useState, useCallback } from "react";
import {
  Plus,
  Search,
  Bot,
  Pencil,
  Copy,
  Trash2,
  MessageSquare,
  Rocket,
  Download,
  ChevronRight,
  LayoutGrid,
  List,
  Clock,
  Wrench,
} from "lucide-react";
import { useNavigate } from "react-router-dom";

import { PageHeader } from "../../components/common/PageHeader";
import { QueryState } from "../../components/common/QueryState";
import { SlidePanel } from "../../components/common/SlidePanel";
import { FormField } from "../../components/common/FormField";
import { TagInput } from "../../components/common/TagInput";
import { ActionMenu, type ActionMenuItem } from "../../components/common/ActionMenu";
import { StatusBadge } from "../../components/common/StatusBadge";
import { ConfirmDialog } from "../../components/common/ConfirmDialog";
import { EmptyState } from "../../components/common/EmptyState";
import { useToast } from "../../components/common/ToastProvider";
import { AgentCard, type AgentCardData } from "../../components/common/AgentCard";
import { CopyIdButton } from "../../components/common/CopyIdButton";
import { VersionBadge } from "../../components/common/VersionBadge";
import {
  safeArray,
  type AgentInfo,
  type AgentCreateRequest,
  type AgentConfig,
} from "../../lib/adapters";
import { useApiQuery, useApiMutation, apiRequest } from "../../lib/api";

/* ── Time ago helper ─────────────────────────────────────────── */
function timeAgo(dateStr?: string): string {
  if (!dateStr) return "Never";
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

/* ── Models available ────────────────────────────────────────── */
const MODELS = [
  "gpt-4.1-mini",
  "gpt-4.1-nano",
  "gpt-4o",
  "gpt-4o-mini",
  "claude-sonnet-4-20250514",
  "claude-3.5-haiku",
  "gemini-2.5-flash",
];

/* ── Default form state ──────────────────────────────────────── */
const emptyForm: AgentCreateRequest = {
  name: "",
  description: "",
  system_prompt: "",
  personality: "",
  model: "gpt-4.1-mini",
  max_tokens: 4096,
  temperature: 0.7,
  tools: [],
  max_turns: 25,
  timeout_seconds: 300,
  tags: [],
  governance: {
    budget_limit_usd: 10,
    blocked_tools: [],
    require_confirmation_for_destructive: true,
  },
};

export const AgentsPage = () => {
  const navigate = useNavigate();
  const { showToast } = useToast();

  /* ── View mode ──────────────────────────────────────────── */
  const [viewMode, setViewMode] = useState<"grid" | "table">("grid");

  /* ── Query state ──────────────────────────────────────────── */
  const [limit, setLimit] = useState(25);
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState("");

  const agentsQuery = useApiQuery<AgentInfo[]>(
    `/api/v1/agents?limit=${limit}&offset=${offset}`,
  );
  const agents = safeArray<AgentInfo>(agentsQuery.data);
  const filtered = search
    ? agents.filter(
        (a) =>
          a.name.toLowerCase().includes(search.toLowerCase()) ||
          a.description?.toLowerCase().includes(search.toLowerCase()),
      )
    : agents;

  /* ── Tools list for the form ──────────────────────────────── */
  const toolsQuery = useApiQuery<Array<{ name: string }>>("/api/v1/tools");
  const availableTools = safeArray<{ name: string }>(toolsQuery.data).map(
    (t) => t.name,
  );

  /* ── Panel state ──────────────────────────────────────────── */
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelMode, setPanelMode] = useState<"create" | "edit">("create");
  const [form, setForm] = useState<AgentCreateRequest>({ ...emptyForm });
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});

  /* ── Detail state ─────────────────────────────────────────── */
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const detailQuery = useApiQuery<AgentConfig>(
    `/api/v1/agents/${selectedAgent ?? ""}/config`,
    Boolean(selectedAgent),
  );

  /* ── Confirm dialog ───────────────────────────────────────── */
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmTarget, setConfirmTarget] = useState<string | null>(null);

  /* ── Mutations ────────────────────────────────────────────── */
  const createMutation = useApiMutation<AgentInfo, AgentCreateRequest>(
    "/api/v1/agents",
    "POST",
  );
  const deleteMutation = useApiMutation<void>(
    `/api/v1/agents/${confirmTarget}`,
    "DELETE",
  );

  /* ── Form helpers ─────────────────────────────────────────── */
  const updateField = useCallback(
    <K extends keyof AgentCreateRequest>(key: K, value: AgentCreateRequest[K]) => {
      setForm((prev) => ({ ...prev, [key]: value }));
      setFormErrors((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    },
    [],
  );

  const validateForm = (): boolean => {
    const errors: Record<string, string> = {};
    if (!form.name?.trim()) errors.name = "Name is required";
    else if (!/^[a-z0-9_-]+$/.test(form.name))
      errors.name = "Use lowercase letters, numbers, hyphens, underscores";
    if (!form.model) errors.model = "Model is required";
    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  };

  /* ── Actions ──────────────────────────────────────────────── */
  const openCreate = () => {
    setForm({ ...emptyForm });
    setPanelMode("create");
    setPanelOpen(true);
    setFormErrors({});
  };

  const openEdit = async (name: string) => {
    try {
      const config = await apiRequest<AgentConfig>(
        `/api/v1/agents/${name}/config`,
      );
      setForm({
        name: config.name,
        description: config.description,
        system_prompt: config.system_prompt,
        personality: config.personality,
        model: config.model,
        max_tokens: config.max_tokens,
        temperature: config.temperature,
        tools: config.tools,
        max_turns: config.max_turns,
        timeout_seconds: config.timeout_seconds,
        tags: config.tags,
        governance: config.governance,
      });
      setPanelMode("edit");
      setPanelOpen(true);
      setFormErrors({});
    } catch {
      showToast("Failed to load agent config", "error");
    }
  };

  const handleSave = async () => {
    if (!validateForm()) return;
    try {
      if (panelMode === "create") {
        await createMutation.mutate(form);
        showToast(`Agent "${form.name}" created`, "success");
      } else {
        await apiRequest(`/api/v1/agents/${form.name}`, "PUT", form);
        showToast(`Agent "${form.name}" updated`, "success");
      }
      setPanelOpen(false);
      void agentsQuery.refetch();
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : "Save failed",
        "error",
      );
    }
  };

  const handleClone = async (name: string) => {
    try {
      await apiRequest(`/api/v1/agents/${name}/clone`, "POST", {
        new_name: `${name}-copy`,
      });
      showToast(`Agent "${name}" cloned`, "success");
      void agentsQuery.refetch();
    } catch {
      showToast("Clone failed", "error");
    }
  };

  const handleDelete = async () => {
    if (!confirmTarget) return;
    try {
      await deleteMutation.mutate();
      showToast(`Agent "${confirmTarget}" deleted`, "success");
      setConfirmOpen(false);
      setConfirmTarget(null);
      if (selectedAgent === confirmTarget) setSelectedAgent(null);
      void agentsQuery.refetch();
    } catch {
      showToast("Delete failed", "error");
    }
  };

  const handleExport = async (name: string) => {
    try {
      const data = await apiRequest<Record<string, unknown>>(
        `/api/v1/agents/${name}/export`,
      );
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${name}.agent.json`;
      a.click();
      URL.revokeObjectURL(url);
      showToast(`Exported "${name}"`, "success");
    } catch {
      showToast("Export failed", "error");
    }
  };

  /* ── Row actions ──────────────────────────────────────────── */
  const getRowActions = (agent: AgentInfo): ActionMenuItem[] => [
    {
      label: "Chat",
      icon: <MessageSquare size={12} />,
      onClick: () => navigate(`/agent-chat?agent=${agent.name}`),
    },
    {
      label: "Edit",
      icon: <Pencil size={12} />,
      onClick: () => void openEdit(agent.name),
    },
    {
      label: "Clone",
      icon: <Copy size={12} />,
      onClick: () => void handleClone(agent.name),
    },
    {
      label: "Export JSON",
      icon: <Download size={12} />,
      onClick: () => void handleExport(agent.name),
    },
    {
      label: "Deploy",
      icon: <Rocket size={12} />,
      onClick: () => navigate(`/releases?agent=${agent.name}`),
    },
    {
      label: "Delete",
      icon: <Trash2 size={12} />,
      onClick: () => {
        setConfirmTarget(agent.name);
        setConfirmOpen(true);
      },
      danger: true,
    },
  ];

  /* ── Live count ───────────────────────────────────────────── */
  const liveCount = agents.filter(
    (a) => a.status === "online" || a.status === "live",
  ).length;

  return (
    <div>
      <PageHeader
        title="Agents"
        subtitle={`${agents.length} configured agents`}
        liveCount={liveCount}
        liveLabel="Live"
        onRefresh={() => void agentsQuery.refetch()}
        actions={
          <div className="flex items-center gap-2">
            <button className="btn btn-secondary text-xs" onClick={() => navigate("/tools")}>
              <Wrench size={14} />
              Browse Tools
            </button>
            <button className="btn btn-primary text-xs" onClick={openCreate}>
              <Plus size={14} />
              New Agent
            </button>
          </div>
        }
      />

      {/* Search & pagination bar */}
      <div className="flex items-center justify-between mb-4 gap-3">
        <div className="relative flex-1 max-w-xs">
          <Search
            size={14}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
          />
          <input
            type="text"
            placeholder="Search agents..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8 text-xs"
          />
        </div>
        <div className="flex items-center gap-2">
          {/* View toggle */}
          <div className="flex items-center border border-border-default rounded-md overflow-hidden">
            <button
              className={`p-1.5 ${viewMode === "grid" ? "bg-surface-overlay text-text-primary" : "bg-transparent text-text-muted"} transition-colors`}
              onClick={() => setViewMode("grid")}
              title="Grid view"
              aria-label="Grid view"
            >
              <LayoutGrid size={14} />
            </button>
            <button
              className={`p-1.5 ${viewMode === "table" ? "bg-surface-overlay text-text-primary" : "bg-transparent text-text-muted"} transition-colors`}
              onClick={() => setViewMode("table")}
              title="Table view"
              aria-label="Table view"
            >
              <List size={14} />
            </button>
          </div>
          <button
            className="btn btn-secondary text-xs"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - limit))}
          >
            Previous
          </button>
          <button
            className="btn btn-secondary text-xs"
            onClick={() => setOffset(offset + limit)}
          >
            Next
          </button>
          <select
            className="text-xs w-auto"
            value={limit}
            onChange={(e) => {
              setLimit(Number(e.target.value));
              setOffset(0);
            }}
          >
            <option value={10}>10</option>
            <option value={25}>25</option>
            <option value={50}>50</option>
            <option value={100}>100</option>
          </select>
        </div>
      </div>

      {/* Agent list */}
      <QueryState
        loading={agentsQuery.loading}
        error={agentsQuery.error}
        isEmpty={agents.length === 0}
        emptyMessage=""
        onRetry={() => void agentsQuery.refetch()}
      >
        {filtered.length === 0 && !agentsQuery.loading ? (
          <EmptyState
            icon={<Bot size={40} />}
            title="No agents found"
            description={
              search
                ? "Try a different search term"
                : "Create your first agent to get started"
            }
            action={
              !search ? (
                <button
                  className="btn btn-primary text-xs"
                  onClick={openCreate}
                >
                  <Plus size={14} />
                  Create Agent
                </button>
              ) : undefined
            }
          />
        ) : viewMode === "grid" ? (
          /* ── Grid View ──────────────────────────────────── */
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {filtered.map((agent) => (
              <AgentCard
                key={agent.name}
                agent={{
                  name: agent.name,
                  description: agent.description,
                  status: agent.status,
                  model: agent.model,
                  version: agent.version,
                  tags: agent.tags,
                  last_active: agent.updated_at,
                } satisfies AgentCardData}
                onSelect={(name) =>
                  setSelectedAgent(selectedAgent === name ? null : name)
                }
              />
            ))}
          </div>
        ) : (
          /* ── Table View ─────────────────────────────────── */
          <div className="card p-0">
            <div className="overflow-x-auto">
              <table>
                <thead>
                  <tr>
                    <th>Agent</th>
                    <th>Model</th>
                    <th>Status</th>
                    <th>Version</th>
                    <th>Tools</th>
                    <th>Tags</th>
                    <th>Last Active</th>
                    <th style={{ width: "48px" }}></th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((agent) => (
                    <tr key={agent.name}>
                      <td>
                        <button
                          className="text-left group"
                          onClick={() =>
                            setSelectedAgent(
                              selectedAgent === agent.name
                                ? null
                                : agent.name,
                            )
                          }
                        >
                          <span className="font-medium text-text-primary group-hover:text-accent transition-colors flex items-center gap-1">
                            <span
                              className="truncate max-w-[180px] inline-block align-bottom"
                              title={agent.name}
                            >
                              {agent.name}
                            </span>
                            <CopyIdButton value={agent.name} label="name" />
                            <ChevronRight
                              size={12}
                              className={`text-text-muted transition-transform flex-shrink-0 ${
                                selectedAgent === agent.name
                                  ? "rotate-90"
                                  : ""
                              }`}
                            />
                          </span>
                          <span className="block text-xs text-text-muted mt-0.5 truncate max-w-[200px]" title={agent.description || "No description"}>
                            {agent.description?.slice(0, 60) || "No description"}
                          </span>
                        </button>
                      </td>
                      <td>
                        <span className="px-2 py-0.5 text-[10px] font-mono bg-surface-overlay text-text-secondary rounded border border-border-default">
                          {agent.model?.split("/").pop() || "n/a"}
                        </span>
                      </td>
                      <td>
                        <StatusBadge status={agent.status || "draft"} />
                      </td>
                      <td>
                        {agent.version ? (
                          <VersionBadge label={agent.version} />
                        ) : (
                          <span className="text-[10px] text-text-muted">--</span>
                        )}
                      </td>
                      <td>
                        <span className="text-xs text-text-muted">
                          {safeArray(agent.tools).length} tools
                        </span>
                      </td>
                      <td>
                        <div className="flex gap-1 flex-wrap">
                          {safeArray<string>(agent.tags)
                            .slice(0, 3)
                            .map((tag) => (
                              <VersionBadge key={tag} label={tag} />
                            ))}
                          {safeArray(agent.tags).length > 3 && (
                            <span className="text-[10px] text-text-muted">
                              +{safeArray(agent.tags).length - 3}
                            </span>
                          )}
                        </div>
                      </td>
                      <td>
                        <span className="text-[10px] text-text-muted flex items-center gap-1">
                          <Clock size={10} />
                          {agent.updated_at
                            ? timeAgo(agent.updated_at)
                            : "--"}
                        </span>
                      </td>
                      <td>
                        <ActionMenu items={getRowActions(agent)} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </QueryState>

      {/* Agent detail panel (inline expand) */}
      {selectedAgent && (
        <div className="card mt-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-text-primary">
                Agent Config: {selectedAgent}
              </h3>
              <CopyIdButton value={selectedAgent} label="agent name" />
            </div>
            <div className="flex items-center gap-2">
              <button
                className="btn btn-secondary text-xs"
                onClick={() => void openEdit(selectedAgent)}
              >
                <Pencil size={12} />
                Edit
              </button>
              <button
                className="btn btn-secondary text-xs"
                onClick={() => setSelectedAgent(null)}
              >
                Close
              </button>
            </div>
          </div>
          {detailQuery.loading && (
            <p className="text-sm text-text-muted">Loading config...</p>
          )}
          {detailQuery.error && (
            <p className="text-sm text-status-error">{detailQuery.error}</p>
          )}
          {detailQuery.data && (
            <>
              {/* Last edited + version info */}
              <div className="flex items-center gap-4 mb-3 text-[10px] text-text-muted">
                {detailQuery.data.version && (
                  <VersionBadge label={detailQuery.data.version} />
                )}
                {detailQuery.data.agent_id && (
                  <span className="flex items-center gap-1 font-mono">
                    ID: {detailQuery.data.agent_id.slice(0, 12)}...
                    <CopyIdButton value={detailQuery.data.agent_id} label="agent ID" />
                  </span>
                )}
                <span className="flex items-center gap-1">
                  <Clock size={10} />
                  Last edited: {timeAgo(
                    agents.find((a) => a.name === selectedAgent)?.updated_at
                  )}
                </span>
              </div>
              <pre className="text-xs font-mono bg-surface-base border border-border-default rounded-md p-4 overflow-x-auto max-h-80">
                {JSON.stringify(detailQuery.data, null, 2)}
              </pre>
            </>
          )}
        </div>
      )}

      {/* Create / Edit slide panel */}
      <SlidePanel
        isOpen={panelOpen}
        onClose={() => setPanelOpen(false)}
        title={panelMode === "create" ? "Create Agent" : `Edit: ${form.name}`}
        subtitle={
          panelMode === "create"
            ? "Configure a new agent from scratch"
            : "Modify agent configuration"
        }
        footer={
          <>
            <button
              className="btn btn-secondary text-xs"
              onClick={() => setPanelOpen(false)}
            >
              Cancel
            </button>
            <button
              className="btn btn-primary text-xs"
              onClick={() => void handleSave()}
              disabled={createMutation.loading}
            >
              {createMutation.loading
                ? "Saving..."
                : panelMode === "create"
                  ? "Create Agent"
                  : "Save Changes"}
            </button>
          </>
        }
      >
        {/* Basic Info */}
        <div className="mb-6">
          <h4 className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-3">
            Basic Info
          </h4>
          <FormField
            label="Name"
            htmlFor="agent-name"
            required
            error={formErrors.name}
            hint="Lowercase slug: my-agent-name"
          >
            <input
              id="agent-name"
              type="text"
              value={form.name || ""}
              onChange={(e) => updateField("name", e.target.value)}
              placeholder="support-bot"
              disabled={panelMode === "edit"}
              className="text-sm"
            />
          </FormField>

          <FormField label="Description" htmlFor="agent-desc">
            <input
              id="agent-desc"
              type="text"
              value={form.description || ""}
              onChange={(e) => updateField("description", e.target.value)}
              placeholder="A helpful support agent..."
              className="text-sm"
            />
          </FormField>

          <FormField label="Tags">
            <TagInput
              value={form.tags || []}
              onChange={(tags) => updateField("tags", tags)}
              placeholder="Add tags..."
            />
          </FormField>
        </div>

        {/* Identity */}
        <div className="mb-6">
          <h4 className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-3">
            Identity
          </h4>
          <FormField
            label="System Prompt"
            htmlFor="agent-prompt"
            hint="The core instructions that define this agent's behavior"
          >
            <textarea
              id="agent-prompt"
              value={form.system_prompt || ""}
              onChange={(e) => updateField("system_prompt", e.target.value)}
              placeholder="You are a helpful assistant that..."
              rows={5}
              className="text-sm font-mono"
            />
          </FormField>

          <FormField label="Personality" htmlFor="agent-personality">
            <input
              id="agent-personality"
              type="text"
              value={form.personality || ""}
              onChange={(e) => updateField("personality", e.target.value)}
              placeholder="Friendly, professional, concise"
              className="text-sm"
            />
          </FormField>
        </div>

        {/* LLM Settings */}
        <div className="mb-6">
          <h4 className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-3">
            LLM Settings
          </h4>
          <FormField label="Model" htmlFor="agent-model" required error={formErrors.model}>
            <select
              id="agent-model"
              value={form.model || ""}
              onChange={(e) => updateField("model", e.target.value)}
              className="text-sm"
            >
              {MODELS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </FormField>

          <div className="grid grid-cols-2 gap-3">
            <FormField label="Temperature" htmlFor="agent-temp">
              <input
                id="agent-temp"
                type="number"
                min={0}
                max={2}
                step={0.1}
                value={form.temperature ?? 0.7}
                onChange={(e) =>
                  updateField("temperature", parseFloat(e.target.value))
                }
                className="text-sm"
              />
            </FormField>
            <FormField label="Max Tokens" htmlFor="agent-tokens">
              <input
                id="agent-tokens"
                type="number"
                min={1}
                max={128000}
                value={form.max_tokens ?? 4096}
                onChange={(e) =>
                  updateField("max_tokens", parseInt(e.target.value))
                }
                className="text-sm"
              />
            </FormField>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <FormField label="Max Turns" htmlFor="agent-turns">
              <input
                id="agent-turns"
                type="number"
                min={1}
                max={100}
                value={form.max_turns ?? 25}
                onChange={(e) =>
                  updateField("max_turns", parseInt(e.target.value))
                }
                className="text-sm"
              />
            </FormField>
            <FormField label="Timeout (sec)" htmlFor="agent-timeout">
              <input
                id="agent-timeout"
                type="number"
                min={10}
                max={3600}
                value={form.timeout_seconds ?? 300}
                onChange={(e) =>
                  updateField("timeout_seconds", parseInt(e.target.value))
                }
                className="text-sm"
              />
            </FormField>
          </div>
        </div>

        {/* Tools */}
        <div className="mb-6">
          <h4 className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-3">
            Tools
          </h4>
          <FormField
            label="Attached Tools"
            hint="Select tools this agent can use"
          >
            <TagInput
              value={form.tools || []}
              onChange={(tools) => updateField("tools", tools)}
              suggestions={
                availableTools.length > 0
                  ? availableTools
                  : [
                      "web_search",
                      "sandbox_exec",
                      "file_read",
                      "file_write",
                      "slack_send_message",
                      "search_docs",
                      "create_ticket",
                      "query_database",
                      "send_email",
                      "http_request",
                    ]
              }
              placeholder="Type to search tools..."
            />
          </FormField>
        </div>

        {/* Governance */}
        <div className="mb-6">
          <h4 className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-3">
            Governance
          </h4>
          <FormField label="Budget Limit (USD)" htmlFor="agent-budget">
            <input
              id="agent-budget"
              type="number"
              min={0}
              step={0.5}
              value={form.governance?.budget_limit_usd ?? 10}
              onChange={(e) =>
                updateField("governance", {
                  ...form.governance,
                  budget_limit_usd: parseFloat(e.target.value),
                })
              }
              className="text-sm"
            />
          </FormField>

          <label className="flex items-center gap-2 text-xs text-text-secondary cursor-pointer">
            <input
              type="checkbox"
              checked={
                form.governance?.require_confirmation_for_destructive ?? true
              }
              onChange={(e) =>
                updateField("governance", {
                  ...form.governance,
                  require_confirmation_for_destructive: e.target.checked,
                })
              }
              className="w-3.5 h-3.5 rounded border-border-default bg-surface-base accent-accent"
            />
            Require confirmation for destructive actions
          </label>
        </div>
      </SlidePanel>

      {/* Delete confirmation */}
      {confirmOpen && confirmTarget && (
        <ConfirmDialog
          title="Delete Agent"
          description={`Are you sure you want to delete "${confirmTarget}"? This action cannot be undone.`}
          confirmLabel="Delete"
          tone="danger"
          onConfirm={() => void handleDelete()}
          onCancel={() => {
            setConfirmOpen(false);
            setConfirmTarget(null);
          }}
        />
      )}
    </div>
  );
};
