import { useMemo, useState } from "react";
import { Plus, Settings, Users, Key, Trash2, Copy, Eye, EyeOff, RefreshCw, UserPlus, Building2, Puzzle, ToggleLeft, ToggleRight, Pencil, Check, X } from "lucide-react";

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
type OrgMember = { user_id: string; name: string; email: string; role: string };
type Org = { org_id: string; name: string; slug: string; plan: string; member_count: number; members?: OrgMember[] };
type Skill = { name: string; description: string; version: string; category: string; enabled: boolean };

export const SettingsPage = () => {
  const { showToast } = useToast();
  const teamQuery = useApiQuery<{ members: TeamMember[] }>("/api/v1/team/members");
  const keysQuery = useApiQuery<{ keys: ApiKey[] }>("/api/v1/api-keys");
  const orgsQuery = useApiQuery<{ orgs: Org[] }>("/api/v1/orgs");
  const skillsQuery = useApiQuery<{ skills: Skill[] }>("/api/v1/skills");
  const members = useMemo(() => teamQuery.data?.members ?? [], [teamQuery.data]);
  const keys = useMemo(() => keysQuery.data?.keys ?? [], [keysQuery.data]);
  const orgs = useMemo(() => orgsQuery.data?.orgs ?? [], [orgsQuery.data]);
  const skills = useMemo(() => skillsQuery.data?.skills ?? [], [skillsQuery.data]);

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

  /* ── Org edit state ─────────────────────────────────────────── */
  const [editingOrgId, setEditingOrgId] = useState<string | null>(null);
  const [editingOrgName, setEditingOrgName] = useState("");
  const [orgLoading, setOrgLoading] = useState(false);

  /* ── Skills state ───────────────────────────────────────────── */
  const [skillsReloading, setSkillsReloading] = useState(false);

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

  /* ── Org handlers ────────────────────────────────────────────── */
  const handleUpdateOrgName = async (orgId: string) => {
    if (!editingOrgName.trim()) return;
    setOrgLoading(true);
    try {
      await apiRequest(`/api/v1/orgs/${orgId}`, "PUT", { name: editingOrgName });
      showToast("Organization updated", "success");
      setEditingOrgId(null);
      void orgsQuery.refetch();
    } catch { showToast("Failed to update organization", "error"); }
    finally { setOrgLoading(false); }
  };

  const handleMemberRoleChange = async (orgId: string, userId: string, newRole: string) => {
    try {
      await apiRequest(`/api/v1/orgs/${orgId}/members/${userId}`, "PUT", { role: newRole });
      showToast("Member role updated", "success");
      void orgsQuery.refetch();
    } catch { showToast("Failed to update member role", "error"); }
  };

  /* ── Skills handlers ────────────────────────────────────────── */
  const handleToggleSkill = async (skillName: string, enabled: boolean) => {
    try {
      await apiRequest(`/api/v1/skills/${encodeURIComponent(skillName)}`, "PUT", { enabled });
      showToast(`Skill ${enabled ? "enabled" : "disabled"}`, "success");
      void skillsQuery.refetch();
    } catch { showToast("Failed to update skill", "error"); }
  };

  const handleReloadSkills = async () => {
    setSkillsReloading(true);
    try {
      await apiRequest("/api/v1/skills/reload", "POST");
      showToast("Skills reloaded", "success");
      void skillsQuery.refetch();
    } catch { showToast("Failed to reload skills", "error"); }
    finally { setSkillsReloading(false); }
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

  /* ── Orgs tab ───────────────────────────────────────────────── */
  const orgsTab = (
    <div>
      <QueryState loading={orgsQuery.loading} error={orgsQuery.error} isEmpty={orgs.length === 0} emptyMessage="">
        {orgs.length === 0 ? (
          <EmptyState icon={<Building2 size={40} />} title="No organizations" description="You are not a member of any organization yet" />
        ) : (
          <div className="space-y-4">
            {orgs.map((org) => (
              <div key={org.org_id} className="card">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-3">
                    {editingOrgId === org.org_id ? (
                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          value={editingOrgName}
                          onChange={(e) => setEditingOrgName(e.target.value)}
                          className="text-sm px-2 py-1 bg-surface-base border border-border-default rounded"
                          autoFocus
                        />
                        <button disabled={orgLoading} className="p-1 text-status-live hover:text-status-live/80" onClick={() => void handleUpdateOrgName(org.org_id)}>
                          <Check size={14} />
                        </button>
                        <button className="p-1 text-text-muted hover:text-text-primary" onClick={() => setEditingOrgId(null)}>
                          <X size={14} />
                        </button>
                      </div>
                    ) : (
                      <>
                        <span className="text-sm font-semibold text-text-primary">{org.name}</span>
                        <button className="p-1 text-text-muted hover:text-text-primary" onClick={() => { setEditingOrgId(org.org_id); setEditingOrgName(org.name); }}>
                          <Pencil size={12} />
                        </button>
                      </>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    <StatusBadge status={org.plan} />
                    <span className="text-xs text-text-muted">{org.member_count} member{org.member_count !== 1 ? "s" : ""}</span>
                  </div>
                </div>
                <div className="text-xs text-text-muted mb-3">Slug: <code className="font-mono">{org.slug}</code></div>

                {org.members && org.members.length > 0 && (
                  <div className="border border-border-default rounded-lg overflow-hidden">
                    <table>
                      <thead><tr><th>Name</th><th>Email</th><th>Role</th></tr></thead>
                      <tbody>
                        {org.members.map((m) => (
                          <tr key={m.user_id}>
                            <td><span className="text-text-primary text-sm">{m.name}</span></td>
                            <td><span className="text-text-muted text-xs">{m.email}</span></td>
                            <td>
                              <select
                                value={m.role}
                                onChange={(e) => void handleMemberRoleChange(org.org_id, m.user_id, e.target.value)}
                                className="text-xs bg-surface-base border border-border-default rounded px-2 py-1"
                              >
                                <option value="owner">Owner</option>
                                <option value="admin">Admin</option>
                                <option value="member">Member</option>
                                <option value="viewer">Viewer</option>
                              </select>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </QueryState>
    </div>
  );

  /* ── Skills tab ──────────────────────────────────────────────── */
  const skillsTab = (
    <div>
      <div className="flex items-center justify-end mb-4">
        <button className="btn btn-primary text-xs" disabled={skillsReloading} onClick={() => void handleReloadSkills()}>
          <RefreshCw size={12} className={skillsReloading ? "animate-spin" : ""} /> {skillsReloading ? "Reloading..." : "Reload Skills"}
        </button>
      </div>
      <QueryState loading={skillsQuery.loading} error={skillsQuery.error} isEmpty={skills.length === 0} emptyMessage="">
        {skills.length === 0 ? (
          <EmptyState icon={<Puzzle size={40} />} title="No skills found" description="No skills are currently available" />
        ) : (
          <div className="card p-0"><div className="overflow-x-auto">
            <table>
              <thead><tr><th>Name</th><th>Description</th><th>Version</th><th>Category</th><th>Status</th><th style={{ width: "64px" }}>Toggle</th></tr></thead>
              <tbody>
                {skills.map((skill) => (
                  <tr key={skill.name}>
                    <td><span className="text-text-primary text-sm font-medium">{skill.name}</span></td>
                    <td><span className="text-text-muted text-xs">{skill.description}</span></td>
                    <td><span className="font-mono text-xs text-text-muted">{skill.version}</span></td>
                    <td><StatusBadge status={skill.category} /></td>
                    <td><StatusBadge status={skill.enabled ? "enabled" : "disabled"} /></td>
                    <td>
                      <button
                        onClick={() => void handleToggleSkill(skill.name, !skill.enabled)}
                        className={`p-1 transition-colors ${skill.enabled ? "text-status-live hover:text-status-live/80" : "text-text-muted hover:text-text-primary"}`}
                        title={skill.enabled ? "Disable skill" : "Enable skill"}
                      >
                        {skill.enabled ? <ToggleRight size={20} /> : <ToggleLeft size={20} />}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div></div>
        )}
      </QueryState>
    </div>
  );

  return (
    <div>
      <PageHeader title="Settings" subtitle="Team management, API keys, and profile configuration" onRefresh={() => { void teamQuery.refetch(); void keysQuery.refetch(); void orgsQuery.refetch(); void skillsQuery.refetch(); }} />

      <Tabs tabs={[
        { id: "team", label: "Team", count: members.length, content: teamTab },
        { id: "keys", label: "API Keys", count: keys.length, content: keysTab },
        { id: "orgs", label: "Organizations", count: orgs.length, content: orgsTab },
        { id: "skills", label: "Skills", count: skills.length, content: skillsTab },
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
