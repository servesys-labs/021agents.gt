import { useState, useEffect, useCallback } from "react";
import { Shield, RefreshCw, Play } from "lucide-react";

import { type AgentConfig } from "../../../lib/adapters";
import { apiGet, apiPost } from "../../../lib/api";
import { useToast } from "../../../components/common/ToastProvider";

/* ── Props ────────────────────────────────────────────────────── */

type SecurityTabProps = {
  agent: AgentConfig;
};

/* ── Types ────────────────────────────────────────────────────── */

type SecurityScan = {
  id?: string;
  status?: string;
  risk_score?: number;
  findings?: SecurityFinding[];
  scanned_at?: string;
};

type SecurityFinding = {
  id?: string;
  severity?: "critical" | "high" | "medium" | "low" | "info";
  title?: string;
  description?: string;
  recommendation?: string;
};

/* ── Helpers ──────────────────────────────────────────────────── */

function severityColor(severity?: string): string {
  switch (severity) {
    case "critical": return "var(--color-status-error)";
    case "high": return "var(--color-status-error)";
    case "medium": return "var(--color-status-warning)";
    case "low": return "var(--color-status-info)";
    default: return "var(--color-surface-overlay)";
  }
}

/* ── Component ────────────────────────────────────────────────── */

export const SecurityTab = ({ agent }: SecurityTabProps) => {
  const { showToast } = useToast();

  const [scan, setScan] = useState<SecurityScan | null>(null);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);

  /* ── Fetch latest scan ──────────────────────────────────────── */

  const fetchScan = useCallback(async () => {
    try {
      const data = await apiGet<SecurityScan>(`/api/v1/security/agents/${agent.name}/scan`);
      setScan(data);
    } catch {
      setScan(null);
    }
  }, [agent.name]);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      await fetchScan();
      setLoading(false);
    };
    void load();
  }, [fetchScan]);

  /* ── Run scan ───────────────────────────────────────────────── */

  const handleScan = async () => {
    setScanning(true);
    try {
      await apiPost(`/api/v1/security/agents/${agent.name}/scan`);
      showToast("Security scan started", "success");
      await fetchScan();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to start scan", "error");
    } finally {
      setScanning(false);
    }
  };

  /* ── Render ─────────────────────────────────────────────────── */

  return (
    <div className="space-y-6">
      {/* Governance summary */}
      <div className="card">
        <h3 className="text-sm font-semibold text-text-primary mb-3">Security & Governance</h3>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <span className="block text-xs text-text-muted uppercase tracking-wide mb-1">Budget Limit</span>
            <span className="text-sm text-text-secondary">
              ${agent.governance?.budget_limit_usd ?? "Not set"}
            </span>
          </div>
          <div>
            <span className="block text-xs text-text-muted uppercase tracking-wide mb-1">
              Destructive Confirmation
            </span>
            <span className="text-sm text-text-secondary">
              {agent.governance?.require_confirmation_for_destructive ? "Required" : "Disabled"}
            </span>
          </div>
          <div>
            <span className="block text-xs text-text-muted uppercase tracking-wide mb-1">Blocked Tools</span>
            <span className="text-sm text-text-secondary">
              {agent.governance?.blocked_tools?.length
                ? agent.governance.blocked_tools.join(", ")
                : "None"}
            </span>
          </div>
        </div>
      </div>

      {/* Scan controls */}
      <div className="card flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-text-primary">Security Scan</h3>
          <p className="text-xs text-text-muted mt-0.5">
            Run a security assessment against <span className="font-mono text-text-secondary">{agent.name}</span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void fetchScan()}
            className="btn btn-ghost p-1"
            style={{ minWidth: "var(--touch-target-min)", minHeight: "var(--touch-target-min)" }}
            aria-label="Refresh scan"
          >
            <RefreshCw size={14} />
          </button>
          <button
            type="button"
            onClick={() => void handleScan()}
            disabled={scanning}
            className="btn btn-primary"
            style={{ minHeight: "var(--touch-target-min)" }}
          >
            <Play size={14} />
            {scanning ? "Scanning..." : "Run Scan"}
          </button>
        </div>
      </div>

      {/* Scan results */}
      <div className="card">
        <h3 className="text-sm font-semibold text-text-primary mb-3">Latest Scan Results</h3>

        {loading ? (
          <p className="text-xs text-text-muted py-4 text-center">Loading scan results...</p>
        ) : !scan ? (
          <div className="border border-border-default rounded-md p-6 flex items-center justify-center">
            <p className="text-xs text-text-muted">No scan results yet. Click "Run Scan" to start.</p>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Risk score */}
            <div className="flex items-center gap-4">
              <Shield size={24} className="text-text-muted" />
              <div>
                <span className="block text-xs text-text-muted uppercase tracking-wide mb-1">Risk Score</span>
                <span
                  className="text-2xl font-bold"
                  style={{
                    color:
                      (scan.risk_score ?? 0) >= 7 ? "var(--color-status-error)" :
                      (scan.risk_score ?? 0) >= 4 ? "var(--color-status-warning)" :
                      "var(--color-status-live)",
                  }}
                >
                  {scan.risk_score != null ? scan.risk_score.toFixed(1) : "-"} / 10
                </span>
              </div>
              <div className="ml-auto text-right">
                <span className="block text-xs text-text-muted uppercase tracking-wide mb-1">Status</span>
                <span
                  className="inline-block text-xs font-medium px-2 py-0.5 rounded-full"
                  style={{
                    backgroundColor:
                      scan.status === "completed" ? "var(--color-status-live)" :
                      scan.status === "running" ? "var(--color-status-warning)" :
                      "var(--color-surface-overlay)",
                    color: "var(--color-text-primary)",
                  }}
                >
                  {scan.status ?? "unknown"}
                </span>
              </div>
            </div>

            {/* Findings */}
            {scan.findings && scan.findings.length > 0 ? (
              <div className="space-y-2">
                <h4 className="text-xs font-semibold text-text-muted uppercase tracking-wide">
                  Findings ({scan.findings.length})
                </h4>
                {scan.findings.map((finding, idx) => (
                  <div
                    key={finding.id ?? idx}
                    className="px-3 py-2 border rounded-md"
                    style={{ borderColor: severityColor(finding.severity) }}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <span
                        className="inline-block text-[10px] font-bold uppercase px-1.5 py-0.5 rounded"
                        style={{
                          backgroundColor: severityColor(finding.severity),
                          color: "var(--color-text-primary)",
                        }}
                      >
                        {finding.severity ?? "info"}
                      </span>
                      <span className="text-sm font-medium text-text-secondary">{finding.title}</span>
                    </div>
                    {finding.description && (
                      <p className="text-xs text-text-muted mt-1">{finding.description}</p>
                    )}
                    {finding.recommendation && (
                      <p className="text-xs text-text-secondary mt-1">
                        <span className="font-semibold">Fix: </span>
                        {finding.recommendation}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-text-muted">No findings reported.</p>
            )}

            {/* Scan date */}
            {scan.scanned_at && (
              <p className="text-xs text-text-muted text-right">
                Last scanned: {new Date(scan.scanned_at).toLocaleString()}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
