import { useCallback, useMemo, useState } from "react";
import {
  Plus,
  Key,
  Trash2,
  Copy,
  RefreshCw,
  AlertTriangle,
  Users,
  Activity,
  DollarSign,
  ExternalLink,
} from "lucide-react";

import { EmptyState } from "../../components/common/EmptyState";
import { ConfirmDialog } from "../../components/common/ConfirmDialog";
import { useToast } from "../../components/common/ToastProvider";
import { apiPost, apiDelete, useApiQuery } from "../../lib/api";
import { Modal } from "../../components/common/Modal";

/* ══════════════════════════════════════════════════════════════════
   Types
   ══════════════════════════════════════════════════════════════════ */

type EndUserToken = {
  token_id: string;
  end_user_id: string;
  token_prefix: string;
  allowed_agents: string[];
  rate_limit_rpm: number | null;
  rate_limit_rpd: number | null;
  expires_at?: string | number | null;
  created_at?: string | number;
};

type TokenUsageSummary = {
  total_active_tokens: number;
  total_end_users: number;
  total_usage_cost: number;
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

function formatCurrency(n: number): string {
  return "$" + n.toFixed(2);
}

function isExpired(expiresAt?: string | number | null): boolean {
  if (expiresAt == null) return false;
  const ts =
    typeof expiresAt === "number" && expiresAt < 1e12
      ? expiresAt * 1000
      : new Date(expiresAt).getTime();
  return ts < Date.now();
}

const EXPIRY_OPTIONS = [
  { label: "1 hour", seconds: 3600 },
  { label: "4 hours", seconds: 14400 },
  { label: "24 hours", seconds: 86400 },
  { label: "7 days", seconds: 604800 },
];

/* ══════════════════════════════════════════════════════════════════
   EndUserTokensTab
   ══════════════════════════════════════════════════════════════════ */

export function EndUserTokensTab() {
  const { showToast } = useToast();

  /* ── Data ─────────────────────────────────────────────────────── */

  const tokensQuery = useApiQuery<EndUserToken[] | { tokens: EndUserToken[]; summary?: TokenUsageSummary }>(
    "/api/v1/end-user-tokens",
    true,
  );

  const tokens = useMemo<EndUserToken[]>(() => {
    const raw = tokensQuery.data;
    if (Array.isArray(raw)) return raw;
    return raw?.tokens ?? [];
  }, [tokensQuery.data]);

  const summary = useMemo<TokenUsageSummary>(() => {
    const raw = tokensQuery.data;
    if (raw && !Array.isArray(raw) && raw.summary) return raw.summary;
    // Derive from token list
    const activeTokens = tokens.filter((t) => !isExpired(t.expires_at));
    const uniqueUsers = new Set(tokens.map((t) => t.end_user_id));
    return {
      total_active_tokens: activeTokens.length,
      total_end_users: uniqueUsers.size,
      total_usage_cost: 0,
    };
  }, [tokensQuery.data, tokens]);

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

  /* ── Mint modal state ─────────────────────────────────────────── */

  const [mintOpen, setMintOpen] = useState(false);
  const [mintForm, setMintForm] = useState({
    end_user_id: "",
    allowed_agents: "",
    expires_in_seconds: EXPIRY_OPTIONS[2].seconds, // 24h default
    rate_limit_rpm: 60,
    rate_limit_rpd: 1000,
  });
  const [mintLoading, setMintLoading] = useState(false);
  const [mintedToken, setMintedToken] = useState<string | null>(null);

  const openMintModal = () => {
    setMintedToken(null);
    setMintForm({
      end_user_id: "",
      allowed_agents: "",
      expires_in_seconds: EXPIRY_OPTIONS[2].seconds,
      rate_limit_rpm: 60,
      rate_limit_rpd: 1000,
    });
    setMintOpen(true);
  };

  const closeMintModal = () => {
    setMintOpen(false);
    setMintedToken(null);
  };

  /* ── Handlers ─────────────────────────────────────────────────── */

  const handleMint = async () => {
    if (!mintForm.end_user_id.trim()) return;
    setMintLoading(true);
    try {
      const agents = mintForm.allowed_agents
        .split(",")
        .map((a) => a.trim())
        .filter(Boolean);
      const result = await apiPost<{ token: string }>("/api/v1/end-user-tokens", {
        end_user_id: mintForm.end_user_id.trim(),
        allowed_agents: agents.length ? agents : undefined,
        expires_in_seconds: mintForm.expires_in_seconds,
        rate_limit_rpm: mintForm.rate_limit_rpm || undefined,
        rate_limit_rpd: mintForm.rate_limit_rpd || undefined,
      });
      setMintedToken(result.token);
      showToast("Token minted", "success");
      void tokensQuery.refetch();
    } catch {
      showToast("Failed to mint token", "error");
    } finally {
      setMintLoading(false);
    }
  };

  const handleRevoke = (t: EndUserToken) => {
    confirm(
      "Revoke Token",
      `Revoke token for end-user "${t.end_user_id}" (${t.token_prefix}...)? This cannot be undone.`,
      async () => {
        await apiDelete(`/api/v1/end-user-tokens/${t.token_id}`);
        showToast("Token revoked", "success");
        void tokensQuery.refetch();
      },
      { label: "Revoke", destructive: true },
    );
  };

  const copyToClipboard = (text: string) => {
    void navigator.clipboard.writeText(text);
    showToast("Copied to clipboard", "success");
  };

  /* ── Render ───────────────────────────────────────────────────── */

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-text-primary">End-User Tokens</h2>
        <button className="btn btn-primary text-xs" onClick={openMintModal}>
          <Key size={12} /> Mint Token
        </button>
      </div>

      {/* ── Summary cards ─────────────────────────────────────────── */}
      <div className="flex gap-3 mb-5 flex-wrap">
        <div className="card flex-1 min-w-[140px]">
          <div className="flex items-center gap-2 mb-1">
            <Key size={12} className="text-text-muted" />
            <p className="text-[10px] uppercase tracking-wide text-text-muted">Active Tokens</p>
          </div>
          <p className="text-lg font-bold text-text-primary font-mono">{summary.total_active_tokens}</p>
        </div>
        <div className="card flex-1 min-w-[140px]">
          <div className="flex items-center gap-2 mb-1">
            <Users size={12} className="text-text-muted" />
            <p className="text-[10px] uppercase tracking-wide text-text-muted">End Users</p>
          </div>
          <p className="text-lg font-bold text-text-primary font-mono">{summary.total_end_users}</p>
        </div>
        <div className="card flex-1 min-w-[140px]">
          <div className="flex items-center gap-2 mb-1">
            <DollarSign size={12} className="text-text-muted" />
            <p className="text-[10px] uppercase tracking-wide text-text-muted">Total Usage</p>
          </div>
          <p className="text-lg font-bold text-text-primary font-mono">{formatCurrency(summary.total_usage_cost)}</p>
        </div>
      </div>

      {/* ── Token list ────────────────────────────────────────────── */}
      {tokensQuery.loading ? (
        <div className="card flex items-center justify-center py-12">
          <RefreshCw size={16} className="animate-spin text-accent mr-2" />
          <span className="text-sm text-text-muted">Loading tokens...</span>
        </div>
      ) : tokensQuery.error ? (
        <div className="card border-status-error/30 text-center py-8">
          <p className="text-sm text-status-error">{tokensQuery.error}</p>
        </div>
      ) : tokens.length === 0 ? (
        <EmptyState
          icon={<Key size={40} />}
          title="No end-user tokens"
          description="Mint tokens to give your end-users scoped access to agents"
          action={
            <button className="btn btn-primary text-xs mt-2" onClick={openMintModal}>
              <Plus size={12} /> Mint First Token
            </button>
          }
        />
      ) : (
        <div className="space-y-2">
          {tokens.map((t) => {
            const expired = isExpired(t.expires_at);
            return (
              <div key={t.token_id} className="card card-hover py-3 px-4">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-medium text-text-primary">{t.end_user_id}</span>
                    <code className="text-xs font-mono text-text-muted">{t.token_prefix}...</code>
                    {expired && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-medium rounded-full bg-status-error/10 text-status-error border border-status-error/20">
                        Expired
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    <a
                      href={`?tab=end-user-tokens&usage=${encodeURIComponent(t.end_user_id)}`}
                      className="p-2 min-w-[var(--touch-target-min)] min-h-[var(--touch-target-min)] text-text-muted hover:text-accent hover:bg-surface-overlay rounded-md transition-colors flex items-center justify-center"
                      title="View usage"
                    >
                      <Activity size={14} />
                    </a>
                    <button
                      onClick={() => handleRevoke(t)}
                      className="p-2 min-w-[var(--touch-target-min)] min-h-[var(--touch-target-min)] text-text-muted hover:text-status-error hover:bg-status-error/10 rounded-md transition-colors flex items-center justify-center"
                      title="Revoke token"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
                <div className="flex items-center gap-4 flex-wrap">
                  {t.allowed_agents.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {t.allowed_agents.map((a) => (
                        <span
                          key={a}
                          className="inline-flex items-center px-2 py-0.5 text-[10px] font-medium rounded-full border border-border-subtle bg-surface-overlay text-text-muted"
                        >
                          {a}
                        </span>
                      ))}
                    </div>
                  )}
                  {(t.rate_limit_rpm || t.rate_limit_rpd) && (
                    <span className="text-[10px] text-text-muted">
                      {t.rate_limit_rpm ? `${t.rate_limit_rpm} RPM` : ""}
                      {t.rate_limit_rpm && t.rate_limit_rpd ? " / " : ""}
                      {t.rate_limit_rpd ? `${t.rate_limit_rpd} RPD` : ""}
                    </span>
                  )}
                  <span className="text-[10px] text-text-muted ml-auto whitespace-nowrap">
                    Expires {formatDate(t.expires_at)}
                  </span>
                  <span className="text-[10px] text-text-muted whitespace-nowrap">
                    Created {formatDate(t.created_at)}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Mint / Reveal modal ───────────────────────────────────── */}
      <Modal open={mintOpen} onClose={closeMintModal} title={mintedToken ? "Token Minted" : "Mint End-User Token"} maxWidth="md">
        {mintedToken ? (
          <div>
            <div className="rounded-lg border border-status-warning/30 bg-status-warning/10 p-3 mb-4">
              <p className="text-xs text-status-warning font-medium flex items-center gap-1.5">
                <AlertTriangle size={12} /> Copy this token now — it won't be shown again
              </p>
            </div>
            <div className="flex items-center gap-2 p-3 bg-surface-base border border-border-default rounded-lg">
              <code className="text-xs font-mono text-accent flex-1 break-all select-all">{mintedToken}</code>
              <button
                className="p-2 min-w-[var(--touch-target-min)] min-h-[var(--touch-target-min)] text-text-muted hover:text-accent transition-colors flex items-center justify-center"
                onClick={() => copyToClipboard(mintedToken)}
              >
                <Copy size={14} />
              </button>
            </div>
            <div className="flex justify-end mt-4">
              <button className="btn btn-primary text-xs" onClick={closeMintModal}>Done</button>
            </div>
          </div>
        ) : (
          <div>
            <div className="mb-4">
              <label className="block text-xs font-medium text-text-secondary mb-1.5 uppercase tracking-wide">
                End-User ID <span className="text-accent">*</span>
              </label>
              <input
                type="text"
                value={mintForm.end_user_id}
                onChange={(e) => setMintForm({ ...mintForm, end_user_id: e.target.value })}
                placeholder="user_abc123"
                className="text-sm font-mono"
              />
            </div>

            <div className="mb-4">
              <label className="block text-xs font-medium text-text-secondary mb-1.5 uppercase tracking-wide">
                Allowed Agents
              </label>
              <input
                type="text"
                value={mintForm.allowed_agents}
                onChange={(e) => setMintForm({ ...mintForm, allowed_agents: e.target.value })}
                placeholder="agent-a, agent-b (comma-separated, blank for all)"
                className="text-sm"
              />
              <p className="mt-1 text-[11px] text-text-muted">Leave blank to allow access to all agents</p>
            </div>

            <div className="mb-4">
              <label className="block text-xs font-medium text-text-secondary mb-1.5 uppercase tracking-wide">
                Expiry
              </label>
              <select
                value={mintForm.expires_in_seconds}
                onChange={(e) => setMintForm({ ...mintForm, expires_in_seconds: Number(e.target.value) })}
                className="text-sm"
              >
                {EXPIRY_OPTIONS.map((opt) => (
                  <option key={opt.seconds} value={opt.seconds}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="grid grid-cols-2 gap-3 mb-4">
              <div>
                <label className="block text-xs font-medium text-text-secondary mb-1.5 uppercase tracking-wide">
                  Rate Limit (RPM)
                </label>
                <input
                  type="number"
                  min={0}
                  value={mintForm.rate_limit_rpm}
                  onChange={(e) => setMintForm({ ...mintForm, rate_limit_rpm: Number(e.target.value) })}
                  placeholder="60"
                  className="text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-text-secondary mb-1.5 uppercase tracking-wide">
                  Rate Limit (RPD)
                </label>
                <input
                  type="number"
                  min={0}
                  value={mintForm.rate_limit_rpd}
                  onChange={(e) => setMintForm({ ...mintForm, rate_limit_rpd: Number(e.target.value) })}
                  placeholder="1000"
                  className="text-sm"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 mt-5">
              <button className="btn btn-secondary text-xs" onClick={closeMintModal}>
                Cancel
              </button>
              <button
                className="btn btn-primary text-xs"
                disabled={!mintForm.end_user_id.trim() || mintLoading}
                onClick={() => void handleMint()}
              >
                {mintLoading ? "Minting..." : "Mint Token"}
              </button>
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
