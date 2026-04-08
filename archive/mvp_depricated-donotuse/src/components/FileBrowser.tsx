/**
 * FileBrowser — Browse and preview workspace files stored in R2.
 *
 * Shows a tree-like file list with click-to-preview. Files are fetched
 * from the server (R2 manifest), not localStorage.
 */
import { useState, useEffect, useCallback } from "react";
import { File, Folder, ChevronRight, ChevronDown, X, Loader2, RefreshCw, Eye, Upload, Trash2, Plus } from "lucide-react";
import { api } from "../lib/api";
import { timeAgo } from "../lib/time-ago";

interface FileEntry {
  path: string;
  size: number;
  hash: string;
  updated_at: string;
}

interface FileBrowserProps {
  agentName: string;
  open: boolean;
  onClose: () => void;
}

const EXT_LANGS: Record<string, string> = {
  ts: "TypeScript", tsx: "React TSX", js: "JavaScript", jsx: "React JSX",
  py: "Python", json: "JSON", html: "HTML", css: "CSS", md: "Markdown",
  sql: "SQL", sh: "Shell", yaml: "YAML", yml: "YAML", txt: "Text",
  csv: "CSV", xml: "XML", toml: "TOML", env: "Env",
};

function fileIcon(path: string) {
  const ext = path.split(".").pop()?.toLowerCase() || "";
  if (["ts", "tsx", "js", "jsx"].includes(ext)) return <File size={14} className="text-blue-400" />;
  if (["py"].includes(ext)) return <File size={14} className="text-green-400" />;
  if (["json", "yaml", "yml", "toml"].includes(ext)) return <File size={14} className="text-amber-400" />;
  if (["html", "css"].includes(ext)) return <File size={14} className="text-orange-400" />;
  if (["md", "txt"].includes(ext)) return <File size={14} className="text-text-muted" />;
  return <File size={14} className="text-text-muted" />;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function FileBrowser({ agentName, open, onClose }: FileBrowserProps) {
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());

  const fetchFiles = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.get<{ files: FileEntry[] }>(`/workspace/files?agent_name=${encodeURIComponent(agentName)}`);
      setFiles(data.files || []);
      // Auto-expand top-level dirs
      const dirs = new Set<string>();
      for (const f of (data.files || [])) {
        const parts = f.path.replace(/^\/workspace\//, "").split("/");
        if (parts.length > 1) dirs.add(parts[0]);
      }
      setExpandedDirs(dirs);
    } catch {
      setFiles([]);
    } finally {
      setLoading(false);
    }
  }, [agentName]);

  useEffect(() => {
    if (open) fetchFiles();
  }, [open, fetchFiles]);

  const openFile = useCallback(async (path: string) => {
    setSelectedFile(path);
    setFileContent(null);
    setFileLoading(true);
    try {
      const data = await api.get<{ content: string }>(`/workspace/files/read?agent_name=${encodeURIComponent(agentName)}&path=${encodeURIComponent(path)}`);
      setFileContent(data.content);
    } catch {
      setFileContent("Error: Could not load file");
    } finally {
      setFileLoading(false);
    }
  }, [agentName]);

  const toggleDir = (dir: string) => {
    setExpandedDirs(prev => {
      const next = new Set(prev);
      if (next.has(dir)) next.delete(dir); else next.add(dir);
      return next;
    });
  };

  // Phase 8.2: File upload handler
  const handleUpload = async () => {
    const input = document.createElement("input");
    input.type = "file";
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      if (file.size > 10_000_000) {
        alert("File too large (max 10MB)");
        return;
      }
      try {
        const content = await file.text();
        await api.post("/workspace/files/create", {
          agent_name: agentName,
          path: file.name,
          content,
        });
        fetchFiles(); // Refresh file list
      } catch (err: any) {
        alert(`Upload failed: ${err?.message || "Unknown error"}`);
      }
    };
    input.click();
  };

  // Phase 8.2: File delete handler
  const handleDelete = async (path: string) => {
    if (!confirm(`Delete ${path}?`)) return;
    try {
      await api.del(`/workspace/files?agent_name=${encodeURIComponent(agentName)}&path=${encodeURIComponent(path)}`);
      if (selectedFile === path) { setSelectedFile(null); setFileContent(null); }
      fetchFiles();
    } catch (err: any) {
      alert(`Delete failed: ${err?.message || "Unknown error"}`);
    }
  };

  if (!open) return null;

  // Build directory tree
  const tree = new Map<string, FileEntry[]>();
  const rootFiles: FileEntry[] = [];
  for (const f of files) {
    const rel = f.path.replace(/^\/workspace\//, "");
    const slashIdx = rel.indexOf("/");
    if (slashIdx === -1) {
      rootFiles.push(f);
    } else {
      const dir = rel.slice(0, slashIdx);
      if (!tree.has(dir)) tree.set(dir, []);
      tree.get(dir)!.push(f);
    }
  }

  const ext = selectedFile?.split(".").pop()?.toLowerCase() || "";
  const lang = EXT_LANGS[ext] || ext;

  return (
    <div className="flex flex-col h-full border-l border-border bg-surface">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <div className="flex items-center gap-2">
          <Folder size={14} className="text-primary" />
          <span className="text-sm font-semibold text-text">Files</span>
          <span className="text-[10px] text-text-muted">{files.length} files</span>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={handleUpload} className="p-1 rounded hover:bg-surface-alt transition-colors" title="Upload file">
            <Upload size={12} className="text-primary" />
          </button>
          <button onClick={fetchFiles} className="p-1 rounded hover:bg-surface-alt transition-colors" title="Refresh">
            <RefreshCw size={12} className="text-text-muted" />
          </button>
          <button onClick={onClose} className="p-1 rounded hover:bg-surface-alt transition-colors">
            <X size={14} className="text-text-muted" />
          </button>
        </div>
      </div>

      <div className="flex flex-1 min-h-0">
        {/* File tree */}
        <div className="w-56 border-r border-border overflow-y-auto py-1">
          {loading && (
            <div className="flex items-center justify-center py-8">
              <Loader2 size={16} className="animate-spin text-text-muted" />
            </div>
          )}

          {!loading && files.length === 0 && (
            <p className="text-xs text-text-muted text-center py-8 px-3">No files in workspace yet. Files appear here after the agent creates them.</p>
          )}

          {/* Directories */}
          {[...tree.entries()].map(([dir, dirFiles]) => (
            <div key={dir}>
              <button
                onClick={() => toggleDir(dir)}
                className="w-full flex items-center gap-1.5 px-2 py-1 text-xs text-text-secondary hover:bg-surface-alt transition-colors"
              >
                {expandedDirs.has(dir) ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                <Folder size={12} className="text-text-muted" />
                <span className="truncate">{dir}</span>
                <span className="text-[9px] text-text-muted ml-auto">{dirFiles.length}</span>
              </button>
              {expandedDirs.has(dir) && dirFiles.map(f => {
                const name = f.path.replace(/^\/workspace\//, "").split("/").slice(1).join("/");
                return (
                  <button
                    key={f.path}
                    onClick={() => openFile(f.path)}
                    className={`w-full flex items-center gap-1.5 pl-7 pr-2 py-1 text-xs transition-colors ${
                      selectedFile === f.path ? "bg-primary/10 text-primary" : "text-text-secondary hover:bg-surface-alt"
                    }`}
                  >
                    {fileIcon(f.path)}
                    <span className="truncate">{name}</span>
                  </button>
                );
              })}
            </div>
          ))}

          {/* Root-level files */}
          {rootFiles.map(f => {
            const name = f.path.replace(/^\/workspace\//, "");
            return (
              <button
                key={f.path}
                onClick={() => openFile(f.path)}
                className={`w-full flex items-center gap-1.5 px-2 py-1 text-xs transition-colors ${
                  selectedFile === f.path ? "bg-primary/10 text-primary" : "text-text-secondary hover:bg-surface-alt"
                }`}
              >
                {fileIcon(f.path)}
                <span className="truncate">{name}</span>
              </button>
            );
          })}
        </div>

        {/* File preview */}
        <div className="flex-1 min-w-0 flex flex-col">
          {!selectedFile && (
            <div className="flex items-center justify-center h-full text-xs text-text-muted">
              <div className="text-center">
                <Eye size={20} className="mx-auto mb-2 opacity-50" />
                <p>Select a file to preview</p>
              </div>
            </div>
          )}

          {selectedFile && (
            <>
              <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border text-xs">
                {fileIcon(selectedFile)}
                <span className="font-medium text-text truncate">{selectedFile.replace(/^\/workspace\//, "")}</span>
                {lang && <span className="text-text-muted">{lang}</span>}
                {files.find(f => f.path === selectedFile)?.size != null && (
                  <span className="text-text-muted ml-auto">{formatSize(files.find(f => f.path === selectedFile)!.size)}</span>
                )}
                {files.find(f => f.path === selectedFile)?.updated_at && (
                  <span className="text-text-muted">{timeAgo(files.find(f => f.path === selectedFile)!.updated_at)}</span>
                )}
              </div>
              <div className="flex-1 overflow-auto bg-[#1e1e2e]">
                {fileLoading && (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 size={16} className="animate-spin text-[#8b949e]" />
                  </div>
                )}
                {!fileLoading && fileContent !== null && (
                  <pre className="px-3 py-2 text-[#cdd6f4] text-[11px] font-mono leading-relaxed whitespace-pre-wrap break-words">
                    {fileContent}
                  </pre>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
