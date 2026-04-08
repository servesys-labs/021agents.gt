import { useCallback, useMemo, useState } from "react";
import {
  Plus,
  Globe,
  Trash2,
  Copy,
  RefreshCw,
  Check,
  AlertTriangle,
  Shield,
  ExternalLink,
} from "lucide-react";

import { EmptyState } from "../../components/common/EmptyState";
import { ConfirmDialog } from "../../components/common/ConfirmDialog";
import { useToast } from "../../components/common/ToastProvider";
import { apiGet, apiPost, apiDelete, useApiQuery } from "../../lib/api";
import { Modal } from "../../components/common/Modal";

/* ══════════════════════════════════════════════════════════════════
   Types
   ══════════════════════════════════════════════════════════════════ */

type Domain = {
  id: string;
  hostname: string;
  type: "subdomain" | "custom";
  status: "pending" | "active" | "failed";
  ssl_status?: "provisioning" | "active" | "error";
  cname_target?: string;
  verified_at?: string | null;
  created_at?: string;
};

/* ══════════════════════════════════════════════════════════════════
   Helpers
   ══════════════════════════════════════════════════════════════════ */

function formatDate(value?: string | number | null): string {
  if (value == null || value === "") return "--";
  const ts =
    typeof value === "number" && value < 1e12 ? value * 1000 : value;
  return new Date(ts).toLocaleDateString();
}

function statusBadgeClass(status: string): string {
  switch (status) {
    case "active":
      return "bg-status-live/10 text-status-live border-status-live/20";
    case "pending":
      return "bg-status-warning/10 text-status-warning border-status-warning/20";
    case "failed":
      return "bg-status-error/10 text-status-error border-status-error/20";
    default:
      return "bg-surface-overlay text-text-muted border-border-default";
  }
}

function sslBadgeClass(ssl?: string): string {
  switch (ssl) {
    case "active":
      return "text-status-live";
    case "provisioning":
      return "text-status-warning";
    case "error":
      return "text-status-error";
    default:
      return "text-text-muted";
  }
}

/* ══════════════════════════════════════════════════════════════════
   DomainsTab
   ══════════════════════════════════════════════════════════════════ */

export function DomainsTab() {
  const { showToast } = useToast();

  /* ── Data ─────────────────────────────────────────────────────── */

  const domainsQuery = useApiQuery<{ domains: Domain[] }>("/api/v1/domains", true);
  const domains = useMemo(() => domainsQuery.data?.domains ?? [], [domainsQuery.data]);

  /* ── Confirm dialog ───────────────────────────────────────────── */

  const [confirmState, setConfirmState] = useState<{
    open: boolean;
    title: string;
    message: string;
    confirmLabel: string;
    destructive: boolean;
    action: () => Promise<void>;
  }>({ open: false, title: "", message: "", confirmLabel: "Confirm", destructive: false, action: async () => {} });

  const confirm = useCallback(
    (title: string, message: string, action: () => Promise<void>, opts?: { label?: string; destructive?: boolean }) => {
      setConfirmState({
        open: true,
        title,
        message,
        confirmLabel: opts?.label ?? "Confirm",
        destructive: opts?.destructive ?? true,
        action,
      });
    },
    [],
  );

  const handleConfirm = async () => {
    try {
      await confirmState.action();
    } catch {
      showToast("Action failed", "error");
    }
    setConfirmState((s) => ({ ...s, open: false }));
  };

  /* ── Modal state ──────────────────────────────────────────────── */

  const [modalOpen, setModalOpen] = useState(false);
  const [domainType, setDomainType] = useState<"subdomain" | "custom">("subdomain");
  const [customHostname, setCustomHostname] = useState("");
  const [saving, setSaving] = useState(false);

  const [dnsInfoDomain, setDnsInfoDomain] = useState<Domain | null>(null);

  const openAddModal = () => {
    setDomainType("subdomain");
    setCustomHostname("");
    setModalOpen(true);
  };

  /* ── Handlers ─────────────────────────────────────────────────── */

  const handleAdd = async () => {
    if (domainType === "custom" && !customHostname.trim()) return;
    setSaving(true);
    try {
      const body =
        domainType === "subdomain"
          ? { type: "subdomain" as const, hostname: "" }
          : { type: "custom" as const, hostname: customHostname.trim().toLowerCase() };
      await apiPost("/api/v1/domains", body);
      showToast("Domain added", "success");
      setModalOpen(false);
      void domainsQuery.refetch();
    } catch {
      showToast("Failed to add domain", "error");
    } finally {
      setSaving(false);
    }
  };

  const handleVerify = async (domain: Domain) => {
    try {
      await apiPost(`/api/v1/domains/${domain.id}/verify`);
      showToast("Verification started", "success");
      void domainsQuery.refetch();
    } catch {
      showToast("Verification failed", "error");
    }
  };

  const handleDelete = (domain: Domain) => {
    confirm(
      "Delete Domain",
      `Remove "${domain.hostname}"? This cannot be undone.`,
      async () => {
        await apiDelete(`/api/v1/domains/${domain.id}`);
        showToast("Domain removed", "success");
        void domainsQuery.refetch();
      },
      { label: "Delete", destructive: true },
    );
  };

  const copyToClipboard = (text: string) => {
    void navigator.clipboard.writeText(text);
    showToast("Copied to clipboard", "success");
  };

  const isValidHostname = (h: string) =>
    /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(h.trim());

  /* ── Render ───────────────────────────────────────────────────── */

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-text-primary">Custom Domains</h2>
        <button className="btn btn-primary text-xs" onClick={openAddModal}>
          <Plus size={12} /> Add Domain
        </button>
      </div>

      {domainsQuery.loading ? (
        <div className="card flex items-center justify-center py-12">
          <RefreshCw size={16} className="animate-spin text-accent mr-2" />
          <span className="text-sm text-text-muted">Loading domains...</span>
        </div>
      ) : domainsQuery.error ? (
        <div className="card border-status-error/30 text-center py-8">
          <p className="text-sm text-status-error">{domainsQuery.error}</p>
        </div>
      ) : domains.length === 0 ? (
        <EmptyState
          icon={<Globe size={40} />}
          title="No domains configured"
          description="Add a custom domain or auto-generate a subdomain for your agents"
          action={
            <button className="btn btn-primary text-xs mt-2" onClick={openAddModal}>
              <Plus size={12} /> Add Domain
            </button>
          }
        />
      ) : (
        <div className="space-y-2">
          {domains.map((d) => (
            <div key={d.id} className="card card-hover py-3 px-4">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-3">
                  <Globe size={14} className="text-text-muted flex-shrink-0" />
                  <span className="text-sm font-medium text-text-primary font-mono">{d.hostname}</span>
                  <span
                    className={`inline-flex items-center px-2 py-0.5 text-[10px] font-medium rounded-full border ${statusBadgeClass(d.status)}`}
                  >
                    {d.status}
                  </span>
                  <span
                    className={`inline-flex items-center px-2 py-0.5 text-[10px] font-medium rounded-full border border-border-subtle bg-surface-overlay text-text-muted`}
                  >
                    {d.type === "subdomain" ? "auto" : "custom"}
                  </span>
                </div>
                <div className="flex items-center gap-1">
                  {d.type === "custom" && d.status !== "active" && (
                    <button
                      onClick={() => void handleVerify(d)}
                      className="px-2.5 py-1 text-[10px] font-medium rounded border bg-surface-overlay text-text-secondary border-border-default hover:border-border-strong transition-colors min-h-[var(--touch-target-min)]"
                    >
                      Verify
                    </button>
                  )}
                  {d.type === "custom" && (
                    <button
                      onClick={() => setDnsInfoDomain(d)}
                      className="p-2 min-w-[var(--touch-target-min)] min-h-[var(--touch-target-min)] text-text-muted hover:text-accent hover:bg-surface-overlay rounded-md transition-colors flex items-center justify-center"
                      title="DNS instructions"
                    >
                      <ExternalLink size={14} />
                    </button>
                  )}
                  <button
                    onClick={() => handleDelete(d)}
                    className="p-2 min-w-[var(--touch-target-min)] min-h-[var(--touch-target-min)] text-text-muted hover:text-status-error hover:bg-status-error/10 rounded-md transition-colors flex items-center justify-center"
                    title="Delete domain"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
              <div className="flex items-center gap-4">
                <div className="flex items-center gap-1.5">
                  <Shield size={10} className={sslBadgeClass(d.ssl_status)} />
                  <span className={`text-[10px] font-medium ${sslBadgeClass(d.ssl_status)}`}>
                    SSL: {d.ssl_status ?? "none"}
                  </span>
                </div>
                <span className="text-[10px] text-text-muted ml-auto whitespace-nowrap">
                  Verified {d.verified_at ? formatDate(d.verified_at) : "never"}
                </span>
                <span className="text-[10px] text-text-muted whitespace-nowrap">
                  Added {formatDate(d.created_at)}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Add Domain modal ──────────────────────────────────────── */}
      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Add Domain" maxWidth="md">
        <div className="mb-4">
          <label className="block text-xs font-medium text-text-secondary mb-1.5 uppercase tracking-wide">
            Type
          </label>
          <div className="grid grid-cols-2 gap-2">
            {(["subdomain", "custom"] as const).map((t) => {
              const selected = domainType === t;
              return (
                <button
                  key={t}
                  onClick={() => setDomainType(t)}
                  className={`flex flex-col items-start px-3 py-2.5 rounded border text-xs transition-colors ${
                    selected
                      ? "bg-accent-muted border-accent/30 text-accent"
                      : "bg-surface-base border-border-default text-text-secondary hover:border-border-strong"
                  }`}
                >
                  <span className="font-medium">{t === "subdomain" ? "Auto subdomain" : "Custom domain"}</span>
                  <span className="text-[10px] mt-0.5 text-text-muted">
                    {t === "subdomain" ? "yourorg.agentos.dev" : "agents.yourdomain.com"}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {domainType === "subdomain" ? (
          <div className="rounded-lg border border-border-default bg-surface-base p-3 mb-4">
            <p className="text-xs text-text-secondary">
              A subdomain will be automatically provisioned:
            </p>
            <p className="text-sm font-mono text-accent mt-1">
              {"<your-org>"}.agentos.dev
            </p>
          </div>
        ) : (
          <div className="mb-4">
            <label className="block text-xs font-medium text-text-secondary mb-1.5 uppercase tracking-wide">
              Hostname <span className="text-accent">*</span>
            </label>
            <input
              type="text"
              value={customHostname}
              onChange={(e) => setCustomHostname(e.target.value)}
              placeholder="agents.yourdomain.com"
              className="text-sm font-mono"
            />
            {customHostname.trim() && !isValidHostname(customHostname) && (
              <p className="mt-1 text-[11px] text-status-error">Enter a valid hostname</p>
            )}
          </div>
        )}

        {domainType === "custom" && (
          <div className="rounded-lg border border-status-info/30 bg-status-info/5 p-3 mb-4">
            <p className="text-xs text-status-info font-medium mb-1">DNS Configuration Required</p>
            <p className="text-[11px] text-text-muted">
              After adding, create a CNAME record pointing your hostname to{" "}
              <code className="text-accent font-mono">proxy.agentos.dev</code>.
            </p>
          </div>
        )}

        <div className="flex justify-end gap-2 mt-5">
          <button className="btn btn-secondary text-xs" onClick={() => setModalOpen(false)}>
            Cancel
          </button>
          <button
            className="btn btn-primary text-xs"
            disabled={saving || (domainType === "custom" && !isValidHostname(customHostname))}
            onClick={() => void handleAdd()}
          >
            {saving ? "Adding..." : "Add Domain"}
          </button>
        </div>
      </Modal>

      {/* ── DNS Instructions modal ────────────────────────────────── */}
      <Modal
        open={!!dnsInfoDomain}
        onClose={() => setDnsInfoDomain(null)}
        title="DNS Configuration"
        maxWidth="md"
      >
        {dnsInfoDomain && (
          <div>
            <p className="text-xs text-text-secondary mb-3">
              Add the following CNAME record to your DNS provider for{" "}
              <span className="font-mono text-accent">{dnsInfoDomain.hostname}</span>:
            </p>
            <div className="rounded-lg border border-border-default bg-surface-base p-3 mb-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] uppercase tracking-wide text-text-muted">Type</span>
                <span className="text-xs font-mono text-text-primary">CNAME</span>
              </div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] uppercase tracking-wide text-text-muted">Name</span>
                <span className="text-xs font-mono text-text-primary">{dnsInfoDomain.hostname}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[10px] uppercase tracking-wide text-text-muted">Target</span>
                <div className="flex items-center gap-1.5">
                  <span className="text-xs font-mono text-accent">
                    {dnsInfoDomain.cname_target || "proxy.agentos.dev"}
                  </span>
                  <button
                    className="p-1 text-text-muted hover:text-accent transition-colors"
                    onClick={() => copyToClipboard(dnsInfoDomain.cname_target || "proxy.agentos.dev")}
                  >
                    <Copy size={12} />
                  </button>
                </div>
              </div>
            </div>
            <div className="rounded-lg border border-status-warning/30 bg-status-warning/10 p-3 mb-4">
              <p className="text-xs text-status-warning font-medium flex items-center gap-1.5">
                <AlertTriangle size={12} /> DNS changes can take up to 48 hours to propagate
              </p>
            </div>
            <div className="flex justify-end">
              <button className="btn btn-primary text-xs" onClick={() => setDnsInfoDomain(null)}>Done</button>
            </div>
          </div>
        )}
      </Modal>

      {/* ── Confirm dialog ────────────────────────────────────────── */}
      <ConfirmDialog
        open={confirmState.open}
        title={confirmState.title}
        message={confirmState.message}
        confirmLabel={confirmState.confirmLabel}
        destructive={confirmState.destructive}
        onConfirm={() => void handleConfirm()}
        onCancel={() => setConfirmState((s) => ({ ...s, open: false }))}
      />
    </div>
  );
}
