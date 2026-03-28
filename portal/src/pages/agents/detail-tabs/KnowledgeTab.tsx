import { useState, useEffect, useRef, useCallback, type DragEvent } from "react";
import { Upload, FileText, Trash2, RefreshCw } from "lucide-react";

import { type KnowledgeDocument } from "../../../lib/adapters";
import { apiGet, apiUpload, apiDelete } from "../../../lib/api";
import { useToast } from "../../../components/common/ToastProvider";

/* ── Props ────────────────────────────────────────────────────── */

type KnowledgeTabProps = {
  agentName: string;
};

/* ── Types ────────────────────────────────────────────────────── */

type IndexStatus = {
  total_documents?: number;
  total_chunks?: number;
  status?: string;
};

const ACCEPTED_EXTENSIONS = [".txt", ".md", ".pdf", ".json", ".csv"];

/* ── Helpers ──────────────────────────────────────────────────── */

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso?: string): string {
  if (!iso) return "-";
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/* ── Component ────────────────────────────────────────────────── */

export const KnowledgeTab = ({ agentName }: KnowledgeTabProps) => {
  const { showToast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [indexStatus, setIndexStatus] = useState<IndexStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [dragActive, setDragActive] = useState(false);

  /* ── Fetch data ─────────────────────────────────────────────── */

  const fetchDocs = useCallback(async () => {
    try {
      const data = await apiGet<KnowledgeDocument[]>(`/api/v1/rag/${agentName}/documents`);
      setDocuments(Array.isArray(data) ? data : []);
    } catch {
      setDocuments([]);
    }
  }, [agentName]);

  const fetchStatus = useCallback(async () => {
    try {
      const data = await apiGet<IndexStatus>(`/api/v1/rag/${agentName}/status`);
      setIndexStatus(data);
    } catch {
      setIndexStatus(null);
    }
  }, [agentName]);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      await Promise.all([fetchDocs(), fetchStatus()]);
      setLoading(false);
    };
    void load();
  }, [fetchDocs, fetchStatus]);

  /* ── Upload handler ─────────────────────────────────────────── */

  const uploadFiles = async (files: FileList | File[]) => {
    const fileArr = Array.from(files).filter((f) =>
      ACCEPTED_EXTENSIONS.some((ext) => f.name.toLowerCase().endsWith(ext)),
    );
    if (fileArr.length === 0) {
      showToast("No supported files selected (.txt, .md, .pdf, .json, .csv)", "error");
      return;
    }

    setUploading(true);
    let successCount = 0;
    for (const file of fileArr) {
      try {
        const formData = new FormData();
        formData.append("file", file);
        await apiUpload(`/api/v1/rag/${agentName}/ingest`, formData);
        successCount++;
      } catch (err) {
        showToast(
          `Failed to upload ${file.name}: ${err instanceof Error ? err.message : "Unknown error"}`,
          "error",
        );
      }
    }

    if (successCount > 0) {
      showToast(`${successCount} file(s) uploaded`, "success");
      await Promise.all([fetchDocs(), fetchStatus()]);
    }
    setUploading(false);
  };

  /* ── Delete handler ─────────────────────────────────────────── */

  const handleDeleteDoc = async (docId: string) => {
    try {
      await apiDelete(`/api/v1/rag/${agentName}/documents/${docId}`);
      showToast("Document removed", "success");
      await Promise.all([fetchDocs(), fetchStatus()]);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to delete document", "error");
    }
  };

  /* ── Drag handlers ──────────────────────────────────────────── */

  const handleDrag = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") setDragActive(true);
    if (e.type === "dragleave") setDragActive(false);
  };

  const handleDrop = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files.length > 0) {
      void uploadFiles(e.dataTransfer.files);
    }
  };

  /* ── Render ─────────────────────────────────────────────────── */

  return (
    <div className="space-y-6">
      {/* Upload zone */}
      <div className="card">
        <h3 className="text-sm font-semibold text-text-primary mb-3">Upload Documents</h3>

        <div
          onDragEnter={handleDrag}
          onDragOver={handleDrag}
          onDragLeave={handleDrag}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          className="border-2 border-dashed rounded-lg p-8 flex flex-col items-center justify-center gap-3 cursor-pointer transition-colors"
          style={{
            borderColor: dragActive ? "var(--color-accent)" : "var(--color-border-default)",
            backgroundColor: dragActive ? "var(--color-accent-muted)" : "transparent",
            minHeight: "10rem",
          }}
          role="button"
          tabIndex={0}
          aria-label="Upload files"
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") fileInputRef.current?.click();
          }}
        >
          <Upload size={24} className="text-text-muted" />
          <p className="text-sm text-text-secondary">
            {uploading ? "Uploading..." : "Drag files here or click to browse"}
          </p>
          <p className="text-xs text-text-muted">.txt, .md, .pdf, .json, .csv</p>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={ACCEPTED_EXTENSIONS.join(",")}
          className="hidden"
          onChange={(e) => {
            if (e.target.files) void uploadFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {/* Index status */}
      <div className="card">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-text-primary">Index Status</h3>
          <button
            type="button"
            onClick={() => void fetchStatus()}
            className="btn btn-ghost p-1"
            style={{ minWidth: "var(--touch-target-min)", minHeight: "var(--touch-target-min)" }}
            aria-label="Refresh status"
          >
            <RefreshCw size={14} />
          </button>
        </div>

        {loading ? (
          <p className="text-xs text-text-muted">Loading...</p>
        ) : indexStatus ? (
          <div className="grid grid-cols-3 gap-4">
            <div>
              <span className="block text-xs text-text-muted uppercase tracking-wide mb-1">Documents</span>
              <span className="text-sm text-text-secondary font-mono">{indexStatus.total_documents ?? 0}</span>
            </div>
            <div>
              <span className="block text-xs text-text-muted uppercase tracking-wide mb-1">Chunks</span>
              <span className="text-sm text-text-secondary font-mono">{indexStatus.total_chunks ?? 0}</span>
            </div>
            <div>
              <span className="block text-xs text-text-muted uppercase tracking-wide mb-1">Status</span>
              <span
                className="inline-block text-xs font-medium px-2 py-0.5 rounded-full"
                style={{
                  backgroundColor:
                    indexStatus.status === "ready" ? "var(--color-status-live)" :
                    indexStatus.status === "indexing" ? "var(--color-status-warning)" :
                    "var(--color-surface-overlay)",
                  color: "var(--color-text-primary)",
                }}
              >
                {indexStatus.status ?? "unknown"}
              </span>
            </div>
          </div>
        ) : (
          <p className="text-xs text-text-muted">No index data available.</p>
        )}
      </div>

      {/* Documents list */}
      <div className="card">
        <h3 className="text-sm font-semibold text-text-primary mb-3">
          Documents ({documents.length})
        </h3>

        {loading ? (
          <p className="text-xs text-text-muted py-4 text-center">Loading documents...</p>
        ) : documents.length === 0 ? (
          <div className="border border-border-default rounded-md p-6 flex items-center justify-center">
            <p className="text-xs text-text-muted">No documents uploaded yet.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {documents.map((doc) => (
              <div
                key={doc.id}
                className="flex items-center justify-between gap-3 px-3 py-2 bg-surface-base border border-border-default rounded-md"
              >
                <div className="flex items-center gap-3 flex-1 min-w-0">
                  <FileText size={16} className="text-text-muted flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-text-secondary font-mono truncate">{doc.filename}</p>
                    <div className="flex items-center gap-3 mt-0.5">
                      {doc.size_bytes != null && (
                        <span className="text-xs text-text-muted">{formatBytes(doc.size_bytes)}</span>
                      )}
                      <span className="text-xs text-text-muted">{doc.status}</span>
                      <span className="text-xs text-text-muted">{formatDate(doc.ingested_at)}</span>
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void handleDeleteDoc(doc.id)}
                  className="btn btn-ghost p-1 text-status-error hover:bg-status-error/10 flex-shrink-0"
                  style={{ minWidth: "var(--touch-target-min)", minHeight: "var(--touch-target-min)" }}
                  aria-label={`Delete ${doc.filename}`}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
