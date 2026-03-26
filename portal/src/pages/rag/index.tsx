import { useMemo, useState, useRef } from "react";
import {
  Upload,
  FileText,
  Database,
  Trash2,
  Eye,
  Search,
  RefreshCw,
  HardDrive,
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
import type { AgentInfo } from "../../lib/adapters";
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

export const RagPage = () => {
  const { showToast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);

  /* ── Agent selection ──────────────────────────────────────── */
  const agentsQuery = useApiQuery<AgentInfo[]>("/api/v1/agents");
  const agents = useMemo(() => agentsQuery.data ?? [], [agentsQuery.data]);
  const [agentName, setAgentName] = useState("");
  const selectedAgent = agentName || agents[0]?.name || "";

  /* ── Upload settings ──────────────────────────────────────── */
  const [chunkSize, setChunkSize] = useState("512");
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);

  /* ── Queries ──────────────────────────────────────────────── */
  const statusQuery = useApiQuery<RagStatus>(
    `/api/v1/rag/${encodeURIComponent(selectedAgent)}/status`,
    Boolean(selectedAgent),
  );
  const docsQuery = useApiQuery<{ documents: RagDocument[] }>(
    `/api/v1/rag/${encodeURIComponent(selectedAgent)}/documents`,
    Boolean(selectedAgent),
  );
  const documents = docsQuery.data?.documents ?? [];

  /* ── Search ───────────────────────────────────────────────── */
  const [docSearch, setDocSearch] = useState("");
  const filteredDocs = docSearch
    ? documents.filter(
        (d) =>
          (d.filename ?? d.metadata?.source ?? "")
            .toLowerCase()
            .includes(docSearch.toLowerCase()),
      )
    : documents;

  /* ── Chunk viewer ─────────────────────────────────────────── */
  const [chunkDrawerOpen, setChunkDrawerOpen] = useState(false);
  const [selectedDoc, setSelectedDoc] = useState<RagDocument | null>(null);
  const [chunks, setChunks] = useState<RagChunk[]>([]);
  const [chunksLoading, setChunksLoading] = useState(false);

  /* ── Confirm dialog ───────────────────────────────────────── */
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmAction, setConfirmAction] = useState<{
    title: string;
    desc: string;
    action: () => Promise<void>;
  } | null>(null);

  /* ── Upload handler ───────────────────────────────────────── */
  const handleUpload = async (files: FileList | null) => {
    if (!files || files.length === 0 || !selectedAgent) return;
    setUploading(true);
    setUploadProgress(0);

    try {
      const formData = new FormData();
      for (const file of Array.from(files)) {
        formData.append("files", file);
      }
      formData.append("chunk_size", chunkSize);

      const token = localStorage.getItem("token");
      const headers: Record<string, string> = {};
      if (token) headers.Authorization = `Bearer ${token}`;

      // Simulate progress
      const progressInterval = setInterval(() => {
        setUploadProgress((p) => Math.min(p + 10, 90));
      }, 200);

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
      showToast(
        err instanceof Error ? err.message : "Upload failed",
        "error",
      );
    } finally {
      setUploading(false);
      setTimeout(() => setUploadProgress(0), 1500);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  /* ── View chunks ──────────────────────────────────────────── */
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

  /* ── Delete document ──────────────────────────────────────── */
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

  /* ── Row actions ──────────────────────────────────────────── */
  const getDocActions = (doc: RagDocument): ActionMenuItem[] => [
    {
      label: "View Chunks",
      icon: <Eye size={12} />,
      onClick: () => void viewChunks(doc),
    },
    {
      label: "Delete",
      icon: <Trash2 size={12} />,
      onClick: () => handleDeleteDoc(doc),
      danger: true,
    },
  ];

  const formatBytes = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

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
                  PDF, TXT, MD, DOCX, CSV
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

        {/* Upload progress */}
        {uploading && (
          <div className="mt-3">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs text-text-secondary">Uploading...</span>
              <span className="text-xs text-text-muted font-mono">
                {uploadProgress}%
              </span>
            </div>
            <div className="w-full h-1.5 bg-surface-overlay rounded-full overflow-hidden">
              <div
                className="h-full bg-accent rounded-full transition-all duration-300"
                style={{ width: `${uploadProgress}%` }}
              />
            </div>
          </div>
        )}
      </div>

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
            title="No documents"
            description="Upload documents above to build your knowledge base"
          />
        ) : (
          <div className="card p-0">
            <div className="overflow-x-auto">
              <table>
                <thead>
                  <tr>
                    <th>Document</th>
                    <th>Status</th>
                    <th>Chunks</th>
                    <th>Size</th>
                    <th>Ingested</th>
                    <th style={{ width: "48px" }}></th>
                  </tr>
                </thead>
                <tbody>
                  {filteredDocs.map((doc, i) => (
                    <tr key={doc.id ?? i}>
                      <td>
                        <div className="flex items-center gap-2">
                          <FileText
                            size={14}
                            className="text-text-muted shrink-0"
                          />
                          <span className="text-text-primary text-sm">
                            {doc.filename ??
                              doc.metadata?.source ??
                              `document-${i + 1}`}
                          </span>
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
                            ? new Date(doc.ingested_at).toLocaleDateString()
                            : "--"}
                        </span>
                      </td>
                      <td>
                        <ActionMenu items={getDocActions(doc)} />
                      </td>
                    </tr>
                  ))}
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
