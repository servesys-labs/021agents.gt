import { useMemo, useState } from "react";
import { FlaskConical, TrendingUp, CheckCircle, XCircle, AlertTriangle } from "lucide-react";

import { PageHeader } from "../../components/common/PageHeader";
import { QueryState } from "../../components/common/QueryState";
import { StatusBadge } from "../../components/common/StatusBadge";
import { EmptyState } from "../../components/common/EmptyState";
import { Tabs } from "../../components/common/Tabs";
import { useApiQuery } from "../../lib/api";
import { extractList } from "../../lib/normalize";

/* ── Types ──────────────────────────────────────────────────────── */

type AutoResearchRun = {
  id?: number;
  run_id: string;
  agent_name: string;
  mode: string;
  primary_metric: string;
  status: string;
  total_iterations: number;
  baseline_score: number;
  best_score: number;
  improvements_kept: number;
  experiments_discarded: number;
  experiments_crashed: number;
  total_cost_usd: number;
  elapsed_seconds: number;
  backend: string;
  proposer_model: string;
  source: string;
  applied: number;
  started_at: number;
  completed_at?: number;
};

type AutoResearchExperiment = {
  id?: number;
  run_id: string;
  agent_name: string;
  iteration: number;
  hypothesis: string;
  description: string;
  score_before: number;
  score_after: number;
  improvement: number;
  primary_metric: string;
  status: string;
  val_bpb: number;
  total_cost_usd: number;
  commit_hash: string;
  created_at: number;
};

/* ── Helpers ────────────────────────────────────────────────────── */

const formatDuration = (seconds: number) => {
  if (seconds < 60) return `${seconds.toFixed(0)}s`;
  if (seconds < 3600) return `${(seconds / 60).toFixed(1)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
};

const improvementColor = (val: number) =>
  val > 0 ? "text-chart-green" : val < 0 ? "text-status-error" : "text-text-muted";

const statusIcon = (status: string) => {
  if (status === "keep") return <CheckCircle size={14} className="text-chart-green" />;
  if (status === "discard") return <XCircle size={14} className="text-text-muted" />;
  if (status === "crash") return <AlertTriangle size={14} className="text-status-error" />;
  return null;
};

/* ── Page ───────────────────────────────────────────────────────── */

export const AutoResearchPage = () => {
  const runsQuery = useApiQuery<{ runs: AutoResearchRun[] } | AutoResearchRun[]>("/api/v1/autoresearch/runs?limit=50");
  const runs = useMemo(() => extractList<AutoResearchRun>(runsQuery.data, "runs"), [runsQuery.data]);

  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const detailQuery = useApiQuery<{ experiments?: AutoResearchExperiment[] } & AutoResearchRun>(
    `/api/v1/autoresearch/runs/${selectedRunId}`,
    Boolean(selectedRunId),
  );

  const experiments = useMemo(
    () => extractList<AutoResearchExperiment>(detailQuery.data, "experiments"),
    [detailQuery.data],
  );

  /* ── Summary stats ──────────────────────────────────────── */
  const totalRuns = runs.length;
  const totalExperiments = runs.reduce((s, r) => s + r.total_iterations, 0);
  const totalKept = runs.reduce((s, r) => s + r.improvements_kept, 0);
  const totalCost = runs.reduce((s, r) => s + r.total_cost_usd, 0);

  /* ── Runs tab ───────────────────────────────────────────── */
  const runsTab = (
    <div>
      <QueryState loading={runsQuery.loading} error={runsQuery.error} isEmpty={runs.length === 0} emptyMessage="" onRetry={() => void runsQuery.refetch()}>
        {runs.length === 0 ? (
          <EmptyState
            icon={<FlaskConical size={40} />}
            title="No autoresearch runs yet"
            description="Run 'agentos autoresearch agent <name> <tasks.json>' or use the autoresearch tool from the meta-agent"
          />
        ) : (
          <div className="card p-0"><div className="overflow-x-auto">
            <table>
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>Status</th>
                  <th>Baseline</th>
                  <th>Best</th>
                  <th>Kept</th>
                  <th>Discarded</th>
                  <th>Cost</th>
                  <th>Duration</th>
                  <th>Source</th>
                  <th>Date</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr
                    key={r.run_id || r.id}
                    onClick={() => setSelectedRunId(r.run_id)}
                    className="cursor-pointer hover:bg-surface-overlay/50"
                  >
                    <td><span className="text-text-primary text-sm font-medium">{r.agent_name}</span></td>
                    <td><StatusBadge status={r.status} /></td>
                    <td><span className="font-mono text-xs text-text-muted">{r.baseline_score.toFixed(3)}</span></td>
                    <td>
                      <span className={`font-mono text-xs ${r.best_score > r.baseline_score ? "text-chart-green" : "text-text-muted"}`}>
                        {r.best_score.toFixed(3)}
                      </span>
                    </td>
                    <td><span className="font-mono text-xs text-chart-green">{r.improvements_kept}</span></td>
                    <td><span className="font-mono text-xs text-text-muted">{r.experiments_discarded}</span></td>
                    <td><span className="font-mono text-xs text-text-muted">${r.total_cost_usd.toFixed(3)}</span></td>
                    <td><span className="text-xs text-text-muted">{formatDuration(r.elapsed_seconds)}</span></td>
                    <td><span className="text-[10px] text-text-muted">{r.source}</span></td>
                    <td>
                      <span className="text-[10px] text-text-muted">
                        {r.started_at ? new Date(r.started_at * 1000).toLocaleDateString() : "--"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div></div>
        )}
      </QueryState>
    </div>
  );

  /* ── Experiments detail tab ─────────────────────────────── */
  const experimentsTab = (
    <div>
      {!selectedRunId ? (
        <EmptyState
          icon={<TrendingUp size={40} />}
          title="Select a run"
          description="Click a run in the Runs tab to see its experiments"
        />
      ) : (
        <QueryState loading={detailQuery.loading} error={detailQuery.error} isEmpty={experiments.length === 0} emptyMessage="" onRetry={() => void detailQuery.refetch()}>
          {/* Run summary card */}
          {detailQuery.data && (
            <div className="card mb-4">
              <div className="flex items-center gap-3 mb-3">
                <FlaskConical size={16} className="text-accent-primary" />
                <span className="text-sm font-semibold text-text-primary">{detailQuery.data.agent_name}</span>
                <StatusBadge status={detailQuery.data.status} />
                {detailQuery.data.applied ? (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-chart-green/20 text-chart-green">applied</span>
                ) : null}
              </div>
              <div className="grid grid-cols-4 gap-4 text-xs">
                <div>
                  <span className="text-text-muted">Baseline</span>
                  <div className="font-mono text-text-primary">{detailQuery.data.baseline_score.toFixed(3)}</div>
                </div>
                <div>
                  <span className="text-text-muted">Best</span>
                  <div className="font-mono text-chart-green">{detailQuery.data.best_score.toFixed(3)}</div>
                </div>
                <div>
                  <span className="text-text-muted">Improvement</span>
                  <div className={`font-mono ${improvementColor(detailQuery.data.best_score - detailQuery.data.baseline_score)}`}>
                    {detailQuery.data.best_score > detailQuery.data.baseline_score ? "+" : ""}
                    {((detailQuery.data.best_score - detailQuery.data.baseline_score) * 100).toFixed(1)}%
                  </div>
                </div>
                <div>
                  <span className="text-text-muted">Model</span>
                  <div className="font-mono text-text-primary truncate">{detailQuery.data.proposer_model || "--"}</div>
                </div>
              </div>
            </div>
          )}

          {/* Experiment rows */}
          {experiments.length === 0 ? (
            <EmptyState icon={<TrendingUp size={40} />} title="No experiments" description="This run has no recorded experiments" />
          ) : (
            <div className="card p-0"><div className="overflow-x-auto">
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Status</th>
                    <th>Description</th>
                    <th>Score</th>
                    <th>Delta</th>
                    <th>Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {experiments.map((exp) => (
                    <tr key={`${exp.run_id}-${exp.iteration}`}>
                      <td><span className="font-mono text-xs text-text-muted">{exp.iteration}</span></td>
                      <td>
                        <div className="flex items-center gap-1.5">
                          {statusIcon(exp.status)}
                          <span className="text-xs">{exp.status}</span>
                        </div>
                      </td>
                      <td>
                        <div className="max-w-[300px]">
                          <div className="text-sm text-text-primary truncate">{exp.description}</div>
                          {exp.hypothesis && (
                            <div className="text-[10px] text-text-muted truncate mt-0.5">{exp.hypothesis}</div>
                          )}
                        </div>
                      </td>
                      <td><span className="font-mono text-xs text-text-primary">{exp.score_after.toFixed(3)}</span></td>
                      <td>
                        <span className={`font-mono text-xs ${improvementColor(exp.improvement)}`}>
                          {exp.improvement >= 0 ? "+" : ""}{exp.improvement.toFixed(3)}
                        </span>
                      </td>
                      <td><span className="font-mono text-xs text-text-muted">${exp.total_cost_usd.toFixed(3)}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div></div>
          )}
        </QueryState>
      )}
    </div>
  );

  return (
    <div className="page-container">
      <PageHeader
        title="Autoresearch"
        description="Autonomous agent improvement — hypothesis, evaluate, keep or discard"
        icon={<FlaskConical size={20} />}
      />

      {/* Summary cards */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        {[
          { label: "Total runs", value: totalRuns, color: "text-text-primary" },
          { label: "Experiments", value: totalExperiments, color: "text-accent-primary" },
          { label: "Improvements kept", value: totalKept, color: "text-chart-green" },
          { label: "Total cost", value: `$${totalCost.toFixed(2)}`, color: "text-text-muted" },
        ].map(({ label, value, color }) => (
          <div key={label} className="card">
            <div className="text-[10px] uppercase tracking-wider text-text-muted mb-1">{label}</div>
            <div className={`text-2xl font-mono font-semibold ${color}`}>{value}</div>
          </div>
        ))}
      </div>

      <Tabs
        tabs={[
          { id: "runs", label: "Runs", content: runsTab },
          { id: "experiments", label: "Experiments", content: experimentsTab },
        ]}
      />
    </div>
  );
};
