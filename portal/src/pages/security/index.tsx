import { useMemo, useState } from "react";
import {
  Shield,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  Scan,
  RefreshCw,
  AlertTriangle,
  CheckCircle,
  XCircle,
  Target,
} from "lucide-react";

import { PageHeader } from "../../components/common/PageHeader";
import { QueryState } from "../../components/common/QueryState";
import { Tabs } from "../../components/common/Tabs";
import { EmptyState } from "../../components/common/EmptyState";
import { SlidePanel } from "../../components/common/SlidePanel";
import { useApiQuery, apiRequest } from "../../lib/api";
import { useToast } from "../../components/common/ToastProvider";

/* ── Types ─────────────────────────────────────────────────────── */

type SecurityScan = {
  scan_id: string;
  agent_name: string;
  scan_type: string;
  status: string;
  total_probes: number;
  passed: number;
  failed: number;
  risk_score: number;
  risk_level: string;
  created_at: number;
};

type SecurityFinding = {
  id: number;
  scan_id: string;
  agent_name: string;
  probe_name: string;
  category: string;
  layer: string;
  severity: string;
  title: string;
  description: string;
  evidence: string;
  aivss_score: number;
};

type RiskProfile = {
  agent_name: string;
  risk_score: number;
  risk_level: string;
  last_scan_id: string;
  findings_summary: { total?: number; by_severity?: Record<string, number> };
};

/* ── Helpers ───────────────────────────────────────────────────── */

const riskColor = (level: string) => {
  switch (level) {
    case "critical": return "text-status-error";
    case "high": return "text-chart-orange";
    case "medium": return "text-status-warning";
    case "low": return "text-status-live";
    default: return "text-text-muted";
  }
};

const riskBg = (level: string) => {
  switch (level) {
    case "critical": return "bg-status-error";
    case "high": return "bg-chart-orange";
    case "medium": return "bg-status-warning";
    case "low": return "bg-status-live";
    default: return "bg-text-muted";
  }
};

const ScoreGauge = ({ score, size = "lg" }: { score: number; size?: "sm" | "lg" }) => {
  const level = score >= 9 ? "critical" : score >= 7 ? "high" : score >= 4 ? "medium" : score > 0 ? "low" : "none";
  const pct = Math.min(100, (score / 10) * 100);
  return (
    <div className={`flex items-center gap-2 ${size === "sm" ? "" : ""}`}>
      <div className={`${size === "lg" ? "w-20 h-2" : "w-12 h-1.5"} bg-surface-overlay rounded-full overflow-hidden`}>
        <div className={`h-full rounded-full ${riskBg(level)}`} style={{ width: `${pct}%` }} />
      </div>
      <span className={`font-mono font-semibold ${riskColor(level)} ${size === "lg" ? "text-sm" : "text-[10px]"}`}>
        {score.toFixed(1)}
      </span>
    </div>
  );
};

/* ── Main Page ─────────────────────────────────────────────────── */

export const SecurityPage = () => {
  const { showToast } = useToast();
  const [activeTab, setActiveTab] = useState(0);
  const [selectedScan, setSelectedScan] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [scanAgent, setScanAgent] = useState("");

  const scansQuery = useApiQuery<{ scans: SecurityScan[] }>("/api/v1/security/scans");
  const profilesQuery = useApiQuery<{ profiles: RiskProfile[] }>("/api/v1/security/risk-profiles");
  const findingsQuery = useApiQuery<{ findings: SecurityFinding[] }>(
    `/api/v1/security/findings?scan_id=${selectedScan ?? ""}`,
    Boolean(selectedScan),
  );

  const scans = useMemo(() => scansQuery.data?.scans ?? [], [scansQuery.data]);
  const profiles = useMemo(() => profilesQuery.data?.profiles ?? [], [profilesQuery.data]);
  const findings = useMemo(() => findingsQuery.data?.findings ?? [], [findingsQuery.data]);

  const handleRefresh = () => {
    scansQuery.refetch();
    profilesQuery.refetch();
  };

  const handleScan = async () => {
    if (!scanAgent.trim()) return;
    try {
      const result = await apiRequest<{ scan_id: string; risk_score: number; risk_level: string }>(
        `/api/v1/security/scan/${encodeURIComponent(scanAgent)}`, "POST",
      );
      showToast(`Scan complete: ${result.risk_level} (${result.risk_score}/10)`, "success");
      setScanAgent("");
      handleRefresh();
    } catch {
      showToast("Scan failed", "error");
    }
  };

  return (
    <div className="max-w-[1400px] mx-auto">
      <PageHeader
        title="Security"
        subtitle="Red-teaming, MAESTRO assessment, and AIVSS risk scoring"
        actions={
          <div className="flex items-center gap-2">
            <input
              type="text"
              placeholder="Agent name..."
              value={scanAgent}
              onChange={(e) => setScanAgent(e.target.value)}
              className="px-2 py-1.5 text-xs rounded-lg bg-surface-raised border border-border-default text-text-primary w-36"
            />
            <button onClick={handleScan} className="btn btn-primary text-xs" disabled={!scanAgent.trim()}>
              <Scan size={14} /> Scan
            </button>
            <button onClick={handleRefresh} className="btn btn-secondary">
              <RefreshCw size={14} />
            </button>
          </div>
        }
      />

      {/* Risk Profile Cards */}
      {profiles.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          {profiles.slice(0, 4).map((p) => (
            <div key={p.agent_name} className="card">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-medium text-text-primary truncate">{p.agent_name}</span>
                <span className={`text-[10px] font-semibold uppercase ${riskColor(p.risk_level)}`}>{p.risk_level}</span>
              </div>
              <ScoreGauge score={p.risk_score} />
              <div className="flex items-center gap-2 mt-2 text-[10px] text-text-muted">
                <span>{p.findings_summary?.total ?? 0} findings</span>
              </div>
            </div>
          ))}
        </div>
      )}

      <Tabs
        tabs={["Scans", "Risk Profiles", "Findings"]}
        activeIndex={activeTab}
        onChange={setActiveTab}
      />

      {/* Tab: Scans */}
      {activeTab === 0 && (
        <QueryState loading={scansQuery.loading} error={scansQuery.error}>
          {scans.length > 0 ? (
            <div className="card mt-4">
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border-default text-text-muted">
                      <th className="text-left py-2 pr-4">Scan</th>
                      <th className="text-left py-2 px-3">Agent</th>
                      <th className="text-left py-2 px-3">Type</th>
                      <th className="text-center py-2 px-3">Risk</th>
                      <th className="text-right py-2 px-3">Passed</th>
                      <th className="text-right py-2 px-3">Failed</th>
                      <th className="text-center py-2 px-3">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {scans.map((s) => (
                      <tr key={s.scan_id} className="border-b border-border-default/50 hover:bg-surface-overlay/30">
                        <td className="py-2 pr-4 font-mono text-text-secondary text-[10px]">{s.scan_id}</td>
                        <td className="py-2 px-3 text-text-primary">{s.agent_name}</td>
                        <td className="py-2 px-3 text-text-muted">{s.scan_type}</td>
                        <td className="py-2 px-3 text-center"><ScoreGauge score={s.risk_score} size="sm" /></td>
                        <td className="py-2 px-3 text-right text-status-live">{s.passed}</td>
                        <td className="py-2 px-3 text-right text-status-error">{s.failed}</td>
                        <td className="py-2 px-3 text-center">
                          <button
                            onClick={() => { setSelectedScan(s.scan_id); setDrawerOpen(true); }}
                            className="text-accent hover:underline text-[10px]"
                          >
                            Findings
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <EmptyState message="No security scans yet. Enter an agent name and click Scan." />
          )}
        </QueryState>
      )}

      {/* Tab: Risk Profiles */}
      {activeTab === 1 && (
        <QueryState loading={profilesQuery.loading} error={profilesQuery.error}>
          {profiles.length > 0 ? (
            <div className="card mt-4">
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border-default text-text-muted">
                      <th className="text-left py-2 pr-4">Agent</th>
                      <th className="text-center py-2 px-3">AIVSS Score</th>
                      <th className="text-center py-2 px-3">Risk Level</th>
                      <th className="text-right py-2 px-3">Findings</th>
                      <th className="text-left py-2 px-3">Last Scan</th>
                    </tr>
                  </thead>
                  <tbody>
                    {profiles.map((p) => (
                      <tr key={p.agent_name} className="border-b border-border-default/50 hover:bg-surface-overlay/30">
                        <td className="py-2 pr-4 text-text-primary font-medium">{p.agent_name}</td>
                        <td className="py-2 px-3 text-center"><ScoreGauge score={p.risk_score} size="sm" /></td>
                        <td className="py-2 px-3 text-center">
                          <span className={`text-[10px] font-semibold uppercase ${riskColor(p.risk_level)}`}>{p.risk_level}</span>
                        </td>
                        <td className="py-2 px-3 text-right text-text-muted">{p.findings_summary?.total ?? 0}</td>
                        <td className="py-2 px-3 font-mono text-text-muted text-[10px]">{p.last_scan_id?.slice(0, 12)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <EmptyState message="No risk profiles. Run a security scan to generate them." />
          )}
        </QueryState>
      )}

      {/* Tab: Findings */}
      {activeTab === 2 && (
        <div className="mt-4">
          {selectedScan ? (
            <QueryState loading={findingsQuery.loading} error={findingsQuery.error}>
              {findings.length > 0 ? (
                <div className="card">
                  <h3 className="text-sm font-medium text-text-primary mb-3">Findings — Scan {selectedScan.slice(0, 12)}</h3>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-border-default text-text-muted">
                          <th className="text-left py-2 pr-4">Probe</th>
                          <th className="text-left py-2 px-3">Category</th>
                          <th className="text-center py-2 px-3">Severity</th>
                          <th className="text-center py-2 px-3">AIVSS</th>
                          <th className="text-left py-2 px-3">Evidence</th>
                        </tr>
                      </thead>
                      <tbody>
                        {findings.map((f) => (
                          <tr key={f.id} className="border-b border-border-default/50">
                            <td className="py-2 pr-4 text-text-primary">{f.probe_name || f.title}</td>
                            <td className="py-2 px-3 text-text-secondary">{f.category}</td>
                            <td className="py-2 px-3 text-center">
                              <span className={`text-[10px] font-semibold uppercase ${riskColor(f.severity)}`}>{f.severity}</span>
                            </td>
                            <td className="py-2 px-3 text-center"><ScoreGauge score={f.aivss_score} size="sm" /></td>
                            <td className="py-2 px-3 text-text-muted truncate max-w-[200px]">{f.evidence}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : (
                <EmptyState message="No findings for this scan (all probes passed)." />
              )}
            </QueryState>
          ) : (
            <EmptyState message="Select a scan from the Scans tab to view findings." />
          )}
        </div>
      )}

      {/* Drawer */}
      <SlidePanel
        open={drawerOpen}
        onClose={() => { setDrawerOpen(false); setSelectedScan(null); }}
        title={`Scan Findings — ${selectedScan?.slice(0, 12) ?? ""}`}
      >
        <QueryState loading={findingsQuery.loading} error={findingsQuery.error}>
          <div className="space-y-3">
            {findings.map((f) => (
              <div key={f.id} className="p-3 rounded-lg bg-surface-overlay/30 border border-border-default/50">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-medium text-text-primary">{f.probe_name || f.title}</span>
                  <span className={`text-[10px] font-semibold ${riskColor(f.severity)}`}>{f.severity}</span>
                </div>
                <div className="flex items-center gap-2 text-[10px] text-text-muted mb-2">
                  <span>{f.category}</span>
                  <span>AIVSS: {f.aivss_score.toFixed(1)}</span>
                </div>
                <p className="text-[10px] text-text-secondary">{f.evidence}</p>
              </div>
            ))}
            {findings.length === 0 && <p className="text-xs text-text-muted text-center py-4">No findings</p>}
          </div>
        </QueryState>
      </SlidePanel>
    </div>
  );
};
