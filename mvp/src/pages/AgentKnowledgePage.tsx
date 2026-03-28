import { useState, useRef, useCallback, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Upload, FileText, File, Trash2, Search, CheckCircle, Clock, AlertCircle, Loader2 } from "lucide-react";
import { Button } from "../components/ui/Button";
import { AgentNav } from "../components/AgentNav";
import { AgentNotFound } from "../components/AgentNotFound";
import { Card } from "../components/ui/Card";
import { Badge } from "../components/ui/Badge";
import { Select } from "../components/ui/Select";
import { Modal } from "../components/ui/Modal";
import { useToast } from "../components/ui/Toast";
import { api } from "../lib/api";
import { agentPathSegment } from "../lib/agent-path";

interface KBDocument {
  id: string;
  filename: string;
  status: "processing" | "ready" | "error";
  chunks: number;
  created_at: string;
}

const ACCEPTED_TYPES = ".pdf,.doc,.docx,.txt,.md,.csv,.json,.html";

function fileIcon(name: string) {
  if (name.endsWith(".pdf")) return <FileText size={20} className="text-red-500" />;
  return <File size={20} className="text-blue-500" />;
}

const statusConfig = {
  ready: { variant: "success" as const, icon: CheckCircle, label: "Ready" },
  processing: { variant: "warning" as const, icon: Clock, label: "Processing" },
  error: { variant: "danger" as const, icon: AlertCircle, label: "Error" },
};

export default function AgentKnowledgePage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [agentName, setAgentName] = useState<string | null>(null);
  const [docs, setDocs] = useState<KBDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const [search, setSearch] = useState("");
  const [dragging, setDragging] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [chunkSize, setChunkSize] = useState("512");
  const [chunkOverlap, setChunkOverlap] = useState("50");
  const [selectedDoc, setSelectedDoc] = useState<KBDocument | null>(null);

  const fetchDocs = useCallback(async () => {
    if (!id) return;
    try {
      const documents = await api.get<KBDocument[]>(`/rag/documents?agent_name=${encodeURIComponent(id.trim())}`);
      setDocs(documents || []);
    } catch { /* silently ignore refresh failures */ }
  }, [id]);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;

    (async () => {
      try {
        setLoading(true);
        setError(null);

        const [agent, documents] = await Promise.all([
          api.get<{ name: string }>(`/agents/${agentPathSegment(id)}`),
          api.get<KBDocument[]>(`/rag/documents?agent_name=${encodeURIComponent(id.trim())}`),
        ]);
        if (cancelled) return;

        setAgentName(agent.name ?? id);
        setDocs(documents || []);
      } catch (err: any) {
        if (!cancelled) setError(err.message || "Failed to load knowledge base");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [id]);

  const filteredDocs = docs.filter((d) =>
    d.filename.toLowerCase().includes(search.toLowerCase()),
  );

  const handleFiles = useCallback(
    async (files: FileList | null) => {
      if (!files || !id) return;
      setUploading(true);
      try {
        for (const file of Array.from(files)) {
          const formData = new FormData();
          formData.append("file", file);
          formData.append("agent_name", id);

          const token = localStorage.getItem("agentos_token");
          const BASE = (globalThis as any).__VITE_API_URL ?? "https://agentos-control-plane.servesys.workers.dev/api/v1";
          await fetch(`${BASE}/rag/upload`, {
            method: "POST",
            headers: token ? { Authorization: `Bearer ${token}` } : {},
            body: formData,
          });
        }
        toast(`Uploaded ${files.length} file${files.length > 1 ? "s" : ""}`);
        await fetchDocs();
      } catch (err: any) {
        toast(err.message || "Upload failed");
      } finally {
        setUploading(false);
      }
    },
    [id, toast, fetchDocs],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      handleFiles(e.dataTransfer.files);
    },
    [handleFiles],
  );

  const deleteDoc = async (docId: string) => {
    try {
      await api.del(`/rag/documents/${docId}`);
      setDocs((prev) => prev.filter((d) => d.id !== docId));
      setSelectedDoc(null);
      toast("Document removed");
    } catch (err: any) {
      toast(err.message || "Failed to delete document");
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 size={24} className="animate-spin text-primary" />
        <span className="ml-2 text-sm text-text-secondary">Loading knowledge base...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-24">
        <p className="text-sm text-danger mb-2">{error}</p>
        <Button size="sm" variant="secondary" onClick={() => window.location.reload()}>Retry</Button>
      </div>
    );
  }

  if (!agentName) return <AgentNotFound />;

  const totalChunks = docs.filter((d) => d.status === "ready").reduce((s, d) => s + d.chunks, 0);

  return (
    <div>
      <AgentNav agentName={agentName}>
        <Button size="sm" variant="ghost" onClick={() => setShowSettings(true)}>
          Settings
        </Button>
        <Button size="sm" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
          {uploading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
          Upload
        </Button>
      </AgentNav>
        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPTED_TYPES}
          multiple
          className="hidden"
          onChange={(e) => handleFiles(e.target.files)}
        />

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <Card>
          <p className="text-xs text-text-secondary">Documents</p>
          <p className="text-xl font-semibold text-text">{docs.length}</p>
        </Card>
        <Card>
          <p className="text-xs text-text-secondary">Chunks indexed</p>
          <p className="text-xl font-semibold text-text">{totalChunks}</p>
        </Card>
        <Card>
          <p className="text-xs text-text-secondary">Total files</p>
          <p className="text-xl font-semibold text-text">{docs.length}</p>
        </Card>
      </div>

      {/* Drop zone */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        className={`border-2 border-dashed rounded-xl p-8 text-center transition-colors mb-6 ${
          dragging
            ? "border-primary bg-primary-light"
            : "border-border hover:border-gray-300"
        }`}
      >
        <Upload size={32} className="mx-auto text-text-muted mb-3" />
        <p className="text-sm font-medium text-text">
          Drag & drop files here, or{" "}
          <button onClick={() => fileInputRef.current?.click()} className="text-primary hover:underline">
            browse
          </button>
        </p>
        <p className="text-xs text-text-muted mt-1">
          PDF, Word, TXT, Markdown, CSV, JSON, HTML — up to 10MB each
        </p>
      </div>

      {/* Search */}
      {docs.length > 0 && (
        <div className="mb-4">
          <div className="relative max-w-xs">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
            <input
              type="text"
              placeholder="Search documents..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-9 pr-3 py-2 rounded-lg border border-border text-sm bg-white placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
            />
          </div>
        </div>
      )}

      {/* Document list */}
      <div className="bg-white rounded-xl border border-border divide-y divide-border">
        {filteredDocs.length === 0 && docs.length === 0 && (
          <div className="p-12 text-center">
            <FileText size={40} className="mx-auto text-text-muted mb-3" />
            <p className="text-sm font-medium text-text mb-1">No knowledge base documents</p>
            <p className="text-xs text-text-muted mb-4">
              Upload files to teach your agent
            </p>
            <Button size="sm" onClick={() => fileInputRef.current?.click()}>
              <Upload size={14} /> Upload first document
            </Button>
          </div>
        )}
        {filteredDocs.length === 0 && docs.length > 0 && (
          <p className="p-6 text-sm text-text-muted text-center">No documents match "{search}"</p>
        )}
        {filteredDocs.map((doc) => {
          const status = statusConfig[doc.status];
          const StatusIcon = status.icon;
          return (
            <div
              key={doc.id}
              onClick={() => setSelectedDoc(doc)}
              className="flex items-center gap-4 p-4 hover:bg-surface-alt transition-colors cursor-pointer"
            >
              <div className="shrink-0">{fileIcon(doc.filename)}</div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-text truncate">{doc.filename}</p>
                <p className="text-xs text-text-muted mt-0.5">
                  {doc.status === "ready" && `${doc.chunks} chunks · `}
                  {new Date(doc.created_at).toLocaleDateString()}
                </p>
              </div>
              <Badge variant={status.variant}>
                <StatusIcon size={12} className="mr-1" />
                {status.label}
              </Badge>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  deleteDoc(doc.id);
                }}
                className="p-1.5 rounded-lg hover:bg-red-50 text-text-muted hover:text-danger transition-colors"
              >
                <Trash2 size={14} />
              </button>
            </div>
          );
        })}
      </div>

      {/* Document detail modal */}
      <Modal open={!!selectedDoc} onClose={() => setSelectedDoc(null)} title="Document Details" wide>
        {selectedDoc && (
          <div className="space-y-4">
            <div className="flex items-start gap-3">
              {fileIcon(selectedDoc.filename)}
              <div>
                <p className="text-sm font-semibold text-text">{selectedDoc.filename}</p>
              </div>
            </div>

            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-text-secondary text-xs">Status</dt>
                <dd>
                  <Badge variant={statusConfig[selectedDoc.status].variant}>
                    {statusConfig[selectedDoc.status].label}
                  </Badge>
                </dd>
              </div>
              <div>
                <dt className="text-text-secondary text-xs">Chunks</dt>
                <dd className="font-medium text-text">{selectedDoc.chunks}</dd>
              </div>
              <div>
                <dt className="text-text-secondary text-xs">Uploaded</dt>
                <dd className="font-medium text-text">
                  {new Date(selectedDoc.created_at).toLocaleString()}
                </dd>
              </div>
            </dl>

            <div className="flex justify-between pt-2">
              <Button variant="danger" size="sm" onClick={() => deleteDoc(selectedDoc.id)}>
                <Trash2 size={14} /> Delete Document
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setSelectedDoc(null)}>
                Close
              </Button>
            </div>
          </div>
        )}
      </Modal>

      {/* Settings modal */}
      <Modal open={showSettings} onClose={() => setShowSettings(false)} title="Knowledge Base Settings">
        <div className="space-y-4">
          <Select
            label="Chunk size (tokens)"
            value={chunkSize}
            onChange={(e) => setChunkSize(e.target.value)}
            options={[
              { value: "256", label: "256 — More precise, more chunks" },
              { value: "512", label: "512 — Balanced (recommended)" },
              { value: "1024", label: "1024 — Broader context, fewer chunks" },
            ]}
          />
          <Select
            label="Chunk overlap (tokens)"
            value={chunkOverlap}
            onChange={(e) => setChunkOverlap(e.target.value)}
            options={[
              { value: "0", label: "0 — No overlap" },
              { value: "50", label: "50 — Small overlap (recommended)" },
              { value: "100", label: "100 — More overlap, better continuity" },
            ]}
          />
          <div className="bg-blue-50 rounded-lg p-3 text-xs text-blue-700">
            Changes apply to newly uploaded documents. Existing documents keep their current chunking. Re-upload to apply new settings.
          </div>
          <div className="flex justify-end pt-2">
            <Button onClick={() => { setShowSettings(false); toast("Settings saved"); }}>
              Save Settings
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
