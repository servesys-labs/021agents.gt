/**
 * ArtifactPreview -- Shows the latest artifact from agent file_change events.
 *
 * - HTML files render in a sandboxed iframe (srcdoc)
 * - Code files render with syntax highlighting (CodeBlock)
 * - Images show inline
 * - Empty state when no artifacts exist yet
 */
import { useMemo } from "react";
import { Eye, FileCode, Globe } from "lucide-react";
import { CodeBlock } from "./CodeBlock";
import type { ChatMessage } from "../lib/use-agent-stream";

interface ArtifactPreviewProps {
  messages: ChatMessage[];
}

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "bmp"]);

function getExtension(path: string): string {
  return (path.split(".").pop() || "").toLowerCase();
}

function getLangFromExt(ext: string): string {
  const map: Record<string, string> = {
    ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx",
    py: "python", rb: "ruby", go: "go", rs: "rust",
    java: "java", swift: "swift", kt: "kotlin",
    css: "css", scss: "scss", html: "html",
    json: "json", yaml: "yaml", yml: "yaml", toml: "toml",
    sql: "sql", sh: "bash", bash: "bash", zsh: "bash",
    md: "markdown", xml: "xml", csv: "text", txt: "text",
    dockerfile: "dockerfile",
  };
  return map[ext] || ext || "text";
}

export function ArtifactPreview({ messages }: ArtifactPreviewProps) {
  // Find the latest file_change message with content
  const latestArtifact = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === "file_change" && msg.fileChange) {
        const fc = msg.fileChange;
        if (fc.content || fc.newText) return fc;
      }
    }
    return null;
  }, [messages]);

  // Empty state
  if (!latestArtifact) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-text-muted px-6">
        <Eye size={28} className="mb-3 opacity-40" />
        <p className="text-sm font-medium text-text-secondary mb-1">No artifacts yet</p>
        <p className="text-xs text-center leading-relaxed">
          Artifacts from the agent will appear here -- HTML previews, code files, and generated images.
        </p>
      </div>
    );
  }

  const ext = getExtension(latestArtifact.path);
  const content = latestArtifact.content || latestArtifact.newText || "";
  const fileName = latestArtifact.path.split("/").pop() || latestArtifact.path;

  // HTML file -- render in sandboxed iframe
  if (ext === "html" || ext === "htm") {
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border text-xs">
          <Globe size={13} className="text-orange-400" />
          <span className="font-medium text-text">{fileName}</span>
          <span className="text-text-muted">Live Preview</span>
        </div>
        <div className="flex-1 min-h-0 bg-white">
          <iframe
            srcDoc={content}
            sandbox="allow-scripts"
            title="HTML Preview"
            className="w-full h-full border-0"
          />
        </div>
      </div>
    );
  }

  // Image file -- show inline
  if (IMAGE_EXTENSIONS.has(ext)) {
    // SVG can be rendered as srcdoc, others need a data URL approach
    if (ext === "svg") {
      return (
        <div className="flex flex-col h-full">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-border text-xs">
            <Eye size={13} className="text-green-400" />
            <span className="font-medium text-text">{fileName}</span>
            <span className="text-text-muted">Image</span>
          </div>
          <div className="flex-1 min-h-0 flex items-center justify-center p-4 bg-surface-alt/30">
            <div dangerouslySetInnerHTML={{ __html: content }} className="max-w-full max-h-full" />
          </div>
        </div>
      );
    }
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border text-xs">
          <Eye size={13} className="text-green-400" />
          <span className="font-medium text-text">{fileName}</span>
          <span className="text-text-muted">Image</span>
        </div>
        <div className="flex-1 min-h-0 flex items-center justify-center p-4 bg-surface-alt/30">
          <p className="text-xs text-text-muted">Binary image preview not available</p>
        </div>
      </div>
    );
  }

  // Code file -- syntax-highlighted view
  const lang = getLangFromExt(ext);
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border text-xs">
        <FileCode size={13} className="text-blue-400" />
        <span className="font-medium text-text">{fileName}</span>
        <span className="text-text-muted capitalize">{lang}</span>
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        <CodeBlock className={`language-${lang}`}>{content}</CodeBlock>
      </div>
    </div>
  );
}
