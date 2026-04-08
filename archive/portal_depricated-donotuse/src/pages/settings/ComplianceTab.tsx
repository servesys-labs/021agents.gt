import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Shield,
  Eye,
  Clock,
  Trash2,
  Download,
  KeyRound,
  RefreshCw,
  AlertTriangle,
  Info,
  Check,
} from "lucide-react";

import { useToast } from "../../components/common/ToastProvider";
import { Modal } from "../../components/common/Modal";
import { useAuth } from "../../lib/auth";
import { apiGet, apiPost, apiPut, apiDelete, useApiQuery } from "../../lib/api";

/* ══════════════════════════════════════════════════════════════════
   Types
   ══════════════════════════════════════════════════════════════════ */

type OrgSettings = {
  auto_redact_pii: boolean;
  immutable_audit: boolean;
};

type SessionSettings = {
  mfa_enforcement: "optional" | "admins" | "all";
  idle_timeout_minutes: number;
  max_session_age_hours: number;
};

type DeletionRequest = {
  id: string;
  user_id: string;
  reason: string;
  status: "pending" | "processing" | "completed" | "rejected";
  requested_at: string;
  completed_at?: string;
};

type DataExport = {
  id: string;
  status: "pending" | "processing" | "completed" | "expired";
  requested_at: string;
  completed_at?: string;
  download_url?: string;
  expires_at?: string;
};

type KeyRotation = {
  id: string;
  rotated_at: string;
  rotated_by: string;
  status: "completed" | "failed";
};

/* ══════════════════════════════════════════════════════════════════
   Helpers
   ══════════════════════════════════════════════════════════════════ */

function formatDate(value?: string | number | null): string {
  if (value == null || value === "") return "--";
  const ts = typeof value === "number" && value < 1e12 ? value * 1000 : value;
  return new Date(ts).toLocaleDateString();
}

function formatDateTime(value?: string | number | null): string {
  if (value == null || value === "") return "--";
  const ts = typeof value === "number" && value < 1e12 ? value * 1000 : value;
  const d = new Date(ts);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })}`;
}

function statusBadgeClass(status: string): string {
  switch (status) {
    case "completed":
      return "bg-status-live/10 text-status-live border-status-live/20";
    case "pending":
      return "bg-status-warning/10 text-status-warning border-status-warning/20";
    case "processing":
      return "bg-status-info/10 text-status-info border-status-info/20";
    case "expired":
    case "failed":
    case "rejected":
      return "bg-status-error/10 text-status-error border-status-error/20";
    default:
      return "bg-surface-overlay text-text-muted border-border-default";
  }
}

/* ══════════════════════════════════════════════════════════════════
   Toggle Switch
   ══════════════════════════════════════════════════════════════════ */

function Toggle({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-accent/50 focus:ring-offset-2 focus:ring-offset-surface-primary ${
        checked ? "bg-accent" : "bg-surface-overlay border border-border-default"
      } ${disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
    >
      <span
        className={`inline-block h-4 w-4 rounded-full bg-text-primary transition-transform ${
          checked ? "translate-x-6" : "translate-x-1"
        }`}
      />
    </button>
  );
}

/* ══════════════════════════════════════════════════════════════════
   Section Wrapper
   ══════════════════════════════════════════════════════════════════ */

function Section({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="card mb-4">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted flex items-center gap-2 mb-4">
        {icon}
        {title}
      </h3>
      {children}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════
   Main Component
   ══════════════════════════════════════════════════════════════════ */

export function ComplianceTab() {
  const { user } = useAuth();
  const toast = useToast();

  /* ── State ─────────────────────────────────────────────────────── */

  // Data Protection
  const [autoRedactPii, setAutoRedactPii] = useState(false);
  const [immutableAudit, setImmutableAudit] = useState(false);
  const [orgSettingsLoading, setOrgSettingsLoading] = useState(true);
  const [savingOrgSettings, setSavingOrgSettings] = useState(false);

  // MFA
  const [mfaEnforcement, setMfaEnforcement] = useState<"optional" | "admins" | "all">("optional");

  // Session Security
  const [idleTimeout, setIdleTimeout] = useState(30);
  const [maxSessionAge, setMaxSessionAge] = useState(24);
  const [sessionSettingsLoading, setSessionSettingsLoading] = useState(true);
  const [savingSessionSettings, setSavingSessionSettings] = useState(false);

  // Data Deletion
  const [deletionModalOpen, setDeletionModalOpen] = useState(false);
  const [deletionUserId, setDeletionUserId] = useState(user?.id ?? "");
  const [deletionReason, setDeletionReason] = useState("");
  const [deletionLoading, setDeletionLoading] = useState(false);

  // Data Export
  const [exportLoading, setExportLoading] = useState(false);

  // Key Rotation
  const [rotationModalOpen, setRotationModalOpen] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [rotationLoading, setRotationLoading] = useState(false);

  /* ── API Queries ───────────────────────────────────────────────── */

  const deletionRequestsQuery = useApiQuery<DeletionRequest[]>("/api/v1/compliance/deletion-requests");
  const dataExportsQuery = useApiQuery<DataExport[]>("/api/v1/compliance/data-export");
  const rotationsQuery = useApiQuery<KeyRotation[]>("/api/v1/secrets-rotation/rotations");

  const deletionRequests = useMemo<DeletionRequest[]>(
    () => Array.isArray(deletionRequestsQuery.data) ? deletionRequestsQuery.data : [],
    [deletionRequestsQuery.data],
  );
  const dataExports = useMemo<DataExport[]>(
    () => Array.isArray(dataExportsQuery.data) ? dataExportsQuery.data : [],
    [dataExportsQuery.data],
  );
  const rotations = useMemo<KeyRotation[]>(
    () => Array.isArray(rotationsQuery.data) ? rotationsQuery.data : [],
    [rotationsQuery.data],
  );

  /* ── Load org settings ─────────────────────────────────────────── */

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const data = await apiGet<OrgSettings>("/api/v1/orgs/settings");
        if (!cancelled && data) {
          setAutoRedactPii(data.auto_redact_pii ?? false);
          setImmutableAudit(data.immutable_audit ?? false);
        }
      } catch {
        // Settings may not exist yet
      } finally {
        if (!cancelled) setOrgSettingsLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, []);

  /* ── Load session settings ─────────────────────────────────────── */

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const data = await apiGet<SessionSettings>("/api/v1/session-management/settings");
        if (!cancelled && data) {
          setMfaEnforcement(data.mfa_enforcement ?? "optional");
          setIdleTimeout(data.idle_timeout_minutes ?? 30);
          setMaxSessionAge(data.max_session_age_hours ?? 24);
        }
      } catch {
        // Defaults will be used
      } finally {
        if (!cancelled) setSessionSettingsLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, []);

  /* ── Handlers ──────────────────────────────────────────────────── */

  const saveOrgSetting = useCallback(
    async (key: "auto_redact_pii" | "immutable_audit", value: boolean) => {
      setSavingOrgSettings(true);
      try {
        await apiPut("/api/v1/orgs/settings", { [key]: value });
        toast.success(`${key === "auto_redact_pii" ? "PII auto-redaction" : "Immutable audit mode"} ${value ? "enabled" : "disabled"}`);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to save setting");
        // Revert
        if (key === "auto_redact_pii") setAutoRedactPii(!value);
        else setImmutableAudit(!value);
      } finally {
        setSavingOrgSettings(false);
      }
    },
    [toast],
  );

  const handlePiiToggle = useCallback(
    (v: boolean) => {
      setAutoRedactPii(v);
      void saveOrgSetting("auto_redact_pii", v);
    },
    [saveOrgSetting],
  );

  const handleImmutableToggle = useCallback(
    (v: boolean) => {
      setImmutableAudit(v);
      void saveOrgSetting("immutable_audit", v);
    },
    [saveOrgSetting],
  );

  const saveMfaSetting = useCallback(
    async (value: "optional" | "admins" | "all") => {
      setMfaEnforcement(value);
      setSavingSessionSettings(true);
      try {
        await apiPut("/api/v1/session-management/settings", { mfa_enforcement: value });
        toast.success("MFA enforcement updated");
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to save MFA setting");
      } finally {
        setSavingSessionSettings(false);
      }
    },
    [toast],
  );

  const saveSessionSettings = useCallback(async () => {
    setSavingSessionSettings(true);
    try {
      await apiPut("/api/v1/session-management/settings", {
        idle_timeout_minutes: idleTimeout,
        max_session_age_hours: maxSessionAge,
      });
      toast.success("Session security settings saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save session settings");
    } finally {
      setSavingSessionSettings(false);
    }
  }, [idleTimeout, maxSessionAge, toast]);

  const handleDeletionRequest = useCallback(async () => {
    if (!deletionUserId.trim()) return;
    setDeletionLoading(true);
    try {
      await apiDelete(`/api/v1/compliance/account?user_id=${encodeURIComponent(deletionUserId)}&reason=${encodeURIComponent(deletionReason)}`);
      toast.success("Account deletion request submitted");
      setDeletionModalOpen(false);
      setDeletionReason("");
      void deletionRequestsQuery.refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to submit deletion request");
    } finally {
      setDeletionLoading(false);
    }
  }, [deletionUserId, deletionReason, toast, deletionRequestsQuery]);

  const handleDataExport = useCallback(async () => {
    setExportLoading(true);
    try {
      await apiPost("/api/v1/compliance/data-export");
      toast.success("Data export request submitted");
      void dataExportsQuery.refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to request data export");
    } finally {
      setExportLoading(false);
    }
  }, [toast, dataExportsQuery]);

  const handleKeyRotation = useCallback(async () => {
    if (!newKey.trim()) return;
    setRotationLoading(true);
    try {
      await apiPost("/api/v1/secrets-rotation/rotate", { new_key: newKey });
      toast.success("Encryption key rotated successfully");
      setRotationModalOpen(false);
      setNewKey("");
      void rotationsQuery.refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to rotate encryption key");
    } finally {
      setRotationLoading(false);
    }
  }, [newKey, toast, rotationsQuery]);

  /* ── Render ────────────────────────────────────────────────────── */

  if (orgSettingsLoading || sessionSettingsLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <RefreshCw size={16} className="animate-spin text-accent mr-2" />
        <span className="text-sm text-text-muted">Loading compliance settings...</span>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-text-primary">Compliance &amp; Data Protection</h2>
      </div>

      {/* ── 1. Data Protection ──────────────────────────────────────── */}
      <Section icon={<Eye size={14} />} title="Data Protection">
        <div className="space-y-4">
          {/* PII Auto-Redaction */}
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-text-primary">PII Auto-Redaction</p>
              <p className="text-xs text-text-muted mt-0.5">
                Automatically detect and redact personally identifiable information in agent logs and traces
              </p>
            </div>
            <div className="flex items-center gap-3">
              <span
                className={`inline-flex items-center px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide rounded-full border ${
                  autoRedactPii
                    ? "bg-status-live/10 text-status-live border-status-live/20"
                    : "bg-surface-overlay text-text-muted border-border-default"
                }`}
              >
                {autoRedactPii ? "Active" : "Inactive"}
              </span>
              <Toggle checked={autoRedactPii} onChange={handlePiiToggle} disabled={savingOrgSettings} />
            </div>
          </div>

          <div className="border-t border-border-default" />

          {/* Immutable Audit Mode */}
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-text-primary">Immutable Audit Mode</p>
              <p className="text-xs text-text-muted mt-0.5">
                Lock all audit logs to prevent deletion or modification
              </p>
            </div>
            <div className="flex items-center gap-3">
              <span
                className={`inline-flex items-center px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide rounded-full border ${
                  immutableAudit
                    ? "bg-status-live/10 text-status-live border-status-live/20"
                    : "bg-surface-overlay text-text-muted border-border-default"
                }`}
              >
                {immutableAudit ? "Locked" : "Mutable"}
              </span>
              <Toggle checked={immutableAudit} onChange={handleImmutableToggle} disabled={savingOrgSettings} />
            </div>
          </div>

          {/* Warning */}
          <div className="flex items-start gap-2 p-3 rounded-lg bg-status-warning/5 border border-status-warning/20">
            <AlertTriangle size={14} className="text-status-warning mt-0.5 shrink-0" />
            <p className="text-xs text-status-warning">
              Once enabled, audit logs cannot be deleted and will be archived to cold storage.
            </p>
          </div>
        </div>
      </Section>

      {/* ── 2. MFA Enforcement ──────────────────────────────────────── */}
      <Section icon={<Shield size={14} />} title="MFA Enforcement">
        <div className="space-y-3">
          {(["optional", "admins", "all"] as const).map((value) => {
            const labels: Record<string, string> = {
              optional: "Optional",
              admins: "Required for Admins",
              all: "Required for All",
            };
            return (
              <label
                key={value}
                className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                  mfaEnforcement === value
                    ? "border-accent/40 bg-accent/5"
                    : "border-border-default bg-surface-primary hover:border-border-strong"
                }`}
              >
                <input
                  type="radio"
                  name="mfa_enforcement"
                  value={value}
                  checked={mfaEnforcement === value}
                  onChange={() => void saveMfaSetting(value)}
                  disabled={savingSessionSettings}
                  className="accent-accent"
                />
                <span className="text-sm text-text-primary">{labels[value]}</span>
              </label>
            );
          })}

          <div className="flex items-start gap-2 p-3 rounded-lg bg-status-info/5 border border-status-info/20">
            <Info size={14} className="text-status-info mt-0.5 shrink-0" />
            <p className="text-xs text-status-info">
              MFA is enforced via Cloudflare Zero Trust. Users will be prompted for MFA on their next login.
            </p>
          </div>
        </div>
      </Section>

      {/* ── 3. Session Security ─────────────────────────────────────── */}
      <Section icon={<Clock size={14} />} title="Session Security">
        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1.5 uppercase tracking-wide">
                Idle Timeout (minutes)
              </label>
              <input
                type="number"
                min={1}
                max={480}
                value={idleTimeout}
                onChange={(e) => setIdleTimeout(Number(e.target.value) || 30)}
                className="text-sm w-full"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1.5 uppercase tracking-wide">
                Max Session Age (hours)
              </label>
              <input
                type="number"
                min={1}
                max={720}
                value={maxSessionAge}
                onChange={(e) => setMaxSessionAge(Number(e.target.value) || 24)}
                className="text-sm w-full"
              />
            </div>
          </div>
          <div className="flex justify-end">
            <button
              className="btn btn-primary text-xs"
              onClick={() => void saveSessionSettings()}
              disabled={savingSessionSettings}
            >
              {savingSessionSettings ? (
                <>
                  <RefreshCw size={12} className="animate-spin" /> Saving...
                </>
              ) : (
                <>
                  <Check size={12} /> Save Session Settings
                </>
              )}
            </button>
          </div>
        </div>
      </Section>

      {/* ── 4. Data Deletion (GDPR Art. 17) ─────────────────────────── */}
      <Section icon={<Trash2 size={14} />} title="Data Deletion (GDPR Art. 17)">
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-text-secondary">
              Submit a request to permanently delete all personal data associated with an account.
            </p>
            <button
              className="btn btn-primary text-xs shrink-0 ml-4"
              onClick={() => {
                setDeletionUserId(user?.id ?? "");
                setDeletionReason("");
                setDeletionModalOpen(true);
              }}
            >
              <Trash2 size={12} /> Request Account Deletion
            </button>
          </div>

          {/* Deletion history table */}
          {deletionRequestsQuery.loading ? (
            <div className="flex items-center justify-center py-6">
              <RefreshCw size={14} className="animate-spin text-accent mr-2" />
              <span className="text-xs text-text-muted">Loading requests...</span>
            </div>
          ) : deletionRequests.length === 0 ? (
            <p className="text-xs text-text-muted text-center py-4">No deletion requests</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border-default">
                    <th className="text-left py-2 px-2 text-text-muted font-medium uppercase tracking-wide">User ID</th>
                    <th className="text-left py-2 px-2 text-text-muted font-medium uppercase tracking-wide">Reason</th>
                    <th className="text-left py-2 px-2 text-text-muted font-medium uppercase tracking-wide">Status</th>
                    <th className="text-left py-2 px-2 text-text-muted font-medium uppercase tracking-wide">Requested</th>
                    <th className="text-left py-2 px-2 text-text-muted font-medium uppercase tracking-wide">Completed</th>
                  </tr>
                </thead>
                <tbody>
                  {deletionRequests.map((req) => (
                    <tr key={req.id} className="border-b border-border-default/50 hover:bg-surface-overlay/50">
                      <td className="py-2 px-2 font-mono text-text-primary">{req.user_id}</td>
                      <td className="py-2 px-2 text-text-secondary max-w-[200px] truncate">{req.reason || "--"}</td>
                      <td className="py-2 px-2">
                        <span className={`inline-flex items-center px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide rounded-full border ${statusBadgeClass(req.status)}`}>
                          {req.status}
                        </span>
                      </td>
                      <td className="py-2 px-2 text-text-muted">{formatDate(req.requested_at)}</td>
                      <td className="py-2 px-2 text-text-muted">{formatDate(req.completed_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Section>

      {/* ── 5. Data Export (GDPR Art. 20) ───────────────────────────── */}
      <Section icon={<Download size={14} />} title="Data Export (GDPR Art. 20)">
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-text-secondary">
              Request a portable copy of all your personal data in machine-readable format.
            </p>
            <button
              className="btn btn-primary text-xs shrink-0 ml-4"
              onClick={() => void handleDataExport()}
              disabled={exportLoading}
            >
              {exportLoading ? (
                <>
                  <RefreshCw size={12} className="animate-spin" /> Requesting...
                </>
              ) : (
                <>
                  <Download size={12} /> Request Data Export
                </>
              )}
            </button>
          </div>

          {/* Export history table */}
          {dataExportsQuery.loading ? (
            <div className="flex items-center justify-center py-6">
              <RefreshCw size={14} className="animate-spin text-accent mr-2" />
              <span className="text-xs text-text-muted">Loading exports...</span>
            </div>
          ) : dataExports.length === 0 ? (
            <p className="text-xs text-text-muted text-center py-4">No export requests</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border-default">
                    <th className="text-left py-2 px-2 text-text-muted font-medium uppercase tracking-wide">Status</th>
                    <th className="text-left py-2 px-2 text-text-muted font-medium uppercase tracking-wide">Requested</th>
                    <th className="text-left py-2 px-2 text-text-muted font-medium uppercase tracking-wide">Completed</th>
                    <th className="text-left py-2 px-2 text-text-muted font-medium uppercase tracking-wide">Expires</th>
                    <th className="text-left py-2 px-2 text-text-muted font-medium uppercase tracking-wide">Download</th>
                  </tr>
                </thead>
                <tbody>
                  {dataExports.map((exp) => (
                    <tr key={exp.id} className="border-b border-border-default/50 hover:bg-surface-overlay/50">
                      <td className="py-2 px-2">
                        <span className={`inline-flex items-center px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide rounded-full border ${statusBadgeClass(exp.status)}`}>
                          {exp.status}
                        </span>
                      </td>
                      <td className="py-2 px-2 text-text-muted">{formatDate(exp.requested_at)}</td>
                      <td className="py-2 px-2 text-text-muted">{formatDate(exp.completed_at)}</td>
                      <td className="py-2 px-2 text-text-muted">{formatDate(exp.expires_at)}</td>
                      <td className="py-2 px-2">
                        {exp.status === "completed" && exp.download_url ? (
                          <a
                            href={exp.download_url}
                            className="text-accent hover:underline flex items-center gap-1"
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            <Download size={10} /> Download
                          </a>
                        ) : (
                          <span className="text-text-muted">--</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Section>

      {/* ── 6. Secrets Key Rotation ─────────────────────────────────── */}
      <Section icon={<KeyRound size={14} />} title="Secrets Key Rotation">
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-text-secondary">
              Rotate the encryption key used to protect stored secrets. All secrets will be re-encrypted.
            </p>
            <button
              className="btn btn-primary text-xs shrink-0 ml-4"
              onClick={() => {
                setNewKey("");
                setRotationModalOpen(true);
              }}
            >
              <KeyRound size={12} /> Rotate Encryption Key
            </button>
          </div>

          {/* Rotation history */}
          {rotationsQuery.loading ? (
            <div className="flex items-center justify-center py-6">
              <RefreshCw size={14} className="animate-spin text-accent mr-2" />
              <span className="text-xs text-text-muted">Loading rotation history...</span>
            </div>
          ) : rotations.length === 0 ? (
            <p className="text-xs text-text-muted text-center py-4">No key rotations recorded</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border-default">
                    <th className="text-left py-2 px-2 text-text-muted font-medium uppercase tracking-wide">Rotated At</th>
                    <th className="text-left py-2 px-2 text-text-muted font-medium uppercase tracking-wide">Rotated By</th>
                    <th className="text-left py-2 px-2 text-text-muted font-medium uppercase tracking-wide">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rotations.map((rot) => (
                    <tr key={rot.id} className="border-b border-border-default/50 hover:bg-surface-overlay/50">
                      <td className="py-2 px-2 text-text-primary">{formatDateTime(rot.rotated_at)}</td>
                      <td className="py-2 px-2 text-text-secondary">{rot.rotated_by}</td>
                      <td className="py-2 px-2">
                        <span className={`inline-flex items-center px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide rounded-full border ${statusBadgeClass(rot.status)}`}>
                          {rot.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Section>

      {/* ── Deletion Modal ──────────────────────────────────────────── */}
      <Modal open={deletionModalOpen} onClose={() => setDeletionModalOpen(false)} title="Request Account Deletion" maxWidth="md">
        <div className="mb-4">
          <label className="block text-xs font-medium text-text-secondary mb-1.5 uppercase tracking-wide">
            User ID <span className="text-accent">*</span>
          </label>
          <input
            type="text"
            value={deletionUserId}
            onChange={(e) => setDeletionUserId(e.target.value)}
            placeholder="user-id"
            className="text-sm w-full"
          />
        </div>
        <div className="mb-4">
          <label className="block text-xs font-medium text-text-secondary mb-1.5 uppercase tracking-wide">
            Reason
          </label>
          <textarea
            value={deletionReason}
            onChange={(e) => setDeletionReason(e.target.value)}
            placeholder="Reason for account deletion request..."
            className="text-sm w-full"
            rows={3}
          />
        </div>

        <div className="flex items-start gap-2 p-3 rounded-lg bg-status-error/5 border border-status-error/20 mb-4">
          <AlertTriangle size={14} className="text-status-error mt-0.5 shrink-0" />
          <p className="text-xs text-status-error">
            This action is irreversible. All personal data associated with this account will be permanently deleted within 30 days.
          </p>
        </div>

        <div className="flex justify-end gap-2">
          <button className="btn btn-secondary text-xs" onClick={() => setDeletionModalOpen(false)}>
            Cancel
          </button>
          <button
            className="btn btn-primary text-xs bg-status-error hover:bg-status-error/80"
            disabled={!deletionUserId.trim() || deletionLoading}
            onClick={() => void handleDeletionRequest()}
          >
            {deletionLoading ? "Submitting..." : "Submit Deletion Request"}
          </button>
        </div>
      </Modal>

      {/* ── Key Rotation Modal ──────────────────────────────────────── */}
      <Modal open={rotationModalOpen} onClose={() => setRotationModalOpen(false)} title="Rotate Encryption Key" maxWidth="md">
        <div className="mb-4">
          <label className="block text-xs font-medium text-text-secondary mb-1.5 uppercase tracking-wide">
            New Encryption Key <span className="text-accent">*</span>
          </label>
          <input
            type="password"
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
            placeholder="Enter new encryption key"
            className="text-sm w-full"
            autoComplete="off"
          />
        </div>

        <div className="flex items-start gap-2 p-3 rounded-lg bg-status-warning/5 border border-status-warning/20 mb-4">
          <AlertTriangle size={14} className="text-status-warning mt-0.5 shrink-0" />
          <p className="text-xs text-status-warning">
            All stored secrets will be re-encrypted with the new key. This process may take several minutes for large secret stores.
          </p>
        </div>

        <div className="flex justify-end gap-2">
          <button className="btn btn-secondary text-xs" onClick={() => setRotationModalOpen(false)}>
            Cancel
          </button>
          <button
            className="btn btn-primary text-xs"
            disabled={!newKey.trim() || rotationLoading}
            onClick={() => void handleKeyRotation()}
          >
            {rotationLoading ? (
              <>
                <RefreshCw size={12} className="animate-spin" /> Rotating...
              </>
            ) : (
              <>
                <KeyRound size={12} /> Rotate Key
              </>
            )}
          </button>
        </div>
      </Modal>
    </div>
  );
}
