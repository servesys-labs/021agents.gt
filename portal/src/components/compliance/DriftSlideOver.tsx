import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Info,
  RotateCcw,
  Upload,
  X,
} from "lucide-react";

import { SlidePanel } from "../common/SlidePanel";
import { apiPost, apiPut } from "../../lib/api";

/* ── Types ──────────────────────────────────────────────────────── */

type DriftField = {
  field_path: string;
  severity: string;
  approved_value: unknown;
  current_value: unknown;
};

type DriftResponse = {
  agent_name: string;
  image_id: string;
  image_name?: string;
  image_version?: string;
  status: string;
  drifted_fields: DriftField[];
  gold_config?: Record<string, unknown>;
  current_config?: Record<string, unknown>;
};

interface DriftSlideOverProps {
  open: boolean;
  onClose: () => void;
  agentName: string;
  imageId: string;
  imageName: string;
}

/* ── Helpers ─────────────────────────────────────────────────────── */

function severityStyle(severity: string) {
  const s = severity?.toLowerCase() ?? "info";
  if (s === "critical" || s === "high") {
    return {
      emoji: "\uD83D\uDD34",
      bg: "bg-status-error/15",
      text: "text-status-error",
      border: "border-status-error/20",
      label: "CRITICAL",
    };
  }
  if (s === "warning" || s === "medium") {
    return {
      emoji: "\uD83D\uDFE1",
      bg: "bg-status-warning/15",
      text: "text-status-warning",
      border: "border-status-warning/20",
      label: "WARNING",
    };
  }
  return {
    emoji: "\u2139\uFE0F",
    bg: "bg-status-info/15",
    text: "text-status-info",
    border: "border-status-info/20",
    label: "INFO",
  };
}

function stringifyValue(val: unknown): string {
  if (val === null || val === undefined) return "null";
  if (typeof val === "string") return val;
  if (typeof val === "object") return JSON.stringify(val, null, 2);
  return String(val);
}

/* ── Drift Slide-Over ────────────────────────────────────────────── */

export function DriftSlideOver({
  open,
  onClose,
  agentName,
  imageId,
  imageName,
}: DriftSlideOverProps) {
  const [drift, setDrift] = useState<DriftResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [updating, setUpdating] = useState(false);

  /* Fetch drift details on open */
  useEffect(() => {
    if (!open || !agentName || !imageId) return;
    setLoading(true);
    setError(null);
    apiPost<DriftResponse>(
      `/api/v1/gold-images/drift/${encodeURIComponent(agentName)}/${encodeURIComponent(imageId)}`,
    )
      .then((result) => setDrift(result))
      .catch((err) =>
        setError(err instanceof Error ? err.message : "Failed to load drift details"),
      )
      .finally(() => setLoading(false));
  }, [open, agentName, imageId]);

  /* Restore agent to gold image config */
  const handleRestore = useCallback(async () => {
    if (!drift?.gold_config || restoring) return;
    setRestoring(true);
    try {
      await apiPut(`/api/v1/agents/${encodeURIComponent(agentName)}`, drift.gold_config);
      onClose();
    } catch {
      /* ignore - toast could be shown here */
    } finally {
      setRestoring(false);
    }
  }, [agentName, drift, restoring, onClose]);

  /* Update gold image to match current agent */
  const handleUpdateGoldImage = useCallback(async () => {
    if (!drift?.current_config || updating) return;
    setUpdating(true);
    try {
      await apiPut(
        `/api/v1/gold-images/${encodeURIComponent(imageId)}`,
        drift.current_config,
      );
      onClose();
    } catch {
      /* ignore */
    } finally {
      setUpdating(false);
    }
  }, [imageId, drift, updating, onClose]);

  const overallStatus = drift?.status?.toLowerCase() ?? "unknown";
  const statusColor =
    overallStatus === "critical"
      ? "text-status-error"
      : overallStatus === "drifted" || overallStatus === "warning"
        ? "text-status-warning"
        : "text-status-live";

  return (
    <SlidePanel
      open={open}
      onClose={onClose}
      title="Drift Details"
      subtitle={`${agentName} vs ${imageName}`}
      width="480px"
      footer={
        <div className="flex items-center gap-[var(--space-2)] w-full">
          <button
            onClick={handleRestore}
            disabled={restoring || !drift?.gold_config}
            className="btn btn-primary text-[var(--text-xs)] min-h-[var(--touch-target-min)] flex-1"
          >
            <RotateCcw size={14} />
            {restoring ? "Restoring..." : "Restore to Gold Image"}
          </button>
          <button
            onClick={handleUpdateGoldImage}
            disabled={updating || !drift?.current_config}
            className="btn btn-secondary text-[var(--text-xs)] min-h-[var(--touch-target-min)] flex-1"
          >
            <Upload size={14} />
            {updating ? "Updating..." : "Update Gold Image"}
          </button>
          <button
            onClick={onClose}
            className="btn btn-ghost text-[var(--text-xs)] min-h-[var(--touch-target-min)]"
          >
            Close
          </button>
        </div>
      }
    >
      {loading && (
        <div className="flex items-center justify-center py-[var(--space-12)] text-text-muted text-[var(--text-sm)]">
          Loading drift details...
        </div>
      )}

      {error && (
        <div className="card border-status-error/30 text-center py-[var(--space-6)]">
          <AlertTriangle size={20} className="text-status-error mx-auto mb-[var(--space-2)]" />
          <p className="text-[var(--text-sm)] text-status-error">{error}</p>
        </div>
      )}

      {drift && !loading && (
        <div className="space-y-[var(--space-4)]">
          {/* Header info */}
          <div className="space-y-[var(--space-2)]">
            <div className="flex items-center justify-between text-[var(--text-xs)]">
              <span className="text-text-muted">Agent</span>
              <span className="text-text-primary font-medium">{drift.agent_name}</span>
            </div>
            <div className="flex items-center justify-between text-[var(--text-xs)]">
              <span className="text-text-muted">Gold Image</span>
              <span className="text-text-secondary">
                {drift.image_name ?? imageName}
                {drift.image_version ? ` v${drift.image_version}` : ""}
              </span>
            </div>
            <div className="flex items-center justify-between text-[var(--text-xs)]">
              <span className="text-text-muted">Status</span>
              <span className={`font-semibold uppercase ${statusColor}`}>
                {drift.status}
              </span>
            </div>
          </div>

          {/* Drifted fields */}
          <div>
            <h4 className="text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-2)]">
              Drifted Fields ({drift.drifted_fields?.length ?? 0})
            </h4>

            {drift.drifted_fields?.length > 0 ? (
              <div className="space-y-[var(--space-2)]">
                {drift.drifted_fields.map((field, i) => {
                  const style = severityStyle(field.severity);
                  return (
                    <div
                      key={`${field.field_path}-${i}`}
                      className="rounded-lg border border-border-default overflow-hidden"
                    >
                      {/* Field header */}
                      <div className="flex items-center justify-between px-[var(--space-3)] py-[var(--space-2)] bg-surface-overlay">
                        <span className="text-[var(--text-xs)] font-mono text-text-primary">
                          {field.field_path}
                        </span>
                        <span
                          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide border ${style.bg} ${style.text} ${style.border}`}
                        >
                          {style.label}
                        </span>
                      </div>

                      {/* Values */}
                      <div className="px-[var(--space-3)] py-[var(--space-2)] space-y-[var(--space-2)]">
                        <div>
                          <span className="text-[10px] text-text-muted uppercase tracking-wide">
                            Approved
                          </span>
                          <pre className="text-[var(--text-xs)] font-mono text-status-live bg-status-live/5 rounded px-[var(--space-2)] py-[var(--space-1)] mt-[var(--space-1)] overflow-x-auto whitespace-pre-wrap break-all">
                            {stringifyValue(field.approved_value)}
                          </pre>
                        </div>
                        <div>
                          <span className="text-[10px] text-text-muted uppercase tracking-wide">
                            Current
                          </span>
                          <pre className="text-[var(--text-xs)] font-mono text-status-error bg-status-error/5 rounded px-[var(--space-2)] py-[var(--space-1)] mt-[var(--space-1)] overflow-x-auto whitespace-pre-wrap break-all">
                            {stringifyValue(field.current_value)}
                          </pre>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-[var(--text-sm)] text-text-muted">
                No drifted fields detected
              </p>
            )}
          </div>
        </div>
      )}
    </SlidePanel>
  );
}
