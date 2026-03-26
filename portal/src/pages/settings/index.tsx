import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams, Link } from "react-router-dom";
import {
  Plus,
  Users,
  Key,
  Trash2,
  Copy,
  RefreshCw,
  UserPlus,
  CreditCard,
  Plug,
  Calendar,
  Webhook,
  Lock,
  FolderKanban,
  ExternalLink,
  ChevronDown,
  ChevronRight,
  Send,
  Server,
  Shield,
  Play,
  AlertTriangle,
  Check,
  X,
} from "lucide-react";

import { PageHeader } from "../../components/common/PageHeader";
import { EmptyState } from "../../components/common/EmptyState";
import { ConfirmDialog } from "../../components/common/ConfirmDialog";
import { useToast } from "../../components/common/ToastProvider";
import { useAuth } from "../../lib/auth";
import { apiGet, apiPost, apiPut, apiDelete, useApiQuery } from "../../lib/api";
import { extractList } from "../../lib/normalize";

/* ══════════════════════════════════════════════════════════════════
   Types
   ══════════════════════════════════════════════════════════════════ */

type Member = {
  user_id: string;
  name: string;
  email: string;
  role: string;
  joined_at?: string;
};

type Org = { org_id: string; name: string };

type ApiKeyItem = {
  key_id: string;
  name: string;
  prefix: string;
  scopes: string[];
  created_at?: string | number;
  last_used?: string | number;
  expires_at?: string | number;
};

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
};

type BillingUsage = {
  total: number;
  inference: number;
  tools: number;
  infra: number;
  by_agent: { name: string; cost: number }[];
  by_model: { model: string; cost: number; pct: number }[];
};

type DailyPoint = { date: string; cost: number };

type StripeStatus = { plan: string; portal_url?: string };

type ConnectorProvider = {
  app: string;
  name: string;
  connected: boolean;
  tool_count: number;
};

type McpServer = {
  id: string;
  name: string;
  url: string;
  health: string;
  tool_count: number;
};

type TelegramStatus = {
  connected: boolean;
  bot_name?: string;
};

type Schedule = {
  id: string;
  name: string;
  description?: string;
  agent_name: string;
  cron: string;
  run_count: number;
  last_run?: string;
  enabled: boolean;
};

type Agent = { name: string };

type WebhookItem = {
  id: string;
  name: string;
  url: string;
  events: string[];
  delivery_count: number;
  fail_count: number;
};

type WebhookDelivery = {
  delivery_id: string;
  status: string;
  timestamp: string;
};

type SecretItem = {
  name: string;
  last4: string;
  created_at?: string;
};

type Project = {
  id: string;
  name: string;
  description?: string;
  agent_count: number;
  environments: string[];
};

/* ══════════════════════════════════════════════════════════════════
   Tab definitions
   ══════════════════════════════════════════════════════════════════ */

const TAB_IDS = [
  "team",
  "api-keys",
  "billing",
  "integrations",
  "schedules",
  "webhooks",
  "secrets",
  "projects",
] as const;

type TabId = (typeof TAB_IDS)[number];

const TAB_LABELS: Record<TabId, string> = {
  team: "Team",
  "api-keys": "API Keys",
  billing: "Billing",
  integrations: "Integrations",
  schedules: "Schedules",
  webhooks: "Webhooks",
  secrets: "Secrets",
  projects: "Projects",
};

/* ══════════════════════════════════════════════════════════════════
   Helpers
   ══════════════════════════════════════════════════════════════════ */

function formatDate(value?: string | number | null): string {
  if (value == null || value === "") return "--";
  const ts =
    typeof value === "number" && value < 1e12
      ? value * 1000
      : value;
  return new Date(ts).toLocaleDateString();
}

function formatCurrency(n: number): string {
  return "$" + n.toFixed(2);
}

function avatarColor(name: string): string {
  const colors = [
    "bg-chart-orange",
    "bg-chart-blue",
    "bg-chart-purple",
    "bg-chart-cyan",
    "bg-chart-green",
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
}

function roleBadgeClass(role: string): string {
  switch (role) {
    case "owner":
      return "bg-accent-muted text-accent border-accent/20";
    case "admin":
      return "bg-status-info/10 text-status-info border-status-info/20";
    case "viewer":
      return "bg-surface-overlay text-text-muted border-border-default";
    default:
      return "bg-surface-overlay text-text-secondary border-border-default";
  }
}

function cronToHuman(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length < 5) return cron;
  const [min, hour, dom, , dow] = parts;
  if (min === "0" && hour !== "*" && dom === "*" && dow === "*") return `Every day at ${hour}:00`;
  if (min === "0" && hour !== "*" && dom === "*" && dow === "1") return `Every Monday at ${hour}:00`;
  if (min === "0" && hour === "*" && dom === "*" && dow === "*") return "Every hour";
  if (min !== "*" && hour === "*" && dom === "*" && dow === "*") return `Every hour at :${min.padStart(2, "0")}`;
  if (min === "*/5" || (min !== "*" && min.startsWith("*/"))) return `Every ${min.replace("*/", "")} minutes`;
  return cron;
}

function daysUntil(value?: string | number): number | null {
  if (value == null || value === "") return null;
  const ts =
    typeof value === "number" && value < 1e12
      ? value * 1000
      : value;
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

const WEBHOOK_EVENTS = [
  "session.complete",
  "session.error",
  "issue.created",
  "eval.complete",
  "deploy.complete",
] as const;

/* ══════════════════════════════════════════════════════════════════
   Shared inline components
   ══════════════════════════════════════════════════════════════════ */

function Modal({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 glass-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="w-full max-w-[480px] glass-medium border border-border-default rounded-lg relative"
        style={{ animation: "fadeIn 0.15s ease-out" }}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-default">
          <h2 className="text-sm font-semibold text-text-primary">{title}</h2>
          <button
            onClick={onClose}
            className="p-2 min-w-[var(--touch-target-min)] min-h-[var(--touch-target-min)] rounded-md text-text-muted hover:text-text-primary hover:bg-surface-overlay transition-colors flex items-center justify-center"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>
        <div className="px-5 py-4">{children}</div>
      </div>
    </div>
  );
}

function Pill({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 text-[10px] font-medium rounded-full border border-border-subtle bg-surface-overlay text-text-muted ${className}`}
    >
      {children}
    </span>
  );
}

function SignalCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="card flex-1 min-w-[140px]">
      <p className="text-[10px] uppercase tracking-wide text-text-muted mb-1">{label}</p>
      <p className="text-lg font-bold text-text-primary font-mono">{value}</p>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wide mb-3 mt-6 first:mt-0">{children}</h3>;
}

/* ══════════════════════════════════════════════════════════════════
   SettingsPage
   ══════════════════════════════════════════════════════════════════ */

export const SettingsPage = () => {
  const { showToast } = useToast();
  const { user } = useAuth();
  const orgId = user?.org_id ?? "";

  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = (searchParams.get("tab") as TabId) || "team";

  const setTab = useCallback(
    (tab: TabId) => setSearchParams({ tab }, { replace: true }),
    [setSearchParams],
  );

  /* ── Confirm dialog ────────────────────────────────────────── */
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

  /* ══════════════════════════════════════════════════════════════
     TAB 1: Team
     ══════════════════════════════════════════════════════════════ */

  const orgQuery = useApiQuery<{ orgs: Org[] }>("/api/v1/orgs", activeTab === "team");
  const orgName = orgQuery.data?.orgs?.[0]?.name ?? "...";
  const resolvedOrgId = orgId || orgQuery.data?.orgs?.[0]?.org_id || "";

  const membersQuery = useApiQuery<{ members: Member[] }>(
    `/api/v1/orgs/${resolvedOrgId}/members`,
    activeTab === "team" && !!resolvedOrgId,
  );
  const members = useMemo(() => membersQuery.data?.members ?? [], [membersQuery.data]);

  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("member");
  const [inviteLoading, setInviteLoading] = useState(false);

  const handleInvite = async () => {
    if (!inviteEmail.trim()) return;
    setInviteLoading(true);
    try {
      await apiPost(`/api/v1/orgs/${resolvedOrgId}/members`, { email: inviteEmail, role: inviteRole });
      showToast(`Invitation sent to ${inviteEmail}`, "success");
      setInviteOpen(false);
      setInviteEmail("");
      setInviteRole("member");
      void membersQuery.refetch();
    } catch {
      showToast("Failed to send invite", "error");
    } finally {
      setInviteLoading(false);
    }
  };

  const handleRoleChange = async (userId: string, role: string) => {
    try {
      await apiPut(`/api/v1/orgs/${resolvedOrgId}/members/${userId}`, { role });
      showToast("Role updated", "success");
      void membersQuery.refetch();
    } catch {
      showToast("Failed to update role", "error");
    }
  };

  const handleRemoveMember = (m: Member) => {
    confirm(
      "Remove Member",
      `Remove ${m.name} (${m.email}) from this organization? They will lose all access.`,
      async () => {
        await apiDelete(`/api/v1/orgs/${resolvedOrgId}/members/${m.user_id}`);
        showToast("Member removed", "success");
        void membersQuery.refetch();
      },
      { label: "Remove", destructive: true },
    );
  };

  const teamContent = (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-text-primary">
          Team &mdash; Org: {orgName}
        </h2>
        <button className="btn btn-primary text-xs" onClick={() => setInviteOpen(true)}>
          <UserPlus size={12} /> Invite +
        </button>
      </div>

      {membersQuery.loading ? (
        <div className="card flex items-center justify-center py-12">
          <RefreshCw size={16} className="animate-spin text-accent mr-2" />
          <span className="text-sm text-text-muted">Loading members...</span>
        </div>
      ) : membersQuery.error ? (
        <div className="card border-status-error/30 text-center py-8">
          <p className="text-sm text-status-error">{membersQuery.error}</p>
        </div>
      ) : members.length === 0 ? (
        <EmptyState
          icon={<Users size={40} />}
          title="No team members"
          description="Invite members to collaborate on your agents"
          action={
            <button className="btn btn-primary text-xs mt-2" onClick={() => setInviteOpen(true)}>
              <UserPlus size={12} /> Invite First Member
            </button>
          }
        />
      ) : (
        <div className="space-y-2">
          {members.map((m) => {
            const isOwner = m.role === "owner";
            const isSelf = m.user_id === user?.id;
            return (
              <div
                key={m.user_id}
                className="card flex items-center gap-4 py-3 px-4 card-hover"
              >
                {/* Avatar */}
                <div
                  className={`w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold text-text-primary ${avatarColor(m.name)}`}
                >
                  {m.name.charAt(0).toUpperCase()}
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-text-primary truncate">{m.name}</p>
                  <p className="text-xs text-text-muted truncate">{m.email}</p>
                </div>

                {/* Role */}
                <div className="flex items-center gap-3">
                  {isOwner ? (
                    <span className={`inline-flex items-center px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide rounded-full border ${roleBadgeClass("owner")}`}>
                      Owner
                    </span>
                  ) : (
                    <select
                      value={m.role}
                      onChange={(e) => void handleRoleChange(m.user_id, e.target.value)}
                      className="text-xs bg-surface-base border border-border-default rounded px-2 py-1.5 min-h-[var(--touch-target-min)]"
                    >
                      <option value="admin">Admin</option>
                      <option value="member">Member</option>
                      <option value="viewer">Viewer</option>
                    </select>
                  )}

                  {/* Join date */}
                  <span className="text-[10px] text-text-muted whitespace-nowrap hidden sm:inline">
                    {formatDate(m.joined_at)}
                  </span>

                  {/* Remove */}
                  {!isOwner && !isSelf && (
                    <button
                      onClick={() => handleRemoveMember(m)}
                      className="p-2 min-w-[var(--touch-target-min)] min-h-[var(--touch-target-min)] rounded-md text-text-muted hover:text-status-error hover:bg-status-error/10 transition-colors flex items-center justify-center"
                      title="Remove member"
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Invite modal */}
      <Modal open={inviteOpen} onClose={() => setInviteOpen(false)} title="Invite Team Member">
        <div className="mb-4">
          <label className="block text-xs font-medium text-text-secondary mb-1.5 uppercase tracking-wide">
            Email <span className="text-accent">*</span>
          </label>
          <input
            type="email"
            value={inviteEmail}
            onChange={(e) => setInviteEmail(e.target.value)}
            placeholder="colleague@company.com"
            className="text-sm"
          />
        </div>
        <div className="mb-4">
          <label className="block text-xs font-medium text-text-secondary mb-1.5 uppercase tracking-wide">
            Role
          </label>
          <select
            value={inviteRole}
            onChange={(e) => setInviteRole(e.target.value)}
            className="text-sm"
          >
            <option value="admin">Admin</option>
            <option value="member">Member</option>
            <option value="viewer">Viewer</option>
          </select>
        </div>
        <div className="flex justify-end gap-2 mt-5">
          <button className="btn btn-secondary text-xs" onClick={() => setInviteOpen(false)}>
            Cancel
          </button>
          <button
            className="btn btn-primary text-xs"
            disabled={!inviteEmail.trim() || inviteLoading}
            onClick={() => void handleInvite()}
          >
            {inviteLoading ? "Sending..." : "Send Invite"}
          </button>
        </div>
      </Modal>
    </div>
  );

  /* ══════════════════════════════════════════════════════════════
     TAB 2: API Keys
     ══════════════════════════════════════════════════════════════ */

  const keysQuery = useApiQuery<{ keys: BackendApiKey[] } | BackendApiKey[]>(
    "/api/v1/api-keys",
    activeTab === "api-keys",
  );
  const keys = useMemo<ApiKeyItem[]>(() => {
    const raw = keysQuery.data;
    const rows = Array.isArray(raw) ? raw : raw?.keys ?? [];
    return rows.map((k) => ({
      key_id: String(k.key_id ?? ""),
      name: String(k.name ?? ""),
      prefix: String(k.prefix ?? k.key_prefix ?? ""),
      scopes: Array.isArray(k.scopes) ? k.scopes : [],
      created_at: k.created_at ?? undefined,
      last_used:
        k.last_used ?? k.last_used_at ?? undefined,
      expires_at: k.expires_at ?? undefined,
    }));
  }, [keysQuery.data]);

  const [createKeyOpen, setCreateKeyOpen] = useState(false);
  const [keyName, setKeyName] = useState("");
  const [keyScopes, setKeyScopes] = useState<string[]>([]);
  const [keyExpiry, setKeyExpiry] = useState("none");
  const [createdKeyValue, setCreatedKeyValue] = useState<string | null>(null);
  const [keyLoading, setKeyLoading] = useState(false);

  const toggleScope = (scope: string) => {
    if (scope === "*") {
      setKeyScopes(keyScopes.includes("*") ? [] : ["*"]);
    } else {
      setKeyScopes((prev) => (prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev.filter((s) => s !== "*"), scope]));
    }
  };

  const handleCreateKey = async () => {
    if (!keyName.trim()) return;
    setKeyLoading(true);
    try {
      const result = await apiPost<{ key: string }>("/api/v1/api-keys", {
        name: keyName,
        scopes: keyScopes.length ? keyScopes : ["*"],
        expiry_days: keyExpiry === "none" ? null : parseInt(keyExpiry),
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
    setCreatedKeyValue(null);
  };

  const copyToClipboard = (text: string) => {
    void navigator.clipboard.writeText(text);
    showToast("Copied to clipboard", "success");
  };

  const apiKeysContent = (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-text-primary">API Keys</h2>
        <button
          className="btn btn-primary text-xs"
          onClick={() => { setCreatedKeyValue(null); setKeyName(""); setKeyScopes([]); setKeyExpiry("none"); setCreateKeyOpen(true); }}
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
            return (
              <div key={k.key_id} className="card card-hover py-3 px-4">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-medium text-text-primary">{k.name}</span>
                    <code className="text-xs font-mono text-text-muted">{k.prefix}...</code>
                    {expiring && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-medium rounded-full bg-status-warning/10 text-status-warning border border-status-warning/20">
                        <AlertTriangle size={10} /> Expires in {expDays}d
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
                    Last used {k.last_used ? formatDate(k.last_used) : "never"}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Create / Reveal modal */}
      <Modal open={createKeyOpen} onClose={closeKeyModal} title={createdKeyValue ? "Key Created" : "Create API Key"}>
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
    </div>
  );

  /* ══════════════════════════════════════════════════════════════
     TAB 3: Billing
     ══════════════════════════════════════════════════════════════ */

  const billingQuery = useApiQuery<BillingUsage>("/api/v1/billing/usage?since_days=30", activeTab === "billing");
  const dailyQuery = useApiQuery<{ points: DailyPoint[] }>("/api/v1/billing/usage/daily?days=30", activeTab === "billing");
  const stripeQuery = useApiQuery<StripeStatus>("/api/v1/stripe/status", activeTab === "billing");

  const billing = billingQuery.data;
  const dailyPoints = dailyQuery.data?.points ?? [];
  const plan = stripeQuery.data?.plan ?? "Free";

  const handleManageSubscription = async () => {
    try {
      const result = await apiPost<{ url: string }>("/api/v1/stripe/portal");
      window.open(result.url, "_blank");
    } catch {
      showToast("Failed to open billing portal", "error");
    }
  };

  // SVG area chart helpers
  const chartW = 600;
  const chartH = 160;
  const chartPad = { top: 10, right: 10, bottom: 24, left: 50 };
  const innerW = chartW - chartPad.left - chartPad.right;
  const innerH = chartH - chartPad.top - chartPad.bottom;

  const maxCost = Math.max(...dailyPoints.map((p) => p.cost), 1);
  const xScale = (i: number) => chartPad.left + (i / Math.max(dailyPoints.length - 1, 1)) * innerW;
  const yScale = (v: number) => chartPad.top + innerH - (v / maxCost) * innerH;

  const linePoints = dailyPoints.map((p, i) => `${xScale(i)},${yScale(p.cost)}`).join(" ");
  const areaPoints = dailyPoints.length
    ? `${xScale(0)},${yScale(0)} ${linePoints} ${xScale(dailyPoints.length - 1)},${yScale(0)}`
    : "";

  // Horizontal bar chart for cost by agent
  const agentCosts = billing?.by_agent ?? [];
  const maxAgentCost = Math.max(...agentCosts.map((a) => a.cost), 1);

  const billingContent = (
    <div>
      {billingQuery.loading ? (
        <div className="card flex items-center justify-center py-12">
          <RefreshCw size={16} className="animate-spin text-accent mr-2" />
          <span className="text-sm text-text-muted">Loading billing data...</span>
        </div>
      ) : billingQuery.error ? (
        <div className="card border-status-error/30 text-center py-8">
          <p className="text-sm text-status-error">{billingQuery.error}</p>
        </div>
      ) : (
        <>
          {/* Signal cards */}
          <div className="flex flex-wrap gap-3 mb-6">
            <SignalCard label="Total This Month" value={formatCurrency(billing?.total ?? 0)} />
            <SignalCard label="Inference" value={formatCurrency(billing?.inference ?? 0)} />
            <SignalCard label="Tools" value={formatCurrency(billing?.tools ?? 0)} />
            <SignalCard label="Infra" value={formatCurrency(billing?.infra ?? 0)} />
          </div>

          {/* Daily cost chart */}
          {dailyPoints.length > 0 && (
            <div className="card mb-6">
              <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wide mb-3">
                Daily Cost (30 days)
              </h3>
              <svg viewBox={`0 0 ${chartW} ${chartH}`} className="w-full" preserveAspectRatio="xMidYMid meet">
                {/* Y-axis labels */}
                {[0, 0.25, 0.5, 0.75, 1].map((pct) => {
                  const val = maxCost * pct;
                  const y = yScale(val);
                  return (
                    <g key={pct}>
                      <line
                        x1={chartPad.left}
                        y1={y}
                        x2={chartW - chartPad.right}
                        y2={y}
                        stroke="var(--color-border-subtle)"
                        strokeWidth="0.5"
                      />
                      <text x={chartPad.left - 6} y={y + 3} textAnchor="end" fill="var(--color-text-muted)" fontSize="9">
                        ${val.toFixed(0)}
                      </text>
                    </g>
                  );
                })}
                {/* Area */}
                <polygon points={areaPoints} fill="var(--color-accent)" opacity="0.12" />
                {/* Line */}
                <polyline points={linePoints} fill="none" stroke="var(--color-accent)" strokeWidth="2" />
                {/* X-axis labels (first, middle, last) */}
                {dailyPoints.length > 0 && (
                  <>
                    <text x={xScale(0)} y={chartH - 4} textAnchor="start" fill="var(--color-text-muted)" fontSize="8">
                      {dailyPoints[0].date.slice(5)}
                    </text>
                    {dailyPoints.length > 2 && (
                      <text
                        x={xScale(Math.floor(dailyPoints.length / 2))}
                        y={chartH - 4}
                        textAnchor="middle"
                        fill="var(--color-text-muted)"
                        fontSize="8"
                      >
                        {dailyPoints[Math.floor(dailyPoints.length / 2)].date.slice(5)}
                      </text>
                    )}
                    <text x={xScale(dailyPoints.length - 1)} y={chartH - 4} textAnchor="end" fill="var(--color-text-muted)" fontSize="8">
                      {dailyPoints[dailyPoints.length - 1].date.slice(5)}
                    </text>
                  </>
                )}
              </svg>
            </div>
          )}

          {/* Cost by Agent */}
          {agentCosts.length > 0 && (
            <div className="card mb-6">
              <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wide mb-3">
                Cost by Agent
              </h3>
              <div className="space-y-2">
                {agentCosts.map((a) => (
                  <div key={a.name} className="flex items-center gap-3">
                    <span className="text-xs text-text-secondary w-32 truncate flex-shrink-0">{a.name}</span>
                    <div className="flex-1 h-5 bg-surface-overlay rounded overflow-hidden">
                      <div
                        className="h-full bg-accent rounded transition-all"
                        style={{ width: `${(a.cost / maxAgentCost) * 100}%` }}
                      />
                    </div>
                    <span className="text-xs font-mono text-text-muted w-16 text-right">{formatCurrency(a.cost)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Cost by Model */}
          {(billing?.by_model ?? []).length > 0 && (
            <div className="card mb-6">
              <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wide mb-3">
                Cost by Model
              </h3>
              <div className="overflow-x-auto">
                <table>
                  <thead>
                    <tr>
                      <th>Model</th>
                      <th>Cost</th>
                      <th>% of Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(billing?.by_model ?? []).map((m) => (
                      <tr key={m.model}>
                        <td><span className="text-text-primary text-sm font-mono">{m.model}</span></td>
                        <td><span className="text-text-secondary text-sm font-mono">{formatCurrency(m.cost)}</span></td>
                        <td><span className="text-text-muted text-sm">{m.pct.toFixed(1)}%</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Plan */}
          <div className="card flex items-center justify-between">
            <div>
              <p className="text-xs text-text-muted uppercase tracking-wide">Plan</p>
              <p className="text-sm font-semibold text-text-primary mt-0.5">{plan}</p>
            </div>
            <div className="flex items-center gap-2">
              <Link to="/billing/pricing" className="btn btn-secondary text-xs">
                <CreditCard size={12} /> Pricing
              </Link>
              <Link to="/billing/invoices" className="btn btn-secondary text-xs">
                Invoices
              </Link>
              <button
                className="btn btn-secondary text-xs"
                onClick={() => void handleManageSubscription()}
              >
                Manage Subscription <ExternalLink size={12} />
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );

  /* ══════════════════════════════════════════════════════════════
     TAB 4: Integrations
     ══════════════════════════════════════════════════════════════ */

  const connectorsQuery = useApiQuery<{ providers: ConnectorProvider[] }>(
    "/api/v1/connectors/providers",
    activeTab === "integrations",
  );
  const mcpQuery = useApiQuery<{ servers: McpServer[] }>(
    "/api/v1/mcp/servers",
    activeTab === "integrations",
  );
  const telegramQuery = useApiQuery<TelegramStatus>(
    "/api/v1/chat/telegram/status",
    activeTab === "integrations",
  );

  const connectors = connectorsQuery.data?.providers ?? [];
  const mcpServers = mcpQuery.data?.servers ?? [];
  const telegram = telegramQuery.data;

  const [telegramToken, setTelegramToken] = useState("");
  const [telegramConnecting, setTelegramConnecting] = useState(false);
  const [showTelegramConnect, setShowTelegramConnect] = useState(false);
  const [telegramQr, setTelegramQr] = useState<string | null>(null);

  const [mcpFormOpen, setMcpFormOpen] = useState(false);
  const [mcpName, setMcpName] = useState("");
  const [mcpUrl, setMcpUrl] = useState("");
  const [mcpRegistering, setMcpRegistering] = useState(false);

  const handleTelegramConnect = async () => {
    if (!telegramToken.trim()) return;
    setTelegramConnecting(true);
    try {
      await apiPost("/api/v1/chat/telegram/connect", { token: telegramToken });
      showToast("Telegram connected", "success");
      setShowTelegramConnect(false);
      setTelegramToken("");
      void telegramQuery.refetch();
    } catch {
      showToast("Failed to connect Telegram", "error");
    } finally {
      setTelegramConnecting(false);
    }
  };

  const handleTelegramQr = async () => {
    try {
      const result = await apiGet<{ qr_url?: string; deep_link?: string }>("/api/v1/chat/telegram/qr");
      setTelegramQr(result.qr_url || result.deep_link || null);
    } catch {
      showToast("Failed to load QR", "error");
    }
  };

  const handleTelegramDisconnect = async () => {
    try {
      await apiPost("/api/v1/chat/telegram/disconnect");
      showToast("Telegram disconnected", "success");
      void telegramQuery.refetch();
    } catch {
      showToast("Failed to disconnect", "error");
    }
  };

  const handleConnectorAuth = async (app: string) => {
    try {
      const result = await apiGet<{ url: string }>(`/api/v1/connectors/auth/${app}`);
      window.open(result.url, "_blank");
    } catch {
      showToast("Failed to start OAuth", "error");
    }
  };

  const handleMcpSync = async (id: string) => {
    try {
      await apiPost(`/api/v1/mcp/servers/${id}/sync`);
      showToast("MCP server synced", "success");
      void mcpQuery.refetch();
    } catch {
      showToast("Sync failed", "error");
    }
  };

  const handleMcpRemove = (srv: McpServer) => {
    confirm(
      "Remove MCP Server",
      `Remove "${srv.name}" (${srv.url})? All tools from this server will become unavailable.`,
      async () => {
        await apiDelete(`/api/v1/mcp/servers/${srv.id}`);
        showToast("Server removed", "success");
        void mcpQuery.refetch();
      },
      { label: "Remove", destructive: true },
    );
  };

  const handleMcpRegister = async () => {
    if (!mcpName.trim() || !mcpUrl.trim()) return;
    setMcpRegistering(true);
    try {
      await apiPost("/api/v1/mcp/servers", { name: mcpName, url: mcpUrl });
      showToast("MCP server registered", "success");
      setMcpFormOpen(false);
      setMcpName("");
      setMcpUrl("");
      void mcpQuery.refetch();
    } catch {
      showToast("Registration failed", "error");
    } finally {
      setMcpRegistering(false);
    }
  };

  const healthColor = (h: string) => {
    switch (h.toLowerCase()) {
      case "healthy": return "text-status-live";
      case "degraded": return "text-status-warning";
      default: return "text-status-error";
    }
  };

  const integrationsContent = (
    <div>
      {/* Section A: Chat Platforms */}
      <SectionLabel>Chat Platforms</SectionLabel>
      <div className="card card-hover mb-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Send size={16} className="text-chart-blue" />
            <div>
              <p className="text-sm font-medium text-text-primary">Telegram</p>
              {telegram?.connected && telegram?.bot_name && (
                <p className="text-xs text-text-muted">{telegram.bot_name}</p>
              )}
            </div>
            <span
              className={`inline-flex items-center gap-1.5 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide rounded-full border ${
                telegram?.connected
                  ? "bg-status-live/10 text-status-live border-status-live/20"
                  : "bg-surface-overlay text-text-muted border-border-default"
              }`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${telegram?.connected ? "bg-status-live" : "bg-text-muted"}`} />
              {telegram?.connected ? "Connected" : "Not connected"}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {telegram?.connected ? (
              <>
                <button className="btn btn-secondary text-xs" onClick={() => void handleTelegramQr()}>
                  View QR
                </button>
                <button className="btn btn-secondary text-xs" onClick={() => void handleTelegramDisconnect()}>
                  Disconnect
                </button>
              </>
            ) : (
              <button className="btn btn-primary text-xs" onClick={() => setShowTelegramConnect(true)}>
                Connect
              </button>
            )}
          </div>
        </div>
        {showTelegramConnect && !telegram?.connected && (
          <div className="mt-4 pt-4 border-t border-border-default">
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <label className="block text-xs font-medium text-text-secondary mb-1.5 uppercase tracking-wide">
                  Bot Token
                </label>
                <input
                  type="text"
                  value={telegramToken}
                  onChange={(e) => setTelegramToken(e.target.value)}
                  placeholder="123456:ABC-DEF..."
                  className="text-sm font-mono"
                />
              </div>
              <button
                className="btn btn-primary text-xs"
                disabled={!telegramToken.trim() || telegramConnecting}
                onClick={() => void handleTelegramConnect()}
              >
                {telegramConnecting ? "Connecting..." : "Connect"}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Telegram QR modal */}
      <Modal open={!!telegramQr} onClose={() => setTelegramQr(null)} title="Telegram QR Code">
        <div className="flex flex-col items-center gap-4">
          {telegramQr?.startsWith("http") ? (
            <img src={telegramQr} alt="Telegram QR code" className="w-48 h-48 rounded-lg border border-border-default" />
          ) : (
            <div className="p-4 bg-surface-base border border-border-default rounded-lg">
              <a
                href={telegramQr ?? ""}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-accent hover:underline break-all"
              >
                {telegramQr}
              </a>
            </div>
          )}
          <button className="btn btn-secondary text-xs" onClick={() => setTelegramQr(null)}>
            Close
          </button>
        </div>
      </Modal>

      {/* Section B: Connectors (Pipedream) */}
      <SectionLabel>Connectors (Pipedream)</SectionLabel>
      {connectorsQuery.loading ? (
        <div className="card flex items-center justify-center py-8 mb-4">
          <RefreshCw size={14} className="animate-spin text-accent mr-2" />
          <span className="text-sm text-text-muted">Loading connectors...</span>
        </div>
      ) : connectors.length === 0 ? (
        <div className="card text-center py-8 mb-4">
          <p className="text-sm text-text-muted">No connector providers available</p>
        </div>
      ) : (
        <div className="space-y-2 mb-4">
          {connectors.map((c) => (
            <div key={c.app} className="card card-hover py-3 px-4 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Plug size={14} className="text-text-muted" />
                <span className="text-sm text-text-primary">{c.name}</span>
                <span
                  className={`inline-flex items-center gap-1.5 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide rounded-full border ${
                    c.connected
                      ? "bg-status-live/10 text-status-live border-status-live/20"
                      : "bg-surface-overlay text-text-muted border-border-default"
                  }`}
                >
                  {c.connected ? "Connected" : "Not connected"}
                </span>
                {c.connected && c.tool_count > 0 && (
                  <span className="text-[10px] text-text-muted">{c.tool_count} tools</span>
                )}
              </div>
              {!c.connected && (
                <button className="btn btn-primary text-xs" onClick={() => void handleConnectorAuth(c.app)}>
                  Connect <ExternalLink size={10} />
                </button>
              )}
            </div>
          ))}
          <a
            href="#"
            className="inline-flex items-center gap-1 text-xs text-accent hover:text-accent-hover transition-colors mt-2"
            onClick={(e) => { e.preventDefault(); void handleConnectorAuth("browse"); }}
          >
            Browse All Connectors <ExternalLink size={10} />
          </a>
        </div>
      )}

      {/* Section C: MCP Servers */}
      <SectionLabel>MCP Servers</SectionLabel>
      {mcpQuery.loading ? (
        <div className="card flex items-center justify-center py-8">
          <RefreshCw size={14} className="animate-spin text-accent mr-2" />
          <span className="text-sm text-text-muted">Loading MCP servers...</span>
        </div>
      ) : mcpServers.length === 0 && !mcpFormOpen ? (
        <EmptyState
          icon={<Server size={32} />}
          title="No MCP servers"
          description="Register an MCP server to extend your agent's tool library"
          action={
            <button className="btn btn-primary text-xs mt-2" onClick={() => setMcpFormOpen(true)}>
              <Plus size={12} /> Register Server
            </button>
          }
        />
      ) : (
        <>
          <div className="space-y-2 mb-3">
            {mcpServers.map((srv) => (
              <div key={srv.id} className="card card-hover py-3 px-4 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Server size={14} className="text-text-muted" />
                  <div>
                    <p className="text-sm font-medium text-text-primary">{srv.name}</p>
                    <p className="text-xs text-text-muted font-mono truncate max-w-xs">{srv.url}</p>
                  </div>
                  <span className={`text-[10px] font-medium uppercase ${healthColor(srv.health)}`}>
                    {srv.health}
                  </span>
                  {srv.tool_count > 0 && (
                    <span className="text-[10px] text-text-muted">{srv.tool_count} tools</span>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => void handleMcpSync(srv.id)}
                    className="p-2 min-w-[var(--touch-target-min)] min-h-[var(--touch-target-min)] text-text-muted hover:text-accent hover:bg-surface-overlay rounded-md transition-colors flex items-center justify-center"
                    title="Sync tools"
                  >
                    <RefreshCw size={14} />
                  </button>
                  <button
                    onClick={() => handleMcpRemove(srv)}
                    className="p-2 min-w-[var(--touch-target-min)] min-h-[var(--touch-target-min)] text-text-muted hover:text-status-error hover:bg-status-error/10 rounded-md transition-colors flex items-center justify-center"
                    title="Remove server"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>

          {!mcpFormOpen && (
            <button
              className="btn btn-secondary text-xs"
              onClick={() => setMcpFormOpen(true)}
            >
              <Plus size={12} /> Register New MCP Server
            </button>
          )}
        </>
      )}

      {/* MCP registration inline form */}
      {mcpFormOpen && (
        <div className="card mt-3">
          <h4 className="text-xs font-semibold text-text-secondary uppercase tracking-wide mb-3">
            Register New MCP Server
          </h4>
          <div className="grid grid-cols-2 gap-3 mb-3">
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1 uppercase tracking-wide">Name</label>
              <input
                type="text"
                value={mcpName}
                onChange={(e) => setMcpName(e.target.value)}
                placeholder="my-mcp-server"
                className="text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1 uppercase tracking-wide">URL</label>
              <input
                type="url"
                value={mcpUrl}
                onChange={(e) => setMcpUrl(e.target.value)}
                placeholder="https://mcp.example.com"
                className="text-sm"
              />
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <button className="btn btn-secondary text-xs" onClick={() => { setMcpFormOpen(false); setMcpName(""); setMcpUrl(""); }}>
              Cancel
            </button>
            <button
              className="btn btn-primary text-xs"
              disabled={!mcpName.trim() || !mcpUrl.trim() || mcpRegistering}
              onClick={() => void handleMcpRegister()}
            >
              {mcpRegistering ? "Registering..." : "Register"}
            </button>
          </div>
        </div>
      )}
    </div>
  );

  /* ══════════════════════════════════════════════════════════════
     TAB 5: Schedules
     ══════════════════════════════════════════════════════════════ */

  const schedulesQuery = useApiQuery<{ schedules: Schedule[] }>(
    "/api/v1/schedules",
    activeTab === "schedules",
  );
  const agentsQuery = useApiQuery<{ agents: Agent[] } | Agent[]>(
    "/api/v1/agents",
    activeTab === "schedules",
  );

  const schedules = schedulesQuery.data?.schedules ?? [];
  const agentsList = useMemo(() => extractList<Agent>(agentsQuery.data, "agents"), [agentsQuery.data]);

  const [scheduleModalOpen, setScheduleModalOpen] = useState(false);
  const [editingSchedule, setEditingSchedule] = useState<Schedule | null>(null);
  const [schedForm, setSchedForm] = useState({ agent_name: "", task: "", cron: "" });
  const [schedLoading, setSchedLoading] = useState(false);

  const openNewSchedule = () => {
    setEditingSchedule(null);
    setSchedForm({ agent_name: agentsList[0]?.name ?? "", task: "", cron: "" });
    setScheduleModalOpen(true);
  };

  const openEditSchedule = (s: Schedule) => {
    setEditingSchedule(s);
    setSchedForm({ agent_name: s.agent_name, task: s.description ?? s.name, cron: s.cron });
    setScheduleModalOpen(true);
  };

  const handleSaveSchedule = async () => {
    if (!schedForm.agent_name || !schedForm.task.trim() || !schedForm.cron.trim()) return;
    setSchedLoading(true);
    try {
      if (editingSchedule) {
        await apiPut(`/api/v1/schedules/${editingSchedule.id}`, schedForm);
        showToast("Schedule updated", "success");
      } else {
        await apiPost("/api/v1/schedules", schedForm);
        showToast("Schedule created", "success");
      }
      setScheduleModalOpen(false);
      void schedulesQuery.refetch();
    } catch {
      showToast("Failed to save schedule", "error");
    } finally {
      setSchedLoading(false);
    }
  };

  const handleDeleteSchedule = (s: Schedule) => {
    confirm(
      "Delete Schedule",
      `Delete schedule "${s.name}"? This cannot be undone.`,
      async () => {
        await apiDelete(`/api/v1/schedules/${s.id}`);
        showToast("Schedule deleted", "success");
        void schedulesQuery.refetch();
      },
      { label: "Delete", destructive: true },
    );
  };

  const handleToggleSchedule = async (s: Schedule) => {
    try {
      await apiPost(`/api/v1/schedules/${s.id}/${s.enabled ? "disable" : "enable"}`);
      showToast(`Schedule ${s.enabled ? "disabled" : "enabled"}`, "success");
      void schedulesQuery.refetch();
    } catch {
      showToast("Failed to toggle schedule", "error");
    }
  };

  const schedulesContent = (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-text-primary">Schedules</h2>
        <button className="btn btn-primary text-xs" onClick={openNewSchedule}>
          <Calendar size={12} /> New Schedule
        </button>
      </div>

      {schedulesQuery.loading ? (
        <div className="card flex items-center justify-center py-12">
          <RefreshCw size={16} className="animate-spin text-accent mr-2" />
          <span className="text-sm text-text-muted">Loading schedules...</span>
        </div>
      ) : schedules.length === 0 ? (
        <EmptyState
          icon={<Calendar size={40} />}
          title="No schedules configured"
          description="Schedule your first agent run"
          action={
            <button className="btn btn-primary text-xs mt-2" onClick={openNewSchedule}>
              <Plus size={12} /> New Schedule
            </button>
          }
        />
      ) : (
        <div className="space-y-2">
          {schedules.map((s) => (
            <div key={s.id} className="card card-hover py-3 px-4">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-3">
                  <span className="text-sm font-medium text-text-primary">{s.name}</span>
                  {s.description && (
                    <span className="text-xs text-text-muted truncate max-w-xs">{s.description}</span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => void handleToggleSchedule(s)}
                    className={`px-2.5 py-1 text-[10px] font-medium rounded-full border transition-colors ${
                      s.enabled
                        ? "bg-status-live/10 text-status-live border-status-live/20 hover:bg-status-live/20"
                        : "bg-surface-overlay text-text-muted border-border-default hover:bg-surface-hover"
                    }`}
                  >
                    {s.enabled ? "Enabled" : "Disabled"}
                  </button>
                  <button
                    onClick={() => openEditSchedule(s)}
                    className="p-2 min-w-[var(--touch-target-min)] min-h-[var(--touch-target-min)] text-text-muted hover:text-accent hover:bg-surface-overlay rounded-md transition-colors flex items-center justify-center"
                    title="Edit"
                  >
                    <ChevronRight size={14} />
                  </button>
                  <button
                    onClick={() => handleDeleteSchedule(s)}
                    className="p-2 min-w-[var(--touch-target-min)] min-h-[var(--touch-target-min)] text-text-muted hover:text-status-error hover:bg-status-error/10 rounded-md transition-colors flex items-center justify-center"
                    title="Delete"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
              <div className="flex items-center gap-4 text-[10px] text-text-muted">
                <span>Agent: <span className="text-text-secondary">{s.agent_name}</span></span>
                <span className="font-mono">{s.cron}</span>
                <span>{cronToHuman(s.cron)}</span>
                <span>{s.run_count} runs</span>
                {s.last_run && <span>Last: {formatDate(s.last_run)}</span>}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Schedule modal */}
      <Modal
        open={scheduleModalOpen}
        onClose={() => setScheduleModalOpen(false)}
        title={editingSchedule ? "Edit Schedule" : "New Schedule"}
      >
        <div className="mb-4">
          <label className="block text-xs font-medium text-text-secondary mb-1.5 uppercase tracking-wide">
            Agent <span className="text-accent">*</span>
          </label>
          <select
            value={schedForm.agent_name}
            onChange={(e) => setSchedForm({ ...schedForm, agent_name: e.target.value })}
            className="text-sm"
          >
            {agentsList.length === 0 && <option value="">No agents available</option>}
            {agentsList.map((a) => (
              <option key={a.name} value={a.name}>{a.name}</option>
            ))}
          </select>
        </div>
        <div className="mb-4">
          <label className="block text-xs font-medium text-text-secondary mb-1.5 uppercase tracking-wide">
            Task <span className="text-accent">*</span>
          </label>
          <input
            type="text"
            value={schedForm.task}
            onChange={(e) => setSchedForm({ ...schedForm, task: e.target.value })}
            placeholder="What should the agent do?"
            className="text-sm"
          />
        </div>
        <div className="mb-4">
          <label className="block text-xs font-medium text-text-secondary mb-1.5 uppercase tracking-wide">
            Cron Expression <span className="text-accent">*</span>
          </label>
          <input
            type="text"
            value={schedForm.cron}
            onChange={(e) => setSchedForm({ ...schedForm, cron: e.target.value })}
            placeholder="0 9 * * *"
            className="text-sm font-mono"
          />
          {schedForm.cron.trim() && (
            <p className="mt-1 text-[11px] text-accent">{cronToHuman(schedForm.cron)}</p>
          )}
        </div>
        <div className="flex justify-end gap-2 mt-5">
          <button className="btn btn-secondary text-xs" onClick={() => setScheduleModalOpen(false)}>
            Cancel
          </button>
          <button
            className="btn btn-primary text-xs"
            disabled={!schedForm.agent_name || !schedForm.task.trim() || !schedForm.cron.trim() || schedLoading}
            onClick={() => void handleSaveSchedule()}
          >
            {schedLoading ? "Saving..." : editingSchedule ? "Save" : "Create"}
          </button>
        </div>
      </Modal>
    </div>
  );

  /* ══════════════════════════════════════════════════════════════
     TAB 6: Webhooks
     ══════════════════════════════════════════════════════════════ */

  const webhooksQuery = useApiQuery<{ webhooks: WebhookItem[] }>(
    "/api/v1/webhooks",
    activeTab === "webhooks",
  );
  const webhooks = webhooksQuery.data?.webhooks ?? [];

  const [webhookModalOpen, setWebhookModalOpen] = useState(false);
  const [editingWebhook, setEditingWebhook] = useState<WebhookItem | null>(null);
  const [whForm, setWhForm] = useState({ name: "", url: "", events: [] as string[] });
  const [whLoading, setWhLoading] = useState(false);
  const [expandedDeliveries, setExpandedDeliveries] = useState<Record<string, WebhookDelivery[]>>({});
  const [testResults, setTestResults] = useState<Record<string, "success" | "fail" | "loading">>({});

  const openNewWebhook = () => {
    setEditingWebhook(null);
    setWhForm({ name: "", url: "", events: [] });
    setWebhookModalOpen(true);
  };

  const openEditWebhook = (wh: WebhookItem) => {
    setEditingWebhook(wh);
    setWhForm({ name: wh.name, url: wh.url, events: [...wh.events] });
    setWebhookModalOpen(true);
  };

  const toggleWhEvent = (evt: string) => {
    setWhForm((f) => ({
      ...f,
      events: f.events.includes(evt) ? f.events.filter((e) => e !== evt) : [...f.events, evt],
    }));
  };

  const handleSaveWebhook = async () => {
    if (!whForm.name.trim() || !whForm.url.trim()) return;
    setWhLoading(true);
    try {
      if (editingWebhook) {
        await apiPut(`/api/v1/webhooks/${editingWebhook.id}`, whForm);
        showToast("Webhook updated", "success");
      } else {
        await apiPost("/api/v1/webhooks", whForm);
        showToast("Webhook created", "success");
      }
      setWebhookModalOpen(false);
      void webhooksQuery.refetch();
    } catch {
      showToast("Failed to save webhook", "error");
    } finally {
      setWhLoading(false);
    }
  };

  const handleDeleteWebhook = (wh: WebhookItem) => {
    confirm(
      "Delete Webhook",
      `Delete webhook "${wh.name}"? This cannot be undone.`,
      async () => {
        await apiDelete(`/api/v1/webhooks/${wh.id}`);
        showToast("Webhook deleted", "success");
        void webhooksQuery.refetch();
      },
      { label: "Delete", destructive: true },
    );
  };

  const handleTestWebhook = async (wh: WebhookItem) => {
    setTestResults((r) => ({ ...r, [wh.id]: "loading" }));
    try {
      await apiPost(`/api/v1/webhooks/${wh.id}/test`);
      setTestResults((r) => ({ ...r, [wh.id]: "success" }));
    } catch {
      setTestResults((r) => ({ ...r, [wh.id]: "fail" }));
    }
  };

  const handleLoadDeliveries = async (wh: WebhookItem) => {
    if (expandedDeliveries[wh.id]) {
      setExpandedDeliveries((d) => { const next = { ...d }; delete next[wh.id]; return next; });
      return;
    }
    try {
      const result = await apiGet<{ deliveries: WebhookDelivery[] }>(`/api/v1/webhooks/${wh.id}/deliveries`);
      setExpandedDeliveries((d) => ({ ...d, [wh.id]: result.deliveries ?? [] }));
    } catch {
      showToast("Failed to load deliveries", "error");
    }
  };

  const handleReplayDelivery = async (whId: string, deliveryId: string) => {
    try {
      await apiPost(`/api/v1/webhooks/${whId}/deliveries/${deliveryId}/replay`);
      showToast("Delivery replayed", "success");
    } catch {
      showToast("Replay failed", "error");
    }
  };

  const webhooksContent = (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-text-primary">Webhooks</h2>
        <button className="btn btn-primary text-xs" onClick={openNewWebhook}>
          <Webhook size={12} /> New Webhook
        </button>
      </div>

      {webhooksQuery.loading ? (
        <div className="card flex items-center justify-center py-12">
          <RefreshCw size={16} className="animate-spin text-accent mr-2" />
          <span className="text-sm text-text-muted">Loading webhooks...</span>
        </div>
      ) : webhooks.length === 0 ? (
        <EmptyState
          icon={<Webhook size={40} />}
          title="No webhooks configured"
          description="Set up webhooks to receive real-time event notifications"
          action={
            <button className="btn btn-primary text-xs mt-2" onClick={openNewWebhook}>
              <Plus size={12} /> New Webhook
            </button>
          }
        />
      ) : (
        <div className="space-y-2">
          {webhooks.map((wh) => {
            const testStatus = testResults[wh.id];
            const deliveries = expandedDeliveries[wh.id];
            return (
              <div key={wh.id} className="card card-hover py-3 px-4">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-medium text-text-primary">{wh.name}</span>
                    <span className="text-xs text-text-muted font-mono truncate max-w-[200px]">{wh.url}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => void handleTestWebhook(wh)}
                      className={`px-2.5 py-1 text-[10px] font-medium rounded border transition-colors min-h-[var(--touch-target-min)] ${
                        testStatus === "success"
                          ? "bg-status-live/10 text-status-live border-status-live/20"
                          : testStatus === "fail"
                            ? "bg-status-error/10 text-status-error border-status-error/20"
                            : "bg-surface-overlay text-text-secondary border-border-default hover:border-border-strong"
                      }`}
                      disabled={testStatus === "loading"}
                    >
                      {testStatus === "loading" ? "Testing..." : testStatus === "success" ? "Pass" : testStatus === "fail" ? "Failed" : "Test"}
                    </button>
                    <button
                      onClick={() => void handleLoadDeliveries(wh)}
                      className="p-2 min-w-[var(--touch-target-min)] min-h-[var(--touch-target-min)] text-text-muted hover:text-accent hover:bg-surface-overlay rounded-md transition-colors flex items-center justify-center"
                      title="Deliveries"
                    >
                      {deliveries ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    </button>
                    <button
                      onClick={() => openEditWebhook(wh)}
                      className="p-2 min-w-[var(--touch-target-min)] min-h-[var(--touch-target-min)] text-text-muted hover:text-accent hover:bg-surface-overlay rounded-md transition-colors flex items-center justify-center"
                      title="Edit"
                    >
                      <ChevronRight size={14} />
                    </button>
                    <button
                      onClick={() => handleDeleteWebhook(wh)}
                      className="p-2 min-w-[var(--touch-target-min)] min-h-[var(--touch-target-min)] text-text-muted hover:text-status-error hover:bg-status-error/10 rounded-md transition-colors flex items-center justify-center"
                      title="Delete"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <div className="flex flex-wrap gap-1">
                    {wh.events.map((e) => <Pill key={e}>{e}</Pill>)}
                  </div>
                  <span className="text-[10px] text-text-muted ml-auto">{wh.delivery_count} deliveries</span>
                  {wh.fail_count > 0 && (
                    <span className="text-[10px] text-status-error">{wh.fail_count} failures</span>
                  )}
                </div>

                {/* Expanded deliveries */}
                {deliveries && (
                  <div className="mt-3 pt-3 border-t border-border-default">
                    {deliveries.length === 0 ? (
                      <p className="text-xs text-text-muted">No recent deliveries</p>
                    ) : (
                      <div className="space-y-1">
                        {deliveries.map((d) => (
                          <div key={d.delivery_id} className="flex items-center justify-between py-1.5 px-2 rounded bg-surface-base">
                            <div className="flex items-center gap-3">
                              <span className="text-[10px] font-mono text-text-muted">{d.delivery_id.slice(0, 8)}</span>
                              <span
                                className={`text-[10px] font-medium uppercase ${
                                  d.status === "success" ? "text-status-live" : "text-status-error"
                                }`}
                              >
                                {d.status}
                              </span>
                              <span className="text-[10px] text-text-muted">{formatDate(d.timestamp)}</span>
                            </div>
                            <button
                              onClick={() => void handleReplayDelivery(wh.id, d.delivery_id)}
                              className="px-2 py-0.5 text-[10px] text-text-muted hover:text-accent border border-border-default rounded hover:border-border-strong transition-colors"
                            >
                              Replay
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Webhook modal */}
      <Modal
        open={webhookModalOpen}
        onClose={() => setWebhookModalOpen(false)}
        title={editingWebhook ? "Edit Webhook" : "New Webhook"}
      >
        <div className="mb-4">
          <label className="block text-xs font-medium text-text-secondary mb-1.5 uppercase tracking-wide">
            Name <span className="text-accent">*</span>
          </label>
          <input
            type="text"
            value={whForm.name}
            onChange={(e) => setWhForm({ ...whForm, name: e.target.value })}
            placeholder="deploy-notifier"
            className="text-sm"
          />
        </div>
        <div className="mb-4">
          <label className="block text-xs font-medium text-text-secondary mb-1.5 uppercase tracking-wide">
            URL <span className="text-accent">*</span>
          </label>
          <input
            type="url"
            value={whForm.url}
            onChange={(e) => setWhForm({ ...whForm, url: e.target.value })}
            placeholder="https://hooks.example.com/..."
            className="text-sm font-mono"
          />
        </div>
        <div className="mb-4">
          <label className="block text-xs font-medium text-text-secondary mb-1.5 uppercase tracking-wide">
            Event Types
          </label>
          <div className="space-y-2">
            {WEBHOOK_EVENTS.map((evt) => {
              const checked = whForm.events.includes(evt);
              return (
                <label
                  key={evt}
                  className={`flex items-center gap-2 px-2.5 py-2 rounded border text-xs cursor-pointer transition-colors ${
                    checked
                      ? "bg-accent-muted border-accent/30 text-accent"
                      : "bg-surface-base border-border-default text-text-secondary hover:border-border-strong"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleWhEvent(evt)}
                    className="sr-only"
                  />
                  <span
                    className={`w-3.5 h-3.5 rounded border flex items-center justify-center flex-shrink-0 ${
                      checked ? "bg-accent border-accent" : "border-border-strong bg-surface-base"
                    }`}
                  >
                    {checked && <Check size={10} className="text-text-inverse" />}
                  </span>
                  <span className="font-mono">{evt}</span>
                </label>
              );
            })}
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-5">
          <button className="btn btn-secondary text-xs" onClick={() => setWebhookModalOpen(false)}>
            Cancel
          </button>
          <button
            className="btn btn-primary text-xs"
            disabled={!whForm.name.trim() || !whForm.url.trim() || whLoading}
            onClick={() => void handleSaveWebhook()}
          >
            {whLoading ? "Saving..." : editingWebhook ? "Save" : "Create"}
          </button>
        </div>
      </Modal>
    </div>
  );

  /* ══════════════════════════════════════════════════════════════
     TAB 7: Secrets
     ══════════════════════════════════════════════════════════════ */

  const secretsQuery = useApiQuery<{ secrets: SecretItem[] }>(
    "/api/v1/secrets",
    activeTab === "secrets",
  );
  const secrets = secretsQuery.data?.secrets ?? [];

  const [secretName, setSecretName] = useState("");
  const [secretValue, setSecretValue] = useState("");
  const [secretLoading, setSecretLoading] = useState(false);
  const [addSecretOpen, setAddSecretOpen] = useState(false);
  const [rotatedSecretValue, setRotatedSecretValue] = useState<string | null>(null);

  const handleAddSecret = async () => {
    if (!secretName.trim() || !secretValue.trim()) return;
    setSecretLoading(true);
    try {
      await apiPost("/api/v1/secrets", { name: secretName, value: secretValue });
      showToast("Secret added", "success");
      setSecretName("");
      setSecretValue("");
      setAddSecretOpen(false);
      void secretsQuery.refetch();
    } catch {
      showToast("Failed to add secret", "error");
    } finally {
      setSecretLoading(false);
    }
  };

  const handleRotateSecret = (s: SecretItem) => {
    confirm(
      "Rotate Secret",
      `Rotate "${s.name}"? A new value will be generated. The old value will stop working immediately.`,
      async () => {
        const result = await apiPost<{ value: string }>(`/api/v1/secrets/${s.name}/rotate`);
        setRotatedSecretValue(result.value);
        showToast("Secret rotated — copy the new value now", "success");
        void secretsQuery.refetch();
      },
      { label: "Rotate", destructive: false },
    );
  };

  const handleDeleteSecret = (s: SecretItem) => {
    confirm(
      "Delete Secret",
      `Delete secret "${s.name}"? This cannot be undone. Any agents using this secret will lose access.`,
      async () => {
        await apiDelete(`/api/v1/secrets/${s.name}`);
        showToast("Secret deleted", "success");
        void secretsQuery.refetch();
      },
      { label: "Delete", destructive: true },
    );
  };

  const secretsContent = (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-text-primary">Secrets</h2>
        <button className="btn btn-primary text-xs" onClick={() => setAddSecretOpen(true)}>
          <Lock size={12} /> Add Secret
        </button>
      </div>

      {secretsQuery.loading ? (
        <div className="card flex items-center justify-center py-12">
          <RefreshCw size={16} className="animate-spin text-accent mr-2" />
          <span className="text-sm text-text-muted">Loading secrets...</span>
        </div>
      ) : secrets.length === 0 && !addSecretOpen ? (
        <EmptyState
          icon={<Lock size={40} />}
          title="No secrets stored"
          description="Add encrypted secrets for your agents to use"
          action={
            <button className="btn btn-primary text-xs mt-2" onClick={() => setAddSecretOpen(true)}>
              <Plus size={12} /> Add Secret
            </button>
          }
        />
      ) : (
        <div className="space-y-2">
          {secrets.map((s) => (
            <div key={s.name} className="card card-hover py-3 px-4 flex items-center justify-between">
              <div className="flex items-center gap-4">
                <Shield size={14} className="text-text-muted flex-shrink-0" />
                <div>
                  <p className="text-sm font-medium text-text-primary font-mono">{s.name}</p>
                  <p className="text-xs text-text-muted">
                    {"••••••••"}{s.last4} &middot; Created {formatDate(s.created_at)}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => handleRotateSecret(s)}
                  className="p-2 min-w-[var(--touch-target-min)] min-h-[var(--touch-target-min)] text-text-muted hover:text-accent hover:bg-surface-overlay rounded-md transition-colors flex items-center justify-center"
                  title="Rotate"
                >
                  <RefreshCw size={14} />
                </button>
                <button
                  onClick={() => handleDeleteSecret(s)}
                  className="p-2 min-w-[var(--touch-target-min)] min-h-[var(--touch-target-min)] text-text-muted hover:text-status-error hover:bg-status-error/10 rounded-md transition-colors flex items-center justify-center"
                  title="Delete"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add secret inline form */}
      {addSecretOpen && (
        <div className="card mt-3">
          <h4 className="text-xs font-semibold text-text-secondary uppercase tracking-wide mb-3">
            Add New Secret
          </h4>
          <div className="grid grid-cols-2 gap-3 mb-3">
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1 uppercase tracking-wide">Name</label>
              <input
                type="text"
                value={secretName}
                onChange={(e) => setSecretName(e.target.value)}
                placeholder="MY_API_KEY"
                className="text-sm font-mono"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1 uppercase tracking-wide">Value</label>
              <input
                type="password"
                value={secretValue}
                onChange={(e) => setSecretValue(e.target.value)}
                placeholder="Enter secret value"
                className="text-sm"
              />
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <button className="btn btn-secondary text-xs" onClick={() => { setAddSecretOpen(false); setSecretName(""); setSecretValue(""); }}>
              Cancel
            </button>
            <button
              className="btn btn-primary text-xs"
              disabled={!secretName.trim() || !secretValue.trim() || secretLoading}
              onClick={() => void handleAddSecret()}
            >
              {secretLoading ? "Saving..." : "Save"}
            </button>
          </div>
        </div>
      )}

      {/* Rotated secret reveal */}
      <Modal open={!!rotatedSecretValue} onClose={() => setRotatedSecretValue(null)} title="Secret Rotated">
        <div className="rounded-lg border border-status-warning/30 bg-status-warning/10 p-3 mb-4">
          <p className="text-xs text-status-warning font-medium flex items-center gap-1.5">
            <AlertTriangle size={12} /> Copy this value now — it won't be shown again
          </p>
        </div>
        <div className="flex items-center gap-2 p-3 bg-surface-base border border-border-default rounded-lg">
          <code className="text-xs font-mono text-accent flex-1 break-all select-all">{rotatedSecretValue}</code>
          <button
            className="p-2 min-w-[var(--touch-target-min)] min-h-[var(--touch-target-min)] text-text-muted hover:text-accent transition-colors flex items-center justify-center"
            onClick={() => { if (rotatedSecretValue) copyToClipboard(rotatedSecretValue); }}
          >
            <Copy size={14} />
          </button>
        </div>
        <div className="flex justify-end mt-4">
          <button className="btn btn-primary text-xs" onClick={() => setRotatedSecretValue(null)}>Done</button>
        </div>
      </Modal>

      {/* Note */}
      {secrets.length > 0 && (
        <p className="text-[10px] text-text-muted mt-4 flex items-center gap-1.5">
          <Shield size={10} /> Values are encrypted at rest (AES-256). Only names and creation dates are visible.
        </p>
      )}
    </div>
  );

  /* ══════════════════════════════════════════════════════════════
     TAB 8: Projects
     ══════════════════════════════════════════════════════════════ */

  const projectsQuery = useApiQuery<{ projects: Project[] }>(
    "/api/v1/projects",
    activeTab === "projects",
  );
  const projects = projectsQuery.data?.projects ?? [];

  const [projectModalOpen, setProjectModalOpen] = useState(false);
  const [projName, setProjName] = useState("");
  const [projDesc, setProjDesc] = useState("");
  const [projLoading, setProjLoading] = useState(false);

  const handleCreateProject = async () => {
    if (!projName.trim()) return;
    setProjLoading(true);
    try {
      await apiPost("/api/v1/projects", { name: projName, description: projDesc });
      showToast("Project created", "success");
      setProjectModalOpen(false);
      setProjName("");
      setProjDesc("");
      void projectsQuery.refetch();
    } catch {
      showToast("Failed to create project", "error");
    } finally {
      setProjLoading(false);
    }
  };

  const envBadgeClass = (env: string) => {
    switch (env) {
      case "prod": return "bg-status-live/10 text-status-live border-status-live/20";
      case "staging": return "bg-status-warning/10 text-status-warning border-status-warning/20";
      default: return "bg-status-info/10 text-status-info border-status-info/20";
    }
  };

  const projectsContent = (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-text-primary">Projects</h2>
        <button className="btn btn-primary text-xs" onClick={() => { setProjName(""); setProjDesc(""); setProjectModalOpen(true); }}>
          <FolderKanban size={12} /> New Project
        </button>
      </div>

      {projectsQuery.loading ? (
        <div className="card flex items-center justify-center py-12">
          <RefreshCw size={16} className="animate-spin text-accent mr-2" />
          <span className="text-sm text-text-muted">Loading projects...</span>
        </div>
      ) : projects.length === 0 ? (
        <EmptyState
          icon={<FolderKanban size={40} />}
          title="No projects yet"
          description="Create a project to organize your agents by team or product"
          action={
            <button className="btn btn-primary text-xs mt-2" onClick={() => setProjectModalOpen(true)}>
              <Plus size={12} /> New Project
            </button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {projects.map((p) => (
            <div key={p.id} className="card card-hover">
              <div className="flex items-start justify-between mb-3">
                <div>
                  <p className="text-sm font-semibold text-text-primary">{p.name}</p>
                  {p.description && (
                    <p className="text-xs text-text-muted mt-0.5 line-clamp-2">{p.description}</p>
                  )}
                </div>
                <span className="text-xs text-text-muted whitespace-nowrap ml-3">{p.agent_count} agent{p.agent_count !== 1 ? "s" : ""}</span>
              </div>
              <div className="flex items-center gap-2 mb-3">
                {(p.environments ?? []).map((env) => (
                  <span
                    key={env}
                    className={`inline-flex items-center px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide rounded-full border ${envBadgeClass(env)}`}
                  >
                    {env}
                  </span>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <button className="btn btn-secondary text-xs flex-1">
                  Manage
                </button>
                <a href="/agents" className="btn btn-ghost text-xs flex-1 text-center">
                  Open Canvas <Play size={10} />
                </a>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create project modal */}
      <Modal open={projectModalOpen} onClose={() => setProjectModalOpen(false)} title="New Project">
        <div className="mb-4">
          <label className="block text-xs font-medium text-text-secondary mb-1.5 uppercase tracking-wide">
            Name <span className="text-accent">*</span>
          </label>
          <input
            type="text"
            value={projName}
            onChange={(e) => setProjName(e.target.value)}
            placeholder="my-project"
            className="text-sm"
          />
        </div>
        <div className="mb-4">
          <label className="block text-xs font-medium text-text-secondary mb-1.5 uppercase tracking-wide">
            Description
          </label>
          <textarea
            value={projDesc}
            onChange={(e) => setProjDesc(e.target.value)}
            placeholder="What is this project for?"
            className="text-sm"
            rows={3}
          />
        </div>
        <div className="flex justify-end gap-2 mt-5">
          <button className="btn btn-secondary text-xs" onClick={() => setProjectModalOpen(false)}>
            Cancel
          </button>
          <button
            className="btn btn-primary text-xs"
            disabled={!projName.trim() || projLoading}
            onClick={() => void handleCreateProject()}
          >
            {projLoading ? "Creating..." : "Create"}
          </button>
        </div>
      </Modal>
    </div>
  );

  /* ══════════════════════════════════════════════════════════════
     Tab content map
     ══════════════════════════════════════════════════════════════ */

  const tabContent: Record<TabId, React.ReactNode> = {
    team: teamContent,
    "api-keys": apiKeysContent,
    billing: billingContent,
    integrations: integrationsContent,
    schedules: schedulesContent,
    webhooks: webhooksContent,
    secrets: secretsContent,
    projects: projectsContent,
  };

  /* ══════════════════════════════════════════════════════════════
     Render
     ══════════════════════════════════════════════════════════════ */

  return (
    <div>
      <PageHeader
        title="Settings"
        subtitle="Team management, API keys, billing, and platform configuration"
      />

      {/* Tab bar */}
      <div className="flex items-center gap-0 border-b border-border-default mb-6 overflow-x-auto">
        {TAB_IDS.map((tabId) => (
          <button
            key={tabId}
            onClick={() => setTab(tabId)}
            className={`px-4 py-2.5 text-xs font-medium transition-colors border-b-2 -mb-px whitespace-nowrap ${
              activeTab === tabId
                ? "text-accent border-accent"
                : "text-text-muted border-transparent hover:text-text-secondary hover:border-border-strong"
            }`}
          >
            {TAB_LABELS[tabId]}
          </button>
        ))}
      </div>

      {/* Active tab content */}
      {tabContent[activeTab] ?? tabContent.team}

      {/* Global confirm dialog */}
      {confirmState.open && (
        <ConfirmDialog
          title={confirmState.title}
          description={confirmState.message}
          confirmLabel={confirmState.confirmLabel}
          tone={confirmState.destructive ? "danger" : "default"}
          onConfirm={() => void handleConfirm()}
          onCancel={() => setConfirmState((s) => ({ ...s, open: false }))}
        />
      )}
    </div>
  );
};
