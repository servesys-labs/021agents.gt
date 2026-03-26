import { useState, useMemo, useCallback } from "react";
import {
  Database,
  Search,
  Plus,
  ArrowRight,
  Trash2,
  X,
  Loader2,
  Play,
  Edit3,
  Download,
  ChevronDown,
  ChevronUp,
  Activity,
  FileText,
  Users,
  Webhook,
  BookOpen,
  Radio,
  HardDrive,
  LayoutTemplate,
} from "lucide-react";

import { PageHeader } from "../../components/common/PageHeader";
import { QueryState } from "../../components/common/QueryState";
import { EmptyState } from "../../components/common/EmptyState";
import {
  useApiQuery,
  apiPost,
  apiPut,
  apiDelete,
} from "../../lib/api";
import { extractList } from "../../lib/normalize";
import { useToast } from "../../components/common/ToastProvider";
import { Modal } from "../../components/common/Modal";

/* ── Types ──────────────────────────────────────────────────────── */

type PipelineResource = {
  id: string;
  name: string;
  description?: string;
  type: string;
  config_json?: string;
  status: string;
  cf_resource_id?: string;
  created_at?: number;
  updated_at?: number;
  stream_name?: string;
  sink_name?: string;
};

type PipelineTemplate = {
  id: string;
  name: string;
  description: string;
  category: string;
  icon: string;
  stream_config: Record<string, unknown>;
  sink_config: Record<string, unknown>;
  sql: string;
};

/* ── Tab constants ─────────────────────────────────────────────── */

const TABS = ["Pipelines", "Streams", "Sinks"] as const;
type Tab = (typeof TABS)[number];

/* ── Status badge ──────────────────────────────────────────────── */

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    active: "bg-status-live/15 text-status-live border-status-live/20",
    draft: "bg-surface-overlay text-text-secondary border-border-default",
    deploying: "bg-status-warning/15 text-status-warning border-status-warning/20",
    error: "bg-status-error/15 text-status-error border-status-error/20",
  };
  const cls = styles[status] ?? styles.draft;
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase border ${cls}`}
    >
      {status === "deploying" && <Loader2 size={10} className="animate-spin" />}
      {status}
    </span>
  );
}

/* ── Sink type badge ───────────────────────────────────────────── */

function SinkTypeBadge({ sinkType }: { sinkType: string }) {
  const labels: Record<string, string> = {
    r2_iceberg: "Iceberg",
    r2_parquet: "Parquet",
    r2_json: "JSON",
  };
  const colors: Record<string, string> = {
    r2_iceberg: "bg-chart-blue/15 text-chart-blue border-chart-blue/20",
    r2_parquet: "bg-chart-purple/15 text-chart-purple border-chart-purple/20",
    r2_json: "bg-chart-orange/15 text-chart-orange border-chart-orange/20",
  };
  return (
    <span
      className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase border ${colors[sinkType] ?? "bg-surface-overlay text-text-secondary border-border-default"}`}
    >
      {labels[sinkType] ?? sinkType}
    </span>
  );
}

/* ── Template icon resolver ────────────────────────────────────── */

function TemplateIcon({ icon }: { icon: string }) {
  const size = 18;
  switch (icon) {
    case "book":
      return <BookOpen size={size} />;
    case "users":
      return <Users size={size} />;
    case "file-text":
      return <FileText size={size} />;
    case "activity":
      return <Activity size={size} />;
    case "webhook":
      return <Webhook size={size} />;
    default:
      return <Database size={size} />;
  }
}

/* ── Helpers ────────────────────────────────────────────────────── */

function parseConfig(resource: PipelineResource): Record<string, unknown> {
  try {
    return JSON.parse(resource.config_json || "{}");
  } catch {
    return {};
  }
}

function timeAgo(epoch?: number): string {
  if (!epoch) return "Never";
  const seconds = Math.floor(Date.now() / 1000 - epoch);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

/* ── Main component ────────────────────────────────────────────── */

export function PipelinesPage() {
  const { showToast } = useToast();
  const [activeTab, setActiveTab] = useState<Tab>("Pipelines");
  const [searchQuery, setSearchQuery] = useState("");

  // Modals
  const [showCreatePipeline, setShowCreatePipeline] = useState(false);
  const [showCreateStream, setShowCreateStream] = useState(false);
  const [showCreateSink, setShowCreateSink] = useState(false);
  const [showQueryPanel, setShowQueryPanel] = useState(false);
  const [showEditSql, setShowEditSql] = useState(false);
  const [selectedPipeline, setSelectedPipeline] = useState<PipelineResource | null>(null);

  // Wizard state
  const [wizardStep, setWizardStep] = useState(0);
  const [wizardTemplate, setWizardTemplate] = useState<PipelineTemplate | null>(null);

  // Form state — pipeline
  const [pipelineName, setPipelineName] = useState("");
  const [pipelineDesc, setPipelineDesc] = useState("");
  const [pipelineStreamId, setPipelineStreamId] = useState("");
  const [pipelineSinkId, setPipelineSinkId] = useState("");
  const [pipelineSql, setPipelineSql] = useState("");

  // Form state — stream
  const [streamName, setStreamName] = useState("");
  const [streamDesc, setStreamDesc] = useState("");
  const [streamHttpEnabled, setStreamHttpEnabled] = useState(true);
  const [streamHttpAuth, setStreamHttpAuth] = useState(true);
  const [streamSchema, setStreamSchema] = useState("");

  // Form state — sink
  const [sinkName, setSinkName] = useState("");
  const [sinkDesc, setSinkDesc] = useState("");
  const [sinkType, setSinkType] = useState("r2_json");
  const [sinkBucket, setSinkBucket] = useState("");
  const [sinkPath, setSinkPath] = useState("");
  const [sinkCompression, setSinkCompression] = useState("none");

  // Query state
  const [querySql, setQuerySql] = useState("SELECT * FROM events LIMIT 100");
  const [queryResults, setQueryResults] = useState<unknown[] | null>(null);
  const [queryLoading, setQueryLoading] = useState(false);

  // Edit SQL state
  const [editSqlValue, setEditSqlValue] = useState("");

  // Submitting
  const [submitting, setSubmitting] = useState(false);

  /* ── API queries ──────────────────────────────────────────────── */

  const pipelinesQuery = useApiQuery<{ pipelines: PipelineResource[] } | PipelineResource[]>(
    "/api/v1/pipelines",
  );
  const streamsQuery = useApiQuery<{ streams: PipelineResource[] } | PipelineResource[]>(
    "/api/v1/pipelines/streams",
  );
  const sinksQuery = useApiQuery<{ sinks: PipelineResource[] } | PipelineResource[]>(
    "/api/v1/pipelines/sinks",
  );
  const templatesQuery = useApiQuery<{ templates: PipelineTemplate[] } | PipelineTemplate[]>(
    "/api/v1/pipelines/templates",
  );

  const pipelines = useMemo(
    () => extractList<PipelineResource>(pipelinesQuery.data, "pipelines"),
    [pipelinesQuery.data],
  );
  const streams = useMemo(
    () => extractList<PipelineResource>(streamsQuery.data, "streams"),
    [streamsQuery.data],
  );
  const sinks = useMemo(
    () => extractList<PipelineResource>(sinksQuery.data, "sinks"),
    [sinksQuery.data],
  );
  const templates = useMemo(
    () => extractList<PipelineTemplate>(templatesQuery.data, "templates"),
    [templatesQuery.data],
  );

  /* ── Filtered lists ────────────────────────────────────────────── */

  const filteredPipelines = useMemo(() => {
    if (!searchQuery.trim()) return pipelines;
    const q = searchQuery.toLowerCase();
    return pipelines.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        (p.description ?? "").toLowerCase().includes(q),
    );
  }, [pipelines, searchQuery]);

  const filteredStreams = useMemo(() => {
    if (!searchQuery.trim()) return streams;
    const q = searchQuery.toLowerCase();
    return streams.filter((s) => s.name.toLowerCase().includes(q));
  }, [streams, searchQuery]);

  const filteredSinks = useMemo(() => {
    if (!searchQuery.trim()) return sinks;
    const q = searchQuery.toLowerCase();
    return sinks.filter((s) => s.name.toLowerCase().includes(q));
  }, [sinks, searchQuery]);

  /* ── Handlers ──────────────────────────────────────────────────── */

  const refetchAll = useCallback(() => {
    pipelinesQuery.refetch();
    streamsQuery.refetch();
    sinksQuery.refetch();
    templatesQuery.refetch();
  }, [pipelinesQuery, streamsQuery, sinksQuery, templatesQuery]);

  const resetPipelineForm = useCallback(() => {
    setPipelineName("");
    setPipelineDesc("");
    setPipelineStreamId("");
    setPipelineSinkId("");
    setPipelineSql("");
    setWizardStep(0);
    setWizardTemplate(null);
  }, []);

  const handleSelectTemplate = useCallback(
    (t: PipelineTemplate) => {
      setWizardTemplate(t);
      setPipelineName(t.name);
      setPipelineDesc(t.description);
      setPipelineSql(t.sql);
      setWizardStep(1);
    },
    [],
  );

  const handleCreatePipeline = useCallback(async () => {
    if (!pipelineName.trim()) {
      showToast("Pipeline name is required", "error");
      return;
    }
    if (!pipelineStreamId) {
      showToast("Please select a stream", "error");
      return;
    }
    if (!pipelineSinkId) {
      showToast("Please select a sink", "error");
      return;
    }
    if (!pipelineSql.trim()) {
      showToast("SQL transformation is required", "error");
      return;
    }
    setSubmitting(true);
    try {
      await apiPost("/api/v1/pipelines", {
        name: pipelineName,
        description: pipelineDesc,
        stream_id: pipelineStreamId,
        sink_id: pipelineSinkId,
        sql: pipelineSql,
      });
      showToast("Pipeline created", "success");
      setShowCreatePipeline(false);
      resetPipelineForm();
      refetchAll();
    } catch (err: unknown) {
      showToast(
        err instanceof Error ? err.message : "Failed to create pipeline",
        "error",
      );
    } finally {
      setSubmitting(false);
    }
  }, [pipelineName, pipelineDesc, pipelineStreamId, pipelineSinkId, pipelineSql, showToast, resetPipelineForm, refetchAll]);

  const handleCreateStream = useCallback(async () => {
    if (!streamName.trim()) {
      showToast("Stream name is required", "error");
      return;
    }
    setSubmitting(true);
    try {
      let schema = null;
      if (streamSchema.trim()) {
        try {
          schema = JSON.parse(streamSchema);
        } catch {
          showToast("Invalid JSON schema", "error");
          setSubmitting(false);
          return;
        }
      }
      await apiPost("/api/v1/pipelines/streams", {
        name: streamName,
        description: streamDesc,
        http_enabled: streamHttpEnabled,
        http_auth: streamHttpAuth,
        schema,
      });
      showToast("Stream created", "success");
      setShowCreateStream(false);
      setStreamName("");
      setStreamDesc("");
      setStreamSchema("");
      refetchAll();
    } catch (err: unknown) {
      showToast(
        err instanceof Error ? err.message : "Failed to create stream",
        "error",
      );
    } finally {
      setSubmitting(false);
    }
  }, [streamName, streamDesc, streamHttpEnabled, streamHttpAuth, streamSchema, showToast, refetchAll]);

  const handleCreateSink = useCallback(async () => {
    if (!sinkName.trim()) {
      showToast("Sink name is required", "error");
      return;
    }
    setSubmitting(true);
    try {
      await apiPost("/api/v1/pipelines/sinks", {
        name: sinkName,
        description: sinkDesc,
        type: sinkType,
        bucket: sinkBucket,
        path: sinkPath,
        compression: sinkCompression,
      });
      showToast("Sink created", "success");
      setShowCreateSink(false);
      setSinkName("");
      setSinkDesc("");
      setSinkBucket("");
      setSinkPath("");
      refetchAll();
    } catch (err: unknown) {
      showToast(
        err instanceof Error ? err.message : "Failed to create sink",
        "error",
      );
    } finally {
      setSubmitting(false);
    }
  }, [sinkName, sinkDesc, sinkType, sinkBucket, sinkPath, sinkCompression, showToast, refetchAll]);

  const handleDeleteResource = useCallback(
    async (type: string, id: string) => {
      try {
        if (type === "stream") {
          await apiDelete(`/api/v1/pipelines/streams/${id}`);
        } else if (type === "sink") {
          await apiDelete(`/api/v1/pipelines/sinks/${id}`);
        } else {
          await apiDelete(`/api/v1/pipelines/${id}`);
        }
        showToast("Deleted", "success");
        refetchAll();
      } catch (err: unknown) {
        showToast(
          err instanceof Error ? err.message : "Delete failed",
          "error",
        );
      }
    },
    [showToast, refetchAll],
  );

  const handleQueryData = useCallback(
    async (pipeline: PipelineResource) => {
      setSelectedPipeline(pipeline);
      setShowQueryPanel(true);
      setQueryResults(null);
    },
    [],
  );

  const handleRunQuery = useCallback(async () => {
    if (!selectedPipeline) return;
    setQueryLoading(true);
    try {
      const result = await apiPost<{ records?: unknown[]; total?: number }>(
        `/api/v1/pipelines/${selectedPipeline.id}/query`,
        { sql: querySql, limit: 100 },
      );
      setQueryResults(result.records ?? []);
    } catch (err: unknown) {
      showToast(
        err instanceof Error ? err.message : "Query failed",
        "error",
      );
    } finally {
      setQueryLoading(false);
    }
  }, [selectedPipeline, querySql, showToast]);

  const handleEditSql = useCallback(
    (pipeline: PipelineResource) => {
      const config = parseConfig(pipeline);
      setSelectedPipeline(pipeline);
      setEditSqlValue(String(config.sql ?? ""));
      setShowEditSql(true);
    },
    [],
  );

  const handleSaveSql = useCallback(async () => {
    if (!selectedPipeline) return;
    setSubmitting(true);
    try {
      await apiPut(`/api/v1/pipelines/${selectedPipeline.id}`, {
        sql: editSqlValue,
      });
      showToast("SQL updated", "success");
      setShowEditSql(false);
      refetchAll();
    } catch (err: unknown) {
      showToast(
        err instanceof Error ? err.message : "Update failed",
        "error",
      );
    } finally {
      setSubmitting(false);
    }
  }, [selectedPipeline, editSqlValue, showToast, refetchAll]);

  const exportResults = useCallback(
    (format: "csv" | "json") => {
      if (!queryResults || queryResults.length === 0) return;
      let content: string;
      let mimeType: string;
      let ext: string;

      if (format === "json") {
        content = JSON.stringify(queryResults, null, 2);
        mimeType = "application/json";
        ext = "json";
      } else {
        const keys = Object.keys(
          (queryResults[0] as Record<string, unknown>) ?? {},
        );
        const rows = queryResults.map((r) =>
          keys
            .map((k) => {
              const v = (r as Record<string, unknown>)[k];
              return typeof v === "string" ? `"${v.replace(/"/g, '""')}"` : String(v ?? "");
            })
            .join(","),
        );
        content = [keys.join(","), ...rows].join("\n");
        mimeType = "text/csv";
        ext = "csv";
      }

      const blob = new Blob([content], { type: mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `pipeline-data.${ext}`;
      a.click();
      URL.revokeObjectURL(url);
    },
    [queryResults],
  );

  /* ── Resolve stream/sink names for pipeline cards ──────────────── */

  const streamNameMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of streams) m.set(s.id, s.name);
    return m;
  }, [streams]);

  const sinkNameMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of sinks) m.set(s.id, s.name);
    return m;
  }, [sinks]);

  /* ── Render ────────────────────────────────────────────────────── */

  return (
    <div className="max-w-[1400px] mx-auto">
      <PageHeader
        title="Pipelines"
        subtitle="Stream, transform, and sink data for your agents"
        icon={<Database size={20} />}
        onRefresh={refetchAll}
      />

      {/* Stats row */}
      <div className="grid grid-cols-3 gap-[var(--space-3)] mb-[var(--space-6)]">
        <div className="card flex items-center gap-[var(--space-3)] py-[var(--space-3)]">
          <div className="p-2 rounded-lg bg-accent-muted">
            <Database size={16} className="text-accent" />
          </div>
          <div>
            <p className="text-[var(--text-xl)] font-bold text-text-primary font-mono">
              {pipelines.length}
            </p>
            <p className="text-[10px] text-text-muted uppercase tracking-wide">
              Pipelines
            </p>
          </div>
        </div>
        <div className="card flex items-center gap-[var(--space-3)] py-[var(--space-3)]">
          <div className="p-2 rounded-lg bg-chart-blue/10">
            <Radio size={16} className="text-chart-blue" />
          </div>
          <div>
            <p className="text-[var(--text-xl)] font-bold text-text-primary font-mono">
              {streams.length}
            </p>
            <p className="text-[10px] text-text-muted uppercase tracking-wide">
              Streams
            </p>
          </div>
        </div>
        <div className="card flex items-center gap-[var(--space-3)] py-[var(--space-3)]">
          <div className="p-2 rounded-lg bg-chart-purple/10">
            <HardDrive size={16} className="text-chart-purple" />
          </div>
          <div>
            <p className="text-[var(--text-xl)] font-bold text-text-primary font-mono">
              {sinks.length}
            </p>
            <p className="text-[10px] text-text-muted uppercase tracking-wide">
              Sinks
            </p>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-[var(--space-1)] mb-[var(--space-4)] border-b border-border-default">
        {TABS.map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-[var(--space-4)] py-[var(--space-3)] text-[var(--text-sm)] font-medium transition-colors border-b-2 min-h-[var(--touch-target-min)] ${
              activeTab === tab
                ? "border-accent text-accent"
                : "border-transparent text-text-muted hover:text-text-primary"
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Search + create */}
      <div className="flex items-center gap-[var(--space-3)] mb-[var(--space-4)]">
        <div className="relative flex-1">
          <Search
            size={16}
            className="absolute left-[var(--space-3)] top-1/2 -translate-y-1/2 text-text-muted pointer-events-none"
          />
          <input
            type="text"
            placeholder={`Search ${activeTab.toLowerCase()}...`}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-10 bg-surface-overlay"
          />
        </div>
        <button
          onClick={() => {
            if (activeTab === "Pipelines") {
              resetPipelineForm();
              setShowCreatePipeline(true);
            } else if (activeTab === "Streams") {
              setShowCreateStream(true);
            } else {
              setShowCreateSink(true);
            }
          }}
          className="btn btn-primary min-h-[var(--touch-target-min)]"
        >
          <Plus size={14} />
          <span className="text-[var(--text-sm)]">
            New {activeTab === "Pipelines" ? "Pipeline" : activeTab === "Streams" ? "Stream" : "Sink"}
          </span>
        </button>
      </div>

      {/* ── Pipelines tab ──────────────────────────────────────────── */}
      {activeTab === "Pipelines" && (
        <QueryState
          loading={pipelinesQuery.loading}
          error={pipelinesQuery.error}
          onRetry={pipelinesQuery.refetch}
        >
          {/* Templates section */}
          {templates.length > 0 && filteredPipelines.length === 0 && !searchQuery && (
            <section className="mb-[var(--space-6)]">
              <h2 className="text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-3)]">
                Pipeline Templates
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-[var(--space-3)]">
                {templates.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => {
                      handleSelectTemplate(t);
                      setShowCreatePipeline(true);
                    }}
                    className="card card-hover text-left flex items-start gap-[var(--space-3)] border-l-2 border-accent/40 hover:border-accent transition-colors"
                  >
                    <div className="p-2 rounded-lg bg-accent-muted text-accent flex-shrink-0">
                      <TemplateIcon icon={t.icon} />
                    </div>
                    <div className="min-w-0">
                      <h3 className="text-[var(--text-sm)] font-semibold text-text-primary">
                        {t.name}
                      </h3>
                      <p className="text-[var(--text-xs)] text-text-muted line-clamp-2 mt-[var(--space-1)]">
                        {t.description}
                      </p>
                      <span className="inline-block mt-[var(--space-2)] px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase bg-surface-overlay text-text-secondary border border-border-default">
                        {t.category}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            </section>
          )}

          {filteredPipelines.length > 0 ? (
            <div className="space-y-[var(--space-3)]">
              {filteredPipelines.map((p) => {
                const config = parseConfig(p);
                const resolvedStreamName =
                  p.stream_name || streamNameMap.get(String(config.stream_id ?? "")) || "Unknown";
                const resolvedSinkName =
                  p.sink_name || sinkNameMap.get(String(config.sink_id ?? "")) || "Unknown";
                const sqlPreview =
                  typeof config.sql === "string"
                    ? config.sql
                    : config.sql != null
                      ? String(config.sql)
                      : "";
                return (
                  <div
                    key={p.id}
                    className="card card-hover glass-light"
                  >
                    <div className="flex items-start justify-between mb-[var(--space-3)]">
                      <div>
                        <div className="flex items-center gap-[var(--space-2)]">
                          <h3 className="text-[var(--text-md)] font-semibold text-text-primary">
                            {p.name}
                          </h3>
                          <StatusBadge status={p.status} />
                        </div>
                        {p.description && (
                          <p className="text-[var(--text-xs)] text-text-muted mt-[var(--space-1)]">
                            {p.description}
                          </p>
                        )}
                      </div>
                    </div>

                    {/* Flow visualization */}
                    <div className="flex items-center gap-[var(--space-2)] mb-[var(--space-3)] px-[var(--space-3)] py-[var(--space-2)] bg-surface-overlay rounded-lg">
                      <div className="flex items-center gap-[var(--space-2)]">
                        <Radio size={14} className="text-chart-blue" />
                        <span className="text-[var(--text-sm)] font-medium text-text-primary">
                          {resolvedStreamName}
                        </span>
                      </div>
                      <ArrowRight size={14} className="text-text-muted flex-shrink-0" />
                      <div className="flex items-center gap-[var(--space-2)]">
                        <LayoutTemplate size={14} className="text-accent" />
                        <span className="text-[var(--text-xs)] text-text-secondary">
                          SQL Transform
                        </span>
                      </div>
                      <ArrowRight size={14} className="text-text-muted flex-shrink-0" />
                      <div className="flex items-center gap-[var(--space-2)]">
                        <HardDrive size={14} className="text-chart-purple" />
                        <span className="text-[var(--text-sm)] font-medium text-text-primary">
                          {resolvedSinkName}
                        </span>
                      </div>
                    </div>

                    {/* SQL preview */}
                    {sqlPreview && (
                      <div className="mb-[var(--space-3)] px-[var(--space-3)] py-[var(--space-2)] bg-surface-base rounded-lg border border-border-default overflow-x-auto">
                        <code className="text-[var(--text-xs)] font-mono text-text-secondary whitespace-pre-wrap break-all">
                          {sqlPreview.length > 200
                            ? `${sqlPreview.slice(0, 200)}...`
                            : sqlPreview}
                        </code>
                      </div>
                    )}

                    {/* Actions */}
                    <div className="flex items-center gap-[var(--space-2)]">
                      <span className="text-[var(--text-xs)] text-text-muted mr-auto">
                        Updated {timeAgo(p.updated_at)}
                      </span>
                      <button
                        onClick={() => handleQueryData(p)}
                        className="btn btn-secondary text-[var(--text-xs)] min-h-[var(--touch-target-min)]"
                      >
                        <Play size={12} />
                        Query Data
                      </button>
                      <button
                        onClick={() => handleEditSql(p)}
                        className="btn btn-secondary text-[var(--text-xs)] min-h-[var(--touch-target-min)]"
                      >
                        <Edit3 size={12} />
                        Edit SQL
                      </button>
                      <button
                        onClick={() => handleDeleteResource("pipeline", p.id)}
                        className="btn btn-secondary text-[var(--text-xs)] text-status-error min-h-[var(--touch-target-min)]"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            !searchQuery &&
            templates.length === 0 && (
              <EmptyState
                icon={<Database size={28} />}
                title="No pipelines yet"
                description="Create a pipeline to stream, transform, and sink data for your agents."
              />
            )
          )}
        </QueryState>
      )}

      {/* ── Streams tab ────────────────────────────────────────────── */}
      {activeTab === "Streams" && (
        <QueryState
          loading={streamsQuery.loading}
          error={streamsQuery.error}
          onRetry={streamsQuery.refetch}
        >
          {filteredStreams.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-[var(--space-3)]">
              {filteredStreams.map((s) => {
                const config = parseConfig(s);
                const httpEnabled = config.http_enabled === true;
                const httpAuthRequired = config.http_auth === true;
                const hasSchema = Boolean(config.schema);
                return (
                  <div key={s.id} className="card card-hover glass-light flex flex-col gap-[var(--space-3)]">
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-[var(--space-2)]">
                        <div className="p-2 rounded-lg bg-chart-blue/10">
                          <Radio size={16} className="text-chart-blue" />
                        </div>
                        <div>
                          <h3 className="text-[var(--text-sm)] font-semibold text-text-primary">
                            {s.name}
                          </h3>
                          {s.description && (
                            <p className="text-[var(--text-xs)] text-text-muted">{s.description}</p>
                          )}
                        </div>
                      </div>
                      <StatusBadge status={s.status} />
                    </div>

                    <div className="flex flex-wrap gap-[var(--space-2)]">
                      {httpEnabled && (
                        <span className="inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold bg-chart-green/15 text-chart-green border border-chart-green/20">
                          HTTP Enabled
                        </span>
                      )}
                      {httpAuthRequired && (
                        <span className="inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold bg-chart-orange/15 text-chart-orange border border-chart-orange/20">
                          Auth Required
                        </span>
                      )}
                      {hasSchema && (
                        <span className="inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold bg-chart-purple/15 text-chart-purple border border-chart-purple/20">
                          Schema Defined
                        </span>
                      )}
                    </div>

                    {s.cf_resource_id && (
                      <p className="text-[var(--text-xs)] text-text-muted font-mono truncate">
                        Endpoint: {s.cf_resource_id}.ingest.cloudflare.com
                      </p>
                    )}

                    <div className="flex items-center justify-between mt-auto pt-[var(--space-2)] border-t border-border-default">
                      <span className="text-[var(--text-xs)] text-text-muted">
                        Created {timeAgo(s.created_at)}
                      </span>
                      <button
                        onClick={() => handleDeleteResource("stream", s.id)}
                        className="btn btn-secondary text-[var(--text-xs)] text-status-error min-h-[var(--touch-target-min)]"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <EmptyState
              icon={<Radio size={28} />}
              title="No streams yet"
              description="Create a stream to ingest data via HTTP or Worker bindings."
            />
          )}
        </QueryState>
      )}

      {/* ── Sinks tab ──────────────────────────────────────────────── */}
      {activeTab === "Sinks" && (
        <QueryState
          loading={sinksQuery.loading}
          error={sinksQuery.error}
          onRetry={sinksQuery.refetch}
        >
          {filteredSinks.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-[var(--space-3)]">
              {filteredSinks.map((s) => {
                const config = parseConfig(s);
                const compression =
                  typeof config.compression === "string" ? config.compression : "";
                const bucket = typeof config.bucket === "string" ? config.bucket : "";
                const path = typeof config.path === "string" ? config.path : "";
                return (
                  <div key={s.id} className="card card-hover glass-light flex flex-col gap-[var(--space-3)]">
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-[var(--space-2)]">
                        <div className="p-2 rounded-lg bg-chart-purple/10">
                          <HardDrive size={16} className="text-chart-purple" />
                        </div>
                        <div>
                          <h3 className="text-[var(--text-sm)] font-semibold text-text-primary">
                            {s.name}
                          </h3>
                          {s.description && (
                            <p className="text-[var(--text-xs)] text-text-muted">{s.description}</p>
                          )}
                        </div>
                      </div>
                      <StatusBadge status={s.status} />
                    </div>

                    <div className="flex flex-wrap gap-[var(--space-2)]">
                      <SinkTypeBadge sinkType={String(config.sink_type ?? "")} />
                      {compression && compression !== "none" && (
                        <span className="inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold bg-surface-overlay text-text-secondary border border-border-default">
                          {compression}
                        </span>
                      )}
                    </div>

                    {bucket && (
                      <p className="text-[var(--text-xs)] text-text-muted font-mono truncate">
                        Bucket: {bucket}{path ? `/${path}` : ""}
                      </p>
                    )}

                    <div className="flex items-center justify-between mt-auto pt-[var(--space-2)] border-t border-border-default">
                      <span className="text-[var(--text-xs)] text-text-muted">
                        Created {timeAgo(s.created_at)}
                      </span>
                      <button
                        onClick={() => handleDeleteResource("sink", s.id)}
                        className="btn btn-secondary text-[var(--text-xs)] text-status-error min-h-[var(--touch-target-min)]"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <EmptyState
              icon={<HardDrive size={28} />}
              title="No sinks yet"
              description="Create a sink to store pipeline output in R2 as Iceberg, Parquet, or JSON."
            />
          )}
        </QueryState>
      )}

      {/* ── Create Pipeline modal (wizard) ─────────────────────────── */}
      <Modal
        open={showCreatePipeline}
        onClose={() => setShowCreatePipeline(false)}
        title={
          wizardStep === 0
            ? "Choose a Template"
            : wizardStep === 1
              ? "Configure Stream"
              : wizardStep === 2
                ? "SQL Transform"
                : wizardStep === 3
                  ? "Configure Sink"
                  : "Review & Create"
        }
        maxWidth="2xl"
        footer={
          <>
            <button
              onClick={() => {
                if (wizardStep > 0) setWizardStep(wizardStep - 1);
                else setShowCreatePipeline(false);
              }}
              className="btn btn-secondary min-h-[var(--touch-target-min)]"
            >
              {wizardStep === 0 ? "Cancel" : "Back"}
            </button>
            {wizardStep < 4 ? (
              <button
                onClick={() => setWizardStep(wizardStep + 1)}
                className="btn btn-primary min-h-[var(--touch-target-min)]"
              >
                Next
                <ArrowRight size={14} />
              </button>
            ) : (
              <button
                onClick={handleCreatePipeline}
                disabled={submitting}
                className="btn btn-primary min-h-[var(--touch-target-min)]"
              >
                {submitting ? (
                  <>
                    <Loader2 size={14} className="animate-spin" />
                    Creating...
                  </>
                ) : (
                  <>
                    <Plus size={14} />
                    Create Pipeline
                  </>
                )}
              </button>
            )}
          </>
        }
      >

            {/* Step indicators */}
            <div className="flex items-center gap-[var(--space-2)] mb-[var(--space-4)]">
              {["Template", "Stream", "SQL", "Sink", "Review"].map(
                (label, i) => (
                  <div
                    key={label}
                    className={`flex items-center gap-1.5 text-[var(--text-xs)] font-medium ${
                      i === wizardStep
                        ? "text-accent"
                        : i < wizardStep
                          ? "text-status-live"
                          : "text-text-muted"
                    }`}
                  >
                    <span
                      className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${
                        i === wizardStep
                          ? "bg-accent text-text-inverse"
                          : i < wizardStep
                            ? "bg-status-live/20 text-status-live"
                            : "bg-surface-overlay text-text-muted"
                      }`}
                    >
                      {i + 1}
                    </span>
                    <span className="hidden sm:inline">{label}</span>
                    {i < 4 && (
                      <ArrowRight size={10} className="text-text-muted ml-1" />
                    )}
                  </div>
                ),
              )}
            </div>

            {/* Step 0: Template selection */}
            {wizardStep === 0 && (
              <div className="space-y-[var(--space-3)]">
                <button
                  onClick={() => {
                    setWizardTemplate(null);
                    setWizardStep(1);
                  }}
                  className="card card-hover w-full text-left flex items-center gap-[var(--space-3)]"
                >
                  <div className="p-2 rounded-lg bg-surface-overlay">
                    <Plus size={18} className="text-text-secondary" />
                  </div>
                  <div>
                    <h3 className="text-[var(--text-sm)] font-semibold text-text-primary">
                      Start Blank
                    </h3>
                    <p className="text-[var(--text-xs)] text-text-muted">
                      Build a custom pipeline from scratch
                    </p>
                  </div>
                </button>
                {templates.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => handleSelectTemplate(t)}
                    className="card card-hover w-full text-left flex items-center gap-[var(--space-3)] border-l-2 border-accent/30 hover:border-accent"
                  >
                    <div className="p-2 rounded-lg bg-accent-muted text-accent flex-shrink-0">
                      <TemplateIcon icon={t.icon} />
                    </div>
                    <div className="min-w-0">
                      <h3 className="text-[var(--text-sm)] font-semibold text-text-primary">
                        {t.name}
                      </h3>
                      <p className="text-[var(--text-xs)] text-text-muted line-clamp-1">
                        {t.description}
                      </p>
                    </div>
                  </button>
                ))}
              </div>
            )}

            {/* Step 1: Stream selection */}
            {wizardStep === 1 && (
              <div className="space-y-[var(--space-4)]">
                <div>
                  <label className="block text-[var(--text-xs)] text-text-muted uppercase mb-[var(--space-1)]">
                    Pipeline Name
                  </label>
                  <input
                    type="text"
                    value={pipelineName}
                    onChange={(e) => setPipelineName(e.target.value)}
                    placeholder="my-pipeline"
                    className="bg-surface-overlay"
                  />
                </div>
                <div>
                  <label className="block text-[var(--text-xs)] text-text-muted uppercase mb-[var(--space-1)]">
                    Description
                  </label>
                  <input
                    type="text"
                    value={pipelineDesc}
                    onChange={(e) => setPipelineDesc(e.target.value)}
                    placeholder="Optional description"
                    className="bg-surface-overlay"
                  />
                </div>
                <div>
                  <label className="block text-[var(--text-xs)] text-text-muted uppercase mb-[var(--space-1)]">
                    Select Stream
                  </label>
                  {streams.length > 0 ? (
                    <select
                      value={pipelineStreamId}
                      onChange={(e) => setPipelineStreamId(e.target.value)}
                      className="bg-surface-overlay w-full rounded-lg border border-border-default px-[var(--space-3)] py-[var(--space-2)] text-[var(--text-sm)] text-text-primary min-h-[var(--touch-target-min)]"
                    >
                      <option value="">Choose a stream...</option>
                      {streams.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <p className="text-[var(--text-xs)] text-text-muted">
                      No streams available. Create one first from the Streams tab.
                    </p>
                  )}
                </div>
              </div>
            )}

            {/* Step 2: SQL transform */}
            {wizardStep === 2 && (
              <div>
                <label className="block text-[var(--text-xs)] text-text-muted uppercase mb-[var(--space-1)]">
                  SQL Transformation
                </label>
                <textarea
                  value={pipelineSql}
                  onChange={(e) => setPipelineSql(e.target.value)}
                  rows={8}
                  placeholder="SELECT column1, column2, _timestamp FROM events WHERE condition"
                  className="w-full font-mono text-[var(--text-sm)] bg-surface-base border border-border-default rounded-lg px-[var(--space-3)] py-[var(--space-3)] text-text-primary placeholder:text-text-muted resize-y focus:outline-none focus:ring-2 focus:ring-accent/40"
                  spellCheck={false}
                />
                <p className="text-[var(--text-xs)] text-text-muted mt-[var(--space-1)]">
                  Write a SQL query to transform events from the stream before they reach the sink.
                </p>
              </div>
            )}

            {/* Step 3: Sink selection */}
            {wizardStep === 3 && (
              <div>
                <label className="block text-[var(--text-xs)] text-text-muted uppercase mb-[var(--space-1)]">
                  Select Sink
                </label>
                {sinks.length > 0 ? (
                  <select
                    value={pipelineSinkId}
                    onChange={(e) => setPipelineSinkId(e.target.value)}
                    className="bg-surface-overlay w-full rounded-lg border border-border-default px-[var(--space-3)] py-[var(--space-2)] text-[var(--text-sm)] text-text-primary min-h-[var(--touch-target-min)]"
                  >
                    <option value="">Choose a sink...</option>
                    {sinks.map((s) => {
                      const cfg = parseConfig(s);
                      return (
                        <option key={s.id} value={s.id}>
                          {s.name} ({String(cfg.sink_type ?? "unknown")})
                        </option>
                      );
                    })}
                  </select>
                ) : (
                  <p className="text-[var(--text-xs)] text-text-muted">
                    No sinks available. Create one first from the Sinks tab.
                  </p>
                )}
              </div>
            )}

            {/* Step 4: Review */}
            {wizardStep === 4 && (
              <div className="space-y-[var(--space-3)]">
                <div className="card bg-surface-base">
                  <div className="grid grid-cols-2 gap-[var(--space-3)] text-[var(--text-sm)]">
                    <div>
                      <span className="text-[var(--text-xs)] text-text-muted uppercase">Name</span>
                      <p className="text-text-primary font-medium">{pipelineName || "Unnamed"}</p>
                    </div>
                    <div>
                      <span className="text-[var(--text-xs)] text-text-muted uppercase">Template</span>
                      <p className="text-text-primary font-medium">{wizardTemplate?.name || "Custom"}</p>
                    </div>
                    <div>
                      <span className="text-[var(--text-xs)] text-text-muted uppercase">Stream</span>
                      <p className="text-text-primary font-medium">
                        {streamNameMap.get(pipelineStreamId) || pipelineStreamId || "None"}
                      </p>
                    </div>
                    <div>
                      <span className="text-[var(--text-xs)] text-text-muted uppercase">Sink</span>
                      <p className="text-text-primary font-medium">
                        {sinkNameMap.get(pipelineSinkId) || pipelineSinkId || "None"}
                      </p>
                    </div>
                  </div>
                  {pipelineSql && (
                    <div className="mt-[var(--space-3)]">
                      <span className="text-[var(--text-xs)] text-text-muted uppercase">SQL</span>
                      <pre className="mt-[var(--space-1)] px-[var(--space-3)] py-[var(--space-2)] bg-surface-overlay rounded-lg text-[var(--text-xs)] font-mono text-text-secondary overflow-x-auto whitespace-pre-wrap">
                        {pipelineSql}
                      </pre>
                    </div>
                  )}
                </div>
              </div>
            )}

      </Modal>

      {/* ── Create Stream modal ────────────────────────────────────── */}
      <Modal
        open={showCreateStream}
        onClose={() => setShowCreateStream(false)}
        title="Create Stream"
        maxWidth="lg"
        footer={
          <>
            <button
              onClick={() => setShowCreateStream(false)}
              className="btn btn-secondary min-h-[var(--touch-target-min)]"
            >
              Cancel
            </button>
            <button
              onClick={handleCreateStream}
              disabled={submitting}
              className="btn btn-primary min-h-[var(--touch-target-min)]"
            >
              {submitting ? (
                <>
                  <Loader2 size={14} className="animate-spin" />
                  Creating...
                </>
              ) : (
                <>
                  <Plus size={14} />
                  Create Stream
                </>
              )}
            </button>
          </>
        }
      >
            <div className="space-y-[var(--space-4)]">
              <div>
                <label className="block text-[var(--text-xs)] text-text-muted uppercase mb-[var(--space-1)]">
                  Name
                </label>
                <input
                  type="text"
                  value={streamName}
                  onChange={(e) => setStreamName(e.target.value)}
                  placeholder="my-stream"
                  className="bg-surface-overlay"
                />
              </div>
              <div>
                <label className="block text-[var(--text-xs)] text-text-muted uppercase mb-[var(--space-1)]">
                  Description
                </label>
                <input
                  type="text"
                  value={streamDesc}
                  onChange={(e) => setStreamDesc(e.target.value)}
                  placeholder="Optional description"
                  className="bg-surface-overlay"
                />
              </div>

              <div className="flex items-center gap-[var(--space-4)]">
                <label className="flex items-center gap-[var(--space-2)] text-[var(--text-sm)] text-text-primary cursor-pointer min-h-[var(--touch-target-min)]">
                  <input
                    type="checkbox"
                    checked={streamHttpEnabled}
                    onChange={(e) => setStreamHttpEnabled(e.target.checked)}
                    className="w-4 h-4 rounded border-border-default accent-accent"
                  />
                  HTTP Enabled
                </label>
                <label className="flex items-center gap-[var(--space-2)] text-[var(--text-sm)] text-text-primary cursor-pointer min-h-[var(--touch-target-min)]">
                  <input
                    type="checkbox"
                    checked={streamHttpAuth}
                    onChange={(e) => setStreamHttpAuth(e.target.checked)}
                    className="w-4 h-4 rounded border-border-default accent-accent"
                  />
                  Auth Required
                </label>
              </div>

              <div>
                <label className="block text-[var(--text-xs)] text-text-muted uppercase mb-[var(--space-1)]">
                  JSON Schema (optional)
                </label>
                <textarea
                  value={streamSchema}
                  onChange={(e) => setStreamSchema(e.target.value)}
                  rows={5}
                  placeholder='{"type": "object", "properties": { ... }}'
                  className="w-full font-mono text-[var(--text-sm)] bg-surface-base border border-border-default rounded-lg px-[var(--space-3)] py-[var(--space-3)] text-text-primary placeholder:text-text-muted resize-y focus:outline-none focus:ring-2 focus:ring-accent/40"
                  spellCheck={false}
                />
              </div>
            </div>
      </Modal>

      {/* ── Create Sink modal ──────────────────────────────────────── */}
      <Modal
        open={showCreateSink}
        onClose={() => setShowCreateSink(false)}
        title="Create Sink"
        maxWidth="lg"
        footer={
          <>
            <button
              onClick={() => setShowCreateSink(false)}
              className="btn btn-secondary min-h-[var(--touch-target-min)]"
            >
              Cancel
            </button>
            <button
              onClick={handleCreateSink}
              disabled={submitting}
              className="btn btn-primary min-h-[var(--touch-target-min)]"
            >
              {submitting ? (
                <>
                  <Loader2 size={14} className="animate-spin" />
                  Creating...
                </>
              ) : (
                <>
                  <Plus size={14} />
                  Create Sink
                </>
              )}
            </button>
          </>
        }
      >
            <div className="space-y-[var(--space-4)]">
              <div>
                <label className="block text-[var(--text-xs)] text-text-muted uppercase mb-[var(--space-1)]">
                  Name
                </label>
                <input
                  type="text"
                  value={sinkName}
                  onChange={(e) => setSinkName(e.target.value)}
                  placeholder="my-sink"
                  className="bg-surface-overlay"
                />
              </div>
              <div>
                <label className="block text-[var(--text-xs)] text-text-muted uppercase mb-[var(--space-1)]">
                  Description
                </label>
                <input
                  type="text"
                  value={sinkDesc}
                  onChange={(e) => setSinkDesc(e.target.value)}
                  placeholder="Optional description"
                  className="bg-surface-overlay"
                />
              </div>
              <div>
                <label className="block text-[var(--text-xs)] text-text-muted uppercase mb-[var(--space-1)]">
                  Type
                </label>
                <select
                  value={sinkType}
                  onChange={(e) => setSinkType(e.target.value)}
                  className="bg-surface-overlay w-full rounded-lg border border-border-default px-[var(--space-3)] py-[var(--space-2)] text-[var(--text-sm)] text-text-primary min-h-[var(--touch-target-min)]"
                >
                  <option value="r2_json">R2 JSON</option>
                  <option value="r2_parquet">R2 Parquet</option>
                  <option value="r2_iceberg">R2 Iceberg</option>
                </select>
              </div>
              <div>
                <label className="block text-[var(--text-xs)] text-text-muted uppercase mb-[var(--space-1)]">
                  R2 Bucket
                </label>
                <input
                  type="text"
                  value={sinkBucket}
                  onChange={(e) => setSinkBucket(e.target.value)}
                  placeholder="my-bucket"
                  className="bg-surface-overlay"
                />
              </div>
              <div>
                <label className="block text-[var(--text-xs)] text-text-muted uppercase mb-[var(--space-1)]">
                  Path Prefix
                </label>
                <input
                  type="text"
                  value={sinkPath}
                  onChange={(e) => setSinkPath(e.target.value)}
                  placeholder="data/output/"
                  className="bg-surface-overlay"
                />
              </div>
              <div>
                <label className="block text-[var(--text-xs)] text-text-muted uppercase mb-[var(--space-1)]">
                  Compression
                </label>
                <select
                  value={sinkCompression}
                  onChange={(e) => setSinkCompression(e.target.value)}
                  className="bg-surface-overlay w-full rounded-lg border border-border-default px-[var(--space-3)] py-[var(--space-2)] text-[var(--text-sm)] text-text-primary min-h-[var(--touch-target-min)]"
                >
                  <option value="none">None</option>
                  <option value="gzip">Gzip</option>
                  <option value="zstd">Zstd</option>
                </select>
              </div>
            </div>

      </Modal>

      {/* ── Query Panel (slide-over) ───────────────────────────────── */}
      {showQueryPanel && selectedPipeline && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div
            className="absolute inset-0 bg-surface-base/60"
            onClick={() => setShowQueryPanel(false)}
          />
          <div className="relative w-full max-w-2xl h-full glass-dropdown border-l border-border-default shadow-2xl flex flex-col">
            {/* Header */}
            <div className="flex items-center justify-between p-[var(--space-4)] border-b border-border-default">
              <div>
                <h2 className="text-[var(--text-md)] font-bold text-text-primary">
                  Query: {selectedPipeline.name}
                </h2>
                <p className="text-[var(--text-xs)] text-text-muted">
                  Run SQL queries against pipeline data
                </p>
              </div>
              <button
                onClick={() => setShowQueryPanel(false)}
                className="p-2 rounded-lg hover:bg-surface-overlay transition-colors min-w-[var(--touch-target-min)] min-h-[var(--touch-target-min)] flex items-center justify-center"
                aria-label="Close"
              >
                <X size={16} />
              </button>
            </div>

            {/* SQL editor */}
            <div className="p-[var(--space-4)]">
              <textarea
                value={querySql}
                onChange={(e) => setQuerySql(e.target.value)}
                rows={5}
                className="w-full font-mono text-[var(--text-sm)] bg-surface-base border border-border-default rounded-lg px-[var(--space-3)] py-[var(--space-3)] text-text-primary placeholder:text-text-muted resize-y focus:outline-none focus:ring-2 focus:ring-accent/40"
                spellCheck={false}
              />
              <div className="flex items-center gap-[var(--space-2)] mt-[var(--space-2)]">
                <button
                  onClick={handleRunQuery}
                  disabled={queryLoading}
                  className="btn btn-primary min-h-[var(--touch-target-min)]"
                >
                  {queryLoading ? (
                    <>
                      <Loader2 size={14} className="animate-spin" />
                      Running...
                    </>
                  ) : (
                    <>
                      <Play size={14} />
                      Run Query
                    </>
                  )}
                </button>
                {queryResults && queryResults.length > 0 && (
                  <>
                    <button
                      onClick={() => exportResults("csv")}
                      className="btn btn-secondary min-h-[var(--touch-target-min)] text-[var(--text-xs)]"
                    >
                      <Download size={12} />
                      CSV
                    </button>
                    <button
                      onClick={() => exportResults("json")}
                      className="btn btn-secondary min-h-[var(--touch-target-min)] text-[var(--text-xs)]"
                    >
                      <Download size={12} />
                      JSON
                    </button>
                  </>
                )}
              </div>
            </div>

            {/* Results */}
            <div className="flex-1 overflow-auto p-[var(--space-4)] pt-0">
              {queryResults !== null && (
                <>
                  <p className="text-[var(--text-xs)] text-text-muted mb-[var(--space-2)]">
                    {queryResults.length} record{queryResults.length !== 1 ? "s" : ""}
                  </p>
                  {queryResults.length > 0 ? (
                    <div className="border border-border-default rounded-lg overflow-auto">
                      <table className="w-full text-[var(--text-xs)]">
                        <thead>
                          <tr className="bg-surface-overlay">
                            {Object.keys(
                              (queryResults[0] as Record<string, unknown>) ?? {},
                            ).map((key) => (
                              <th
                                key={key}
                                className="px-[var(--space-3)] py-[var(--space-2)] text-left text-text-muted font-semibold uppercase whitespace-nowrap border-b border-border-default"
                              >
                                {key}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {queryResults.map((row, i) => (
                            <tr
                              key={i}
                              className={
                                i % 2 === 0
                                  ? "bg-surface-base"
                                  : "bg-surface-overlay/50"
                              }
                            >
                              {Object.values(
                                (row as Record<string, unknown>) ?? {},
                              ).map((val, j) => (
                                <td
                                  key={j}
                                  className="px-[var(--space-3)] py-[var(--space-2)] text-text-primary whitespace-nowrap font-mono border-b border-border-default"
                                >
                                  {typeof val === "object"
                                    ? JSON.stringify(val)
                                    : String(val ?? "")}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div className="card text-center py-[var(--space-6)] text-text-muted text-[var(--text-sm)]">
                      No results returned
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Edit SQL modal ─────────────────────────────────────────── */}
      {showEditSql && selectedPipeline && (
        <Modal
          open
          onClose={() => setShowEditSql(false)}
          title={`Edit SQL: ${selectedPipeline.name}`}
          maxWidth="xl"
          footer={
            <>
              <button
                onClick={() => setShowEditSql(false)}
                className="btn btn-secondary min-h-[var(--touch-target-min)]"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveSql}
                disabled={submitting}
                className="btn btn-primary min-h-[var(--touch-target-min)]"
              >
                {submitting ? (
                  <>
                    <Loader2 size={14} className="animate-spin" />
                    Saving...
                  </>
                ) : (
                  "Save SQL"
                )}
              </button>
            </>
          }
        >
            <textarea
              value={editSqlValue}
              onChange={(e) => setEditSqlValue(e.target.value)}
              rows={10}
              className="w-full font-mono text-[var(--text-sm)] bg-surface-base border border-border-default rounded-lg px-[var(--space-3)] py-[var(--space-3)] text-text-primary placeholder:text-text-muted resize-y focus:outline-none focus:ring-2 focus:ring-accent/40"
              spellCheck={false}
            />
        </Modal>
      )}
    </div>
  );
}

export { PipelinesPage as default };
