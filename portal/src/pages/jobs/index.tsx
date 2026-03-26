import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import {
  Timer,
  Plus,
  Play,
  Pause,
  Trash2,
  Edit3,
  X,
  Loader2,
  Search,
  ChevronDown,
  ChevronRight,
  RotateCcw,
  XCircle,
  Calendar,
  Clock,
  Hash,
  AlertTriangle,
} from "lucide-react";

import { PageHeader } from "../../components/common/PageHeader";
import { QueryState } from "../../components/common/QueryState";
import { EmptyState } from "../../components/common/EmptyState";
import { useApiQuery, apiPost, apiPut, apiDelete } from "../../lib/api";
import { useToast } from "../../components/common/ToastProvider";

/* ── Cron Preview Helper ─────────────────────────────────────────── */

function cronToHuman(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return expr;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

  // Every N minutes: */N * * * *
  if (minute.startsWith("*/") && hour === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    const n = minute.slice(2);
    return n === "1" ? "Every minute" : `Every ${n} minutes`;
  }

  // Every hour at minute M: M * * * *
  if (/^\d+$/.test(minute) && hour === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    return `Every hour at minute ${minute}`;
  }

  // Every N hours: 0 */N * * *
  if (minute === "0" && hour.startsWith("*/") && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    const n = hour.slice(2);
    return n === "1" ? "Every hour" : `Every ${n} hours`;
  }

  // Daily at H:MM
  if (/^\d+$/.test(minute) && /^\d+$/.test(hour) && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    const h = parseInt(hour, 10);
    const m = parseInt(minute, 10);
    const ampm = h >= 12 ? "PM" : "AM";
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    const mStr = m.toString().padStart(2, "0");
    return `Every day at ${h12}:${mStr} ${ampm}`;
  }

  // Weekly on day D at H:MM
  if (/^\d+$/.test(minute) && /^\d+$/.test(hour) && dayOfMonth === "*" && month === "*" && /^\d+$/.test(dayOfWeek)) {
    const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const day = days[parseInt(dayOfWeek, 10)] ?? dayOfWeek;
    const h = parseInt(hour, 10);
    const m = parseInt(minute, 10);
    if (h === 0 && m === 0) return `Every ${day} at midnight`;
    const ampm = h >= 12 ? "PM" : "AM";
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    const mStr = m.toString().padStart(2, "0");
    return `Every ${day} at ${h12}:${mStr} ${ampm}`;
  }

  // Monthly on Dth at H:MM
  if (/^\d+$/.test(minute) && /^\d+$/.test(hour) && /^\d+$/.test(dayOfMonth) && month === "*" && dayOfWeek === "*") {
    const d = parseInt(dayOfMonth, 10);
    const h = parseInt(hour, 10);
    const m = parseInt(minute, 10);
    const suffix = d === 1 ? "st" : d === 2 ? "nd" : d === 3 ? "rd" : "th";
    if (h === 0 && m === 0) return `Monthly on the ${d}${suffix} at midnight`;
    const ampm = h >= 12 ? "PM" : "AM";
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    const mStr = m.toString().padStart(2, "0");
    return `Monthly on the ${d}${suffix} at ${h12}:${mStr} ${ampm}`;
  }

  return expr;
}

/* ── Types ──────────────────────────────────────────────────────── */

type JobType =
  | "agent_run"
  | "security_scan"
  | "eval_run"
  | "compliance_check"
  | "maintenance_run"
  | "retention_cleanup"
  | "custom";

type ScheduledJob = {
  id: string;
  name: string;
  cron_expression: string;
  job_type: JobType;
  agent_name?: string;
  task?: string;
  enabled: boolean;
  last_run_at?: string;
  last_run_result?: string;
  total_runs: number;
};

type RunningJob = {
  job_id: string;
  type: JobType;
  agent_name?: string;
  started_at: string;
  status: "running";
};

type HistoryJob = {
  job_id: string;
  type: JobType;
  agent_name?: string;
  started_at: string;
  duration_ms: number;
  status: "completed" | "failed";
  result?: string;
  result_json?: Record<string, unknown>;
};

type DeadLetterJob = {
  job_id: string;
  type: JobType;
  agent_name?: string;
  failed_at: string;
  error: string;
  retry_count: number;
};

type Agent = {
  name: string;
};

/* ── Job type badge config ──────────────────────────────────────── */

const JOB_TYPE_CONFIG: Record<JobType, { label: string; classes: string; description: string }> = {
  agent_run: {
    label: "Agent Run",
    classes: "bg-chart-orange/15 text-chart-orange border-chart-orange/20",
    description: "Run an agent with a specific task on schedule",
  },
  security_scan: {
    label: "Security Scan",
    classes: "bg-chart-blue/15 text-chart-blue border-chart-blue/20",
    description: "OWASP security scan on an agent's config",
  },
  eval_run: {
    label: "Eval Run",
    classes: "bg-chart-green/15 text-chart-green border-chart-green/20",
    description: "Run an eval dataset against an agent",
  },
  compliance_check: {
    label: "Compliance",
    classes: "bg-status-warning/15 text-status-warning border-status-warning/20",
    description: "Check agent config drift against gold images",
  },
  maintenance_run: {
    label: "Maintenance",
    classes: "bg-chart-purple/15 text-chart-purple border-chart-purple/20",
    description: "Run autonomous meta-agent maintenance cycle",
  },
  retention_cleanup: {
    label: "Retention",
    classes: "bg-chart-cyan/15 text-chart-cyan border-chart-cyan/20",
    description: "Apply data retention policies, delete old data",
  },
  custom: {
    label: "Custom",
    classes: "bg-surface-overlay text-text-secondary border-border-default",
    description: "Send arbitrary payload to the job queue",
  },
};

function JobTypeBadge({ type }: { type: JobType }) {
  const cfg = JOB_TYPE_CONFIG[type] ?? JOB_TYPE_CONFIG.custom;
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase border ${cfg.classes}`}>
      {cfg.label}
    </span>
  );
}

/* ── Elapsed time component ─────────────────────────────────────── */

function ElapsedTime({ since }: { since: string }) {
  const [elapsed, setElapsed] = useState("");
  const startRef = useRef(new Date(since).getTime());

  useEffect(() => {
    startRef.current = new Date(since).getTime();
    const tick = () => {
      const diff = Math.max(0, Math.floor((Date.now() - startRef.current) / 1000));
      const h = Math.floor(diff / 3600);
      const m = Math.floor((diff % 3600) / 60);
      const s = diff % 60;
      setElapsed(
        h > 0
          ? `${h}h ${m}m ${s}s`
          : m > 0
            ? `${m}m ${s}s`
            : `${s}s`,
      );
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [since]);

  return <span className="font-mono text-[var(--text-xs)]">{elapsed}</span>;
}

/* ── Format helpers ─────────────────────────────────────────────── */

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m ${rs}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function truncateId(id: string): string {
  return id.length > 12 ? id.slice(0, 8) + "..." : id;
}

/* ── Tab definitions ────────────────────────────────────────────── */

const TABS = ["Scheduled", "Running", "History", "Dead Letter"] as const;
type Tab = (typeof TABS)[number];

/* ── Quick cron presets ─────────────────────────────────────────── */

const CRON_PRESETS = [
  { label: "Every hour", value: "0 * * * *" },
  { label: "Daily 2am", value: "0 2 * * *" },
  { label: "Weekly Monday", value: "0 0 * * 1" },
  { label: "Monthly 1st", value: "0 0 1 * *" },
];

/* ── Job types requiring agent selector ─────────────────────────── */

const AGENT_JOB_TYPES: JobType[] = ["agent_run", "security_scan", "eval_run", "maintenance_run"];

/* ── Component ──────────────────────────────────────────────────── */

export function JobsPage() {
  const { showToast } = useToast();
  const [activeTab, setActiveTab] = useState<Tab>("Scheduled");
  const [modalOpen, setModalOpen] = useState(false);
  const [editingJob, setEditingJob] = useState<ScheduledJob | null>(null);

  /* ── Scheduled tab state ─────────────────────────────────────── */
  const schedulesQuery = useApiQuery<{ schedules: ScheduledJob[] } | ScheduledJob[]>(
    "/api/v1/schedules",
  );
  const schedules: ScheduledJob[] = useMemo(() => {
    const raw = schedulesQuery.data;
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    return raw.schedules ?? [];
  }, [schedulesQuery.data]);

  /* ── Running tab state ───────────────────────────────────────── */
  const runningQuery = useApiQuery<{ jobs: RunningJob[] } | RunningJob[]>(
    "/api/v1/jobs?status=running",
    activeTab === "Running",
  );
  const runningJobs: RunningJob[] = useMemo(() => {
    const raw = runningQuery.data;
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    return raw.jobs ?? [];
  }, [runningQuery.data]);

  // Auto-refresh running jobs every 5s
  useEffect(() => {
    if (activeTab !== "Running") return;
    const id = setInterval(() => {
      runningQuery.refetch();
    }, 5000);
    return () => clearInterval(id);
  }, [activeTab, runningQuery]);

  /* ── History tab state ───────────────────────────────────────── */
  const [historyTypeFilter, setHistoryTypeFilter] = useState<string>("all");
  const [historyStatusFilter, setHistoryStatusFilter] = useState<string>("all");
  const [historyPage, setHistoryPage] = useState(0);
  const [expandedRow, setExpandedRow] = useState<string | null>(null);

  const historyPath = useMemo(() => {
    const params = new URLSearchParams();
    if (historyStatusFilter === "all") {
      params.set("status", "completed,failed");
    } else {
      params.set("status", historyStatusFilter);
    }
    params.set("limit", "50");
    params.set("offset", String(historyPage * 50));
    return `/api/v1/jobs?${params.toString()}`;
  }, [historyStatusFilter, historyPage]);

  const historyQuery = useApiQuery<{ jobs: HistoryJob[] } | HistoryJob[]>(
    historyPath,
    activeTab === "History",
  );
  const historyJobs: HistoryJob[] = useMemo(() => {
    const raw = historyQuery.data;
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    return raw.jobs ?? [];
  }, [historyQuery.data]);

  const filteredHistory = useMemo(() => {
    if (historyTypeFilter === "all") return historyJobs;
    return historyJobs.filter((j) => j.type === historyTypeFilter);
  }, [historyJobs, historyTypeFilter]);

  /* ── Dead Letter tab state ───────────────────────────────────── */
  const dlqQuery = useApiQuery<{ jobs: DeadLetterJob[] } | DeadLetterJob[]>(
    "/api/v1/jobs/dlq",
    activeTab === "Dead Letter",
  );
  const dlqJobs: DeadLetterJob[] = useMemo(() => {
    const raw = dlqQuery.data;
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    return raw.jobs ?? [];
  }, [dlqQuery.data]);

  /* ── Agents for selector ─────────────────────────────────────── */
  const agentsQuery = useApiQuery<{ agents: Agent[] } | Agent[]>("/api/v1/agents", modalOpen);
  const agents: Agent[] = useMemo(() => {
    const raw = agentsQuery.data;
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    return raw.agents ?? [];
  }, [agentsQuery.data]);

  /* ── Modal form state ────────────────────────────────────────── */
  const [formName, setFormName] = useState("");
  const [formJobType, setFormJobType] = useState<JobType>("agent_run");
  const [formAgent, setFormAgent] = useState("");
  const [formTask, setFormTask] = useState("");
  const [formEvalDataset, setFormEvalDataset] = useState("");
  const [formCron, setFormCron] = useState("0 2 * * *");
  const [formRunOnce, setFormRunOnce] = useState(false);
  const [saving, setSaving] = useState(false);

  const cronPreview = useMemo(() => cronToHuman(formCron), [formCron]);

  const openCreate = useCallback(() => {
    setEditingJob(null);
    setFormName("");
    setFormJobType("agent_run");
    setFormAgent("");
    setFormTask("");
    setFormEvalDataset("");
    setFormCron("0 2 * * *");
    setFormRunOnce(false);
    setModalOpen(true);
  }, []);

  const openEdit = useCallback((job: ScheduledJob) => {
    setEditingJob(job);
    setFormName(job.name);
    setFormJobType(job.job_type);
    setFormAgent(job.agent_name ?? "");
    setFormTask(job.task ?? "");
    setFormEvalDataset("");
    setFormCron(job.cron_expression);
    setFormRunOnce(false);
    setModalOpen(true);
  }, []);

  const handleSave = useCallback(async () => {
    if (!formName.trim()) {
      showToast("Job name is required", "error");
      return;
    }
    setSaving(true);
    try {
      if (formRunOnce) {
        // One-shot execution
        await apiPost("/api/v1/jobs", {
          type: formJobType,
          payload: {
            agent_name: formAgent || undefined,
            task: formTask || undefined,
            eval_dataset: formEvalDataset || undefined,
          },
        });
        showToast("Job queued for immediate execution", "success");
      } else if (editingJob) {
        await apiPut(`/api/v1/schedules/${encodeURIComponent(editingJob.id)}`, {
          name: formName.trim(),
          job_type: formJobType,
          agent_name: formAgent || undefined,
          task: formTask || undefined,
          cron_expression: formCron,
          enabled: editingJob.enabled,
        });
        showToast("Schedule updated", "success");
      } else {
        await apiPost("/api/v1/schedules", {
          name: formName.trim(),
          job_type: formJobType,
          agent_name: formAgent || undefined,
          task: formTask || undefined,
          cron_expression: formCron,
          enabled: true,
        });
        showToast("Schedule created", "success");
      }
      setModalOpen(false);
      schedulesQuery.refetch();
    } catch {
      showToast("Failed to save job", "error");
    } finally {
      setSaving(false);
    }
  }, [formName, formJobType, formAgent, formTask, formEvalDataset, formCron, formRunOnce, editingJob, showToast, schedulesQuery]);

  const handleToggleEnabled = useCallback(async (job: ScheduledJob) => {
    try {
      await apiPut(`/api/v1/schedules/${encodeURIComponent(job.id)}`, {
        enabled: !job.enabled,
      });
      schedulesQuery.refetch();
    } catch {
      showToast("Failed to toggle schedule", "error");
    }
  }, [showToast, schedulesQuery]);

  const handleRunNow = useCallback(async (job: ScheduledJob) => {
    try {
      await apiPost("/api/v1/jobs", {
        type: job.job_type,
        payload: {
          agent_name: job.agent_name,
          task: job.task,
        },
      });
      showToast("Job queued", "success");
    } catch {
      showToast("Failed to queue job", "error");
    }
  }, [showToast]);

  const handleDeleteSchedule = useCallback(async (id: string) => {
    try {
      await apiDelete(`/api/v1/schedules/${encodeURIComponent(id)}`);
      showToast("Schedule deleted", "success");
      schedulesQuery.refetch();
    } catch {
      showToast("Failed to delete schedule", "error");
    }
  }, [showToast, schedulesQuery]);

  const handleCancelJob = useCallback(async (jobId: string) => {
    try {
      await apiPost(`/api/v1/jobs/${encodeURIComponent(jobId)}/cancel`);
      showToast("Job cancelled", "success");
      runningQuery.refetch();
    } catch {
      showToast("Failed to cancel job", "error");
    }
  }, [showToast, runningQuery]);

  const handleRetryDlq = useCallback(async (jobId: string) => {
    try {
      await apiPost(`/api/v1/jobs/${encodeURIComponent(jobId)}/retry`);
      showToast("Job retried", "success");
      dlqQuery.refetch();
    } catch {
      showToast("Failed to retry job", "error");
    }
  }, [showToast, dlqQuery]);

  const handleDismissDlq = useCallback(async (jobId: string) => {
    try {
      await apiDelete(`/api/v1/jobs/dlq/${encodeURIComponent(jobId)}`);
      showToast("Dismissed from dead letter queue", "success");
      dlqQuery.refetch();
    } catch {
      showToast("Failed to dismiss", "error");
    }
  }, [showToast, dlqQuery]);

  const currentRefetch = activeTab === "Scheduled"
    ? schedulesQuery.refetch
    : activeTab === "Running"
      ? runningQuery.refetch
      : activeTab === "History"
        ? historyQuery.refetch
        : dlqQuery.refetch;

  return (
    <div className="max-w-[1400px] mx-auto">
      <PageHeader
        title="Jobs & Scheduling"
        subtitle="Configure recurring jobs, monitor execution, and manage failures"
        icon={<Timer size={20} />}
        actions={
          <div className="flex items-center gap-[var(--space-3)]">
            <Link
              to="/autoresearch"
              className="text-[var(--text-xs)] text-accent hover:text-accent/80 transition-colors flex items-center gap-[var(--space-1)] min-h-[var(--touch-target-min)]"
            >
              Autoresearch Runs <ChevronRight size={14} />
            </Link>
            <button
              onClick={openCreate}
              className="btn btn-primary text-[var(--text-xs)] min-h-[var(--touch-target-min)]"
            >
              <Plus size={14} />
              New Job
            </button>
          </div>
        }
        onRefresh={currentRefetch}
      />

      {/* ── Tabs ────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-[var(--space-1)] mb-[var(--space-6)] border-b border-border-default">
        {TABS.map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-[var(--space-4)] py-[var(--space-3)] text-[var(--text-xs)] font-medium transition-colors border-b-2 min-h-[var(--touch-target-min)] ${
              activeTab === tab
                ? "border-accent text-accent"
                : "border-transparent text-text-muted hover:text-text-secondary"
            }`}
          >
            {tab}
            {tab === "Running" && runningJobs.length > 0 && (
              <span className="ml-[var(--space-2)] inline-flex items-center justify-center w-5 h-5 rounded-full bg-accent/15 text-accent text-[10px] font-bold">
                {runningJobs.length}
              </span>
            )}
            {tab === "Dead Letter" && dlqJobs.length > 0 && (
              <span className="ml-[var(--space-2)] inline-flex items-center justify-center w-5 h-5 rounded-full bg-status-error/15 text-status-error text-[10px] font-bold">
                {dlqJobs.length}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* ── Tab: Scheduled ──────────────────────────────────────────── */}
      {activeTab === "Scheduled" && (
        <>
        <QueryState loading={schedulesQuery.loading} error={schedulesQuery.error} onRetry={schedulesQuery.refetch}>
          {schedules.length > 0 ? (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-[var(--space-3)]">
              {schedules.map((job) => (
                <div key={job.id} className="card card-hover flex flex-col gap-[var(--space-3)]">
                  {/* Header row */}
                  <div className="flex items-start justify-between gap-[var(--space-2)]">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-[var(--space-2)] mb-[var(--space-1)]">
                        <span
                          className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${
                            job.enabled ? "bg-status-live" : "bg-text-muted"
                          }`}
                        />
                        <h3 className="text-[var(--text-sm)] font-semibold text-text-primary truncate">
                          {job.name}
                        </h3>
                        <JobTypeBadge type={job.job_type} />
                      </div>
                      <div className="flex items-center gap-[var(--space-2)] text-[var(--text-xs)] text-text-muted">
                        <Calendar size={10} />
                        <span className="font-mono">{job.cron_expression}</span>
                        <span className="text-text-muted">-</span>
                        <span>{cronToHuman(job.cron_expression)}</span>
                      </div>
                    </div>

                    {/* Enable/disable toggle */}
                    <button
                      onClick={() => handleToggleEnabled(job)}
                      className={`relative w-10 h-[22px] rounded-full transition-colors flex-shrink-0 min-h-[var(--touch-target-min)] flex items-center ${
                        job.enabled ? "bg-accent" : "bg-surface-hover"
                      }`}
                      aria-label={`Toggle ${job.name} ${job.enabled ? "off" : "on"}`}
                    >
                      <span
                        className={`absolute top-[3px] w-4 h-4 rounded-full bg-text-primary transition-transform ${
                          job.enabled ? "translate-x-[22px]" : "translate-x-[3px]"
                        }`}
                      />
                    </button>
                  </div>

                  {/* Details row */}
                  <div className="flex items-center gap-[var(--space-4)] text-[10px] text-text-muted">
                    {job.agent_name && (
                      <span className="flex items-center gap-1">
                        Agent: <span className="text-text-secondary">{job.agent_name}</span>
                      </span>
                    )}
                    {job.last_run_at && (
                      <span className="flex items-center gap-1">
                        <Clock size={10} />
                        Last: <span className="text-text-secondary">{formatTime(job.last_run_at)}</span>
                        {job.last_run_result && (
                          <span className="text-text-secondary ml-1">({job.last_run_result})</span>
                        )}
                      </span>
                    )}
                    <span className="flex items-center gap-1">
                      <Hash size={10} />
                      Runs: <span className="text-text-secondary">{job.total_runs}</span>
                    </span>
                  </div>

                  {/* Actions row */}
                  <div className="flex items-center gap-[var(--space-1)] pt-[var(--space-1)] border-t border-border-subtle">
                    <button
                      onClick={() => handleRunNow(job)}
                      className="btn btn-ghost text-[var(--text-xs)] min-h-[var(--touch-target-min)] px-[var(--space-2)]"
                    >
                      <Play size={12} />
                      Run Now
                    </button>
                    <button
                      onClick={() => openEdit(job)}
                      className="btn btn-ghost text-[var(--text-xs)] min-h-[var(--touch-target-min)] px-[var(--space-2)]"
                    >
                      <Edit3 size={12} />
                      Edit
                    </button>
                    <div className="flex-1" />
                    <button
                      onClick={() => handleDeleteSchedule(job.id)}
                      className="btn btn-ghost text-[var(--text-xs)] text-status-error min-h-[var(--touch-target-min)] px-[var(--space-2)]"
                    >
                      <Trash2 size={12} />
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState
              icon={<Timer size={28} />}
              title="No scheduled jobs yet"
              description="Set up recurring maintenance, scans, or agent runs."
              action={
                <button
                  onClick={openCreate}
                  className="btn btn-primary text-[var(--text-xs)] min-h-[var(--touch-target-min)]"
                >
                  <Plus size={14} />
                  New Job
                </button>
              }
            />
          )}
        </QueryState>
        <div className="mt-[var(--space-4)] flex justify-end">
          <Link
            to="/settings?tab=schedules"
            className="text-[var(--text-xs)] text-accent hover:text-accent/80 transition-colors flex items-center gap-[var(--space-1)] min-h-[var(--touch-target-min)]"
          >
            Manage in Settings <ChevronRight size={14} />
          </Link>
        </div>
        </>
      )}

      {/* ── Tab: Running ────────────────────────────────────────────── */}
      {activeTab === "Running" && (
        <QueryState loading={runningQuery.loading} error={runningQuery.error} onRetry={runningQuery.refetch}>
          {runningJobs.length > 0 ? (
            <div className="card overflow-x-auto">
              <table>
                <thead>
                  <tr>
                    <th>Job ID</th>
                    <th>Type</th>
                    <th>Agent</th>
                    <th>Started</th>
                    <th>Elapsed</th>
                    <th>Status</th>
                    <th className="text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {runningJobs.map((job) => (
                    <tr key={job.job_id}>
                      <td>
                        <span className="font-mono text-[var(--text-xs)]">{truncateId(job.job_id)}</span>
                      </td>
                      <td>
                        <JobTypeBadge type={job.type} />
                      </td>
                      <td className="text-[var(--text-xs)]">{job.agent_name ?? "-"}</td>
                      <td className="text-[var(--text-xs)]">{formatTime(job.started_at)}</td>
                      <td>
                        <ElapsedTime since={job.started_at} />
                      </td>
                      <td>
                        <span className="inline-flex items-center gap-[var(--space-1)] text-accent text-[var(--text-xs)]">
                          <Loader2 size={12} className="animate-spin" />
                          Running
                        </span>
                      </td>
                      <td className="text-right">
                        <button
                          onClick={() => handleCancelJob(job.job_id)}
                          className="btn btn-ghost text-[var(--text-xs)] text-status-error min-h-[var(--touch-target-min)] px-[var(--space-2)]"
                        >
                          <XCircle size={12} />
                          Cancel
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState
              icon={<Loader2 size={28} />}
              title="No running jobs"
              description="Jobs in progress will appear here with live status updates."
            />
          )}
        </QueryState>
      )}

      {/* ── Tab: History ────────────────────────────────────────────── */}
      {activeTab === "History" && (
        <>
          {/* Filters */}
          <div className="flex flex-col sm:flex-row gap-[var(--space-3)] mb-[var(--space-4)]">
            <select
              value={historyTypeFilter}
              onChange={(e) => setHistoryTypeFilter(e.target.value)}
              className="w-auto min-w-[160px]"
            >
              <option value="all">All types</option>
              {(Object.keys(JOB_TYPE_CONFIG) as JobType[]).map((t) => (
                <option key={t} value={t}>
                  {JOB_TYPE_CONFIG[t].label}
                </option>
              ))}
            </select>
            <select
              value={historyStatusFilter}
              onChange={(e) => {
                setHistoryStatusFilter(e.target.value);
                setHistoryPage(0);
              }}
              className="w-auto min-w-[140px]"
            >
              <option value="all">All status</option>
              <option value="completed">Success</option>
              <option value="failed">Failed</option>
            </select>
          </div>

          <QueryState loading={historyQuery.loading} error={historyQuery.error} onRetry={historyQuery.refetch}>
            {filteredHistory.length > 0 ? (
              <>
                <div className="card overflow-x-auto">
                  <table>
                    <thead>
                      <tr>
                        <th style={{ width: 24 }} />
                        <th>Job ID</th>
                        <th>Type</th>
                        <th>Agent</th>
                        <th>Started</th>
                        <th>Duration</th>
                        <th>Status</th>
                        <th>Result</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredHistory.map((job) => (
                        <>
                          <tr
                            key={job.job_id}
                            className="cursor-pointer"
                            onClick={() =>
                              setExpandedRow(expandedRow === job.job_id ? null : job.job_id)
                            }
                          >
                            <td>
                              {expandedRow === job.job_id ? (
                                <ChevronDown size={12} className="text-text-muted" />
                              ) : (
                                <ChevronRight size={12} className="text-text-muted" />
                              )}
                            </td>
                            <td>
                              <span className="font-mono text-[var(--text-xs)]">{truncateId(job.job_id)}</span>
                            </td>
                            <td>
                              <JobTypeBadge type={job.type} />
                            </td>
                            <td className="text-[var(--text-xs)]">{job.agent_name ?? "-"}</td>
                            <td className="text-[var(--text-xs)]">{formatTime(job.started_at)}</td>
                            <td className="font-mono text-[var(--text-xs)]">{formatDuration(job.duration_ms)}</td>
                            <td>
                              <span
                                className={`inline-flex items-center gap-1 text-[var(--text-xs)] font-semibold ${
                                  job.status === "completed" ? "text-status-live" : "text-status-error"
                                }`}
                              >
                                <span
                                  className={`inline-block w-1.5 h-1.5 rounded-full ${
                                    job.status === "completed" ? "bg-status-live" : "bg-status-error"
                                  }`}
                                />
                                {job.status === "completed" ? "Success" : "Failed"}
                              </span>
                            </td>
                            <td className="text-[var(--text-xs)] text-text-muted max-w-[200px] truncate">
                              {job.result ?? "-"}
                            </td>
                          </tr>
                          {expandedRow === job.job_id && (
                            <tr key={`${job.job_id}-detail`}>
                              <td colSpan={8} className="!bg-surface-base !p-[var(--space-4)]">
                                <pre className="text-[var(--text-xs)] text-text-secondary font-mono whitespace-pre-wrap max-h-60 overflow-y-auto">
                                  {job.result_json
                                    ? JSON.stringify(job.result_json, null, 2)
                                    : job.result ?? "No detailed result available."}
                                </pre>
                              </td>
                            </tr>
                          )}
                        </>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Pagination */}
                <div className="flex items-center justify-between mt-[var(--space-4)]">
                  <button
                    onClick={() => setHistoryPage(Math.max(0, historyPage - 1))}
                    disabled={historyPage === 0}
                    className="btn btn-secondary text-[var(--text-xs)] min-h-[var(--touch-target-min)]"
                  >
                    Previous
                  </button>
                  <span className="text-[var(--text-xs)] text-text-muted">
                    Page {historyPage + 1}
                  </span>
                  <button
                    onClick={() => setHistoryPage(historyPage + 1)}
                    disabled={filteredHistory.length < 50}
                    className="btn btn-secondary text-[var(--text-xs)] min-h-[var(--touch-target-min)]"
                  >
                    Next
                  </button>
                </div>
              </>
            ) : (
              <EmptyState
                icon={<Clock size={28} />}
                title="No job history"
                description="Completed and failed jobs will appear here."
              />
            )}
          </QueryState>
        </>
      )}

      {/* ── Tab: Dead Letter ────────────────────────────────────────── */}
      {activeTab === "Dead Letter" && (
        <QueryState loading={dlqQuery.loading} error={dlqQuery.error} onRetry={dlqQuery.refetch}>
          {dlqJobs.length > 0 ? (
            <div className="card overflow-x-auto">
              <table>
                <thead>
                  <tr>
                    <th>Job ID</th>
                    <th>Type</th>
                    <th>Agent</th>
                    <th>Failed At</th>
                    <th>Error</th>
                    <th>Retries</th>
                    <th className="text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {dlqJobs.map((job) => (
                    <tr key={job.job_id}>
                      <td>
                        <span className="font-mono text-[var(--text-xs)]">{truncateId(job.job_id)}</span>
                      </td>
                      <td>
                        <JobTypeBadge type={job.type} />
                      </td>
                      <td className="text-[var(--text-xs)]">{job.agent_name ?? "-"}</td>
                      <td className="text-[var(--text-xs)]">{formatTime(job.failed_at)}</td>
                      <td className="text-[var(--text-xs)] text-status-error max-w-[300px] truncate">
                        {job.error}
                      </td>
                      <td className="font-mono text-[var(--text-xs)]">{job.retry_count}</td>
                      <td className="text-right">
                        <div className="flex items-center justify-end gap-[var(--space-1)]">
                          <button
                            onClick={() => handleRetryDlq(job.job_id)}
                            className="btn btn-ghost text-[var(--text-xs)] min-h-[var(--touch-target-min)] px-[var(--space-2)]"
                          >
                            <RotateCcw size={12} />
                            Retry
                          </button>
                          <button
                            onClick={() => handleDismissDlq(job.job_id)}
                            className="btn btn-ghost text-[var(--text-xs)] text-text-muted min-h-[var(--touch-target-min)] px-[var(--space-2)]"
                          >
                            <X size={12} />
                            Dismiss
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState
              icon={<AlertTriangle size={28} />}
              title="Dead letter queue is empty"
              description="Jobs that exhaust all retries will appear here."
            />
          )}
        </QueryState>
      )}

      {/* ── Create / Edit Modal ─────────────────────────────────────── */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          {/* Backdrop */}
          <div
            className="absolute inset-0 glass-backdrop"
            onClick={() => setModalOpen(false)}
          />

          {/* Panel */}
          <div className="relative z-10 w-full max-w-2xl max-h-[85vh] overflow-y-auto rounded-xl border border-border-default shadow-panel glass-medium p-[var(--space-6)]">
            {/* Header */}
            <div className="flex items-center justify-between mb-[var(--space-6)]">
              <h2 className="text-[var(--text-md)] font-bold text-text-primary">
                {editingJob ? "Edit Schedule" : "New Job"}
              </h2>
              <button
                onClick={() => setModalOpen(false)}
                className="btn btn-ghost p-[var(--space-2)] min-h-[var(--touch-target-min)] min-w-[var(--touch-target-min)]"
                aria-label="Close"
              >
                <X size={16} />
              </button>
            </div>

            {/* Form */}
            <div className="space-y-[var(--space-4)]">
              {/* Name */}
              <div>
                <label className="block text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-1)]">
                  Name
                </label>
                <input
                  type="text"
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  placeholder="e.g., nightly-security-sweep"
                />
              </div>

              {/* Job type */}
              <div>
                <label className="block text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-1)]">
                  Job Type
                </label>
                <select
                  value={formJobType}
                  onChange={(e) => setFormJobType(e.target.value as JobType)}
                >
                  {(Object.keys(JOB_TYPE_CONFIG) as JobType[]).map((t) => (
                    <option key={t} value={t}>
                      {JOB_TYPE_CONFIG[t].label} - {JOB_TYPE_CONFIG[t].description}
                    </option>
                  ))}
                </select>
              </div>

              {/* Agent selector — conditional */}
              {AGENT_JOB_TYPES.includes(formJobType) && (
                <div>
                  <label className="block text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-1)]">
                    Agent
                  </label>
                  <select
                    value={formAgent}
                    onChange={(e) => setFormAgent(e.target.value)}
                  >
                    <option value="">Select an agent...</option>
                    {agents.map((a) => (
                      <option key={a.name} value={a.name}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* Task description — conditional */}
              {formJobType === "agent_run" && (
                <div>
                  <label className="block text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-1)]">
                    Task Description
                  </label>
                  <textarea
                    value={formTask}
                    onChange={(e) => setFormTask(e.target.value)}
                    placeholder="Describe the task for the agent to execute..."
                    rows={3}
                  />
                  <p className="mt-[var(--space-2)] text-[10px] text-text-muted flex items-center gap-[var(--space-1)]">
                    <AlertTriangle size={10} className="text-status-warning flex-shrink-0" />
                    This schedule will also appear in Settings &rarr; Schedules
                  </p>
                </div>
              )}

              {/* Eval dataset — conditional */}
              {formJobType === "eval_run" && (
                <div>
                  <label className="block text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-1)]">
                    Eval Dataset
                  </label>
                  <input
                    type="text"
                    value={formEvalDataset}
                    onChange={(e) => setFormEvalDataset(e.target.value)}
                    placeholder="e.g., qa-regression-v2.json"
                  />
                </div>
              )}

              {/* Cron expression */}
              {!formRunOnce && (
                <div>
                  <label className="block text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-1)]">
                    Cron Expression
                  </label>
                  <input
                    type="text"
                    value={formCron}
                    onChange={(e) => setFormCron(e.target.value)}
                    placeholder="0 2 * * *"
                    className="font-mono"
                  />
                  <p className="mt-[var(--space-1)] text-[var(--text-xs)] text-text-muted">
                    {cronPreview}
                  </p>

                  {/* Quick presets */}
                  <div className="flex flex-wrap gap-[var(--space-2)] mt-[var(--space-2)]">
                    {CRON_PRESETS.map((preset) => (
                      <button
                        key={preset.value}
                        type="button"
                        onClick={() => setFormCron(preset.value)}
                        className={`px-[var(--space-3)] py-[var(--space-1)] rounded-full text-[10px] font-medium transition-colors border min-h-[var(--touch-target-min)] flex items-center ${
                          formCron === preset.value
                            ? "bg-accent/15 text-accent border-accent/20"
                            : "bg-surface-raised border-border-default text-text-secondary hover:bg-surface-overlay hover:text-text-primary"
                        }`}
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Run once checkbox */}
              {!editingJob && (
                <label className="flex items-center gap-[var(--space-2)] cursor-pointer min-h-[var(--touch-target-min)]">
                  <input
                    type="checkbox"
                    checked={formRunOnce}
                    onChange={(e) => setFormRunOnce(e.target.checked)}
                    className="w-4 h-4 rounded border-border-default accent-accent"
                  />
                  <span className="text-[var(--text-xs)] text-text-secondary">
                    Run once now (don't schedule)
                  </span>
                </label>
              )}
            </div>

            {/* Actions */}
            <div className="flex items-center justify-end gap-[var(--space-3)] mt-[var(--space-6)]">
              <button
                onClick={() => setModalOpen(false)}
                className="btn btn-secondary text-[var(--text-xs)] min-h-[var(--touch-target-min)]"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="btn btn-primary text-[var(--text-xs)] min-h-[var(--touch-target-min)]"
              >
                {saving ? (
                  <>
                    <Loader2 size={12} className="animate-spin" />
                    Saving...
                  </>
                ) : formRunOnce ? (
                  "Run Now"
                ) : editingJob ? (
                  "Update"
                ) : (
                  "Create"
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export { JobsPage as default };
