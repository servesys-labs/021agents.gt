import { useState, useMemo, useCallback } from "react";
import {
  GitBranch,
  Plus,
  Play,
  Square,
  ChevronDown,
  ChevronRight,
  Clock,
  CheckCircle2,
  XCircle,
  Loader2,
  X,
  ArrowDown,
  Bot,
  Wrench,
  Layers,
  Merge,
  Flag,
  AlertTriangle,
} from "lucide-react";
import { useApiQuery, apiPost, apiGet } from "../../lib/api";

/* ── Types ──────────────────────────────────────────────────────── */

type WorkflowStep = {
  id: string;
  name?: string;
  type: "llm" | "tool" | "parallel" | "join" | "finalize";
  agent_name?: string;
  depends_on?: string[];
};

type Workflow = {
  id: string;
  name: string;
  steps: WorkflowStep[];
  agent_count?: number;
  created_at?: string;
  last_run_status?: string;
};

type WorkflowRun = {
  id: string;
  workflow_id: string;
  workflow_name?: string;
  status: "running" | "completed" | "failed" | "cancelled";
  started_at?: string;
  duration_seconds?: number;
  step_progress?: string;
};

type ValidationResult = {
  valid: boolean;
  errors?: string[];
  warnings?: string[];
};

/* ── Workflows Page ──────────────────────────────────────────────── */

export function WorkflowsPage() {
  const [activeTab, setActiveTab] = useState<"workflows" | "runs">("workflows");

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-[var(--space-6)]">
        <div className="flex items-center gap-[var(--space-3)]">
          <div className="w-10 h-10 rounded-xl bg-chart-purple/10 flex items-center justify-center">
            <GitBranch size={20} className="text-chart-purple" />
          </div>
          <div>
            <h1 className="text-[var(--text-lg)] font-bold text-text-primary">Workflows</h1>
            <p className="text-[var(--text-sm)] text-text-muted">
              Multi-agent workflow orchestration
            </p>
          </div>
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex items-center gap-0 border-b border-border-default mb-[var(--space-4)]">
        {(["workflows", "runs"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`flex items-center gap-[var(--space-2)] px-[var(--space-4)] py-[var(--space-3)] text-[var(--text-xs)] font-medium transition-colors border-b-2 -mb-px min-h-[var(--touch-target-min)] capitalize ${
              activeTab === tab
                ? "text-accent border-accent"
                : "text-text-muted border-transparent hover:text-text-secondary hover:border-border-strong"
            }`}
          >
            {tab === "workflows" ? <GitBranch size={14} /> : <Play size={14} />}
            {tab}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === "workflows" && <WorkflowsTab />}
      {activeTab === "runs" && <RunsTab />}
    </div>
  );
}

/* ── Workflows Tab ───────────────────────────────────────────────── */

function WorkflowsTab() {
  const [showCreate, setShowCreate] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const workflowsQuery = useApiQuery<{ workflows: Workflow[] } | Workflow[]>(
    "/api/v1/workflows",
  );

  const workflows: Workflow[] = useMemo(() => {
    const raw = workflowsQuery.data;
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    if ("workflows" in raw) return raw.workflows ?? [];
    return [];
  }, [workflowsQuery.data]);

  const statusColors: Record<string, string> = {
    completed: "bg-status-live/10 text-status-live border-status-live/20",
    failed: "bg-status-error/10 text-status-error border-status-error/20",
    running: "bg-status-info/10 text-status-info border-status-info/20",
    cancelled: "bg-surface-overlay text-text-muted border-border-subtle",
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-[var(--space-4)]">
        <h2 className="text-[var(--text-md)] font-semibold text-text-primary">
          All Workflows ({workflows.length})
        </h2>
        <button
          onClick={() => setShowCreate(true)}
          className="btn btn-primary text-[var(--text-xs)] min-h-[var(--touch-target-min)]"
        >
          <Plus size={14} />
          Create Workflow
        </button>
      </div>

      {workflowsQuery.loading ? (
        <p className="text-[var(--text-sm)] text-text-muted py-[var(--space-6)]">Loading workflows...</p>
      ) : workflows.length === 0 ? (
        <div className="card flex flex-col items-center justify-center py-[var(--space-12)] text-center">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-surface-overlay mb-[var(--space-4)]">
            <GitBranch size={28} className="text-text-muted" />
          </div>
          <h3 className="text-[var(--text-md)] font-semibold text-text-primary mb-[var(--space-2)]">
            No Workflows
          </h3>
          <p className="text-[var(--text-sm)] text-text-muted max-w-sm">
            Create a multi-agent workflow to orchestrate complex tasks across agents.
          </p>
        </div>
      ) : (
        <div className="space-y-[var(--space-3)]">
          {workflows.map((workflow) => (
            <div key={workflow.id} className="card card-hover">
              <button
                onClick={() => setExpandedId(expandedId === workflow.id ? null : workflow.id)}
                className="w-full flex items-center gap-[var(--space-3)] text-left min-h-[var(--touch-target-min)]"
              >
                {expandedId === workflow.id ? (
                  <ChevronDown size={14} className="text-text-muted flex-shrink-0" />
                ) : (
                  <ChevronRight size={14} className="text-text-muted flex-shrink-0" />
                )}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-[var(--space-2)]">
                    <h3 className="text-[var(--text-sm)] font-semibold text-text-primary truncate">
                      {workflow.name}
                    </h3>
                    {workflow.last_run_status && (
                      <span className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide border ${statusColors[workflow.last_run_status] ?? statusColors.cancelled}`}>
                        {workflow.last_run_status}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-[var(--space-4)] mt-[var(--space-1)]">
                    <span className="text-[10px] text-text-muted">
                      {workflow.steps?.length ?? 0} steps
                    </span>
                    <span className="text-[10px] text-text-muted">
                      {workflow.agent_count ?? new Set(workflow.steps?.filter((s) => s.agent_name).map((s) => s.agent_name)).size} agents
                    </span>
                    {workflow.created_at && (
                      <span className="text-[10px] text-text-muted font-mono">
                        {new Date(workflow.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                      </span>
                    )}
                  </div>
                </div>
              </button>

              {/* Expanded: step detail + DAG preview */}
              {expandedId === workflow.id && workflow.steps && (
                <div className="mt-[var(--space-3)] pt-[var(--space-3)] border-t border-border-subtle">
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-[var(--space-4)]">
                    {/* Step table */}
                    <div className="overflow-x-auto">
                      <table>
                        <thead>
                          <tr>
                            <th>Step</th>
                            <th>Type</th>
                            <th>Agent</th>
                            <th>Depends On</th>
                          </tr>
                        </thead>
                        <tbody>
                          {workflow.steps.map((step) => (
                            <tr key={step.id}>
                              <td className="font-mono text-[var(--text-xs)]">
                                {step.name || step.id}
                              </td>
                              <td>
                                <StepTypeBadge type={step.type} />
                              </td>
                              <td className="text-[var(--text-xs)]">{step.agent_name || "--"}</td>
                              <td className="text-[var(--text-xs)] font-mono">
                                {step.depends_on?.join(", ") || "--"}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    {/* DAG preview */}
                    <DAGPreview steps={workflow.steps} />
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Create modal */}
      {showCreate && (
        <CreateWorkflowModal
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            void workflowsQuery.refetch();
          }}
        />
      )}
    </div>
  );
}

/* ── Step Type Badge ─────────────────────────────────────────────── */

function StepTypeBadge({ type }: { type: WorkflowStep["type"] }) {
  const config: Record<string, { icon: React.ReactNode; color: string }> = {
    llm: { icon: <Bot size={10} />, color: "bg-node-glow-purple text-chart-purple border-chart-purple/20" },
    tool: { icon: <Wrench size={10} />, color: "bg-node-glow-cyan text-chart-cyan border-chart-cyan/20" },
    parallel: { icon: <Layers size={10} />, color: "bg-node-glow-blue text-status-info border-status-info/20" },
    join: { icon: <Merge size={10} />, color: "bg-node-glow-orange text-accent border-accent/20" },
    finalize: { icon: <Flag size={10} />, color: "bg-node-glow-green text-status-live border-status-live/20" },
  };

  const c = config[type] ?? config.llm;

  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide border ${c.color}`}>
      {c.icon}
      {type}
    </span>
  );
}

/* ── DAG Preview ─────────────────────────────────────────────────── */

function DAGPreview({ steps }: { steps: WorkflowStep[] }) {
  // Build layers from dependency graph
  const layers = useMemo(() => {
    if (!steps || steps.length === 0) return [];

    const stepMap = new Map(steps.map((s) => [s.id, s]));
    const placed = new Set<string>();
    const result: WorkflowStep[][] = [];

    // BFS layering
    let remaining = [...steps];
    let safetyCount = 0;
    while (remaining.length > 0 && safetyCount < 20) {
      safetyCount++;
      const layer: WorkflowStep[] = [];
      const nextRemaining: WorkflowStep[] = [];

      for (const step of remaining) {
        const deps = step.depends_on ?? [];
        if (deps.length === 0 || deps.every((d) => placed.has(d))) {
          layer.push(step);
        } else {
          nextRemaining.push(step);
        }
      }

      if (layer.length === 0) {
        // Circular dependency fallback — place remaining in one layer
        result.push(nextRemaining);
        break;
      }

      for (const s of layer) placed.add(s.id);
      result.push(layer);
      remaining = nextRemaining;
    }

    return result;
  }, [steps]);

  if (layers.length === 0) {
    return (
      <div className="flex items-center justify-center p-[var(--space-4)] text-[var(--text-sm)] text-text-muted">
        No steps to visualize
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-[var(--space-2)] p-[var(--space-3)]">
      {layers.map((layer, layerIdx) => (
        <div key={layerIdx}>
          {/* Arrow from previous layer */}
          {layerIdx > 0 && (
            <div className="flex justify-center mb-[var(--space-2)]">
              <ArrowDown size={16} className="text-border-strong" />
            </div>
          )}

          {/* Layer boxes */}
          <div className="flex items-center justify-center gap-[var(--space-3)] flex-wrap">
            {layer.map((step) => (
              <div
                key={step.id}
                className="rounded-lg px-[var(--space-3)] py-[var(--space-2)] bg-surface-raised border border-border-subtle text-center min-w-[6rem]"
              >
                <StepTypeBadge type={step.type} />
                <p className="text-[var(--text-xs)] font-medium text-text-primary mt-[var(--space-1)] truncate max-w-[8rem]">
                  {step.name || step.id}
                </p>
                {step.agent_name && (
                  <p className="text-[10px] text-text-muted truncate">{step.agent_name}</p>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ── Create Workflow Modal ───────────────────────────────────────── */

type NewStep = {
  temp_id: string;
  name: string;
  type: WorkflowStep["type"];
  agent_name: string;
  depends_on: string[];
};

function CreateWorkflowModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState("");
  const [steps, setSteps] = useState<NewStep[]>([]);
  const [creating, setCreating] = useState(false);
  const [validating, setValidating] = useState(false);
  const [validationResult, setValidationResult] = useState<ValidationResult | null>(null);

  const addStep = () => {
    setSteps((prev) => [
      ...prev,
      {
        temp_id: `step-${Date.now()}`,
        name: `Step ${prev.length + 1}`,
        type: "llm",
        agent_name: "",
        depends_on: [],
      },
    ]);
  };

  const updateStep = (idx: number, updates: Partial<NewStep>) => {
    setSteps((prev) => prev.map((s, i) => (i === idx ? { ...s, ...updates } : s)));
  };

  const removeStep = (idx: number) => {
    setSteps((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleValidate = async () => {
    setValidating(true);
    setValidationResult(null);
    try {
      const payload = {
        name,
        steps: steps.map((s) => ({
          id: s.temp_id,
          name: s.name,
          type: s.type,
          agent_name: s.agent_name || undefined,
          depends_on: s.depends_on.length > 0 ? s.depends_on : undefined,
        })),
      };
      const result = await apiPost<ValidationResult>("/api/v1/workflows/validate", payload);
      setValidationResult(result);
    } catch {
      setValidationResult({ valid: false, errors: ["Validation request failed"] });
    } finally {
      setValidating(false);
    }
  };

  const handleCreate = async () => {
    if (!name.trim()) return;
    setCreating(true);
    try {
      const payload = {
        name: name.trim(),
        steps: steps.map((s) => ({
          id: s.temp_id,
          name: s.name,
          type: s.type,
          agent_name: s.agent_name || undefined,
          depends_on: s.depends_on.length > 0 ? s.depends_on : undefined,
        })),
      };
      await apiPost("/api/v1/workflows", payload);
      onCreated();
    } catch {
      // handle silently
    } finally {
      setCreating(false);
    }
  };

  return (
    <>
      <div className="fixed inset-0 z-40 glass-backdrop" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-[var(--space-4)]">
        <div className="w-full max-w-3xl max-h-[85vh] overflow-y-auto rounded-2xl glass-medium border border-glass-border p-[var(--space-6)]" style={{ boxShadow: "var(--shadow-panel)" }}>
          {/* Header */}
          <div className="flex items-center justify-between mb-[var(--space-6)]">
            <h2 className="text-[var(--text-lg)] font-bold text-text-primary">Create Workflow</h2>
            <button
              onClick={onClose}
              className="p-2 rounded-lg hover:bg-surface-overlay transition-colors min-w-[var(--touch-target-min)] min-h-[var(--touch-target-min)] flex items-center justify-center"
              aria-label="Close"
            >
              <X size={16} className="text-text-muted" />
            </button>
          </div>

          {/* Name */}
          <div className="mb-[var(--space-4)]">
            <label className="block text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-1)]">
              Workflow Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., Research Pipeline"
              className="text-[var(--text-sm)]"
            />
          </div>

          {/* Steps builder */}
          <div className="mb-[var(--space-4)]">
            <div className="flex items-center justify-between mb-[var(--space-3)]">
              <label className="block text-[var(--text-xs)] text-text-muted uppercase tracking-wide">
                Steps ({steps.length})
              </label>
              <button
                onClick={addStep}
                className="btn btn-secondary text-[var(--text-xs)] min-h-[var(--touch-target-min)]"
              >
                <Plus size={12} />
                Add Step
              </button>
            </div>

            {steps.length === 0 ? (
              <p className="text-[var(--text-sm)] text-text-muted py-[var(--space-4)] text-center">
                Add steps to define your workflow pipeline.
              </p>
            ) : (
              <div className="space-y-[var(--space-3)]">
                {steps.map((step, idx) => (
                  <div key={step.temp_id} className="rounded-lg border border-border-default bg-surface-base p-[var(--space-3)]">
                    <div className="flex items-center gap-[var(--space-2)] mb-[var(--space-2)]">
                      <span className="text-[10px] text-text-muted font-mono">#{idx + 1}</span>
                      <div className="flex-1" />
                      <button
                        onClick={() => removeStep(idx)}
                        className="p-1 rounded hover:bg-surface-overlay transition-colors min-w-[var(--touch-target-min)] min-h-[var(--touch-target-min)] flex items-center justify-center"
                        aria-label="Remove step"
                      >
                        <X size={12} className="text-text-muted" />
                      </button>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-[var(--space-2)]">
                      <div>
                        <label className="block text-[10px] text-text-muted mb-[var(--space-1)]">Name</label>
                        <input
                          type="text"
                          value={step.name}
                          onChange={(e) => updateStep(idx, { name: e.target.value })}
                          className="text-[var(--text-xs)]"
                        />
                      </div>
                      <div>
                        <label className="block text-[10px] text-text-muted mb-[var(--space-1)]">Type</label>
                        <select
                          value={step.type}
                          onChange={(e) => updateStep(idx, { type: e.target.value as WorkflowStep["type"] })}
                          className="text-[var(--text-xs)]"
                        >
                          <option value="llm">LLM</option>
                          <option value="tool">Tool</option>
                          <option value="parallel">Parallel</option>
                          <option value="join">Join</option>
                          <option value="finalize">Finalize</option>
                        </select>
                      </div>
                      {(step.type === "llm" || step.type === "tool") && (
                        <div>
                          <label className="block text-[10px] text-text-muted mb-[var(--space-1)]">Agent</label>
                          <input
                            type="text"
                            value={step.agent_name}
                            onChange={(e) => updateStep(idx, { agent_name: e.target.value })}
                            placeholder="Agent name"
                            className="text-[var(--text-xs)]"
                          />
                        </div>
                      )}
                      <div>
                        <label className="block text-[10px] text-text-muted mb-[var(--space-1)]">Depends On</label>
                        <select
                          multiple
                          value={step.depends_on}
                          onChange={(e) => {
                            const selected = Array.from(e.target.selectedOptions, (o) => o.value);
                            updateStep(idx, { depends_on: selected });
                          }}
                          className="text-[var(--text-xs)] min-h-[var(--touch-target-min)]"
                        >
                          {steps.filter((_, i) => i !== idx).map((s) => (
                            <option key={s.temp_id} value={s.temp_id}>
                              {s.name || s.temp_id}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* DAG preview */}
          {steps.length > 0 && (
            <div className="mb-[var(--space-4)]">
              <label className="block text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-2)]">
                DAG Preview
              </label>
              <div className="rounded-lg border border-border-default bg-surface-base p-[var(--space-2)]">
                <DAGPreview
                  steps={steps.map((s) => ({
                    id: s.temp_id,
                    name: s.name,
                    type: s.type,
                    agent_name: s.agent_name || undefined,
                    depends_on: s.depends_on.length > 0 ? s.depends_on : undefined,
                  }))}
                />
              </div>
            </div>
          )}

          {/* Validation result */}
          {validationResult && (
            <div className={`rounded-lg p-[var(--space-3)] mb-[var(--space-4)] border ${
              validationResult.valid
                ? "bg-node-glow-green border-status-live/20"
                : "bg-node-glow-red border-status-error/20"
            }`}>
              <div className="flex items-center gap-[var(--space-2)] mb-[var(--space-1)]">
                {validationResult.valid ? (
                  <CheckCircle2 size={14} className="text-status-live" />
                ) : (
                  <AlertTriangle size={14} className="text-status-error" />
                )}
                <span className={`text-[var(--text-xs)] font-semibold ${
                  validationResult.valid ? "text-status-live" : "text-status-error"
                }`}>
                  {validationResult.valid ? "Validation passed" : "Validation failed"}
                </span>
              </div>
              {validationResult.errors?.map((err, i) => (
                <p key={i} className="text-[var(--text-xs)] text-status-error">{err}</p>
              ))}
              {validationResult.warnings?.map((warn, i) => (
                <p key={i} className="text-[var(--text-xs)] text-status-warning">{warn}</p>
              ))}
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center gap-[var(--space-3)] justify-end">
            <button
              onClick={onClose}
              className="btn btn-secondary text-[var(--text-xs)] min-h-[var(--touch-target-min)]"
            >
              Cancel
            </button>
            <button
              onClick={handleValidate}
              disabled={validating || steps.length === 0}
              className="btn btn-secondary text-[var(--text-xs)] min-h-[var(--touch-target-min)]"
            >
              {validating ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
              {validating ? "Validating..." : "Validate"}
            </button>
            <button
              onClick={handleCreate}
              disabled={creating || !name.trim() || steps.length === 0}
              className="btn btn-primary text-[var(--text-xs)] min-h-[var(--touch-target-min)]"
            >
              {creating ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
              {creating ? "Creating..." : "Create"}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

/* ── Runs Tab ────────────────────────────────────────────────────── */

function RunsTab() {
  const runsQuery = useApiQuery<{ runs: WorkflowRun[] } | WorkflowRun[]>(
    "/api/v1/workflows/runs",
  );

  const runs: WorkflowRun[] = useMemo(() => {
    const raw = runsQuery.data;
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    if ("runs" in raw) return raw.runs ?? [];
    return [];
  }, [runsQuery.data]);

  const [cancelling, setCancelling] = useState<string | null>(null);

  const handleCancel = async (runId: string, workflowId: string) => {
    setCancelling(runId);
    try {
      await apiPost(`/api/v1/workflows/${workflowId}/runs/${runId}/cancel`);
      await runsQuery.refetch();
    } catch {
      // handle silently
    } finally {
      setCancelling(null);
    }
  };

  const statusConfig: Record<string, { icon: React.ReactNode; color: string }> = {
    running: {
      icon: <Loader2 size={12} className="animate-spin" />,
      color: "text-status-info",
    },
    completed: {
      icon: <CheckCircle2 size={12} />,
      color: "text-status-live",
    },
    failed: {
      icon: <XCircle size={12} />,
      color: "text-status-error",
    },
    cancelled: {
      icon: <Square size={12} />,
      color: "text-text-muted",
    },
  };

  return (
    <div>
      <h2 className="text-[var(--text-md)] font-semibold text-text-primary mb-[var(--space-4)]">
        Run History
      </h2>

      {runsQuery.loading ? (
        <p className="text-[var(--text-sm)] text-text-muted py-[var(--space-6)]">Loading runs...</p>
      ) : runs.length === 0 ? (
        <div className="card flex flex-col items-center justify-center py-[var(--space-12)] text-center">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-surface-overlay mb-[var(--space-4)]">
            <Play size={28} className="text-text-muted" />
          </div>
          <h3 className="text-[var(--text-md)] font-semibold text-text-primary mb-[var(--space-2)]">
            No Runs
          </h3>
          <p className="text-[var(--text-sm)] text-text-muted max-w-sm">
            Execute a workflow to see run history here.
          </p>
        </div>
      ) : (
        <div className="card">
          <div className="overflow-x-auto">
            <table>
              <thead>
                <tr>
                  <th>Workflow</th>
                  <th>Run ID</th>
                  <th>Status</th>
                  <th>Started</th>
                  <th>Duration</th>
                  <th>Progress</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => {
                  const sc = statusConfig[run.status] ?? statusConfig.cancelled;
                  return (
                    <tr key={run.id} className={run.status === "failed" ? "bg-node-glow-red" : ""}>
                      <td className="text-[var(--text-xs)] font-medium text-text-primary">
                        {run.workflow_name || run.workflow_id?.slice(0, 12) || "--"}
                      </td>
                      <td className="font-mono text-[var(--text-xs)]">
                        {run.id.slice(0, 12)}...
                      </td>
                      <td>
                        <span className={`inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide ${sc.color}`}>
                          {sc.icon}
                          {run.status}
                        </span>
                      </td>
                      <td className="text-[var(--text-xs)]">
                        {run.started_at
                          ? new Date(run.started_at).toLocaleDateString(undefined, {
                              month: "short",
                              day: "numeric",
                              hour: "2-digit",
                              minute: "2-digit",
                            })
                          : "--"}
                      </td>
                      <td className="font-mono text-[var(--text-xs)]">
                        {run.duration_seconds != null
                          ? run.duration_seconds < 60
                            ? `${run.duration_seconds.toFixed(1)}s`
                            : `${Math.floor(run.duration_seconds / 60)}m ${Math.round(run.duration_seconds % 60)}s`
                          : "--"}
                      </td>
                      <td className="text-[var(--text-xs)]">
                        {run.step_progress ?? "--"}
                      </td>
                      <td>
                        {run.status === "running" && (
                          <button
                            onClick={() => handleCancel(run.id, run.workflow_id)}
                            disabled={cancelling === run.id}
                            className="btn btn-ghost text-[var(--text-xs)] min-h-[var(--touch-target-min)] text-status-error"
                          >
                            {cancelling === run.id ? (
                              <Loader2 size={12} className="animate-spin" />
                            ) : (
                              <Square size={12} />
                            )}
                            Cancel
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

export { WorkflowsPage as default };
