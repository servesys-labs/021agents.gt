import { useState } from "react";
import {
  Workflow, Clock, Webhook, ShieldCheck, FolderKanban, Tag, Cpu,
  Play, Pause, Trash2, Plus, RotateCcw, CheckCircle2, XCircle,
  AlertTriangle, Search, Eye, Send, Upload, Settings, Globe,
  MoreVertical, ChevronRight, Zap, Activity, Code, Lock, Unlock,
  KeyRound, RefreshCw,
} from "lucide-react";
import { CanvasOverlayPanel } from "./CanvasOverlayPanel";
import { apiRequest, useApiQuery } from "../../lib/api";
import { StatusPill, SectionTitle, InlineInput, InlineSelect, InlineTextarea, ToggleRow, ReadOnlyNotice } from "./primitives";

/* ═══════════════════════════════════════════════════════════════════
   WORKFLOWS & JOBS PANEL
   ═══════════════════════════════════════════════════════════════════ */
export function WorkflowsPanel({ open, onClose, editable = true }: { open: boolean; onClose: () => void; editable?: boolean }) {
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
      <ReadOnlyNotice editable={editable} />
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
          <button onClick={() => setShowCreate(!showCreate)} disabled={!editable}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-accent text-text-inverse rounded-md hover:bg-accent/90 transition-colors">
            <Plus size={12} /> New Workflow
          </button>
        )}
      </div>

      {/* Create form */}
      {showCreate && tab === "workflows" && (
        <div className="bg-surface-base rounded-lg border border-border-default p-4 mb-4">
          <SectionTitle>Create Workflow</SectionTitle>
          <InlineInput compact label="Name" value={wfName} onChange={setWfName} placeholder="e.g. Customer Onboarding" />
          <InlineTextarea compact label="Description" value={wfDesc} onChange={setWfDesc} placeholder="What does this workflow do?" />
          <div className="flex gap-2 mt-2">
            <button
              className="flex-1 py-2 text-xs font-medium bg-accent text-text-inverse rounded-lg hover:bg-accent/90 transition-colors"
              onClick={async () => {
                if (!editable) return;
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
                    if (!editable) return;
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
                    if (!editable) return;
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
                  job.status === "running" ? "bg-status-warning" :
                  job.status === "completed" ? "bg-status-live" : "bg-text-muted"
                }`} style={{ width: `${job.progress}%` }} />
              </div>
              <div className="flex gap-2">
                {job.status === "running" && (
                  <button
                    className="flex items-center gap-1 px-2 py-1 text-[10px] text-status-error hover:bg-status-error/10 rounded transition-colors"
                    onClick={async () => {
                      if (!editable) return;
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
                      if (!editable) return;
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
export function SchedulesPanel({ open, onClose, editable = true }: { open: boolean; onClose: () => void; editable?: boolean }) {
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
      <ReadOnlyNotice editable={editable} />
      <div className="flex items-center justify-between mb-4">
        <p className="text-xs text-text-muted">{schedules.length} schedules configured</p>
        <button onClick={() => setShowCreate(!showCreate)} disabled={!editable}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-accent text-text-inverse rounded-md hover:bg-accent/90 transition-colors">
          <Plus size={12} /> New Schedule
        </button>
      </div>

      {showCreate && (
        <div className="bg-surface-base rounded-lg border border-border-default p-4 mb-4">
          <SectionTitle>Create Schedule</SectionTitle>
          <InlineInput compact label="Name" value={name} onChange={setName} placeholder="e.g. Morning Report" />
          <InlineInput compact label="Cron Expression" value={cron} onChange={setCron} placeholder="0 0 9 * * 1-5" />
          <p className="text-[10px] text-text-muted -mt-2 mb-3">Format: sec min hour day month weekday</p>
          <InlineInput compact label="Task" value={task} onChange={setTask} placeholder="Describe scheduled task" />
          <InlineSelect compact label="Agent" value={agent} onChange={setAgent}
            options={[{ value: "support-bot", label: "Support Bot" }, { value: "data-analyst", label: "Data Analyst" }]} />
          <div className="flex gap-2 mt-2">
            <button
              className="flex-1 py-2 text-xs font-medium bg-accent text-text-inverse rounded-lg hover:bg-accent/90 transition-colors"
              onClick={async () => {
                if (!editable) return;
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
                  sch.status === "enabled" ? "text-status-warning hover:bg-status-warning/10" : "text-status-live hover:bg-status-live/10"
                }`}
                onClick={async () => {
                  if (!editable) return;
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
                  if (!editable) return;
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
export function WebhooksPanel({ open, onClose, editable = true }: { open: boolean; onClose: () => void; editable?: boolean }) {
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
      <ReadOnlyNotice editable={editable} />
      <div className="flex items-center justify-between mb-4">
        <p className="text-xs text-text-muted">{webhooks.length} webhooks configured</p>
        <button onClick={() => setShowCreate(!showCreate)} disabled={!editable}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-accent text-text-inverse rounded-md hover:bg-accent/90 transition-colors">
          <Plus size={12} /> New Webhook
        </button>
      </div>

      {showCreate && (
        <div className="bg-surface-base rounded-lg border border-border-default p-4 mb-4">
          <SectionTitle>Create Webhook</SectionTitle>
          <InlineInput compact label="Endpoint URL" value={url} onChange={setUrl} placeholder="https://..." />
          <InlineInput compact label="Events (comma-separated)" value={events} onChange={setEvents} placeholder="agent.run.completed, agent.deployed" />
          <div className="flex gap-2 mt-2">
            <button
              className="flex-1 py-2 text-xs font-medium bg-accent text-text-inverse rounded-lg hover:bg-accent/90 transition-colors"
              onClick={async () => {
                if (!editable) return;
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
                if (!editable) return;
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
                if (!editable) return;
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
                if (!editable) return;
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
export function GovernancePanel({ open, onClose, editable = true }: { open: boolean; onClose: () => void; editable?: boolean }) {
  const [tab, setTab] = useState<"policies" | "budgets" | "approvals">("policies");
  const [policyName, setPolicyName] = useState("");
  const [policyBudget, setPolicyBudget] = useState("10");
  const [blockedToolsRaw, setBlockedToolsRaw] = useState("");
  const [actionMessage, setActionMessage] = useState("");
  const policiesQuery = useApiQuery<{ policies?: Array<Record<string, unknown>> }>(
    "/api/v1/policies",
    open,
  );
  const usageQuery = useApiQuery<Record<string, unknown>>(
    "/api/v1/billing/usage?since_days=30",
    open && tab === "budgets",
  );
  const auditQuery = useApiQuery<{ entries?: Array<Record<string, unknown>> }>(
    "/api/v1/audit/log?limit=30&since_days=30",
    open && tab === "approvals",
  );
  const policies = (policiesQuery.data?.policies ?? []).map((p) => ({
    id: String(p.policy_id ?? ""),
    name: String(p.name ?? "Unnamed policy"),
    orgId: String(p.org_id ?? ""),
    policy: (() => {
      try {
        return typeof p.policy_json === "string"
          ? (JSON.parse(p.policy_json) as Record<string, unknown>)
          : {};
      } catch {
        return {};
      }
    })(),
  }));
  const totalCostUsd = Number(usageQuery.data?.total_cost_usd ?? 0);
  const inferenceCostUsd = Number(usageQuery.data?.inference_cost_usd ?? 0);
  const gpuCostUsd = Number(usageQuery.data?.gpu_compute_cost_usd ?? 0);
  const connectorCostUsd = Number(usageQuery.data?.connector_cost_usd ?? 0);
  const policyBudgetValue = Number(policyBudget || "0") || 0;
  const usagePct = policyBudgetValue > 0 ? Math.min(100, (totalCostUsd / policyBudgetValue) * 100) : 0;

  return (
    <CanvasOverlayPanel open={open} onClose={onClose} title="Governance" icon={<ShieldCheck size={16} className="text-accent" />}>
      <ReadOnlyNotice editable={editable} />
      <div className="flex items-center gap-1 mb-4">
        {(["policies", "budgets", "approvals"] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${tab === t ? "bg-accent/20 text-accent" : "text-text-muted hover:bg-surface-overlay"}`}>
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
      {actionMessage && <div className="mb-3 text-[10px] text-text-muted">{actionMessage}</div>}

      {tab === "policies" && (
        <div>
          <div className="bg-surface-base rounded-lg border border-border-default p-4 mb-4">
            <SectionTitle>Create Policy</SectionTitle>
            <InlineInput compact label="Policy Name" value={policyName} onChange={setPolicyName} placeholder="e.g. strict-prod" />
            <InlineInput compact label="Budget Limit (USD)" value={policyBudget} onChange={setPolicyBudget} type="number" />
            <InlineInput compact label="Blocked Tools (comma-separated)" value={blockedToolsRaw} onChange={setBlockedToolsRaw} placeholder="sandbox_exec, web_search" />
            <button
              disabled={!editable}
              className="w-full py-2 text-xs font-medium bg-accent text-text-inverse rounded-lg hover:bg-accent/90 transition-colors disabled:opacity-50"
              onClick={async () => {
                if (!editable) return;
                if (!policyName.trim()) return;
                const query = new URLSearchParams({
                  name: policyName.trim(),
                  budget_limit_usd: String(Number(policyBudget || "0") || 0),
                }).toString();
                try {
                  await apiRequest(`/api/v1/policies?${query}`, "POST");
                  setActionMessage("Policy created");
                  setPolicyName("");
                  setBlockedToolsRaw("");
                  void policiesQuery.refetch();
                } catch (err) {
                  setActionMessage(err instanceof Error ? err.message : "Failed to create policy");
                }
              }}
            >
              Create Policy
            </button>
          </div>
          <div className="bg-surface-base rounded-lg border border-border-default p-4">
            <SectionTitle>Policy Templates</SectionTitle>
            {policiesQuery.loading && <p className="text-xs text-text-muted">Loading policies...</p>}
            {policiesQuery.error && <p className="text-xs text-status-error">{policiesQuery.error}</p>}
            <div className="space-y-2">
              {policies.map((policy) => (
                <div key={policy.id} className="border border-border-default rounded p-2">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-text-primary flex-1">{policy.name}</span>
                    <span className="text-[10px] text-text-muted font-mono">{policy.orgId || "global"}</span>
                    <button
                      disabled={!editable}
                      className="text-[10px] text-status-error disabled:opacity-50"
                      onClick={async () => {
                        if (!editable) return;
                        try {
                          await apiRequest(`/api/v1/policies/${policy.id}`, "DELETE");
                          setActionMessage("Policy deleted");
                          void policiesQuery.refetch();
                        } catch (err) {
                          setActionMessage(err instanceof Error ? err.message : "Failed to delete policy");
                        }
                      }}
                    >
                      Delete
                    </button>
                  </div>
                  <div className="text-[10px] text-text-muted mt-1">
                    Budget: ${Number(policy.policy.budget_limit_usd ?? 0).toFixed(2)} ·
                    Blocked: {Array.isArray(policy.policy.blocked_tools) ? policy.policy.blocked_tools.length : 0}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {tab === "budgets" && (
        <div>
          <div className="grid grid-cols-2 gap-3 mb-4">
            <div className="bg-surface-base rounded-lg border border-border-default p-3">
              <p className="text-[10px] text-text-muted">30d Spend</p>
              <p className="text-lg font-semibold text-text-primary">${totalCostUsd.toFixed(2)}</p>
              <p className="text-[10px] text-text-muted">vs configured policy budget</p>
              <div className="mt-1.5 h-1 bg-surface-overlay rounded-full overflow-hidden">
                <div className="h-full bg-accent rounded-full" style={{ width: `${usagePct}%` }} />
              </div>
            </div>
            <div className="bg-surface-base rounded-lg border border-border-default p-3">
              <p className="text-[10px] text-text-muted">Cost Split</p>
              <div className="text-[11px] text-text-secondary mt-1 space-y-1">
                <p>Inference: ${inferenceCostUsd.toFixed(2)}</p>
                <p>GPU: ${gpuCostUsd.toFixed(2)}</p>
                <p>Connectors: ${connectorCostUsd.toFixed(2)}</p>
              </div>
            </div>
          </div>
          {usageQuery.loading && <p className="text-xs text-text-muted">Loading usage...</p>}
          {usageQuery.error && <p className="text-xs text-status-error">{usageQuery.error}</p>}
        </div>
      )}

      {tab === "approvals" && (
        <div className="space-y-2">
          {auditQuery.loading && <p className="text-xs text-text-muted">Loading recent governance events...</p>}
          {auditQuery.error && <p className="text-xs text-status-error">{auditQuery.error}</p>}
          {(auditQuery.data?.entries ?? []).slice(0, 20).map((entry, idx) => (
            <div key={`${entry.id ?? entry.created_at ?? idx}`} className="bg-surface-base rounded-lg border border-border-default p-3">
              <div className="flex items-center gap-2 mb-1">
                <ShieldCheck size={12} className="text-accent" />
                <span className="text-[11px] font-medium text-text-primary flex-1">
                  {String(entry.action ?? "event")}
                </span>
                <span className="text-[10px] text-text-muted">
                  {entry.created_at ? new Date(Number(entry.created_at) * 1000).toLocaleString() : ""}
                </span>
              </div>
              <div className="text-[10px] text-text-muted">
                user: {String(entry.user_id ?? "system")} · resource: {String(entry.resource_type ?? "n/a")}
              </div>
            </div>
          ))}
        </div>
      )}
    </CanvasOverlayPanel>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   PROJECTS & ENVIRONMENTS PANEL
   ═══════════════════════════════════════════════════════════════════ */
export function ProjectsPanel({ open, onClose, editable = true }: { open: boolean; onClose: () => void; editable?: boolean }) {
  const [selectedProject, setSelectedProject] = useState<string>("");
  const [showCreate, setShowCreate] = useState(false);
  const [projName, setProjName] = useState("");
  const [projDesc, setProjDesc] = useState("");
  const [envPlan, setEnvPlan] = useState("standard");
  const [actionMessage, setActionMessage] = useState("");
  const projectsQuery = useApiQuery<{ projects?: Array<Record<string, unknown>> }>(
    "/api/v1/projects",
    open,
  );
  const envsQuery = useApiQuery<{ environments?: Array<Record<string, unknown>> }>(
    `/api/v1/projects/${selectedProject}/envs`,
    open && Boolean(selectedProject),
  );
  const projects = (projectsQuery.data?.projects ?? []).map((p) => ({
    id: String(p.project_id ?? ""),
    name: String(p.name ?? "project"),
    description: String(p.description ?? ""),
    slug: String(p.slug ?? ""),
    plan: String(p.default_plan ?? "standard"),
    createdAt: Number(p.created_at ?? 0),
  }));
  const envs = (envsQuery.data?.environments ?? []).map((e) => ({
    id: String(e.env_id ?? ""),
    name: String(e.name ?? ""),
    plan: String(e.plan ?? "standard"),
  }));

  return (
    <CanvasOverlayPanel open={open} onClose={onClose} title="Projects & Environments" icon={<FolderKanban size={16} className="text-accent" />}>
      <ReadOnlyNotice editable={editable} />
      <div className="flex items-center justify-between mb-4">
        <p className="text-xs text-text-muted">{projects.length} projects</p>
        <button onClick={() => setShowCreate(!showCreate)} disabled={!editable}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-accent text-text-inverse rounded-md hover:bg-accent/90 transition-colors">
          <Plus size={12} /> New Project
        </button>
      </div>
      {actionMessage && <div className="mb-3 text-[10px] text-text-muted">{actionMessage}</div>}

      {showCreate && (
        <div className="bg-surface-base rounded-lg border border-border-default p-4 mb-4">
          <SectionTitle>Create Project</SectionTitle>
          <InlineInput compact label="Name" value={projName} onChange={setProjName} placeholder="e.g. my-agents" />
          <InlineTextarea compact label="Description" value={projDesc} onChange={setProjDesc} placeholder="What is this project for?" />
          <div className="flex gap-2 mt-2">
            <button
              disabled={!editable}
              className="flex-1 py-2 text-xs font-medium bg-accent text-text-inverse rounded-lg hover:bg-accent/90 transition-colors disabled:opacity-50"
              onClick={async () => {
                if (!editable) return;
                if (!projName.trim()) return;
                const qs = new URLSearchParams({
                  name: projName.trim(),
                  description: projDesc.trim(),
                  plan: "standard",
                }).toString();
                try {
                  const created = await apiRequest<{ meta_agent?: { name?: string; created?: boolean } }>(
                    `/api/v1/projects?${qs}`,
                    "POST",
                  );
                  const metaName = created.meta_agent?.name || "meta-agent";
                  const metaCreated = created.meta_agent?.created;
                  setActionMessage(
                    metaCreated
                      ? `Project created and ${metaName} initialized`
                      : `Project created (${metaName} already existed)`,
                  );
                  setProjName("");
                  setProjDesc("");
                  setShowCreate(false);
                  void projectsQuery.refetch();
                } catch (err) {
                  setActionMessage(err instanceof Error ? err.message : "Failed to create project");
                }
              }}
            >
              Create
            </button>
            <button onClick={() => setShowCreate(false)} className="px-4 py-2 text-xs text-text-muted hover:text-text-primary transition-colors">Cancel</button>
          </div>
        </div>
      )}

      <div className="space-y-3">
        {projectsQuery.loading && <p className="text-xs text-text-muted">Loading projects...</p>}
        {projectsQuery.error && <p className="text-xs text-status-error">{projectsQuery.error}</p>}
        {projects.map((proj) => (
          <div key={proj.id} className="bg-surface-base rounded-lg border border-border-default overflow-hidden">
            <button onClick={() => setSelectedProject(selectedProject === proj.id ? "" : proj.id)}
              className="w-full flex items-center gap-3 p-3 hover:bg-surface-overlay/50 transition-colors">
              <FolderKanban size={14} className="text-accent flex-shrink-0" />
              <div className="flex-1 text-left min-w-0">
                <p className="text-[11px] font-medium text-text-primary">{proj.name}</p>
                <p className="text-[10px] text-text-muted">{proj.description}</p>
              </div>
              <span className="text-[10px] text-text-muted">{proj.plan}</span>
              <ChevronRight size={12} className={`text-text-muted transition-transform ${selectedProject === proj.id ? "rotate-90" : ""}`} />
            </button>

            {selectedProject === proj.id && (
              <div className="border-t border-border-default p-3">
                <div className="flex items-center gap-2 mb-3">
                  <SectionTitle>Environments</SectionTitle>
                </div>
                {envsQuery.loading && <p className="text-xs text-text-muted">Loading environments...</p>}
                {envsQuery.error && <p className="text-xs text-status-error">{envsQuery.error}</p>}
                <div className="flex gap-2 mb-4">
                  {envs.map((env) => (
                    <button
                      key={env.id}
                      disabled={!editable}
                      className="text-[10px] px-2 py-1 rounded-md bg-surface-overlay text-text-secondary disabled:opacity-50"
                      onClick={async () => {
                        if (!editable) return;
                        const nextPlan = envPlan === "standard" ? "pro" : "standard";
                        const qs = new URLSearchParams({ plan: nextPlan }).toString();
                        try {
                          await apiRequest(`/api/v1/projects/${proj.id}/envs/${env.name}?${qs}`, "PUT");
                          setActionMessage(`Updated ${env.name} plan to ${nextPlan}`);
                          setEnvPlan(nextPlan);
                          void envsQuery.refetch();
                        } catch (err) {
                          setActionMessage(err instanceof Error ? err.message : "Failed to update environment");
                        }
                      }}
                    >
                      {env.name} ({env.plan})
                    </button>
                  ))}
                </div>
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
export function ReleasesPanel({ open, onClose, editable = true }: { open: boolean; onClose: () => void; editable?: boolean }) {
  const [tab, setTab] = useState<"channels" | "releases">("channels");
  const [agentName, setAgentName] = useState("support-bot");
  const [canaryVersion, setCanaryVersion] = useState("v-next");
  const [canaryWeight, setCanaryWeight] = useState("0.1");
  const [actionMessage, setActionMessage] = useState("");
  const channelsQuery = useApiQuery<{ channels?: Array<Record<string, unknown>> }>(
    `/api/v1/releases/${encodeURIComponent(agentName)}/channels`,
    open,
  );
  const canaryQuery = useApiQuery<{ canary?: Record<string, unknown> | null }>(
    `/api/v1/releases/${encodeURIComponent(agentName)}/canary`,
    open,
  );
  const channels = (channelsQuery.data?.channels ?? []).map((c) => ({
    name: String(c.channel ?? ""),
    version: String(c.version ?? ""),
    status: "active",
    promotedAt: Number(c.promoted_at ?? 0),
  }));
  const releases = channels.map((c) => ({
    version: c.version,
    agent: agentName,
    channel: c.name,
    status: c.status,
    date: c.promotedAt ? new Date(c.promotedAt * 1000).toLocaleString() : "n/a",
  }));
  const canary = canaryQuery.data?.canary ?? null;

  return (
    <CanvasOverlayPanel open={open} onClose={onClose} title="Release Channels" icon={<Tag size={16} className="text-accent" />}>
      <ReadOnlyNotice editable={editable} />
      <div className="mb-3">
        <InlineInput compact label="Agent Name" value={agentName} onChange={setAgentName} placeholder="support-bot" />
      </div>
      {actionMessage && <div className="mb-3 text-[10px] text-text-muted">{actionMessage}</div>}
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
          {channelsQuery.loading && <p className="text-xs text-text-muted">Loading channels...</p>}
          {channelsQuery.error && <p className="text-xs text-status-error">{channelsQuery.error}</p>}
          {channels.map((ch) => (
            <div key={ch.name} className="bg-surface-base rounded-lg border border-border-default p-3">
              <div className="flex items-center gap-2 mb-2">
                <Tag size={12} className="text-accent" />
                <span className="text-[11px] font-medium text-text-primary flex-1">{ch.name}</span>
                <code className="text-[10px] font-mono text-text-muted">{ch.version}</code>
                <StatusPill status={ch.status} />
              </div>
              <div className="text-[10px] text-text-muted">Promoted: {ch.promotedAt ? new Date(ch.promotedAt * 1000).toLocaleString() : "n/a"}</div>
            </div>
          ))}
          <div className="bg-surface-base rounded-lg border border-border-default p-3">
            <p className="text-[10px] text-text-muted mb-2">Promote Draft → Staging</p>
            <button
              disabled={!editable}
              className="w-full py-2 text-xs font-medium border border-dashed border-border-default rounded-lg text-text-muted hover:border-accent/40 hover:text-accent transition-colors disabled:opacity-50"
              onClick={async () => {
                if (!editable) return;
                try {
                  const qs = new URLSearchParams({ from_channel: "draft", to_channel: "staging" }).toString();
                  await apiRequest(`/api/v1/releases/${encodeURIComponent(agentName)}/promote?${qs}`, "POST");
                  setActionMessage("Promoted draft to staging");
                  void channelsQuery.refetch();
                } catch (err) {
                  setActionMessage(err instanceof Error ? err.message : "Failed to promote");
                }
              }}
            >
              Promote
            </button>
          </div>
          <div className="bg-surface-base rounded-lg border border-border-default p-3">
            <p className="text-[10px] text-text-muted mb-2">Canary Split</p>
            <InlineInput compact label="Canary Version" value={canaryVersion} onChange={setCanaryVersion} placeholder="v-next" />
            <InlineInput compact label="Canary Weight (0-1)" value={canaryWeight} onChange={setCanaryWeight} type="number" />
            <div className="flex gap-2">
              <button
                disabled={!editable}
                className="flex-1 py-2 text-xs font-medium bg-accent text-text-inverse rounded-lg hover:bg-accent/90 transition-colors disabled:opacity-50"
                onClick={async () => {
                  if (!editable) return;
                  try {
                    const primary = channels.find((c) => c.name === "production")?.version || "current";
                    const qs = new URLSearchParams({
                      primary_version: primary,
                      canary_version: canaryVersion,
                      canary_weight: String(Number(canaryWeight || "0.1")),
                    }).toString();
                    await apiRequest(`/api/v1/releases/${encodeURIComponent(agentName)}/canary?${qs}`, "POST");
                    setActionMessage("Canary updated");
                    void canaryQuery.refetch();
                  } catch (err) {
                    setActionMessage(err instanceof Error ? err.message : "Failed to set canary");
                  }
                }}
              >
                Set Canary
              </button>
              <button
                disabled={!editable || !canary}
                className="px-3 py-2 text-xs border border-border-default rounded-lg text-text-muted disabled:opacity-50"
                onClick={async () => {
                  if (!editable) return;
                  try {
                    await apiRequest(`/api/v1/releases/${encodeURIComponent(agentName)}/canary`, "DELETE");
                    setActionMessage("Canary removed");
                    void canaryQuery.refetch();
                  } catch (err) {
                    setActionMessage(err instanceof Error ? err.message : "Failed to remove canary");
                  }
                }}
              >
                Remove
              </button>
            </div>
            {canary && (
              <p className="mt-2 text-[10px] text-text-muted">
                Active canary: {String(canary.canary_version ?? "")} @ {Number(canary.canary_weight ?? 0) * 100}%
              </p>
            )}
          </div>
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
export function InfrastructurePanel({ open, onClose, editable = true }: { open: boolean; onClose: () => void; editable?: boolean }) {
  const [tab, setTab] = useState<"gpu" | "retention">("gpu");
  const [modelId, setModelId] = useState("gpt-4.1-mini");
  const [gpuType, setGpuType] = useState("h200");
  const [gpuCount, setGpuCount] = useState("1");
  const [resourceType, setResourceType] = useState("sessions");
  const [retentionDays, setRetentionDays] = useState("90");
  const [actionMessage, setActionMessage] = useState("");
  const gpuQuery = useApiQuery<{ endpoints?: Array<Record<string, unknown>> }>(
    "/api/v1/gpu/endpoints",
    open && tab === "gpu",
  );
  const retentionQuery = useApiQuery<{ policies?: Array<Record<string, unknown>> }>(
    "/api/v1/retention",
    open && tab === "retention",
  );
  const gpuEndpoints = (gpuQuery.data?.endpoints ?? []).map((gpu) => ({
    id: String(gpu.endpoint_id ?? ""),
    modelId: String(gpu.model_id ?? ""),
    type: String(gpu.gpu_type ?? ""),
    status: String(gpu.status ?? "unknown"),
    count: Number(gpu.gpu_count ?? 1),
    cost: Number(gpu.hourly_rate_usd ?? 0),
  }));
  const retentionPolicies = (retentionQuery.data?.policies ?? []).map((rp) => ({
    id: String(rp.policy_id ?? ""),
    type: String(rp.resource_type ?? ""),
    retention: Number(rp.retention_days ?? 0),
    status: Boolean(rp.is_active ?? true) ? "active" : "disabled",
  }));

  return (
    <CanvasOverlayPanel open={open} onClose={onClose} title="Infrastructure" icon={<Cpu size={16} className="text-accent" />}>
      <ReadOnlyNotice editable={editable} />
      {actionMessage && <div className="mb-3 text-[10px] text-text-muted">{actionMessage}</div>}
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
          <div className="bg-surface-base rounded-lg border border-border-default p-3 mb-3">
            <SectionTitle>Provision Endpoint</SectionTitle>
            <InlineInput compact label="Model ID" value={modelId} onChange={setModelId} placeholder="gpt-4.1-mini" />
            <InlineSelect compact label="GPU Type" value={gpuType} onChange={setGpuType} options={[
              { value: "h200", label: "H200" },
              { value: "h100", label: "H100" },
            ]} />
            <InlineInput compact label="GPU Count" value={gpuCount} onChange={setGpuCount} type="number" />
            <button
              disabled={!editable}
              className="w-full py-2 text-xs font-medium bg-accent text-text-inverse rounded-lg hover:bg-accent/90 transition-colors disabled:opacity-50"
              onClick={async () => {
                if (!editable) return;
                const qs = new URLSearchParams({
                  model_id: modelId,
                  gpu_type: gpuType,
                  gpu_count: String(Number(gpuCount || "1") || 1),
                }).toString();
                try {
                  await apiRequest(`/api/v1/gpu/endpoints?${qs}`, "POST");
                  setActionMessage("GPU provisioning requested");
                  void gpuQuery.refetch();
                } catch (err) {
                  setActionMessage(err instanceof Error ? err.message : "Failed to provision endpoint");
                }
              }}
            >
              Provision
            </button>
          </div>
          <div className="space-y-2 mb-4">
            {gpuQuery.loading && <p className="text-xs text-text-muted">Loading GPU endpoints...</p>}
            {gpuQuery.error && <p className="text-xs text-status-error">{gpuQuery.error}</p>}
            {gpuEndpoints.map((gpu) => (
              <div key={gpu.id} className="bg-surface-base rounded-lg border border-border-default p-3">
                <div className="flex items-center gap-2 mb-2">
                  <Cpu size={12} className="text-accent" />
                  <span className="text-[11px] font-medium text-text-primary flex-1">{gpu.id}</span>
                  <StatusPill status={gpu.status} />
                </div>
                <div className="flex items-center gap-3 text-[10px] text-text-muted mb-2">
                  <span>{gpu.type} x{gpu.count}</span>
                  <span>${gpu.cost.toFixed(2)}/hr</span>
                  <span>{gpu.modelId}</span>
                </div>
                <div className="flex gap-2 mt-2">
                  <button
                    disabled={!editable}
                    className="flex items-center gap-1 px-2 py-1 text-[10px] text-status-error hover:bg-status-error/10 rounded transition-colors disabled:opacity-50"
                    onClick={async () => {
                      if (!editable) return;
                      try {
                        await apiRequest(`/api/v1/gpu/endpoints/${gpu.id}`, "DELETE");
                        setActionMessage("GPU endpoint terminated");
                        void gpuQuery.refetch();
                      } catch (err) {
                        setActionMessage(err instanceof Error ? err.message : "Failed to terminate endpoint");
                      }
                    }}
                  >
                    <Pause size={9} /> Terminate
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === "retention" && (
        <div>
          <div className="bg-surface-base rounded-lg border border-border-default p-3 mb-3">
            <SectionTitle>Create Retention Policy</SectionTitle>
            <InlineSelect compact label="Resource Type" value={resourceType} onChange={setResourceType} options={[
              { value: "sessions", label: "sessions" },
              { value: "turns", label: "turns" },
              { value: "episodes", label: "episodes" },
              { value: "billing_records", label: "billing_records" },
              { value: "audit_log", label: "audit_log" },
              { value: "cost_ledger", label: "cost_ledger" },
            ]} />
            <InlineInput compact label="Retention Days" value={retentionDays} onChange={setRetentionDays} type="number" />
            <div className="flex gap-2">
              <button
                disabled={!editable}
                className="flex-1 py-2 text-xs font-medium bg-accent text-text-inverse rounded-lg hover:bg-accent/90 transition-colors disabled:opacity-50"
                onClick={async () => {
                  if (!editable) return;
                  const qs = new URLSearchParams({
                    resource_type: resourceType,
                    retention_days: String(Number(retentionDays || "90") || 90),
                  }).toString();
                  try {
                    await apiRequest(`/api/v1/retention?${qs}`, "POST");
                    setActionMessage("Retention policy created");
                    void retentionQuery.refetch();
                  } catch (err) {
                    setActionMessage(err instanceof Error ? err.message : "Failed to create retention policy");
                  }
                }}
              >
                Create
              </button>
              <button
                disabled={!editable}
                className="px-3 py-2 text-xs border border-border-default rounded-lg text-text-muted disabled:opacity-50"
                onClick={async () => {
                  if (!editable) return;
                  try {
                    await apiRequest("/api/v1/retention/apply", "POST");
                    setActionMessage("Retention policies applied");
                  } catch (err) {
                    setActionMessage(err instanceof Error ? err.message : "Failed to apply retention");
                  }
                }}
              >
                Apply
              </button>
            </div>
          </div>
          <div className="space-y-2">
          {retentionQuery.loading && <p className="text-xs text-text-muted">Loading retention policies...</p>}
          {retentionQuery.error && <p className="text-xs text-status-error">{retentionQuery.error}</p>}
          {retentionPolicies.map((rp) => (
            <div key={rp.id} className="bg-surface-base rounded-lg border border-border-default p-3 flex items-center gap-3">
              <div className="flex-1">
                <p className="text-[11px] font-medium text-text-primary">{rp.type}</p>
                <div className="flex items-center gap-3 text-[10px] text-text-muted mt-1">
                  <span>Retention: {rp.retention} days</span>
                </div>
              </div>
              <StatusPill status={rp.status} />
              <button
                disabled={!editable}
                className="text-[10px] text-status-error disabled:opacity-50"
                onClick={async () => {
                  if (!editable) return;
                  try {
                    await apiRequest(`/api/v1/retention/${rp.id}`, "DELETE");
                    setActionMessage("Retention policy deleted");
                    void retentionQuery.refetch();
                  } catch (err) {
                    setActionMessage(err instanceof Error ? err.message : "Failed to delete retention policy");
                  }
                }}
              >
                Delete
              </button>
            </div>
          ))}
          </div>
        </div>
      )}
    </CanvasOverlayPanel>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   SECRETS VAULT PANEL
   ═══════════════════════════════════════════════════════════════════ */
export function SecretsPanel({ open, onClose, editable = true }: { open: boolean; onClose: () => void; editable?: boolean }) {
  const [showCreate, setShowCreate] = useState(false);
  const [secretName, setSecretName] = useState("");
  const [secretValue, setSecretValue] = useState("");
  const [rotatingId, setRotatingId] = useState<string | null>(null);
  const [rotateValue, setRotateValue] = useState("");
  const [actionMessage, setActionMessage] = useState("");

  const secretsQuery = useApiQuery<{ secrets?: Array<Record<string, unknown>> }>(
    "/api/v1/secrets",
    open,
  );
  const secrets = (secretsQuery.data?.secrets ?? (Array.isArray(secretsQuery.data) ? secretsQuery.data : [])).map((s: Record<string, unknown>) => ({
    id: String(s.secret_id ?? s.id ?? ""),
    name: String(s.name ?? ""),
    keyPrefix: String(s.key_prefix ?? ""),
    createdAt: Number(s.created_at ?? 0),
    updatedAt: Number(s.updated_at ?? 0),
  }));

  return (
    <CanvasOverlayPanel open={open} onClose={onClose} title="Secrets Vault" icon={<KeyRound size={16} className="text-accent" />}>
      <ReadOnlyNotice editable={editable} />
      <div className="flex items-center justify-between mb-4">
        <p className="text-xs text-text-muted">{secrets.length} secrets stored</p>
        <button onClick={() => setShowCreate(!showCreate)} disabled={!editable}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-accent text-text-inverse rounded-md hover:bg-accent/90 transition-colors">
          <Plus size={12} /> New Secret
        </button>
      </div>

      {showCreate && (
        <div className="bg-surface-base rounded-lg border border-border-default p-4 mb-4">
          <SectionTitle>Create Secret</SectionTitle>
          <InlineInput compact label="Name" value={secretName} onChange={setSecretName} placeholder="e.g. OPENAI_API_KEY" />
          <div className="flex items-center gap-2 py-1.5">
            <label className="text-[11px] text-text-muted w-28 shrink-0">Value</label>
            <input
              type="password"
              value={secretValue}
              onChange={(e) => setSecretValue(e.target.value)}
              placeholder="Enter secret value"
              className="flex-1 px-2 py-1.5 text-xs bg-surface-base border border-border-default rounded-md text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent/50"
            />
          </div>
          <div className="flex gap-2 mt-2">
            <button
              className="flex-1 py-2 text-xs font-medium bg-accent text-text-inverse rounded-lg hover:bg-accent/90 transition-colors"
              onClick={async () => {
                if (!editable) return;
                if (!secretName.trim() || !secretValue.trim()) return;
                try {
                  await apiRequest("/api/v1/secrets", "POST", {
                    name: secretName.trim(),
                    value: secretValue.trim(),
                  });
                  setSecretName("");
                  setSecretValue("");
                  setShowCreate(false);
                  setActionMessage("Secret created");
                  void secretsQuery.refetch();
                } catch (err) {
                  setActionMessage(err instanceof Error ? err.message : "Failed to create secret");
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
        {secretsQuery.loading && <p className="text-xs text-text-muted">Loading secrets...</p>}
        {secretsQuery.error && <p className="text-xs text-status-error">{secretsQuery.error}</p>}
        {secrets.map((secret) => (
          <div key={secret.id} className="bg-surface-base rounded-lg border border-border-default p-3">
            <div className="flex items-center gap-2 mb-2">
              <KeyRound size={12} className="text-accent" />
              <span className="text-[11px] font-medium text-text-primary flex-1 font-mono">{secret.name}</span>
              <span className="text-[10px] font-mono text-text-muted px-1.5 py-0.5 rounded bg-surface-overlay">
                {secret.keyPrefix ? `${secret.keyPrefix}••••••` : "••••••••"}
              </span>
            </div>
            <div className="flex items-center gap-3 text-[10px] text-text-muted mb-2">
              <span>Created: {secret.createdAt ? new Date(secret.createdAt * 1000).toLocaleDateString() : "n/a"}</span>
              {secret.updatedAt > 0 && <span>Updated: {new Date(secret.updatedAt * 1000).toLocaleDateString()}</span>}
            </div>

            {/* Inline rotate form */}
            {rotatingId === secret.id && (
              <div className="bg-surface-overlay rounded-md border border-border-default p-2 mb-2">
                <div className="flex items-center gap-2">
                  <input
                    type="password"
                    value={rotateValue}
                    onChange={(e) => setRotateValue(e.target.value)}
                    placeholder="New secret value"
                    className="flex-1 px-2 py-1 text-xs bg-surface-base border border-border-default rounded text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent/50"
                  />
                  <button
                    className="px-2 py-1 text-[10px] font-medium bg-accent text-text-inverse rounded hover:bg-accent/90 transition-colors"
                    onClick={async () => {
                      if (!editable || !rotateValue.trim()) return;
                      try {
                        await apiRequest(`/api/v1/secrets/${secret.id}`, "PUT", {
                          value: rotateValue.trim(),
                        });
                        setRotatingId(null);
                        setRotateValue("");
                        setActionMessage("Secret rotated");
                        void secretsQuery.refetch();
                      } catch (err) {
                        setActionMessage(err instanceof Error ? err.message : "Failed to rotate secret");
                      }
                    }}
                  >
                    Save
                  </button>
                  <button
                    className="px-2 py-1 text-[10px] text-text-muted hover:text-text-primary transition-colors"
                    onClick={() => { setRotatingId(null); setRotateValue(""); }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            <div className="flex gap-2">
              <button
                className="flex items-center gap-1 px-2 py-1 text-[10px] text-accent hover:bg-accent/10 rounded transition-colors"
                disabled={!editable}
                onClick={() => {
                  setRotatingId(rotatingId === secret.id ? null : secret.id);
                  setRotateValue("");
                }}
              >
                <RefreshCw size={9} /> Rotate
              </button>
              <button
                className="flex items-center gap-1 px-2 py-1 text-[10px] text-status-error hover:bg-status-error/10 rounded transition-colors ml-auto"
                disabled={!editable}
                onClick={async () => {
                  if (!editable) return;
                  try {
                    await apiRequest(`/api/v1/secrets/${secret.id}`, "DELETE");
                    setActionMessage("Secret deleted");
                    void secretsQuery.refetch();
                  } catch (err) {
                    setActionMessage(err instanceof Error ? err.message : "Failed to delete secret");
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
