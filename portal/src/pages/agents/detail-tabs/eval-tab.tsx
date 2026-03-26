import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Loader2, Play, Plus, Trash2, Upload, X } from "lucide-react";

import { apiDelete, apiGet, apiPost, apiUpload, useApiQuery } from "../../../lib/api";
import { useToast } from "../../../components/common/ToastProvider";

type EvalDataset = {
  name: string;
  tasks?: EvalTask[];
  task_count?: number;
  last_modified?: string;
};

type EvalTask = {
  name: string;
  input: string;
  expected: string;
  grader?: "contains" | "llm" | "exact_match";
};

type EvalRun = {
  run_id: string;
  eval_name?: string;
  dataset?: string;
  pass_rate?: number;
  total_trials?: number;
  avg_score?: number;
  avg_latency_ms?: number;
  cost?: number;
  status?: string;
  created_at?: string;
  trials?: EvalTrial[];
};

type EvalTrial = {
  task_name?: string;
  input?: string;
  expected?: string;
  actual?: string;
  passed?: boolean;
  score?: number;
  latency_ms?: number;
  cost?: number;
};

type Evaluator = {
  name: string;
  grader_type: "contains" | "llm" | "exact_match";
  criteria?: string;
};

export function EvalTab({ agentName }: { agentName?: string }) {
  const { showToast } = useToast();

  const [selectedDataset, setSelectedDataset] = useState("");
  const [trialsCount, setTrialsCount] = useState(3);
  const [isRunning, setIsRunning] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const datasetsQuery = useApiQuery<{ datasets: EvalDataset[] } | EvalDataset[]>(
    "/api/v1/eval/datasets",
    Boolean(agentName),
  );
  const datasets: EvalDataset[] = useMemo(() => {
    const raw = datasetsQuery.data;
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    return (raw as { datasets: EvalDataset[] }).datasets ?? [];
  }, [datasetsQuery.data]);

  const runsQuery = useApiQuery<{ runs: EvalRun[] } | EvalRun[]>(
    `/api/v1/eval/runs?agent_name=${agentName ?? ""}&limit=20`,
    Boolean(agentName),
  );
  const runs: EvalRun[] = useMemo(() => {
    const raw = runsQuery.data;
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    return (raw as { runs: EvalRun[] }).runs ?? [];
  }, [runsQuery.data]);

  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const [expandedTrialIdx, setExpandedTrialIdx] = useState<number | null>(null);

  const [showCreateDataset, setShowCreateDataset] = useState(false);
  const [newDatasetName, setNewDatasetName] = useState("");
  const [newDatasetJson, setNewDatasetJson] = useState(
    JSON.stringify([{ name: "task_1", input: "Hello", expected: "Hi", grader: "contains" }], null, 2),
  );
  const datasetFileRef = useRef<HTMLInputElement>(null);

  const evaluatorsQuery = useApiQuery<{ evaluators: Evaluator[] } | Evaluator[]>(
    "/api/v1/eval/evaluators",
    Boolean(agentName),
  );
  const evaluators: Evaluator[] = useMemo(() => {
    const raw = evaluatorsQuery.data;
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    return (raw as { evaluators: Evaluator[] }).evaluators ?? [];
  }, [evaluatorsQuery.data]);

  const [showCreateEvaluator, setShowCreateEvaluator] = useState(false);
  const [newEvalName, setNewEvalName] = useState("");
  const [newEvalGrader, setNewEvalGrader] = useState<"contains" | "llm" | "exact_match">("contains");
  const [newEvalCriteria, setNewEvalCriteria] = useState("");

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const handleRunEval = useCallback(async () => {
    if (!agentName || !selectedDataset) return;
    try {
      setIsRunning(true);
      await apiPost("/api/v1/eval/run", {
        agent_name: agentName,
        dataset: selectedDataset,
        trials: trialsCount,
      });
      showToast("Eval started", "success");

      pollRef.current = setInterval(async () => {
        try {
          const result = await apiGet<{ runs: EvalRun[] } | EvalRun[]>(
            `/api/v1/eval/runs?agent_name=${agentName}&limit=1`,
          );
          const latestRuns = Array.isArray(result) ? result : (result as { runs: EvalRun[] }).runs ?? [];
          const latest = latestRuns[0];
          if (latest && latest.status !== "running" && latest.status !== "pending") {
            setIsRunning(false);
            if (pollRef.current) clearInterval(pollRef.current);
            runsQuery.refetch();
          }
        } catch {
          // ignore polling error
        }
      }, 3000);

      setTimeout(() => {
        if (pollRef.current) {
          clearInterval(pollRef.current);
          setIsRunning(false);
          runsQuery.refetch();
        }
      }, 300000);
    } catch {
      setIsRunning(false);
      showToast("Failed to start eval run", "error");
    }
  }, [agentName, selectedDataset, trialsCount, showToast, runsQuery]);

  const handleCreateDataset = useCallback(async () => {
    if (!newDatasetName.trim()) return;
    try {
      const tasks = JSON.parse(newDatasetJson);
      await apiPost("/api/v1/eval/datasets", {
        name: newDatasetName,
        tasks,
      });
      showToast("Dataset created", "success");
      setShowCreateDataset(false);
      setNewDatasetName("");
      datasetsQuery.refetch();
    } catch (err) {
      showToast(err instanceof SyntaxError ? "Invalid JSON" : "Failed to create dataset", "error");
    }
  }, [newDatasetName, newDatasetJson, showToast, datasetsQuery]);

  const handleDeleteDataset = useCallback(
    async (name: string) => {
      try {
        await apiDelete(`/api/v1/eval/datasets/${encodeURIComponent(name)}`);
        showToast("Dataset deleted", "success");
        datasetsQuery.refetch();
      } catch {
        showToast("Failed to delete dataset", "error");
      }
    },
    [showToast, datasetsQuery],
  );

  const handleUploadDataset = useCallback(
    async (file: File) => {
      try {
        const formData = new FormData();
        formData.append("file", file);
        await apiUpload("/api/v1/eval/tasks/upload", formData);
        showToast("Dataset uploaded", "success");
        datasetsQuery.refetch();
      } catch {
        showToast("Failed to upload dataset", "error");
      }
    },
    [showToast, datasetsQuery],
  );

  const handleCreateEvaluator = useCallback(async () => {
    if (!newEvalName.trim()) return;
    try {
      await apiPost("/api/v1/eval/evaluators", {
        name: newEvalName,
        grader_type: newEvalGrader,
        criteria: newEvalCriteria || undefined,
      });
      showToast("Evaluator created", "success");
      setShowCreateEvaluator(false);
      setNewEvalName("");
      setNewEvalCriteria("");
      evaluatorsQuery.refetch();
    } catch {
      showToast("Failed to create evaluator", "error");
    }
  }, [newEvalName, newEvalGrader, newEvalCriteria, showToast, evaluatorsQuery]);

  const handleDeleteEvaluator = useCallback(
    async (name: string) => {
      try {
        await apiDelete(`/api/v1/eval/evaluators/${encodeURIComponent(name)}`);
        showToast("Evaluator deleted", "success");
        evaluatorsQuery.refetch();
      } catch {
        showToast("Failed to delete evaluator", "error");
      }
    },
    [showToast, evaluatorsQuery],
  );

  const passRateColor = (rate?: number) => {
    if (rate == null) return "text-text-muted";
    if (rate >= 0.9) return "text-status-live";
    if (rate >= 0.7) return "text-status-warning";
    return "text-status-error";
  };

  const passRateBg = (rate?: number) => {
    if (rate == null) return "bg-surface-overlay";
    if (rate >= 0.9) return "bg-status-live/10";
    if (rate >= 0.7) return "bg-status-warning/10";
    return "bg-status-error/10";
  };

  return (
    <div className="max-w-5xl space-y-[var(--space-6)]">
      <section className="card">
        <h2 className="text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-4)]">
          Run Eval
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-[var(--space-3)] items-end">
          <div>
            <label className="block text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-1)]">
              Agent
            </label>
            <input type="text" value={agentName ?? ""} disabled className="bg-surface-overlay text-text-secondary opacity-70" />
          </div>
          <div>
            <label className="block text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-1)]">
              Dataset
            </label>
            <select value={selectedDataset} onChange={(e) => setSelectedDataset(e.target.value)} className="bg-surface-overlay">
              <option value="">Select dataset...</option>
              {datasets.map((ds) => (
                <option key={ds.name} value={ds.name}>
                  {ds.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-1)]">
              Trials
            </label>
            <input
              type="number"
              min={1}
              max={20}
              value={trialsCount}
              onChange={(e) => setTrialsCount(Math.min(20, Math.max(1, Number(e.target.value))))}
              className="bg-surface-overlay"
            />
          </div>
          <button
            onClick={handleRunEval}
            disabled={!selectedDataset || isRunning}
            className="btn btn-primary min-h-[var(--touch-target-min)]"
          >
            {isRunning ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                Running...
              </>
            ) : (
              <>
                <Play size={14} />
                Run Eval
              </>
            )}
          </button>
        </div>
        {isRunning && (
          <div className="mt-[var(--space-3)]">
            <div className="w-full h-1.5 bg-surface-overlay rounded-full overflow-hidden">
              <div className="h-full rounded-full bg-accent animate-pulse" style={{ width: "60%" }} />
            </div>
            <p className="text-[10px] text-text-muted mt-[var(--space-1)]">Eval in progress... polling for results</p>
          </div>
        )}
      </section>

      <section className="card">
        <h2 className="text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-4)]">
          Eval Runs ({runs.length})
        </h2>
        {runsQuery.loading ? (
          <p className="text-[var(--text-sm)] text-text-muted">Loading runs...</p>
        ) : runs.length === 0 ? (
          <p className="text-[var(--text-sm)] text-text-muted">No eval runs recorded</p>
        ) : (
          <div className="overflow-x-auto">
            <table>
              <thead>
                <tr>
                  <th>Run ID</th>
                  <th>Eval Name</th>
                  <th>Pass Rate</th>
                  <th className="text-right">Trials</th>
                  <th className="text-right">Avg Score</th>
                  <th className="text-right">Avg Latency</th>
                  <th className="text-right">Cost</th>
                  <th>Date</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => {
                  const isExpanded = expandedRunId === run.run_id;
                  return (
                    <Fragment key={run.run_id}>
                      <tr
                        className="cursor-pointer"
                        onClick={() => {
                          setExpandedRunId(isExpanded ? null : run.run_id);
                          setExpandedTrialIdx(null);
                        }}
                      >
                        <td className="font-mono text-[var(--text-xs)]">
                          <div className="flex items-center gap-[var(--space-1)]">
                            {isExpanded ? (
                              <ChevronDown size={12} className="text-text-muted" />
                            ) : (
                              <ChevronRight size={12} className="text-text-muted" />
                            )}
                            {run.run_id.slice(0, 12)}...
                          </div>
                        </td>
                        <td className="text-text-primary">{run.eval_name ?? run.dataset ?? "--"}</td>
                        <td>
                          <span
                            className={`inline-flex items-center px-2 py-0.5 rounded-full text-[var(--text-xs)] font-bold ${passRateColor(run.pass_rate)} ${passRateBg(run.pass_rate)}`}
                          >
                            {run.pass_rate != null ? `${(run.pass_rate * 100).toFixed(1)}%` : "--"}
                          </span>
                        </td>
                        <td className="text-right font-mono">{run.total_trials ?? "--"}</td>
                        <td className="text-right font-mono">{run.avg_score != null ? run.avg_score.toFixed(2) : "--"}</td>
                        <td className="text-right font-mono">
                          {run.avg_latency_ms != null ? `${run.avg_latency_ms.toFixed(0)}ms` : "--"}
                        </td>
                        <td className="text-right font-mono">
                          {run.cost != null ? `$${run.cost.toFixed(4)}` : "--"}
                        </td>
                        <td className="text-text-muted text-[var(--text-xs)]">
                          {run.created_at
                            ? new Date(run.created_at).toLocaleDateString(undefined, {
                                month: "short",
                                day: "numeric",
                                hour: "2-digit",
                                minute: "2-digit",
                              })
                            : "--"}
                        </td>
                      </tr>
                      {isExpanded && run.trials && run.trials.length > 0 && (
                        <tr>
                          <td colSpan={8} className="p-0">
                            <div className="bg-surface-base border-y border-border-subtle">
                              <table>
                                <thead>
                                  <tr>
                                    <th className="text-[10px]">Task</th>
                                    <th className="text-[10px]">Input</th>
                                    <th className="text-[10px]">Expected</th>
                                    <th className="text-[10px]">Actual</th>
                                    <th className="text-[10px] text-center">Result</th>
                                    <th className="text-[10px] text-right">Latency</th>
                                    <th className="text-[10px] text-right">Cost</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {run.trials.map((trial, ti) => {
                                    const trialExpanded = expandedTrialIdx === ti;
                                    return (
                                      <Fragment key={ti}>
                                        <tr
                                          className="cursor-pointer"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            setExpandedTrialIdx(trialExpanded ? null : ti);
                                          }}
                                        >
                                          <td className="text-[var(--text-xs)]">{trial.task_name ?? `Trial ${ti + 1}`}</td>
                                          <td className="text-[var(--text-xs)] font-mono max-w-[120px] truncate">{trial.input ?? "--"}</td>
                                          <td className="text-[var(--text-xs)] font-mono max-w-[120px] truncate">{trial.expected ?? "--"}</td>
                                          <td className="text-[var(--text-xs)] font-mono max-w-[120px] truncate">{trial.actual ?? "--"}</td>
                                          <td className="text-center">
                                            <span
                                              className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase ${
                                                trial.passed
                                                  ? "bg-status-live/10 text-status-live"
                                                  : "bg-status-error/10 text-status-error"
                                              }`}
                                            >
                                              {trial.passed ? "PASS" : "FAIL"}
                                            </span>
                                          </td>
                                          <td className="text-right font-mono text-[var(--text-xs)]">
                                            {trial.latency_ms != null ? `${trial.latency_ms.toFixed(0)}ms` : "--"}
                                          </td>
                                          <td className="text-right font-mono text-[var(--text-xs)]">
                                            {trial.cost != null ? `$${trial.cost.toFixed(4)}` : "--"}
                                          </td>
                                        </tr>
                                        {trialExpanded && (
                                          <tr>
                                            <td colSpan={7} className="p-0">
                                              <div className="p-[var(--space-3)] bg-surface-raised border-y border-border-subtle space-y-[var(--space-2)]">
                                                <div>
                                                  <span className="text-[10px] text-text-muted uppercase tracking-wide">Full Input</span>
                                                  <pre className="text-[var(--text-xs)] text-text-secondary font-mono bg-surface-base rounded p-[var(--space-2)] mt-[var(--space-1)] whitespace-pre-wrap break-words">
                                                    {trial.input ?? "--"}
                                                  </pre>
                                                </div>
                                                <div>
                                                  <span className="text-[10px] text-text-muted uppercase tracking-wide">Expected</span>
                                                  <pre className="text-[var(--text-xs)] text-text-secondary font-mono bg-surface-base rounded p-[var(--space-2)] mt-[var(--space-1)] whitespace-pre-wrap break-words">
                                                    {trial.expected ?? "--"}
                                                  </pre>
                                                </div>
                                                <div>
                                                  <span className="text-[10px] text-text-muted uppercase tracking-wide">Actual Output</span>
                                                  <pre className="text-[var(--text-xs)] text-text-secondary font-mono bg-surface-base rounded p-[var(--space-2)] mt-[var(--space-1)] whitespace-pre-wrap break-words">
                                                    {trial.actual ?? "--"}
                                                  </pre>
                                                </div>
                                              </div>
                                            </td>
                                          </tr>
                                        )}
                                      </Fragment>
                                    );
                                  })}
                                </tbody>
                              </table>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <div className="flex items-center justify-between mb-[var(--space-4)]">
          <h2 className="text-[var(--text-xs)] text-text-muted uppercase tracking-wide">Datasets ({datasets.length})</h2>
          <div className="flex gap-[var(--space-2)]">
            <button
              onClick={() => datasetFileRef.current?.click()}
              className="btn btn-secondary text-[var(--text-xs)] min-h-[var(--touch-target-min)]"
            >
              <Upload size={12} />
              Upload
            </button>
            <input
              ref={datasetFileRef}
              type="file"
              accept=".json,.jsonl"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleUploadDataset(file);
                e.target.value = "";
              }}
            />
            <button
              onClick={() => setShowCreateDataset(true)}
              className="btn btn-primary text-[var(--text-xs)] min-h-[var(--touch-target-min)]"
            >
              <Plus size={12} />
              Create Dataset
            </button>
          </div>
        </div>

        {showCreateDataset && (
          <div className="fixed inset-0 z-50 flex items-center justify-center">
            <div className="absolute inset-0 glass-backdrop" onClick={() => setShowCreateDataset(false)} />
            <div className="relative glass-medium border border-border-default rounded-xl p-[var(--space-6)] w-full max-w-2xl shadow-overlay">
              <div className="flex items-center justify-between mb-[var(--space-4)]">
                <h3 className="text-[var(--text-md)] font-semibold text-text-primary">Create Dataset</h3>
                <button
                  onClick={() => setShowCreateDataset(false)}
                  className="btn btn-ghost p-[var(--space-2)] min-h-[var(--touch-target-min)] min-w-[var(--touch-target-min)]"
                >
                  <X size={16} />
                </button>
              </div>
              <div className="space-y-[var(--space-3)]">
                <div>
                  <label className="block text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-1)]">
                    Dataset Name
                  </label>
                  <input
                    type="text"
                    value={newDatasetName}
                    onChange={(e) => setNewDatasetName(e.target.value)}
                    className="bg-surface-base text-[var(--text-xs)]"
                    placeholder="e.g. basic_qa_tests"
                  />
                </div>
                <div>
                  <label className="block text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-1)]">
                    Tasks (JSON)
                  </label>
                  <textarea
                    rows={10}
                    value={newDatasetJson}
                    onChange={(e) => setNewDatasetJson(e.target.value)}
                    className="bg-surface-base font-mono text-[var(--text-xs)]"
                    spellCheck={false}
                  />
                  <p className="text-[10px] text-text-muted mt-[var(--space-1)]">
                    Array of {"{"} name, input, expected, grader: "contains"|"llm"|"exact_match" {"}"}
                  </p>
                </div>
              </div>
              <div className="flex justify-end gap-[var(--space-2)] mt-[var(--space-4)]">
                <button onClick={() => setShowCreateDataset(false)} className="btn btn-secondary min-h-[var(--touch-target-min)]">
                  Cancel
                </button>
                <button
                  onClick={handleCreateDataset}
                  disabled={!newDatasetName.trim()}
                  className="btn btn-primary min-h-[var(--touch-target-min)]"
                >
                  Save
                </button>
              </div>
            </div>
          </div>
        )}

        {datasetsQuery.loading ? (
          <p className="text-[var(--text-sm)] text-text-muted">Loading datasets...</p>
        ) : datasets.length === 0 ? (
          <p className="text-[var(--text-sm)] text-text-muted">No datasets. Create or upload one to get started.</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-[var(--space-3)]">
            {datasets.map((ds) => (
              <div
                key={ds.name}
                className="p-[var(--space-3)] rounded-lg bg-surface-base border border-border-subtle"
              >
                <div className="flex items-center justify-between mb-[var(--space-2)]">
                  <span className="text-[var(--text-sm)] font-medium text-text-primary">{ds.name}</span>
                  <button
                    onClick={() => handleDeleteDataset(ds.name)}
                    className="btn btn-ghost text-status-error p-[var(--space-1)] min-h-[var(--touch-target-min)] min-w-[var(--touch-target-min)]"
                    aria-label={`Delete dataset ${ds.name}`}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
                <div className="flex items-center gap-[var(--space-3)] text-[10px] text-text-muted">
                  <span className="font-mono">{ds.task_count ?? ds.tasks?.length ?? 0} tasks</span>
                  {ds.last_modified && (
                    <span>
                      {new Date(ds.last_modified).toLocaleDateString(undefined, {
                        month: "short",
                        day: "numeric",
                      })}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="card">
        <div className="flex items-center justify-between mb-[var(--space-4)]">
          <h2 className="text-[var(--text-xs)] text-text-muted uppercase tracking-wide">
            Evaluators ({evaluators.length})
          </h2>
          <button
            onClick={() => setShowCreateEvaluator(true)}
            className="btn btn-primary text-[var(--text-xs)] min-h-[var(--touch-target-min)]"
          >
            <Plus size={12} />
            Create Evaluator
          </button>
        </div>

        {showCreateEvaluator && (
          <div className="fixed inset-0 z-50 flex items-center justify-center">
            <div className="absolute inset-0 glass-backdrop" onClick={() => setShowCreateEvaluator(false)} />
            <div className="relative glass-medium border border-border-default rounded-xl p-[var(--space-6)] w-full max-w-lg shadow-overlay">
              <div className="flex items-center justify-between mb-[var(--space-4)]">
                <h3 className="text-[var(--text-md)] font-semibold text-text-primary">Create Evaluator</h3>
                <button
                  onClick={() => setShowCreateEvaluator(false)}
                  className="btn btn-ghost p-[var(--space-2)] min-h-[var(--touch-target-min)] min-w-[var(--touch-target-min)]"
                >
                  <X size={16} />
                </button>
              </div>
              <div className="space-y-[var(--space-3)]">
                <div>
                  <label className="block text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-1)]">
                    Name
                  </label>
                  <input
                    type="text"
                    value={newEvalName}
                    onChange={(e) => setNewEvalName(e.target.value)}
                    className="bg-surface-base text-[var(--text-xs)]"
                    placeholder="e.g. relevance_checker"
                  />
                </div>
                <div>
                  <label className="block text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-1)]">
                    Grader Type
                  </label>
                  <select
                    value={newEvalGrader}
                    onChange={(e) => setNewEvalGrader(e.target.value as "contains" | "llm" | "exact_match")}
                    className="bg-surface-overlay"
                  >
                    <option value="contains">Contains</option>
                    <option value="exact_match">Exact Match</option>
                    <option value="llm">LLM</option>
                  </select>
                </div>
                {newEvalGrader === "llm" && (
                  <div>
                    <label className="block text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-1)]">
                      Criteria
                    </label>
                    <textarea
                      rows={3}
                      value={newEvalCriteria}
                      onChange={(e) => setNewEvalCriteria(e.target.value)}
                      className="bg-surface-base text-[var(--text-xs)]"
                      placeholder="Describe what makes a good response..."
                    />
                  </div>
                )}
              </div>
              <div className="flex justify-end gap-[var(--space-2)] mt-[var(--space-4)]">
                <button
                  onClick={() => setShowCreateEvaluator(false)}
                  className="btn btn-secondary min-h-[var(--touch-target-min)]"
                >
                  Cancel
                </button>
                <button
                  onClick={handleCreateEvaluator}
                  disabled={!newEvalName.trim()}
                  className="btn btn-primary min-h-[var(--touch-target-min)]"
                >
                  Save
                </button>
              </div>
            </div>
          </div>
        )}

        {evaluatorsQuery.loading ? (
          <p className="text-[var(--text-sm)] text-text-muted">Loading evaluators...</p>
        ) : evaluators.length === 0 ? (
          <p className="text-[var(--text-sm)] text-text-muted">No evaluators configured</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-[var(--space-3)]">
            {evaluators.map((ev) => (
              <div
                key={ev.name}
                className="p-[var(--space-3)] rounded-lg bg-surface-base border border-border-subtle"
              >
                <div className="flex items-center justify-between mb-[var(--space-2)]">
                  <span className="text-[var(--text-sm)] font-medium text-text-primary">{ev.name}</span>
                  <button
                    onClick={() => handleDeleteEvaluator(ev.name)}
                    className="btn btn-ghost text-status-error p-[var(--space-1)] min-h-[var(--touch-target-min)] min-w-[var(--touch-target-min)]"
                    aria-label={`Delete evaluator ${ev.name}`}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
                <span className="inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase bg-accent-muted text-accent border border-accent/20">
                  {ev.grader_type}
                </span>
                {ev.criteria && (
                  <p className="text-[var(--text-xs)] text-text-muted mt-[var(--space-2)] line-clamp-2">
                    {ev.criteria}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
