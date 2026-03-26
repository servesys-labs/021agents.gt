import { useMemo, useState } from "react";
import { CheckCircle2, Loader2, Plus, X, XCircle, Zap } from "lucide-react";

import { apiPost, useApiQuery } from "../../../lib/api";

type EvolveProposal = {
  id: string;
  title: string;
  rationale?: string;
  category?: "runtime" | "governance" | "eval" | "prompt" | "optimization";
  priority_score?: number;
  status?: "pending" | "approved" | "rejected";
  created_at?: string;
};

type LedgerEntry = {
  id: string;
  action: "approved" | "rejected";
  proposal_title: string;
  note?: string;
  timestamp?: string;
  who?: string;
};

type EvolveMetaReport = {
  success_rate?: number;
  avg_turns?: number;
  node_error_rate?: number;
  eval_pass_rate?: number;
};

type MaintenanceResult = {
  proposals_generated?: number;
  graph_checks?: string;
  rollout_recommendation?: string;
};

export function EvolveTab({ agentName }: { agentName?: string }) {
  const proposalsQuery = useApiQuery<{ proposals: EvolveProposal[] } | EvolveProposal[]>(
    `/api/v1/evolve/${agentName ?? ""}/proposals`,
    Boolean(agentName),
  );

  const ledgerQuery = useApiQuery<{ entries: LedgerEntry[] } | LedgerEntry[]>(
    `/api/v1/evolve/${agentName ?? ""}/ledger`,
    Boolean(agentName),
  );

  const metaReportQuery = useApiQuery<EvolveMetaReport>(
    `/api/v1/observability/agents/${agentName ?? ""}/meta-report`,
    Boolean(agentName),
  );

  const proposals: EvolveProposal[] = useMemo(() => {
    const raw = proposalsQuery.data;
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    if ("proposals" in raw) return raw.proposals ?? [];
    return [];
  }, [proposalsQuery.data]);

  const ledger: LedgerEntry[] = useMemo(() => {
    const raw = ledgerQuery.data;
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    if ("entries" in raw) return raw.entries ?? [];
    return [];
  }, [ledgerQuery.data]);

  const metaReport = metaReportQuery.data;

  const [generating, setGenerating] = useState(false);
  const [maintenanceRunning, setMaintenanceRunning] = useState(false);
  const [maintenanceResult, setMaintenanceResult] = useState<MaintenanceResult | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectNote, setRejectNote] = useState("");

  const handleGenerateProposals = async () => {
    if (!agentName) return;
    setGenerating(true);
    try {
      await apiPost(`/api/v1/observability/agents/${agentName}/meta-proposals/generate`);
      await proposalsQuery.refetch();
    } catch {
      // handle silently
    } finally {
      setGenerating(false);
    }
  };

  const handleApprove = async (id: string) => {
    if (!agentName) return;
    try {
      await apiPost(`/api/v1/evolve/${agentName}/proposals/${id}/approve`);
      await proposalsQuery.refetch();
      await ledgerQuery.refetch();
    } catch {
      // handle silently
    }
  };

  const handleReject = async (id: string) => {
    if (!agentName) return;
    try {
      await apiPost(`/api/v1/evolve/${agentName}/proposals/${id}/reject`, { note: rejectNote });
      setRejectingId(null);
      setRejectNote("");
      await proposalsQuery.refetch();
      await ledgerQuery.refetch();
    } catch {
      // handle silently
    }
  };

  const handleMaintenanceCycle = async () => {
    if (!agentName) return;
    setMaintenanceRunning(true);
    setMaintenanceResult(null);
    try {
      const result = await apiPost<MaintenanceResult>(
        `/api/v1/observability/agents/${agentName}/autonomous-maintenance-run`,
        { dry_run: false, persist_proposals: true },
      );
      setMaintenanceResult(result);
      await proposalsQuery.refetch();
    } catch {
      // handle silently
    } finally {
      setMaintenanceRunning(false);
    }
  };

  const categoryColors: Record<string, string> = {
    runtime: "bg-node-glow-orange text-accent border-accent/20",
    governance: "bg-node-glow-blue text-status-info border-status-info/20",
    eval: "bg-node-glow-green text-status-live border-status-live/20",
    prompt: "bg-node-glow-purple text-chart-purple border-chart-purple/20",
    optimization: "bg-node-glow-cyan text-chart-cyan border-chart-cyan/20",
  };

  return (
    <div className="space-y-[var(--space-6)]">
      <div>
        <div className="flex items-center justify-between mb-[var(--space-4)]">
          <h2 className="text-[var(--text-md)] font-semibold text-text-primary">Active Proposals</h2>
          <button
            onClick={handleGenerateProposals}
            disabled={generating}
            className="btn btn-secondary text-[var(--text-xs)] min-h-[var(--touch-target-min)]"
          >
            {generating ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
            {generating ? "Generating..." : "Generate Proposals"}
          </button>
        </div>

        {proposalsQuery.loading ? (
          <p className="text-[var(--text-sm)] text-text-muted">Loading proposals...</p>
        ) : proposals.length === 0 ? (
          <div className="card text-center py-[var(--space-8)]">
            <p className="text-[var(--text-sm)] text-text-muted">
              No active proposals. Run autonomous maintenance to generate improvement suggestions.
            </p>
          </div>
        ) : (
          <div className="space-y-[var(--space-3)]">
            {proposals.map((proposal) => (
              <div key={proposal.id} className="card card-hover">
                <div className="flex items-start gap-[var(--space-3)]">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-[var(--space-2)] mb-[var(--space-2)]">
                      <h3 className="text-[var(--text-sm)] font-semibold text-text-primary truncate">
                        {proposal.title}
                      </h3>
                      {proposal.category && (
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide border ${categoryColors[proposal.category] ?? "bg-surface-overlay text-text-muted border-border-subtle"}`}
                        >
                          {proposal.category}
                        </span>
                      )}
                      {proposal.status && (
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide border ${
                            proposal.status === "approved"
                              ? "bg-status-live/10 text-status-live border-status-live/20"
                              : proposal.status === "rejected"
                                ? "bg-status-error/10 text-status-error border-status-error/20"
                                : "bg-status-warning/10 text-status-warning border-status-warning/20"
                          }`}
                        >
                          {proposal.status}
                        </span>
                      )}
                    </div>
                    {proposal.rationale && (
                      <p className="text-[var(--text-xs)] text-text-secondary leading-relaxed mb-[var(--space-2)]">
                        {proposal.rationale}
                      </p>
                    )}
                    {proposal.priority_score != null && (
                      <div className="flex items-center gap-[var(--space-2)]">
                        <span className="text-[10px] text-text-muted uppercase tracking-wide">Priority</span>
                        <div className="w-24 h-1.5 rounded-full bg-surface-overlay overflow-hidden">
                          <div
                            className="h-full rounded-full bg-accent transition-all"
                            style={{ width: `${proposal.priority_score * 100}%` }}
                          />
                        </div>
                        <span className="text-[10px] font-mono text-text-muted">
                          {proposal.priority_score.toFixed(2)}
                        </span>
                      </div>
                    )}
                  </div>

                  {proposal.status === "pending" && (
                    <div className="flex items-center gap-[var(--space-2)] flex-shrink-0">
                      <button
                        onClick={() => handleApprove(proposal.id)}
                        className="btn btn-primary text-[var(--text-xs)] min-h-[var(--touch-target-min)] px-[var(--space-3)]"
                      >
                        <CheckCircle2 size={12} />
                        Approve
                      </button>
                      {rejectingId === proposal.id ? (
                        <div className="flex items-center gap-[var(--space-1)]">
                          <input
                            type="text"
                            value={rejectNote}
                            onChange={(e) => setRejectNote(e.target.value)}
                            placeholder="Rejection note..."
                            className="text-[var(--text-xs)] w-40"
                          />
                          <button
                            onClick={() => handleReject(proposal.id)}
                            className="btn btn-secondary text-[var(--text-xs)] min-h-[var(--touch-target-min)] px-[var(--space-2)] text-status-error border-status-error/20"
                          >
                            Confirm
                          </button>
                          <button
                            onClick={() => {
                              setRejectingId(null);
                              setRejectNote("");
                            }}
                            className="btn btn-ghost text-[var(--text-xs)] min-h-[var(--touch-target-min)] px-[var(--space-2)]"
                          >
                            <X size={12} />
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => setRejectingId(proposal.id)}
                          className="btn btn-secondary text-[var(--text-xs)] min-h-[var(--touch-target-min)] px-[var(--space-3)] text-status-error border-status-error/20"
                        >
                          <XCircle size={12} />
                          Reject
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div>
        <h2 className="text-[var(--text-md)] font-semibold text-text-primary mb-[var(--space-4)]">Version Ledger</h2>
        {ledgerQuery.loading ? (
          <p className="text-[var(--text-sm)] text-text-muted">Loading ledger...</p>
        ) : ledger.length === 0 ? (
          <p className="text-[var(--text-sm)] text-text-muted">No evolution history recorded</p>
        ) : (
          <div className="relative pl-[var(--space-6)]">
            <div className="absolute left-2 top-0 bottom-0 w-px bg-border-default" />
            {ledger.map((entry) => (
              <div key={entry.id} className="relative mb-[var(--space-3)] pl-[var(--space-2)]">
                <div
                  className={`absolute -left-[var(--space-6)] top-1.5 w-2.5 h-2.5 rounded-full border-2 border-surface-raised ${
                    entry.action === "approved" ? "bg-status-live" : "bg-status-error"
                  }`}
                />
                <div className="card py-[var(--space-2)] px-[var(--space-3)]">
                  <div className="flex items-center gap-[var(--space-2)] mb-[var(--space-1)]">
                    <span
                      className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide border ${
                        entry.action === "approved"
                          ? "bg-status-live/10 text-status-live border-status-live/20"
                          : "bg-status-error/10 text-status-error border-status-error/20"
                      }`}
                    >
                      {entry.action}
                    </span>
                    <span className="text-[var(--text-xs)] font-medium text-text-primary flex-1 truncate">
                      {entry.proposal_title}
                    </span>
                    {entry.timestamp && (
                      <span className="text-[10px] text-text-muted font-mono flex-shrink-0">
                        {new Date(entry.timestamp).toLocaleDateString(undefined, {
                          month: "short",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                    )}
                  </div>
                  {entry.note && <p className="text-[var(--text-xs)] text-text-secondary">{entry.note}</p>}
                  {entry.who && <p className="text-[10px] text-text-muted mt-[var(--space-1)]">by {entry.who}</p>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div>
        <h2 className="text-[var(--text-md)] font-semibold text-text-primary mb-[var(--space-4)]">
          Meta-Agent Insights
        </h2>

        {metaReportQuery.loading ? (
          <p className="text-[var(--text-sm)] text-text-muted">Loading insights...</p>
        ) : (
          <>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-[var(--space-3)] mb-[var(--space-4)]">
              <div className="card py-[var(--space-3)]">
                <p className="text-[10px] text-text-muted uppercase tracking-wide mb-[var(--space-1)]">Success Rate</p>
                <p className="text-[var(--text-lg)] font-bold font-mono text-text-primary">
                  {metaReport?.success_rate != null ? `${(metaReport.success_rate * 100).toFixed(1)}%` : "--"}
                </p>
              </div>
              <div className="card py-[var(--space-3)]">
                <p className="text-[10px] text-text-muted uppercase tracking-wide mb-[var(--space-1)]">Avg Turns</p>
                <p className="text-[var(--text-lg)] font-bold font-mono text-text-primary">
                  {metaReport?.avg_turns?.toFixed(1) ?? "--"}
                </p>
              </div>
              <div className="card py-[var(--space-3)]">
                <p className="text-[10px] text-text-muted uppercase tracking-wide mb-[var(--space-1)]">
                  Node Error Rate
                </p>
                <p className="text-[var(--text-lg)] font-bold font-mono text-text-primary">
                  {metaReport?.node_error_rate != null ? `${(metaReport.node_error_rate * 100).toFixed(1)}%` : "--"}
                </p>
              </div>
              <div className="card py-[var(--space-3)]">
                <p className="text-[10px] text-text-muted uppercase tracking-wide mb-[var(--space-1)]">Eval Pass Rate</p>
                <p className="text-[var(--text-lg)] font-bold font-mono text-text-primary">
                  {metaReport?.eval_pass_rate != null ? `${(metaReport.eval_pass_rate * 100).toFixed(1)}%` : "--"}
                </p>
              </div>
            </div>

            <button
              onClick={handleMaintenanceCycle}
              disabled={maintenanceRunning}
              className="btn btn-primary text-[var(--text-xs)] min-h-[var(--touch-target-min)]"
            >
              {maintenanceRunning ? <Loader2 size={14} className="animate-spin" /> : <Zap size={14} />}
              {maintenanceRunning ? "Running Maintenance..." : "Run Maintenance Cycle"}
            </button>

            {maintenanceResult && (
              <div className="card mt-[var(--space-3)]">
                <h3 className="text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-2)]">
                  Maintenance Result
                </h3>
                <div className="space-y-[var(--space-1)]">
                  {maintenanceResult.proposals_generated != null && (
                    <p className="text-[var(--text-xs)] text-text-secondary">
                      <span className="text-text-muted">Proposals Generated:</span>{" "}
                      {maintenanceResult.proposals_generated}
                    </p>
                  )}
                  {maintenanceResult.graph_checks && (
                    <p className="text-[var(--text-xs)] text-text-secondary">
                      <span className="text-text-muted">Graph Checks:</span> {maintenanceResult.graph_checks}
                    </p>
                  )}
                  {maintenanceResult.rollout_recommendation && (
                    <p className="text-[var(--text-xs)] text-text-secondary">
                      <span className="text-text-muted">Recommendation:</span>{" "}
                      {maintenanceResult.rollout_recommendation}
                    </p>
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
