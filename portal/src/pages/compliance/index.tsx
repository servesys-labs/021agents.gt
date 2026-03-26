import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  BookOpen,
  CheckCircle,
  ChevronDown,
  ChevronRight,
  Clock,
  Download,
  FileText,
  Loader2,
  Plus,
  RefreshCw,
  Scan,
  Shield,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  ThumbsDown,
  ThumbsUp,
  Trash2,
} from "lucide-react";

import { Link } from "react-router-dom";
import { PageHeader } from "../../components/common/PageHeader";
import { QueryState } from "../../components/common/QueryState";
import { EmptyState } from "../../components/common/EmptyState";
import { DriftSlideOver } from "../../components/compliance/DriftSlideOver";
import { AssistPanel } from "../../components/common/AssistPanel";
import { useApiQuery, apiGet, apiPost, apiDelete, apiRequest } from "../../lib/api";
import { extractList } from "../../lib/normalize";
import { useToast } from "../../components/common/ToastProvider";
import { Modal } from "../../components/common/Modal";

/* ── Types ──────────────────────────────────────────────────────── */

type ComplianceSummary = {
  total_checks?: number;
  compliant?: number;
  drifted?: number;
  critical?: number;
  compliance_rate?: number;
};

type ComplianceCheck = {
  id: number;
  agent_name: string;
  image_id: string;
  image_name: string;
  status: string;
  drift_count: number;
  drift_fields?: string[];
  created_at?: number;
};

type SloStatus = {
  agent_name: string;
  metric_name: string;
  threshold: number;
  operator: string;
  current_value: number;
  status: string;
};

type SecurityScan = {
  scan_id: string;
  agent_name: string;
  scan_type?: string;
  risk_score: number;
  risk_level: string;
  passed: number;
  failed: number;
  total_probes?: number;
  created_at?: number | string;
};

type Agent = {
  name: string;
  status?: string;
};

type Proposal = {
  id: string;
  title: string;
  category?: string;
  priority_score?: number;
  status?: string;
  description?: string;
};

/* ── Helpers ─────────────────────────────────────────────────────── */

function complianceStatusStyle(status: string) {
  const s = status?.toLowerCase() ?? "";
  if (s === "critical") {
    return { icon: ShieldX, color: "text-status-error", label: "CRITICAL" };
  }
  if (s === "drifted" || s === "warning") {
    return { icon: ShieldAlert, color: "text-status-warning", label: "WARNING" };
  }
  return { icon: ShieldCheck, color: "text-status-live", label: "Compliant" };
}

function riskLevelColor(level: string) {
  switch (level?.toLowerCase()) {
    case "critical":
      return "text-status-error";
    case "high":
      return "text-chart-orange";
    case "medium":
      return "text-status-warning";
    case "low":
      return "text-status-live";
    default:
      return "text-text-muted";
  }
}

function riskLevelBg(level: string) {
  switch (level?.toLowerCase()) {
    case "critical":
      return "bg-status-error/15 text-status-error border-status-error/20";
    case "high":
      return "bg-chart-orange/15 text-chart-orange border-chart-orange/20";
    case "medium":
      return "bg-status-warning/15 text-status-warning border-status-warning/20";
    case "low":
      return "bg-status-live/15 text-status-live border-status-live/20";
    default:
      return "bg-surface-overlay text-text-muted border-border-default";
  }
}

function formatDate(ts?: number | string): string {
  if (!ts) return "--";
  const d = new Date(typeof ts === "number" && ts < 1e12 ? ts * 1000 : ts);
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/* ── Tab definitions ────────────────────────────────────────────── */

const COMPLIANCE_TABS = [
  { id: "overview", label: "Overview", icon: ShieldCheck },
  { id: "audit", label: "Audit Log", icon: FileText },
  { id: "retention", label: "Retention", icon: Clock },
  { id: "policies", label: "Policies", icon: BookOpen },
] as const;

type ComplianceTabId = (typeof COMPLIANCE_TABS)[number]["id"];

/* ── Compliance & Governance Page ────────────────────────────────── */

export function CompliancePage() {
  const [activeTab, setActiveTab] = useState<ComplianceTabId>("overview");

  return (
    <div className="max-w-[1400px] mx-auto">
      <PageHeader
        title="Compliance & Governance"
        subtitle="Gold image drift, SLO monitoring, audit logs, retention, and policies"
        actions={
          <Link
            to="/audit"
            className="text-[var(--text-xs)] text-accent hover:text-accent/80 transition-colors flex items-center gap-[var(--space-1)] min-h-[var(--touch-target-min)]"
          >
            View Full Audit Log <ChevronRight size={14} />
          </Link>
        }
      />

      {/* Meta-agent assist */}
      <div className="mb-[var(--space-4)]">
        <AssistPanel compact />
      </div>

      {/* Tab bar */}
      <div className="flex items-center gap-0 border-b border-border-default mb-[var(--space-6)]">
        {COMPLIANCE_TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-[var(--space-2)] px-[var(--space-4)] py-[var(--space-3)] text-[var(--text-xs)] font-medium transition-colors border-b-2 -mb-px min-h-[var(--touch-target-min)] ${
              activeTab === tab.id
                ? "text-accent border-accent"
                : "text-text-muted border-transparent hover:text-text-secondary hover:border-border-strong"
            }`}
          >
            <tab.icon size={14} />
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === "overview" && <OverviewComplianceTab />}
      {activeTab === "audit" && <AuditLogTab />}
      {activeTab === "retention" && <RetentionTab />}
      {activeTab === "policies" && <PoliciesTab />}
    </div>
  );
}

/* ── Overview Tab (existing content) ─────────────────────────────── */

function OverviewComplianceTab() {
  const { showToast } = useToast();

  /* Drift slide-over state */
  const [driftOpen, setDriftOpen] = useState(false);
  const [driftAgent, setDriftAgent] = useState("");
  const [driftImageId, setDriftImageId] = useState("");
  const [driftImageName, setDriftImageName] = useState("");

  /* Proposal handling */
  const [rejectNote, setRejectNote] = useState("");
  const [rejectingId, setRejectingId] = useState<string | null>(null);

  /* Queries */
  const compSummaryQuery = useApiQuery<ComplianceSummary>(
    "/api/v1/gold-images/compliance/summary",
  );
  const checksQuery = useApiQuery<{ checks: ComplianceCheck[] } | ComplianceCheck[]>(
    "/api/v1/gold-images/compliance/checks?limit=50",
  );
  const sloQuery = useApiQuery<{ slos: SloStatus[] } | SloStatus[]>(
    "/api/v1/slos/status",
  );
  const scansQuery = useApiQuery<{ scans: SecurityScan[] } | SecurityScan[]>(
    "/api/v1/security/scans?limit=20",
  );
  const agentsQuery = useApiQuery<{ agents: Agent[] } | Agent[]>("/api/v1/agents");

  const compSummary = compSummaryQuery.data;
  const checks: ComplianceCheck[] = useMemo(() => {
    const raw = checksQuery.data;
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    return raw.checks ?? [];
  }, [checksQuery.data]);

  const slos: SloStatus[] = useMemo(() => {
    const raw = sloQuery.data;
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    return raw.slos ?? [];
  }, [sloQuery.data]);

  const scans: SecurityScan[] = useMemo(() => {
    const raw = scansQuery.data;
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    return raw.scans ?? [];
  }, [scansQuery.data]);

  const agents: Agent[] = useMemo(() => extractList<Agent>(agentsQuery.data, "agents"), [agentsQuery.data]);

  /* Fetch proposals for each agent */
  const [proposals, setProposals] = useState<
    Array<{ agentName: string; proposals: Proposal[] }>
  >([]);
  const [proposalsLoading, setProposalsLoading] = useState(false);

  useEffect(() => {
    if (agents.length === 0) return;
    setProposalsLoading(true);
    const fetches = agents.map(async (agent) => {
      try {
        const result = await apiGet<{ proposals: Proposal[] } | Proposal[]>(
          `/api/v1/observability/agents/${encodeURIComponent(agent.name)}/meta-proposals?status=pending`,
        );
        const list = Array.isArray(result) ? result : result?.proposals ?? [];
        return { agentName: agent.name, proposals: list };
      } catch {
        return { agentName: agent.name, proposals: [] };
      }
    });
    Promise.all(fetches)
      .then((results) =>
        setProposals(results.filter((r) => r.proposals.length > 0)),
      )
      .finally(() => setProposalsLoading(false));
  }, [agents]);

  const handleApproveProposal = useCallback(
    async (agentName: string, proposalId: string) => {
      try {
        await apiPost(
          `/api/v1/observability/agents/${encodeURIComponent(agentName)}/meta-proposals/${encodeURIComponent(proposalId)}/review`,
          { approved: true },
        );
        showToast("Proposal approved", "success");
        /* Remove from local state */
        setProposals((prev) =>
          prev
            .map((g) =>
              g.agentName === agentName
                ? {
                    ...g,
                    proposals: g.proposals.filter((p) => p.id !== proposalId),
                  }
                : g,
            )
            .filter((g) => g.proposals.length > 0),
        );
      } catch {
        showToast("Failed to approve proposal", "error");
      }
    },
    [showToast],
  );

  const handleRejectProposal = useCallback(
    async (agentName: string, proposalId: string, note: string) => {
      try {
        await apiPost(
          `/api/v1/observability/agents/${encodeURIComponent(agentName)}/meta-proposals/${encodeURIComponent(proposalId)}/review`,
          { approved: false, note },
        );
        showToast("Proposal rejected", "success");
        setProposals((prev) =>
          prev
            .map((g) =>
              g.agentName === agentName
                ? {
                    ...g,
                    proposals: g.proposals.filter((p) => p.id !== proposalId),
                  }
                : g,
            )
            .filter((g) => g.proposals.length > 0),
        );
        setRejectingId(null);
        setRejectNote("");
      } catch {
        showToast("Failed to reject proposal", "error");
      }
    },
    [showToast],
  );

  const handleRunScanAll = useCallback(async () => {
    try {
      for (const agent of agents) {
        await apiRequest(
          `/api/v1/security/scan/${encodeURIComponent(agent.name)}`,
          "POST",
        );
      }
      showToast("Security scans triggered for all agents", "success");
      scansQuery.refetch();
    } catch {
      showToast("Failed to trigger scans", "error");
    }
  }, [agents, showToast, scansQuery]);

  const handleOpenDrift = (
    agentName: string,
    imageId: string,
    imageName: string,
  ) => {
    setDriftAgent(agentName);
    setDriftImageId(imageId);
    setDriftImageName(imageName);
    setDriftOpen(true);
  };

  /* Computed metrics */
  const compliantCount = compSummary?.compliant ?? 0;
  const criticalDriftCount = compSummary?.critical ?? 0;
  const sloBreaches = slos.filter(
    (s) => s.status === "breach" || s.status === "failing",
  ).length;

  return (
    <div>
      {/* ── Section 1: Compliance Status ─────────────────────────── */}
      <section className="mb-[var(--space-8)]">
        <h2 className="text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-3)]">
          Compliance Status
        </h2>

        {/* Signal cards */}
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-[var(--space-3)] mb-[var(--space-4)]">
          <div className="card flex items-center gap-[var(--space-3)] py-[var(--space-3)]">
            <div className="p-2 rounded-lg bg-status-live/10">
              <ShieldCheck size={16} className="text-status-live" />
            </div>
            <div>
              <p className="text-[var(--text-xl)] font-bold text-text-primary font-mono">
                {compliantCount}
              </p>
              <p className="text-[10px] text-text-muted uppercase tracking-wide">
                Compliant
              </p>
            </div>
          </div>
          <div className="card flex items-center gap-[var(--space-3)] py-[var(--space-3)]">
            <div className="p-2 rounded-lg bg-status-error/10">
              <ShieldX size={16} className="text-status-error" />
            </div>
            <div>
              <p className="text-[var(--text-xl)] font-bold text-status-error font-mono">
                {criticalDriftCount}
              </p>
              <p className="text-[10px] text-text-muted uppercase tracking-wide">
                Critical Drift
              </p>
            </div>
          </div>
          <div className="card flex items-center gap-[var(--space-3)] py-[var(--space-3)]">
            <div className="p-2 rounded-lg bg-status-warning/10">
              <AlertTriangle size={16} className="text-status-warning" />
            </div>
            <div>
              <p className="text-[var(--text-xl)] font-bold text-text-primary font-mono">
                {sloBreaches}
              </p>
              <p className="text-[10px] text-text-muted uppercase tracking-wide">
                SLO Breaches
              </p>
            </div>
          </div>
        </div>

        {/* Per-agent compliance cards */}
        <QueryState loading={checksQuery.loading} error={checksQuery.error}>
          {checks.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-[var(--space-3)]">
              {checks.map((check) => {
                const style = complianceStatusStyle(check.status);
                const Icon = style.icon;
                return (
                  <div
                    key={check.id}
                    className="card flex flex-col gap-[var(--space-2)]"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-[var(--text-sm)] font-medium text-text-primary">
                        {check.agent_name}
                      </span>
                      <span
                        className={`inline-flex items-center gap-1 text-[var(--text-xs)] font-semibold ${style.color}`}
                      >
                        <Icon size={14} />
                        {style.label}
                      </span>
                    </div>
                    {check.drift_count > 0 && (
                      <p className="text-[10px] text-text-muted">
                        {check.drift_count} drifted field
                        {check.drift_count !== 1 ? "s" : ""}
                      </p>
                    )}
                    <div className="flex items-center gap-[var(--space-2)] mt-[var(--space-1)]">
                      {check.drift_count > 0 && (
                        <button
                          onClick={() =>
                            handleOpenDrift(
                              check.agent_name,
                              check.image_id,
                              check.image_name,
                            )
                          }
                          className="btn btn-secondary text-[var(--text-xs)] min-h-[var(--touch-target-min)]"
                        >
                          View Drift
                        </button>
                      )}
                      {check.status === "critical" && (
                        <button
                          onClick={() =>
                            apiRequest(
                              `/api/v1/security/scan/${encodeURIComponent(check.agent_name)}`,
                              "POST",
                            )
                              .then(() =>
                                showToast("Security scan triggered", "success"),
                              )
                              .catch(() =>
                                showToast("Failed to trigger scan", "error"),
                              )
                          }
                          className="btn btn-ghost text-[var(--text-xs)] text-status-error min-h-[var(--touch-target-min)]"
                        >
                          <Scan size={14} />
                          Run Security Scan
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <EmptyState title="No compliance checks" description="Compliance checks will appear here once recorded." />
          )}
        </QueryState>
      </section>

      {/* ── Section 2: SLO Status ────────────────────────────────── */}
      <section className="mb-[var(--space-8)]">
        <h2 className="text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-3)]">
          SLO Status
        </h2>

        <QueryState loading={sloQuery.loading} error={sloQuery.error}>
          {slos.length > 0 ? (
            <div className="card">
              <div className="overflow-x-auto">
                <table>
                  <thead>
                    <tr>
                      <th>Agent</th>
                      <th>Metric</th>
                      <th className="text-right">Threshold</th>
                      <th className="text-center">Operator</th>
                      <th className="text-right">Current</th>
                      <th className="text-center">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {slos.map((slo, i) => {
                      const isBreach =
                        slo.status === "breach" || slo.status === "failing";
                      return (
                        <tr key={`${slo.agent_name}-${slo.metric_name}-${i}`}>
                          <td className="text-text-primary font-medium">
                            {slo.agent_name}
                          </td>
                          <td className="text-text-secondary">
                            {slo.metric_name}
                          </td>
                          <td className="text-right font-mono text-text-secondary">
                            {slo.threshold}
                          </td>
                          <td className="text-center text-text-muted">
                            {slo.operator === ">=" || slo.operator === "gte"
                              ? "\u2265"
                              : slo.operator === "<=" || slo.operator === "lte"
                                ? "\u2264"
                                : slo.operator}
                          </td>
                          <td
                            className={`text-right font-mono font-semibold ${
                              isBreach ? "text-status-error" : "text-text-primary"
                            }`}
                          >
                            {typeof slo.current_value === "number"
                              ? slo.current_value.toFixed(2)
                              : slo.current_value}
                          </td>
                          <td className="text-center">
                            {isBreach ? (
                              <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-status-error">
                                <AlertTriangle size={12} />
                                breach
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-status-live">
                                <CheckCircle size={12} />
                                passing
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <EmptyState title="No SLOs configured" description="Service Level Objectives will appear here once configured." />
          )}
        </QueryState>
      </section>

      {/* ── Section 3: Recent Security Scans ─────────────────────── */}
      <section className="mb-[var(--space-8)]">
        <h2 className="text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-3)]">
          Recent Security Scans
        </h2>

        <QueryState loading={scansQuery.loading} error={scansQuery.error}>
          {scans.length > 0 ? (
            <div className="card">
              <div className="overflow-x-auto">
                <table>
                  <thead>
                    <tr>
                      <th>Agent</th>
                      <th>Date</th>
                      <th className="text-right">Risk Score</th>
                      <th className="text-center">Risk Level</th>
                      <th className="text-right">Passed</th>
                      <th className="text-right">Failed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {scans.map((scan) => (
                      <tr key={scan.scan_id}>
                        <td className="text-text-primary font-medium">
                          {scan.agent_name}
                        </td>
                        <td className="text-text-muted">
                          {formatDate(scan.created_at)}
                        </td>
                        <td className="text-right font-mono text-text-primary">
                          {scan.risk_score.toFixed(1)}
                        </td>
                        <td className="text-center">
                          <span
                            className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase border ${riskLevelBg(scan.risk_level)}`}
                          >
                            {scan.risk_level}
                          </span>
                        </td>
                        <td className="text-right text-status-live font-mono">
                          {scan.passed}
                        </td>
                        <td className="text-right text-status-error font-mono">
                          {scan.failed}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="mt-[var(--space-4)] flex justify-end">
                <button
                  onClick={handleRunScanAll}
                  className="btn btn-secondary text-[var(--text-xs)] min-h-[var(--touch-target-min)]"
                >
                  <Scan size={14} />
                  Run Scan for All Agents
                </button>
              </div>
            </div>
          ) : (
            <EmptyState title="No security scans" description="Security scans will appear here once recorded." />
          )}
        </QueryState>
      </section>

      {/* ── Section 4: Pending Proposals ─────────────────────────── */}
      <section className="mb-[var(--space-8)]">
        <h2 className="text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-3)]">
          Pending Proposals
        </h2>

        {proposalsLoading ? (
          <div className="card">
            <div className="flex items-center justify-center py-[var(--space-6)] text-text-muted text-[var(--text-sm)]">
              Loading proposals...
            </div>
          </div>
        ) : proposals.length > 0 ? (
          <div className="space-y-[var(--space-4)]">
            {proposals.map((group) => (
              <div key={group.agentName}>
                <h3 className="text-[var(--text-sm)] font-semibold text-text-primary mb-[var(--space-2)]">
                  {group.agentName}
                </h3>
                <div className="space-y-[var(--space-2)]">
                  {group.proposals.map((proposal) => (
                    <div
                      key={proposal.id}
                      className="card flex flex-col gap-[var(--space-2)]"
                    >
                      <div className="flex items-start justify-between">
                        <div className="flex-1 min-w-0">
                          <p className="text-[var(--text-sm)] text-text-primary font-medium">
                            {proposal.title}
                          </p>
                          <div className="flex items-center gap-[var(--space-2)] mt-[var(--space-1)]">
                            {proposal.category && (
                              <span className="px-1.5 py-0.5 rounded text-[10px] bg-surface-overlay text-text-secondary border border-border-default">
                                {proposal.category}
                              </span>
                            )}
                            {proposal.priority_score != null && (
                              <span className="text-[10px] text-text-muted">
                                Priority: {proposal.priority_score}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>

                      {/* Reject note input */}
                      {rejectingId === proposal.id && (
                        <div className="flex items-center gap-[var(--space-2)]">
                          <input
                            type="text"
                            placeholder="Rejection note..."
                            value={rejectNote}
                            onChange={(e) => setRejectNote(e.target.value)}
                            className="flex-1 px-[var(--space-2)] py-[var(--space-1)] text-[var(--text-xs)]"
                          />
                          <button
                            onClick={() =>
                              handleRejectProposal(
                                group.agentName,
                                proposal.id,
                                rejectNote,
                              )
                            }
                            className="btn btn-secondary text-[var(--text-xs)] text-status-error min-h-[var(--touch-target-min)]"
                          >
                            Confirm Reject
                          </button>
                          <button
                            onClick={() => {
                              setRejectingId(null);
                              setRejectNote("");
                            }}
                            className="btn btn-ghost text-[var(--text-xs)] min-h-[var(--touch-target-min)]"
                          >
                            Cancel
                          </button>
                        </div>
                      )}

                      {/* Action buttons */}
                      {rejectingId !== proposal.id && (
                        <div className="flex items-center gap-[var(--space-2)]">
                          <button
                            onClick={() =>
                              handleApproveProposal(
                                group.agentName,
                                proposal.id,
                              )
                            }
                            className="btn btn-primary text-[var(--text-xs)] min-h-[var(--touch-target-min)]"
                          >
                            <ThumbsUp size={12} />
                            Approve
                          </button>
                          <button
                            onClick={() => setRejectingId(proposal.id)}
                            className="btn btn-secondary text-[var(--text-xs)] min-h-[var(--touch-target-min)]"
                          >
                            <ThumbsDown size={12} />
                            Reject
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState title="No pending proposals" description="Governance proposals will appear here when created." />
        )}
      </section>

      {/* Drift Slide-Over */}
      <DriftSlideOver
        open={driftOpen}
        onClose={() => setDriftOpen(false)}
        agentName={driftAgent}
        imageId={driftImageId}
        imageName={driftImageName}
      />
    </div>
  );
}

/* ── Audit Log Tab ───────────────────────────────────────────────── */

type AuditEntry = {
  id?: string;
  timestamp?: string;
  user?: string;
  action?: string;
  resource?: string;
  details?: Record<string, unknown> | string;
};

function AuditLogTab() {
  const { showToast } = useToast();
  const [sinceDays, setSinceDays] = useState(30);
  const [actionFilter, setActionFilter] = useState("");
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const auditQuery = useApiQuery<{ entries: AuditEntry[] } | AuditEntry[]>(
    `/api/v1/audit/log?limit=50&since_days=${sinceDays}`,
  );

  const entries: AuditEntry[] = useMemo(() => {
    const raw = auditQuery.data;
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    return raw.entries ?? [];
  }, [auditQuery.data]);

  const filteredEntries = useMemo(() => {
    if (!actionFilter) return entries;
    return entries.filter(
      (e) => (e.action ?? "").toLowerCase() === actionFilter.toLowerCase(),
    );
  }, [entries, actionFilter]);

  const actionTypes = useMemo(() => {
    const set = new Set<string>();
    entries.forEach((e) => {
      if (e.action) set.add(e.action);
    });
    return Array.from(set).sort();
  }, [entries]);

  const handleExport = useCallback(async () => {
    setExporting(true);
    try {
      const data = await apiGet<unknown>("/api/v1/audit/export");
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `audit-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      showToast("Audit log exported with hash chain", "success");
    } catch {
      showToast("Failed to export audit log", "error");
    } finally {
      setExporting(false);
    }
  }, [showToast]);

  return (
    <div>
      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-[var(--space-3)] mb-[var(--space-4)]">
        <div className="flex items-center gap-[var(--space-2)]">
          <label className="text-[var(--text-xs)] text-text-muted">
            Since:
          </label>
          <select
            value={sinceDays}
            onChange={(e) => setSinceDays(Number(e.target.value))}
            className="w-auto min-w-[120px]"
          >
            <option value={7}>Last 7 days</option>
            <option value={14}>Last 14 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </select>
        </div>
        <div className="flex items-center gap-[var(--space-2)]">
          <label className="text-[var(--text-xs)] text-text-muted">
            Action:
          </label>
          <select
            value={actionFilter}
            onChange={(e) => setActionFilter(e.target.value)}
            className="w-auto min-w-[160px]"
          >
            <option value="">All actions</option>
            {actionTypes.map((at) => (
              <option key={at} value={at}>
                {at}
              </option>
            ))}
          </select>
        </div>
        <div className="flex-1" />
        <button
          onClick={handleExport}
          disabled={exporting}
          className="btn btn-secondary text-[var(--text-xs)] min-h-[var(--touch-target-min)]"
        >
          {exporting ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <Download size={14} />
          )}
          Export with Hash Chain
        </button>
      </div>

      {/* Audit table */}
      <QueryState
        loading={auditQuery.loading}
        error={auditQuery.error}
        onRetry={auditQuery.refetch}
      >
        {filteredEntries.length > 0 ? (
          <div className="card">
            <div className="overflow-x-auto">
              <table>
                <thead>
                  <tr>
                    <th style={{ width: 28 }}></th>
                    <th>Timestamp</th>
                    <th>User</th>
                    <th>Action</th>
                    <th>Resource</th>
                    <th>Details</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredEntries.map((entry, i) => {
                    const rowId = entry.id ?? `${i}`;
                    const isExpanded = expandedRow === rowId;
                    const detailStr =
                      typeof entry.details === "string"
                        ? entry.details
                        : entry.details
                          ? JSON.stringify(entry.details)
                          : "--";
                    return (
                      <>
                        <tr
                          key={rowId}
                          className="cursor-pointer"
                          onClick={() =>
                            setExpandedRow(isExpanded ? null : rowId)
                          }
                        >
                          <td>
                            {isExpanded ? (
                              <ChevronDown size={12} className="text-text-muted" />
                            ) : (
                              <ChevronRight size={12} className="text-text-muted" />
                            )}
                          </td>
                          <td className="text-[var(--text-xs)] font-mono text-text-muted whitespace-nowrap">
                            {entry.timestamp
                              ? new Date(entry.timestamp).toLocaleString()
                              : "--"}
                          </td>
                          <td className="text-text-primary text-[var(--text-sm)]">
                            {entry.user ?? "--"}
                          </td>
                          <td>
                            <span className="inline-block px-2 py-0.5 rounded text-[10px] font-semibold uppercase bg-surface-overlay text-text-secondary border border-border-default">
                              {entry.action ?? "--"}
                            </span>
                          </td>
                          <td className="text-text-secondary text-[var(--text-sm)]">
                            {entry.resource ?? "--"}
                          </td>
                          <td className="text-text-muted text-[var(--text-xs)] max-w-[200px] truncate">
                            {detailStr.slice(0, 60)}
                            {detailStr.length > 60 ? "..." : ""}
                          </td>
                        </tr>
                        {isExpanded && (
                          <tr key={`${rowId}-detail`}>
                            <td colSpan={6} className="bg-surface-base">
                              <pre className="text-[var(--text-xs)] text-text-secondary font-mono p-[var(--space-3)] overflow-x-auto whitespace-pre-wrap">
                                {typeof entry.details === "string"
                                  ? entry.details
                                  : JSON.stringify(entry.details, null, 2)}
                              </pre>
                            </td>
                          </tr>
                        )}
                      </>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <EmptyState
            icon={<FileText size={28} />}
            title="No audit entries"
            description="No audit log entries found for the selected time range."
          />
        )}
      </QueryState>
    </div>
  );
}

/* ── Retention Tab ───────────────────────────────────────────────── */

type RetentionPolicy = {
  id?: string;
  resource_type?: string;
  retention_days?: number;
  redact_pii?: boolean;
  archive?: boolean;
};

type RetentionApplyResult = {
  deleted?: number;
  archived?: number;
};

function RetentionTab() {
  const { showToast } = useToast();
  const [modalOpen, setModalOpen] = useState(false);
  const [formResourceType, setFormResourceType] = useState("sessions");
  const [formRetentionDays, setFormRetentionDays] = useState(90);
  const [formRedactPii, setFormRedactPii] = useState(false);
  const [formArchive, setFormArchive] = useState(false);
  const [saving, setSaving] = useState(false);
  const [applying, setApplying] = useState(false);

  const policiesQuery = useApiQuery<
    { policies: RetentionPolicy[] } | RetentionPolicy[]
  >("/api/v1/retention");

  const policies: RetentionPolicy[] = useMemo(() => {
    const raw = policiesQuery.data;
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    return raw.policies ?? [];
  }, [policiesQuery.data]);

  const handleCreate = useCallback(async () => {
    setSaving(true);
    try {
      await apiPost("/api/v1/retention", {
        resource_type: formResourceType,
        retention_days: formRetentionDays,
        redact_pii: formRedactPii,
        archive: formArchive,
      });
      showToast("Retention policy created", "success");
      setModalOpen(false);
      policiesQuery.refetch();
    } catch {
      showToast("Failed to create retention policy", "error");
    } finally {
      setSaving(false);
    }
  }, [
    formResourceType,
    formRetentionDays,
    formRedactPii,
    formArchive,
    showToast,
    policiesQuery,
  ]);

  const handleDelete = useCallback(
    async (id: string) => {
      try {
        await apiDelete(`/api/v1/retention/${encodeURIComponent(id)}`);
        showToast("Retention policy deleted", "success");
        policiesQuery.refetch();
      } catch {
        showToast("Failed to delete retention policy", "error");
      }
    },
    [showToast, policiesQuery],
  );

  const handleApply = useCallback(async () => {
    setApplying(true);
    try {
      const result = await apiPost<RetentionApplyResult>(
        "/api/v1/retention/apply",
      );
      showToast(
        `Retention applied: ${result?.deleted ?? 0} deleted, ${result?.archived ?? 0} archived`,
        "success",
      );
    } catch {
      showToast("Failed to apply retention policies", "error");
    } finally {
      setApplying(false);
    }
  }, [showToast]);

  return (
    <div>
      <div className="flex items-center justify-between mb-[var(--space-4)]">
        <h2 className="text-[var(--text-xs)] text-text-muted uppercase tracking-wide">
          Retention Policies
        </h2>
        <div className="flex items-center gap-[var(--space-2)]">
          <button
            onClick={handleApply}
            disabled={applying}
            className="btn btn-secondary text-[var(--text-xs)] min-h-[var(--touch-target-min)]"
          >
            {applying ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <RefreshCw size={14} />
            )}
            Apply Now
          </button>
          <button
            onClick={() => {
              setFormResourceType("sessions");
              setFormRetentionDays(90);
              setFormRedactPii(false);
              setFormArchive(false);
              setModalOpen(true);
            }}
            className="btn btn-primary text-[var(--text-xs)] min-h-[var(--touch-target-min)]"
          >
            <Plus size={14} />
            Create Policy
          </button>
        </div>
      </div>

      <QueryState
        loading={policiesQuery.loading}
        error={policiesQuery.error}
        onRetry={policiesQuery.refetch}
      >
        {policies.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-[var(--space-3)]">
            {policies.map((policy, i) => (
              <div
                key={policy.id ?? i}
                className="card flex flex-col gap-[var(--space-2)]"
              >
                <div className="flex items-center justify-between">
                  <span className="inline-block px-2 py-0.5 rounded text-[10px] font-semibold uppercase bg-chart-blue/15 text-chart-blue border border-chart-blue/20">
                    {policy.resource_type ?? "unknown"}
                  </span>
                  <button
                    onClick={() => policy.id && handleDelete(policy.id)}
                    className="btn btn-ghost text-status-error p-[var(--space-1)] min-h-[var(--touch-target-min)] min-w-[var(--touch-target-min)]"
                    aria-label="Delete policy"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
                <div className="grid grid-cols-3 gap-[var(--space-2)]">
                  <div>
                    <p className="text-[var(--text-lg)] font-bold text-text-primary font-mono">
                      {policy.retention_days ?? "--"}
                    </p>
                    <p className="text-[10px] text-text-muted uppercase tracking-wide">
                      Days
                    </p>
                  </div>
                  <div>
                    <p
                      className={`text-[var(--text-sm)] font-semibold ${policy.redact_pii ? "text-status-live" : "text-text-muted"}`}
                    >
                      {policy.redact_pii ? "Yes" : "No"}
                    </p>
                    <p className="text-[10px] text-text-muted uppercase tracking-wide">
                      PII Redaction
                    </p>
                  </div>
                  <div>
                    <p
                      className={`text-[var(--text-sm)] font-semibold ${policy.archive ? "text-status-live" : "text-text-muted"}`}
                    >
                      {policy.archive ? "Yes" : "No"}
                    </p>
                    <p className="text-[10px] text-text-muted uppercase tracking-wide">
                      Archive
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState
            icon={<Clock size={28} />}
            title="No retention policies"
            description="Create retention policies to manage data lifecycle."
            action={
              <button
                onClick={() => setModalOpen(true)}
                className="btn btn-primary text-[var(--text-xs)] min-h-[var(--touch-target-min)]"
              >
                <Plus size={14} />
                Create Policy
              </button>
            }
          />
        )}
      </QueryState>

      {/* Create modal */}
      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title="Create Retention Policy"
        maxWidth="md"
        footer={
          <>
            <button
              onClick={() => setModalOpen(false)}
              className="btn btn-secondary text-[var(--text-xs)] min-h-[var(--touch-target-min)]"
            >
              Cancel
            </button>
            <button
              onClick={handleCreate}
              disabled={saving}
              className="btn btn-primary text-[var(--text-xs)] min-h-[var(--touch-target-min)]"
            >
              {saving ? (
                <>
                  <Loader2 size={12} className="animate-spin" />
                  Saving...
                </>
              ) : (
                "Create"
              )}
            </button>
          </>
        }
      >
            <div className="space-y-[var(--space-4)]">
              <div>
                <label className="block text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-1)]">
                  Resource Type
                </label>
                <select
                  value={formResourceType}
                  onChange={(e) => setFormResourceType(e.target.value)}
                >
                  <option value="sessions">Sessions</option>
                  <option value="turns">Turns</option>
                  <option value="episodes">Episodes</option>
                  <option value="billing">Billing</option>
                </select>
              </div>
              <div>
                <label className="block text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-1)]">
                  Retention Days
                </label>
                <input
                  type="number"
                  value={formRetentionDays}
                  onChange={(e) =>
                    setFormRetentionDays(Number(e.target.value))
                  }
                  min={1}
                />
              </div>
              <div className="flex items-center justify-between min-h-[var(--touch-target-min)]">
                <label className="text-[var(--text-sm)] text-text-primary">
                  PII Redaction
                </label>
                <button
                  onClick={() => setFormRedactPii(!formRedactPii)}
                  className={`relative w-10 h-[22px] rounded-full transition-colors ${
                    formRedactPii ? "bg-accent" : "bg-surface-hover"
                  }`}
                  aria-label="Toggle PII redaction"
                >
                  <span
                    className={`absolute top-[3px] w-4 h-4 rounded-full bg-text-primary transition-transform ${
                      formRedactPii
                        ? "translate-x-[22px]"
                        : "translate-x-[3px]"
                    }`}
                  />
                </button>
              </div>
              <div className="flex items-center justify-between min-h-[var(--touch-target-min)]">
                <label className="text-[var(--text-sm)] text-text-primary">
                  Archive Before Delete
                </label>
                <button
                  onClick={() => setFormArchive(!formArchive)}
                  className={`relative w-10 h-[22px] rounded-full transition-colors ${
                    formArchive ? "bg-accent" : "bg-surface-hover"
                  }`}
                  aria-label="Toggle archive"
                >
                  <span
                    className={`absolute top-[3px] w-4 h-4 rounded-full bg-text-primary transition-transform ${
                      formArchive
                        ? "translate-x-[22px]"
                        : "translate-x-[3px]"
                    }`}
                  />
                </button>
              </div>
            </div>
      </Modal>
    </div>
  );
}

/* ── Policies Tab ────────────────────────────────────────────────── */

type GovernancePolicy = {
  id?: string;
  name?: string;
  type?: string;
  budget_limit_usd?: number;
  blocked_tools?: string[];
  allowed_domains?: string[];
  require_confirmation?: boolean;
  max_tokens_per_turn?: number;
  constraints?: Record<string, unknown>;
};

function PoliciesTab() {
  const { showToast } = useToast();
  const [modalOpen, setModalOpen] = useState(false);
  const [formName, setFormName] = useState("");
  const [formBudget, setFormBudget] = useState<number | "">("");
  const [formBlockedTools, setFormBlockedTools] = useState("");
  const [formAllowedDomains, setFormAllowedDomains] = useState("");
  const [formRequireConfirmation, setFormRequireConfirmation] = useState(false);
  const [formMaxTokens, setFormMaxTokens] = useState<number | "">("");
  const [saving, setSaving] = useState(false);

  const policiesQuery = useApiQuery<
    { policies: GovernancePolicy[] } | GovernancePolicy[]
  >("/api/v1/policies");

  const policies: GovernancePolicy[] = useMemo(() => {
    const raw = policiesQuery.data;
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    return raw.policies ?? [];
  }, [policiesQuery.data]);

  const handleCreate = useCallback(async () => {
    if (!formName.trim()) {
      showToast("Policy name is required", "error");
      return;
    }
    setSaving(true);
    try {
      await apiPost("/api/v1/policies", {
        name: formName.trim(),
        budget_limit_usd: formBudget || undefined,
        blocked_tools: formBlockedTools
          ? formBlockedTools.split(",").map((s) => s.trim()).filter(Boolean)
          : [],
        allowed_domains: formAllowedDomains
          ? formAllowedDomains.split(",").map((s) => s.trim()).filter(Boolean)
          : [],
        require_confirmation: formRequireConfirmation,
        max_tokens_per_turn: formMaxTokens || undefined,
      });
      showToast("Policy created", "success");
      setModalOpen(false);
      policiesQuery.refetch();
    } catch {
      showToast("Failed to create policy", "error");
    } finally {
      setSaving(false);
    }
  }, [
    formName,
    formBudget,
    formBlockedTools,
    formAllowedDomains,
    formRequireConfirmation,
    formMaxTokens,
    showToast,
    policiesQuery,
  ]);

  const handleDelete = useCallback(
    async (id: string) => {
      try {
        await apiDelete(`/api/v1/policies/${encodeURIComponent(id)}`);
        showToast("Policy deleted", "success");
        policiesQuery.refetch();
      } catch {
        showToast("Failed to delete policy", "error");
      }
    },
    [showToast, policiesQuery],
  );

  const policyTypeLabel = (policy: GovernancePolicy) => {
    const parts: string[] = [];
    if (policy.budget_limit_usd != null) parts.push("budget");
    if (policy.blocked_tools?.length) parts.push("tools");
    if (policy.allowed_domains?.length) parts.push("domains");
    if (policy.type) return policy.type;
    return parts.join(", ") || "general";
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-[var(--space-4)]">
        <h2 className="text-[var(--text-xs)] text-text-muted uppercase tracking-wide">
          Governance Policies
        </h2>
        <button
          onClick={() => {
            setFormName("");
            setFormBudget("");
            setFormBlockedTools("");
            setFormAllowedDomains("");
            setFormRequireConfirmation(false);
            setFormMaxTokens("");
            setModalOpen(true);
          }}
          className="btn btn-primary text-[var(--text-xs)] min-h-[var(--touch-target-min)]"
        >
          <Plus size={14} />
          Create Policy
        </button>
      </div>

      <QueryState
        loading={policiesQuery.loading}
        error={policiesQuery.error}
        onRetry={policiesQuery.refetch}
      >
        {policies.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-[var(--space-3)]">
            {policies.map((policy, i) => (
              <div
                key={policy.id ?? i}
                className="card flex flex-col gap-[var(--space-3)]"
              >
                <div className="flex items-center justify-between">
                  <h3 className="text-[var(--text-sm)] font-semibold text-text-primary">
                    {policy.name ?? `Policy ${i + 1}`}
                  </h3>
                  <div className="flex items-center gap-[var(--space-2)]">
                    <span className="inline-block px-2 py-0.5 rounded text-[10px] font-semibold uppercase bg-chart-orange/15 text-chart-orange border border-chart-orange/20">
                      {policyTypeLabel(policy)}
                    </span>
                    <button
                      onClick={() => policy.id && handleDelete(policy.id)}
                      className="btn btn-ghost text-status-error p-[var(--space-1)] min-h-[var(--touch-target-min)] min-w-[var(--touch-target-min)]"
                      aria-label="Delete policy"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>

                <div className="space-y-[var(--space-1)] text-[var(--text-xs)]">
                  {policy.budget_limit_usd != null && (
                    <div className="flex justify-between">
                      <span className="text-text-muted">Budget Limit</span>
                      <span className="text-text-primary font-mono">
                        ${policy.budget_limit_usd}
                      </span>
                    </div>
                  )}
                  {policy.blocked_tools && policy.blocked_tools.length > 0 && (
                    <div className="flex justify-between">
                      <span className="text-text-muted">Blocked Tools</span>
                      <span className="text-text-secondary truncate max-w-[200px]">
                        {policy.blocked_tools.join(", ")}
                      </span>
                    </div>
                  )}
                  {policy.allowed_domains &&
                    policy.allowed_domains.length > 0 && (
                      <div className="flex justify-between">
                        <span className="text-text-muted">Allowed Domains</span>
                        <span className="text-text-secondary truncate max-w-[200px]">
                          {policy.allowed_domains.join(", ")}
                        </span>
                      </div>
                    )}
                  {policy.require_confirmation && (
                    <div className="flex justify-between">
                      <span className="text-text-muted">
                        Require Confirmation
                      </span>
                      <span className="text-status-live font-semibold">
                        Yes
                      </span>
                    </div>
                  )}
                  {policy.max_tokens_per_turn != null && (
                    <div className="flex justify-between">
                      <span className="text-text-muted">
                        Max Tokens/Turn
                      </span>
                      <span className="text-text-primary font-mono">
                        {policy.max_tokens_per_turn.toLocaleString()}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState
            icon={<BookOpen size={28} />}
            title="No governance policies"
            description="Create policies to control agent behavior, budgets, and tool access."
            action={
              <button
                onClick={() => setModalOpen(true)}
                className="btn btn-primary text-[var(--text-xs)] min-h-[var(--touch-target-min)]"
              >
                <Plus size={14} />
                Create Policy
              </button>
            }
          />
        )}
      </QueryState>

      {/* Create modal */}
      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title="Create Governance Policy"
        maxWidth="lg"
        footer={
          <>
            <button
              onClick={() => setModalOpen(false)}
              className="btn btn-secondary text-[var(--text-xs)] min-h-[var(--touch-target-min)]"
            >
              Cancel
            </button>
            <button
              onClick={handleCreate}
              disabled={saving}
              className="btn btn-primary text-[var(--text-xs)] min-h-[var(--touch-target-min)]"
            >
              {saving ? (
                <>
                  <Loader2 size={12} className="animate-spin" />
                  Saving...
                </>
              ) : (
                "Create"
              )}
            </button>
          </>
        }
      >
            <div className="space-y-[var(--space-4)]">
              <div>
                <label className="block text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-1)]">
                  Policy Name
                </label>
                <input
                  type="text"
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  placeholder="e.g., Production Safety"
                />
              </div>
              <div>
                <label className="block text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-1)]">
                  Budget Limit (USD)
                </label>
                <input
                  type="number"
                  value={formBudget}
                  onChange={(e) =>
                    setFormBudget(
                      e.target.value === "" ? "" : Number(e.target.value),
                    )
                  }
                  placeholder="e.g., 100"
                  min={0}
                  step={0.01}
                />
              </div>
              <div>
                <label className="block text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-1)]">
                  Blocked Tools (comma-separated)
                </label>
                <input
                  type="text"
                  value={formBlockedTools}
                  onChange={(e) => setFormBlockedTools(e.target.value)}
                  placeholder="e.g., execute_code, delete_file"
                />
              </div>
              <div>
                <label className="block text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-1)]">
                  Allowed Domains (comma-separated)
                </label>
                <input
                  type="text"
                  value={formAllowedDomains}
                  onChange={(e) => setFormAllowedDomains(e.target.value)}
                  placeholder="e.g., api.example.com, docs.example.com"
                />
              </div>
              <div className="flex items-center justify-between min-h-[var(--touch-target-min)]">
                <label className="text-[var(--text-sm)] text-text-primary">
                  Require Confirmation for Destructive Actions
                </label>
                <button
                  onClick={() =>
                    setFormRequireConfirmation(!formRequireConfirmation)
                  }
                  className={`relative w-10 h-[22px] rounded-full transition-colors ${
                    formRequireConfirmation ? "bg-accent" : "bg-surface-hover"
                  }`}
                  aria-label="Toggle require confirmation"
                >
                  <span
                    className={`absolute top-[3px] w-4 h-4 rounded-full bg-text-primary transition-transform ${
                      formRequireConfirmation
                        ? "translate-x-[22px]"
                        : "translate-x-[3px]"
                    }`}
                  />
                </button>
              </div>
              <div>
                <label className="block text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-1)]">
                  Max Tokens Per Turn
                </label>
                <input
                  type="number"
                  value={formMaxTokens}
                  onChange={(e) =>
                    setFormMaxTokens(
                      e.target.value === "" ? "" : Number(e.target.value),
                    )
                  }
                  placeholder="e.g., 4096"
                  min={1}
                />
              </div>
            </div>
      </Modal>
    </div>
  );
}

export { CompliancePage as default };
