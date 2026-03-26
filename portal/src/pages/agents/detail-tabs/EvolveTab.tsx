import { useState } from "react";
import { useApiQuery, apiPost } from "../../../lib/api";
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

export const EvolveTab = ({ agentName }: { agentName: string }) => {
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisDays, setAnalysisDays] = useState(7);
  const [expandedProposal, setExpandedProposal] = useState<string | null>(null);
  const [reviewNote, setReviewNote] = useState("");

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
    await apiPost(`/api/v1/evolve/${agentName}/proposals/${proposalId}/approve`, { note: reviewNote });
    setReviewNote("");
    proposalsQuery.refetch();
    ledgerQuery.refetch();
  }

  async function rejectProposal(proposalId: string) {
    await apiPost(`/api/v1/evolve/${agentName}/proposals/${proposalId}/reject`, { note: reviewNote });
    setReviewNote("");
    proposalsQuery.refetch();
    ledgerQuery.refetch();
  }

  async function applyProposal(proposalId: string) {
    await apiPost(`/api/v1/evolve/${agentName}/proposals/${proposalId}/apply`);
    proposalsQuery.refetch();
    ledgerQuery.refetch();
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
                          value={reviewNote}
                          onChange={(e) => setReviewNote(e.target.value)}
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
                  <button
                    onClick={() => applyProposal(proposal.proposal_id)}
                    className="btn btn-primary text-xs"
                  >
                    Apply
                  </button>
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
