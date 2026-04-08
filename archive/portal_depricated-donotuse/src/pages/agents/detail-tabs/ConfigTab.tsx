import { useState, useEffect, type ChangeEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Save, Trash2, ChevronDown, ChevronRight } from "lucide-react";

import { type AgentConfig } from "../../../lib/adapters";
import { apiPut, apiDelete } from "../../../lib/api";
import { useToast } from "../../../components/common/ToastProvider";
import { ConfirmDialog } from "../../../components/common/ConfirmDialog";

/* ── Model options ────────────────────────────────────────────── */

const MODEL_OPTIONS = [
  "@cf/moonshotai/kimi-k2.5",
  "anthropic/claude-sonnet-4-6",
  "openai/gpt-5-mini",
  "deepseek/deepseek-chat",
] as const;

/* ── Props ────────────────────────────────────────────────────── */

type ConfigTabProps = {
  agent: AgentConfig;
  onAgentUpdated?: () => void;
};

/* ── Component ────────────────────────────────────────────────── */

export const ConfigTab = ({ agent, onAgentUpdated }: ConfigTabProps) => {
  const navigate = useNavigate();
  const { showToast } = useToast();

  /* ── Form state ─────────────────────────────────────────────── */
  const [systemPrompt, setSystemPrompt] = useState(agent.system_prompt ?? "");
  const [model, setModel] = useState(agent.model ?? "");
  const [customModel, setCustomModel] = useState("");
  const [maxTurns, setMaxTurns] = useState(agent.max_turns ?? 10);
  const [budget, setBudget] = useState(agent.governance?.budget_limit_usd ?? 1);
  const [description, setDescription] = useState(agent.description ?? "");
  const [tags, setTags] = useState((agent.tags ?? []).join(", "));

  /* Governance */
  const [blockedTools, setBlockedTools] = useState(
    (agent.governance?.blocked_tools ?? []).join(", "),
  );
  const [allowedDomains, setAllowedDomains] = useState(
    ((agent.governance as Record<string, unknown>)?.allowed_domains as string[] ?? []).join(", "),
  );
  const [requireConfirmation, setRequireConfirmation] = useState(
    agent.governance?.require_confirmation_for_destructive ?? false,
  );

  /* UI state */
  const [govOpen, setGovOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const isCustomModel = !MODEL_OPTIONS.includes(model as typeof MODEL_OPTIONS[number]);

  /* Re-sync when agent prop changes */
  useEffect(() => {
    setSystemPrompt(agent.system_prompt ?? "");
    setModel(agent.model ?? "");
    setMaxTurns(agent.max_turns ?? 10);
    setBudget(agent.governance?.budget_limit_usd ?? 1);
    setDescription(agent.description ?? "");
    setTags((agent.tags ?? []).join(", "));
    setBlockedTools((agent.governance?.blocked_tools ?? []).join(", "));
    setAllowedDomains(
      ((agent.governance as Record<string, unknown>)?.allowed_domains as string[] ?? []).join(", "),
    );
    setRequireConfirmation(agent.governance?.require_confirmation_for_destructive ?? false);
  }, [agent]);

  /* ── Helpers ────────────────────────────────────────────────── */

  const splitCsv = (v: string): string[] =>
    v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

  /* ── Save handler ───────────────────────────────────────────── */

  const handleSave = async () => {
    setSaving(true);
    try {
      const effectiveModel = isCustomModel ? customModel || model : model;
      await apiPut(`/api/v1/agents/${agent.name}`, {
        system_prompt: systemPrompt,
        model: effectiveModel,
        max_turns: maxTurns,
        description,
        tags: splitCsv(tags),
        governance: {
          budget_limit_usd: budget,
          blocked_tools: splitCsv(blockedTools),
          allowed_domains: splitCsv(allowedDomains),
          require_confirmation_for_destructive: requireConfirmation,
        },
      });
      showToast("Agent configuration saved", "success");
      onAgentUpdated?.();
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : "Failed to save configuration",
        "error",
      );
    } finally {
      setSaving(false);
    }
  };

  /* ── Delete handler ─────────────────────────────────────────── */

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await apiDelete(`/api/v1/agents/${agent.name}`);
      showToast("Agent deleted", "success");
      navigate("/agents");
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : "Failed to delete agent",
        "error",
      );
    } finally {
      setDeleting(false);
      setDeleteOpen(false);
    }
  };

  /* ── Render ─────────────────────────────────────────────────── */

  return (
    <div className="space-y-6">
      {/* Agent name — read-only header */}
      <div className="card">
        <h2 className="text-base font-semibold text-text-primary mb-1">{agent.name}</h2>
        <span className="text-xs text-text-muted font-mono">v{agent.version || "1.0.0"}</span>
      </div>

      {/* System Prompt */}
      <div className="card space-y-2">
        <label htmlFor="cfg-prompt" className="block text-xs font-semibold text-text-primary uppercase tracking-wide">
          System Prompt
        </label>
        <textarea
          id="cfg-prompt"
          value={systemPrompt}
          onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setSystemPrompt(e.target.value)}
          rows={8}
          className="w-full font-mono text-sm"
          style={{ minHeight: "12rem" }}
          placeholder="You are a helpful assistant..."
        />
        <span className="block text-right text-xs text-text-muted">
          {systemPrompt.length.toLocaleString()} characters
        </span>
      </div>

      {/* Model + Max Turns + Budget row */}
      <div className="card space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {/* Model */}
          <div className="space-y-1">
            <label htmlFor="cfg-model" className="block text-xs font-semibold text-text-primary uppercase tracking-wide">
              Model
            </label>
            <select
              id="cfg-model"
              value={isCustomModel ? "__custom__" : model}
              onChange={(e) => {
                if (e.target.value === "__custom__") {
                  setModel("__custom__");
                  setCustomModel("");
                } else {
                  setModel(e.target.value);
                }
              }}
              className="w-full text-sm"
              style={{ minHeight: "var(--touch-target-min)" }}
            >
              {MODEL_OPTIONS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
              <option value="__custom__">Custom...</option>
            </select>
            {(isCustomModel || model === "__custom__") && (
              <input
                type="text"
                value={customModel || (isCustomModel && model !== "__custom__" ? model : "")}
                onChange={(e) => {
                  setCustomModel(e.target.value);
                  setModel("__custom__");
                }}
                placeholder="org/model-name"
                className="w-full text-sm mt-1"
                style={{ minHeight: "var(--touch-target-min)" }}
              />
            )}
          </div>

          {/* Max Turns */}
          <div className="space-y-1">
            <label htmlFor="cfg-turns" className="block text-xs font-semibold text-text-primary uppercase tracking-wide">
              Max Turns
            </label>
            <input
              id="cfg-turns"
              type="number"
              min={1}
              max={50}
              value={maxTurns}
              onChange={(e) => setMaxTurns(Math.max(1, Math.min(50, Number(e.target.value) || 1)))}
              className="w-full text-sm"
              style={{ minHeight: "var(--touch-target-min)" }}
            />
          </div>

          {/* Budget */}
          <div className="space-y-1">
            <label htmlFor="cfg-budget" className="block text-xs font-semibold text-text-primary uppercase tracking-wide">
              Budget (USD)
            </label>
            <input
              id="cfg-budget"
              type="number"
              min={0.01}
              max={100}
              step={0.01}
              value={budget}
              onChange={(e) => setBudget(Math.max(0.01, Math.min(100, Number(e.target.value) || 0.01)))}
              className="w-full text-sm"
              style={{ minHeight: "var(--touch-target-min)" }}
            />
          </div>
        </div>
      </div>

      {/* Description */}
      <div className="card space-y-2">
        <label htmlFor="cfg-desc" className="block text-xs font-semibold text-text-primary uppercase tracking-wide">
          Description
        </label>
        <textarea
          id="cfg-desc"
          value={description}
          onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setDescription(e.target.value)}
          rows={3}
          className="w-full text-sm"
          placeholder="What does this agent do?"
        />
      </div>

      {/* Tags */}
      <div className="card space-y-2">
        <label htmlFor="cfg-tags" className="block text-xs font-semibold text-text-primary uppercase tracking-wide">
          Tags
        </label>
        <input
          id="cfg-tags"
          type="text"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          placeholder="tag1, tag2, tag3"
          className="w-full text-sm"
          style={{ minHeight: "var(--touch-target-min)" }}
        />
        <span className="block text-xs text-text-muted">Comma-separated</span>
      </div>

      {/* Governance — collapsible */}
      <div className="card">
        <button
          type="button"
          onClick={() => setGovOpen((prev) => !prev)}
          className="flex items-center gap-2 w-full text-left"
          style={{ minHeight: "var(--touch-target-min)", background: "transparent", border: "none", cursor: "pointer", padding: 0 }}
        >
          {govOpen ? <ChevronDown size={14} className="text-text-muted" /> : <ChevronRight size={14} className="text-text-muted" />}
          <span className="text-xs font-semibold text-text-primary uppercase tracking-wide">Governance</span>
        </button>

        {govOpen && (
          <div className="mt-4 space-y-4">
            {/* Blocked Tools */}
            <div className="space-y-1">
              <label htmlFor="cfg-blocked" className="block text-xs font-semibold text-text-muted uppercase tracking-wide">
                Blocked Tools
              </label>
              <input
                id="cfg-blocked"
                type="text"
                value={blockedTools}
                onChange={(e) => setBlockedTools(e.target.value)}
                placeholder="tool_a, tool_b"
                className="w-full text-sm"
                style={{ minHeight: "var(--touch-target-min)" }}
              />
              <span className="block text-xs text-text-muted">Comma-separated tool names</span>
            </div>

            {/* Allowed Domains */}
            <div className="space-y-1">
              <label htmlFor="cfg-domains" className="block text-xs font-semibold text-text-muted uppercase tracking-wide">
                Allowed Domains
              </label>
              <input
                id="cfg-domains"
                type="text"
                value={allowedDomains}
                onChange={(e) => setAllowedDomains(e.target.value)}
                placeholder="example.com, api.service.io"
                className="w-full text-sm"
                style={{ minHeight: "var(--touch-target-min)" }}
              />
              <span className="block text-xs text-text-muted">Comma-separated domains</span>
            </div>

            {/* Require Confirmation */}
            <label className="flex items-center gap-3 cursor-pointer" style={{ minHeight: "var(--touch-target-min)" }}>
              <input
                type="checkbox"
                checked={requireConfirmation}
                onChange={(e) => setRequireConfirmation(e.target.checked)}
              />
              <span className="text-sm text-text-secondary">
                Require confirmation for destructive actions
              </span>
            </label>
          </div>
        )}
      </div>

      {/* Action buttons */}
      <div className="flex items-center justify-between gap-4">
        <button
          type="button"
          onClick={() => setDeleteOpen(true)}
          className="btn bg-status-error text-text-primary hover:bg-status-error/80"
          style={{ minHeight: "var(--touch-target-min)" }}
        >
          <Trash2 size={14} />
          Delete Agent
        </button>

        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={saving}
          className="btn btn-primary"
          style={{ minHeight: "var(--touch-target-min)" }}
        >
          <Save size={14} />
          {saving ? "Saving..." : "Save Changes"}
        </button>
      </div>

      {/* Delete confirmation */}
      {deleteOpen && (
        <ConfirmDialog
          title="Delete Agent"
          description={`Are you sure you want to delete "${agent.name}"? This action cannot be undone.`}
          confirmLabel={deleting ? "Deleting..." : "Delete"}
          tone="danger"
          onConfirm={() => void handleDelete()}
          onCancel={() => setDeleteOpen(false)}
        />
      )}
    </div>
  );
};
