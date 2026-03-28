import { useMemo, useState } from "react";
import {
  Key,
  Trash2,
  Copy,
  RefreshCw,
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Shield,
  Globe,
  Gauge,
  Activity,
} from "lucide-react";

import { EmptyState } from "../../components/common/EmptyState";
import { Modal } from "../../components/common/Modal";
import { useToast } from "../../components/common/ToastProvider";
import { apiPost, apiDelete, useApiQuery } from "../../lib/api";

/* ══════════════════════════════════════════════════════════════════
   Types
   ══════════════════════════════════════════════════════════════════ */

type BackendApiKey = {
  key_id: string;
  name: string;
  key_prefix?: string;
  prefix?: string;
  scopes?: string[];
  created_at?: string | number | null;
  last_used?: string | number | null;
  last_used_at?: string | number | null;
  expires_at?: string | number | null;
  ip_allowlist?: string[];
  allowed_agents?: string[];
  rate_limit_rpm?: number;
  rate_limit_rpd?: number;
  request_count?: number;
};

type ApiKeyItem = {
  key_id: string;
  name: string;
  prefix: string;
  scopes: string[];
  created_at?: string | number;
  last_used?: string | number;
  expires_at?: string | number;
  ip_allowlist: string[];
  allowed_agents: string[];
  rate_limit_rpm: number;
  rate_limit_rpd: number;
  request_count: number;
};

type Agent = { name: string };

/* ══════════════════════════════════════════════════════════════════
   Helpers
   ══════════════════════════════════════════════════════════════════ */

function formatDate(value?: string | number | null): string {
  if (value == null || value === "") return "--";
  const ts =
    typeof value === "number" && value < 1e12 ? value * 1000 : value;
  return new Date(ts).toLocaleDateString();
}

function relativeTime(value?: string | number | null): string {
  if (value == null || value === "") return "never";
  const ts =
    typeof value === "number" && value < 1e12 ? value * 1000 : value;
  const diff = Date.now() - new Date(ts).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return formatDate(value);
}

function daysUntil(value?: string | number): number | null {
  if (value == null || value === "") return null;
  const ts =
    typeof value === "number" && value < 1e12 ? value * 1000 : value;
  const diff = new Date(ts).getTime() - Date.now();
  return Math.ceil(diff / 86400000);
}

/* ── Scope definitions ─────────────────────────────────────────── */

const ALL_SCOPES = [
  "agents:read",
  "agents:write",
  "agents:run",
  "sessions:read",
  "eval:run",
  "billing:read",
  "memory:read",
  "memory:write",
  "tools:read",
  "webhooks:read",
  "webhooks:write",
  "deploy:write",
  "admin",
  "*",
] as const;

/* ── Shared inline components ──────────────────────────────────── */

function Pill({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 text-[10px] font-medium rounded-full border border-border-subtle bg-surface-overlay text-text-muted ${className}`}
    >
      {children}
    </span>
  );
}

/* ══════════════════════════════════════════════════════════════════
   ApiKeysEnhanced
   ══════════════════════════════════════════════════════════════════ */

export function ApiKeysEnhanced() {
  const { showToast } = useToast();

  /* ── Confirm dialog (local) ──────────────────────────────────── */
  const [confirmState, setConfirmState] = useState<{
    open: boolean;
    title: string;
    message: string;
    confirmLabel: string;
    destructive: boolean;
    action: () => Promise<void>;
  }>({ open: false, title: "", message: "", confirmLabel: "Confirm", destructive: false, action: async () => {} });

  const confirm = (
    title: string,
    message: string,
    action: () => Promise<void>,
    opts?: { label?: string; destructive?: boolean },
  ) => {
    setConfirmState({
      open: true,
      title,
      message,
      confirmLabel: opts?.label ?? "Confirm",
      destructive: opts?.destructive ?? false,
      action,
    });
  };

  const [confirmLoading, setConfirmLoading] = useState(false);
  const handleConfirm = async () => {
    setConfirmLoading(true);
    try {
      await confirmState.action();
    } catch {
      showToast("Action failed", "error");
    } finally {
      setConfirmLoading(false);
      setConfirmState((s) => ({ ...s, open: false }));
    }
  };

  /* ── Data queries ────────────────────────────────────────────── */
  const keysQuery = useApiQuery<{ keys: BackendApiKey[] } | BackendApiKey[]>("/api/v1/api-keys", true);
  const agentsQuery = useApiQuery<{ agents: Agent[] } | Agent[]>("/api/v1/agents", true);

  const agents = useMemo<Agent[]>(() => {
    const raw = agentsQuery.data;
    return Array.isArray(raw) ? raw : (raw as { agents: Agent[] } | null)?.agents ?? [];
  }, [agentsQuery.data]);

  const keys = useMemo<ApiKeyItem[]>(() => {
    const raw = keysQuery.data;
    const rows = Array.isArray(raw) ? raw : raw?.keys ?? [];
    return rows.map((k) => ({
      key_id: String(k.key_id ?? ""),
      name: String(k.name ?? ""),
      prefix: String(k.prefix ?? k.key_prefix ?? ""),
      scopes: Array.isArray(k.scopes) ? k.scopes : [],
      created_at: k.created_at ?? undefined,
      last_used: k.last_used ?? k.last_used_at ?? undefined,
      expires_at: k.expires_at ?? undefined,
      ip_allowlist: Array.isArray(k.ip_allowlist) ? k.ip_allowlist : [],
      allowed_agents: Array.isArray(k.allowed_agents) ? k.allowed_agents : [],
      rate_limit_rpm: k.rate_limit_rpm ?? 60,
      rate_limit_rpd: k.rate_limit_rpd ?? 10000,
      request_count: k.request_count ?? 0,
    }));
  }, [keysQuery.data]);

  /* ── Modal state ─────────────────────────────────────────────── */
  const [createKeyOpen, setCreateKeyOpen] = useState(false);
  const [keyName, setKeyName] = useState("");
  const [keyScopes, setKeyScopes] = useState<string[]>([]);
  const [keyExpiry, setKeyExpiry] = useState("none");
  const [keyIpAllowlist, setKeyIpAllowlist] = useState("");
  const [keyAllowedAgents, setKeyAllowedAgents] = useState<string[]>([]);
  const [keyRpm, setKeyRpm] = useState(60);
  const [keyRpd, setKeyRpd] = useState(10000);
  const [createdKeyValue, setCreatedKeyValue] = useState<string | null>(null);
  const [keyLoading, setKeyLoading] = useState(false);

  /* ── Expanded rows ───────────────────────────────────────────── */
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());

  const toggleExpand = (keyId: string) => {
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(keyId)) next.delete(keyId);
      else next.add(keyId);
      return next;
    });
  };

  /* ── Scope toggle ────────────────────────────────────────────── */
  const toggleScope = (scope: string) => {
    if (scope === "*") {
      setKeyScopes(keyScopes.includes("*") ? [] : ["*"]);
    } else {
      setKeyScopes((prev) =>
        prev.includes(scope)
          ? prev.filter((s) => s !== scope)
          : [...prev.filter((s) => s !== "*"), scope],
      );
    }
  };

  /* ── Agent toggle ────────────────────────────────────────────── */
  const toggleAgent = (agentName: string) => {
    setKeyAllowedAgents((prev) =>
      prev.includes(agentName)
        ? prev.filter((a) => a !== agentName)
        : [...prev, agentName],
    );
  };

  /* ── Handlers ────────────────────────────────────────────────── */
  const handleCreateKey = async () => {
    if (!keyName.trim()) return;
    setKeyLoading(true);
    try {
      const ipList = keyIpAllowlist
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      const result = await apiPost<{ key: string }>("/api/v1/api-keys", {
        name: keyName,
        scopes: keyScopes.length ? keyScopes : ["*"],
        expires_in_days: keyExpiry === "none" ? null : parseInt(keyExpiry),
        ip_allowlist: ipList.length ? ipList : [],
        allowed_agents: keyAllowedAgents.length ? keyAllowedAgents : [],
        rate_limit_rpm: keyRpm,
        rate_limit_rpd: keyRpd,
      });
      setCreatedKeyValue(result.key);
      showToast("API key created", "success");
      void keysQuery.refetch();
    } catch {
      showToast("Failed to create key", "error");
    } finally {
      setKeyLoading(false);
    }
  };

  const handleRotateKey = (k: ApiKeyItem) => {
    confirm(
      "Rotate API Key",
      `Rotate "${k.name}" (${k.prefix}...)? The old key will stop working immediately.`,
      async () => {
        const result = await apiPost<{ key: string }>(`/api/v1/api-keys/${k.key_id}/rotate`);
        setCreatedKeyValue(result.key);
        setCreateKeyOpen(true);
        showToast("Key rotated — copy the new value now", "success");
        void keysQuery.refetch();
      },
      { label: "Rotate", destructive: false },
    );
  };

  const handleRevokeKey = (k: ApiKeyItem) => {
    confirm(
      "Revoke API Key",
      `Revoke "${k.name}" (${k.prefix}...)? This cannot be undone.`,
      async () => {
        await apiDelete(`/api/v1/api-keys/${k.key_id}`);
        showToast("Key revoked", "success");
        void keysQuery.refetch();
      },
      { label: "Revoke", destructive: true },
    );
  };

  const closeKeyModal = () => {
    setCreateKeyOpen(false);
    setKeyName("");
    setKeyScopes([]);
    setKeyExpiry("none");
    setKeyIpAllowlist("");
    setKeyAllowedAgents([]);
    setKeyRpm(60);
    setKeyRpd(10000);
    setCreatedKeyValue(null);
  };

  const copyToClipboard = (text: string) => {
    void navigator.clipboard.writeText(text);
    showToast("Copied to clipboard", "success");
  };

  /* ── Render ──────────────────────────────────────────────────── */
  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-text-primary">API Keys</h2>
        <button
          className="btn btn-primary text-xs"
          onClick={() => {
            setCreatedKeyValue(null);
            setKeyName("");
            setKeyScopes([]);
            setKeyExpiry("none");
            setKeyIpAllowlist("");
            setKeyAllowedAgents([]);
            setKeyRpm(60);
            setKeyRpd(10000);
            setCreateKeyOpen(true);
          }}
        >
          <Key size={12} /> Create Key
        </button>
      </div>

      {keysQuery.loading ? (
        <div className="card flex items-center justify-center py-12">
          <RefreshCw size={16} className="animate-spin text-accent mr-2" />
          <span className="text-sm text-text-muted">Loading keys...</span>
        </div>
      ) : keysQuery.error ? (
        <div className="card border-status-error/30 text-center py-8">
          <p className="text-sm text-status-error">{keysQuery.error}</p>
        </div>
      ) : keys.length === 0 ? (
        <EmptyState
          icon={<Key size={40} />}
          title="No API keys"
          description="Create an API key to access the platform programmatically"
        />
      ) : (
        <div className="space-y-2">
          {keys.map((k) => {
            const expDays = daysUntil(k.expires_at);
            const expiring = expDays !== null && expDays > 0 && expDays <= 7;
            const isExpanded = expandedKeys.has(k.key_id);

            return (
              <div key={k.key_id} className="card card-hover py-3 px-4">
                {/* Row header */}
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => toggleExpand(k.key_id)}
                      className="p-1 text-text-muted hover:text-text-primary transition-colors"
                      aria-label={isExpanded ? "Collapse details" : "Expand details"}
                    >
                      {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    </button>
                    <span className="text-sm font-medium text-text-primary">{k.name}</span>
                    <code className="text-xs font-mono text-text-muted">{k.prefix}...</code>
                    {expiring && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-medium rounded-full bg-status-warning/10 text-status-warning border border-status-warning/20">
                        <AlertTriangle size={10} /> Expires in {expDays}d
                      </span>
                    )}
                    {k.request_count > 0 && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-medium rounded-full bg-accent-muted text-accent border border-accent/20">
                        <Activity size={10} /> {k.request_count.toLocaleString()} reqs
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => handleRotateKey(k)}
                      className="p-2 min-w-[var(--touch-target-min)] min-h-[var(--touch-target-min)] text-text-muted hover:text-accent hover:bg-surface-overlay rounded-md transition-colors flex items-center justify-center"
                      title="Rotate key"
                    >
                      <RefreshCw size={14} />
                    </button>
                    <button
                      onClick={() => handleRevokeKey(k)}
                      className="p-2 min-w-[var(--touch-target-min)] min-h-[var(--touch-target-min)] text-text-muted hover:text-status-error hover:bg-status-error/10 rounded-md transition-colors flex items-center justify-center"
                      title="Revoke key"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>

                {/* Summary row */}
                <div className="flex items-center gap-4">
                  <div className="flex flex-wrap gap-1">
                    {(k.scopes ?? []).map((s) => (
                      <Pill key={s}>{s}</Pill>
                    ))}
                  </div>
                  <span className="text-[10px] text-text-muted ml-auto whitespace-nowrap">
                    Created {formatDate(k.created_at)}
                  </span>
                  <span className="text-[10px] text-text-muted whitespace-nowrap">
                    Last used {relativeTime(k.last_used)}
                  </span>
                </div>

                {/* Expanded detail panel */}
                {isExpanded && (
                  <div className="mt-3 pt-3 border-t border-border-subtle">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {/* IP Allowlist */}
                      <div>
                        <div className="flex items-center gap-1.5 mb-1.5">
                          <Globe size={12} className="text-text-muted" />
                          <span className="text-[10px] font-medium text-text-secondary uppercase tracking-wide">
                            IP Allowlist
                          </span>
                        </div>
                        {k.ip_allowlist.length > 0 ? (
                          <div className="flex flex-wrap gap-1">
                            {k.ip_allowlist.map((ip) => (
                              <Pill key={ip}>{ip}</Pill>
                            ))}
                          </div>
                        ) : (
                          <span className="text-[10px] text-text-muted">All IPs allowed</span>
                        )}
                      </div>

                      {/* Allowed Agents */}
                      <div>
                        <div className="flex items-center gap-1.5 mb-1.5">
                          <Shield size={12} className="text-text-muted" />
                          <span className="text-[10px] font-medium text-text-secondary uppercase tracking-wide">
                            Allowed Agents
                          </span>
                        </div>
                        {k.allowed_agents.length > 0 ? (
                          <div className="flex flex-wrap gap-1">
                            {k.allowed_agents.map((a) => (
                              <Pill key={a}>{a}</Pill>
                            ))}
                          </div>
                        ) : (
                          <span className="text-[10px] text-text-muted">All agents</span>
                        )}
                      </div>

                      {/* Rate Limits */}
                      <div>
                        <div className="flex items-center gap-1.5 mb-1.5">
                          <Gauge size={12} className="text-text-muted" />
                          <span className="text-[10px] font-medium text-text-secondary uppercase tracking-wide">
                            Rate Limits
                          </span>
                        </div>
                        <div className="flex gap-3">
                          <span className="text-xs text-text-secondary">
                            <span className="font-mono font-medium text-text-primary">{k.rate_limit_rpm.toLocaleString()}</span> RPM
                          </span>
                          <span className="text-xs text-text-secondary">
                            <span className="font-mono font-medium text-text-primary">{k.rate_limit_rpd.toLocaleString()}</span> RPD
                          </span>
                        </div>
                      </div>

                      {/* Usage Stats */}
                      <div>
                        <div className="flex items-center gap-1.5 mb-1.5">
                          <Activity size={12} className="text-text-muted" />
                          <span className="text-[10px] font-medium text-text-secondary uppercase tracking-wide">
                            Usage
                          </span>
                        </div>
                        <div className="flex gap-3">
                          <span className="text-xs text-text-secondary">
                            <span className="font-mono font-medium text-text-primary">{k.request_count.toLocaleString()}</span> total requests
                          </span>
                          <span className="text-xs text-text-muted">
                            Last used {relativeTime(k.last_used)}
                          </span>
                        </div>
                      </div>

                      {/* Scopes (full list) */}
                      <div className="md:col-span-2">
                        <div className="flex items-center gap-1.5 mb-1.5">
                          <Key size={12} className="text-text-muted" />
                          <span className="text-[10px] font-medium text-text-secondary uppercase tracking-wide">
                            Scopes
                          </span>
                        </div>
                        <div className="flex flex-wrap gap-1">
                          {k.scopes.map((s) => (
                            <Pill key={s}>{s}</Pill>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ── Create / Reveal modal ──────────────────────────────── */}
      <Modal open={createKeyOpen} onClose={closeKeyModal} title={createdKeyValue ? "Key Created" : "Create API Key"} maxWidth="md">
        {createdKeyValue ? (
          <div>
            <div className="rounded-lg border border-status-warning/30 bg-status-warning/10 p-3 mb-4">
              <p className="text-xs text-status-warning font-medium flex items-center gap-1.5">
                <AlertTriangle size={12} /> Copy this key now — it won't be shown again
              </p>
            </div>
            <div className="flex items-center gap-2 p-3 bg-surface-base border border-border-default rounded-lg">
              <code className="text-xs font-mono text-accent flex-1 break-all select-all">{createdKeyValue}</code>
              <button
                className="p-2 min-w-[var(--touch-target-min)] min-h-[var(--touch-target-min)] text-text-muted hover:text-accent transition-colors flex items-center justify-center"
                onClick={() => copyToClipboard(createdKeyValue)}
              >
                <Copy size={14} />
              </button>
            </div>
            <div className="flex justify-end mt-4">
              <button className="btn btn-primary text-xs" onClick={closeKeyModal}>Done</button>
            </div>
          </div>
        ) : (
          <div>
            {/* Name */}
            <div className="mb-4">
              <label className="block text-xs font-medium text-text-secondary mb-1.5 uppercase tracking-wide">
                Name <span className="text-accent">*</span>
              </label>
              <input
                type="text"
                value={keyName}
                onChange={(e) => setKeyName(e.target.value)}
                placeholder="production-key"
                className="text-sm"
              />
            </div>

            {/* Scopes */}
            <div className="mb-4">
              <label className="block text-xs font-medium text-text-secondary mb-1.5 uppercase tracking-wide">
                Scopes
              </label>
              <div className="grid grid-cols-2 gap-2">
                {ALL_SCOPES.map((scope) => {
                  const isFullAccess = keyScopes.includes("*");
                  const isChecked = keyScopes.includes(scope);
                  const isDisabled = isFullAccess && scope !== "*";
                  return (
                    <label
                      key={scope}
                      className={`flex items-center gap-2 px-2.5 py-2 rounded border text-xs cursor-pointer transition-colors ${
                        isChecked
                          ? "bg-accent-muted border-accent/30 text-accent"
                          : isDisabled
                            ? "bg-surface-overlay border-border-subtle text-text-muted opacity-50 cursor-not-allowed"
                            : "bg-surface-base border-border-default text-text-secondary hover:border-border-strong"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={isChecked}
                        disabled={isDisabled}
                        onChange={() => toggleScope(scope)}
                        className="sr-only"
                      />
                      <span
                        className={`w-3.5 h-3.5 rounded border flex items-center justify-center flex-shrink-0 ${
                          isChecked ? "bg-accent border-accent" : "border-border-strong bg-surface-base"
                        }`}
                      >
                        {isChecked && <Check size={10} className="text-text-inverse" />}
                      </span>
                      <span className="font-mono">{scope}</span>
                    </label>
                  );
                })}
              </div>
            </div>

            {/* Expiry */}
            <div className="mb-4">
              <label className="block text-xs font-medium text-text-secondary mb-1.5 uppercase tracking-wide">
                Expiry
              </label>
              <select
                value={keyExpiry}
                onChange={(e) => setKeyExpiry(e.target.value)}
                className="text-sm"
              >
                <option value="none">No expiry</option>
                <option value="30">30 days</option>
                <option value="90">90 days</option>
                <option value="365">365 days</option>
              </select>
            </div>

            {/* IP Allowlist */}
            <div className="mb-4">
              <label className="block text-xs font-medium text-text-secondary mb-1.5 uppercase tracking-wide">
                IP Allowlist
              </label>
              <textarea
                value={keyIpAllowlist}
                onChange={(e) => setKeyIpAllowlist(e.target.value)}
                placeholder={"10.0.0.1\n192.168.1.0/24\n2001:db8::/32"}
                rows={3}
                className="text-sm font-mono"
              />
              <p className="text-[10px] text-text-muted mt-1">
                Leave empty to allow all IPs. Add IP addresses or CIDR ranges (e.g., 10.0.0.0/8)
              </p>
            </div>

            {/* Allowed Agents */}
            <div className="mb-4">
              <label className="block text-xs font-medium text-text-secondary mb-1.5 uppercase tracking-wide">
                Allowed Agents
              </label>
              {agents.length > 0 ? (
                <div className="grid grid-cols-2 gap-2 max-h-40 overflow-y-auto">
                  {agents.map((agent) => {
                    const isChecked = keyAllowedAgents.includes(agent.name);
                    return (
                      <label
                        key={agent.name}
                        className={`flex items-center gap-2 px-2.5 py-2 rounded border text-xs cursor-pointer transition-colors ${
                          isChecked
                            ? "bg-accent-muted border-accent/30 text-accent"
                            : "bg-surface-base border-border-default text-text-secondary hover:border-border-strong"
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => toggleAgent(agent.name)}
                          className="sr-only"
                        />
                        <span
                          className={`w-3.5 h-3.5 rounded border flex items-center justify-center flex-shrink-0 ${
                            isChecked ? "bg-accent border-accent" : "border-border-strong bg-surface-base"
                          }`}
                        >
                          {isChecked && <Check size={10} className="text-text-inverse" />}
                        </span>
                        <span className="font-mono truncate">{agent.name}</span>
                      </label>
                    );
                  })}
                </div>
              ) : (
                <input
                  type="text"
                  value={keyAllowedAgents.join(", ")}
                  onChange={(e) =>
                    setKeyAllowedAgents(
                      e.target.value
                        .split(",")
                        .map((s) => s.trim())
                        .filter(Boolean),
                    )
                  }
                  placeholder="support-bot, billing-agent"
                  className="text-sm font-mono"
                />
              )}
              <p className="text-[10px] text-text-muted mt-1">
                Restrict this key to specific agents. Leave empty for all agents.
              </p>
            </div>

            {/* Rate Limits */}
            <div className="mb-4">
              <label className="block text-xs font-medium text-text-secondary mb-1.5 uppercase tracking-wide">
                Rate Limits
              </label>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[10px] text-text-muted mb-1">
                    Requests per minute (RPM)
                  </label>
                  <input
                    type="number"
                    value={keyRpm}
                    onChange={(e) => setKeyRpm(parseInt(e.target.value) || 0)}
                    min={1}
                    className="text-sm font-mono"
                  />
                </div>
                <div>
                  <label className="block text-[10px] text-text-muted mb-1">
                    Requests per day (RPD)
                  </label>
                  <input
                    type="number"
                    value={keyRpd}
                    onChange={(e) => setKeyRpd(parseInt(e.target.value) || 0)}
                    min={1}
                    className="text-sm font-mono"
                  />
                </div>
              </div>
            </div>

            {/* Actions */}
            <div className="flex justify-end gap-2 mt-5">
              <button className="btn btn-secondary text-xs" onClick={closeKeyModal}>
                Cancel
              </button>
              <button
                className="btn btn-primary text-xs"
                disabled={!keyName.trim() || keyLoading}
                onClick={() => void handleCreateKey()}
              >
                {keyLoading ? "Creating..." : "Create"}
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* ── Confirm dialog ─────────────────────────────────────── */}
      {confirmState.open && (
        <Modal
          open={confirmState.open}
          onClose={() => setConfirmState((s) => ({ ...s, open: false }))}
          title={confirmState.title}
          maxWidth="sm"
        >
          <p className="text-sm text-text-secondary mb-4">{confirmState.message}</p>
          <div className="flex justify-end gap-2">
            <button
              className="btn btn-secondary text-xs"
              onClick={() => setConfirmState((s) => ({ ...s, open: false }))}
            >
              Cancel
            </button>
            <button
              className={`btn text-xs ${confirmState.destructive ? "btn-primary bg-status-error hover:bg-status-error/90 border-status-error" : "btn-primary"}`}
              disabled={confirmLoading}
              onClick={() => void handleConfirm()}
            >
              {confirmLoading ? "..." : confirmState.confirmLabel}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
