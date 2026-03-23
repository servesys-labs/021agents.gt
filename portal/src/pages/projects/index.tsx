import { useMemo, useState } from "react";
import {
  Plus,
  FolderOpen,
  Layers,
  Trash2,
  Pencil,
  Eye,
  EyeOff,
  Search,
  Variable,
  Lock,
} from "lucide-react";

import { PageHeader } from "../../components/common/PageHeader";
import { QueryState } from "../../components/common/QueryState";
import { FormField } from "../../components/common/FormField";
import { SlidePanel } from "../../components/common/SlidePanel";
import { StatusBadge } from "../../components/common/StatusBadge";
import { EmptyState } from "../../components/common/EmptyState";
import { ActionMenu, type ActionMenuItem } from "../../components/common/ActionMenu";
import { ConfirmDialog } from "../../components/common/ConfirmDialog";
import { Tabs } from "../../components/common/Tabs";
import { useToast } from "../../components/common/ToastProvider";
import { apiRequest, useApiQuery } from "../../lib/api";

type Project = { project_id: string; name: string; slug: string; description?: string; default_plan?: string };
type Env = { env_id: string; name: string; plan?: string };
type EnvVar = { key: string; value: string; is_secret?: boolean };

export const ProjectsPage = () => {
  const { showToast } = useToast();

  /* ── Queries ──────────────────────────────────────────────── */
  const projectsQuery = useApiQuery<{ projects: Project[] }>("/api/v1/projects");
  const projects = useMemo(() => projectsQuery.data?.projects ?? [], [projectsQuery.data]);
  const [selectedProject, setSelectedProject] = useState("");
  const activeProject = selectedProject || projects[0]?.project_id || "";

  const envsQuery = useApiQuery<{ environments: Env[] }>(
    `/api/v1/projects/${activeProject}/environments`,
    Boolean(activeProject),
  );
  const envs = useMemo(() => envsQuery.data?.environments ?? [], [envsQuery.data]);

  /* ── Search ───────────────────────────────────────────────── */
  const [search, setSearch] = useState("");
  const filtered = search
    ? projects.filter((p) => p.name.toLowerCase().includes(search.toLowerCase()))
    : projects;

  /* ── Create/Edit project panel ────────────────────────────── */
  const [projectPanelOpen, setProjectPanelOpen] = useState(false);
  const [projectMode, setProjectMode] = useState<"create" | "edit">("create");
  const [projectForm, setProjectForm] = useState({ name: "", description: "", plan: "standard" });
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
  const [projectErrors, setProjectErrors] = useState<Record<string, string>>({});

  /* ── Env var editor panel ─────────────────────────────────── */
  const [envVarPanelOpen, setEnvVarPanelOpen] = useState(false);
  const [envVars, setEnvVars] = useState<EnvVar[]>([]);
  const [selectedEnv, setSelectedEnv] = useState<Env | null>(null);
  const [showSecrets, setShowSecrets] = useState<Record<string, boolean>>({});

  /* ── Confirm dialog ───────────────────────────────────────── */
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmAction, setConfirmAction] = useState<{
    title: string;
    desc: string;
    action: () => Promise<void>;
  } | null>(null);

  /* ── Create/Edit project ──────────────────────────────────── */
  const handleSaveProject = async () => {
    const errors: Record<string, string> = {};
    if (!projectForm.name.trim()) errors.name = "Required";
    setProjectErrors(errors);
    if (Object.keys(errors).length > 0) return;

    try {
      if (projectMode === "create") {
        await apiRequest("/api/v1/projects", "POST", projectForm);
        showToast(`Project "${projectForm.name}" created`, "success");
      } else {
        await apiRequest(`/api/v1/projects/${editingProjectId}`, "PUT", projectForm);
        showToast("Project updated", "success");
      }
      setProjectPanelOpen(false);
      void projectsQuery.refetch();
    } catch {
      showToast("Failed to save project", "error");
    }
  };

  /* ── Delete project ───────────────────────────────────────── */
  const handleDeleteProject = (p: Project) => {
    setConfirmAction({
      title: "Delete Project",
      desc: `Delete "${p.name}" and all its environments? This cannot be undone.`,
      action: async () => {
        await apiRequest(`/api/v1/projects/${p.project_id}`, "DELETE");
        showToast("Project deleted", "success");
        void projectsQuery.refetch();
      },
    });
    setConfirmOpen(true);
  };

  /* ── Env var management ───────────────────────────────────── */
  const openEnvVars = async (env: Env) => {
    setSelectedEnv(env);
    setEnvVarPanelOpen(true);
    try {
      const result = await apiRequest<{ variables: EnvVar[] }>(
        `/api/v1/projects/${activeProject}/environments/${env.env_id}/variables`,
      );
      setEnvVars(result.variables ?? []);
    } catch {
      setEnvVars([]);
    }
  };

  const handleSaveEnvVars = async () => {
    if (!selectedEnv) return;
    try {
      await apiRequest(
        `/api/v1/projects/${activeProject}/environments/${selectedEnv.env_id}/variables`,
        "PUT",
        { variables: envVars },
      );
      showToast("Environment variables saved", "success");
      setEnvVarPanelOpen(false);
    } catch {
      showToast("Failed to save variables", "error");
    }
  };

  const addEnvVar = () => {
    setEnvVars([...envVars, { key: "", value: "", is_secret: false }]);
  };

  const removeEnvVar = (index: number) => {
    setEnvVars(envVars.filter((_, i) => i !== index));
  };

  const updateEnvVar = (index: number, field: keyof EnvVar, value: string | boolean) => {
    const updated = [...envVars];
    updated[index] = { ...updated[index], [field]: value };
    setEnvVars(updated);
  };

  /* ── Row actions ──────────────────────────────────────────── */
  const getProjectActions = (p: Project): ActionMenuItem[] => [
    {
      label: "Edit",
      icon: <Pencil size={12} />,
      onClick: () => {
        setProjectForm({ name: p.name, description: p.description ?? "", plan: p.default_plan ?? "standard" });
        setEditingProjectId(p.project_id);
        setProjectMode("edit");
        setProjectErrors({});
        setProjectPanelOpen(true);
      },
    },
    {
      label: "Delete",
      icon: <Trash2 size={12} />,
      onClick: () => handleDeleteProject(p),
      danger: true,
    },
  ];

  /* ── Projects tab ─────────────────────────────────────────── */
  const projectsTab = (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div className="relative flex-1 max-w-xs">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
          <input type="text" placeholder="Search projects..." value={search} onChange={(e) => setSearch(e.target.value)} className="pl-8 text-xs" />
        </div>
      </div>
      {filtered.length === 0 ? (
        <EmptyState
          icon={<FolderOpen size={40} />}
          title="No projects"
          description="Create a project to organize agents and environments"
          action={
            <button className="btn btn-primary text-xs" onClick={() => { setProjectForm({ name: "", description: "", plan: "standard" }); setProjectMode("create"); setProjectPanelOpen(true); }}>
              <Plus size={14} /> New Project
            </button>
          }
        />
      ) : (
        <div className="grid gap-3">
          {filtered.map((p) => (
            <div key={p.project_id} className="card flex items-center justify-between py-3 cursor-pointer hover:border-accent/40 transition-colors" onClick={() => setSelectedProject(p.project_id)}>
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-chart-blue/10">
                  <FolderOpen size={14} className="text-chart-blue" />
                </div>
                <div>
                  <p className="text-sm font-medium text-text-primary">{p.name}</p>
                  <p className="text-[10px] text-text-muted">{p.slug} &middot; {p.default_plan ?? "standard"}</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <StatusBadge status={activeProject === p.project_id ? "selected" : "default"} />
                <ActionMenu items={getProjectActions(p)} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  /* ── Environments tab ─────────────────────────────────────── */
  const envsTab = (
    <div>
      {!activeProject ? (
        <EmptyState icon={<Layers size={40} />} title="Select a project" description="Choose a project from the Projects tab to view its environments" />
      ) : (
        <QueryState loading={envsQuery.loading} error={envsQuery.error} isEmpty={envs.length === 0} emptyMessage="No environments" onRetry={() => void envsQuery.refetch()}>
          <div className="space-y-2">
            {envs.map((env) => (
              <div key={env.env_id} className="card flex items-center justify-between py-3">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-chart-green/10">
                    <Layers size={14} className="text-chart-green" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-text-primary">{env.name}</p>
                    <p className="text-[10px] text-text-muted font-mono">{env.env_id.slice(0, 12)}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {env.plan && <StatusBadge status={env.plan} />}
                  <button className="btn btn-secondary text-xs" onClick={() => void openEnvVars(env)}>
                    <Variable size={12} /> Variables
                  </button>
                </div>
              </div>
            ))}
          </div>
        </QueryState>
      )}
    </div>
  );

  return (
    <div>
      <PageHeader
        title="Projects & Environments"
        subtitle="Organize agents into projects with isolated environments"
        onRefresh={() => { void projectsQuery.refetch(); void envsQuery.refetch(); }}
        actions={
          <button className="btn btn-primary text-xs" onClick={() => { setProjectForm({ name: "", description: "", plan: "standard" }); setProjectMode("create"); setProjectErrors({}); setProjectPanelOpen(true); }}>
            <Plus size={14} /> New Project
          </button>
        }
      />

      <div className="grid grid-cols-2 gap-3 mb-4">
        <div className="card flex items-center gap-3 py-3">
          <div className="p-2 rounded-lg bg-chart-blue/10"><FolderOpen size={14} className="text-chart-blue" /></div>
          <div>
            <p className="text-lg font-bold text-text-primary font-mono">{projects.length}</p>
            <p className="text-[10px] text-text-muted uppercase">Projects</p>
          </div>
        </div>
        <div className="card flex items-center gap-3 py-3">
          <div className="p-2 rounded-lg bg-chart-green/10"><Layers size={14} className="text-chart-green" /></div>
          <div>
            <p className="text-lg font-bold text-text-primary font-mono">{envs.length}</p>
            <p className="text-[10px] text-text-muted uppercase">Environments</p>
          </div>
        </div>
      </div>

      <Tabs tabs={[
        { id: "projects", label: "Projects", count: projects.length, content: projectsTab },
        { id: "envs", label: "Environments", count: envs.length, content: envsTab },
      ]} />

      {/* Create/Edit project panel */}
      <SlidePanel isOpen={projectPanelOpen} onClose={() => setProjectPanelOpen(false)} title={projectMode === "create" ? "Create Project" : "Edit Project"} subtitle="Project configuration"
        footer={<><button className="btn btn-secondary text-xs" onClick={() => setProjectPanelOpen(false)}>Cancel</button><button className="btn btn-primary text-xs" onClick={() => void handleSaveProject()}>{projectMode === "create" ? "Create" : "Update"}</button></>}>
        <FormField label="Name" required error={projectErrors.name}>
          <input type="text" value={projectForm.name} onChange={(e) => setProjectForm({ ...projectForm, name: e.target.value })} placeholder="my-project" className="text-sm" />
        </FormField>
        <FormField label="Description">
          <textarea value={projectForm.description} onChange={(e) => setProjectForm({ ...projectForm, description: e.target.value })} placeholder="Project description..." rows={3} className="text-sm" />
        </FormField>
        <FormField label="Default Plan">
          <select value={projectForm.plan} onChange={(e) => setProjectForm({ ...projectForm, plan: e.target.value })} className="text-sm">
            <option value="standard">Standard</option>
            <option value="professional">Professional</option>
            <option value="enterprise">Enterprise</option>
          </select>
        </FormField>
      </SlidePanel>

      {/* Env var editor panel */}
      <SlidePanel isOpen={envVarPanelOpen} onClose={() => setEnvVarPanelOpen(false)} title={`Variables: ${selectedEnv?.name ?? ""}`} subtitle="Environment variables and secrets" width="560px"
        footer={<><button className="btn btn-secondary text-xs" onClick={() => setEnvVarPanelOpen(false)}>Cancel</button><button className="btn btn-primary text-xs" onClick={() => void handleSaveEnvVars()}>Save Variables</button></>}>
        <div className="space-y-3">
          {envVars.map((v, i) => (
            <div key={i} className="flex items-start gap-2">
              <div className="flex-1">
                <input type="text" value={v.key} onChange={(e) => updateEnvVar(i, "key", e.target.value)} placeholder="KEY" className="text-xs font-mono mb-1" />
                <div className="relative">
                  <input type={showSecrets[String(i)] ? "text" : v.is_secret ? "password" : "text"} value={v.value} onChange={(e) => updateEnvVar(i, "value", e.target.value)} placeholder="value" className="text-xs font-mono pr-8" />
                  {v.is_secret && (
                    <button className="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-primary" onClick={() => setShowSecrets({ ...showSecrets, [String(i)]: !showSecrets[String(i)] })}>
                      {showSecrets[String(i)] ? <EyeOff size={12} /> : <Eye size={12} />}
                    </button>
                  )}
                </div>
              </div>
              <button className={`mt-1 p-1.5 rounded transition-colors ${v.is_secret ? "bg-accent/10 text-accent" : "bg-surface-overlay text-text-muted hover:text-accent"}`} onClick={() => updateEnvVar(i, "is_secret", !v.is_secret)} title="Toggle secret">
                <Lock size={12} />
              </button>
              <button className="mt-1 p-1.5 text-text-muted hover:text-status-error hover:bg-status-error/10 rounded transition-colors" onClick={() => removeEnvVar(i)}>
                <Trash2 size={12} />
              </button>
            </div>
          ))}
          <button className="btn btn-secondary text-xs w-full" onClick={addEnvVar}>
            <Plus size={12} /> Add Variable
          </button>
        </div>
      </SlidePanel>

      {/* Confirm dialog */}
      {confirmOpen && confirmAction && (
        <ConfirmDialog title={confirmAction.title} description={confirmAction.desc} confirmLabel="Delete" tone="danger"
          onConfirm={async () => { try { await confirmAction.action(); } catch { showToast("Action failed", "error"); } setConfirmOpen(false); setConfirmAction(null); }}
          onCancel={() => { setConfirmOpen(false); setConfirmAction(null); }} />
      )}
    </div>
  );
};
