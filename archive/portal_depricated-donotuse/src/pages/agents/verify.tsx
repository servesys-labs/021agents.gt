import { useState, useEffect, useCallback, useRef } from "react";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import {
  ArrowLeft,
  ArrowUpRight,
  ArrowDownRight,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Loader2,
  Rocket,
  RotateCcw,
  XCircle,
  Minus,
} from "lucide-react";
import { useApiQuery, apiGet, apiPost } from "../../lib/api";

/* ── Types ──────────────────────────────────────────────────────── */

type EvalRun = {
  id: string;
  agent_name: string;
  dataset_name?: string;
  status: string;
  total_tasks?: number;
  completed_tasks?: number;
  pass_rate?: number;
  avg_latency_ms?: number;
  total_cost_usd?: number;
  tool_failure_rate?: number;
  started_at?: string;
  completed_at?: string;
};

type EvalTrial = {
  id: string;
  name?: string;
  input: string;
  expected_output?: string;
  actual_output?: string;
  passed: boolean;
  latency_ms?: number;
  cost_usd?: number;
  error?: string;
};

/* ── Helpers ─────────────────────────────────────────────────────── */

function pct(val?: number): string {
  if (val == null) return "--";
  return `${(val * 100).toFixed(1)}%`;
}

function ms(val?: number): string {
  if (val == null) return "--";
  return `${val.toFixed(0)}ms`;
}

function usd(val?: number): string {
  if (val == null) return "--";
  return `$${val.toFixed(4)}`;
}

/* ── Verify Page ─────────────────────────────────────────────────── */

export function VerifyPage() {
  const { name: agentName } = useParams<{ name: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const evalTriggered = searchParams.get("eval_triggered") === "true";

  const [polledRuns, setPolledRuns] = useState<EvalRun[] | null>(null);
  const [polling, setPolling] = useState(evalTriggered);
  const [trials, setTrials] = useState<EvalTrial[]>([]);
  const [trialsLoading, setTrialsLoading] = useState(false);
  const [promoting, setPromoting] = useState(false);
  const [runAgainLoading, setRunAgainLoading] = useState(false);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const prevTrialRunId = useRef<string | null>(null);

  // Initial fetch
  const runsQuery = useApiQuery<{ runs: EvalRun[] } | EvalRun[]>(
    `/api/v1/eval/runs?agent_name=${agentName ?? ""}&limit=2`,
    Boolean(agentName),
  );

  // Derive latestRuns from either polled data or query data (no setState-in-effect)
  const latestRuns: EvalRun[] = (() => {
    if (polledRuns) return polledRuns;
    const raw = runsQuery.data;
    if (!raw) return [];
    return Array.isArray(raw) ? raw : raw.runs ?? [];
  })();

  // Polling for eval completion
  useEffect(() => {
    if (!polling || !agentName) return;

    const poll = async () => {
      try {
        const raw = await apiGet<{ runs: EvalRun[] } | EvalRun[]>(
          `/api/v1/eval/runs?agent_name=${agentName}&limit=2`,
        );
        const runs = Array.isArray(raw) ? raw : (raw as { runs: EvalRun[] }).runs ?? [];
        setPolledRuns(runs);

        const latest = runs[0];
        if (latest && (latest.status === "completed" || latest.status === "failed")) {
          setPolling(false);
        }
      } catch {
        // continue polling
      }
    };

    pollingRef.current = setInterval(poll, 3000);
    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current);
    };
  }, [polling, agentName]);

  // Load trials when latest run completes
  const latestRun = latestRuns[0] ?? null;
  const previousRun = latestRuns[1] ?? null;

  const fetchTrials = useCallback((runId: string) => {
    setTrialsLoading(true);
    apiGet<{ trials: EvalTrial[] } | EvalTrial[]>(`/api/v1/eval/runs/${runId}/trials`)
      .then((raw) => {
        const t = Array.isArray(raw) ? raw : (raw as { trials: EvalTrial[] }).trials ?? [];
        setTrials(t);
      })
      .catch(() => { /* ignore */ })
      .finally(() => setTrialsLoading(false));
  }, []);

  useEffect(() => {
    if (!latestRun?.id || latestRun.status === "running" || latestRun.status === "pending") return;
    if (prevTrialRunId.current === latestRun.id) return;
    prevTrialRunId.current = latestRun.id;
    fetchTrials(latestRun.id);
  }, [latestRun?.id, latestRun?.status, fetchTrials]);

  const handlePromote = useCallback(async () => {
    if (!agentName || promoting) return;
    setPromoting(true);
    try {
      await apiPost(`/api/v1/releases/${agentName}/promote`, {
        from_channel: "staging",
        to_channel: "production",
      });
      navigate(`/agents/${agentName}?tab=releases`);
    } catch {
      setPromoting(false);
    }
  }, [agentName, promoting, navigate]);

  const handleRunAgain = useCallback(async () => {
    if (!agentName || runAgainLoading) return;
    setRunAgainLoading(true);
    try {
      await apiPost("/api/v1/eval/run", { agent_name: agentName });
      setPolling(true);
    } catch { /* ignore */ }
    setRunAgainLoading(false);
  }, [agentName, runAgainLoading]);

  const isRunning = latestRun?.status === "running" || latestRun?.status === "pending" || polling;
  const progressPct = latestRun
    ? latestRun.total_tasks
      ? ((latestRun.completed_tasks ?? 0) / latestRun.total_tasks) * 100
      : 0
    : 0;

  return (
    <div>
      {/* Back nav */}
      <button
        onClick={() => navigate(`/agents/${agentName}?tab=overview`)}
        className="flex items-center gap-[var(--space-2)] text-[var(--text-sm)] text-text-muted hover:text-text-primary transition-colors mb-[var(--space-4)] min-h-[var(--touch-target-min)]"
      >
        <ArrowLeft size={16} />
        Back to {agentName}
      </button>

      <h1 className="text-[var(--text-lg)] font-bold text-text-primary mb-[var(--space-6)]">
        Fix Verification
      </h1>

      {/* Status */}
      {isRunning && (
        <div className="card mb-[var(--space-4)]">
          <div className="flex items-center gap-[var(--space-3)] mb-[var(--space-3)]">
            <Loader2 size={16} className="text-accent animate-spin" />
            <p className="text-[var(--text-sm)] text-text-primary font-medium">
              Fix applied. Running evaluation...
            </p>
          </div>
          <div className="w-full h-2 rounded-full bg-surface-overlay overflow-hidden">
            <div
              className="h-full rounded-full bg-accent transition-all duration-500"
              style={{ width: `${Math.max(progressPct, 5)}%` }}
            />
          </div>
          {latestRun?.total_tasks && (
            <p className="text-[10px] text-text-muted mt-[var(--space-1)] font-mono">
              {latestRun.completed_tasks ?? 0} / {latestRun.total_tasks} tasks
            </p>
          )}
        </div>
      )}

      {/* Before/After Comparison */}
      {latestRun && !isRunning && (
        <div className="card mb-[var(--space-4)]">
          <h3 className="text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-3)]">
            Before / After Comparison
          </h3>
          <div className="overflow-x-auto">
            <table>
              <thead>
                <tr>
                  <th>Metric</th>
                  <th>Before</th>
                  <th>After</th>
                  <th>Change</th>
                </tr>
              </thead>
              <tbody>
                <ComparisonRow
                  label="Success Rate"
                  before={previousRun?.pass_rate}
                  after={latestRun.pass_rate}
                  format={pct}
                  higherIsBetter
                />
                <ComparisonRow
                  label="Avg Latency"
                  before={previousRun?.avg_latency_ms}
                  after={latestRun.avg_latency_ms}
                  format={ms}
                  higherIsBetter={false}
                />
                <ComparisonRow
                  label="Cost"
                  before={previousRun?.total_cost_usd}
                  after={latestRun.total_cost_usd}
                  format={usd}
                  higherIsBetter={false}
                />
                <ComparisonRow
                  label="Tool Failures"
                  before={previousRun?.tool_failure_rate}
                  after={latestRun.tool_failure_rate}
                  format={pct}
                  higherIsBetter={false}
                />
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Trial Details */}
      {!isRunning && trials.length > 0 && (
        <div className="card mb-[var(--space-4)]">
          <h3 className="text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-3)]">
            Trial Details ({trials.length})
          </h3>
          <div className="space-y-[var(--space-1)]">
            {trials.map((trial) => (
              <TrialRow key={trial.id} trial={trial} />
            ))}
          </div>
        </div>
      )}

      {trialsLoading && (
        <div className="flex items-center gap-[var(--space-2)] text-text-muted text-[var(--text-sm)] mb-[var(--space-4)]">
          <Loader2 size={14} className="animate-spin" />
          Loading trial details...
        </div>
      )}

      {/* Actions */}
      {!isRunning && latestRun && (
        <div className="flex items-center gap-[var(--space-3)] flex-wrap">
          <button
            onClick={handlePromote}
            disabled={promoting}
            className="btn btn-primary min-h-[var(--touch-target-min)]"
          >
            <Rocket size={14} />
            {promoting ? "Promoting..." : "Promote to Production"}
          </button>
          <button
            onClick={handleRunAgain}
            disabled={runAgainLoading}
            className="btn btn-secondary min-h-[var(--touch-target-min)]"
          >
            <RotateCcw size={14} />
            {runAgainLoading ? "Starting..." : "Run Again"}
          </button>
          <button
            onClick={() => navigate(`/agents/${agentName}?tab=overview`)}
            className="btn btn-ghost text-text-muted min-h-[var(--touch-target-min)]"
          >
            Back to Overview
          </button>
        </div>
      )}
    </div>
  );
}

/* ── Comparison Row ──────────────────────────────────────────────── */

function ComparisonRow({
  label,
  before,
  after,
  format,
  higherIsBetter,
}: {
  label: string;
  before?: number;
  after?: number;
  format: (v?: number) => string;
  higherIsBetter: boolean;
}) {
  const delta = before != null && after != null ? after - before : null;
  const improved = delta != null ? (higherIsBetter ? delta > 0 : delta < 0) : null;
  const unchanged = delta != null ? Math.abs(delta) < 0.001 : true;

  return (
    <tr>
      <td className="font-medium text-text-primary">{label}</td>
      <td className="font-mono">{format(before)}</td>
      <td className="font-mono">{format(after)}</td>
      <td>
        {unchanged ? (
          <span className="flex items-center gap-1 text-text-muted">
            <Minus size={12} />
            No change
          </span>
        ) : improved ? (
          <span className="flex items-center gap-1 text-status-live">
            <ArrowUpRight size={12} />
            Improved
          </span>
        ) : (
          <span className="flex items-center gap-1 text-status-error">
            <ArrowDownRight size={12} />
            Regressed
          </span>
        )}
      </td>
    </tr>
  );
}

/* ── Trial Row ───────────────────────────────────────────────────── */

function TrialRow({ trial }: { trial: EvalTrial }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div>
      <button
        onClick={() => setExpanded(!expanded)}
        className={`w-full flex items-center gap-[var(--space-3)] p-[var(--space-2)] rounded-lg transition-colors min-h-[var(--touch-target-min)] text-left ${
          trial.passed ? "hover:bg-surface-overlay" : "bg-node-glow-red hover:bg-node-glow-red-hover"
        }`}
      >
        {trial.passed ? (
          <CheckCircle2 size={14} className="text-status-live flex-shrink-0" />
        ) : (
          <XCircle size={14} className="text-status-error flex-shrink-0" />
        )}
        <span className="text-[var(--text-sm)] text-text-primary flex-1 truncate">
          {trial.name || trial.input.slice(0, 60)}
        </span>
        {trial.latency_ms != null && (
          <span className="text-[10px] text-text-muted font-mono">{trial.latency_ms}ms</span>
        )}
        <span className={`text-[10px] font-semibold uppercase ${trial.passed ? "text-status-live" : "text-status-error"}`}>
          {trial.passed ? "Pass" : "Fail"}
        </span>
        {expanded ? <ChevronDown size={12} className="text-text-muted" /> : <ChevronRight size={12} className="text-text-muted" />}
      </button>
      {expanded && (
        <div className="ml-[var(--space-8)] p-[var(--space-3)] rounded-lg border border-border-subtle bg-surface-base text-[var(--text-xs)] font-mono space-y-[var(--space-2)] mt-[var(--space-1)] transition-all">
          <div>
            <span className="text-text-muted">Input: </span>
            <span className="text-text-secondary">{trial.input}</span>
          </div>
          {trial.expected_output && (
            <div>
              <span className="text-text-muted">Expected: </span>
              <span className="text-text-secondary">{trial.expected_output}</span>
            </div>
          )}
          {trial.actual_output && (
            <div>
              <span className="text-text-muted">Actual: </span>
              <span className="text-text-secondary">{trial.actual_output}</span>
            </div>
          )}
          {trial.error && (
            <div>
              <span className="text-status-error">Error: </span>
              <span className="text-status-error">{trial.error}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export { VerifyPage as default };
