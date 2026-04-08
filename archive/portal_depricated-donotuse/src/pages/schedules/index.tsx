import React, { useMemo, useState } from "react";
import { Plus, Clock, Trash2, Pencil, Search, ToggleLeft, ToggleRight, Play, Eye, ChevronDown, ChevronRight, History } from "lucide-react";

import { PageHeader } from "../../components/common/PageHeader";
import { QueryState } from "../../components/common/QueryState";
import { FormField } from "../../components/common/FormField";
import { SlidePanel } from "../../components/common/SlidePanel";
import { StatusBadge } from "../../components/common/StatusBadge";
import { EmptyState } from "../../components/common/EmptyState";
import { ActionMenu, type ActionMenuItem } from "../../components/common/ActionMenu";
import { ConfirmDialog } from "../../components/common/ConfirmDialog";
import { useToast } from "../../components/common/ToastProvider";
import { apiRequest, useApiQuery } from "../../lib/api";

type Schedule = {
  schedule_id: string;
  name?: string;
  agent_name?: string;
  cron?: string;
  task?: string;
  is_active?: boolean;
  last_run?: string;
  next_run?: string;
};

type ScheduleExecution = {
  execution_id?: string;
  status?: string;
  started_at?: string;
  completed_at?: string;
  error?: string;
};

function ScheduleHistoryRow({ scheduleId }: { scheduleId: string }) {
  const [expanded, setExpanded] = useState(false);
  const historyQuery = useApiQuery<{ history?: ScheduleExecution[] }>(
    `/api/v1/schedules/${scheduleId}/history`,
    expanded,
  );
  const executions = (historyQuery.data?.history ?? []).slice(0, 10);

  return (
    <div className="mt-2">
      <button
        className="flex items-center gap-1.5 text-[10px] text-accent hover:underline"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        <History size={10} />
        History
      </button>
      {expanded && (
        <div className="mt-2 space-y-1">
          {historyQuery.loading && <p className="text-[10px] text-text-muted">Loading history...</p>}
          {historyQuery.error && <p className="text-[10px] text-status-error">{historyQuery.error}</p>}
          {!historyQuery.loading && executions.length === 0 && (
            <p className="text-[10px] text-text-muted">No execution history</p>
          )}
          {executions.map((exec, i) => (
            <div
              key={exec.execution_id ?? i}
              className="flex items-center gap-3 px-3 py-1.5 bg-surface-base border border-border-default rounded text-[10px]"
            >
              <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                exec.status === "completed" || exec.status === "success" ? "bg-status-live" :
                exec.status === "failed" || exec.status === "error" ? "bg-status-error" :
                exec.status === "running" ? "bg-status-warning" : "bg-text-muted"
              }`} />
              <span className="text-text-secondary font-medium">{exec.status ?? "unknown"}</span>
              <span className="text-text-muted flex-1">
                {exec.started_at ? new Date(exec.started_at).toLocaleString() : "--"}
              </span>
              {exec.error && (
                <span className="text-status-error truncate max-w-[150px]">{exec.error}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export const SchedulesPage = () => {
  const { showToast } = useToast();
  const schedulesQuery = useApiQuery<{ schedules: Schedule[] }>("/api/v1/schedules");
  const schedules = useMemo(() => schedulesQuery.data?.schedules ?? [], [schedulesQuery.data]);

  const [search, setSearch] = useState("");
  const filtered = search ? schedules.filter((s) => ((s.name ?? "") + (s.agent_name ?? "")).toLowerCase().includes(search.toLowerCase())) : schedules;

  const [panelOpen, setPanelOpen] = useState(false);
  const [panelMode, setPanelMode] = useState<"create" | "edit">("create");
  const [form, setForm] = useState({ name: "", agent_name: "", cron: "", task: "" });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailItem, setDetailItem] = useState<unknown>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmAction, setConfirmAction] = useState<{ title: string; desc: string; action: () => Promise<void> } | null>(null);

  const handleSave = async () => {
    const errors: Record<string, string> = {};
    if (!form.name.trim()) errors.name = "Required";
    if (!form.cron.trim()) errors.cron = "Required";
    if (!form.task.trim()) errors.task = "Required";
    setFormErrors(errors);
    if (Object.keys(errors).length > 0) return;
    try {
      if (panelMode === "create") {
        await apiRequest("/api/v1/schedules", "POST", form);
        showToast("Schedule created", "success");
      } else {
        await apiRequest(`/api/v1/schedules/${editingId}`, "PUT", form);
        showToast("Schedule updated", "success");
      }
      setPanelOpen(false);
      void schedulesQuery.refetch();
    } catch { showToast("Failed to save schedule", "error"); }
  };

  const handleToggle = async (s: Schedule) => {
    try {
      await apiRequest(`/api/v1/schedules/${s.schedule_id}`, "PUT", { is_active: !s.is_active });
      showToast(s.is_active ? "Schedule paused" : "Schedule activated", "success");
      void schedulesQuery.refetch();
    } catch { showToast("Toggle failed", "error"); }
  };

  const handleTrigger = async (s: Schedule) => {
    try {
      await apiRequest(`/api/v1/schedules/${s.schedule_id}/trigger`, "POST");
      showToast("Schedule triggered", "success");
    } catch { showToast("Trigger failed", "error"); }
  };

  const handleDelete = (s: Schedule) => {
    setConfirmAction({ title: "Delete Schedule", desc: `Delete "${s.name ?? s.schedule_id}"?`, action: async () => {
      await apiRequest(`/api/v1/schedules/${s.schedule_id}`, "DELETE");
      showToast("Schedule deleted", "success");
      void schedulesQuery.refetch();
    }});
    setConfirmOpen(true);
  };

  const getActions = (s: Schedule): ActionMenuItem[] => [
    { label: "Edit", icon: <Pencil size={12} />, onClick: () => { setForm({ name: s.name ?? "", agent_name: s.agent_name ?? "", cron: s.cron ?? "", task: s.task ?? "" }); setEditingId(s.schedule_id); setPanelMode("edit"); setFormErrors({}); setPanelOpen(true); } },
    { label: "Trigger Now", icon: <Play size={12} />, onClick: () => void handleTrigger(s) },
    { label: s.is_active ? "Pause" : "Activate", icon: s.is_active ? <ToggleLeft size={12} /> : <ToggleRight size={12} />, onClick: () => void handleToggle(s) },
    { label: "View Details", icon: <Eye size={12} />, onClick: () => { setDetailItem(s); setDetailOpen(true); } },
    { label: "Delete", icon: <Trash2 size={12} />, onClick: () => handleDelete(s), danger: true },
  ];

  const activeCount = schedules.filter((s) => s.is_active).length;

  return (
    <div>
      <PageHeader title="Schedules" subtitle="Create and manage cron-based agent schedules" liveCount={activeCount} liveLabel="Active" onRefresh={() => void schedulesQuery.refetch()}
        actions={<button className="btn btn-primary text-xs" onClick={() => { setForm({ name: "", agent_name: "", cron: "", task: "" }); setPanelMode("create"); setFormErrors({}); setPanelOpen(true); }}><Plus size={14} /> New Schedule</button>} />

      <div className="grid grid-cols-2 gap-3 mb-4">
        <div className="card flex items-center gap-3 py-3">
          <div className="p-2 rounded-lg bg-chart-blue/10"><Clock size={14} className="text-chart-blue" /></div>
          <div><p className="text-lg font-bold text-text-primary font-mono">{schedules.length}</p><p className="text-[10px] text-text-muted uppercase">Total Schedules</p></div>
        </div>
        <div className="card flex items-center gap-3 py-3">
          <div className="p-2 rounded-lg bg-chart-green/10"><ToggleRight size={14} className="text-chart-green" /></div>
          <div><p className="text-lg font-bold text-text-primary font-mono">{activeCount}</p><p className="text-[10px] text-text-muted uppercase">Active</p></div>
        </div>
      </div>

      <div className="flex items-center justify-between mb-3">
        <div className="relative flex-1 max-w-xs">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
          <input type="text" placeholder="Search schedules..." value={search} onChange={(e) => setSearch(e.target.value)} className="pl-8 text-xs" />
        </div>
      </div>

      <QueryState loading={schedulesQuery.loading} error={schedulesQuery.error} isEmpty={schedules.length === 0} emptyMessage="" onRetry={() => void schedulesQuery.refetch()}>
        {filtered.length === 0 ? (
          <EmptyState
            icon={<Clock size={40} />}
            title="No schedules yet"
            description="Schedules let you run agents automatically on a cron basis. Create one to automate recurring tasks like reports, monitoring, or data processing."
            actionLabel="New Schedule"
            onAction={() => { setForm({ name: "", agent_name: "", cron: "", task: "" }); setPanelMode("create"); setPanelOpen(true); }}
          />
        ) : (
          <div className="card p-0"><div className="overflow-x-auto">
            <table><thead><tr><th>Name</th><th>Agent</th><th>Cron</th><th>Status</th><th>Last Run</th><th>Next Run</th><th style={{ width: "48px" }}></th></tr></thead>
              <tbody>{filtered.map((s) => (
                <React.Fragment key={s.schedule_id}>
                <tr>
                  <td><span className="text-text-primary text-sm font-medium">{s.name ?? s.schedule_id.slice(0, 12)}</span></td>
                  <td><span className="text-text-secondary text-sm">{s.agent_name ?? "n/a"}</span></td>
                  <td><span className="font-mono text-xs text-text-muted bg-surface-overlay px-1.5 py-0.5 rounded">{s.cron ?? "--"}</span></td>
                  <td><StatusBadge status={s.is_active ? "active" : "paused"} /></td>
                  <td><span className="text-[10px] text-text-muted">{s.last_run ? new Date(s.last_run).toLocaleString() : "--"}</span></td>
                  <td><span className="text-[10px] text-text-muted">{s.next_run ? new Date(s.next_run).toLocaleString() : "--"}</span></td>
                  <td><ActionMenu items={getActions(s)} /></td>
                </tr>
                <tr>
                  <td colSpan={7} className="py-0 px-3">
                    <ScheduleHistoryRow scheduleId={s.schedule_id} />
                  </td>
                </tr>
                </React.Fragment>
              ))}</tbody>
            </table>
          </div></div>
        )}
      </QueryState>

      <SlidePanel isOpen={panelOpen} onClose={() => setPanelOpen(false)} title={panelMode === "create" ? "Create Schedule" : "Edit Schedule"} subtitle="Define a cron-based agent schedule"
        footer={<><button className="btn btn-secondary text-xs" onClick={() => setPanelOpen(false)}>Cancel</button><button className="btn btn-primary text-xs" onClick={() => void handleSave()}>{panelMode === "create" ? "Create" : "Update"}</button></>}>
        <FormField label="Name" required error={formErrors.name}><input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="daily-report" className="text-sm" /></FormField>
        <FormField label="Agent Name"><input type="text" value={form.agent_name} onChange={(e) => setForm({ ...form, agent_name: e.target.value })} placeholder="report-agent" className="text-sm" /></FormField>
        <FormField label="Cron Expression" required error={formErrors.cron} hint="e.g. 0 9 * * 1-5 (weekdays at 9am)"><input type="text" value={form.cron} onChange={(e) => setForm({ ...form, cron: e.target.value })} placeholder="0 9 * * 1-5" className="text-sm font-mono" /></FormField>
        <FormField label="Task" required error={formErrors.task}><textarea value={form.task} onChange={(e) => setForm({ ...form, task: e.target.value })} placeholder="Generate daily summary report..." rows={4} className="text-sm" /></FormField>
      </SlidePanel>

      <SlidePanel isOpen={detailOpen} onClose={() => { setDetailOpen(false); setDetailItem(null); }} title="Schedule Details">
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
