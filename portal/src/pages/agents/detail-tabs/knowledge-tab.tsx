import { useCallback, useMemo, useRef, useState } from "react";
import type { DragEvent, ReactNode } from "react";
import {
  BookOpen,
  Brain,
  ChevronDown,
  ChevronRight,
  Database,
  FileText,
  Plus,
  Search,
  Settings2,
  Trash2,
  Upload,
  X,
  Zap,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { apiDelete, apiPost, apiUpload, useApiQuery } from "../../../lib/api";
import { EmptyState } from "../../../components/common/EmptyState";
import { QueryState } from "../../../components/common/QueryState";
import { useToast } from "../../../components/common/ToastProvider";

type RagDocument = {
  id?: string;
  filename: string;
  size?: number;
  chunks?: number;
  status?: string;
  uploaded_at?: string;
};

type RagStatus = {
  total_documents?: number;
  total_chunks?: number;
  index_size?: string;
  last_updated?: string;
  status?: string;
};

type UploadItem = {
  file: File;
  status: "uploading" | "chunking" | "embedding" | "done" | "error";
  chunks?: number;
  error?: string;
};

const ACCEPTED_FILE_TYPES = [".txt", ".md", ".pdf", ".json", ".csv"];

export function KnowledgeTab({ agentName }: { agentName?: string }) {
  const [subTab, setSubTab] = useState<"documents" | "memory">("documents");

  return (
    <div>
      <div className="flex items-center gap-0 border-b border-border-default mb-[var(--space-4)]">
        <button
          onClick={() => setSubTab("documents")}
          className={`flex items-center gap-[var(--space-2)] px-[var(--space-4)] py-[var(--space-3)] text-[var(--text-xs)] font-medium transition-colors border-b-2 -mb-px min-h-[var(--touch-target-min)] ${
            subTab === "documents"
              ? "text-accent border-accent"
              : "text-text-muted border-transparent hover:text-text-secondary hover:border-border-strong"
          }`}
        >
          <FileText size={14} />
          Documents
        </button>
        <button
          onClick={() => setSubTab("memory")}
          className={`flex items-center gap-[var(--space-2)] px-[var(--space-4)] py-[var(--space-3)] text-[var(--text-xs)] font-medium transition-colors border-b-2 -mb-px min-h-[var(--touch-target-min)] ${
            subTab === "memory"
              ? "text-accent border-accent"
              : "text-text-muted border-transparent hover:text-text-secondary hover:border-border-strong"
          }`}
        >
          <Brain size={14} />
          Memory
        </button>
      </div>

      {subTab === "documents" && <DocumentsSubTab agentName={agentName} />}
      {subTab === "memory" && <MemoryBrowser agentName={agentName} />}
    </div>
  );
}

function DocumentsSubTab({ agentName }: { agentName?: string }) {
  const { showToast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [uploads, setUploads] = useState<UploadItem[]>([]);

  const docsQuery = useApiQuery<{ documents: RagDocument[] } | RagDocument[]>(
    `/api/v1/rag/${agentName ?? ""}/documents`,
    Boolean(agentName),
  );

  const statusQuery = useApiQuery<RagStatus>(
    `/api/v1/rag/${agentName ?? ""}/status`,
    Boolean(agentName),
  );

  const documents: RagDocument[] = useMemo(() => {
    const raw = docsQuery.data;
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    return raw.documents ?? [];
  }, [docsQuery.data]);

  const ragStatus = statusQuery.data;

  const uploadFile = useCallback(
    async (file: File) => {
      const item: UploadItem = { file, status: "uploading" };
      setUploads((prev) => [...prev, item]);

      const updateStatus = (status: UploadItem["status"], extra?: Partial<UploadItem>) => {
        setUploads((prev) => prev.map((u) => (u.file === file ? { ...u, status, ...extra } : u)));
      };

      try {
        const formData = new FormData();
        formData.append("file", file);

        updateStatus("uploading");
        const result = await apiUpload<{
          chunks?: number;
          status?: string;
        }>(`/api/v1/rag/${agentName ?? ""}/ingest`, formData);

        updateStatus("chunking");
        await new Promise((r) => setTimeout(r, 400));
        updateStatus("embedding", { chunks: result?.chunks });
        await new Promise((r) => setTimeout(r, 400));
        updateStatus("done", { chunks: result?.chunks });

        docsQuery.refetch();
        statusQuery.refetch();
      } catch {
        updateStatus("error", { error: "Upload failed" });
        showToast(`Failed to upload ${file.name}`, "error");
      }
    },
    [agentName, showToast, docsQuery, statusQuery],
  );

  const handleFiles = useCallback(
    (files: FileList | null) => {
      if (!files) return;
      Array.from(files).forEach((file) => {
        const ext = "." + (file.name.split(".").pop() ?? "").toLowerCase();
        if (ACCEPTED_FILE_TYPES.includes(ext)) {
          uploadFile(file);
        } else {
          showToast(`Unsupported file type: ${ext}`, "error");
        }
      });
    },
    [uploadFile, showToast],
  );

  const handleDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      handleFiles(e.dataTransfer.files);
    },
    [handleFiles],
  );

  const handleDeleteDoc = useCallback(
    async (doc: RagDocument) => {
      try {
        await apiDelete(
          `/api/v1/rag/${agentName ?? ""}/documents/${encodeURIComponent(doc.id ?? doc.filename)}`,
        );
        showToast("Document deleted", "success");
        docsQuery.refetch();
        statusQuery.refetch();
      } catch {
        showToast("Failed to delete document", "error");
      }
    },
    [agentName, showToast, docsQuery, statusQuery],
  );

  const statusColor = (s?: string) => {
    switch (s?.toLowerCase()) {
      case "indexed":
      case "healthy":
      case "done":
        return "text-status-live";
      case "processing":
      case "building":
        return "text-status-warning";
      case "error":
        return "text-status-error";
      default:
        return "text-text-muted";
    }
  };

  const uploadStatusLabel = (s: UploadItem["status"]) => {
    switch (s) {
      case "uploading":
        return "Uploading...";
      case "chunking":
        return "Chunking...";
      case "embedding":
        return "Embedding...";
      case "done":
        return "Done";
      case "error":
        return "Error";
    }
  };

  const uploadProgress = (s: UploadItem["status"]) => {
    switch (s) {
      case "uploading":
        return 25;
      case "chunking":
        return 50;
      case "embedding":
        return 75;
      case "done":
        return 100;
      case "error":
        return 0;
    }
  };

  return (
    <div className="max-w-4xl">
      {ragStatus && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-[var(--space-3)] mb-[var(--space-6)]">
          <div className="card py-[var(--space-3)]">
            <p className="text-[var(--text-lg)] font-bold text-text-primary font-mono">
              {ragStatus.total_documents ?? 0}
            </p>
            <p className="text-[10px] text-text-muted uppercase tracking-wide">Documents</p>
          </div>
          <div className="card py-[var(--space-3)]">
            <p className="text-[var(--text-lg)] font-bold text-text-primary font-mono">
              {ragStatus.total_chunks ?? 0}
            </p>
            <p className="text-[10px] text-text-muted uppercase tracking-wide">Chunks</p>
          </div>
          <div className="card py-[var(--space-3)]">
            <p className="text-[var(--text-sm)] font-bold text-text-primary font-mono">
              {ragStatus.index_size ?? "--"}
            </p>
            <p className="text-[10px] text-text-muted uppercase tracking-wide">Index Size</p>
          </div>
          <div className="card py-[var(--space-3)]">
            <span
              className={`inline-flex items-center gap-1 text-[var(--text-xs)] font-semibold uppercase ${statusColor(ragStatus.status)}`}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  ragStatus.status === "healthy"
                    ? "bg-status-live"
                    : ragStatus.status === "building"
                      ? "bg-status-warning"
                      : ragStatus.status === "error"
                        ? "bg-status-error"
                        : "bg-text-muted"
                }`}
              />
              {ragStatus.status ?? "unknown"}
            </span>
            <p className="text-[10px] text-text-muted uppercase tracking-wide mt-[var(--space-1)]">Status</p>
          </div>
        </div>
      )}

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
        className={`card cursor-pointer mb-[var(--space-4)] border-2 border-dashed transition-colors text-center py-[var(--space-8)] ${
          dragOver
            ? "border-accent bg-accent-muted"
            : "border-border-strong hover:border-accent hover:bg-accent-muted/50"
        }`}
      >
        <Upload
          size={28}
          className={`mx-auto mb-[var(--space-3)] ${dragOver ? "text-accent" : "text-text-muted"}`}
        />
        <p className="text-[var(--text-sm)] text-text-primary font-medium mb-[var(--space-1)]">
          Drag files here or click to upload
        </p>
        <p className="text-[var(--text-xs)] text-text-muted">Accepts {ACCEPTED_FILE_TYPES.join(", ")}</p>
        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPTED_FILE_TYPES.join(",")}
          multiple
          className="hidden"
          onChange={(e) => handleFiles(e.target.files)}
        />
      </div>

      {uploads.length > 0 && (
        <div className="space-y-[var(--space-2)] mb-[var(--space-4)]">
          {uploads.map((item, i) => (
            <div key={`${item.file.name}-${i}`} className="card py-[var(--space-2)] px-[var(--space-3)]">
              <div className="flex items-center justify-between mb-[var(--space-1)]">
                <span className="text-[var(--text-xs)] text-text-primary font-medium truncate">
                  {item.file.name}
                </span>
                <span className={`text-[10px] font-semibold uppercase ${statusColor(item.status)}`}>
                  {uploadStatusLabel(item.status)}
                  {item.chunks != null && ` (${item.chunks} chunks)`}
                </span>
              </div>
              <div className="w-full h-1.5 bg-surface-overlay rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-500 ${
                    item.status === "error" ? "bg-status-error" : "bg-accent"
                  }`}
                  style={{ width: `${uploadProgress(item.status)}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      )}

      <QueryState loading={docsQuery.loading} error={docsQuery.error}>
        {documents.length > 0 ? (
          <div className="card">
            <h3 className="text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-3)]">
              Ingested Documents ({documents.length})
            </h3>
            <div className="overflow-x-auto">
              <table>
                <thead>
                  <tr>
                    <th>Filename</th>
                    <th className="text-right">Size</th>
                    <th className="text-right">Chunks</th>
                    <th className="text-center">Status</th>
                    <th>Uploaded</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {documents.map((doc, i) => (
                    <tr key={doc.id ?? `${doc.filename}-${i}`}>
                      <td className="text-text-primary font-medium">
                        <div className="flex items-center gap-[var(--space-2)]">
                          <FileText size={14} className="text-text-muted flex-shrink-0" />
                          {doc.filename}
                        </div>
                      </td>
                      <td className="text-right font-mono text-[var(--text-xs)]">
                        {doc.size != null
                          ? doc.size > 1048576
                            ? `${(doc.size / 1048576).toFixed(1)} MB`
                            : `${(doc.size / 1024).toFixed(1)} KB`
                          : "--"}
                      </td>
                      <td className="text-right font-mono">{doc.chunks ?? "--"}</td>
                      <td className="text-center">
                        <span
                          className={`inline-flex items-center gap-1 text-[10px] font-semibold uppercase ${statusColor(doc.status)}`}
                        >
                          <span
                            className={`w-1.5 h-1.5 rounded-full ${
                              doc.status === "indexed"
                                ? "bg-status-live"
                                : doc.status === "processing"
                                  ? "bg-status-warning"
                                  : doc.status === "error"
                                    ? "bg-status-error"
                                    : "bg-text-muted"
                            }`}
                          />
                          {doc.status ?? "unknown"}
                        </span>
                      </td>
                      <td className="text-text-muted text-[var(--text-xs)]">
                        {doc.uploaded_at
                          ? new Date(doc.uploaded_at).toLocaleDateString(undefined, {
                              month: "short",
                              day: "numeric",
                              hour: "2-digit",
                              minute: "2-digit",
                            })
                          : "--"}
                      </td>
                      <td>
                        <button
                          onClick={() => handleDeleteDoc(doc)}
                          className="btn btn-ghost text-status-error p-[var(--space-1)] min-h-[var(--touch-target-min)] min-w-[var(--touch-target-min)]"
                          aria-label={`Delete ${doc.filename}`}
                        >
                          <Trash2 size={14} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <EmptyState
            icon={<FileText size={28} />}
            title="No documents uploaded"
            description="Drag files here or click to upload."
          />
        )}
      </QueryState>
    </div>
  );
}

type WorkingMemoryEntry = { key: string; value: string };
type Episode = {
  id?: string;
  input: string;
  output: string;
  outcome?: string;
  timestamp?: string;
};
type Fact = {
  key: string;
  value: string;
  confidence?: number;
  source?: string;
  category?: string;
};
type Procedure = {
  name: string;
  steps?: string[];
  success_count?: number;
  failure_count?: number;
  success_rate?: number;
};

function CollapsibleSection({
  title,
  icon: Icon,
  count,
  defaultOpen = false,
  children,
}: {
  title: string;
  icon: LucideIcon;
  count?: number;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="card mb-[var(--space-3)]">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-[var(--space-3)] min-h-[var(--touch-target-min)] text-left"
      >
        {open ? (
          <ChevronDown size={16} className="text-text-muted flex-shrink-0" />
        ) : (
          <ChevronRight size={16} className="text-text-muted flex-shrink-0" />
        )}
        <div className="p-2 rounded-lg bg-accent-muted flex-shrink-0">
          <Icon size={14} className="text-accent" />
        </div>
        <span className="text-[var(--text-sm)] font-medium text-text-primary flex-1">{title}</span>
        {count != null && <span className="text-[var(--text-xs)] text-text-muted font-mono">{count}</span>}
      </button>
      <div
        className="overflow-hidden transition-all duration-200"
        style={{ maxHeight: open ? "5000px" : "0", opacity: open ? 1 : 0 }}
      >
        <div className="pt-[var(--space-3)] border-t border-border-subtle mt-[var(--space-3)]">
          {children}
        </div>
      </div>
    </div>
  );
}

function MemoryBrowser({ agentName }: { agentName?: string }) {
  const { showToast } = useToast();

  const workingQuery = useApiQuery<
    { entries: WorkingMemoryEntry[] } | WorkingMemoryEntry[] | Record<string, string>
  >(`/api/v1/memory/${agentName ?? ""}/working`, Boolean(agentName));

  const workingEntries: WorkingMemoryEntry[] = useMemo(() => {
    const raw = workingQuery.data;
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    if ("entries" in raw && Array.isArray((raw as { entries: WorkingMemoryEntry[] }).entries))
      return (raw as { entries: WorkingMemoryEntry[] }).entries;
    return Object.entries(raw).map(([key, value]) => ({
      key,
      value: typeof value === "string" ? value : JSON.stringify(value),
    }));
  }, [workingQuery.data]);

  const [expandedWorkingKeys, setExpandedWorkingKeys] = useState<Set<string>>(new Set());

  const episodesQuery = useApiQuery<{ episodes: Episode[] } | Episode[]>(
    `/api/v1/memory/${agentName ?? ""}/episodes`,
    Boolean(agentName),
  );
  const episodes: Episode[] = useMemo(() => {
    const raw = episodesQuery.data;
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    return (raw as { episodes: Episode[] }).episodes ?? [];
  }, [episodesQuery.data]);

  const [episodeSearch, setEpisodeSearch] = useState("");
  const [showAddEpisode, setShowAddEpisode] = useState(false);
  const [newEpisodeInput, setNewEpisodeInput] = useState("");
  const [newEpisodeOutput, setNewEpisodeOutput] = useState("");

  const filteredEpisodes = useMemo(() => {
    if (!episodeSearch.trim()) return episodes;
    const q = episodeSearch.toLowerCase();
    return episodes.filter(
      (e) =>
        e.input.toLowerCase().includes(q) ||
        e.output.toLowerCase().includes(q) ||
        (e.outcome ?? "").toLowerCase().includes(q),
    );
  }, [episodes, episodeSearch]);

  const handleAddEpisode = useCallback(async () => {
    if (!agentName || !newEpisodeInput.trim()) return;
    try {
      await apiPost(`/api/v1/memory/${agentName}/episodes`, {
        input: newEpisodeInput,
        output: newEpisodeOutput,
      });
      showToast("Episode added", "success");
      setShowAddEpisode(false);
      setNewEpisodeInput("");
      setNewEpisodeOutput("");
      episodesQuery.refetch();
    } catch {
      showToast("Failed to add episode", "error");
    }
  }, [agentName, newEpisodeInput, newEpisodeOutput, showToast, episodesQuery]);

  const handleClearEpisodes = useCallback(async () => {
    if (!agentName || !confirm("Clear all episodic memory? This cannot be undone.")) return;
    try {
      await apiDelete(`/api/v1/memory/${agentName}/episodes`);
      showToast("Episodic memory cleared", "success");
      episodesQuery.refetch();
    } catch {
      showToast("Failed to clear episodes", "error");
    }
  }, [agentName, showToast, episodesQuery]);

  const factsQuery = useApiQuery<{ facts: Fact[] } | Fact[]>(
    `/api/v1/memory/${agentName ?? ""}/facts`,
    Boolean(agentName),
  );
  const facts: Fact[] = useMemo(() => {
    const raw = factsQuery.data;
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    return (raw as { facts: Fact[] }).facts ?? [];
  }, [factsQuery.data]);

  const [factSearch, setFactSearch] = useState("");
  const [showAddFact, setShowAddFact] = useState(false);
  const [newFactKey, setNewFactKey] = useState("");
  const [newFactValue, setNewFactValue] = useState("");
  const [newFactCategory, setNewFactCategory] = useState("");

  const filteredFacts = useMemo(() => {
    if (!factSearch.trim()) return facts;
    const q = factSearch.toLowerCase();
    return facts.filter(
      (f) =>
        f.key.toLowerCase().includes(q) ||
        f.value.toLowerCase().includes(q) ||
        (f.category ?? "").toLowerCase().includes(q),
    );
  }, [facts, factSearch]);

  const handleAddFact = useCallback(async () => {
    if (!agentName || !newFactKey.trim()) return;
    try {
      await apiPost(`/api/v1/memory/${agentName}/facts`, {
        key: newFactKey,
        value: newFactValue,
        category: newFactCategory || undefined,
      });
      showToast("Fact added", "success");
      setShowAddFact(false);
      setNewFactKey("");
      setNewFactValue("");
      setNewFactCategory("");
      factsQuery.refetch();
    } catch {
      showToast("Failed to add fact", "error");
    }
  }, [agentName, newFactKey, newFactValue, newFactCategory, showToast, factsQuery]);

  const handleDeleteFact = useCallback(
    async (key: string) => {
      if (!agentName) return;
      try {
        await apiDelete(`/api/v1/memory/${agentName}/facts/${encodeURIComponent(key)}`);
        showToast("Fact deleted", "success");
        factsQuery.refetch();
      } catch {
        showToast("Failed to delete fact", "error");
      }
    },
    [agentName, showToast, factsQuery],
  );

  const handleClearFacts = useCallback(async () => {
    if (!agentName || !confirm("Clear all semantic memory (facts)? This cannot be undone.")) return;
    try {
      await apiDelete(`/api/v1/memory/${agentName}/facts`);
      showToast("Facts cleared", "success");
      factsQuery.refetch();
    } catch {
      showToast("Failed to clear facts", "error");
    }
  }, [agentName, showToast, factsQuery]);

  const proceduresQuery = useApiQuery<{ procedures: Procedure[] } | Procedure[]>(
    `/api/v1/memory/${agentName ?? ""}/procedures`,
    Boolean(agentName),
  );
  const procedures: Procedure[] = useMemo(() => {
    const raw = proceduresQuery.data;
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    return (raw as { procedures: Procedure[] }).procedures ?? [];
  }, [proceduresQuery.data]);

  const handleClearProcedures = useCallback(async () => {
    if (!agentName || !confirm("Clear all procedural memory? This cannot be undone.")) return;
    try {
      await apiDelete(`/api/v1/memory/${agentName}/procedures`);
      showToast("Procedural memory cleared", "success");
      proceduresQuery.refetch();
    } catch {
      showToast("Failed to clear procedures", "error");
    }
  }, [agentName, showToast, proceduresQuery]);

  return (
    <div className="max-w-4xl">
      <CollapsibleSection title="Working Memory" icon={Zap} count={workingEntries.length} defaultOpen>
        {workingQuery.loading ? (
          <p className="text-[var(--text-sm)] text-text-muted">Loading...</p>
        ) : workingEntries.length === 0 ? (
          <p className="text-[var(--text-sm)] text-text-muted">
            No working memory snapshot available. Working memory is session-scoped.
          </p>
        ) : (
          <div className="space-y-[var(--space-1)]">
            {workingEntries.map((entry) => {
              const expanded = expandedWorkingKeys.has(entry.key);
              const isLong = entry.value.length > 120;
              return (
                <div
                  key={entry.key}
                  className="flex items-start gap-[var(--space-3)] p-[var(--space-2)] rounded-lg hover:bg-surface-overlay transition-colors"
                >
                  <span className="text-[var(--text-xs)] font-mono text-accent font-semibold min-w-[120px] flex-shrink-0 pt-0.5">
                    {entry.key}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-[var(--text-xs)] text-text-secondary font-mono whitespace-pre-wrap break-words">
                      {expanded || !isLong ? entry.value : `${entry.value.slice(0, 120)}...`}
                    </p>
                    {isLong && (
                      <button
                        onClick={() => {
                          setExpandedWorkingKeys((prev) => {
                            const next = new Set(prev);
                            if (next.has(entry.key)) next.delete(entry.key);
                            else next.add(entry.key);
                            return next;
                          });
                        }}
                        className="text-[10px] text-accent hover:text-accent-hover mt-[var(--space-1)]"
                      >
                        {expanded ? "Show less" : "Show more"}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <p className="text-[10px] text-text-muted mt-[var(--space-2)]">
          Read-only -- working memory is session-scoped
        </p>
      </CollapsibleSection>

      <CollapsibleSection title="Episodic Memory" icon={BookOpen} count={episodes.length}>
        <div className="flex items-center gap-[var(--space-2)] mb-[var(--space-3)]">
          <div className="relative flex-1">
            <Search
              size={14}
              className="absolute left-[var(--space-3)] top-1/2 -translate-y-1/2 text-text-muted pointer-events-none"
            />
            <input
              type="text"
              placeholder="Search episodes..."
              value={episodeSearch}
              onChange={(e) => setEpisodeSearch(e.target.value)}
              className="pl-9 bg-surface-overlay text-[var(--text-xs)]"
            />
          </div>
          <button
            onClick={() => setShowAddEpisode(true)}
            className="btn btn-secondary text-[var(--text-xs)] min-h-[var(--touch-target-min)]"
          >
            <Plus size={12} />
            Add Episode
          </button>
          {episodes.length > 0 && (
            <button
              onClick={handleClearEpisodes}
              className="btn btn-ghost text-status-error text-[var(--text-xs)] min-h-[var(--touch-target-min)]"
            >
              <Trash2 size={12} />
              Clear All
            </button>
          )}
        </div>

        {showAddEpisode && (
          <div className="fixed inset-0 z-50 flex items-center justify-center">
            <div className="absolute inset-0 glass-backdrop" onClick={() => setShowAddEpisode(false)} />
            <div className="relative glass-medium border border-border-default rounded-xl p-[var(--space-6)] w-full max-w-lg shadow-overlay">
              <div className="flex items-center justify-between mb-[var(--space-4)]">
                <h3 className="text-[var(--text-md)] font-semibold text-text-primary">Add Episode</h3>
                <button
                  onClick={() => setShowAddEpisode(false)}
                  className="btn btn-ghost p-[var(--space-2)] min-h-[var(--touch-target-min)] min-w-[var(--touch-target-min)]"
                >
                  <X size={16} />
                </button>
              </div>
              <div className="space-y-[var(--space-3)]">
                <div>
                  <label className="block text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-1)]">
                    Input
                  </label>
                  <textarea
                    rows={3}
                    value={newEpisodeInput}
                    onChange={(e) => setNewEpisodeInput(e.target.value)}
                    className="bg-surface-base font-mono text-[var(--text-xs)]"
                    placeholder="User input or trigger..."
                  />
                </div>
                <div>
                  <label className="block text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-1)]">
                    Output
                  </label>
                  <textarea
                    rows={3}
                    value={newEpisodeOutput}
                    onChange={(e) => setNewEpisodeOutput(e.target.value)}
                    className="bg-surface-base font-mono text-[var(--text-xs)]"
                    placeholder="Agent response or action..."
                  />
                </div>
              </div>
              <div className="flex justify-end gap-[var(--space-2)] mt-[var(--space-4)]">
                <button onClick={() => setShowAddEpisode(false)} className="btn btn-secondary min-h-[var(--touch-target-min)]">
                  Cancel
                </button>
                <button
                  onClick={handleAddEpisode}
                  disabled={!newEpisodeInput.trim()}
                  className="btn btn-primary min-h-[var(--touch-target-min)]"
                >
                  Save
                </button>
              </div>
            </div>
          </div>
        )}

        {episodesQuery.loading ? (
          <p className="text-[var(--text-sm)] text-text-muted">Loading...</p>
        ) : filteredEpisodes.length === 0 ? (
          <p className="text-[var(--text-sm)] text-text-muted">
            {episodeSearch ? "No episodes match your search" : "No episodic memory recorded"}
          </p>
        ) : (
          <div className="space-y-[var(--space-1)]">
            {filteredEpisodes.map((ep, i) => (
              <div
                key={ep.id ?? i}
                className="p-[var(--space-3)] rounded-lg bg-surface-base border border-border-subtle"
              >
                <div className="flex items-start gap-[var(--space-3)]">
                  <div className="flex-1 min-w-0">
                    <p className="text-[var(--text-xs)] text-text-primary font-mono truncate">
                      <span className="text-text-muted">IN:</span> {ep.input}
                    </p>
                    <p className="text-[var(--text-xs)] text-text-secondary font-mono truncate mt-[var(--space-1)]">
                      <span className="text-text-muted">OUT:</span> {ep.output}
                    </p>
                  </div>
                  <div className="flex flex-col items-end flex-shrink-0 gap-[var(--space-1)]">
                    {ep.outcome && (
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase ${
                          ep.outcome === "success"
                            ? "bg-status-live/10 text-status-live"
                            : ep.outcome === "failure"
                              ? "bg-status-error/10 text-status-error"
                              : "bg-surface-overlay text-text-muted"
                        }`}
                      >
                        {ep.outcome}
                      </span>
                    )}
                    {ep.timestamp && (
                      <span className="text-[10px] text-text-muted">
                        {new Date(ep.timestamp).toLocaleDateString(undefined, {
                          month: "short",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </CollapsibleSection>

      <CollapsibleSection title="Semantic Memory (Facts)" icon={Database} count={facts.length}>
        <div className="flex items-center gap-[var(--space-2)] mb-[var(--space-3)]">
          <div className="relative flex-1">
            <Search
              size={14}
              className="absolute left-[var(--space-3)] top-1/2 -translate-y-1/2 text-text-muted pointer-events-none"
            />
            <input
              type="text"
              placeholder="Search facts..."
              value={factSearch}
              onChange={(e) => setFactSearch(e.target.value)}
              className="pl-9 bg-surface-overlay text-[var(--text-xs)]"
            />
          </div>
          <button
            onClick={() => setShowAddFact(true)}
            className="btn btn-secondary text-[var(--text-xs)] min-h-[var(--touch-target-min)]"
          >
            <Plus size={12} />
            Add Fact
          </button>
          {facts.length > 0 && (
            <button
              onClick={handleClearFacts}
              className="btn btn-ghost text-status-error text-[var(--text-xs)] min-h-[var(--touch-target-min)]"
            >
              <Trash2 size={12} />
              Clear All
            </button>
          )}
        </div>

        {showAddFact && (
          <div className="fixed inset-0 z-50 flex items-center justify-center">
            <div className="absolute inset-0 glass-backdrop" onClick={() => setShowAddFact(false)} />
            <div className="relative glass-medium border border-border-default rounded-xl p-[var(--space-6)] w-full max-w-lg shadow-overlay">
              <div className="flex items-center justify-between mb-[var(--space-4)]">
                <h3 className="text-[var(--text-md)] font-semibold text-text-primary">Add Fact</h3>
                <button
                  onClick={() => setShowAddFact(false)}
                  className="btn btn-ghost p-[var(--space-2)] min-h-[var(--touch-target-min)] min-w-[var(--touch-target-min)]"
                >
                  <X size={16} />
                </button>
              </div>
              <div className="space-y-[var(--space-3)]">
                <div>
                  <label className="block text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-1)]">
                    Key
                  </label>
                  <input
                    type="text"
                    value={newFactKey}
                    onChange={(e) => setNewFactKey(e.target.value)}
                    className="bg-surface-base text-[var(--text-xs)]"
                    placeholder="e.g. preferred_language"
                  />
                </div>
                <div>
                  <label className="block text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-1)]">
                    Value
                  </label>
                  <textarea
                    rows={2}
                    value={newFactValue}
                    onChange={(e) => setNewFactValue(e.target.value)}
                    className="bg-surface-base text-[var(--text-xs)]"
                    placeholder="Fact value..."
                  />
                </div>
                <div>
                  <label className="block text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-1)]">
                    Category (optional)
                  </label>
                  <input
                    type="text"
                    value={newFactCategory}
                    onChange={(e) => setNewFactCategory(e.target.value)}
                    className="bg-surface-base text-[var(--text-xs)]"
                    placeholder="e.g. user_preferences"
                  />
                </div>
              </div>
              <div className="flex justify-end gap-[var(--space-2)] mt-[var(--space-4)]">
                <button onClick={() => setShowAddFact(false)} className="btn btn-secondary min-h-[var(--touch-target-min)]">
                  Cancel
                </button>
                <button
                  onClick={handleAddFact}
                  disabled={!newFactKey.trim()}
                  className="btn btn-primary min-h-[var(--touch-target-min)]"
                >
                  Save
                </button>
              </div>
            </div>
          </div>
        )}

        {factsQuery.loading ? (
          <p className="text-[var(--text-sm)] text-text-muted">Loading...</p>
        ) : filteredFacts.length === 0 ? (
          <p className="text-[var(--text-sm)] text-text-muted">
            {factSearch ? "No facts match your search" : "No facts stored"}
          </p>
        ) : (
          <div className="space-y-[var(--space-1)]">
            {filteredFacts.map((fact) => (
              <div
                key={fact.key}
                className="flex items-center gap-[var(--space-3)] p-[var(--space-2)] rounded-lg bg-surface-base border border-border-subtle"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-[var(--space-2)]">
                    <span className="text-[var(--text-xs)] font-mono text-accent font-semibold">{fact.key}</span>
                    {fact.category && (
                      <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase bg-surface-overlay text-text-muted border border-border-default">
                        {fact.category}
                      </span>
                    )}
                  </div>
                  <p className="text-[var(--text-xs)] text-text-secondary mt-[var(--space-1)]">{fact.value}</p>
                  <div className="flex items-center gap-[var(--space-3)] mt-[var(--space-1)]">
                    {fact.confidence != null && (
                      <div className="flex items-center gap-[var(--space-2)]">
                        <span className="text-[10px] text-text-muted">Confidence:</span>
                        <div className="w-16 h-1.5 bg-surface-overlay rounded-full overflow-hidden">
                          <div
                            className="h-full rounded-full bg-accent"
                            style={{ width: `${(fact.confidence * 100).toFixed(0)}%` }}
                          />
                        </div>
                        <span className="text-[10px] text-text-muted font-mono">
                          {(fact.confidence * 100).toFixed(0)}%
                        </span>
                      </div>
                    )}
                    {fact.source && <span className="text-[10px] text-text-muted">Source: {fact.source}</span>}
                  </div>
                </div>
                <button
                  onClick={() => handleDeleteFact(fact.key)}
                  className="btn btn-ghost text-status-error p-[var(--space-1)] min-h-[var(--touch-target-min)] min-w-[var(--touch-target-min)] flex-shrink-0"
                  aria-label={`Delete fact ${fact.key}`}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
      </CollapsibleSection>

      <CollapsibleSection title="Procedural Memory" icon={Settings2} count={procedures.length}>
        {procedures.length > 0 && (
          <div className="flex justify-end mb-[var(--space-3)]">
            <button
              onClick={handleClearProcedures}
              className="btn btn-ghost text-status-error text-[var(--text-xs)] min-h-[var(--touch-target-min)]"
            >
              <Trash2 size={12} />
              Clear All
            </button>
          </div>
        )}
        {proceduresQuery.loading ? (
          <p className="text-[var(--text-sm)] text-text-muted">Loading...</p>
        ) : procedures.length === 0 ? (
          <p className="text-[var(--text-sm)] text-text-muted">
            No procedures learned yet. Procedures are learned from agent execution.
          </p>
        ) : (
          <div className="space-y-[var(--space-2)]">
            {procedures.map((proc) => {
              const total = (proc.success_count ?? 0) + (proc.failure_count ?? 0);
              const rate = proc.success_rate ?? (total > 0 ? (proc.success_count ?? 0) / total : 0);
              return (
                <div
                  key={proc.name}
                  className="p-[var(--space-3)] rounded-lg bg-surface-base border border-border-subtle"
                >
                  <div className="flex items-center justify-between mb-[var(--space-2)]">
                    <span className="text-[var(--text-sm)] font-medium text-text-primary">{proc.name}</span>
                    <div className="flex items-center gap-[var(--space-3)]">
                      <span className="text-[10px] text-status-live font-mono">{proc.success_count ?? 0} pass</span>
                      <span className="text-[10px] text-status-error font-mono">{proc.failure_count ?? 0} fail</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-[var(--space-2)]">
                    <div className="flex-1 h-2 bg-surface-overlay rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${
                          rate >= 0.9
                            ? "bg-status-live"
                            : rate >= 0.7
                              ? "bg-status-warning"
                              : "bg-status-error"
                        }`}
                        style={{ width: `${(rate * 100).toFixed(0)}%` }}
                      />
                    </div>
                    <span className="text-[10px] text-text-muted font-mono w-10 text-right">
                      {(rate * 100).toFixed(0)}%
                    </span>
                  </div>
                  {proc.steps && proc.steps.length > 0 && (
                    <div className="mt-[var(--space-2)]">
                      <span className="text-[10px] text-text-muted uppercase tracking-wide">Steps:</span>
                      <div className="flex flex-wrap gap-[var(--space-1)] mt-[var(--space-1)]">
                        {proc.steps.map((step, si) => (
                          <span
                            key={si}
                            className="inline-block px-2 py-0.5 rounded text-[10px] font-mono bg-surface-overlay text-text-secondary border border-border-default"
                          >
                            {step}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        <p className="text-[10px] text-text-muted mt-[var(--space-2)]">
          Read-only -- procedures are learned from agent execution
        </p>
      </CollapsibleSection>
    </div>
  );
}
