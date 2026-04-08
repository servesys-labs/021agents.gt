import { useState } from "react";
import { useApiQuery, apiPost, getToken } from "../../../lib/api";
import {
  Zap, CheckCircle, XCircle, AlertTriangle, TrendingUp,
  Clock, DollarSign, Activity, Play, ChevronDown, ChevronRight,
  Wrench, Brain, Shield, Cpu, Database
} from "lucide-react";

interface Proposal {
  proposal_id: string;
  title: string;
  rationale: string;
  category: string;
  priority: number;
  status: string;
  config_diff_json: string;
  evidence_json: string;
  created_at: number;
  reviewed_at?: number;
  review_note?: string;
}

interface AnalysisReport {
  agent_name: string;
  analyzed_at: number;
  session_count: number;
  time_window_days: number;
  success_rate: number;
  avg_cost_usd: number;
  avg_turns: number;
  avg_wall_clock_seconds: number;
  failure_clusters: Array<{ pattern: string; count: number; severity: number; example_errors: string[] }>;
  cost_anomalies: Array<{ session_id: string; cost_usd: number; deviation_factor: number; likely_cause: string }>;
  tool_analysis: Array<{ tool_name: string; call_count: number; failure_rate: number; avg_latency_ms: number }>;
  unused_tools: string[];
  top_error_sources: Array<{ source: string; count: number }>;
  avg_quality_score: number;
  task_completion_rate: number;
  recommendations: string[];
}

interface LedgerEntry {
  proposal_id: string;
  action: string;
  note: string;
  created_at: number;
}

type ApplyBlockedPayload = {
  error?: string;
  message?: string;
  details?: {
    min_pass?: number;
    min_eval_trials?: number;
    min_report_sessions?: number;
    eval_window?: { best_pass_rate?: number; best_total_trials?: number; runs_in_window?: number };
    latest_report?: { session_count?: number; success_rate?: number } | null;
  };
  markers_preview?: {
    gate_snapshot?: {
      eval_window?: { best_pass_rate?: number; best_total_trials?: number; runs_in_window?: number };
      latest_report?: { session_count?: number; success_rate?: number } | null;
    };
  };
};

type GateCheck = {
  label: string;
  passed: boolean;
  detail: string;
};

const CATEGORY_ICONS: Record<string, typeof Zap> = {
  prompt: Brain, tools: Wrench, governance: Shield, model: Cpu, memory: Database,
};

const PRIORITY_COLORS: Record<string, string> = {
  high: "text-status-error", medium: "text-yellow-400", low: "text-text-muted",
};

function priorityLabel(p: number): string {
  if (p >= 0.7) return "high";
  if (p >= 0.4) return "medium";
  return "low";
}

function buildGateChecklist(
  payload: ApplyBlockedPayload | null | undefined,
  options: { autopilot: boolean; force: boolean },
): GateCheck[] {
  const details = payload?.details;
  const minPass = Number(details?.min_pass ?? 0);
  const minEvalTrials = Number(details?.min_eval_trials ?? 0);
  const minReportSessions = Number(details?.min_report_sessions ?? 0);
  const evalWindow = details?.eval_window;
  const latestReport = details?.latest_report;

  const evalPass =
    Number(evalWindow?.best_total_trials ?? 0) >= minEvalTrials &&
    Number(evalWindow?.best_pass_rate ?? 0) >= minPass;
  const reportPass =
    Number(latestReport?.session_count ?? 0) >= minReportSessions &&
    Number(latestReport?.success_rate ?? 0) >= minPass;

  return [
    {
      label: "Eval Gate",
      passed: evalPass,
      detail: `need trials>=${minEvalTrials}, pass>=${minPass}; got trials=${Number(evalWindow?.best_total_trials ?? 0)}, pass=${Number(evalWindow?.best_pass_rate ?? 0)}`,
    },
    {
      label: "Report Gate",
      passed: reportPass,
      detail: `need sessions>=${minReportSessions}, success>=${minPass}; got sessions=${Number(latestReport?.session_count ?? 0)}, success=${Number(latestReport?.success_rate ?? 0)}`,
    },
    {
      label: "Force Override",
      passed: options.force === true,
      detail: options.autopilot
        ? (options.force ? "enabled" : "not enabled")
        : "autopilot not requested",
    },
  ];
}

export const EvolveTab = ({ agentName }: { agentName: string }) => {
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisDays, setAnalysisDays] = useState(7);
  const [expandedProposal, setExpandedProposal] = useState<string | null>(null);
  const [reviewNotes, setReviewNotes] = useState<Record<string, string>>({});
  const [confirmApply, setConfirmApply] = useState<string | null>(null);
  const [applyError, setApplyError] = useState<Record<string, ApplyBlockedPayload | null>>({});
  const [applyOptions, setApplyOptions] = useState<
    Record<string, { autopilot: boolean; force: boolean; reason: string }>
  >({});

  const reportQuery = useApiQuery<{ report: AnalysisReport | null; sessions_analyzed?: number }>(
    `/api/v1/evolve/${agentName}/report`,
  );
  const proposalsQuery = useApiQuery<{ proposals: Proposal[] }>(
    `/api/v1/evolve/${agentName}/proposals`,
  );
  const ledgerQuery = useApiQuery<{ entries: LedgerEntry[] }>(
    `/api/v1/evolve/${agentName}/ledger`,
  );

  const report = reportQuery.data?.report;
  const proposals = proposalsQuery.data?.proposals || [];
  const ledger = ledgerQuery.data?.entries || [];

  const pendingProposals = proposals.filter((p) => p.status === "pending");
  const resolvedProposals = proposals.filter((p) => p.status !== "pending");

  async function runAnalysis() {
    setAnalyzing(true);
    try {
      await apiPost(`/api/v1/evolve/${agentName}/analyze`, { days: analysisDays });
      reportQuery.refetch();
      proposalsQuery.refetch();
    } catch (err) {
      console.error("Analysis failed:", err);
    } finally {
      setAnalyzing(false);
    }
  }

  async function approveProposal(proposalId: string) {
    const note = reviewNotes[proposalId] || "";
    await apiPost(`/api/v1/evolve/${agentName}/proposals/${proposalId}/approve`, { note });
    setReviewNotes((prev) => { const n = { ...prev }; delete n[proposalId]; return n; });
    proposalsQuery.refetch();
    ledgerQuery.refetch();
  }

  async function rejectProposal(proposalId: string) {
    const note = reviewNotes[proposalId] || "";
    await apiPost(`/api/v1/evolve/${agentName}/proposals/${proposalId}/reject`, { note });
    setReviewNotes((prev) => { const n = { ...prev }; delete n[proposalId]; return n; });
    proposalsQuery.refetch();
    ledgerQuery.refetch();
  }

  function getApplyOptions(proposalId: string) {
    return applyOptions[proposalId] || { autopilot: false, force: false, reason: "" };
  }

  async function applyProposal(proposalId: string) {
    const options = getApplyOptions(proposalId);
    try {
      const token = getToken();
      const resp = await fetch(`/api/v1/evolve/${agentName}/proposals/${proposalId}/apply`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          autopilot: options.autopilot,
          evolution_apply_guard: options.force
            ? { force: true, reason: options.reason || "manual_force" }
            : undefined,
        }),
      });
      if (!resp.ok) {
        const payload = (await resp.json().catch(() => ({}))) as ApplyBlockedPayload;
        const msg = payload.message || payload.error || `Apply failed (${resp.status})`;
        throw { msg, payload };
      }
      setApplyError((prev) => {
        const next = { ...prev };
        delete next[proposalId];
        return next;
      });
      setConfirmApply(null);
      proposalsQuery.refetch();
      ledgerQuery.refetch();
    } catch (err: any) {
      const payload = (err?.payload || null) as ApplyBlockedPayload | null;
      const fallback = err?.msg ? { message: String(err.msg) } : { message: "Failed to apply proposal" };
      setApplyError((prev) => ({ ...prev, [proposalId]: payload || fallback }));
    }
  }

  return (
    <div className="space-y-6">
      {/* ── Analysis Trigger ──────────────────────────────────── */}
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-sm font-semibold text-text-primary flex items-center gap-2">
              <Zap size={16} /> Evolution Analyzer
            </h3>
            <p className="text-xs text-text-muted mt-1">
              Analyze recent sessions to discover failure patterns, cost anomalies, and generate improvement proposals.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={analysisDays}
              onChange={(e) => setAnalysisDays(Number(e.target.value))}
              className="text-xs bg-surface-base border border-border-default rounded px-2 py-1 text-text-secondary"
            >
              <option value={1}>Last 24h</option>
              <option value={7}>Last 7 days</option>
              <option value={30}>Last 30 days</option>
              <option value={90}>Last 90 days</option>
            </select>
            <button
              onClick={runAnalysis}
              disabled={analyzing}
              className="btn btn-primary text-xs flex items-center gap-1.5"
            >
              <Play size={12} />
              {analyzing ? "Analyzing..." : "Run Analysis"}
            </button>
          </div>
        </div>

        {/* ── Report Summary ─────────────────────────────────── */}
        {report && (
          <div className="space-y-4">
            <div className="grid grid-cols-4 gap-3">
              <MetricCard
                icon={<Activity size={14} />}
                label="Success Rate"
                value={`${(report.success_rate * 100).toFixed(0)}%`}
                color={report.success_rate > 0.7 ? "text-status-live" : "text-status-error"}
              />
              <MetricCard
                icon={<DollarSign size={14} />}
                label="Avg Cost"
                value={`$${report.avg_cost_usd.toFixed(4)}`}
              />
              <MetricCard
                icon={<TrendingUp size={14} />}
                label="Avg Turns"
                value={report.avg_turns.toFixed(1)}
              />
              <MetricCard
                icon={<Clock size={14} />}
                label="Sessions"
                value={String(report.session_count)}
              />
            </div>

            {/* Recommendations */}
            {report.recommendations.length > 0 && (
              <div className="border border-border-default rounded-md p-3">
                <h4 className="text-xs font-semibold text-text-primary mb-2 flex items-center gap-1.5">
                  <AlertTriangle size={12} /> Recommendations
                </h4>
                <ul className="space-y-1">
                  {report.recommendations.map((rec, i) => (
                    <li key={i} className="text-xs text-text-secondary flex items-start gap-2">
                      <span className="text-accent mt-0.5">-</span>
                      {rec}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Failure Clusters */}
            {report.failure_clusters.length > 0 && (
              <div className="border border-border-default rounded-md p-3">
                <h4 className="text-xs font-semibold text-text-primary mb-2">Failure Patterns</h4>
                <div className="space-y-1.5">
                  {report.failure_clusters.slice(0, 5).map((cluster, i) => (
                    <div key={i} className="flex items-center justify-between text-xs">
                      <span className="font-mono text-text-secondary">{cluster.pattern}</span>
                      <div className="flex items-center gap-3">
                        <span className="text-text-muted">{cluster.count}x</span>
                        <div className="w-16 h-1.5 rounded-full bg-surface-base overflow-hidden">
                          <div
                            className="h-full rounded-full bg-status-error"
                            style={{ width: `${Math.min(100, cluster.severity * 10)}%` }}
                          />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Tool Performance */}
            {report.tool_analysis.length > 0 && (
              <div className="border border-border-default rounded-md p-3">
                <h4 className="text-xs font-semibold text-text-primary mb-2">Tool Performance</h4>
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-text-muted">
                      <th className="text-left py-1">Tool</th>
                      <th className="text-right py-1">Calls</th>
                      <th className="text-right py-1">Fail %</th>
                      <th className="text-right py-1">Avg Latency</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.tool_analysis.slice(0, 8).map((tool) => (
                      <tr key={tool.tool_name} className="border-t border-border-subtle">
                        <td className="py-1 font-mono text-text-secondary">{tool.tool_name}</td>
                        <td className="py-1 text-right text-text-muted">{tool.call_count}</td>
                        <td className={`py-1 text-right ${tool.failure_rate > 0.3 ? "text-status-error" : "text-text-muted"}`}>
                          {(tool.failure_rate * 100).toFixed(0)}%
                        </td>
                        <td className="py-1 text-right text-text-muted">{tool.avg_latency_ms}ms</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {!report && !reportQuery.loading && (
          <div className="border border-border-default rounded-md p-8 flex flex-col items-center justify-center">
            <Zap size={24} className="text-text-muted mb-2" />
            <p className="text-xs text-text-muted">No analysis runs yet. Click "Run Analysis" to start.</p>
          </div>
        )}
      </div>

      {/* ── Pending Proposals ─────────────────────────────────── */}
      {pendingProposals.length > 0 && (
        <div className="card">
          <h3 className="text-sm font-semibold text-text-primary mb-3 flex items-center gap-2">
            <AlertTriangle size={16} /> Pending Proposals ({pendingProposals.length})
          </h3>
          <div className="space-y-2">
            {pendingProposals.map((proposal) => {
              const CategoryIcon = CATEGORY_ICONS[proposal.category] || Zap;
              const evidence = safeJsonParse(proposal.evidence_json);
              const isExpanded = expandedProposal === proposal.proposal_id;

              return (
                <div key={proposal.proposal_id} className="border border-border-default rounded-md">
                  <button
                    onClick={() => setExpandedProposal(isExpanded ? null : proposal.proposal_id)}
                    className="w-full flex items-center justify-between p-3 text-left hover:bg-surface-base/50 transition-colors"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <CategoryIcon size={14} className="text-accent shrink-0" />
                      <span className="text-xs font-medium text-text-primary truncate">{proposal.title}</span>
                      <span className={`text-[10px] uppercase font-semibold ${PRIORITY_COLORS[priorityLabel(proposal.priority)]}`}>
                        {priorityLabel(proposal.priority)}
                      </span>
                    </div>
                    {isExpanded ? <ChevronDown size={14} className="text-text-muted" /> : <ChevronRight size={14} className="text-text-muted" />}
                  </button>

                  {isExpanded && (
                    <div className="px-3 pb-3 space-y-3 border-t border-border-subtle">
                      <p className="text-xs text-text-secondary mt-2">{proposal.rationale}</p>

                      {evidence && (
                        <div className="bg-surface-base rounded p-2">
                          <span className="text-[10px] uppercase text-text-muted font-semibold">Evidence</span>
                          <div className="text-xs text-text-secondary mt-1">
                            <span className="font-mono">{evidence.metric}</span>: {String(evidence.current_value)}
                            {evidence.suggested_value && (
                              <span className="text-accent"> → {String(evidence.suggested_value)}</span>
                            )}
                          </div>
                          {evidence.supporting_data?.length > 0 && (
                            <div className="mt-1 space-y-0.5">
                              {evidence.supporting_data.slice(0, 3).map((d: string, i: number) => (
                                <div key={i} className="text-[11px] text-text-muted font-mono truncate">- {d}</div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}

                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          placeholder="Review note (optional)"
                          value={reviewNotes[proposal.proposal_id] || ""}
                          onChange={(e) => setReviewNotes((prev) => ({ ...prev, [proposal.proposal_id]: e.target.value }))}
                          className="flex-1 text-xs bg-surface-base border border-border-default rounded px-2 py-1 text-text-secondary"
                        />
                        <button
                          onClick={() => approveProposal(proposal.proposal_id)}
                          className="btn btn-primary text-xs flex items-center gap-1"
                        >
                          <CheckCircle size={12} /> Approve
                        </button>
                        <button
                          onClick={() => rejectProposal(proposal.proposal_id)}
                          className="btn btn-ghost text-xs flex items-center gap-1 text-status-error"
                        >
                          <XCircle size={12} /> Reject
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Approved (ready to apply) ─────────────────────────── */}
      {resolvedProposals.filter((p) => p.status === "approved").length > 0 && (
        <div className="card">
          <h3 className="text-sm font-semibold text-text-primary mb-3 flex items-center gap-2">
            <CheckCircle size={16} className="text-status-live" /> Approved — Ready to Apply
          </h3>
          <div className="space-y-2">
            {resolvedProposals
              .filter((p) => p.status === "approved")
              .map((proposal) => (
                <div key={proposal.proposal_id} className="flex items-center justify-between p-2 border border-border-default rounded-md">
                  <div className="flex items-center gap-2 min-w-0">
                    <CheckCircle size={12} className="text-status-live shrink-0" />
                    <span className="text-xs text-text-primary truncate">{proposal.title}</span>
                    {proposal.review_note && (
                      <span className="text-[10px] text-text-muted">— {proposal.review_note}</span>
                    )}
                  </div>
                  {confirmApply === proposal.proposal_id ? (
                    <div className="flex flex-col items-end gap-1.5">
                      <span className="text-[10px] text-status-error font-semibold">
                        This will modify the agent config.
                      </span>
                      <div className="flex items-center gap-2">
                        <label className="text-[10px] text-text-muted flex items-center gap-1.5">
                          <input
                            type="checkbox"
                            checked={getApplyOptions(proposal.proposal_id).autopilot}
                            onChange={(e) =>
                              setApplyOptions((prev) => ({
                                ...prev,
                                [proposal.proposal_id]: {
                                  ...getApplyOptions(proposal.proposal_id),
                                  autopilot: e.target.checked,
                                },
                              }))
                            }
                          />
                          Autopilot gates
                        </label>
                        {getApplyOptions(proposal.proposal_id).autopilot ? (
                          <label className="text-[10px] text-text-muted flex items-center gap-1.5">
                            <input
                              type="checkbox"
                              checked={getApplyOptions(proposal.proposal_id).force}
                              onChange={(e) =>
                                setApplyOptions((prev) => ({
                                  ...prev,
                                  [proposal.proposal_id]: {
                                    ...getApplyOptions(proposal.proposal_id),
                                    force: e.target.checked,
                                  },
                                }))
                              }
                            />
                            Force override
                          </label>
                        ) : null}
                      </div>
                      {getApplyOptions(proposal.proposal_id).autopilot &&
                      getApplyOptions(proposal.proposal_id).force ? (
                        <input
                          type="text"
                          placeholder="force reason (optional)"
                          value={getApplyOptions(proposal.proposal_id).reason}
                          onChange={(e) =>
                            setApplyOptions((prev) => ({
                              ...prev,
                              [proposal.proposal_id]: {
                                ...getApplyOptions(proposal.proposal_id),
                                reason: e.target.value,
                              },
                            }))
                          }
                          className="text-xs bg-surface-base border border-border-default rounded px-2 py-1 w-[240px]"
                        />
                      ) : null}
                      {applyError[proposal.proposal_id] ? (
                        <div className="max-w-[420px] border border-status-error/30 bg-status-error/10 rounded p-2">
                          <p className="text-[10px] text-status-error font-semibold">
                            {applyError[proposal.proposal_id]?.message || applyError[proposal.proposal_id]?.error || "Apply blocked"}
                          </p>
                          {applyError[proposal.proposal_id]?.details ? (
                            <div className="mt-1 text-[10px] text-text-secondary space-y-0.5">
                              <p>
                                Gate mins: pass {applyError[proposal.proposal_id]?.details?.min_pass ?? 0},
                                eval trials {applyError[proposal.proposal_id]?.details?.min_eval_trials ?? 0},
                                report sessions {applyError[proposal.proposal_id]?.details?.min_report_sessions ?? 0}
                              </p>
                              <p>
                                Eval window: pass {applyError[proposal.proposal_id]?.details?.eval_window?.best_pass_rate ?? 0},
                                trials {applyError[proposal.proposal_id]?.details?.eval_window?.best_total_trials ?? 0}
                              </p>
                              <p>
                                Latest report: sessions {applyError[proposal.proposal_id]?.details?.latest_report?.session_count ?? 0},
                                success {applyError[proposal.proposal_id]?.details?.latest_report?.success_rate ?? 0}
                              </p>
                              <div className="mt-1 border-t border-status-error/20 pt-1 space-y-1">
                                {buildGateChecklist(
                                  applyError[proposal.proposal_id],
                                  getApplyOptions(proposal.proposal_id),
                                ).map((gate) => (
                                  <div key={gate.label} className="flex items-start justify-between gap-2">
                                    <span className={`font-semibold ${gate.passed ? "text-status-live" : "text-status-error"}`}>
                                      {gate.passed ? "PASS" : "FAIL"} {gate.label}
                                    </span>
                                    <span className="text-right text-text-muted">{gate.detail}</span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                      <div className="flex items-center gap-1.5">
                        <button onClick={() => applyProposal(proposal.proposal_id)} className="btn btn-primary text-xs">
                          Confirm
                        </button>
                        <button onClick={() => setConfirmApply(null)} className="btn btn-ghost text-xs">
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      onClick={() => {
                        setApplyError((prev) => {
                          const next = { ...prev };
                          delete next[proposal.proposal_id];
                          return next;
                        });
                        setConfirmApply(proposal.proposal_id);
                      }}
                      className="btn btn-primary text-xs"
                    >
                      Apply
                    </button>
                  )}
                </div>
              ))}
          </div>
        </div>
      )}

      {/* ── Evolution Ledger ──────────────────────────────────── */}
      {ledger.length > 0 && (
        <div className="card">
          <h3 className="text-sm font-semibold text-text-primary mb-3 flex items-center gap-2">
            <Clock size={16} /> Evolution History
          </h3>
          <div className="space-y-1.5">
            {ledger.slice(0, 20).map((entry, i) => (
              <div key={i} className="flex items-center gap-3 text-xs py-1.5 border-b border-border-subtle last:border-0">
                <span className={`w-16 shrink-0 font-semibold ${
                  entry.action === "applied" ? "text-status-live" :
                  entry.action === "approved" ? "text-accent" :
                  entry.action === "rejected" ? "text-status-error" : "text-text-muted"
                }`}>
                  {entry.action}
                </span>
                <span className="text-text-secondary flex-1 truncate">{entry.note || entry.proposal_id}</span>
                <span className="text-text-muted shrink-0">
                  {entry.created_at ? new Date(entry.created_at * 1000).toLocaleDateString() : ""}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

// ── Helper Components ─────────────────────────────────────────

function MetricCard({ icon, label, value, color }: {
  icon: React.ReactNode;
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <div className="border border-border-default rounded-md p-3">
      <div className="flex items-center gap-1.5 mb-1">
        <span className="text-text-muted">{icon}</span>
        <span className="text-[10px] uppercase text-text-muted font-semibold tracking-wide">{label}</span>
      </div>
      <span className={`text-lg font-bold ${color || "text-text-primary"}`}>{value}</span>
    </div>
  );
}

function safeJsonParse(val: unknown): any {
  if (!val) return undefined;
  if (typeof val === "object") return val;
  try { return JSON.parse(String(val)); } catch { return undefined; }
}
