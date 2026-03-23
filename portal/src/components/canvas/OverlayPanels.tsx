import { useState } from "react";
import {
  Workflow, Clock, Webhook, ShieldCheck, FolderKanban, Tag, Cpu,
  Play, Pause, Trash2, Plus, RotateCcw, CheckCircle2, XCircle,
  AlertTriangle, Search, Eye, Send, Upload, Settings, Globe,
  MoreVertical, ChevronRight, Zap, Activity, Code, Lock, Unlock,
} from "lucide-react";
import { CanvasOverlayPanel } from "./CanvasOverlayPanel";
import { apiRequest, useApiQuery } from "../../lib/api";

/* ── Shared helpers ────────────────────────────────────────────── */
function StatusPill({ status }: { status: string }) {
  const colors: Record<string, string> = {
    active: "bg-status-live/10 text-status-live",
    running: "bg-yellow-500/10 text-yellow-500",
    completed: "bg-status-live/10 text-status-live",
    failed: "bg-status-error/10 text-status-error",
    cancelled: "bg-surface-overlay text-text-muted",
    enabled: "bg-status-live/10 text-status-live",
    disabled: "bg-surface-overlay text-text-muted",
    pending: "bg-yellow-500/10 text-yellow-500",
    healthy: "bg-status-live/10 text-status-live",
    degraded: "bg-yellow-500/10 text-yellow-500",
    provisioning: "bg-yellow-500/10 text-yellow-500",
    terminated: "bg-status-error/10 text-status-error",
  };
  const dotColors: Record<string, string> = {
    active: "bg-status-live", running: "bg-yellow-500", completed: "bg-status-live",
    failed: "bg-status-error", cancelled: "bg-text-muted", enabled: "bg-status-live",
    disabled: "bg-text-muted", pending: "bg-yellow-500", healthy: "bg-status-live",
    degraded: "bg-yellow-500", provisioning: "bg-yellow-500", terminated: "bg-status-error",
  };
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full ${colors[status] || "bg-surface-overlay text-text-muted"}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${dotColors[status] || "bg-text-muted"}`} />
      {status}
    </span>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="text-xs font-semibold text-text-primary mb-3 uppercase tracking-wider">{children}</h3>;
}

function InlineInput({ label, value, onChange, placeholder, type = "text" }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; type?: string;
}) {
  return (
    <div className="mb-3">
      <label className="block text-[10px] font-medium text-text-muted uppercase tracking-wider mb-1">{label}</label>
      <input type={type} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
        className="w-full px-3 py-2 text-xs bg-surface-base border border-border-default rounded-lg text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent/50 transition-colors" />
    </div>
  );
}

function InlineSelect({ label, value, onChange, options }: {
  label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[];
}) {
  return (
    <div className="mb-3">
      <label className="block text-[10px] font-medium text-text-muted uppercase tracking-wider mb-1">{label}</label>
      <select value={value} onChange={(e) => onChange(e.target.value)}
        className="w-full px-3 py-2 text-xs bg-surface-base border border-border-default rounded-lg text-text-primary focus:outline-none focus:border-accent/50 transition-colors">
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}

function InlineTextarea({ label, value, onChange, placeholder, rows = 3 }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; rows?: number;
}) {
  return (
    <div className="mb-3">
      <label className="block text-[10px] font-medium text-text-muted uppercase tracking-wider mb-1">{label}</label>
      <textarea value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} rows={rows}
        className="w-full px-3 py-2 text-xs bg-surface-base border border-border-default rounded-lg text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent/50 transition-colors font-mono resize-none" />
    </div>
  );
}

function ToggleRow({ label, description, checked, onChange }: {
  label: string; description?: string; checked: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between py-3 border-b border-border-default last:border-0">
      <div>
        <p className="text-xs text-text-primary">{label}</p>
        {description && <p className="text-[10px] text-text-muted mt-0.5">{description}</p>}
      </div>
      <button onClick={() => onChange(!checked)}
        className={`relative rounded-full transition-colors flex-shrink-0 ${checked ? "bg-accent" : "bg-surface-overlay"}`}
        style={{ minWidth: 32, height: 18 }}>
        <span className={`absolute top-0.5 left-0.5 rounded-full bg-white transition-transform ${checked ? "translate-x-3.5" : ""}`}
          style={{ width: 14, height: 14 }} />
      </button>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   WORKFLOWS & JOBS PANEL
   ═══════════════════════════════════════════════════════════════════ */
export function WorkflowsPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<"workflows" | "jobs">("workflows");
  const [search, setSearch] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [wfName, setWfName] = useState("");
  const [wfDesc, setWfDesc] = useState("");
  const [actionMessage, setActionMessage] = useState("");

  const workflowsQuery = useApiQuery<{ workflows?: Array<Record<string, unknown>> }>(
    "/api/v1/workflows",
    open,
  );
  const jobsQuery = useApiQuery<{ jobs?: Array<Record<string, unknown>> }>(
    "/api/v1/jobs?limit=50",
    open,
  );
  const workflows = (workflowsQuery.data?.workflows ?? []).map((wf) => ({
    id: String(wf.workflow_id ?? ""),
    name: String(wf.name ?? "Unnamed workflow"),
    description: String(wf.description ?? ""),
    status: String(wf.status ?? "active"),
    createdAt: Number(wf.created_at ?? 0),
    steps: Array.isArray(wf.steps) ? wf.steps.length : Number(wf.step_count ?? 0),
  }));
  const jobs = (jobsQuery.data?.jobs ?? []).map((job) => ({
    id: String(job.job_id ?? ""),
    workflow: String(job.workflow_id ?? job.agent_name ?? "n/a"),
    status: String(job.status ?? "unknown"),
    task: String(job.task ?? ""),
    progress: Number(job.progress ?? 0),
    retries: Number(job.retries ?? 0),
  }));

  return (
    <CanvasOverlayPanel open={open} onClose={onClose} title="Workflows & Jobs" icon={<Workflow size={16} className="text-accent" />} width="780px">
      {/* Tabs */}
      <div className="flex items-center gap-1 mb-4">
        {(["workflows", "jobs"] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${tab === t ? "bg-accent/20 text-accent" : "text-text-muted hover:bg-surface-overlay"}`}>
            {t === "workflows" ? `Workflows (${workflows.length})` : `Jobs (${jobs.length})`}
          </button>
        ))}
        <div className="flex-1" />
        {tab === "workflows" && (
          <button onClick={() => setShowCreate(!showCreate)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-accent text-white rounded-md hover:bg-accent/90 transition-colors">
            <Plus size={12} /> New Workflow
          </button>
        )}
      </div>

      {/* Create form */}
      {showCreate && tab === "workflows" && (
        <div className="bg-surface-base rounded-lg border border-border-default p-4 mb-4">
          <SectionTitle>Create Workflow</SectionTitle>
          <InlineInput label="Name" value={wfName} onChange={setWfName} placeholder="e.g. Customer Onboarding" />
          <InlineTextarea label="Description" value={wfDesc} onChange={setWfDesc} placeholder="What does this workflow do?" />
          <div className="flex gap-2 mt-2">
            <button
              className="flex-1 py-2 text-xs font-medium bg-accent text-white rounded-lg hover:bg-accent/90 transition-colors"
              onClick={async () => {
                if (!wfName.trim()) return;
                try {
                  await apiRequest("/api/v1/workflows", "POST", {
                    name: wfName.trim(),
                    description: wfDesc.trim(),
                    steps: [],
                  });
                  setWfName("");
                  setWfDesc("");
                  setShowCreate(false);
                  setActionMessage("Workflow created");
                  void workflowsQuery.refetch();
                } catch (err) {
                  setActionMessage(err instanceof Error ? err.message : "Failed to create workflow");
                }
              }}
            >
              Create
            </button>
            <button onClick={() => setShowCreate(false)} className="px-4 py-2 text-xs text-text-muted hover:text-text-primary transition-colors">Cancel</button>
          </div>
        </div>
      )}
      {actionMessage && (
        <div className="mb-3 text-[10px] text-text-muted">{actionMessage}</div>
      )}

      {/* Search */}
      <div className="relative mb-3">
        <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={`Search ${tab}...`}
          className="w-full pl-9 pr-3 py-2 text-xs bg-surface-base border border-border-default rounded-lg text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent/50" />
      </div>

      {/* Workflows list */}
      {tab === "workflows" && (
        <div className="space-y-2">
          {workflowsQuery.loading && <p className="text-xs text-text-muted">Loading workflows...</p>}
          {workflowsQuery.error && <p className="text-xs text-status-error">{workflowsQuery.error}</p>}
          {workflows.filter((w) => w.name.toLowerCase().includes(search.toLowerCase())).map((wf) => (
            <div key={wf.id} className="bg-surface-base rounded-lg border border-border-default p-3">
              <div className="flex items-center gap-2 mb-2">
                <Workflow size={12} className="text-accent" />
                <span className="text-[11px] font-medium text-text-primary flex-1">{wf.name}</span>
                <StatusPill status={wf.status} />
              </div>
              <div className="flex items-center gap-4 text-[10px] text-text-muted">
                <span>Workflow: <span className="text-text-secondary font-mono">{wf.id.slice(0, 10)}</span></span>
                <span>{wf.steps} steps</span>
                <span>Created: {wf.createdAt ? new Date(wf.createdAt * 1000).toLocaleDateString() : "n/a"}</span>
              </div>
              <div className="flex gap-2 mt-2">
                <button
                  className="flex items-center gap-1 px-2 py-1 text-[10px] bg-accent/10 text-accent rounded hover:bg-accent/20 transition-colors"
                  onClick={async () => {
                    try {
                      await apiRequest(`/api/v1/workflows/${wf.id}/run`, "POST");
                      setActionMessage("Workflow run started");
                      void jobsQuery.refetch();
                    } catch (err) {
                      setActionMessage(err instanceof Error ? err.message : "Failed to run workflow");
                    }
                  }}
                >
                  <Play size={9} /> Run
                </button>
                <button className="flex items-center gap-1 px-2 py-1 text-[10px] text-text-muted hover:bg-surface-overlay rounded transition-colors">
                  <Settings size={9} /> Configure
                </button>
                <button
                  className="flex items-center gap-1 px-2 py-1 text-[10px] text-status-error hover:bg-status-error/10 rounded transition-colors ml-auto"
                  onClick={async () => {
                    try {
                      await apiRequest(`/api/v1/workflows/${wf.id}`, "DELETE");
                      setActionMessage("Workflow deleted");
                      void workflowsQuery.refetch();
                    } catch (err) {
                      setActionMessage(err instanceof Error ? err.message : "Failed to delete workflow");
                    }
                  }}
                >
                  <Trash2 size={9} /> Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Jobs list */}
      {tab === "jobs" && (
        <div className="space-y-2">
          {jobsQuery.loading && <p className="text-xs text-text-muted">Loading jobs...</p>}
          {jobsQuery.error && <p className="text-xs text-status-error">{jobsQuery.error}</p>}
          {jobs.filter((j) => j.workflow.toLowerCase().includes(search.toLowerCase())).map((job) => (
            <div key={job.id} className="bg-surface-base rounded-lg border border-border-default p-3">
              <div className="flex items-center gap-2 mb-1.5">
                <code className="text-[10px] font-mono text-accent">{job.id}</code>
                <StatusPill status={job.status} />
                <span className="ml-auto text-[10px] text-text-muted">retries {job.retries}</span>
              </div>
              <p className="text-[11px] text-text-primary mb-1">{job.workflow}</p>
              <p className="text-[10px] text-text-muted mb-2 truncate">{job.task || "No task details"}</p>
              <div className="h-1.5 bg-surface-overlay rounded-full overflow-hidden mb-2">
                <div className={`h-full rounded-full transition-all ${
                  job.status === "failed" ? "bg-status-error" :
                  job.status === "running" ? "bg-yellow-500" :
                  job.status === "completed" ? "bg-status-live" : "bg-text-muted"
                }`} style={{ width: `${job.progress}%` }} />
              </div>
              <div className="flex gap-2">
                {job.status === "running" && (
                  <button
                    className="flex items-center gap-1 px-2 py-1 text-[10px] text-status-error hover:bg-status-error/10 rounded transition-colors"
                    onClick={async () => {
                      try {
                        await apiRequest(`/api/v1/jobs/${job.id}/cancel`, "POST");
                        setActionMessage("Job cancelled");
                        void jobsQuery.refetch();
                      } catch (err) {
                        setActionMessage(err instanceof Error ? err.message : "Failed to cancel job");
                      }
                    }}
                  >
                    <Pause size={9} /> Cancel
                  </button>
                )}
                {job.status === "failed" && (
                  <button
                    className="flex items-center gap-1 px-2 py-1 text-[10px] text-accent hover:bg-accent/10 rounded transition-colors"
                    onClick={async () => {
                      try {
                        await apiRequest(`/api/v1/jobs/${job.id}/retry`, "POST");
                        setActionMessage("Job retried");
                        void jobsQuery.refetch();
                      } catch (err) {
                        setActionMessage(err instanceof Error ? err.message : "Failed to retry job");
                      }
                    }}
                  >
                    <RotateCcw size={9} /> Retry
                  </button>
                )}
                <button
                  className="flex items-center gap-1 px-2 py-1 text-[10px] text-text-muted hover:bg-surface-overlay rounded transition-colors"
                  onClick={() => setActionMessage(`Job ${job.id}: ${job.status}`)}
                >
                  <Eye size={9} /> Details
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </CanvasOverlayPanel>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   SCHEDULES PANEL
   ═══════════════════════════════════════════════════════════════════ */
export function SchedulesPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [cron, setCron] = useState("0 0 9 * * 1-5");
  const [agent, setAgent] = useState("support-bot");
  const [task, setTask] = useState("Run scheduled task");
  const [actionMessage, setActionMessage] = useState("");
  const schedulesQuery = useApiQuery<Array<Record<string, unknown>>>(
    "/api/v1/schedules",
    open,
  );
  const schedules = (schedulesQuery.data ?? []).map((s) => ({
    id: String(s.schedule_id ?? ""),
    cron: String(s.cron ?? ""),
    agent: String(s.agent_name ?? ""),
    task: String(s.task ?? ""),
    status: Boolean(s.is_enabled) ? "enabled" : "disabled",
    runCount: Number(s.run_count ?? 0),
    lastRun: Number(s.last_run_at ?? 0),
  }));

  return (
    <CanvasOverlayPanel open={open} onClose={onClose} title="Schedules" icon={<Clock size={16} className="text-accent" />}>
      <div className="flex items-center justify-between mb-4">
        <p className="text-xs text-text-muted">{schedules.length} schedules configured</p>
        <button onClick={() => setShowCreate(!showCreate)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-accent text-white rounded-md hover:bg-accent/90 transition-colors">
          <Plus size={12} /> New Schedule
        </button>
      </div>

      {showCreate && (
        <div className="bg-surface-base rounded-lg border border-border-default p-4 mb-4">
          <SectionTitle>Create Schedule</SectionTitle>
          <InlineInput label="Name" value={name} onChange={setName} placeholder="e.g. Morning Report" />
          <InlineInput label="Cron Expression" value={cron} onChange={setCron} placeholder="0 0 9 * * 1-5" />
          <p className="text-[10px] text-text-muted -mt-2 mb-3">Format: sec min hour day month weekday</p>
          <InlineInput label="Task" value={task} onChange={setTask} placeholder="Describe scheduled task" />
          <InlineSelect label="Agent" value={agent} onChange={setAgent}
            options={[{ value: "support-bot", label: "Support Bot" }, { value: "data-analyst", label: "Data Analyst" }]} />
          <div className="flex gap-2 mt-2">
            <button
              className="flex-1 py-2 text-xs font-medium bg-accent text-white rounded-lg hover:bg-accent/90 transition-colors"
              onClick={async () => {
                if (!agent.trim() || !cron.trim() || !task.trim()) return;
                try {
                  await apiRequest("/api/v1/schedules", "POST", {
                    agent_name: agent.trim(),
                    cron: cron.trim(),
                    task: task.trim(),
                  });
                  setShowCreate(false);
                  setName("");
                  setTask("Run scheduled task");
                  setActionMessage("Schedule created");
                  void schedulesQuery.refetch();
                } catch (err) {
                  setActionMessage(err instanceof Error ? err.message : "Failed to create schedule");
                }
              }}
            >
              Create
            </button>
            <button onClick={() => setShowCreate(false)} className="px-4 py-2 text-xs text-text-muted hover:text-text-primary transition-colors">Cancel</button>
          </div>
        </div>
      )}
      {actionMessage && <div className="mb-3 text-[10px] text-text-muted">{actionMessage}</div>}

      <div className="space-y-2">
        {schedulesQuery.loading && <p className="text-xs text-text-muted">Loading schedules...</p>}
        {schedulesQuery.error && <p className="text-xs text-status-error">{schedulesQuery.error}</p>}
        {schedules.map((sch) => (
          <div key={sch.id} className="bg-surface-base rounded-lg border border-border-default p-3">
            <div className="flex items-center gap-2 mb-2">
              <Clock size={12} className="text-accent" />
              <span className="text-[11px] font-medium text-text-primary flex-1">{sch.task || sch.id}</span>
              <StatusPill status={sch.status} />
            </div>
            <div className="flex items-center gap-3 text-[10px] text-text-muted mb-2">
              <code className="font-mono text-text-secondary">{sch.cron}</code>
              <span>Agent: {sch.agent}</span>
            </div>
            <div className="flex items-center gap-3 text-[10px] text-text-muted">
              <span>Runs: <span className="text-text-secondary">{sch.runCount}</span></span>
              <span>Last: {sch.lastRun ? new Date(sch.lastRun * 1000).toLocaleString() : "never"}</span>
            </div>
            <div className="flex gap-2 mt-2">
              <button className="flex items-center gap-1 px-2 py-1 text-[10px] text-text-muted hover:bg-surface-overlay rounded transition-colors">
                <Settings size={9} /> Edit
              </button>
              <button
                className={`flex items-center gap-1 px-2 py-1 text-[10px] rounded transition-colors ${
                  sch.status === "enabled" ? "text-yellow-500 hover:bg-yellow-500/10" : "text-status-live hover:bg-status-live/10"
                }`}
                onClick={async () => {
                  try {
                    await apiRequest(
                      `/api/v1/schedules/${sch.id}/${sch.status === "enabled" ? "disable" : "enable"}`,
                      "POST",
                    );
                    setActionMessage(`Schedule ${sch.status === "enabled" ? "disabled" : "enabled"}`);
                    void schedulesQuery.refetch();
                  } catch (err) {
                    setActionMessage(err instanceof Error ? err.message : "Failed to toggle schedule");
                  }
                }}
              >
                {sch.status === "enabled" ? <><Pause size={9} /> Disable</> : <><Play size={9} /> Enable</>}
              </button>
              <button
                className="flex items-center gap-1 px-2 py-1 text-[10px] text-status-error hover:bg-status-error/10 rounded transition-colors ml-auto"
                onClick={async () => {
                  try {
                    await apiRequest(`/api/v1/schedules/${sch.id}`, "DELETE");
                    setActionMessage("Schedule deleted");
                    void schedulesQuery.refetch();
                  } catch (err) {
                    setActionMessage(err instanceof Error ? err.message : "Failed to delete schedule");
                  }
                }}
              >
                <Trash2 size={9} /> Delete
              </button>
            </div>
          </div>
        ))}
      </div>
    </CanvasOverlayPanel>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   WEBHOOKS PANEL
   ═══════════════════════════════════════════════════════════════════ */
export function WebhooksPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [showCreate, setShowCreate] = useState(false);
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState("");
  const [actionMessage, setActionMessage] = useState("");
  const webhooksQuery = useApiQuery<Array<Record<string, unknown>>>(
    "/api/v1/webhooks",
    open,
  );
  const webhooks = (webhooksQuery.data ?? []).map((wh) => ({
    id: String(wh.webhook_id ?? ""),
    url: String(wh.url ?? ""),
    events: Array.isArray(wh.events) ? wh.events.map((e) => String(e)) : [],
    status: Boolean(wh.is_active) ? "active" : "disabled",
    failureCount: Number(wh.failure_count ?? 0),
    lastTriggeredAt: Number(wh.last_triggered_at ?? 0),
  }));

  return (
    <CanvasOverlayPanel open={open} onClose={onClose} title="Webhooks" icon={<Webhook size={16} className="text-accent" />}>
      <div className="flex items-center justify-between mb-4">
        <p className="text-xs text-text-muted">{webhooks.length} webhooks configured</p>
        <button onClick={() => setShowCreate(!showCreate)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-accent text-white rounded-md hover:bg-accent/90 transition-colors">
          <Plus size={12} /> New Webhook
        </button>
      </div>

      {showCreate && (
        <div className="bg-surface-base rounded-lg border border-border-default p-4 mb-4">
          <SectionTitle>Create Webhook</SectionTitle>
          <InlineInput label="Endpoint URL" value={url} onChange={setUrl} placeholder="https://..." />
          <InlineInput label="Events (comma-separated)" value={events} onChange={setEvents} placeholder="agent.run.completed, agent.deployed" />
          <div className="flex gap-2 mt-2">
            <button
              className="flex-1 py-2 text-xs font-medium bg-accent text-white rounded-lg hover:bg-accent/90 transition-colors"
              onClick={async () => {
                try {
                  const nextEvents = events
                    .split(",")
                    .map((e) => e.trim())
                    .filter(Boolean);
                  await apiRequest("/api/v1/webhooks", "POST", {
                    url: url.trim(),
                    events: nextEvents.length > 0 ? nextEvents : ["*"],
                  });
                  setShowCreate(false);
                  setUrl("");
                  setEvents("");
                  setActionMessage("Webhook created");
                  void webhooksQuery.refetch();
                } catch (err) {
                  setActionMessage(err instanceof Error ? err.message : "Failed to create webhook");
                }
              }}
            >
              Create
            </button>
            <button onClick={() => setShowCreate(false)} className="px-4 py-2 text-xs text-text-muted hover:text-text-primary transition-colors">Cancel</button>
          </div>
        </div>
      )}
      {actionMessage && <div className="mb-3 text-[10px] text-text-muted">{actionMessage}</div>}

      <div className="space-y-2">
        {webhooksQuery.loading && <p className="text-xs text-text-muted">Loading webhooks...</p>}
        {webhooksQuery.error && <p className="text-xs text-status-error">{webhooksQuery.error}</p>}
        {webhooks.map((wh) => (
          <div key={wh.id} className="bg-surface-base rounded-lg border border-border-default p-3">
            <div className="flex items-center gap-2 mb-2">
              <Webhook size={12} className="text-accent" />
              <code className="text-[10px] font-mono text-text-primary truncate flex-1">{wh.url}</code>
              <StatusPill status={wh.status} />
            </div>
            <div className="flex flex-wrap gap-1 mb-2">
              {wh.events.map((ev) => (
                <span key={ev} className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-surface-overlay text-text-muted">{ev}</span>
              ))}
            </div>
            <div className="flex items-center gap-3 text-[10px] text-text-muted">
              <span>Failures: {wh.failureCount}</span>
              <span>Last: {wh.lastTriggeredAt ? new Date(wh.lastTriggeredAt * 1000).toLocaleString() : "never"}</span>
            </div>
            <div className="flex gap-2 mt-2">
              <button
                className="flex items-center gap-1 px-2 py-1 text-[10px] text-accent hover:bg-accent/10 rounded transition-colors"
                onClick={async () => {
                  try {
                    const result = await apiRequest<{ success?: boolean; status?: number }>(
                      `/api/v1/webhooks/${wh.id}/test`,
                      "POST",
                    );
                    setActionMessage(
                      result.success
                        ? `Webhook test succeeded (${result.status ?? 200})`
                        : `Webhook test failed (${result.status ?? 0})`,
                    );
                  } catch (err) {
                    setActionMessage(err instanceof Error ? err.message : "Webhook test failed");
                  }
                }}
              >
                <Send size={9} /> Test
              </button>
              <button className="flex items-center gap-1 px-2 py-1 text-[10px] text-text-muted hover:bg-surface-overlay rounded transition-colors">
                <Eye size={9} /> Deliveries
              </button>
              <button
                className="flex items-center gap-1 px-2 py-1 text-[10px] text-text-muted hover:bg-surface-overlay rounded transition-colors"
                onClick={async () => {
                  try {
                    const nextState = wh.status !== "active";
                    await apiRequest(
                      `/api/v1/webhooks/${wh.id}?is_active=${nextState ? "true" : "false"}`,
                      "PUT",
                    );
                    setActionMessage(`Webhook ${wh.status === "active" ? "disabled" : "enabled"}`);
                    void webhooksQuery.refetch();
                  } catch (err) {
                    setActionMessage(err instanceof Error ? err.message : "Failed to update webhook");
                  }
                }}
              >
                <Settings size={9} /> {wh.status === "active" ? "Disable" : "Enable"}
              </button>
              <button
                className="flex items-center gap-1 px-2 py-1 text-[10px] text-status-error hover:bg-status-error/10 rounded transition-colors ml-auto"
                onClick={async () => {
                  try {
                    await apiRequest(`/api/v1/webhooks/${wh.id}`, "DELETE");
                    setActionMessage("Webhook deleted");
                    void webhooksQuery.refetch();
                  } catch (err) {
                    setActionMessage(err instanceof Error ? err.message : "Failed to delete webhook");
                  }
                }}
              >
                <Trash2 size={9} /> Delete
              </button>
            </div>
          </div>
        ))}
      </div>
    </CanvasOverlayPanel>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   GOVERNANCE PANEL
   ═══════════════════════════════════════════════════════════════════ */
export function GovernancePanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<"policies" | "budgets" | "approvals">("policies");
  const [requireApproval, setRequireApproval] = useState(true);
  const [humanInLoop, setHumanInLoop] = useState(true);
  const [auditLog, setAuditLog] = useState(true);
  const [maxTokens, setMaxTokens] = useState(true);

  return (
    <CanvasOverlayPanel open={open} onClose={onClose} title="Governance" icon={<ShieldCheck size={16} className="text-accent" />}>
      <div className="flex items-center gap-1 mb-4">
        {(["policies", "budgets", "approvals"] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${tab === t ? "bg-accent/20 text-accent" : "text-text-muted hover:bg-surface-overlay"}`}>
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {tab === "policies" && (
        <div>
          <div className="bg-surface-base rounded-lg border border-border-default p-4 mb-4">
            <SectionTitle>Global Policies</SectionTitle>
            <ToggleRow label="Require deployment approval" description="All agent deployments must be approved by an admin" checked={requireApproval} onChange={setRequireApproval} />
            <ToggleRow label="Human-in-the-loop for sensitive actions" description="Agents must get human confirmation before executing destructive operations" checked={humanInLoop} onChange={setHumanInLoop} />
            <ToggleRow label="Audit logging" description="Log all agent actions and tool invocations" checked={auditLog} onChange={setAuditLog} />
            <ToggleRow label="Max token limit per request" description="Enforce a maximum token budget per single request" checked={maxTokens} onChange={setMaxTokens} />
          </div>
          <div className="bg-surface-base rounded-lg border border-border-default p-4">
            <SectionTitle>Content Filters</SectionTitle>
            <div className="space-y-1.5">
              {["PII Detection", "Profanity Filter", "Code Injection Guard", "Prompt Injection Shield"].map((f) => (
                <div key={f} className="flex items-center justify-between py-2 border-b border-border-default last:border-0">
                  <span className="text-xs text-text-primary">{f}</span>
                  <StatusPill status="enabled" />
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {tab === "budgets" && (
        <div>
          <div className="grid grid-cols-3 gap-3 mb-4">
            {[
              { label: "Monthly Budget", value: "$500", used: "$127.40", pct: 25 },
              { label: "Daily Limit", value: "$50", used: "$12.30", pct: 25 },
              { label: "Per-Agent Cap", value: "$100", used: "$34.50", pct: 35 },
            ].map((b) => (
              <div key={b.label} className="bg-surface-base rounded-lg border border-border-default p-3">
                <p className="text-[10px] text-text-muted">{b.label}</p>
                <p className="text-lg font-semibold text-text-primary">{b.value}</p>
                <p className="text-[10px] text-text-muted">Used: {b.used}</p>
                <div className="mt-1.5 h-1 bg-surface-overlay rounded-full overflow-hidden">
                  <div className="h-full bg-accent rounded-full" style={{ width: `${b.pct}%` }} />
                </div>
              </div>
            ))}
          </div>
          <div className="bg-surface-base rounded-lg border border-border-default p-4">
            <SectionTitle>Budget Alerts</SectionTitle>
            <InlineInput label="Alert at % of budget" value="80" onChange={() => {}} type="number" />
            <InlineInput label="Hard stop at % of budget" value="100" onChange={() => {}} type="number" />
            <InlineInput label="Alert email" value="admin@oneshots.co" onChange={() => {}} />
          </div>
        </div>
      )}

      {tab === "approvals" && (
        <div className="space-y-2">
          {[
            { trigger: "Agent Deployment", approvers: ["admin@oneshots.co"], status: "enabled" },
            { trigger: "Budget Override", approvers: ["admin@oneshots.co", "finance@oneshots.co"], status: "enabled" },
            { trigger: "Tool Permission Grant", approvers: ["admin@oneshots.co"], status: "disabled" },
          ].map((rule) => (
            <div key={rule.trigger} className="bg-surface-base rounded-lg border border-border-default p-3">
              <div className="flex items-center gap-2 mb-2">
                <ShieldCheck size={12} className="text-accent" />
                <span className="text-[11px] font-medium text-text-primary flex-1">{rule.trigger}</span>
                <StatusPill status={rule.status} />
              </div>
              <div className="flex flex-wrap gap-1">
                {rule.approvers.map((a) => (
                  <span key={a} className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-surface-overlay text-text-muted">{a}</span>
                ))}
              </div>
            </div>
          ))}
          <button className="w-full py-2 text-xs font-medium border border-dashed border-border-default rounded-lg text-text-muted hover:border-accent/40 hover:text-accent transition-colors">
            + Add Approval Rule
          </button>
        </div>
      )}
    </CanvasOverlayPanel>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   PROJECTS & ENVIRONMENTS PANEL
   ═══════════════════════════════════════════════════════════════════ */
export function ProjectsPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [projName, setProjName] = useState("");
  const [projDesc, setProjDesc] = useState("");

  const projects = [
    { id: "proj_1", name: "my-agents", description: "Primary agent workspace", envs: ["production", "staging", "development"], varsCount: 12 },
    { id: "proj_2", name: "experiments", description: "Testing and prototyping", envs: ["sandbox"], varsCount: 4 },
  ];

  const envVars = [
    { key: "OPENAI_API_KEY", value: "sk-***", secret: true },
    { key: "DATABASE_URL", value: "postgres://...", secret: true },
    { key: "LOG_LEVEL", value: "info", secret: false },
    { key: "MAX_RETRIES", value: "3", secret: false },
    { key: "SLACK_WEBHOOK_URL", value: "https://hooks.slack.com/...", secret: true },
  ];

  return (
    <CanvasOverlayPanel open={open} onClose={onClose} title="Projects & Environments" icon={<FolderKanban size={16} className="text-accent" />}>
      <div className="flex items-center justify-between mb-4">
        <p className="text-xs text-text-muted">{projects.length} projects</p>
        <button onClick={() => setShowCreate(!showCreate)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-accent text-white rounded-md hover:bg-accent/90 transition-colors">
          <Plus size={12} /> New Project
        </button>
      </div>

      {showCreate && (
        <div className="bg-surface-base rounded-lg border border-border-default p-4 mb-4">
          <SectionTitle>Create Project</SectionTitle>
          <InlineInput label="Name" value={projName} onChange={setProjName} placeholder="e.g. my-agents" />
          <InlineTextarea label="Description" value={projDesc} onChange={setProjDesc} placeholder="What is this project for?" />
          <div className="flex gap-2 mt-2">
            <button className="flex-1 py-2 text-xs font-medium bg-accent text-white rounded-lg hover:bg-accent/90 transition-colors">Create</button>
            <button onClick={() => setShowCreate(false)} className="px-4 py-2 text-xs text-text-muted hover:text-text-primary transition-colors">Cancel</button>
          </div>
        </div>
      )}

      <div className="space-y-3">
        {projects.map((proj) => (
          <div key={proj.id} className="bg-surface-base rounded-lg border border-border-default overflow-hidden">
            <button onClick={() => setSelectedProject(selectedProject === proj.id ? null : proj.id)}
              className="w-full flex items-center gap-3 p-3 hover:bg-surface-overlay/50 transition-colors">
              <FolderKanban size={14} className="text-accent flex-shrink-0" />
              <div className="flex-1 text-left min-w-0">
                <p className="text-[11px] font-medium text-text-primary">{proj.name}</p>
                <p className="text-[10px] text-text-muted">{proj.description}</p>
              </div>
              <span className="text-[10px] text-text-muted">{proj.envs.length} envs</span>
              <ChevronRight size={12} className={`text-text-muted transition-transform ${selectedProject === proj.id ? "rotate-90" : ""}`} />
            </button>

            {selectedProject === proj.id && (
              <div className="border-t border-border-default p-3">
                <div className="flex items-center gap-2 mb-3">
                  <SectionTitle>Environments</SectionTitle>
                </div>
                <div className="flex gap-2 mb-4">
                  {proj.envs.map((env) => (
                    <span key={env} className="text-[10px] px-2 py-1 rounded-md bg-surface-overlay text-text-secondary">{env}</span>
                  ))}
                </div>

                <SectionTitle>Environment Variables</SectionTitle>
                <div className="bg-surface-raised rounded-lg border border-border-default overflow-hidden">
                  {envVars.map((v) => (
                    <div key={v.key} className="flex items-center gap-2 px-3 py-2 border-b border-border-default last:border-0">
                      {v.secret ? <Lock size={9} className="text-yellow-500 flex-shrink-0" /> : <Unlock size={9} className="text-text-muted flex-shrink-0" />}
                      <code className="text-[10px] text-accent font-mono flex-shrink-0">{v.key}</code>
                      <span className="text-[10px] text-text-muted">=</span>
                      <code className="text-[10px] text-text-secondary font-mono truncate flex-1">{v.value}</code>
                      <button className="text-text-muted hover:text-status-error flex-shrink-0"><Trash2 size={9} /></button>
                    </div>
                  ))}
                </div>
                <button className="mt-2 w-full py-1.5 text-[10px] font-medium border border-dashed border-border-default rounded-lg text-text-muted hover:border-accent/40 hover:text-accent transition-colors">
                  + Add Variable
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </CanvasOverlayPanel>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   RELEASES PANEL
   ═══════════════════════════════════════════════════════════════════ */
export function ReleasesPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<"channels" | "releases">("channels");

  const channels = [
    { name: "production", version: "v1.3.2", traffic: 100, status: "active", agent: "support-bot" },
    { name: "staging", version: "v1.4.0-rc1", traffic: 100, status: "active", agent: "support-bot" },
    { name: "canary", version: "v1.4.0-beta", traffic: 5, status: "active", agent: "support-bot" },
  ];

  const releases = [
    { version: "v1.4.0-rc1", agent: "support-bot", channel: "staging", status: "active", date: "2 hours ago" },
    { version: "v1.3.2", agent: "support-bot", channel: "production", status: "active", date: "1 day ago" },
    { version: "v1.3.1", agent: "data-analyst", channel: "production", status: "superseded", date: "3 days ago" },
    { version: "v1.4.0-beta", agent: "support-bot", channel: "canary", status: "active", date: "5 hours ago" },
  ];

  return (
    <CanvasOverlayPanel open={open} onClose={onClose} title="Release Channels" icon={<Tag size={16} className="text-accent" />}>
      <div className="flex items-center gap-1 mb-4">
        {(["channels", "releases"] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${tab === t ? "bg-accent/20 text-accent" : "text-text-muted hover:bg-surface-overlay"}`}>
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {tab === "channels" && (
        <div className="space-y-2">
          {channels.map((ch) => (
            <div key={ch.name} className="bg-surface-base rounded-lg border border-border-default p-3">
              <div className="flex items-center gap-2 mb-2">
                <Tag size={12} className="text-accent" />
                <span className="text-[11px] font-medium text-text-primary flex-1">{ch.name}</span>
                <code className="text-[10px] font-mono text-text-muted">{ch.version}</code>
                <StatusPill status={ch.status} />
              </div>
              <div className="flex items-center gap-2">
                <div className="flex-1 h-1.5 bg-surface-overlay rounded-full overflow-hidden">
                  <div className="h-full bg-accent rounded-full" style={{ width: `${ch.traffic}%` }} />
                </div>
                <span className="text-[10px] text-text-muted">{ch.traffic}% traffic</span>
              </div>
            </div>
          ))}
          <button className="w-full py-2 text-xs font-medium border border-dashed border-border-default rounded-lg text-text-muted hover:border-accent/40 hover:text-accent transition-colors">
            + Create Channel
          </button>
        </div>
      )}

      {tab === "releases" && (
        <div className="space-y-2">
          {releases.map((r) => (
            <div key={`${r.version}-${r.channel}`} className="bg-surface-base rounded-lg border border-border-default p-3 flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <code className="text-[11px] font-mono text-accent">{r.version}</code>
                  <StatusPill status={r.status} />
                </div>
                <div className="flex items-center gap-3 text-[10px] text-text-muted">
                  <span>Agent: {r.agent}</span>
                  <span>Channel: {r.channel}</span>
                  <span>{r.date}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </CanvasOverlayPanel>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   INFRASTRUCTURE PANEL
   ═══════════════════════════════════════════════════════════════════ */
export function InfrastructurePanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<"gpu" | "retention">("gpu");

  const gpuEndpoints = [
    { id: "gpu_1", name: "inference-a100", type: "A100 80GB", status: "healthy", utilization: 72, cost: "$2.40/hr" },
    { id: "gpu_2", name: "training-h100", type: "H100 80GB", status: "provisioning", utilization: 0, cost: "$3.80/hr" },
  ];

  const retentionPolicies = [
    { name: "Session Logs", retention: "90 days", size: "12.4 GB", status: "active" },
    { name: "Agent Traces", retention: "30 days", size: "4.2 GB", status: "active" },
    { name: "Eval Results", retention: "365 days", size: "1.8 GB", status: "active" },
  ];

  return (
    <CanvasOverlayPanel open={open} onClose={onClose} title="Infrastructure" icon={<Cpu size={16} className="text-accent" />}>
      <div className="flex items-center gap-1 mb-4">
        {(["gpu", "retention"] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${tab === t ? "bg-accent/20 text-accent" : "text-text-muted hover:bg-surface-overlay"}`}>
            {t === "gpu" ? "GPU Endpoints" : "Retention Policies"}
          </button>
        ))}
      </div>

      {tab === "gpu" && (
        <div>
          <div className="space-y-2 mb-4">
            {gpuEndpoints.map((gpu) => (
              <div key={gpu.id} className="bg-surface-base rounded-lg border border-border-default p-3">
                <div className="flex items-center gap-2 mb-2">
                  <Cpu size={12} className="text-accent" />
                  <span className="text-[11px] font-medium text-text-primary flex-1">{gpu.name}</span>
                  <StatusPill status={gpu.status} />
                </div>
                <div className="flex items-center gap-3 text-[10px] text-text-muted mb-2">
                  <span>{gpu.type}</span>
                  <span>{gpu.cost}</span>
                </div>
                {gpu.status === "healthy" && (
                  <div className="flex items-center gap-2">
                    <div className="flex-1 h-1.5 bg-surface-overlay rounded-full overflow-hidden">
                      <div className="h-full bg-accent rounded-full" style={{ width: `${gpu.utilization}%` }} />
                    </div>
                    <span className="text-[10px] text-text-muted">{gpu.utilization}% util</span>
                  </div>
                )}
                <div className="flex gap-2 mt-2">
                  <button className="flex items-center gap-1 px-2 py-1 text-[10px] text-status-error hover:bg-status-error/10 rounded transition-colors">
                    <Pause size={9} /> Terminate
                  </button>
                </div>
              </div>
            ))}
          </div>
          <button className="w-full py-2 text-xs font-medium border border-dashed border-border-default rounded-lg text-text-muted hover:border-accent/40 hover:text-accent transition-colors">
            + Provision GPU Endpoint
          </button>
        </div>
      )}

      {tab === "retention" && (
        <div className="space-y-2">
          {retentionPolicies.map((rp) => (
            <div key={rp.name} className="bg-surface-base rounded-lg border border-border-default p-3 flex items-center gap-3">
              <div className="flex-1">
                <p className="text-[11px] font-medium text-text-primary">{rp.name}</p>
                <div className="flex items-center gap-3 text-[10px] text-text-muted mt-1">
                  <span>Retention: {rp.retention}</span>
                  <span>Size: {rp.size}</span>
                </div>
              </div>
              <StatusPill status={rp.status} />
            </div>
          ))}
        </div>
      )}
    </CanvasOverlayPanel>
  );
}
