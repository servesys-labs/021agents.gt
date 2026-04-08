import { useMemo, useState } from "react";
import { Plus, Rocket, GitBranch, ArrowUpRight, Search, Eye, Trash2, Percent } from "lucide-react";

import { PageHeader } from "../../components/common/PageHeader";
import { FormField } from "../../components/common/FormField";
import { SlidePanel } from "../../components/common/SlidePanel";
import { StatusBadge } from "../../components/common/StatusBadge";
import { EmptyState } from "../../components/common/EmptyState";
import { ActionMenu, type ActionMenuItem } from "../../components/common/ActionMenu";
import { ConfirmDialog } from "../../components/common/ConfirmDialog";
import { Tabs } from "../../components/common/Tabs";
import { useToast } from "../../components/common/ToastProvider";
import { apiRequest, useApiQuery } from "../../lib/api";
import { extractList } from "../../lib/normalize";

type Channel = { channel_id: string; name: string; current_version?: string; traffic_pct?: number; status?: string };
type Release = { release_id: string; version: string; agent_name?: string; channel?: string; status?: string; created_at?: string; promoted_at?: string };

export const ReleasesPage = () => {
  const { showToast } = useToast();
  const channelsQuery = useApiQuery<{ channels: Channel[] } | Channel[]>("/api/v1/releases/channels");
  const releasesQuery = useApiQuery<{ releases: Release[] } | Release[]>("/api/v1/releases?limit=50");
  const channels = useMemo(() => extractList<Channel>(channelsQuery.data, "channels"), [channelsQuery.data]);
  const releases = useMemo(() => extractList<Release>(releasesQuery.data, "releases"), [releasesQuery.data]);

  const [search, setSearch] = useState("");
  const filteredReleases = search ? releases.filter((r) => (r.version + (r.agent_name ?? "")).toLowerCase().includes(search.toLowerCase())) : releases;

  /* ── Panels ───────────────────────────────────────────────── */
  const [channelPanelOpen, setChannelPanelOpen] = useState(false);
  const [channelForm, setChannelForm] = useState({ name: "" });
  const [promotePanelOpen, setPromotePanelOpen] = useState(false);
  const [promoteForm, setPromoteForm] = useState({ release_id: "", target_channel: "", traffic_pct: 100 });
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailItem, setDetailItem] = useState<unknown>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmAction, setConfirmAction] = useState<{ title: string; desc: string; action: () => Promise<void> } | null>(null);

  const handleCreateChannel = async () => {
    if (!channelForm.name.trim()) return;
    try {
      await apiRequest("/api/v1/releases/channels", "POST", channelForm);
      showToast(`Channel "${channelForm.name}" created`, "success");
      setChannelPanelOpen(false);
      void channelsQuery.refetch();
    } catch { showToast("Failed to create channel", "error"); }
  };

  const handlePromote = async () => {
    if (!promoteForm.release_id || !promoteForm.target_channel) return;
    try {
      await apiRequest(`/api/v1/releases/${promoteForm.release_id}/promote`, "POST", {
        channel: promoteForm.target_channel,
        traffic_pct: promoteForm.traffic_pct,
      });
      showToast("Release promoted", "success");
      setPromotePanelOpen(false);
      void releasesQuery.refetch();
      void channelsQuery.refetch();
    } catch { showToast("Promote failed", "error"); }
  };

  const handleDeleteChannel = (ch: Channel) => {
    setConfirmAction({ title: "Delete Channel", desc: `Delete channel "${ch.name}"?`, action: async () => {
      await apiRequest(`/api/v1/releases/channels/${ch.channel_id}`, "DELETE");
      showToast("Channel deleted", "success");
      void channelsQuery.refetch();
    }});
    setConfirmOpen(true);
  };

  const getChannelActions = (ch: Channel): ActionMenuItem[] => [
    { label: "View", icon: <Eye size={12} />, onClick: () => { setDetailItem(ch); setDetailOpen(true); } },
    { label: "Delete", icon: <Trash2 size={12} />, onClick: () => handleDeleteChannel(ch), danger: true },
  ];

  const getReleaseActions = (r: Release): ActionMenuItem[] => [
    { label: "Promote", icon: <ArrowUpRight size={12} />, onClick: () => { setPromoteForm({ release_id: r.release_id, target_channel: channels[0]?.name ?? "", traffic_pct: 100 }); setPromotePanelOpen(true); } },
    { label: "View", icon: <Eye size={12} />, onClick: () => { setDetailItem(r); setDetailOpen(true); } },
  ];

  /* ── Channels tab ─────────────────────────────────────────── */
  const channelsTab = (
    <div>
      <div className="flex items-center justify-end mb-4">
        <button className="btn btn-primary text-xs" onClick={() => { setChannelForm({ name: "" }); setChannelPanelOpen(true); }}>
          <Plus size={12} /> New Channel
        </button>
      </div>
      {channels.length === 0 ? (
        <EmptyState icon={<GitBranch size={40} />} title="No channels" description="Create release channels like production, staging, canary" />
      ) : (
        <div className="grid gap-3">
          {channels.map((ch) => (
            <div key={ch.channel_id} className="card flex items-center justify-between py-3">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-chart-purple/10"><GitBranch size={14} className="text-chart-purple" /></div>
                <div>
                  <p className="text-sm font-medium text-text-primary">{ch.name}</p>
                  <p className="text-[10px] text-text-muted font-mono">v{ch.current_version ?? "none"}</p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                {ch.traffic_pct !== undefined && (
                  <div className="flex items-center gap-1">
                    <Percent size={10} className="text-text-muted" />
                    <span className="text-xs text-text-muted font-mono">{ch.traffic_pct}%</span>
                  </div>
                )}
                <StatusBadge status={ch.status ?? "active"} />
                <ActionMenu items={getChannelActions(ch)} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  /* ── Releases tab ─────────────────────────────────────────── */
  const releasesTab = (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div className="relative flex-1 max-w-xs">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
          <input type="text" placeholder="Search releases..." value={search} onChange={(e) => setSearch(e.target.value)} className="pl-8 text-xs" />
        </div>
      </div>
      {filteredReleases.length === 0 ? (
        <EmptyState icon={<Rocket size={40} />} title="No releases" description="Deploy an agent to create a release" />
      ) : (
        <div className="card p-0"><div className="overflow-x-auto">
          <table><thead><tr><th>Version</th><th>Agent</th><th>Channel</th><th>Status</th><th>Created</th><th style={{ width: "48px" }}></th></tr></thead>
            <tbody>{filteredReleases.map((r) => (
              <tr key={r.release_id}>
                <td><span className="font-mono text-xs text-text-primary">v{r.version}</span></td>
                <td><span className="text-text-secondary text-sm">{r.agent_name ?? "n/a"}</span></td>
                <td>{r.channel && <span className="px-1.5 py-0.5 text-[10px] bg-surface-overlay text-text-muted rounded border border-border-default">{r.channel}</span>}</td>
                <td><StatusBadge status={r.status ?? "draft"} /></td>
                <td><span className="text-[10px] text-text-muted">{r.created_at ? new Date(r.created_at).toLocaleDateString() : "--"}</span></td>
                <td><ActionMenu items={getReleaseActions(r)} /></td>
              </tr>
            ))}</tbody>
          </table>
        </div></div>
      )}
    </div>
  );

  return (
    <div>
      <PageHeader title="Releases" subtitle="Manage release channels, promote versions, and configure canary splits" onRefresh={() => { void channelsQuery.refetch(); void releasesQuery.refetch(); }} />
      <div className="grid grid-cols-2 gap-3 mb-4">
        <div className="card flex items-center gap-3 py-3">
          <div className="p-2 rounded-lg bg-chart-purple/10"><GitBranch size={14} className="text-chart-purple" /></div>
          <div><p className="text-lg font-bold text-text-primary font-mono">{channels.length}</p><p className="text-[10px] text-text-muted uppercase">Channels</p></div>
        </div>
        <div className="card flex items-center gap-3 py-3">
          <div className="p-2 rounded-lg bg-accent/10"><Rocket size={14} className="text-accent" /></div>
          <div><p className="text-lg font-bold text-text-primary font-mono">{releases.length}</p><p className="text-[10px] text-text-muted uppercase">Releases</p></div>
        </div>
      </div>
      <Tabs tabs={[
        { id: "channels", label: "Channels", count: channels.length, content: channelsTab },
        { id: "releases", label: "Releases", count: releases.length, content: releasesTab },
      ]} />

      <SlidePanel isOpen={channelPanelOpen} onClose={() => setChannelPanelOpen(false)} title="Create Channel" footer={<><button className="btn btn-secondary text-xs" onClick={() => setChannelPanelOpen(false)}>Cancel</button><button className="btn btn-primary text-xs" onClick={() => void handleCreateChannel()}>Create</button></>}>
        <FormField label="Channel Name" required><input type="text" value={channelForm.name} onChange={(e) => setChannelForm({ name: e.target.value })} placeholder="production" className="text-sm" /></FormField>
      </SlidePanel>

      <SlidePanel isOpen={promotePanelOpen} onClose={() => setPromotePanelOpen(false)} title="Promote Release" subtitle="Route traffic to a specific channel" footer={<><button className="btn btn-secondary text-xs" onClick={() => setPromotePanelOpen(false)}>Cancel</button><button className="btn btn-primary text-xs" onClick={() => void handlePromote()}>Promote</button></>}>
        <FormField label="Target Channel" required>
          <select value={promoteForm.target_channel} onChange={(e) => setPromoteForm({ ...promoteForm, target_channel: e.target.value })} className="text-sm">
            {channels.map((ch) => <option key={ch.channel_id} value={ch.name}>{ch.name}</option>)}
          </select>
        </FormField>
        <FormField label="Traffic %" hint="0-100, for canary splits use less than 100">
          <input type="number" value={promoteForm.traffic_pct} onChange={(e) => setPromoteForm({ ...promoteForm, traffic_pct: Number(e.target.value) })} min={0} max={100} className="text-sm" />
        </FormField>
      </SlidePanel>

      <SlidePanel isOpen={detailOpen} onClose={() => { setDetailOpen(false); setDetailItem(null); }} title="Details">
        <pre className="text-xs font-mono bg-surface-base border border-border-default rounded-md p-4 overflow-x-auto max-h-96">{JSON.stringify(detailItem, null, 2)}</pre>
      </SlidePanel>

      {confirmOpen && confirmAction && (
        <ConfirmDialog title={confirmAction.title} description={confirmAction.desc} confirmLabel="Delete" tone="danger"
          onConfirm={async () => { try { await confirmAction.action(); } catch { showToast("Action failed", "error"); } setConfirmOpen(false); setConfirmAction(null); }}
          onCancel={() => { setConfirmOpen(false); setConfirmAction(null); }} />
      )}
    </div>
  );
};
