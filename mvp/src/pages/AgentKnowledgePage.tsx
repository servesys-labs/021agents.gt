import { useState, useRef, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Upload, FileText, File, Trash2, Search, CheckCircle, Clock, AlertCircle, X } from "lucide-react";
import { Button } from "../components/ui/Button";
import { AgentNav } from "../components/AgentNav";
import { AgentNotFound } from "../components/AgentNotFound";
import { Card } from "../components/ui/Card";
import { Badge } from "../components/ui/Badge";
import { Input } from "../components/ui/Input";
import { Select } from "../components/ui/Select";
import { Modal } from "../components/ui/Modal";
import { useToast } from "../components/ui/Toast";
import { MOCK_AGENTS } from "../lib/mock-data";

interface KBDocument {
  id: string;
  name: string;
  type: string;
  size: number;
  status: "processing" | "ready" | "error";
  chunks: number;
  uploaded_at: string;
}

const INITIAL_DOCS: KBDocument[] = [
  { id: "doc-1", name: "FAQ - Delivery & Returns.pdf", type: "application/pdf", size: 245_000, status: "ready", chunks: 24, uploaded_at: "2026-03-25T10:00:00Z" },
  { id: "doc-2", name: "Product Catalog Spring 2026.pdf", type: "application/pdf", size: 1_200_000, status: "ready", chunks: 87, uploaded_at: "2026-03-26T14:30:00Z" },
  { id: "doc-3", name: "Wedding Packages.docx", type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size: 89_000, status: "ready", chunks: 12, uploaded_at: "2026-03-27T09:15:00Z" },
  { id: "doc-4", name: "Store Policies.txt", type: "text/plain", size: 15_000, status: "ready", chunks: 6, uploaded_at: "2026-03-27T11:00:00Z" },
];

const ACCEPTED_TYPES = ".pdf,.doc,.docx,.txt,.md,.csv,.json,.html";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileIcon(type: string) {
  if (type.includes("pdf")) return <FileText size={20} className="text-red-500" />;
  return <File size={20} className="text-blue-500" />;
}

const statusConfig = {
  ready: { variant: "success" as const, icon: CheckCircle, label: "Ready" },
  processing: { variant: "warning" as const, icon: Clock, label: "Processing" },
  error: { variant: "danger" as const, icon: AlertCircle, label: "Error" },
};

export default function AgentKnowledgePage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const agent = MOCK_AGENTS.find((a) => a.id === id);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [docs, setDocs] = useState<KBDocument[]>(INITIAL_DOCS);
  const [search, setSearch] = useState("");
  const [dragging, setDragging] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [chunkSize, setChunkSize] = useState("512");
  const [chunkOverlap, setChunkOverlap] = useState("50");
  const [selectedDoc, setSelectedDoc] = useState<KBDocument | null>(null);

  const filteredDocs = docs.filter((d) =>
    d.name.toLowerCase().includes(search.toLowerCase()),
  );

  const handleFiles = useCallback(
    (files: FileList | null) => {
      if (!files) return;
      const newDocs: KBDocument[] = Array.from(files).map((f) => ({
        id: `doc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name: f.name,
        type: f.type,
        size: f.size,
        status: "processing" as const,
        chunks: 0,
        uploaded_at: new Date().toISOString(),
      }));

      setDocs((prev) => [...newDocs, ...prev]);
      toast(`Uploading ${newDocs.length} file${newDocs.length > 1 ? "s" : ""}...`);

      // Simulate processing
      newDocs.forEach((doc) => {
        setTimeout(
          () => {
            setDocs((prev) =>
              prev.map((d) =>
                d.id === doc.id
                  ? { ...d, status: "ready", chunks: Math.floor(doc.size / (parseInt(chunkSize) || 512)) + 1 }
                  : d,
              ),
            );
            toast(`${doc.name} processed`);
          },
          1500 + Math.random() * 2000,
        );
      });
    },
    [toast, chunkSize],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      handleFiles(e.dataTransfer.files);
    },
    [handleFiles],
  );

  const deleteDoc = (docId: string) => {
    setDocs((prev) => prev.filter((d) => d.id !== docId));
    setSelectedDoc(null);
    toast("Document removed");
  };

  if (!agent) return <AgentNotFound />;

  const totalChunks = docs.filter((d) => d.status === "ready").reduce((s, d) => s + d.chunks, 0);
  const totalSize = docs.reduce((s, d) => s + d.size, 0);

  return (
    <div>
      <AgentNav agentName={agent.name}>
        <Button size="sm" variant="ghost" onClick={() => setShowSettings(true)}>
          Settings
        </Button>
        <Button size="sm" onClick={() => fileInputRef.current?.click()}>
          <Upload size={14} /> Upload
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
          <p className="text-xs text-text-secondary">Total size</p>
          <p className="text-xl font-semibold text-text">{formatSize(totalSize)}</p>
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
            <p className="text-sm font-medium text-text mb-1">No documents yet</p>
            <p className="text-xs text-text-muted mb-4">
              Upload your FAQs, product info, policies, or any docs your agent should know about.
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
              <div className="shrink-0">{fileIcon(doc.type)}</div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-text truncate">{doc.name}</p>
                <p className="text-xs text-text-muted mt-0.5">
                  {formatSize(doc.size)}
                  {doc.status === "ready" && ` · ${doc.chunks} chunks`}
                  {" · "}
                  {new Date(doc.uploaded_at).toLocaleDateString()}
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
              {fileIcon(selectedDoc.type)}
              <div>
                <p className="text-sm font-semibold text-text">{selectedDoc.name}</p>
                <p className="text-xs text-text-muted mt-0.5">{formatSize(selectedDoc.size)}</p>
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
                  {new Date(selectedDoc.uploaded_at).toLocaleString()}
                </dd>
              </div>
              <div>
                <dt className="text-text-secondary text-xs">Type</dt>
                <dd className="font-medium text-text">{selectedDoc.type || "unknown"}</dd>
              </div>
            </dl>

            {selectedDoc.status === "ready" && (
              <div>
                <p className="text-xs font-medium text-text-secondary mb-2">Sample chunks</p>
                <div className="space-y-2">
                  {[
                    "We deliver Monday through Friday, 9am to 6pm, and Saturdays 10am to 4pm. Delivery is free for orders over $50 within our service area...",
                    "Our return policy: Fresh flowers can be returned or exchanged within 24 hours of delivery if they arrive damaged. Please contact us with photos...",
                    "Wedding packages start at $500 for basic centerpieces. Premium packages include ceremony arch, bouquets, boutonnieres, and reception arrangements...",
                  ]
                    .slice(0, Math.min(3, selectedDoc.chunks))
                    .map((chunk, i) => (
                      <div key={i} className="bg-surface-alt rounded-lg p-3 text-xs text-text-secondary">
                        <span className="text-text-muted font-mono mr-2">#{i + 1}</span>
                        {chunk}
                      </div>
                    ))}
                </div>
              </div>
            )}

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
