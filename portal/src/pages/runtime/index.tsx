import { useMemo, useState } from "react";
import {
  Plus,
  Play,
  XCircle,
  RotateCcw,
  GitBranch,
  Briefcase,
  Search,
  Trash2,
  Pencil,
  Eye,
  Pause,
  PlayCircle,
  AlertOctagon,
} from "lucide-react";

import { PageHeader } from "../../components/common/PageHeader";
import { QueryState } from "../../components/common/QueryState";
import { SlidePanel } from "../../components/common/SlidePanel";
import { FormField } from "../../components/common/FormField";
import { StatusBadge } from "../../components/common/StatusBadge";
import { EmptyState } from "../../components/common/EmptyState";
import { ActionMenu, type ActionMenuItem } from "../../components/common/ActionMenu";
import { ConfirmDialog } from "../../components/common/ConfirmDialog";
import { Tabs } from "../../components/common/Tabs";
import { useToast } from "../../components/common/ToastProvider";
import { apiRequest, useApiQuery } from "../../lib/api";
import { toNumber, type RuntimeInsightsResponse } from "../../lib/adapters";

type Workflow = {
  workflow_id?: string;
  name?: string;
  description?: string;
  status?: string;
  step_count?: number;
  created_at?: string;
};

type Job = {
  job_id?: string;
  workflow_id?: string;
  agent_name?: string;
  task?: string;
  status?: string;
  retries?: number;
  progress?: number;
  started_at?: string;
  error?: string;
};

type DLQEntry = {
  job_id?: string;
  agent_name?: string;
  task?: string;
  error?: string;
  failed_at?: string;
  retries?: number;
};

type WorkflowResponse = { workflows?: Workflow[] };
type JobsResponse = { jobs?: Job[] };
type DLQResponse = { entries?: DLQEntry[] };
type WorkflowRun = {
  run_id?: string;
  workflow_id?: string;
  status?: string;
  total_cost_usd?: number;
  started_at?: number;
  completed_at?: number;
  steps?: Record<string, string>;
  dag?: {
    nodes?: Array<{ id?: string; type?: string; depends_on?: string[] }>;
    results?: Record<string, { status?: string; cost_usd?: number; attempts?: number }>;
  };
  reflection?: {
    node_count?: number;
    nodes?: Record<string, { confidence?: number; action?: string; issues?: string[] }>;
  };
  run_metadata?: {
    execution_mode?: string;
    reducer_strategies?: string[];
    reflection_rollup?: {
      avg_confidence?: number;
      revise_count?: number;
      continue_count?: number;
      node_count?: number;
    };
  };
};
type WorkflowRunsResponse = { runs?: WorkflowRun[] };

export const RuntimePage = () => {
  const { showToast } = useToast();

  /* ── Queries ──────────────────────────────────────────────── */
  const workflowsQuery = useApiQuery<WorkflowResponse>("/api/v1/workflows");
  const jobsQuery = useApiQuery<JobsResponse>("/api/v1/jobs?limit=50");
  const dlqQuery = useApiQuery<DLQResponse>("/api/v1/jobs/dlq");
  const runtimeInsightsQuery = useApiQuery<RuntimeInsightsResponse>("/api/v1/sessions/runtime/insights?since_days=30&limit_sessions=300");
  const [selectedWorkflowForRuns, setSelectedWorkflowForRuns] = useState<string | null>(null);
  const workflowRunsQuery = useApiQuery<WorkflowRunsResponse>(
    `/api/v1/workflows/${selectedWorkflowForRuns ?? ""}/runs?limit=25`,
    Boolean(selectedWorkflowForRuns),
  );
  const workflowRuns = useMemo(
    () => workflowRunsQuery.data?.runs ?? [],
    [workflowRunsQuery.data],
  );
  const workflows = useMemo(
    () => workflowsQuery.data?.workflows ?? [],
    [workflowsQuery.data],
  );
  const jobs = useMemo(() => jobsQuery.data?.jobs ?? [], [jobsQuery.data]);
  const dlqEntries = useMemo(() => dlqQuery.data?.entries ?? [], [dlqQuery.data]);

  /* ── Search ───────────────────────────────────────────────── */
  const [wfSearch, setWfSearch] = useState("");
  const [jobSearch, setJobSearch] = useState("");

  const filteredWf = wfSearch
    ? workflows.filter(
        (w) =>
          (w.name ?? "").toLowerCase().includes(wfSearch.toLowerCase()) ||
          (w.workflow_id ?? "").toLowerCase().includes(wfSearch.toLowerCase()),
      )
    : workflows;

  const filteredJobs = jobSearch
    ? jobs.filter(
        (j) =>
          (j.agent_name ?? "").toLowerCase().includes(jobSearch.toLowerCase()) ||
          (j.job_id ?? "").toLowerCase().includes(jobSearch.toLowerCase()),
      )
    : jobs;

  /* ── Create Workflow panel ────────────────────────────────── */
  const [panelOpen, setPanelOpen] = useState(false);
  const [wfForm, setWfForm] = useState({ name: "", description: "" });
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});

  /* ── Detail panel ─────────────────────────────────────────── */
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailItem, setDetailItem] = useState<Workflow | Job | WorkflowRun | null>(null);
  const [selectedRunNode, setSelectedRunNode] = useState<{
    runId: string;
    nodeId: string;
    nodeType: string;
    nodeSpec: { id?: string; type?: string; depends_on?: string[] } | null;
    nodeResult: { status?: string; cost_usd?: number; attempts?: number; metadata?: unknown } | null;
  } | null>(null);

  /* ── Confirm dialog ───────────────────────────────────────── */
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmAction, setConfirmAction] = useState<{
    title: string;
    desc: string;
    action: () => Promise<void>;
  } | null>(null);

  /* ── Workflow actions ─────────────────────────────────────── */
  const handleCreateWorkflow = async () => {
    const errors: Record<string, string> = {};
    if (!wfForm.name.trim()) errors.name = "Name is required";
    setFormErrors(errors);
    if (Object.keys(errors).length > 0) return;

    try {
      await apiRequest("/api/v1/workflows", "POST", wfForm);
      showToast(`Workflow "${wfForm.name}" created`, "success");
      setPanelOpen(false);
      setWfForm({ name: "", description: "" });
      void workflowsQuery.refetch();
    } catch {
      showToast("Failed to create workflow", "error");
    }
  };

  const handleRunWorkflow = async (wfId: string) => {
    try {
      await apiRequest(`/api/v1/workflows/${wfId}/run`, "POST");
      showToast("Workflow run started", "success");
      void jobsQuery.refetch();
    } catch {
      showToast("Failed to start workflow", "error");
    }
  };

  const handleDeleteWorkflow = (wf: Workflow) => {
    setConfirmAction({
      title: "Delete Workflow",
      desc: `Delete "${wf.name ?? wf.workflow_id}"? This cannot be undone.`,
      action: async () => {
        await apiRequest(`/api/v1/workflows/${wf.workflow_id}`, "DELETE");
        showToast("Workflow deleted", "success");
        void workflowsQuery.refetch();
      },
    });
    setConfirmOpen(true);
  };

  /* ── Job actions ──────────────────────────────────────────── */
  const handleRetryJob = async (jobId: string) => {
    try {
      await apiRequest(`/api/v1/jobs/${jobId}/retry`, "POST");
      showToast("Job retried", "success");
      void jobsQuery.refetch();
    } catch {
      showToast("Retry failed", "error");
    }
  };

  const handleCancelJob = (jobId: string) => {
    setConfirmAction({
      title: "Cancel Job",
      desc: `Cancel job ${jobId.slice(0, 12)}...? Running operations will be stopped.`,
      action: async () => {
        await apiRequest(`/api/v1/jobs/${jobId}/cancel`, "POST");
        showToast("Job cancelled", "success");
        void jobsQuery.refetch();
      },
    });
    setConfirmOpen(true);
  };

  const handlePauseJob = async (jobId: string) => {
    try {
      await apiRequest(`/api/v1/jobs/${jobId}/pause`, "POST");
      showToast("Job paused", "success");
      void jobsQuery.refetch();
    } catch {
      showToast("Pause failed", "error");
    }
  };

  const handleResumeJob = async (jobId: string) => {
    try {
      await apiRequest(`/api/v1/jobs/${jobId}/resume`, "POST");
      showToast("Job resumed", "success");
      void jobsQuery.refetch();
    } catch {
      showToast("Resume failed", "error");
    }
  };

  /* ── Row actions ──────────────────────────────────────────── */
  const getWfActions = (wf: Workflow): ActionMenuItem[] => [
    {
      label: "Run",
      icon: <Play size={12} />,
      onClick: () => void handleRunWorkflow(wf.workflow_id ?? ""),
    },
    {
      label: "View Details",
      icon: <Eye size={12} />,
      onClick: () => {
        setDetailItem(wf);
        setDetailOpen(true);
      },
    },
    {
      label: "View Runs",
      icon: <GitBranch size={12} />,
      onClick: () => {
        setSelectedWorkflowForRuns(wf.workflow_id ?? null);
      },
    },
    {
      label: "Edit",
      icon: <Pencil size={12} />,
      onClick: () => {
        setWfForm({
          name: wf.name ?? "",
          description: wf.description ?? "",
        });
        setPanelOpen(true);
      },
    },
    {
      label: "Delete",
      icon: <Trash2 size={12} />,
      onClick: () => handleDeleteWorkflow(wf),
      danger: true,
    },
  ];

  const getJobActions = (job: Job): ActionMenuItem[] => [
    {
      label: "View Details",
      icon: <Eye size={12} />,
      onClick: () => {
        setDetailItem(job);
        setDetailOpen(true);
      },
    },
    {
      label: "Pause",
      icon: <Pause size={12} />,
      onClick: () => void handlePauseJob(job.job_id ?? ""),
      disabled: job.status !== "running",
    },
    {
      label: "Resume",
      icon: <PlayCircle size={12} />,
      onClick: () => void handleResumeJob(job.job_id ?? ""),
      disabled: job.status !== "paused",
    },
    {
      label: "Retry",
      icon: <RotateCcw size={12} />,
      onClick: () => void handleRetryJob(job.job_id ?? ""),
      disabled: job.status === "running",
    },
    {
      label: "Cancel",
      icon: <XCircle size={12} />,
      onClick: () => handleCancelJob(job.job_id ?? ""),
      danger: true,
      disabled: job.status !== "running" && job.status !== "pending",
    },
  ];

  const combinedError = workflowsQuery.error ?? jobsQuery.error ?? runtimeInsightsQuery.error ?? dlqQuery.error;
  const combinedLoading = workflowsQuery.loading || jobsQuery.loading || runtimeInsightsQuery.loading;
  const runningJobs = jobs.filter((j) => j.status === "running").length;
  const insights = runtimeInsightsQuery.data;
  const parallelRatio = toNumber(insights?.parallel_ratio) * 100;
  const actionCounts = insights?.next_actions ?? {};

  /* ── Workflows tab content ────────────────────────────────── */
  const workflowsTab = (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div className="relative flex-1 max-w-xs">
          <Search
            size={14}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
          />
          <input
            type="text"
            placeholder="Search workflows..."
            value={wfSearch}
            onChange={(e) => setWfSearch(e.target.value)}
            className="pl-8 text-xs"
          />
        </div>
      </div>
      {filteredWf.length === 0 ? (
        <EmptyState
          icon={<GitBranch size={40} />}
          title="No workflows"
          description="Create a workflow to orchestrate multi-agent pipelines"
          action={
            <button
              className="btn btn-primary text-xs"
              onClick={() => {
                setWfForm({ name: "", description: "" });
                setPanelOpen(true);
              }}
            >
              <Plus size={14} />
              New Workflow
            </button>
          }
        />
      ) : (
        <div className="card p-0">
          <div className="overflow-x-auto">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Description</th>
                  <th>Status</th>
                  <th>Steps</th>
                  <th>ID</th>
                  <th style={{ width: "48px" }}></th>
                </tr>
              </thead>
              <tbody>
                {filteredWf.map((wf) => (
                  <tr key={wf.workflow_id}>
                    <td>
                      <span className="font-medium text-text-primary">
                        {wf.name ?? "Unnamed"}
                      </span>
                    </td>
                    <td>
                      <span className="text-text-muted text-xs">
                        {wf.description?.slice(0, 50) ?? "No description"}
                      </span>
                    </td>
                    <td>
                      <StatusBadge status={wf.status ?? "draft"} />
                    </td>
                    <td>
                      <span className="text-text-muted text-xs font-mono">
                        {wf.step_count ?? 0}
                      </span>
                    </td>
                    <td>
                      <span className="font-mono text-[10px] text-text-muted">
                        {wf.workflow_id?.slice(0, 12)}
                      </span>
                    </td>
                    <td>
                      <ActionMenu items={getWfActions(wf)} />
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

  /* ── DLQ tab content ──────────────────────────────────────── */
  const dlqTab = (
    <div>
      {dlqQuery.loading ? (
        <p className="text-sm text-text-muted">Loading dead letter queue...</p>
      ) : dlqEntries.length === 0 ? (
        <EmptyState
          icon={<AlertOctagon size={40} />}
          title="Dead letter queue empty"
          description="Failed jobs that exceeded retry limits appear here"
        />
      ) : (
        <div className="card p-0">
          <div className="overflow-x-auto">
            <table>
              <thead>
                <tr>
                  <th>Job ID</th>
                  <th>Agent</th>
                  <th>Task</th>
                  <th>Error</th>
                  <th>Retries</th>
                  <th>Failed At</th>
                </tr>
              </thead>
              <tbody>
                {dlqEntries.map((entry) => (
                  <tr key={entry.job_id}>
                    <td>
                      <span className="font-mono text-xs text-text-primary">
                        {entry.job_id?.slice(0, 12)}
                      </span>
                    </td>
                    <td>
                      <span className="text-text-secondary text-sm">
                        {entry.agent_name ?? "n/a"}
                      </span>
                    </td>
                    <td>
                      <span className="text-text-muted text-xs truncate max-w-[200px] block">
                        {entry.task ?? "--"}
                      </span>
                    </td>
                    <td>
                      <span className="text-status-error text-xs truncate max-w-[200px] block">
                        {entry.error ?? "Unknown error"}
                      </span>
                    </td>
                    <td>
                      <span className="text-text-muted text-xs font-mono">
                        {entry.retries ?? 0}
                      </span>
                    </td>
                    <td>
                      <span className="text-[10px] text-text-muted">
                        {entry.failed_at
                          ? new Date(entry.failed_at).toLocaleString()
                          : "--"}
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

  /* ── Jobs tab content ─────────────────────────────────────── */
  const jobsTab = (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div className="relative flex-1 max-w-xs">
          <Search
            size={14}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
          />
          <input
            type="text"
            placeholder="Search jobs..."
            value={jobSearch}
            onChange={(e) => setJobSearch(e.target.value)}
            className="pl-8 text-xs"
          />
        </div>
      </div>
      {filteredJobs.length === 0 ? (
        <EmptyState
          icon={<Briefcase size={40} />}
          title="No jobs"
          description="Jobs appear when workflows are run"
        />
      ) : (
        <div className="card p-0">
          <div className="overflow-x-auto">
            <table>
              <thead>
                <tr>
                  <th>Job ID</th>
                  <th>Agent</th>
                  <th>Status</th>
                  <th>Progress</th>
                  <th>Retries</th>
                  <th style={{ width: "48px" }}></th>
                </tr>
              </thead>
              <tbody>
                {filteredJobs.map((job) => (
                  <tr key={job.job_id}>
                    <td>
                      <span className="font-mono text-xs text-text-primary">
                        {job.job_id?.slice(0, 12)}
                      </span>
                    </td>
                    <td>
                      <span className="text-text-secondary text-sm">
                        {job.agent_name ?? "n/a"}
                      </span>
                    </td>
                    <td>
                      <StatusBadge status={job.status ?? "unknown"} />
                    </td>
                    <td>
                      {job.progress !== undefined ? (
                        <div className="flex items-center gap-2">
                          <div className="w-16 h-1.5 bg-surface-overlay rounded-full overflow-hidden">
                            <div
                              className="h-full bg-accent rounded-full transition-all"
                              style={{ width: `${job.progress}%` }}
                            />
                          </div>
                          <span className="text-[10px] text-text-muted font-mono">
                            {job.progress}%
                          </span>
                        </div>
                      ) : (
                        <span className="text-text-muted text-xs">--</span>
                      )}
                    </td>
                    <td>
                      <span className="text-text-muted text-xs font-mono">
                        {job.retries ?? 0}
                      </span>
                    </td>
                    <td>
                      <ActionMenu items={getJobActions(job)} />
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
        title="Workflows & Jobs"
        subtitle="Orchestrate multi-agent pipelines and monitor job queues"
        liveCount={runningJobs}
        liveLabel="Running"
        onRefresh={() => {
          void workflowsQuery.refetch();
          void jobsQuery.refetch();
          void dlqQuery.refetch();
        }}
        actions={
          <button
            className="btn btn-primary text-xs"
            onClick={() => {
              setWfForm({ name: "", description: "" });
              setFormErrors({});
              setPanelOpen(true);
            }}
          >
            <Plus size={14} />
            New Workflow
          </button>
        }
      />

      <QueryState
        loading={combinedLoading}
        error={combinedError}
        isEmpty={workflows.length === 0 && jobs.length === 0}
        emptyMessage=""
        onRetry={() => {
          void workflowsQuery.refetch();
          void jobsQuery.refetch();
        }}
      >
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
          <div className="card py-3">
            <p className="text-[10px] uppercase text-text-muted">Turns Scanned</p>
            <p className="text-lg font-bold font-mono">{toNumber(insights?.turns_scanned)}</p>
          </div>
          <div className="card py-3">
            <p className="text-[10px] uppercase text-text-muted">Parallel Turns</p>
            <p className="text-lg font-bold font-mono">
              {toNumber(insights?.parallel_turns)} ({parallelRatio.toFixed(1)}%)
            </p>
          </div>
          <div className="card py-3">
            <p className="text-[10px] uppercase text-text-muted">Avg Reflection Confidence</p>
            <p className="text-lg font-bold font-mono">
              {(toNumber(insights?.avg_reflection_confidence) * 100).toFixed(1)}%
            </p>
          </div>
          <div className="card py-3">
            <p className="text-[10px] uppercase text-text-muted">Tool Failures</p>
            <p className="text-lg font-bold font-mono">{toNumber(insights?.tool_failures_total)}</p>
          </div>
        </div>
        <div className="card py-3 mb-4">
          <p className="text-[10px] uppercase text-text-muted mb-2">Reflection Actions (30d)</p>
          <div className="flex flex-wrap gap-2">
            {Object.keys(actionCounts).length === 0 ? (
              <span className="text-xs text-text-muted">No reflection action signals yet</span>
            ) : (
              Object.entries(actionCounts).map(([action, count]) => (
                <span
                  key={action}
                  className="px-2 py-0.5 text-[10px] bg-surface-overlay text-text-muted rounded border border-border-default"
                >
                  {action}: {toNumber(count)}
                </span>
              ))
            )}
          </div>
        </div>

        <Tabs
          tabs={[
            {
              id: "workflows",
              label: "Workflows",
              count: workflows.length,
              content: workflowsTab,
            },
            {
              id: "jobs",
              label: "Jobs",
              count: jobs.length,
              content: jobsTab,
            },
            {
              id: "dlq",
              label: "Dead Letter Queue",
              count: dlqEntries.length,
              content: dlqTab,
            },
          ]}
        />
      </QueryState>

      {/* Create Workflow panel */}
      <SlidePanel
        isOpen={panelOpen}
        onClose={() => setPanelOpen(false)}
        title="Create Workflow"
        subtitle="Define a new multi-step pipeline"
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
              onClick={() => void handleCreateWorkflow()}
            >
              Create
            </button>
          </>
        }
      >
        <FormField label="Name" required error={formErrors.name}>
          <input
            type="text"
            value={wfForm.name}
            onChange={(e) => setWfForm({ ...wfForm, name: e.target.value })}
            placeholder="data-pipeline"
            className="text-sm"
          />
        </FormField>
        <FormField label="Description">
          <textarea
            value={wfForm.description}
            onChange={(e) =>
              setWfForm({ ...wfForm, description: e.target.value })
            }
            placeholder="Describe what this workflow does..."
            rows={3}
            className="text-sm"
          />
        </FormField>
      </SlidePanel>

      {/* Detail panel */}
      <SlidePanel
        isOpen={detailOpen}
        onClose={() => {
          setDetailOpen(false);
          setDetailItem(null);
        }}
        title="Details"
        subtitle="Full JSON representation"
      >
        <pre className="text-xs font-mono bg-surface-base border border-border-default rounded-md p-4 overflow-x-auto max-h-96">
          {JSON.stringify(detailItem, null, 2)}
        </pre>
      </SlidePanel>

      {/* Workflow runs panel */}
      <SlidePanel
        isOpen={Boolean(selectedWorkflowForRuns)}
        onClose={() => {
          setSelectedWorkflowForRuns(null);
        }}
        title={`Workflow Runs ${selectedWorkflowForRuns?.slice(0, 10) ?? ""}`}
        subtitle="Node-level DAG and reflection telemetry"
        width="620px"
      >
        {workflowRunsQuery.loading && <p className="text-sm text-text-muted">Loading runs...</p>}
        {workflowRunsQuery.error && (
          <p className="text-sm text-status-error">{workflowRunsQuery.error}</p>
        )}
        {!workflowRunsQuery.loading && !workflowRunsQuery.error && workflowRuns.length === 0 && (
          <p className="text-sm text-text-muted">No runs recorded for this workflow yet.</p>
        )}
        <div className="space-y-3">
          {workflowRuns.map((run) => (
            <div
              key={run.run_id}
              className="border border-border-default rounded-lg p-3 bg-surface-base"
            >
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className="px-2 py-0.5 text-[10px] font-semibold bg-accent/10 text-accent rounded-full">
                    {run.run_id?.slice(0, 12) ?? "run"}
                  </span>
                  <StatusBadge status={run.status ?? "unknown"} />
                </div>
                <span className="text-[10px] text-text-muted font-mono">
                  ${toNumber(run.total_cost_usd).toFixed(4)}
                </span>
              </div>
              <div className="text-[10px] text-text-muted flex flex-wrap gap-2 mb-2">
                <span>
                  Nodes: {toNumber(run.dag?.nodes?.length)}
                </span>
                <span>
                  Steps: {Object.keys(run.steps ?? {}).length}
                </span>
                <span>
                  Reflection nodes: {toNumber(run.reflection?.node_count)}
                </span>
                <span>
                  Mode: {run.run_metadata?.execution_mode ?? "sequential"}
                </span>
                <span>
                  Avg conf: {((toNumber(run.run_metadata?.reflection_rollup?.avg_confidence) || 0) * 100).toFixed(1)}%
                </span>
              </div>
              {Array.isArray(run.run_metadata?.reducer_strategies) && run.run_metadata?.reducer_strategies?.length > 0 && (
                <div className="text-[10px] text-text-muted mb-2">
                  Reducers: {run.run_metadata?.reducer_strategies?.join(", ")}
                </div>
              )}
              <div className="flex flex-wrap gap-1">
                {(run.dag?.nodes ?? []).slice(0, 12).map((node, i) => {
                  const nodeId = node.id ?? "";
                  const nodeStatus = run.dag?.results?.[nodeId]?.status ?? "unknown";
                  return (
                    <button
                      type="button"
                      key={`${node.id ?? node.type ?? "node"}-${i}`}
                      className="px-1.5 py-0.5 text-[10px] bg-surface-overlay text-text-muted rounded border border-border-default hover:border-accent hover:text-text-primary transition-colors"
                      onClick={() =>
                        setSelectedRunNode({
                          runId: run.run_id ?? "run",
                          nodeId: node.id ?? `n${i + 1}`,
                          nodeType: node.type ?? "node",
                          nodeSpec: node,
                          nodeResult: (run.dag?.results?.[nodeId] as { status?: string; cost_usd?: number; attempts?: number; metadata?: unknown } | undefined) ?? null,
                        })
                      }
                    >
                      {node.type ?? "node"}:{node.id ?? `n${i + 1}`} ({nodeStatus})
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </SlidePanel>

      {/* Run node detail panel */}
      <SlidePanel
        isOpen={Boolean(selectedRunNode)}
        onClose={() => setSelectedRunNode(null)}
        title={
          selectedRunNode
            ? `Node ${selectedRunNode.nodeType}:${selectedRunNode.nodeId}`
            : "Node"
        }
        subtitle={
          selectedRunNode
            ? `Run ${selectedRunNode.runId.slice(0, 12)}`
            : "Workflow run node detail"
        }
        width="560px"
      >
        {selectedRunNode ? (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="card py-2">
                <p className="text-[10px] uppercase text-text-muted">Status</p>
                <p className="font-mono">{selectedRunNode.nodeResult?.status ?? "unknown"}</p>
              </div>
              <div className="card py-2">
                <p className="text-[10px] uppercase text-text-muted">Attempts</p>
                <p className="font-mono">{toNumber(selectedRunNode.nodeResult?.attempts)}</p>
              </div>
              <div className="card py-2">
                <p className="text-[10px] uppercase text-text-muted">Cost</p>
                <p className="font-mono">${toNumber(selectedRunNode.nodeResult?.cost_usd).toFixed(6)}</p>
              </div>
              <div className="card py-2">
                <p className="text-[10px] uppercase text-text-muted">Depends On</p>
                <p className="font-mono">
                  {(selectedRunNode.nodeSpec?.depends_on ?? []).join(", ") || "--"}
                </p>
              </div>
            </div>
            <pre className="text-xs font-mono bg-surface-base border border-border-default rounded-md p-4 overflow-x-auto max-h-80">
              {JSON.stringify(
                {
                  node: selectedRunNode.nodeSpec,
                  result: selectedRunNode.nodeResult,
                },
                null,
                2,
              )}
            </pre>
          </div>
        ) : null}
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
