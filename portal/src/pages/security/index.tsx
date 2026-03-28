import { useCallback, useMemo, useState } from "react";
import {
  AlertTriangle,
  BarChart3,
  RefreshCw,
  Scan,
  Shield,
  ShieldAlert,
} from "lucide-react";
import { Link } from "react-router-dom";

import { PageHeader } from "../../components/common/PageHeader";
import { QueryState } from "../../components/common/QueryState";
import { EmptyState } from "../../components/common/EmptyState";
import { AssistPanel } from "../../components/common/AssistPanel";
import { SeverityBadge, normalizeLevel } from "../../components/common/SeverityBadge";
import { ScoreGauge } from "../../components/common/ScoreGauge";
import { useApiQuery, apiRequest } from "../../lib/api";
import { useToast } from "../../components/common/ToastProvider";
import { formatDateTime } from "../../lib/format";

/* ── Types ──────────────────────────────────────────────────────── */

type SecurityScan = {
  scan_id: string;
  agent_name: string;
  scan_type?: string;
  status?: string;
  total_probes?: number;
  passed: number;
  failed: number;
  risk_score: number;
  risk_level: string;
  created_at?: number | string;
};

type RiskProfile = {
  agent_name: string;
  risk_score: number;
  risk_level: string;
  last_scan_id?: string;
  aivss_vector_json?: string;
  findings_summary?: { total?: number; by_severity?: Record<string, number> };
};

type Probe = {
  name: string;
  category?: string;
  description?: string;
};

/* ── AIVSS Vector Components ─────────────────────────────────────── */

const AIVSS_COMPONENTS = [
  { key: "AV", label: "Attack Vector", options: ["Network", "Adjacent", "Local", "Physical"] },
  { key: "AC", label: "Attack Complexity", options: ["Low", "High"] },
  { key: "PR", label: "Privileges Required", options: ["None", "Low", "High"] },
  { key: "UI", label: "User Interaction", options: ["None", "Required"] },
  { key: "S", label: "Scope", options: ["Unchanged", "Changed"] },
  { key: "C", label: "Confidentiality", options: ["None", "Low", "High"] },
  { key: "I", label: "Integrity", options: ["None", "Low", "High"] },
  { key: "A", label: "Availability", options: ["None", "Low", "High"] },
] as const;

/* ── Helpers ─────────────────────────────────────────────────────── */

/** Text color for risk levels — used in places where we only need the color */
function riskColor(level: string) {
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

/* Compute a simple AIVSS-style base score from vector components */
function computeAivssScore(vector: Record<string, string>): number {
  /* Simplified CVSS-like calculation */
  const avWeights: Record<string, number> = {
    Network: 0.85,
    Adjacent: 0.62,
    Local: 0.55,
    Physical: 0.2,
  };
  const acWeights: Record<string, number> = { Low: 0.77, High: 0.44 };
  const prNoneWeights: Record<string, number> = {
    None: 0.85,
    Low: 0.62,
    High: 0.27,
  };
  const uiWeights: Record<string, number> = { None: 0.85, Required: 0.62 };
  const impactWeights: Record<string, number> = {
    High: 0.56,
    Low: 0.22,
    None: 0,
  };

  const av = avWeights[vector.AV] ?? 0.85;
  const ac = acWeights[vector.AC] ?? 0.77;
  const pr = prNoneWeights[vector.PR] ?? 0.85;
  const ui = uiWeights[vector.UI] ?? 0.85;

  const exploitability = 8.22 * av * ac * pr * ui;

  const c = impactWeights[vector.C] ?? 0;
  const i = impactWeights[vector.I] ?? 0;
  const a = impactWeights[vector.A] ?? 0;

  const iss = 1 - (1 - c) * (1 - i) * (1 - a);
  const scopeChanged = vector.S === "Changed";
  const impact = scopeChanged
    ? 7.52 * (iss - 0.029) - 3.25 * Math.pow(iss - 0.02, 15)
    : 6.42 * iss;

  if (impact <= 0) return 0;

  const base = scopeChanged
    ? Math.min(1.08 * (impact + exploitability), 10)
    : Math.min(impact + exploitability, 10);

  return Math.round(base * 10) / 10;
}

/* ── Security Page ───────────────────────────────────────────────── */

export function SecurityPage() {
  const { showToast } = useToast();

  const scansQuery = useApiQuery<{ scans: SecurityScan[] } | SecurityScan[]>(
    "/api/v1/security/scans?limit=50",
  );
  const profilesQuery = useApiQuery<
    { profiles: RiskProfile[] } | RiskProfile[]
  >("/api/v1/security/risk-profiles");
  const probesQuery = useApiQuery<{ probes: Probe[] } | Probe[]>(
    "/api/v1/security/probes",
  );

  const scans: SecurityScan[] = useMemo(() => {
    const raw = scansQuery.data;
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    return raw.scans ?? [];
  }, [scansQuery.data]);

  const profiles: RiskProfile[] = useMemo(() => {
    const raw = profilesQuery.data;
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    return raw.profiles ?? [];
  }, [profilesQuery.data]);

  /* AIVSS calculator state */
  const [aivssVector, setAivssVector] = useState<Record<string, string>>({
    AV: "Network",
    AC: "Low",
    PR: "None",
    UI: "None",
    S: "Unchanged",
    C: "None",
    I: "None",
    A: "None",
  });

  const aivssScore = useMemo(() => computeAivssScore(aivssVector), [aivssVector]);
  const aivssLevel =
    aivssScore >= 9
      ? "Critical"
      : aivssScore >= 7
        ? "High"
        : aivssScore >= 4
          ? "Medium"
          : aivssScore > 0
            ? "Low"
            : "None";

  const handleScanAgent = useCallback(
    async (agentName: string) => {
      try {
        const result = await apiRequest<{
          scan_id: string;
          risk_score: number;
          risk_level: string;
        }>(
          `/api/v1/security/scan/${encodeURIComponent(agentName)}`,
          "POST",
        );
        showToast(
          `Scan complete: ${result.risk_level} (${result.risk_score}/10)`,
          "success",
        );
        scansQuery.refetch();
        profilesQuery.refetch();
      } catch {
        showToast("Scan failed", "error");
      }
    },
    [showToast, scansQuery, profilesQuery],
  );

  return (
    <div>
      <PageHeader
        title="Security"
        subtitle="Red-teaming, AIVSS risk scoring, and security scan history"
        onRefresh={() => {
          scansQuery.refetch();
          profilesQuery.refetch();
        }}
        actions={
          <div className="flex items-center gap-[var(--space-2)]">
            <Link
              to="/security/findings"
              className="btn btn-secondary text-[var(--text-xs)] min-h-[var(--touch-target-min)]"
            >
              <ShieldAlert size={14} />
              Findings
            </Link>
            <Link
              to="/security/report"
              className="btn btn-secondary text-[var(--text-xs)] min-h-[var(--touch-target-min)]"
            >
              <BarChart3 size={14} />
              Report
            </Link>
          </div>
        }
      />

      {/* Meta-agent assist */}
      <div className="mb-[var(--space-4)]">
        <AssistPanel compact />
      </div>

      {/* ── Scan History Table ────────────────────────────────────── */}
      <section className="mb-[var(--space-8)]">
        <h2 className="text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-3)]">
          Scan History
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
                      <tr key={scan.scan_id} className="cursor-pointer">
                        <td className="text-text-primary font-medium">
                          <Link
                            to={`/security/scans/${scan.scan_id}`}
                            className="hover:text-accent transition-colors"
                          >
                            {scan.agent_name}
                          </Link>
                        </td>
                        <td className="text-text-muted">
                          {formatDateTime(scan.created_at)}
                        </td>
                        <td className="text-right">
                          <ScoreGauge score={scan.risk_score} size="sm" />
                        </td>
                        <td className="text-center">
                          <SeverityBadge level={normalizeLevel(scan.risk_level)} size="sm" />
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
            </div>
          ) : (
            <EmptyState title="No security scans" description="Run a security scan to get started." />
          )}
        </QueryState>
      </section>

      {/* ── Risk Profiles ────────────────────────────────────────── */}
      <section className="mb-[var(--space-8)]">
        <h2 className="text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-3)]">
          Risk Profiles
        </h2>

        <QueryState loading={profilesQuery.loading} error={profilesQuery.error}>
          {profiles.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-[var(--space-3)]">
              {profiles.map((profile) => (
                <div key={profile.agent_name} className="card">
                  <div className="flex items-center justify-between mb-[var(--space-2)]">
                    <span className="text-[var(--text-sm)] font-medium text-text-primary truncate">
                      {profile.agent_name}
                    </span>
                    <span
                      className={`text-[10px] font-semibold uppercase ${riskColor(profile.risk_level)}`}
                    >
                      {profile.risk_level}
                    </span>
                  </div>
                  <ScoreGauge score={profile.risk_score} />
                  <div className="flex items-center gap-[var(--space-3)] mt-[var(--space-2)] text-[10px] text-text-muted">
                    <span>
                      {profile.findings_summary?.total ?? 0} findings
                    </span>
                  </div>

                  {/* Sparkline for risk trend */}
                  <div className="mt-[var(--space-3)]">
                    <button
                      onClick={() => handleScanAgent(profile.agent_name)}
                      className="btn btn-secondary text-[var(--text-xs)] w-full min-h-[var(--touch-target-min)]"
                    >
                      <Scan size={14} />
                      Run Scan
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState title="No risk profiles" description="Run a security scan to generate risk profiles." />
          )}
        </QueryState>
      </section>

      {/* ── AIVSS Calculator ─────────────────────────────────────── */}
      <section className="mb-[var(--space-8)]">
        <h2 className="text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-3)]">
          AIVSS Calculator
        </h2>

        <div className="card">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-[var(--space-3)] mb-[var(--space-4)]">
            {AIVSS_COMPONENTS.map((comp) => (
              <div key={comp.key}>
                <label className="block text-[10px] text-text-muted uppercase tracking-wide mb-[var(--space-1)]">
                  {comp.label} ({comp.key})
                </label>
                <select
                  value={aivssVector[comp.key]}
                  onChange={(e) =>
                    setAivssVector((prev) => ({
                      ...prev,
                      [comp.key]: e.target.value,
                    }))
                  }
                  className="w-full px-[var(--space-2)] py-[var(--space-2)] text-[var(--text-xs)] min-h-[var(--touch-target-min)]"
                >
                  {comp.options.map((opt) => (
                    <option key={opt} value={opt}>
                      {opt}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>

          {/* Score display */}
          <div className="flex items-center gap-[var(--space-4)] p-[var(--space-4)] rounded-lg bg-surface-overlay">
            <div>
              <p className="text-[10px] text-text-muted uppercase tracking-wide mb-[var(--space-1)]">
                Computed Score
              </p>
              <p
                className={`text-[var(--text-xl)] font-bold font-mono ${riskColor(aivssLevel.toLowerCase())}`}
              >
                {aivssScore.toFixed(1)}
              </p>
            </div>
            <div>
              <p className="text-[10px] text-text-muted uppercase tracking-wide mb-[var(--space-1)]">
                Risk Level
              </p>
              <SeverityBadge level={normalizeLevel(aivssLevel)} />
            </div>
            <div className="flex-1">
              <p className="text-[10px] text-text-muted uppercase tracking-wide mb-[var(--space-1)]">
                Vector String
              </p>
              <p className="text-[var(--text-xs)] font-mono text-text-secondary">
                AIVSS:1.0/AV:{aivssVector.AV?.charAt(0)}/AC:
                {aivssVector.AC?.charAt(0)}/PR:{aivssVector.PR?.charAt(0)}/UI:
                {aivssVector.UI?.charAt(0)}/S:{aivssVector.S?.charAt(0)}/C:
                {aivssVector.C?.charAt(0)}/I:{aivssVector.I?.charAt(0)}/A:
                {aivssVector.A?.charAt(0)}
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ── Risk Trends (sparklines per agent) ───────────────────── */}
      <section className="mb-[var(--space-8)]">
        <h2 className="text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-3)]">
          Risk Trends
        </h2>

        {profiles.length > 0 ? (
          <div className="card">
            <div className="space-y-4">
              {profiles.map((profile) => (
                <div
                  key={`trend-${profile.agent_name}`}
                  className="flex items-center gap-4"
                >
                  <span className="text-xs text-text-primary w-32 truncate font-medium">
                    {profile.agent_name}
                  </span>
                  <div className="flex-1">
                    <ScoreGauge score={profile.risk_score} size="md" showLabel={false} />
                  </div>
                  <span
                    className={`text-xs font-mono font-semibold ${riskColor(profile.risk_level)}`}
                  >
                    {profile.risk_score.toFixed(1)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <EmptyState title="No risk data" description="Risk trend data will appear here once available." />
        )}
      </section>
    </div>
  );
}

export { SecurityPage as default };
