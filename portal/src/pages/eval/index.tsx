import { useMemo, useState, useRef } from "react";
import {
  Play,
  Upload,
  Eye,
  BarChart3,
  CheckCircle2,
  Clock,
  Target,
} from "lucide-react";

import { PageHeader } from "../../components/common/PageHeader";
import { FormField } from "../../components/common/FormField";
import { SlidePanel } from "../../components/common/SlidePanel";
import { StatusBadge } from "../../components/common/StatusBadge";
import { EmptyState } from "../../components/common/EmptyState";
import { ActionMenu, type ActionMenuItem } from "../../components/common/ActionMenu";
import { Tabs } from "../../components/common/Tabs";
import { useToast } from "../../components/common/ToastProvider";
import type { AgentInfo } from "../../lib/adapters";
import { ApiError, apiUpload, getToken, useApiQuery } from "../../lib/api";

/** POST with query string only — matches FastAPI `run_eval` (no JSON body). */
async function postEvalRun(path: string): Promise<void> {
  const token = getToken();
  const response = await fetch(path, {
    method: "POST",
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const payload = (await response.json()) as {
        detail?: string;
        message?: string;
      };
      message = payload.detail ?? payload.message ?? message;
    } catch {
      /* keep generic */
    }
    throw new ApiError(message, response.status);
  }
  if (response.status === 204) return;
  try {
    await response.json();
  } catch {
    throw new ApiError(
      "Expected JSON response but received a non-JSON payload. Verify the API path/proxy.",
      response.status || 500,
    );
  }
}

/** Control-plane eval router (`agentos/api/routers/eval.py`, prefix `/api/v1`). */
const EVAL_API = {
  tasks: "/api/v1/eval/tasks",
  tasksUpload: "/api/v1/eval/tasks/upload",
  runs: (limit: number) => `/api/v1/eval/runs?limit=${limit}`,
  run: (agentName: string, evalFile: string, trials: number) =>
    `/api/v1/eval/run?agent_name=${encodeURIComponent(agentName)}&eval_file=${encodeURIComponent(evalFile)}&trials=${trials}`,
  runDetail: (runId: number) => `/api/v1/eval/runs/${runId}`,
} as const;

type EvalTaskInfo = { file: string; name: string; task_count: number };
type EvalTasksResponse = { tasks: EvalTaskInfo[] };
type EvalRun = {
  run_id: number;
  agent_name: string;
  pass_rate: number;
  avg_score: number;
  avg_latency_ms: number;
  total_cost_usd: number;
  total_tasks: number;
  total_trials: number;
  status?: string;
  started_at?: string;
  completed_at?: string;
};

export const EvalPage = () => {
  const { showToast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);

  /* ── Queries ──────────────────────────────────────────────── */
  const agentsQuery = useApiQuery<AgentInfo[]>("/api/v1/agents");
  const tasksQuery = useApiQuery<EvalTasksResponse>(EVAL_API.tasks);
  const runsQuery = useApiQuery<EvalRun[]>(EVAL_API.runs(50));
  const agents = useMemo(() => agentsQuery.data ?? [], [agentsQuery.data]);
  const tasks = useMemo(() => tasksQuery.data?.tasks ?? [], [tasksQuery.data]);
  const runs = useMemo(() => runsQuery.data ?? [], [runsQuery.data]);

  /* ── Run form ─────────────────────────────────────────────── */
  const [agentName, setAgentName] = useState("");
  const [evalFile, setEvalFile] = useState("");
  const [trials, setTrials] = useState(3);
  const [running, setRunning] = useState(false);

  /* ── Detail drawer ────────────────────────────────────────── */
  const [detailOpen, setDetailOpen] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);
  const runDetailQuery = useApiQuery<Record<string, unknown>>(
    EVAL_API.runDetail(selectedRunId ?? 0),
    selectedRunId !== null,
  );

  /* ── Upload task file ─────────────────────────────────────── */
  const handleUploadTasks = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    try {
      const formData = new FormData();
      for (const file of Array.from(files)) {
        formData.append("files", file);
      }
      await apiUpload<{ uploaded: unknown[]; count: number }>(
        EVAL_API.tasksUpload,
        formData,
      );
      showToast("Task file uploaded", "success");
      void tasksQuery.refetch();
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : "Upload failed",
        "error",
      );
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  /* ── Run eval ─────────────────────────────────────────────── */
  const runEval = async () => {
    const selectedAgent = agentName || agents[0]?.name;
    const selectedFile = evalFile || tasks[0]?.file;
    if (!selectedAgent || !selectedFile) {
      showToast("Select an agent and eval task file", "error");
      return;
    }
    setRunning(true);
    try {
      const path = EVAL_API.run(selectedAgent, selectedFile, trials);
      await postEvalRun(path);
      showToast("Eval run started", "success");
      void runsQuery.refetch();
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : "Failed to start eval",
        "error",
      );
    } finally {
      setRunning(false);
    }
  };

  /* ── Row actions ──────────────────────────────────────────── */
  const getRunActions = (run: EvalRun): ActionMenuItem[] => [
    {
      label: "View Details",
      icon: <Eye size={12} />,
      onClick: () => {
        setSelectedRunId(run.run_id);
        setDetailOpen(true);
      },
    },
  ];

  /* ── Stats ────────────────────────────────────────────────── */
  const avgPassRate =
    runs.length > 0
      ? runs.reduce((s, r) => s + (r.pass_rate ?? 0), 0) / runs.length
      : 0;
  const totalCost = runs.reduce((s, r) => s + (r.total_cost_usd ?? 0), 0);
  const runningCount = runs.filter(
    (r) => r.status === "running",
  ).length;

  /* ── Run Config tab ───────────────────────────────────────── */
  const configTab = (
    <div className="card">
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <FormField label="Agent" required>
            <select
              value={agentName || agents[0]?.name || ""}
              onChange={(e) => setAgentName(e.target.value)}
              className="text-sm"
            >
              {agents.map((a) => (
                <option key={a.name} value={a.name}>
                  {a.name}
                </option>
              ))}
            </select>
          </FormField>
          <FormField label="Eval Task File" required>
            <select
              value={evalFile || tasks[0]?.file || ""}
              onChange={(e) => setEvalFile(e.target.value)}
              className="text-sm"
            >
              {tasks.map((t) => (
                <option key={t.file} value={t.file}>
                  {t.name} ({t.task_count} tasks)
                </option>
              ))}
            </select>
          </FormField>
          <FormField label="Trials" hint="Number of times to run each task">
            <input
              type="number"
              value={trials}
              onChange={(e) => setTrials(Number(e.target.value))}
              min={1}
              max={50}
              className="text-sm"
            />
          </FormField>
          <button
            className="btn btn-primary text-xs mt-2"
            onClick={() => void runEval()}
            disabled={running}
          >
            <Play size={14} />
            {running ? "Running..." : "Start Eval Run"}
          </button>
        </div>
        <div>
          <FormField label="Upload Task File" hint="JSON or JSONL format">
            <div
              className="border-2 border-dashed border-border-default rounded-lg p-6 text-center cursor-pointer hover:border-accent hover:bg-accent/5 transition-colors"
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload size={20} className="mx-auto mb-1 text-text-muted" />
              <p className="text-xs text-text-secondary">
                Click to upload task file
              </p>
              <p className="text-[10px] text-text-muted mt-0.5">
                JSON, JSONL
              </p>
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                accept=".json,.jsonl"
                onChange={(e) => void handleUploadTasks(e.target.files)}
              />
            </div>
          </FormField>

          {/* Task files list */}
          <div className="mt-3">
            <p className="text-xs text-text-muted mb-2">
              Available task files ({tasks.length})
            </p>
            {tasks.length === 0 ? (
              <p className="text-xs text-text-muted">No task files uploaded</p>
            ) : (
              <div className="space-y-1">
                {tasks.map((t) => (
                  <div
                    key={t.file}
                    className="flex items-center justify-between px-3 py-1.5 bg-surface-base border border-border-default rounded-md"
                  >
                    <span className="text-xs text-text-secondary">
                      {t.name}
                    </span>
                    <span className="text-[10px] text-text-muted font-mono">
                      {t.task_count} tasks
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );

  /* ── Results tab ──────────────────────────────────────────── */
  const resultsTab = (
    <div>
      {runs.length === 0 ? (
        <EmptyState
          icon={<BarChart3 size={40} />}
          title="No eval runs yet"
          description="Run an evaluation from the Config tab to see results here"
        />
      ) : (
        <div className="card p-0">
          <div className="overflow-x-auto">
            <table>
              <thead>
                <tr>
                  <th>Run</th>
                  <th>Agent</th>
                  <th>Status</th>
                  <th>Pass Rate</th>
                  <th>Avg Score</th>
                  <th>Latency</th>
                  <th>Cost</th>
                  <th>Tasks</th>
                  <th style={{ width: "48px" }}></th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.run_id}>
                    <td>
                      <span className="font-mono text-xs text-text-primary">
                        #{run.run_id}
                      </span>
                    </td>
                    <td>
                      <span className="text-text-secondary text-sm">
                        {run.agent_name}
                      </span>
                    </td>
                    <td>
                      <StatusBadge
                        status={run.status ?? "completed"}
                      />
                    </td>
                    <td>
                      <div className="flex items-center gap-2">
                        <div className="w-12 h-1.5 bg-surface-overlay rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full ${
                              (run.pass_rate ?? 0) >= 0.8
                                ? "bg-chart-green"
                                : (run.pass_rate ?? 0) >= 0.5
                                  ? "bg-status-warning"
                                  : "bg-status-error"
                            }`}
                            style={{
                              width: `${((run.pass_rate ?? 0) * 100).toFixed(0)}%`,
                            }}
                          />
                        </div>
                        <span className="text-xs text-text-secondary font-mono">
                          {((run.pass_rate ?? 0) * 100).toFixed(1)}%
                        </span>
                      </div>
                    </td>
                    <td>
                      <span className="text-text-muted text-xs font-mono">
                        {(run.avg_score ?? 0).toFixed(2)}
                      </span>
                    </td>
                    <td>
                      <span className="text-text-muted text-xs font-mono">
                        {(run.avg_latency_ms ?? 0).toFixed(0)}ms
                      </span>
                    </td>
                    <td>
                      <span className="text-text-muted text-xs font-mono">
                        ${(run.total_cost_usd ?? 0).toFixed(4)}
                      </span>
                    </td>
                    <td>
                      <span className="text-text-muted text-xs font-mono">
                        {run.total_tasks ?? 0}
                      </span>
                    </td>
                    <td>
                      <ActionMenu items={getRunActions(run)} />
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
        title="Eval Runner"
        subtitle="Run evaluation suites and inspect benchmark outcomes"
        liveCount={runningCount}
        liveLabel="Running"
        onRefresh={() => {
          void runsQuery.refetch();
          void tasksQuery.refetch();
        }}
      />

      {/* Stats */}
      <div className="grid grid-cols-4 gap-3 mb-4">
        <div className="card flex items-center gap-3 py-3">
          <div className="p-2 rounded-lg bg-chart-green/10">
            <Target size={14} className="text-chart-green" />
          </div>
          <div>
            <p className="text-lg font-bold text-text-primary font-mono">
              {runs.length}
            </p>
            <p className="text-[10px] text-text-muted uppercase">Total Runs</p>
          </div>
        </div>
        <div className="card flex items-center gap-3 py-3">
          <div className="p-2 rounded-lg bg-chart-blue/10">
            <CheckCircle2 size={14} className="text-chart-blue" />
          </div>
          <div>
            <p className="text-lg font-bold text-text-primary font-mono">
              {(avgPassRate * 100).toFixed(1)}%
            </p>
            <p className="text-[10px] text-text-muted uppercase">Avg Pass Rate</p>
          </div>
        </div>
        <div className="card flex items-center gap-3 py-3">
          <div className="p-2 rounded-lg bg-accent/10">
            <Clock size={14} className="text-accent" />
          </div>
          <div>
            <p className="text-lg font-bold text-text-primary font-mono">
              {runs.length > 0
                ? (
                    runs.reduce((s, r) => s + (r.avg_latency_ms ?? 0), 0) /
                    runs.length
                  ).toFixed(0)
                : "0"}
              ms
            </p>
            <p className="text-[10px] text-text-muted uppercase">Avg Latency</p>
          </div>
        </div>
        <div className="card flex items-center gap-3 py-3">
          <div className="p-2 rounded-lg bg-chart-purple/10">
            <BarChart3 size={14} className="text-chart-purple" />
          </div>
          <div>
            <p className="text-lg font-bold text-text-primary font-mono">
              ${totalCost.toFixed(4)}
            </p>
            <p className="text-[10px] text-text-muted uppercase">Total Cost</p>
          </div>
        </div>
      </div>

      <Tabs
        tabs={[
          { id: "config", label: "Run Config", content: configTab },
          { id: "results", label: "Results", count: runs.length, content: resultsTab },
        ]}
      />

      {/* Detail drawer */}
      <SlidePanel
        isOpen={detailOpen}
        onClose={() => {
          setDetailOpen(false);
          setSelectedRunId(null);
        }}
        title={`Eval Run #${selectedRunId}`}
        subtitle="Full run details"
        width="560px"
      >
        {runDetailQuery.loading && (
          <p className="text-sm text-text-muted">Loading...</p>
        )}
        {runDetailQuery.error && (
          <p className="text-sm text-status-error">{runDetailQuery.error}</p>
        )}
        {runDetailQuery.data && (
          <pre className="text-xs font-mono bg-surface-base border border-border-default rounded-md p-4 overflow-x-auto max-h-[70vh]">
            {JSON.stringify(runDetailQuery.data, null, 2)}
          </pre>
        )}
      </SlidePanel>
    </div>
  );
};
