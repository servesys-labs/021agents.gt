import { useState, useEffect, useCallback } from "react";
import { Play, ChevronDown, ChevronRight, RefreshCw } from "lucide-react";

import { type EvalRun } from "../../../lib/adapters";
import { apiGet, apiPost } from "../../../lib/api";
import { useToast } from "../../../components/common/ToastProvider";

/* ── Props ────────────────────────────────────────────────────── */

type EvalTabProps = {
  agentName: string;
};

/* ── Types ────────────────────────────────────────────────────── */

type EvalTrialDetail = {
  id: string;
  input?: string;
  expected?: string;
  actual?: string;
  passed?: boolean;
  cost_usd?: number;
  latency_ms?: number;
};

/* ── Helpers ──────────────────────────────────────────────────── */

function formatDate(iso?: string): string {
  if (!iso) return "-";
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/* ── Component ────────────────────────────────────────────────── */

export const EvalTab = ({ agentName }: EvalTabProps) => {
  const { showToast } = useToast();

  const [runs, setRuns] = useState<EvalRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [expandedRun, setExpandedRun] = useState<string | null>(null);
  const [trialDetails, setTrialDetails] = useState<Record<string, EvalTrialDetail[]>>({});
  const [loadingTrials, setLoadingTrials] = useState<string | null>(null);

  /* ── Fetch runs ─────────────────────────────────────────────── */

  const fetchRuns = useCallback(async () => {
    try {
      const data = await apiGet<EvalRun[]>(`/api/v1/eval/runs?agent_name=${agentName}`);
      setRuns(Array.isArray(data) ? data : []);
    } catch {
      setRuns([]);
    }
  }, [agentName]);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      await fetchRuns();
      setLoading(false);
    };
    void load();
  }, [fetchRuns]);

  /* ── Run eval ───────────────────────────────────────────────── */

  const handleRunEval = async () => {
    setRunning(true);
    try {
      await apiPost("/api/v1/eval/run", { agent_name: agentName });
      showToast("Evaluation started", "success");
      await fetchRuns();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to start evaluation", "error");
    } finally {
      setRunning(false);
    }
  };

  /* ── Expand row ─────────────────────────────────────────────── */

  const toggleExpand = async (runId: string) => {
    if (expandedRun === runId) {
      setExpandedRun(null);
      return;
    }

    setExpandedRun(runId);

    if (!trialDetails[runId]) {
      setLoadingTrials(runId);
      try {
        const data = await apiGet<EvalTrialDetail[]>(`/api/v1/eval/runs/${runId}/trials`);
        setTrialDetails((prev) => ({ ...prev, [runId]: Array.isArray(data) ? data : [] }));
      } catch {
        setTrialDetails((prev) => ({ ...prev, [runId]: [] }));
      } finally {
        setLoadingTrials(null);
      }
    }
  };

  /* ── Render ─────────────────────────────────────────────────── */

  return (
    <div className="space-y-6">
      {/* Controls */}
      <div className="card flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-text-primary">Evaluations</h3>
          <p className="text-xs text-text-muted mt-0.5">
            Run evaluation suites against <span className="font-mono text-text-secondary">{agentName}</span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void fetchRuns()}
            className="btn btn-ghost p-1"
            style={{ minWidth: "var(--touch-target-min)", minHeight: "var(--touch-target-min)" }}
            aria-label="Refresh evaluations"
          >
            <RefreshCw size={14} />
          </button>
          <button
            type="button"
            onClick={() => void handleRunEval()}
            disabled={running}
            className="btn btn-primary"
            style={{ minHeight: "var(--touch-target-min)" }}
          >
            <Play size={14} />
            {running ? "Running..." : "Run Eval"}
          </button>
        </div>
      </div>

      {/* Eval history */}
      <div className="card">
        <h3 className="text-sm font-semibold text-text-primary mb-3">
          Eval History ({runs.length})
        </h3>

        {loading ? (
          <p className="text-xs text-text-muted py-4 text-center">Loading evaluations...</p>
        ) : runs.length === 0 ? (
          <div className="border border-border-default rounded-md p-6 flex items-center justify-center">
            <p className="text-xs text-text-muted">No evaluations run yet. Click "Run Eval" to start.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {runs.map((run) => {
              const isExpanded = expandedRun === run.id;
              const trials = trialDetails[run.id];

              return (
                <div key={run.id} className="border border-border-default rounded-md overflow-hidden">
                  {/* Row header */}
                  <button
                    type="button"
                    onClick={() => void toggleExpand(run.id)}
                    className="flex items-center gap-3 w-full px-3 py-2 bg-surface-base text-left transition-colors hover:bg-surface-overlay"
                    style={{ minHeight: "var(--touch-target-min)", border: "none", cursor: "pointer" }}
                  >
                    {isExpanded ? (
                      <ChevronDown size={14} className="text-text-muted flex-shrink-0" />
                    ) : (
                      <ChevronRight size={14} className="text-text-muted flex-shrink-0" />
                    )}

                    <span className="text-xs text-text-muted w-28 flex-shrink-0">
                      {formatDate(run.started_at)}
                    </span>

                    <span
                      className="inline-block text-xs font-medium px-2 py-0.5 rounded-full flex-shrink-0"
                      style={{
                        backgroundColor:
                          run.status === "completed" ? "var(--color-status-live)" :
                          run.status === "running" ? "var(--color-status-warning)" :
                          run.status === "failed" ? "var(--color-status-error)" :
                          "var(--color-surface-overlay)",
                        color: "var(--color-text-primary)",
                      }}
                    >
                      {run.status}
                    </span>

                    {run.pass_rate != null && (
                      <span className="text-sm font-mono text-text-secondary flex-shrink-0">
                        {(run.pass_rate * 100).toFixed(1)}% pass
                      </span>
                    )}

                    {run.total_tasks != null && (
                      <span className="text-xs text-text-muted flex-shrink-0">
                        {run.completed_tasks ?? 0}/{run.total_tasks} trials
                      </span>
                    )}

                    <span className="flex-1" />

                    {run.dataset_name && (
                      <span className="text-xs text-text-muted font-mono truncate max-w-[10rem]">
                        {run.dataset_name}
                      </span>
                    )}
                  </button>

                  {/* Expanded trial details */}
                  {isExpanded && (
                    <div className="border-t border-border-default px-4 py-3 bg-surface-base/50">
                      {loadingTrials === run.id ? (
                        <p className="text-xs text-text-muted">Loading trial details...</p>
                      ) : !trials || trials.length === 0 ? (
                        <p className="text-xs text-text-muted">No trial details available.</p>
                      ) : (
                        <div className="space-y-2">
                          {trials.map((trial, idx) => (
                            <div
                              key={trial.id ?? idx}
                              className="flex items-start gap-3 px-3 py-2 border border-border-default rounded-md text-xs"
                            >
                              <span
                                className="inline-block w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold flex-shrink-0"
                                style={{
                                  backgroundColor: trial.passed
                                    ? "var(--color-status-live)"
                                    : "var(--color-status-error)",
                                  color: "var(--color-text-primary)",
                                }}
                              >
                                {trial.passed ? "P" : "F"}
                              </span>
                              <div className="flex-1 min-w-0 space-y-1">
                                {trial.input && (
                                  <p className="text-text-secondary">
                                    <span className="text-text-muted">Input: </span>
                                    {trial.input}
                                  </p>
                                )}
                                {trial.expected && (
                                  <p className="text-text-muted">
                                    <span>Expected: </span>
                                    {trial.expected}
                                  </p>
                                )}
                                {trial.actual && (
                                  <p className="text-text-muted">
                                    <span>Actual: </span>
                                    {trial.actual}
                                  </p>
                                )}
                              </div>
                              <div className="flex flex-col items-end gap-1 flex-shrink-0 text-text-muted">
                                {trial.cost_usd != null && (
                                  <span>${trial.cost_usd.toFixed(4)}</span>
                                )}
                                {trial.latency_ms != null && (
                                  <span>{trial.latency_ms}ms</span>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
