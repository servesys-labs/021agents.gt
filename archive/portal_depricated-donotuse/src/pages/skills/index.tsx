import { useState, useMemo, useCallback } from "react";
import {
  Sparkles,
  Search,
  Plus,
  Edit3,
  Trash2,
  Loader2,
  Users,
} from "lucide-react";

import { PageHeader } from "../../components/common/PageHeader";
import { Modal } from "../../components/common/Modal";
import { QueryState } from "../../components/common/QueryState";
import { EmptyState } from "../../components/common/EmptyState";
import { useApiQuery, apiPut, apiPost, apiDelete, apiGet } from "../../lib/api";
import { extractList } from "../../lib/normalize";
import { useToast } from "../../components/common/ToastProvider";

/* ── Types ──────────────────────────────────────────────────────── */

type Skill = {
  name: string;
  description?: string;
  category?: string;
  enabled?: boolean;
  content?: string;
  assigned_agents?: string[];
  agent_count?: number;
};

type Agent = {
  name: string;
};

/* ── Category helpers ───────────────────────────────────────────── */

const SKILL_CATEGORIES = ["All", "prompt", "tool-chain", "workflow", "custom"] as const;
type SkillCategory = (typeof SKILL_CATEGORIES)[number];

const categoryBadge: Record<string, string> = {
  prompt: "bg-chart-blue/15 text-chart-blue border-chart-blue/20",
  "tool-chain": "bg-chart-purple/15 text-chart-purple border-chart-purple/20",
  workflow: "bg-chart-orange/15 text-chart-orange border-chart-orange/20",
  custom: "bg-accent-muted text-accent border-accent/20",
};

function getCategoryBadge(cat?: string): string {
  return categoryBadge[cat ?? ""] ?? "bg-surface-overlay text-text-secondary border-border-default";
}

/* ── Component ──────────────────────────────────────────────────── */

export function SkillsPage() {
  const { showToast } = useToast();
  const [searchQuery, setSearchQuery] = useState("");
  const [activeCategory, setActiveCategory] = useState<SkillCategory>("All");
  const [filterEnabled, setFilterEnabled] = useState<"all" | "enabled" | "disabled">("all");
  const [modalOpen, setModalOpen] = useState(false);
  const [editingSkill, setEditingSkill] = useState<Skill | null>(null);

  /* Modal form state */
  const [formName, setFormName] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [formCategory, setFormCategory] = useState("prompt");
  const [formContent, setFormContent] = useState("");
  const [formAgents, setFormAgents] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  /* Queries */
  const skillsQuery = useApiQuery<{ skills: Skill[] } | Skill[]>(
    "/api/v1/skills",
  );
  const agentsQuery = useApiQuery<{ agents: Agent[] } | Agent[]>("/api/v1/agents");

  const skills: Skill[] = useMemo(() => {
    const raw = skillsQuery.data;
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    return raw.skills ?? [];
  }, [skillsQuery.data]);

  const agents: Agent[] = useMemo(() => extractList<Agent>(agentsQuery.data, "agents"), [agentsQuery.data]);

  const filteredSkills = useMemo(() => {
    let list = skills;
    if (activeCategory !== "All") {
      list = list.filter((s) => s.category === activeCategory);
    }
    if (filterEnabled === "enabled") {
      list = list.filter((s) => s.enabled !== false);
    } else if (filterEnabled === "disabled") {
      list = list.filter((s) => s.enabled === false);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          (s.description ?? "").toLowerCase().includes(q),
      );
    }
    return list;
  }, [skills, activeCategory, filterEnabled, searchQuery]);

  /* Open modal for create or edit */
  const openCreate = useCallback(() => {
    setEditingSkill(null);
    setFormName("");
    setFormDescription("");
    setFormCategory("prompt");
    setFormContent("");
    setFormAgents([]);
    setModalOpen(true);
  }, []);

  const openEdit = useCallback(async (skill: Skill) => {
    try {
      const detail = await apiGet<Skill>(
        `/api/v1/skills/${encodeURIComponent(skill.name)}`,
      );
      setEditingSkill(detail);
      setFormName(detail.name);
      setFormDescription(detail.description ?? "");
      setFormCategory(detail.category ?? "prompt");
      setFormContent(detail.content ?? "");
      setFormAgents(detail.assigned_agents ?? []);
      setModalOpen(true);
    } catch {
      /* Fall back to local data */
      setEditingSkill(skill);
      setFormName(skill.name);
      setFormDescription(skill.description ?? "");
      setFormCategory(skill.category ?? "prompt");
      setFormContent(skill.content ?? "");
      setFormAgents(skill.assigned_agents ?? []);
      setModalOpen(true);
    }
  }, []);

  const handleSave = useCallback(async () => {
    if (!formName.trim()) {
      showToast("Skill name is required", "error");
      return;
    }
    setSaving(true);
    try {
      const body = {
        name: formName.trim(),
        description: formDescription.trim(),
        category: formCategory,
        content: formContent,
        assigned_agents: formAgents,
        enabled: true,
      };
      if (editingSkill) {
        await apiPut(
          `/api/v1/skills/${encodeURIComponent(editingSkill.name)}`,
          body,
        );
        showToast("Skill updated", "success");
      } else {
        await apiPost("/api/v1/skills", body);
        showToast("Skill created", "success");
      }
      setModalOpen(false);
      skillsQuery.refetch();
    } catch {
      showToast("Failed to save skill", "error");
    } finally {
      setSaving(false);
    }
  }, [
    formName,
    formDescription,
    formCategory,
    formContent,
    formAgents,
    editingSkill,
    showToast,
    skillsQuery,
  ]);

  const handleDelete = useCallback(
    async (name: string) => {
      try {
        await apiDelete(`/api/v1/skills/${encodeURIComponent(name)}`);
        showToast("Skill deleted", "success");
        skillsQuery.refetch();
      } catch {
        showToast("Failed to delete skill", "error");
      }
    },
    [showToast, skillsQuery],
  );

  const handleToggle = useCallback(
    async (skill: Skill) => {
      try {
        await apiPut(`/api/v1/skills/${encodeURIComponent(skill.name)}`, {
          enabled: skill.enabled === false,
        });
        skillsQuery.refetch();
      } catch {
        showToast("Failed to toggle skill", "error");
      }
    },
    [showToast, skillsQuery],
  );

  const toggleAgentAssignment = useCallback(
    (agentName: string) => {
      setFormAgents((prev) =>
        prev.includes(agentName)
          ? prev.filter((a) => a !== agentName)
          : [...prev, agentName],
      );
    },
    [],
  );

  return (
    <div>
      <PageHeader
        title="Skills Library"
        subtitle="Reusable prompt templates, tool chains, and workflows"
        icon={<Sparkles size={20} />}
        actions={
          <button
            onClick={openCreate}
            className="btn btn-primary text-[var(--text-xs)] min-h-[var(--touch-target-min)]"
          >
            <Plus size={14} />
            Create Skill
          </button>
        }
        onRefresh={skillsQuery.refetch}
      />

      {/* Search + filters */}
      <div className="flex flex-col sm:flex-row gap-[var(--space-3)] mb-[var(--space-4)]">
        <div className="relative flex-1">
          <Search
            size={16}
            className="absolute left-[var(--space-3)] top-1/2 -translate-y-1/2 text-text-muted pointer-events-none"
          />
          <input
            type="text"
            placeholder="Search skills..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-10 bg-surface-overlay"
          />
        </div>
        <select
          value={filterEnabled}
          onChange={(e) =>
            setFilterEnabled(e.target.value as "all" | "enabled" | "disabled")
          }
          className="w-auto min-w-[140px]"
        >
          <option value="all">All status</option>
          <option value="enabled">Enabled</option>
          <option value="disabled">Disabled</option>
        </select>
      </div>

      {/* Category filter chips */}
      <div className="flex flex-wrap gap-[var(--space-2)] mb-[var(--space-6)]">
        {SKILL_CATEGORIES.map((cat) => (
          <button
            key={cat}
            onClick={() => setActiveCategory(cat)}
            className={`px-[var(--space-3)] py-[var(--space-2)] rounded-lg text-[var(--text-xs)] font-medium transition-colors min-h-[var(--touch-target-min)] ${
              activeCategory === cat
                ? "bg-accent text-text-inverse"
                : "bg-surface-raised border border-border-default text-text-secondary hover:bg-surface-overlay hover:text-text-primary"
            }`}
          >
            {cat === "All" ? "All" : cat}
          </button>
        ))}
      </div>

      {/* Skills grid */}
      <QueryState
        loading={skillsQuery.loading}
        error={skillsQuery.error}
        onRetry={skillsQuery.refetch}
      >
        {filteredSkills.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-[var(--space-3)]">
            {filteredSkills.map((skill) => (
              <div
                key={skill.name}
                className="card card-hover flex flex-col gap-[var(--space-3)]"
              >
                <div className="flex items-start justify-between gap-[var(--space-2)]">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-[var(--space-2)] mb-[var(--space-1)]">
                      <h3 className="text-[var(--text-sm)] font-semibold text-text-primary truncate">
                        {skill.name}
                      </h3>
                      {skill.category && (
                        <span
                          className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase border ${getCategoryBadge(skill.category)}`}
                        >
                          {skill.category}
                        </span>
                      )}
                    </div>
                    {skill.description && (
                      <p className="text-[var(--text-xs)] text-text-muted line-clamp-2">
                        {skill.description}
                      </p>
                    )}
                  </div>

                  {/* Toggle switch */}
                  <button
                    onClick={() => handleToggle(skill)}
                    className={`relative w-10 h-[22px] rounded-full transition-colors flex-shrink-0 min-h-[var(--touch-target-min)] flex items-center ${
                      skill.enabled !== false
                        ? "bg-accent"
                        : "bg-surface-hover"
                    }`}
                    aria-label={`Toggle ${skill.name} ${skill.enabled !== false ? "off" : "on"}`}
                  >
                    <span
                      className={`absolute top-[3px] w-4 h-4 rounded-full bg-text-primary transition-transform ${
                        skill.enabled !== false
                          ? "translate-x-[22px]"
                          : "translate-x-[3px]"
                      }`}
                    />
                  </button>
                </div>

                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-[var(--space-2)] text-[10px] text-text-muted">
                    <Users size={10} />
                    {skill.agent_count ?? skill.assigned_agents?.length ?? 0} agent
                    {(skill.agent_count ?? skill.assigned_agents?.length ?? 0) !== 1
                      ? "s"
                      : ""}
                  </div>
                  <div className="flex items-center gap-[var(--space-1)]">
                    <button
                      onClick={() => openEdit(skill)}
                      className="btn btn-ghost text-[var(--text-xs)] min-h-[var(--touch-target-min)] px-[var(--space-2)]"
                    >
                      <Edit3 size={12} />
                      Edit
                    </button>
                    <button
                      onClick={() => handleDelete(skill.name)}
                      className="btn btn-ghost text-[var(--text-xs)] text-status-error min-h-[var(--touch-target-min)] px-[var(--space-2)]"
                    >
                      <Trash2 size={12} />
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState
            icon={<Sparkles size={28} />}
            title="No skills created yet"
            description="Skills are reusable prompt templates and tool chains."
            action={
              <button
                onClick={openCreate}
                className="btn btn-primary text-[var(--text-xs)] min-h-[var(--touch-target-min)]"
              >
                <Plus size={14} />
                Create Skill
              </button>
            }
          />
        )}
      </QueryState>

      {/* ── Create / Edit Modal ─────────────────────────────────────── */}
      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editingSkill ? "Edit Skill" : "Create Skill"}
        maxWidth="2xl"
        footer={
          <>
            <button
              onClick={() => setModalOpen(false)}
              className="btn btn-secondary text-xs min-h-[var(--touch-target-min)]"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="btn btn-primary text-xs min-h-[var(--touch-target-min)]"
            >
              {saving ? (
                <>
                  <Loader2 size={12} className="animate-spin" />
                  Saving...
                </>
              ) : (
                "Save"
              )}
            </button>
          </>
        }
      >
        <div className="space-y-4">
          <div>
            <label className="block text-xs text-text-muted uppercase tracking-wide mb-1">Name</label>
            <input type="text" value={formName} onChange={(e) => setFormName(e.target.value)} placeholder="e.g., customer-research" disabled={!!editingSkill} />
          </div>
          <div>
            <label className="block text-xs text-text-muted uppercase tracking-wide mb-1">Description</label>
            <textarea value={formDescription} onChange={(e) => setFormDescription(e.target.value)} placeholder="What does this skill do?" rows={2} />
          </div>
          <div>
            <label className="block text-xs text-text-muted uppercase tracking-wide mb-1">Category</label>
            <select value={formCategory} onChange={(e) => setFormCategory(e.target.value)}>
              <option value="prompt">Prompt</option>
              <option value="tool-chain">Tool Chain</option>
              <option value="workflow">Workflow</option>
              <option value="custom">Custom</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-text-muted uppercase tracking-wide mb-1">Content (Markdown / Prompt Template)</label>
            <textarea value={formContent} onChange={(e) => setFormContent(e.target.value)} placeholder="Enter skill definition..." rows={10} className="font-mono text-xs" />
          </div>
          <div>
            <label className="block text-xs text-text-muted uppercase tracking-wide mb-2">Assign to Agents</label>
            {agents.length > 0 ? (
              <div className="grid grid-cols-2 gap-2 max-h-40 overflow-y-auto">
                {agents.map((agent) => (
                  <label key={agent.name} className="flex items-center gap-2 px-2 py-2 rounded-lg hover:bg-surface-overlay transition-colors cursor-pointer min-h-[var(--touch-target-min)]">
                    <input type="checkbox" checked={formAgents.includes(agent.name)} onChange={() => toggleAgentAssignment(agent.name)} />
                    <span className="text-xs text-text-secondary">{agent.name}</span>
                  </label>
                ))}
              </div>
            ) : (
              <p className="text-xs text-text-muted">No agents available.</p>
            )}
          </div>
        </div>
      </Modal>
    </div>
  );
}

export { SkillsPage as default };
