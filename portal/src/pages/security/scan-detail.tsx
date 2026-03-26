import { useMemo } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  Shield,
} from "lucide-react";

import { PageHeader } from "../../components/common/PageHeader";
import { QueryState } from "../../components/common/QueryState";
import { EmptyState } from "../../components/common/EmptyState";
import { StatusBadge } from "../../components/common/StatusBadge";
import { useApiQuery } from "../../lib/api";

/* ── Types ──────────────────────────────────────────────────────── */

type ProbeResult = {
  probe_name: string;
  category?: string;
  passed: boolean;
  details?: string;
  severity?: string;
  recommendation?: string;
};

type ScanDetail = {
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
  completed_at?: number | string;
  duration_ms?: number;
  results?: ProbeResult[];
  aivss_vector_json?: string;
  summary?: string;
};

/* ── Helpers ─────────────────────────────────────────────────────── */

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

function riskBadgeBg(level: string) {
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

/* ── Scan Detail Page ───────────────────────────────────────────── */

export function ScanDetailPage() {
  const { scanId } = useParams<{ scanId: string }>();
  const navigate = useNavigate();

  const { data: scan, loading, error, refetch } = useApiQuery<ScanDetail>(
    `/api/v1/security/scans/${encodeURIComponent(scanId ?? "")}`,
    Boolean(scanId),
  );

  const probeResults = useMemo(() => scan?.results ?? [], [scan]);
  const failedProbes = useMemo(
    () => probeResults.filter((r) => !r.passed),
    [probeResults],
  );
  const passedProbes = useMemo(
    () => probeResults.filter((r) => r.passed),
    [probeResults],
  );

  return (
    <div>
      <div className="mb-4">
        <button
          className="btn btn-secondary text-xs"
          onClick={() => navigate("/security")}
        >
          <ArrowLeft size={14} />
          Back to Security
        </button>
      </div>

      <QueryState
        loading={loading}
        error={error}
        isEmpty={!scan}
        emptyMessage=""
        onRetry={() => void refetch()}
      >
        {!scan ? (
          <EmptyState
            icon={<Shield size={40} />}
            title="Scan not found"
            description={`No scan found with ID "${scanId}".`}
          />
        ) : (
          <>
            <PageHeader
              title={`Scan: ${scan.agent_name}`}
              subtitle={`Scan ID: ${scan.scan_id}`}
              onRefresh={() => void refetch()}
            />

            {/* Summary cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
              <div className="card py-3">
                <p className="text-[10px] text-text-muted uppercase tracking-wide mb-1">
                  Risk Score
                </p>
                <p
                  className={`text-2xl font-bold font-mono ${riskColor(scan.risk_level)}`}
                >
                  {scan.risk_score.toFixed(1)}
                </p>
              </div>
              <div className="card py-3">
                <p className="text-[10px] text-text-muted uppercase tracking-wide mb-1">
                  Risk Level
                </p>
                <span
                  className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase border ${riskBadgeBg(scan.risk_level)}`}
                >
                  {scan.risk_level}
                </span>
              </div>
              <div className="card py-3">
                <p className="text-[10px] text-text-muted uppercase tracking-wide mb-1">
                  Passed
                </p>
                <p className="text-2xl font-bold font-mono text-status-live">
                  {scan.passed}
                </p>
              </div>
              <div className="card py-3">
                <p className="text-[10px] text-text-muted uppercase tracking-wide mb-1">
                  Failed
                </p>
                <p className="text-2xl font-bold font-mono text-status-error">
                  {scan.failed}
                </p>
              </div>
            </div>

            {/* Scan info */}
            <div className="card mb-6">
              <h3 className="text-sm font-semibold text-text-primary mb-3">
                Scan Details
              </h3>
              <dl className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {[
                  ["Scan Type", scan.scan_type || "full"],
                  ["Status", scan.status || "completed"],
                  ["Total Probes", String(scan.total_probes ?? probeResults.length)],
                  ["Duration", scan.duration_ms ? `${scan.duration_ms}ms` : "--"],
                  ["Started", formatDate(scan.created_at)],
                  ["Completed", formatDate(scan.completed_at)],
                ].map(([label, value]) => (
                  <div key={label}>
                    <dt className="text-[10px] text-text-muted uppercase tracking-wide">
                      {label}
                    </dt>
                    <dd className="text-xs text-text-primary font-mono mt-0.5">
                      {value}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>

            {/* Summary */}
            {scan.summary && (
              <div className="card mb-6">
                <h3 className="text-sm font-semibold text-text-primary mb-2">
                  Summary
                </h3>
                <p className="text-xs text-text-secondary leading-relaxed">
                  {scan.summary}
                </p>
              </div>
            )}

            {/* AIVSS Vector */}
            {scan.aivss_vector_json && (
              <div className="card mb-6">
                <h3 className="text-sm font-semibold text-text-primary mb-2">
                  AIVSS Vector
                </h3>
                <pre className="text-xs font-mono bg-surface-base border border-border-default rounded-md p-3 overflow-x-auto">
                  {scan.aivss_vector_json}
                </pre>
              </div>
            )}

            {/* Failed probes */}
            {failedProbes.length > 0 && (
              <div className="card mb-6">
                <h3 className="text-sm font-semibold text-status-error mb-3">
                  Failed Probes ({failedProbes.length})
                </h3>
                <div className="space-y-3">
                  {failedProbes.map((probe) => (
                    <div
                      key={probe.probe_name}
                      className="p-3 rounded-lg bg-status-error/5 border border-status-error/10"
                    >
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs font-medium text-text-primary">
                          {probe.probe_name}
                        </span>
                        {probe.severity && (
                          <span
                            className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase border ${riskBadgeBg(probe.severity)}`}
                          >
                            {probe.severity}
                          </span>
                        )}
                      </div>
                      {probe.category && (
                        <p className="text-[10px] text-text-muted mb-1">
                          Category: {probe.category}
                        </p>
                      )}
                      {probe.details && (
                        <p className="text-xs text-text-secondary mb-1">
                          {probe.details}
                        </p>
                      )}
                      {probe.recommendation && (
                        <p className="text-xs text-accent">
                          {probe.recommendation}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Passed probes */}
            {passedProbes.length > 0 && (
              <div className="card">
                <h3 className="text-sm font-semibold text-status-live mb-3">
                  Passed Probes ({passedProbes.length})
                </h3>
                <div className="overflow-x-auto">
                  <table>
                    <thead>
                      <tr>
                        <th>Probe</th>
                        <th>Category</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {passedProbes.map((probe) => (
                        <tr key={probe.probe_name}>
                          <td className="text-xs text-text-primary">
                            {probe.probe_name}
                          </td>
                          <td className="text-xs text-text-muted">
                            {probe.category || "--"}
                          </td>
                          <td>
                            <StatusBadge status="passed" />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )}
      </QueryState>
    </div>
  );
}

export { ScanDetailPage as default };
