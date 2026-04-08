/**
 * WorkspaceFiles -- File browser panel built from in-session file_change events.
 *
 * Shows a tree view of all files created/edited during the current session,
 * with NEW/EDIT badges, language labels, and file sizes.
 * Clicking a file calls onOpenFile to switch to the preview tab.
 */
import { useMemo, useState } from "react";
import { File, Folder, ChevronRight, ChevronDown, FolderOpen } from "lucide-react";
import type { ChatMessage, FileChange } from "../lib/use-agent-stream";

interface WorkspaceFilesProps {
  messages: ChatMessage[];
  onOpenFile: (path: string) => void;
}

const EXT_LANGS: Record<string, string> = {
  ts: "TypeScript", tsx: "React TSX", js: "JavaScript", jsx: "React JSX",
  py: "Python", json: "JSON", html: "HTML", css: "CSS", md: "Markdown",
  sql: "SQL", sh: "Shell", yaml: "YAML", yml: "YAML", txt: "Text",
  csv: "CSV", xml: "XML", toml: "TOML", env: "Env",
  go: "Go", rs: "Rust", java: "Java", rb: "Ruby", swift: "Swift",
};

const EXT_COLORS: Record<string, string> = {
  ts: "text-blue-400", tsx: "text-blue-400", js: "text-yellow-400", jsx: "text-yellow-400",
  py: "text-green-400", html: "text-orange-400", css: "text-blue-300",
  json: "text-amber-400", yaml: "text-amber-400", yml: "text-amber-400",
  md: "text-text-muted", sql: "text-purple-400", sh: "text-text-muted",
  go: "text-cyan-400", rs: "text-orange-400", java: "text-red-400",
};

function formatSize(bytes: number | undefined): string {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

interface FileNode {
  path: string;
  name: string;
  change: FileChange;
  /** Most recent change type for this path */
  changeType: "create" | "edit";
}

interface DirNode {
  name: string;
  files: FileNode[];
}

export function WorkspaceFiles({ messages, onOpenFile }: WorkspaceFilesProps) {
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set(["__all__"]));

  // Collect all file changes, deduplicating by path (latest wins)
  const fileMap = useMemo(() => {
    const map = new Map<string, { change: FileChange; changeType: "create" | "edit" }>();
    for (const msg of messages) {
      if (msg.role === "file_change" && msg.fileChange) {
        const fc = msg.fileChange;
        const existing = map.get(fc.path);
        map.set(fc.path, {
          change: fc,
          // If it was ever created in this session, mark as NEW; subsequent edits keep EDIT
          changeType: existing ? "edit" : fc.changeType,
        });
      }
    }
    return map;
  }, [messages]);

  // Build tree structure
  const { dirs, rootFiles } = useMemo(() => {
    const dirMap = new Map<string, FileNode[]>();
    const root: FileNode[] = [];

    for (const [path, { change, changeType }] of fileMap) {
      const parts = path.replace(/^\/workspace\//, "").split("/");
      const name = parts[parts.length - 1];
      const node: FileNode = { path, name, change, changeType };

      if (parts.length === 1) {
        root.push(node);
      } else {
        const dir = parts.slice(0, -1).join("/");
        if (!dirMap.has(dir)) dirMap.set(dir, []);
        dirMap.get(dir)!.push(node);
      }
    }

    const dirs: DirNode[] = [...dirMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, files]) => ({ name, files: files.sort((a, b) => a.name.localeCompare(b.name)) }));

    return { dirs, rootFiles: root.sort((a, b) => a.name.localeCompare(b.name)) };
  }, [fileMap]);

  const toggleDir = (dir: string) => {
    setExpandedDirs(prev => {
      const next = new Set(prev);
      if (next.has(dir)) next.delete(dir); else next.add(dir);
      return next;
    });
  };

  // Auto-expand all dirs on first render
  useMemo(() => {
    const allDirs = new Set(["__all__", ...dirs.map(d => d.name)]);
    setExpandedDirs(allDirs);
  }, [dirs.length]);

  const totalFiles = fileMap.size;

  // Empty state
  if (totalFiles === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-text-muted px-6">
        <FolderOpen size={28} className="mb-3 opacity-40" />
        <p className="text-sm font-medium text-text-secondary mb-1">No files yet</p>
        <p className="text-xs text-center leading-relaxed">
          Files created and edited by the agent will appear here as the conversation progresses.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
        <Folder size={14} className="text-primary" />
        <span className="text-sm font-semibold text-text">Session Files</span>
        <span className="text-[10px] text-text-muted">{totalFiles} file{totalFiles !== 1 ? "s" : ""}</span>
      </div>

      {/* File tree */}
      <div className="flex-1 overflow-y-auto py-1">
        {/* Directories */}
        {dirs.map(dir => (
          <div key={dir.name}>
            <button
              onClick={() => toggleDir(dir.name)}
              className="w-full flex items-center gap-1.5 px-3 py-1.5 text-xs text-text-secondary hover:bg-surface-alt transition-colors"
            >
              {expandedDirs.has(dir.name)
                ? <ChevronDown size={10} className="shrink-0" />
                : <ChevronRight size={10} className="shrink-0" />
              }
              <Folder size={12} className="text-text-muted shrink-0" />
              <span className="truncate font-medium">{dir.name}</span>
              <span className="text-[9px] text-text-muted ml-auto">{dir.files.length}</span>
            </button>
            {expandedDirs.has(dir.name) && dir.files.map(file => (
              <FileRow key={file.path} file={file} indent onClick={() => onOpenFile(file.path)} />
            ))}
          </div>
        ))}

        {/* Root-level files */}
        {rootFiles.map(file => (
          <FileRow key={file.path} file={file} onClick={() => onOpenFile(file.path)} />
        ))}
      </div>
    </div>
  );
}

function FileRow({ file, indent, onClick }: { file: FileNode; indent?: boolean; onClick: () => void }) {
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  const lang = EXT_LANGS[ext] || "";
  const colorClass = EXT_COLORS[ext] || "text-text-muted";
  const isCreate = file.changeType === "create";

  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-1.5 ${indent ? "pl-8" : "pl-3"} pr-3 py-1.5 text-xs text-text-secondary hover:bg-surface-alt transition-colors group`}
    >
      <File size={13} className={`shrink-0 ${colorClass}`} />
      <span className="truncate">{file.name}</span>
      <span className={`shrink-0 px-1 py-0.5 rounded text-[9px] font-semibold leading-none ${
        isCreate
          ? "bg-green-500/10 text-green-500"
          : "bg-amber-500/10 text-amber-500"
      }`}>
        {isCreate ? "NEW" : "EDIT"}
      </span>
      {lang && (
        <span className="text-[9px] text-text-muted shrink-0 hidden group-hover:inline">{lang}</span>
      )}
      {file.change.size != null && (
        <span className="text-[9px] text-text-muted ml-auto shrink-0">{formatSize(file.change.size)}</span>
      )}
    </button>
  );
}
