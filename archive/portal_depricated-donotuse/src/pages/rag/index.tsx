import { useMemo, useState, useRef, useCallback, useEffect } from "react";
import {
  Upload,
  FileText,
  Database,
  Trash2,
  Eye,
  Search,
  RefreshCw,
  HardDrive,
  RotateCcw,
  FileType,
  FileSpreadsheet,
  FileCode,
  File,
  CheckSquare,
} from "lucide-react";

import { PageHeader } from "../../components/common/PageHeader";
import { QueryState } from "../../components/common/QueryState";
import { FormField } from "../../components/common/FormField";
import { SlidePanel } from "../../components/common/SlidePanel";
import { StatusBadge } from "../../components/common/StatusBadge";
import { EmptyState } from "../../components/common/EmptyState";
import { ActionMenu, type ActionMenuItem } from "../../components/common/ActionMenu";
import { ConfirmDialog } from "../../components/common/ConfirmDialog";
import { useToast } from "../../components/common/ToastProvider";
import { safeArray, type AgentInfo } from "../../lib/adapters";
import { useApiQuery, apiRequest } from "../../lib/api";

type RagStatus = {
  indexed?: boolean;
  documents?: number;
  chunks?: number;
  sources?: string[];
  total_size_bytes?: number;
};

type RagDocument = {
  id?: string;
  filename?: string;
  metadata?: { source?: string };
  length?: number;
  chunk_count?: number;
  size_bytes?: number;
  status?: string;
  ingested_at?: string;
};

type RagChunk = {
  chunk_id?: string;
  content?: string;
  metadata?: Record<string, unknown>;
  score?: number;
};

/* ── File type helpers ─────────────────────────────────────── */

function getFileExtension(filename: string): string {
  const parts = filename.split(".");
  return parts.length > 1 ? parts.pop()!.toLowerCase() : "";
}

function getFileTypeIcon(filename: string) {
  const ext = getFileExtension(filename);
  switch (ext) {
    case "pdf":
      return <FileType size={14} className="doc-icon-pdf" />;
    case "txt":
      return <FileText size={14} className="doc-icon-txt" />;
    case "md":
      return <FileText size={14} className="doc-icon-md" />;
    case "csv":
      return <FileSpreadsheet size={14} className="doc-icon-csv" />;
    case "json":
      return <FileCode size={14} className="doc-icon-json" />;
    case "docx":
    case "doc":
      return <FileType size={14} className="doc-icon-docx" />;
    default:
      return <File size={14} className="doc-icon-default" />;
  }
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatETA(secondsRemaining: number): string {
  if (secondsRemaining < 1) return "finishing...";
  if (secondsRemaining < 60) return `~${Math.ceil(secondsRemaining)}s remaining`;
  const mins = Math.floor(secondsRemaining / 60);
  const secs = Math.ceil(secondsRemaining % 60);
  return `~${mins}m ${secs}s remaining`;
}

export const RagPage = () => {
  const { showToast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);

  /* ── Agent selection ──────────────────────────────────────── */
  const agentsQuery = useApiQuery<AgentInfo[]>("/api/v1/agents");
  const agents = useMemo(() => agentsQuery.data ?? [], [agentsQuery.data]);
  const [agentName, setAgentName] = useState("");
  const selectedAgent = agentName || agents[0]?.name || "";

  /* ── Upload state ──────────────────────────────────────────── */
  const [chunkSize, setChunkSize] = useState("512");
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadStartTime, setUploadStartTime] = useState<number | null>(null);
  const [uploadETA, setUploadETA] = useState<string>("");
  const [uploadFailed, setUploadFailed] = useState(false);
  const [lastUploadFiles, setLastUploadFiles] = useState<FileList | null>(null);

  /* ── Bulk selection ────────────────────────────────────────── */
  const [selectedDocs, setSelectedDocs] = useState<Set<string>>(new Set());

  /* ── Queries ───────────────────────────────────────────────── */
  const statusQuery = useApiQuery<RagStatus>(
    `/api/v1/rag/${encodeURIComponent(selectedAgent)}/status`,
    Boolean(selectedAgent),
  );
  const docsQuery = useApiQuery<{ documents: RagDocument[] }>(
    `/api/v1/rag/${encodeURIComponent(selectedAgent)}/documents`,
    Boolean(selectedAgent),
  );
  const documents = docsQuery.data?.documents ?? [];

  /* ── Search ────────────────────────────────────────────────── */
  const [docSearch, setDocSearch] = useState("");
  const filteredDocs = docSearch
    ? documents.filter(
        (d) =>
          (d.filename ?? d.metadata?.source ?? "")
            .toLowerCase()
            .includes(docSearch.toLowerCase()),
      )
    : documents;

  /* ── Chunk viewer ──────────────────────────────────────────── */
  const [chunkDrawerOpen, setChunkDrawerOpen] = useState(false);
  const [selectedDoc, setSelectedDoc] = useState<RagDocument | null>(null);
  const [chunks, setChunks] = useState<RagChunk[]>([]);
  const [chunksLoading, setChunksLoading] = useState(false);

  /* ── Confirm dialog ────────────────────────────────────────── */
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmAction, setConfirmAction] = useState<{
    title: string;
    desc: string;
    action: () => Promise<void>;
  } | null>(null);

  /* ── ETA calculation ───────────────────────────────────────── */
  useEffect(() => {
    if (!uploading || !uploadStartTime || uploadProgress <= 0) {
      setUploadETA("");
      return;
    }
    const elapsed = (Date.now() - uploadStartTime) / 1000;
    const rate = uploadProgress / elapsed;
    if (rate > 0) {
      const remaining = (100 - uploadProgress) / rate;
      setUploadETA(formatETA(remaining));
    }
  }, [uploading, uploadProgress, uploadStartTime]);

  /* ── Upload handler ────────────────────────────────────────── */
  const handleUpload = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0 || !selectedAgent) return;
      setUploading(true);
      setUploadProgress(0);
      setUploadFailed(false);
      setUploadStartTime(Date.now());
      setLastUploadFiles(files);

      try {
        const formData = new FormData();
        for (const file of Array.from(files)) {
          formData.append("files", file);
        }
        formData.append("chunk_size", chunkSize);

        const token = localStorage.getItem("token");
        const headers: Record<string, string> = {};
        if (token) headers.Authorization = `Bearer ${token}`;

        const progressInterval = setInterval(() => {
          setUploadProgress((p) => Math.min(p + 8, 90));
        }, 300);

        const response = await fetch(
          `/api/v1/rag/${encodeURIComponent(selectedAgent)}/ingest`,
          { method: "POST", headers, body: formData },
        );

        clearInterval(progressInterval);

        if (!response.ok) throw new Error(`Ingest failed (${response.status})`);

        setUploadProgress(100);
        showToast(
          `${files.length} document${files.length > 1 ? "s" : ""} ingested`,
          "success",
        );
        void statusQuery.refetch();
        void docsQuery.refetch();
      } catch (err) {
        setUploadFailed(true);
        showToast(
          err instanceof Error ? err.message : "Upload failed",
          "error",
        );
      } finally {
        setUploading(false);
        setUploadStartTime(null);
        if (!uploadFailed) {
          setTimeout(() => setUploadProgress(0), 1500);
        }
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
    },
    [selectedAgent, chunkSize, showToast, statusQuery, docsQuery, uploadFailed],
  );

  const handleRetryUpload = () => {
    if (lastUploadFiles) {
      void handleUpload(lastUploadFiles);
    }
  };

  /* ── View chunks ───────────────────────────────────────────── */
  const viewChunks = async (doc: RagDocument) => {
    setSelectedDoc(doc);
    setChunkDrawerOpen(true);
    setChunksLoading(true);
    try {
      const docId = doc.id || doc.filename || doc.metadata?.source || "";
      const result = await apiRequest<{ chunks: RagChunk[] }>(
        `/api/v1/rag/${encodeURIComponent(selectedAgent)}/documents/${encodeURIComponent(docId)}/chunks`,
      );
      setChunks(result.chunks ?? []);
    } catch {
      setChunks([]);
    } finally {
      setChunksLoading(false);
    }
  };

  /* ── Delete document ───────────────────────────────────────── */
  const handleDeleteDoc = (doc: RagDocument) => {
    const name = doc.filename || doc.metadata?.source || "this document";
    setConfirmAction({
      title: "Delete Document",
      desc: `Remove "${name}" and all its chunks? This cannot be undone.`,
      action: async () => {
        const docId = doc.id || doc.filename || doc.metadata?.source || "";
        await apiRequest(
          `/api/v1/rag/${encodeURIComponent(selectedAgent)}/documents/${encodeURIComponent(docId)}`,
          "DELETE",
        );
        showToast("Document deleted", "success");
        void docsQuery.refetch();
        void statusQuery.refetch();
      },
    });
    setConfirmOpen(true);
  };

  /* ── Bulk actions ──────────────────────────────────────────── */
  const getDocId = (doc: RagDocument) =>
    doc.id || doc.filename || doc.metadata?.source || "";

  const toggleDocSelection = (doc: RagDocument) => {
    const id = getDocId(doc);
    setSelectedDocs((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const toggleAllDocs = () => {
    if (selectedDocs.size === filteredDocs.length) {
      setSelectedDocs(new Set());
    } else {
      setSelectedDocs(new Set(filteredDocs.map(getDocId)));
    }
  };

  const handleBulkDelete = () => {
    if (selectedDocs.size === 0) return;
    setConfirmAction({
      title: "Delete Selected Documents",
      desc: `Remove ${selectedDocs.size} document${selectedDocs.size > 1 ? "s" : ""} and all their chunks? This cannot be undone.`,
      action: async () => {
        const promises = Array.from(selectedDocs).map((docId) =>
          apiRequest(
            `/api/v1/rag/${encodeURIComponent(selectedAgent)}/documents/${encodeURIComponent(docId)}`,
            "DELETE",
          ),
        );
        await Promise.allSettled(promises);
        showToast(`${selectedDocs.size} documents deleted`, "success");
        setSelectedDocs(new Set());
        void docsQuery.refetch();
        void statusQuery.refetch();
      },
    });
    setConfirmOpen(true);
  };

  const handleBulkReprocess = async () => {
    if (selectedDocs.size === 0) return;
    try {
      const promises = Array.from(selectedDocs).map((docId) =>
        apiRequest(
          `/api/v1/rag/${encodeURIComponent(selectedAgent)}/documents/${encodeURIComponent(docId)}/reprocess`,
          "POST",
        ),
      );
      await Promise.allSettled(promises);
      showToast(`${selectedDocs.size} documents queued for re-processing`, "success");
      setSelectedDocs(new Set());
      void docsQuery.refetch();
    } catch {
      showToast("Re-process failed", "error");
    }
  };

  /* ── Row actions ───────────────────────────────────────────── */
  const getDocActions = (doc: RagDocument): ActionMenuItem[] => [
    {
      label: "View Chunks",
      icon: <Eye size={12} />,
      onClick: () => void viewChunks(doc),
    },
    {
      label: "Re-process",
      icon: <RotateCcw size={12} />,
      onClick: () =>
        void apiRequest(
          `/api/v1/rag/${encodeURIComponent(selectedAgent)}/documents/${encodeURIComponent(getDocId(doc))}/reprocess`,
          "POST",
        ).then(() => {
          showToast("Re-processing started", "success");
          void docsQuery.refetch();
        }),
    },
    {
      label: "Delete",
      icon: <Trash2 size={12} />,
      onClick: () => handleDeleteDoc(doc),
      danger: true,
    },
  ];

  return (
    <div>
      <PageHeader
        title="Knowledge Base"
        subtitle="Upload documents, monitor ingestion, and browse chunks"
        onRefresh={() => {
          void statusQuery.refetch();
          void docsQuery.refetch();
        }}
      />

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3 mb-4">
        <div className="card flex items-center gap-3 py-3">
          <div className="p-2 rounded-lg bg-chart-blue/10">
            <FileText size={14} className="text-chart-blue" />
          </div>
          <div>
            <p className="text-lg font-bold text-text-primary font-mono">
              {statusQuery.data?.documents ?? documents.length}
            </p>
            <p className="text-[10px] text-text-muted uppercase">Documents</p>
          </div>
        </div>
        <div className="card flex items-center gap-3 py-3">
          <div className="p-2 rounded-lg bg-chart-purple/10">
            <Database size={14} className="text-chart-purple" />
          </div>
          <div>
            <p className="text-lg font-bold text-text-primary font-mono">
              {statusQuery.data?.chunks ?? 0}
            </p>
            <p className="text-[10px] text-text-muted uppercase">Chunks</p>
          </div>
        </div>
        <div className="card flex items-center gap-3 py-3">
          <div className="p-2 rounded-lg bg-accent/10">
            <HardDrive size={14} className="text-accent" />
          </div>
          <div>
            <p className="text-lg font-bold text-text-primary font-mono">
              {statusQuery.data?.total_size_bytes
                ? formatBytes(statusQuery.data.total_size_bytes)
                : "0 B"}
            </p>
            <p className="text-[10px] text-text-muted uppercase">Total Size</p>
          </div>
        </div>
      </div>

      {/* Upload area */}
      <div className="card mb-4">
        <div className="grid gap-3 md:grid-cols-4 items-end">
          <FormField label="Agent">
            <select
              value={selectedAgent}
              onChange={(e) => setAgentName(e.target.value)}
              className="text-sm"
            >
              {agents.map((a) => (
                <option key={a.name} value={a.name}>
                  {a.name}
                </option>
              ))}
            </select>
          </FormField>
          <FormField label="Chunk Size" hint="Characters per chunk">
            <input
              type="number"
              value={chunkSize}
              onChange={(e) => setChunkSize(e.target.value)}
              className="text-sm"
              min={64}
              max={8192}
            />
          </FormField>
          <div className="col-span-2">
            <FormField label="Upload Documents">
              <div
                className="relative border-2 border-dashed border-border-default rounded-lg p-4 text-center cursor-pointer hover:border-accent hover:bg-accent/5 transition-colors"
                onClick={() => fileInputRef.current?.click()}
              >
                <Upload size={20} className="mx-auto mb-1 text-text-muted" />
                <p className="text-xs text-text-secondary">
                  Click to upload or drag files here
                </p>
                <p className="text-[10px] text-text-muted mt-0.5">
                  PDF, TXT, MD, DOCX, CSV, JSON
                </p>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  accept=".pdf,.txt,.md,.docx,.csv,.json"
                  onChange={(e) => void handleUpload(e.target.files)}
                />
              </div>
            </FormField>
          </div>
        </div>

        {/* Upload progress with ETA and retry */}
        {(uploading || uploadProgress > 0 || uploadFailed) && (
          <div className="mt-3">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs text-text-secondary">
                {uploadFailed
                  ? "Upload failed"
                  : uploadProgress >= 100
                    ? "Processing complete"
                    : "Uploading..."}
              </span>
              <div className="flex items-center gap-3">
                {uploading && uploadETA && (
                  <span className="text-[10px] text-text-muted">
                    {uploadETA}
                  </span>
                )}
                <span
                  className={`text-xs font-mono ${uploadFailed ? "text-status-error" : "text-text-muted"}`}
                >
                  {uploadProgress}%
                </span>
              </div>
            </div>
            <div className="progress-track">
              <div
                className={`h-full rounded-full transition-all duration-300 ${
                  uploadFailed
                    ? "bg-status-error"
                    : uploadProgress >= 100
                      ? "bg-status-live"
                      : "progress-bar-gradient"
                }`}
                style={{ width: `${uploadProgress}%` }}
              />
            </div>
            {uploadFailed && (
              <div className="flex items-center gap-2 mt-2">
                <button
                  className="btn btn-secondary text-xs"
                  onClick={handleRetryUpload}
                >
                  <RotateCcw size={12} />
                  Retry Upload
                </button>
                <button
                  className="btn btn-ghost text-xs"
                  onClick={() => {
                    setUploadFailed(false);
                    setUploadProgress(0);
                    setLastUploadFiles(null);
                  }}
                >
                  Dismiss
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Bulk action bar */}
      {selectedDocs.size > 0 && (
        <div className="bulk-action-bar flex items-center gap-3 px-4 py-2.5 mb-3">
          <CheckSquare size={14} className="text-accent" />
          <span className="text-xs text-text-secondary font-medium">
            {selectedDocs.size} selected
          </span>
          <div className="flex-1" />
          <button
            className="btn btn-secondary text-xs"
            onClick={() => void handleBulkReprocess()}
          >
            <RotateCcw size={12} />
            Re-process
          </button>
          <button
            className="btn btn-secondary text-xs text-status-error border-status-error/30 hover:bg-status-error/10"
            onClick={handleBulkDelete}
          >
            <Trash2 size={12} />
            Delete
          </button>
          <button
            className="btn btn-ghost text-xs"
            onClick={() => setSelectedDocs(new Set())}
          >
            Clear
          </button>
        </div>
      )}

      {/* Documents table */}
      <div className="flex items-center justify-between mb-3">
        <div className="relative flex-1 max-w-xs">
          <Search
            size={14}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
          />
          <input
            type="text"
            placeholder="Search documents..."
            value={docSearch}
            onChange={(e) => setDocSearch(e.target.value)}
            className="pl-8 text-xs"
          />
        </div>
        <button
          className="btn btn-secondary text-xs"
          onClick={() => {
            void docsQuery.refetch();
            void statusQuery.refetch();
          }}
        >
          <RefreshCw size={12} />
          Refresh
        </button>
      </div>

      <QueryState
        loading={docsQuery.loading}
        error={docsQuery.error}
        isEmpty={documents.length === 0}
        emptyMessage=""
        onRetry={() => void docsQuery.refetch()}
      >
        {filteredDocs.length === 0 ? (
          <EmptyState
            icon={<FileText size={40} />}
            title="No documents yet"
            description="Upload documents above to build your knowledge base. Supported formats include PDF, TXT, Markdown, DOCX, CSV, and JSON."
            actionLabel="Upload Documents"
            onAction={() => fileInputRef.current?.click()}
          />
        ) : (
          <div className="card p-0">
            <div className="overflow-x-auto">
              <table>
                <thead>
                  <tr>
                    <th style={{ width: "36px", paddingRight: 0 }}>
                      <input
                        type="checkbox"
                        className="bulk-checkbox"
                        checked={
                          filteredDocs.length > 0 &&
                          selectedDocs.size === filteredDocs.length
                        }
                        onChange={toggleAllDocs}
                        aria-label="Select all documents"
                      />
                    </th>
                    <th>Document</th>
                    <th>Status</th>
                    <th>Chunks</th>
                    <th>Size</th>
                    <th>Ingested</th>
                    <th style={{ width: "48px" }}></th>
                  </tr>
                </thead>
                <tbody>
                  {filteredDocs.map((doc, i) => {
                    const docId = getDocId(doc);
                    const filename =
                      doc.filename ??
                      doc.metadata?.source ??
                      `document-${i + 1}`;
                    return (
                      <tr
                        key={doc.id ?? i}
                        className={
                          selectedDocs.has(docId)
                            ? "bg-accent/5"
                            : undefined
                        }
                      >
                        <td style={{ paddingRight: 0 }}>
                          <input
                            type="checkbox"
                            className="bulk-checkbox"
                            checked={selectedDocs.has(docId)}
                            onChange={() => toggleDocSelection(doc)}
                            aria-label={`Select ${filename}`}
                          />
                        </td>
                        <td>
                          <div className="flex items-center gap-2">
                            {getFileTypeIcon(filename)}
                            <div>
                              <span className="text-text-primary text-sm">
                                {filename}
                              </span>
                              <span className="block text-[10px] text-text-muted uppercase">
                                {getFileExtension(filename) || "file"}
                              </span>
                            </div>
                          </div>
                        </td>
                        <td>
                          <StatusBadge
                            status={doc.status ?? "ready"}
                          />
                        </td>
                        <td>
                          <span className="text-text-muted text-xs font-mono">
                            {doc.chunk_count ?? doc.length ?? 0}
                          </span>
                        </td>
                        <td>
                          <span className="text-text-muted text-xs">
                            {doc.size_bytes
                              ? formatBytes(doc.size_bytes)
                              : "--"}
                          </span>
                        </td>
                        <td>
                          <span className="text-text-muted text-[10px]">
                            {doc.ingested_at
                              ? new Date(
                                  doc.ingested_at,
                                ).toLocaleDateString()
                              : "--"}
                          </span>
                        </td>
                        <td>
                          <ActionMenu items={getDocActions(doc)} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </QueryState>

      {/* Chunk viewer drawer */}
      <SlidePanel
        isOpen={chunkDrawerOpen}
        onClose={() => {
          setChunkDrawerOpen(false);
          setSelectedDoc(null);
          setChunks([]);
        }}
        title={`Chunks: ${selectedDoc?.filename ?? selectedDoc?.metadata?.source ?? ""}`}
        subtitle={`${chunks.length} chunks`}
        width="560px"
      >
        {chunksLoading && (
          <p className="text-sm text-text-muted">Loading chunks...</p>
        )}
        {!chunksLoading && chunks.length === 0 && (
          <p className="text-sm text-text-muted">No chunks found.</p>
        )}
        <div className="space-y-3">
          {chunks.map((chunk, i) => (
            <div
              key={chunk.chunk_id ?? i}
              className="border border-border-default rounded-lg p-3 bg-surface-base"
            >
              <div className="flex items-center justify-between mb-2">
                <span className="px-2 py-0.5 text-[10px] font-semibold bg-chart-purple/10 text-chart-purple rounded-full">
                  Chunk {i + 1}
                </span>
                {chunk.score !== undefined && (
                  <span className="text-[10px] text-text-muted font-mono">
                    score: {chunk.score.toFixed(4)}
                  </span>
                )}
              </div>
              <p className="text-xs text-text-secondary whitespace-pre-wrap leading-relaxed">
                {chunk.content?.slice(0, 500)}
                {(chunk.content?.length ?? 0) > 500 && "..."}
              </p>
            </div>
          ))}
        </div>
      </SlidePanel>

      {/* Confirm dialog */}
      {confirmOpen && confirmAction && (
        <ConfirmDialog
          title={confirmAction.title}
          description={confirmAction.desc}
          confirmLabel="Delete"
          tone="danger"
          onConfirm={async () => {
            try {
              await confirmAction.action();
            } catch {
              showToast("Action failed", "error");
            }
            setConfirmOpen(false);
            setConfirmAction(null);
          }}
          onCancel={() => {
            setConfirmOpen(false);
            setConfirmAction(null);
          }}
        />
      )}
    </div>
  );
};
