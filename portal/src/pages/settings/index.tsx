import { useMemo, useState } from "react";
import { Plus, Settings, Users, Key, Trash2, Copy, Eye, EyeOff, RefreshCw, UserPlus } from "lucide-react";

import { PageHeader } from "../../components/common/PageHeader";
import { QueryState } from "../../components/common/QueryState";
import { FormField } from "../../components/common/FormField";
import { SlidePanel } from "../../components/common/SlidePanel";
import { StatusBadge } from "../../components/common/StatusBadge";
import { EmptyState } from "../../components/common/EmptyState";
import { ActionMenu, type ActionMenuItem } from "../../components/common/ActionMenu";
import { ConfirmDialog } from "../../components/common/ConfirmDialog";
import { Tabs } from "../../components/common/Tabs";
import { useToast } from "../../components/common/ToastProvider";
import { apiRequest, useApiQuery } from "../../lib/api";

type TeamMember = { user_id: string; name: string; email: string; role: string; joined_at?: string };
type ApiKey = { key_id: string; name: string; prefix: string; created_at?: string; last_used?: string; scopes?: string[] };

export const SettingsPage = () => {
  const { showToast } = useToast();
  const teamQuery = useApiQuery<{ members: TeamMember[] }>("/api/v1/team/members");
  const keysQuery = useApiQuery<{ keys: ApiKey[] }>("/api/v1/api-keys");
  const members = useMemo(() => teamQuery.data?.members ?? [], [teamQuery.data]);
  const keys = useMemo(() => keysQuery.data?.keys ?? [], [keysQuery.data]);

  /* ── Invite member panel ──────────────────────────────────── */
  const [invitePanelOpen, setInvitePanelOpen] = useState(false);
  const [inviteForm, setInviteForm] = useState({ email: "", role: "member" });

  /* ── API key panel ────────────────────────────────────────── */
  const [keyPanelOpen, setKeyPanelOpen] = useState(false);
  const [keyForm, setKeyForm] = useState({ name: "", scopes: "read,write" });
  const [newKeyValue, setNewKeyValue] = useState("");
  const [showKeyValues, setShowKeyValues] = useState<Record<string, boolean>>({});

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmAction, setConfirmAction] = useState<{ title: string; desc: string; action: () => Promise<void> } | null>(null);

  /* ── Password change state ────────────────────────────────── */
  const [passwordForm, setPasswordForm] = useState({ current_password: "", new_password: "", confirm_password: "" });
  const [passwordLoading, setPasswordLoading] = useState(false);

  const handleInvite = async () => {
    if (!inviteForm.email.trim()) return;
    try {
      await apiRequest("/api/v1/team/invite", "POST", inviteForm);
      showToast(`Invitation sent to ${inviteForm.email}`, "success");
      setInvitePanelOpen(false);
      void teamQuery.refetch();
    } catch { showToast("Invite failed", "error"); }
  };

  const handleRemoveMember = (m: TeamMember) => {
    setConfirmAction({ title: "Remove Member", desc: `Remove ${m.name} (${m.email}) from the team?`, action: async () => {
      await apiRequest(`/api/v1/team/members/${m.user_id}`, "DELETE");
      showToast("Member removed", "success");
      void teamQuery.refetch();
    }});
    setConfirmOpen(true);
  };

  const handleCreateKey = async () => {
    if (!keyForm.name.trim()) return;
    try {
      const result = await apiRequest<{ key?: string }>("/api/v1/api-keys", "POST", {
        name: keyForm.name,
        scopes: keyForm.scopes.split(",").map((s) => s.trim()),
      });
      setNewKeyValue(result.key ?? "sk-...");
      showToast("API key created", "success");
      void keysQuery.refetch();
    } catch { showToast("Failed to create key", "error"); }
  };

  const handleRevokeKey = (k: ApiKey) => {
    setConfirmAction({ title: "Revoke API Key", desc: `Revoke "${k.name}" (${k.prefix}...)? This cannot be undone.`, action: async () => {
      await apiRequest(`/api/v1/api-keys/${k.key_id}`, "DELETE");
      showToast("Key revoked", "success");
      void keysQuery.refetch();
    }});
    setConfirmOpen(true);
  };

  const handleRotateKey = (k: ApiKey) => {
    setConfirmAction({ title: "Rotate API Key", desc: `Rotate "${k.name}" (${k.prefix}...)? The old key will stop working immediately.`, action: async () => {
      const result = await apiRequest<{ key?: string }>(`/api/v1/api-keys/${k.key_id}/rotate`, "POST");
      const newKey = result.key ?? "sk-...";
      setNewKeyValue(newKey);
      setKeyPanelOpen(true);
      showToast("Key rotated — copy the new key now", "success");
      void keysQuery.refetch();
    }});
    setConfirmOpen(true);
  };

  const handleChangePassword = async () => {
    if (!passwordForm.current_password || !passwordForm.new_password) {
      showToast("Please fill in both current and new password", "error");
      return;
    }
    if (passwordForm.new_password !== passwordForm.confirm_password) {
      showToast("New passwords do not match", "error");
      return;
    }
    if (passwordForm.new_password.length < 8) {
      showToast("New password must be at least 8 characters", "error");
      return;
    }
    setPasswordLoading(true);
    try {
      await apiRequest("/api/v1/auth/password", "POST", {
        current_password: passwordForm.current_password,
        new_password: passwordForm.new_password,
      });
      showToast("Password changed successfully", "success");
      setPasswordForm({ current_password: "", new_password: "", confirm_password: "" });
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to change password", "error");
    } finally {
      setPasswordLoading(false);
    }
  };

  const copyToClipboard = (text: string) => {
    void navigator.clipboard.writeText(text);
    showToast("Copied to clipboard", "success");
  };

  const getMemberActions = (m: TeamMember): ActionMenuItem[] => [
    { label: "Remove", icon: <Trash2 size={12} />, onClick: () => handleRemoveMember(m), danger: true },
  ];

  const getKeyActions = (k: ApiKey): ActionMenuItem[] => [
    { label: "Copy Prefix", icon: <Copy size={12} />, onClick: () => copyToClipboard(k.prefix) },
    { label: "Rotate", icon: <RefreshCw size={12} />, onClick: () => handleRotateKey(k) },
    { label: "Revoke", icon: <Trash2 size={12} />, onClick: () => handleRevokeKey(k), danger: true },
  ];

  /* ── Team tab ─────────────────────────────────────────────── */
  const teamTab = (
    <div>
      <div className="flex items-center justify-end mb-4">
        <button className="btn btn-primary text-xs" onClick={() => { setInviteForm({ email: "", role: "member" }); setInvitePanelOpen(true); }}>
          <UserPlus size={12} /> Invite Member
        </button>
      </div>
      <QueryState loading={teamQuery.loading} error={teamQuery.error} isEmpty={members.length === 0} emptyMessage="">
        {members.length === 0 ? (
          <EmptyState icon={<Users size={40} />} title="No team members" description="Invite members to collaborate" />
        ) : (
          <div className="card p-0"><div className="overflow-x-auto">
            <table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Joined</th><th style={{ width: "48px" }}></th></tr></thead>
              <tbody>{members.map((m) => (
                <tr key={m.user_id}>
                  <td><span className="text-text-primary text-sm">{m.name}</span></td>
                  <td><span className="text-text-muted text-xs">{m.email}</span></td>
                  <td><StatusBadge status={m.role} /></td>
                  <td><span className="text-[10px] text-text-muted">{m.joined_at ? new Date(m.joined_at).toLocaleDateString() : "--"}</span></td>
                  <td><ActionMenu items={getMemberActions(m)} /></td>
                </tr>
              ))}</tbody>
            </table>
          </div></div>
        )}
      </QueryState>
    </div>
  );

  /* ── API Keys tab ─────────────────────────────────────────── */
  const keysTab = (
    <div>
      <div className="flex items-center justify-end mb-4">
        <button className="btn btn-primary text-xs" onClick={() => { setKeyForm({ name: "", scopes: "read,write" }); setNewKeyValue(""); setKeyPanelOpen(true); }}>
          <Plus size={12} /> New API Key
        </button>
      </div>
      <QueryState loading={keysQuery.loading} error={keysQuery.error} isEmpty={keys.length === 0} emptyMessage="">
        {keys.length === 0 ? (
          <EmptyState icon={<Key size={40} />} title="No API keys" description="Create an API key to access the platform programmatically" />
        ) : (
          <div className="card p-0"><div className="overflow-x-auto">
            <table><thead><tr><th>Name</th><th>Key</th><th>Scopes</th><th>Last Used</th><th style={{ width: "48px" }}></th></tr></thead>
              <tbody>{keys.map((k) => (
                <tr key={k.key_id}>
                  <td><span className="text-text-primary text-sm">{k.name}</span></td>
                  <td>
                    <div className="flex items-center gap-1">
                      <span className="font-mono text-xs text-text-muted">{showKeyValues[k.key_id] ? k.prefix + "..." : "sk-••••••••"}</span>
                      <button className="p-0.5 text-text-muted hover:text-text-primary" onClick={() => setShowKeyValues({ ...showKeyValues, [k.key_id]: !showKeyValues[k.key_id] })}>
                        {showKeyValues[k.key_id] ? <EyeOff size={10} /> : <Eye size={10} />}
                      </button>
                    </div>
                  </td>
                  <td><div className="flex flex-wrap gap-1">{(k.scopes ?? []).map((s) => <span key={s} className="px-1.5 py-0.5 text-[10px] bg-surface-overlay text-text-muted rounded border border-border-default">{s}</span>)}</div></td>
                  <td><span className="text-[10px] text-text-muted">{k.last_used ? new Date(k.last_used).toLocaleDateString() : "Never"}</span></td>
                  <td><ActionMenu items={getKeyActions(k)} /></td>
                </tr>
              ))}</tbody>
            </table>
          </div></div>
        )}
      </QueryState>
    </div>
  );

  /* ── Profile tab ──────────────────────────────────────────── */
  const profileTab = (
    <div className="max-w-lg">
      <div className="card">
        <h3 className="text-sm font-semibold text-text-primary mb-4">Profile Settings</h3>
        <FormField label="Display Name"><input type="text" defaultValue="Dev User" className="text-sm" /></FormField>
        <FormField label="Email"><input type="email" defaultValue="dev@oneshots.co" className="text-sm" disabled /></FormField>
        <FormField label="Timezone">
          <select defaultValue="America/New_York" className="text-sm">
            <option value="America/New_York">Eastern (ET)</option>
            <option value="America/Chicago">Central (CT)</option>
            <option value="America/Denver">Mountain (MT)</option>
            <option value="America/Los_Angeles">Pacific (PT)</option>
            <option value="UTC">UTC</option>
          </select>
        </FormField>
        <div className="flex justify-end mt-4">
          <button className="btn btn-primary text-xs" onClick={() => showToast("Profile saved", "success")}>Save Changes</button>
        </div>
      </div>

      {/* Password change */}
      <div className="card mt-4">
        <h3 className="text-sm font-semibold text-text-primary mb-4">Change Password</h3>
        <FormField label="Current Password" required>
          <input
            type="password"
            value={passwordForm.current_password}
            onChange={(e) => setPasswordForm({ ...passwordForm, current_password: e.target.value })}
            placeholder="Enter current password"
            className="text-sm"
          />
        </FormField>
        <FormField label="New Password" required>
          <input
            type="password"
            value={passwordForm.new_password}
            onChange={(e) => setPasswordForm({ ...passwordForm, new_password: e.target.value })}
            placeholder="Enter new password"
            className="text-sm"
          />
        </FormField>
        <FormField label="Confirm New Password" required>
          <input
            type="password"
            value={passwordForm.confirm_password}
            onChange={(e) => setPasswordForm({ ...passwordForm, confirm_password: e.target.value })}
            placeholder="Confirm new password"
            className="text-sm"
          />
        </FormField>
        <div className="flex justify-end mt-4">
          <button
            className="btn btn-primary text-xs"
            disabled={passwordLoading}
            onClick={() => void handleChangePassword()}
          >
            {passwordLoading ? "Changing..." : "Change Password"}
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <div>
      <PageHeader title="Settings" subtitle="Team management, API keys, and profile configuration" onRefresh={() => { void teamQuery.refetch(); void keysQuery.refetch(); }} />

      <Tabs tabs={[
        { id: "team", label: "Team", count: members.length, content: teamTab },
        { id: "keys", label: "API Keys", count: keys.length, content: keysTab },
        { id: "profile", label: "Profile", content: profileTab },
      ]} />

      {/* Invite panel */}
      <SlidePanel isOpen={invitePanelOpen} onClose={() => setInvitePanelOpen(false)} title="Invite Team Member"
        footer={<><button className="btn btn-secondary text-xs" onClick={() => setInvitePanelOpen(false)}>Cancel</button><button className="btn btn-primary text-xs" onClick={() => void handleInvite()}>Send Invite</button></>}>
        <FormField label="Email" required><input type="email" value={inviteForm.email} onChange={(e) => setInviteForm({ ...inviteForm, email: e.target.value })} placeholder="colleague@company.com" className="text-sm" /></FormField>
        <FormField label="Role">
          <select value={inviteForm.role} onChange={(e) => setInviteForm({ ...inviteForm, role: e.target.value })} className="text-sm">
            <option value="admin">Admin</option>
            <option value="member">Member</option>
            <option value="viewer">Viewer</option>
          </select>
        </FormField>
      </SlidePanel>

      {/* API key panel */}
      <SlidePanel isOpen={keyPanelOpen} onClose={() => setKeyPanelOpen(false)} title="Create API Key"
        footer={<><button className="btn btn-secondary text-xs" onClick={() => setKeyPanelOpen(false)}>Close</button>{!newKeyValue && <button className="btn btn-primary text-xs" onClick={() => void handleCreateKey()}>Create Key</button>}</>}>
        {newKeyValue ? (
          <div>
            <p className="text-xs text-text-muted mb-2">Copy your API key now. It will not be shown again.</p>
            <div className="flex items-center gap-2 p-3 bg-surface-base border border-border-default rounded-lg">
              <code className="text-xs font-mono text-accent flex-1 break-all">{newKeyValue}</code>
              <button className="p-1.5 text-text-muted hover:text-accent" onClick={() => copyToClipboard(newKeyValue)}><Copy size={14} /></button>
            </div>
          </div>
        ) : (
          <>
            <FormField label="Key Name" required><input type="text" value={keyForm.name} onChange={(e) => setKeyForm({ ...keyForm, name: e.target.value })} placeholder="production-key" className="text-sm" /></FormField>
            <FormField label="Scopes" hint="Comma-separated"><input type="text" value={keyForm.scopes} onChange={(e) => setKeyForm({ ...keyForm, scopes: e.target.value })} placeholder="read,write" className="text-sm font-mono" /></FormField>
          </>
        )}
      </SlidePanel>

      {confirmOpen && confirmAction && (
        <ConfirmDialog title={confirmAction.title} description={confirmAction.desc} confirmLabel="Confirm" tone="danger"
          onConfirm={async () => { try { await confirmAction.action(); } catch { showToast("Action failed", "error"); } setConfirmOpen(false); setConfirmAction(null); }}
          onCancel={() => { setConfirmOpen(false); setConfirmAction(null); }} />
      )}
    </div>
  );
};
