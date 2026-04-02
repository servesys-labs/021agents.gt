import { useState, useRef, useEffect, useCallback } from "react";
import {
  Send, Square, Brain, Wrench, AlertTriangle, Info, ChevronDown, ChevronRight,
  Clock, Zap, Bot, Copy, Check, RefreshCw, Paperclip,
  X, FileText, FolderOpen, Plus, FolderClosed,
  DollarSign, Layers, ShieldAlert, ShieldOff, Users,
  ThumbsUp, ThumbsDown, Download,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock, MarkdownTable, MarkdownThead, MarkdownTr, MarkdownTh, MarkdownTd } from "./CodeBlock";
import type { ChatMessage, SessionMeta, FileChange } from "../lib/use-agent-stream";
import { useScrollAnchor } from "../lib/use-pretext";

// ── Model name formatter ────────────────────────────────────
function formatModelName(raw: string): string {
  // Strip provider prefix (e.g. "anthropic/claude-3-5-haiku" → "claude-3-5-haiku")
  const base = raw.includes("/") ? raw.split("/").pop()! : raw;
  // Map known model patterns to friendly names
  if (/claude.*opus.*4/i.test(base)) return "Opus 4.6";
  if (/claude.*sonnet.*4/i.test(base)) return "Sonnet 4.6";
  if (/claude.*haiku.*4/i.test(base)) return "Haiku 4.5";
  if (/claude.*opus/i.test(base)) return "Opus";
  if (/claude.*sonnet/i.test(base)) return "Sonnet";
  if (/claude.*haiku/i.test(base)) return "Haiku";
  if (/deepseek.*v3/i.test(base)) return "DeepSeek V3.2";
  if (/deepseek/i.test(base)) return "DeepSeek";
  if (/gpt-4o/i.test(base)) return "GPT-4o";
  if (/gpt-4/i.test(base)) return "GPT-4";
  if (/o[134]-/i.test(base)) return base.split("-")[0].toUpperCase();
  // Fallback: capitalize and clean up
  return base.replace(/^claude-/, "").replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

// ── Legacy type ─────────────────────────────────────────────
interface LegacyMessage { id: string; role: "user" | "assistant"; content: string; timestamp: string; }
export type Message = LegacyMessage;

// ── Props ───────────────────────────────────────────────────

export interface WorkspaceProject {
  name: string;
  lastSync?: string;
  fileCount?: number;
}

interface ChatInterfaceProps {
  messages: ChatMessage[] | Message[];
  onSend: (text: string, attachments?: { url: string; type: string }[]) => void;
  onStop?: () => void;
  onRetry?: (messageId: string) => void;
  loading?: boolean;
  streaming?: boolean;
  sessionMeta?: SessionMeta | null;
  placeholder?: string;
  suggestedPrompts?: string[];
  /** Available workspace projects to load */
  projects?: WorkspaceProject[];
  /** Currently active project name */
  activeProject?: string | null;
  /** Called when user selects a project */
  onSelectProject?: (projectName: string) => void;
  /** Called when user creates a new project */
  onCreateProject?: (projectName: string) => void;
  /** Current plan (basic/standard/premium) */
  activePlan?: string;
  /** Called when user changes the plan mid-session */
  onChangePlan?: (plan: string) => void;
  /** Agent description for empty state */
  agentDescription?: string;
  /** Agent name for empty state */
  agentName?: string;
  /** Number of tools available */
  toolCount?: number;
}

// ── Copy Button ─────────────────────────────────────────────

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };
  return (
    <button onClick={handleCopy} className="p-1 rounded hover:bg-surface-alt transition-colors" title="Copy to clipboard">
      {copied ? <Check size={12} className="text-success" /> : <Copy size={12} className="text-text-muted" />}
    </button>
  );
}

// ── Tool Result Renderer (smart dispatch by tool name) ────

interface BashResult {
  stdout?: string;
  stderr?: string;
  exit_code?: number;
}

function tryParseBashResult(result: string): BashResult | null {
  try {
    const parsed = JSON.parse(result);
    if (typeof parsed === "object" && parsed !== null && ("stdout" in parsed || "stderr" in parsed || "exit_code" in parsed)) {
      return parsed as BashResult;
    }
  } catch {
    // Not JSON — that's fine
  }
  return null;
}

function BashResultView({ result }: { result: BashResult }) {
  return (
    <div className="space-y-1.5">
      {/* Exit code badge */}
      <div className="flex items-center gap-2 mb-1.5">
        <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium ${
          result.exit_code === 0
            ? "bg-[rgba(158,206,106,0.15)] text-[#9ece6a]"
            : "bg-[rgba(247,118,142,0.15)] text-[#f7768e]"
        }`}>
          exit {result.exit_code ?? 0}
        </span>
      </div>
      {/* stdout */}
      {result.stdout && result.stdout.trim() && (
        <pre className="terminal-stdout whitespace-pre-wrap break-words">{result.stdout}</pre>
      )}
      {/* stderr */}
      {result.stderr && result.stderr.trim() && (
        <pre className="terminal-stderr whitespace-pre-wrap break-words">{result.stderr}</pre>
      )}
      {/* Empty output */}
      {!result.stdout?.trim() && !result.stderr?.trim() && (
        <span className="terminal-dim italic">(no output)</span>
      )}
    </div>
  );
}

function ToolResultRenderer({ toolName, result }: { toolName: string; result: string }) {
  const name = toolName.toLowerCase();

  // Bash / python-exec: parse JSON with stdout/stderr/exit_code
  if (name === "bash" || name === "python-exec" || name === "python_exec" || name === "shell" || name === "execute") {
    const parsed = tryParseBashResult(result);
    if (parsed) return <BashResultView result={parsed} />;
  }

  // Memory recall: show as a styled card
  if (name === "memory-recall" || name === "memory_recall" || name === "recall") {
    return (
      <div className="space-y-1">
        <div className="flex items-center gap-1.5 mb-1">
          <span className="terminal-info text-[10px] font-medium">MEMORY</span>
        </div>
        <pre className="terminal-stdout whitespace-pre-wrap break-words leading-relaxed">{result}</pre>
      </div>
    );
  }

  // Web search: try to parse structured results
  if (name === "web-search" || name === "web_search" || name === "search") {
    try {
      const parsed = JSON.parse(result);
      if (Array.isArray(parsed)) {
        return (
          <div className="space-y-2">
            {parsed.slice(0, 8).map((item: { title?: string; url?: string; snippet?: string }, i: number) => (
              <div key={i} className="space-y-0.5">
                {item.title && <div className="terminal-info font-medium">{item.title}</div>}
                {item.url && <div className="terminal-dim text-[10px] break-all">{item.url}</div>}
                {item.snippet && <div className="terminal-stdout text-[10.5px] leading-relaxed">{item.snippet}</div>}
              </div>
            ))}
          </div>
        );
      }
    } catch {
      // Not structured JSON
    }
  }

  // Default: plain text
  return <pre className="terminal-stdout whitespace-pre-wrap break-words">{result}</pre>;
}

// ── Tool Call Card (TUI-inspired) ──────────────────────────

// Claude Code-style action verbs for loading personality
const ACTION_VERBS = [
  "Analyzing", "Processing", "Searching", "Computing", "Fetching",
  "Executing", "Querying", "Scanning", "Resolving", "Building",
  "Rendering", "Compiling", "Parsing", "Evaluating", "Inspecting",
];

function ToolCallCard({ msg, compact }: { msg: ChatMessage; compact?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [verb] = useState(() => ACTION_VERBS[Math.floor(Math.random() * ACTION_VERBS.length)]);
  const isRunning = msg.toolStatus === "running";
  const isError = msg.toolStatus === "error";
  const isDone = msg.toolStatus === "done";
  const toolName = msg.toolName || msg.content || "tool";

  // Live elapsed timer for running tools
  useEffect(() => {
    if (!isRunning) return;
    const start = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [isRunning]);

  // Stall detection: >10s = slow, >30s = stalled
  const stallLevel = elapsed > 30 ? "stalled" : elapsed > 10 ? "slow" : "normal";

  // Friendly tool display names (like Claude's "Searched the web")
  const TOOL_DISPLAY: Record<string, string> = {
    "web-search": "Searched the web", "browse": "Read webpage", "python-exec": "Ran Python",
    "bash": "Ran command", "read-file": "Read file", "write-file": "Created file",
    "edit-file": "Edited file", "memory-save": "Saved to memory", "memory-recall": "Checked memory",
    "execute-code": "Executed code", "swarm": "Ran parallel tasks", "save-project": "Saved project",
    "load-project": "Loaded project",
  };
  const displayName = isRunning
    ? (TOOL_DISPLAY[toolName]?.replace(/^(Searched|Read|Ran|Created|Edited|Saved|Checked|Executed|Loaded)/, (m) =>
        m.endsWith("ed") ? m.slice(0, -2) + "ing" : m.endsWith("d") ? m.slice(0, -1) + "ing" : m + "ing"
      ) || toolName)
    : (TOOL_DISPLAY[toolName] || toolName);

  return (
    <div className="text-xs text-text-muted">
      <button
        onClick={() => !isRunning && setExpanded(!expanded)}
        className="flex items-center gap-2 py-1.5 transition-colors hover:text-text"
      >
        {/* Minimal status — Claude.ai style */}
        {isRunning ? (
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 animate-pulse ${
            stallLevel === "stalled" ? "bg-danger" : stallLevel === "slow" ? "bg-warning" : "bg-text-muted"
          }`} />
        ) : isError ? (
          <span className="text-danger shrink-0">✗</span>
        ) : (
          <span className="text-text-muted shrink-0">✓</span>
        )}

        <span className={isRunning ? "text-text-secondary" : "text-text-muted"}>{displayName}</span>

        {msg.toolArgsPreview && !isRunning && (
          <span className="text-text-muted/60 truncate max-w-[200px]" title={msg.toolArgsPreview}>
            {msg.toolArgsPreview}
          </span>
        )}

        {!isRunning && <ChevronRight size={10} className={`transition-transform ${expanded ? "rotate-90" : ""}`} />}
      </button>

      {/* Expandable output — minimal, only when clicked */}
      <div className="accordion-content" data-open={expanded && !!(msg.toolResult || msg.toolError)}>
        <div>
          {(msg.toolResult || msg.toolError) && (
            <div className="terminal-card ml-4 mt-1 px-3 py-2 max-h-60 overflow-y-auto rounded-lg relative group text-[11px]">
              <div className="code-copy-btn"><CopyButton text={msg.toolError || msg.toolResult || ""} /></div>
              {msg.toolError && <pre className="terminal-stderr whitespace-pre-wrap break-words">{msg.toolError}</pre>}
              {msg.toolResult && <ToolResultRenderer toolName={toolName} result={msg.toolResult} />}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Unified Diff Computation ──────────────────────────────

interface DiffLine {
  type: "context" | "added" | "removed" | "separator";
  oldLineNum?: number;
  newLineNum?: number;
  content: string;
}

/**
 * Compute a unified diff between old and new text.
 * Uses a simple approach: find common prefix/suffix lines, mark the rest as removed/added.
 * Groups changes with context lines and separators for gaps.
 */
function computeUnifiedDiff(oldText: string, newText: string, contextLines = 3): DiffLine[] {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const result: DiffLine[] = [];

  // Find common prefix length
  let prefixLen = 0;
  while (prefixLen < oldLines.length && prefixLen < newLines.length && oldLines[prefixLen] === newLines[prefixLen]) {
    prefixLen++;
  }

  // Find common suffix length (don't overlap with prefix)
  let suffixLen = 0;
  while (
    suffixLen < oldLines.length - prefixLen &&
    suffixLen < newLines.length - prefixLen &&
    oldLines[oldLines.length - 1 - suffixLen] === newLines[newLines.length - 1 - suffixLen]
  ) {
    suffixLen++;
  }

  const oldChangeStart = prefixLen;
  const oldChangeEnd = oldLines.length - suffixLen;
  const newChangeStart = prefixLen;
  const newChangeEnd = newLines.length - suffixLen;

  // If no changes, show nothing
  if (oldChangeStart === oldChangeEnd && newChangeStart === newChangeEnd) {
    return [{ type: "context", content: "(no changes)", oldLineNum: undefined, newLineNum: undefined }];
  }

  // Context before the change
  const contextStart = Math.max(0, oldChangeStart - contextLines);
  if (contextStart > 0) {
    result.push({ type: "separator", content: `@@ -${contextStart + 1},${oldChangeEnd - contextStart + Math.min(suffixLen, contextLines)} +${contextStart + 1},${newChangeEnd - contextStart + Math.min(suffixLen, contextLines)} @@` });
  }

  for (let i = contextStart; i < oldChangeStart; i++) {
    result.push({ type: "context", oldLineNum: i + 1, newLineNum: i + 1, content: oldLines[i] });
  }

  // Removed lines
  for (let i = oldChangeStart; i < oldChangeEnd; i++) {
    result.push({ type: "removed", oldLineNum: i + 1, content: oldLines[i] });
  }

  // Added lines
  let newLineCounter = newChangeStart;
  for (let i = newChangeStart; i < newChangeEnd; i++) {
    result.push({ type: "added", newLineNum: i + 1, content: newLines[i] });
    newLineCounter = i + 1;
  }

  // Context after the change
  const contextEnd = Math.min(oldLines.length, oldChangeEnd + contextLines);
  const suffixStart = oldLines.length - suffixLen;
  for (let i = oldChangeEnd; i < Math.min(contextEnd, oldLines.length); i++) {
    const newIdx = newChangeEnd + (i - oldChangeEnd);
    result.push({ type: "context", oldLineNum: i + 1, newLineNum: newIdx + 1, content: oldLines[i] });
  }

  if (contextEnd < oldLines.length) {
    result.push({ type: "separator", content: `... ${oldLines.length - contextEnd} more lines` });
  }

  return result;
}

// ── File Change Card ───────────────────────────────────────

function FileChangeCard({ change }: { change: FileChange }) {
  const [expanded, setExpanded] = useState(false);
  const fileName = change.path.split("/").pop() || change.path;
  const isCreate = change.changeType === "create";

  // Pre-compute diff for edits
  const diffLines = (!isCreate && change.oldText && change.newText)
    ? computeUnifiedDiff(change.oldText, change.newText)
    : null;

  // Count additions/removals for the summary badge
  const addedCount = diffLines?.filter(l => l.type === "added").length ?? 0;
  const removedCount = diffLines?.filter(l => l.type === "removed").length ?? 0;

  return (
    <div className="border rounded-xl overflow-hidden text-xs border-border/60 bg-surface-alt/20">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-black/[0.02] dark:hover:bg-white/[0.02] transition-colors"
      >
        <FileText size={13} className={isCreate ? "text-green-500" : "text-amber-500"} />
        <span className="font-medium text-text">{fileName}</span>
        <span className="text-text-muted font-normal truncate max-w-[200px]">{change.path}</span>
        <span className={`ml-1 px-1.5 py-0.5 rounded text-[10px] font-medium ${
          isCreate ? "bg-green-500/10 text-green-500" : "bg-amber-500/10 text-amber-500"
        }`}>
          {isCreate ? "NEW" : "EDIT"}
        </span>
        {!isCreate && diffLines && (
          <span className="flex items-center gap-1.5 text-[10px] ml-1">
            {addedCount > 0 && <span className="text-[#9ece6a]">+{addedCount}</span>}
            {removedCount > 0 && <span className="text-[#f7768e]">-{removedCount}</span>}
          </span>
        )}
        {change.language && <span className="text-text-muted text-[10px]">{change.language}</span>}
        {change.size != null && <span className="text-text-muted text-[10px] ml-auto">{change.size > 1024 ? `${(change.size / 1024).toFixed(1)}KB` : `${change.size}B`}</span>}
        {expanded ? <ChevronDown size={11} className="text-text-muted" /> : <ChevronRight size={11} className="text-text-muted" />}
      </button>
      {/* Smooth accordion + terminal card */}
      <div className="accordion-content" data-open={expanded}>
        <div>
          <div className="terminal-card border-t border-white/5 max-h-80 overflow-y-auto relative">
            <div className="code-copy-btn"><CopyButton text={isCreate ? (change.content || "") : (change.newText || "")} /></div>
            {isCreate && change.content && (
              <pre className="px-3 py-2.5 terminal-stdout whitespace-pre-wrap break-words">
                {change.content}
              </pre>
            )}
            {!isCreate && diffLines && (
              <div className="py-1.5">
                <div className="diff-header text-[10px] px-3 mb-0.5">--- a/{change.path}</div>
                <div className="diff-header text-[10px] px-3 mb-1">+++ b/{change.path}</div>
                {diffLines.map((line, i) => {
                  if (line.type === "separator") {
                    return (
                      <div key={i} className="diff-header text-[10px] px-3 py-0.5 select-none">
                        {line.content}
                      </div>
                    );
                  }
                  const gutterOld = line.oldLineNum != null ? String(line.oldLineNum) : "";
                  const gutterNew = line.newLineNum != null ? String(line.newLineNum) : "";
                  const prefix = line.type === "added" ? "+" : line.type === "removed" ? "-" : " ";
                  const lineClass = line.type === "added" ? "diff-added" : line.type === "removed" ? "diff-removed" : "";

                  return (
                    <div key={i} className={`flex ${lineClass}`}>
                      <span className="diff-gutter shrink-0 w-[3.5ch] text-right pr-1 select-none">{gutterOld}</span>
                      <span className="diff-gutter shrink-0 w-[3.5ch] text-right pr-1 select-none">{gutterNew}</span>
                      <span className="shrink-0 w-[2ch] text-center select-none">{prefix}</span>
                      <span className="flex-1 whitespace-pre-wrap break-words pr-3">{line.content}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Thinking Block (TUI-inspired) ──────────────────────────

function ThinkingBlock({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);
  const preview = content.length > 120 ? content.slice(0, 120) + "..." : content;

  return (
    <div className="flex justify-start animate-[fadeInUp_150ms_ease-out]">
      <div className="max-w-[85%]">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1.5 text-xs font-medium text-purple-600 dark:text-purple-400 hover:text-purple-800 dark:hover:text-purple-300 transition-colors"
        >
          <span className="text-purple-400 dark:text-purple-500">∴</span>
          <span>Thinking</span>
          {expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
          {!expanded && <span className="text-[10px] text-text-muted font-normal ml-1">(click to expand)</span>}
        </button>
        {/* Smooth accordion */}
        <div className="accordion-content" data-open={expanded}>
          <div>
            <div className="mt-1 px-3 py-2.5 rounded-lg border border-purple-200/60 dark:border-purple-800/40 bg-purple-50/30 dark:bg-purple-950/20 text-xs leading-relaxed text-purple-800 dark:text-purple-300 relative group">
              <div className="code-copy-btn"><CopyButton text={content} /></div>
              <pre className="whitespace-pre-wrap break-words">{content}</pre>
            </div>
          </div>
        </div>
        {!expanded && (
          <p className="px-3 py-0.5 text-[11px] text-purple-400/60 dark:text-purple-500/60 italic truncate max-w-lg">
            {preview}
          </p>
        )}
      </div>
    </div>
  );
}

// ── Session Summary ─────────────────────────────────────────

function SessionSummary({ meta }: { meta: SessionMeta }) {
  return (
    <div className="flex items-center justify-center gap-4 text-xs text-text-muted py-2 border-t border-border/50">
      <span className="flex items-center gap-1"><Zap size={10} /> {meta.total_turns} turns</span>
      <span>{meta.total_tool_calls} tool calls</span>
      <span>${meta.total_cost_usd.toFixed(4)}</span>
      <span>{meta.latency_ms < 1000 ? `${meta.latency_ms}ms` : `${(meta.latency_ms / 1000).toFixed(1)}s`}</span>
    </div>
  );
}

// ── Message Actions (hover bar) ─────────────────────────────

function MessageActions({ msg, onRetry }: { msg: ChatMessage; onRetry?: (id: string) => void }) {
  const [feedback, setFeedback] = useState<"up" | "down" | null>(null);

  return (
    <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity mt-1 px-1">
      <CopyButton text={msg.content} />
      {onRetry && msg.role === "assistant" && (
        <button
          onClick={() => onRetry(msg.id)}
          className="p-1 rounded hover:bg-surface-alt transition-colors"
          title="Retry this response"
        >
          <RefreshCw size={12} className="text-text-muted" />
        </button>
      )}
      {/* Thumbs up/down feedback */}
      {msg.role === "assistant" && (
        <>
          <button
            onClick={() => setFeedback(f => f === "up" ? null : "up")}
            className={`p-1 rounded transition-colors ${feedback === "up" ? "bg-success-light text-success" : "hover:bg-surface-alt text-text-muted"}`}
            title="Good response"
          >
            <ThumbsUp size={11} />
          </button>
          <button
            onClick={() => setFeedback(f => f === "down" ? null : "down")}
            className={`p-1 rounded transition-colors ${feedback === "down" ? "bg-danger-light text-danger" : "hover:bg-surface-alt text-text-muted"}`}
            title="Poor response"
          >
            <ThumbsDown size={11} />
          </button>
        </>
      )}
    </div>
  );
}

// ── Slash Command Palette ──────────────────────────────────

const SLASH_COMMANDS = [
  { name: "batch", description: "Decompose & execute tasks in parallel", icon: "⚡" },
  { name: "review", description: "Three-lens code review (reuse, quality, efficiency)", icon: "🔍" },
  { name: "debug", description: "Diagnose agent issues & errors", icon: "🔧" },
  { name: "verify", description: "Run tests to verify a change works", icon: "✅" },
  { name: "remember", description: "Curate agent memory (dedup, promote, clean)", icon: "🧠" },
  { name: "skillify", description: "Extract a process into a reusable skill", icon: "📝" },
  { name: "schedule", description: "Create a recurring agent task", icon: "📅" },
  { name: "docs", description: "Load relevant documentation for context", icon: "📚" },
];

function SlashCommandPalette({ query, onSelect, visible }: {
  query: string;
  onSelect: (cmd: string) => void;
  visible: boolean;
}) {
  if (!visible) return null;

  const filtered = query
    ? SLASH_COMMANDS.filter(c => c.name.includes(query.toLowerCase()))
    : SLASH_COMMANDS;

  if (filtered.length === 0) return null;

  return (
    <div className="absolute bottom-full left-0 right-0 mb-1 mx-4 bg-surface border border-border rounded-xl shadow-lg overflow-hidden z-20 animate-[fadeInUp_100ms_ease-out]">
      <div className="px-3 py-1.5 border-b border-border/50">
        <span className="text-[10px] font-medium text-text-muted uppercase tracking-wide">Skills</span>
      </div>
      <div className="max-h-64 overflow-y-auto">
        {filtered.map(cmd => (
          <button
            key={cmd.name}
            onClick={() => onSelect(cmd.name)}
            className="w-full flex items-center gap-3 px-3 py-2 hover:bg-surface-alt transition-colors text-left"
          >
            <span className="text-base">{cmd.icon}</span>
            <div className="flex-1 min-w-0">
              <span className="text-sm font-medium text-text">/{cmd.name}</span>
              <span className="text-xs text-text-muted ml-2">{cmd.description}</span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Export Conversation ─────────────────────────────────────

function exportAsMarkdown(messages: ChatMessage[]): string {
  const lines: string[] = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      lines.push(`## User\n\n${msg.content}\n`);
    } else if (msg.role === "assistant") {
      lines.push(`## Assistant\n\n${msg.content}\n`);
    } else if (msg.role === "tool") {
      lines.push(`> **Tool: ${msg.toolName}** (${msg.toolStatus})\n> ${(msg.toolResult || msg.toolError || "").slice(0, 200)}\n`);
    }
  }
  return lines.join("\n---\n\n");
}

// ── Markdown prose classes ──────────────────────────────────

const PROSE_CLASSES = `prose prose-sm prose-neutral dark:prose-invert max-w-none
  [&>*:first-child]:mt-0 [&>*:last-child]:mb-0
  [&_p]:my-2 [&_p]:leading-relaxed
  [&_h1]:text-base [&_h1]:font-bold [&_h1]:mt-4 [&_h1]:mb-2
  [&_h2]:text-[15px] [&_h2]:font-bold [&_h2]:mt-4 [&_h2]:mb-2
  [&_h3]:text-sm [&_h3]:font-semibold [&_h3]:mt-3 [&_h3]:mb-1
  [&_ul]:my-2 [&_ul]:pl-5 [&_ul]:space-y-1 [&_ul]:list-disc
  [&_ol]:my-2 [&_ol]:pl-5 [&_ol]:space-y-1 [&_ol]:list-decimal
  [&_li]:leading-relaxed [&_li]:pl-1
  [&_pre]:my-0 [&_pre]:p-0 [&_pre]:bg-transparent
  [&_code]:font-mono
  [&_blockquote]:border-l-2 [&_blockquote]:border-primary/30 [&_blockquote]:pl-3 [&_blockquote]:my-3 [&_blockquote]:text-text-secondary [&_blockquote]:italic
  [&_hr]:my-4 [&_hr]:border-border
  [&_table]:my-0
  [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2 [&_a]:decoration-primary/30 hover:[&_a]:decoration-primary
  [&_strong]:font-semibold [&_strong]:text-text
  [&_em]:italic
  [&_img]:rounded-lg [&_img]:my-3 [&_img]:max-h-80 [&_img]:object-contain
`;

// ── Main Component ──────────────────────────────────────────

export function ChatInterface({
  messages, onSend, onStop, onRetry, loading, streaming, sessionMeta, placeholder, suggestedPrompts,
  projects, activeProject, onSelectProject, onCreateProject, activePlan, onChangePlan,
  agentDescription, agentName, toolCount,
}: ChatInterfaceProps) {
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<{ url: string; type: string; name: string }[]>([]);
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [plusMenuOpen, setPlusMenuOpen] = useState(false);
  const [slashPaletteVisible, setSlashPaletteVisible] = useState(false);
  const [slashQuery, setSlashQuery] = useState("");
  const [newProjectName, setNewProjectName] = useState("");
  const [showNewProjectInput, setShowNewProjectInput] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const projectPickerRef = useRef<HTMLDivElement>(null);
  const plusMenuRef = useRef<HTMLDivElement>(null);
  const isActive = loading || streaming;

  // Track container width for scroll anchoring on resize (e.g. meta panel open/close)
  const [containerWidth, setContainerWidth] = useState(0);
  useEffect(() => {
    const el = scrollAreaRef.current;
    if (!el) return;
    const obs = new ResizeObserver(([entry]) => setContainerWidth(entry.contentRect.width));
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // Pretext-powered scroll anchor — preserves position when width changes
  useScrollAnchor(scrollAreaRef, containerWidth, messages.length);

  // Close popovers on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (projectPickerRef.current && !projectPickerRef.current.contains(e.target as Node)) {
        setProjectPickerOpen(false);
        setShowNewProjectInput(false);
      }
      if (plusMenuRef.current && !plusMenuRef.current.contains(e.target as Node)) {
        setPlusMenuOpen(false);
      }
    };
    if (projectPickerOpen || plusMenuOpen) document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [projectPickerOpen, plusMenuOpen]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isActive]);

  // ── Keyboard shortcuts ──
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isMod = e.metaKey || e.ctrlKey;
      // Cmd+/ → Focus textarea (start typing)
      if (isMod && e.key === "/") {
        e.preventDefault();
        textareaRef.current?.focus();
      }
      // Escape → Close slash palette or stop generation
      if (e.key === "Escape") {
        if (slashPaletteVisible) setSlashPaletteVisible(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [slashPaletteVisible]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if ((!text && attachments.length === 0) || isActive) return;
    setInput("");
    const atts = attachments.length > 0 ? attachments.map(a => ({ url: a.url, type: a.type })) : undefined;
    attachments.forEach(a => URL.revokeObjectURL(a.url));
    setAttachments([]);
    onSend(text || "Analyze this file", atts);
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  // Clipboard paste handler for images (Cmd+V / Ctrl+V)
  const handlePaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of Array.from(items)) {
      if (item.type.startsWith("image/")) {
        e.preventDefault();
        const file = item.getAsFile();
        if (!file) continue;
        const url = URL.createObjectURL(file);
        setAttachments(prev => [...prev, { url, type: file.type, name: file.name || "pasted-image.png" }]);
      }
    }
  };

  // Drag-and-drop handler
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const files = e.dataTransfer?.files;
    if (!files) return;
    for (const file of Array.from(files)) {
      const url = URL.createObjectURL(file);
      setAttachments(prev => [...prev, { url, type: file.type, name: file.name }]);
    }
  };

  const handleInput = () => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = Math.min(el.scrollHeight, 160) + "px";
    }
  };

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    Array.from(files).forEach(file => {
      const url = URL.createObjectURL(file);
      setAttachments(prev => [...prev, { url, type: file.type, name: file.name }]);
    });
    e.target.value = "";
  }, []);

  const removeAttachment = (index: number) => {
    setAttachments(prev => prev.filter((_, i) => i !== index));
  };

  return (
    <div className="flex flex-col h-full">
      {/* Messages */}
      <div ref={scrollAreaRef} className="flex-1 overflow-y-auto px-4 py-6 space-y-4">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 px-4 max-w-xl mx-auto">
            {/* Agent identity */}
            <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center mb-4 border border-primary/10">
              <Bot size={28} className="text-primary" />
            </div>
            {agentName && (
              <h2 className="text-base font-semibold text-text mb-1">{agentName}</h2>
            )}
            {agentDescription ? (
              <p className="text-sm text-text-secondary mb-1 text-center leading-relaxed max-w-md">{agentDescription}</p>
            ) : (
              <p className="text-sm text-text-secondary mb-1">What can I help you with?</p>
            )}
            {toolCount != null && toolCount > 0 && (
              <p className="text-[11px] text-text-muted mb-6 flex items-center gap-1">
                <Wrench size={10} /> {toolCount} tools available
              </p>
            )}
            {!agentDescription && !toolCount && <div className="mb-6" />}

            {/* Suggested prompts — larger, more discoverable */}
            {suggestedPrompts && suggestedPrompts.length > 0 && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 w-full">
                {suggestedPrompts.map((prompt, i) => (
                  <button
                    key={i}
                    onClick={() => onSend(prompt)}
                    className="px-4 py-3 text-sm text-text-secondary bg-surface border border-border rounded-xl hover:border-primary/30 hover:bg-surface-alt hover:text-text transition-all text-left leading-relaxed group"
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {(() => {
          // Pre-compute parallel tool groups for P1b
          const typedMessages = messages as ChatMessage[];
          const renderedGroupIds = new Set<string>();

          return typedMessages.map((msg, idx) => {
          // User message
          if (msg.role === "user") {
            return (
              <div key={msg.id} className="flex justify-end animate-[fadeInUp_200ms_ease-out] group">
                <div className="max-w-[80%]">
                  <div className="px-4 py-2.5 rounded-2xl rounded-br-md text-sm leading-relaxed bg-primary text-white">
                    {msg.content}
                  </div>
                  <div className="flex justify-end">
                    <MessageActions msg={msg} />
                  </div>
                </div>
              </div>
            );
          }

          // Thinking
          if (msg.role === "thinking") return <ThinkingBlock key={msg.id} content={msg.content} />;

          // Tool call — with parallel grouping
          if (msg.role === "tool") {
            // Skip if already rendered as part of a group
            if (renderedGroupIds.has(msg.id)) return null;

            // Collect consecutive tool messages with the same toolTurn
            const hasTurn = msg.toolTurn != null;
            const groupMessages: ChatMessage[] = [msg];

            if (hasTurn) {
              for (let j = idx + 1; j < typedMessages.length; j++) {
                const next = typedMessages[j];
                if (next.role === "tool" && next.toolTurn === msg.toolTurn) {
                  groupMessages.push(next);
                  renderedGroupIds.add(next.id);
                } else {
                  break;
                }
              }
            }

            // Single tool — render normally
            if (groupMessages.length === 1) {
              return (
                <div key={msg.id} className="animate-[fadeInUp_150ms_ease-out]">
                  <div className="w-full">
                    <ToolCallCard msg={msg} />
                  </div>
                </div>
              );
            }

            // Parallel group — render with shared container
            const allDone = groupMessages.every(m => m.toolStatus === "done" || m.toolStatus === "error");
            const anyError = groupMessages.some(m => m.toolStatus === "error");
            const runningCount = groupMessages.filter(m => m.toolStatus === "running").length;

            return (
              <div key={`group-${msg.id}`} className="animate-[fadeInUp_150ms_ease-out]">
                <div className={`w-full border rounded-xl overflow-hidden transition-all duration-200 ${
                  anyError ? "border-danger/30 bg-danger/[0.02]" :
                  !allDone ? "border-primary/20 bg-primary/[0.02]" :
                  "border-border/50 bg-surface-alt/20"
                }`}>
                  {/* Group header */}
                  <div className="flex items-center gap-2 px-3 py-2 border-b border-border/30">
                    {!allDone ? (
                      <span className="w-2 h-2 rounded-full bg-primary status-dot-pulse shrink-0" />
                    ) : anyError ? (
                      <span className="text-danger text-xs shrink-0">!</span>
                    ) : (
                      <Layers size={12} className="text-text-muted shrink-0" />
                    )}
                    <span className="text-[11px] font-medium text-text-secondary">
                      {!allDone
                        ? `Running ${groupMessages.length} tools in parallel${runningCount > 0 ? ` (${runningCount} active)` : ""}`
                        : `${groupMessages.length} tools ran in parallel`}
                    </span>
                    {allDone && (
                      <span className="ml-auto text-[10px] text-text-muted">
                        {anyError ? "completed with errors" : "all succeeded"}
                      </span>
                    )}
                  </div>
                  {/* Individual tool cards inside */}
                  <div className="space-y-0 divide-y divide-border/20">
                    {groupMessages.map(gMsg => (
                      <div key={gMsg.id} className="px-0">
                        <ToolCallCard msg={gMsg} compact />
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            );
          }

          // File change (write-file / edit-file)
          if (msg.role === "file_change" && msg.fileChange) {
            return (
              <div key={msg.id} className="animate-[fadeInUp_150ms_ease-out]">
                <div className="w-full">
                  <FileChangeCard change={msg.fileChange} />
                </div>
              </div>
            );
          }

          // System/warning/reasoning — with Phase-specific categorization
          if (msg.role === "system") {
            const content = msg.content || "";
            const isWarning = content.startsWith("Warning:");
            const isBudget = content.includes("Budget guard") || content.includes("budget");
            const isLoop = content.includes("Loop detected") || content.includes("loop");
            const isCompression = content.includes("compressed") || content.includes("Context");
            const isRefusal = content.includes("usage policies") || content.includes("declined");
            const isRepair = content.includes("repair") || content.includes("interrupted");
            const isCircuitBreaker = content.includes("Circuit breaker") || content.includes("circuit");
            const isSessionLimit = content.includes("Session limit") || content.includes("concurrent");

            // Category-specific styling
            let bgClass = "bg-surface-alt text-text-muted";
            let IconComp = Info;
            if (isBudget) { bgClass = "bg-danger-light text-danger-dark border border-danger/30"; IconComp = DollarSign; }
            else if (isLoop) { bgClass = "bg-warning-light text-warning-dark border border-warning"; IconComp = RefreshCw; }
            else if (isCompression) { bgClass = "bg-info-light text-info-dark border border-info/30"; IconComp = Layers; }
            else if (isRefusal) { bgClass = "bg-danger-light text-danger-dark border border-danger/30"; IconComp = ShieldAlert; }
            else if (isRepair) { bgClass = "bg-violet-50 text-violet-700 dark:bg-violet-900/20 dark:text-violet-300 border border-violet-200 dark:border-violet-800"; IconComp = Wrench; }
            else if (isCircuitBreaker) { bgClass = "bg-orange-50 text-orange-700 dark:bg-orange-900/20 dark:text-orange-300 border border-orange-200 dark:border-orange-800"; IconComp = ShieldOff; }
            else if (isSessionLimit) { bgClass = "bg-warning-light text-warning-dark border border-warning"; IconComp = Users; }
            else if (isWarning) { bgClass = "bg-warning-light text-warning-dark border border-warning"; IconComp = AlertTriangle; }
            else if (msg.strategy) { bgClass = "bg-info-light text-info-dark border border-info"; IconComp = Brain; }

            return (
              <div key={msg.id} className="flex justify-center animate-[fadeInUp_150ms_ease-out]">
                <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs max-w-[80%] ${bgClass}`}>
                  <IconComp size={10} className="shrink-0" />
                  <span className="truncate">{content}</span>
                </div>
              </div>
            );
          }

          // Error
          if (msg.role === "error") {
            return (
              <div key={msg.id} className="flex justify-start animate-[fadeInUp_150ms_ease-out]">
                <div className="px-4 py-2.5 rounded-2xl rounded-bl-md text-sm leading-relaxed bg-danger-light text-danger border border-danger/30">
                  {msg.content}
                </div>
              </div>
            );
          }

          // Assistant message — clean, no box, content flows directly
          const isLastMsg = idx === messages.length - 1;
          const isStreaming = isLastMsg && streaming && msg.role === "assistant";
          return (
            <div key={msg.id} className="animate-[fadeInUp_200ms_ease-out] group">
              <div className="min-w-0">
                <div className={`text-sm leading-relaxed text-text ${PROSE_CLASSES} ${isStreaming ? "streaming-cursor" : ""}`}>
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      code: ({ className, children, ...props }) => {
                        const isInline = !className;
                        return <CodeBlock className={className} inline={isInline} {...props}>{children}</CodeBlock>;
                      },
                      pre: ({ children }) => <>{children}</>,
                      table: MarkdownTable,
                      thead: MarkdownThead,
                      tr: MarkdownTr,
                      th: MarkdownTh,
                      td: MarkdownTd,
                    }}
                  >{msg.content}</ReactMarkdown>
                </div>
                <div className="flex items-center gap-2 mt-2 opacity-0 group-hover:opacity-100 transition-opacity">
                  <MessageActions msg={msg} onRetry={onRetry} />
                  {msg.turnInfo && (
                    <span className="text-[10px] text-text-muted ml-auto flex items-center gap-2">
                      <span className="px-1.5 py-0.5 rounded-full bg-surface-alt border border-border/40 font-medium">{formatModelName(msg.turnInfo.model)}</span>
                      <span>${msg.turnInfo.cost_usd.toFixed(4)}</span>
                    </span>
                  )}
                </div>
              </div>
            </div>
          );
        });
        })()}

        {/* Streaming indicator — Claude Code shimmer style */}
        {(streaming || loading) && (
          <div className="flex items-center gap-2.5 text-xs px-1 py-1.5">
            <span className="w-2 h-2 rounded-full bg-primary status-dot-pulse" />
            <span className="shimmer-text font-medium">
              {ACTION_VERBS[Math.floor(Date.now() / 3000) % ACTION_VERBS.length]}...
            </span>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Session summary */}
      {sessionMeta && <SessionSummary meta={sessionMeta} />}

      {/* Composer — seamless with chat area */}
      <div className="px-4 pb-2 pt-0 relative">
        {/* Slash command palette (positioned above input) */}
        <SlashCommandPalette
          query={slashQuery}
          visible={slashPaletteVisible}
          onSelect={(cmd) => {
            setInput(`/${cmd} `);
            setSlashPaletteVisible(false);
            textareaRef.current?.focus();
          }}
        />

        {/* Export conversation button */}
        {messages.length > 2 && (
          <div className="flex justify-end mb-1">
            <button
              onClick={() => {
                const md = exportAsMarkdown(messages as ChatMessage[]);
                navigator.clipboard.writeText(md);
              }}
              className="text-[10px] text-text-muted hover:text-text flex items-center gap-1 transition-colors"
              title="Copy conversation as Markdown"
            >
              <Download size={10} /> Export
            </button>
          </div>
        )}

        <form
          onSubmit={handleSubmit}
          className="border-t border-border/50 pt-2"
        >
          {/* Attachment previews inside the card */}
          {attachments.length > 0 && (
            <div className="px-4 pt-3 pb-1 flex gap-2 flex-wrap">
              {attachments.map((att, i) => (
                <div key={i} className="relative group flex items-center gap-2 px-2.5 py-1.5 bg-surface-alt border border-border/60 rounded-lg text-xs">
                  {att.type.startsWith("image") ? (
                    <img src={att.url} alt="" className="w-8 h-8 rounded object-cover" />
                  ) : (
                    <FileText size={14} className="text-text-muted" />
                  )}
                  <span className="text-text-secondary truncate max-w-[120px]">{att.name}</span>
                  <button onClick={() => removeAttachment(i)} className="p-0.5 rounded hover:bg-danger-light transition-colors">
                    <X size={12} className="text-text-muted" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Textarea — borderless, supports paste images + drag-drop */}
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => {
              const v = e.target.value;
              setInput(v);
              // Slash command palette detection
              if (v.startsWith("/") && !v.includes(" ")) {
                setSlashPaletteVisible(true);
                setSlashQuery(v.slice(1));
              } else {
                setSlashPaletteVisible(false);
              }
            }}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onDrop={handleDrop}
            onDragOver={(e) => e.preventDefault()}
            onInput={handleInput}
            placeholder={placeholder || "Message this agent... (paste images with ⌘V, drop files here)"}
            rows={1}
            className="w-full resize-none bg-transparent px-4 pt-3 pb-2 text-sm text-text placeholder:text-text-muted/60 focus:outline-none"
          />

          {/* Bottom toolbar */}
          <div className="flex items-center justify-between px-3 pb-3 pt-1">
            <div className="flex items-center gap-1.5">
              {/* Project picker */}
              {(projects || onCreateProject) && (
                <div className="relative" ref={projectPickerRef}>
                  <button
                    type="button"
                    onClick={() => setProjectPickerOpen(!projectPickerOpen)}
                    className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg transition-colors ${
                      activeProject
                        ? "text-primary bg-primary/5 hover:bg-primary/10"
                        : "text-text-muted hover:text-text-secondary hover:bg-surface-alt"
                    }`}
                  >
                    <FolderOpen size={14} />
                    <span>{activeProject || "Work in a project"}</span>
                    <ChevronDown size={10} />
                  </button>

                  {projectPickerOpen && (
                    <div className="absolute left-0 bottom-full mb-1 w-64 bg-surface border border-border rounded-xl shadow-lg z-50 overflow-hidden">
                      {projects && projects.length > 0 && (
                        <>
                          <div className="px-3 py-2 border-b border-border">
                            <p className="text-[10px] font-medium text-text-muted uppercase tracking-wide">Projects</p>
                          </div>
                          {projects.map((p) => (
                            <button
                              key={p.name}
                              type="button"
                              onClick={() => { onSelectProject?.(p.name); setProjectPickerOpen(false); }}
                              className={`w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-surface-alt transition-colors ${
                                activeProject === p.name ? "bg-primary/5" : ""
                              }`}
                            >
                              <FolderClosed size={14} className={activeProject === p.name ? "text-primary" : "text-text-muted"} />
                              <div className="flex-1 min-w-0">
                                <p className="text-xs font-medium text-text truncate">{p.name}</p>
                                {p.lastSync && (
                                  <p className="text-[10px] text-text-muted">
                                    {p.fileCount ? `${p.fileCount} files · ` : ""}
                                    {new Date(p.lastSync).toLocaleDateString()}
                                  </p>
                                )}
                              </div>
                              {activeProject === p.name && <Check size={12} className="text-primary shrink-0" />}
                            </button>
                          ))}
                        </>
                      )}

                      {(!projects || projects.length === 0) && !showNewProjectInput && (
                        <div className="px-3 py-4 text-center">
                          <FolderOpen size={20} className="text-text-muted mx-auto mb-1.5" />
                          <p className="text-xs text-text-secondary">No projects yet</p>
                          <p className="text-[10px] text-text-muted mt-0.5">Create one to persist files across sessions</p>
                        </div>
                      )}

                      {activeProject && (
                        <button
                          type="button"
                          onClick={() => { onSelectProject?.(""); setProjectPickerOpen(false); }}
                          className="w-full flex items-center gap-2 px-3 py-2 text-xs text-text-muted hover:bg-surface-alt border-t border-border transition-colors"
                        >
                          <X size={12} /> Stop working in project
                        </button>
                      )}

                      <div className="border-t border-border">
                        {showNewProjectInput ? (
                          <div className="px-3 py-2 flex gap-1.5">
                            <input
                              type="text"
                              value={newProjectName}
                              onChange={(e) => setNewProjectName(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter" && newProjectName.trim()) {
                                  onCreateProject?.(newProjectName.trim());
                                  setNewProjectName("");
                                  setShowNewProjectInput(false);
                                  setProjectPickerOpen(false);
                                }
                                if (e.key === "Escape") setShowNewProjectInput(false);
                              }}
                              placeholder="Project name"
                              autoFocus
                              className="flex-1 text-xs px-2 py-1 rounded border border-border bg-surface focus:outline-none focus:ring-1 focus:ring-primary/30"
                            />
                            <button
                              type="button"
                              onClick={() => {
                                if (newProjectName.trim()) {
                                  onCreateProject?.(newProjectName.trim());
                                  setNewProjectName("");
                                  setShowNewProjectInput(false);
                                  setProjectPickerOpen(false);
                                }
                              }}
                              className="px-2 py-1 text-xs bg-primary text-white rounded hover:opacity-90"
                            >
                              Create
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setShowNewProjectInput(true)}
                            className="w-full flex items-center gap-2 px-3 py-2 text-xs text-text-secondary hover:bg-surface-alt transition-colors"
                          >
                            <Plus size={12} /> Create new project
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Plus menu */}
              <div className="relative" ref={plusMenuRef}>
                <input ref={fileInputRef} type="file" className="hidden" multiple accept="image/*,.pdf,.csv,.txt,.json,.md" onChange={handleFileSelect} />
                <button
                  type="button"
                  onClick={() => setPlusMenuOpen(!plusMenuOpen)}
                  className="flex items-center justify-center w-8 h-8 rounded-full border border-border/60 text-text-muted hover:text-text hover:bg-surface-alt hover:border-border transition-colors"
                  title="Add content"
                >
                  <Plus size={16} />
                </button>

                {plusMenuOpen && (
                  <div className="absolute left-0 bottom-full mb-1 w-56 bg-surface border border-border rounded-xl shadow-lg z-50 overflow-hidden py-1">
                    <button
                      type="button"
                      onClick={() => { fileInputRef.current?.click(); setPlusMenuOpen(false); }}
                      className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-text hover:bg-surface-alt transition-colors"
                    >
                      <Paperclip size={16} className="text-text-muted" />
                      Add files or photos
                    </button>
                    <div className="mx-3 border-t border-border/50" />
                    <button
                      type="button"
                      onClick={() => { onSend("What tools and skills do you have available?"); setPlusMenuOpen(false); }}
                      className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-text hover:bg-surface-alt transition-colors"
                    >
                      <Zap size={16} className="text-text-muted" />
                      Skills
                    </button>
                  </div>
                )}
              </div>
            </div>

            {/* Plan selector + Send / Stop */}
            <div className="flex items-center gap-2">
              {onChangePlan && (
                <select
                  value={activePlan || "standard"}
                  onChange={(e) => onChangePlan(e.target.value)}
                  className="text-xs bg-surface-alt border border-border/60 rounded-lg px-2 py-1.5 text-text-secondary hover:border-border focus:outline-none focus:ring-1 focus:ring-primary/30 cursor-pointer"
                  title="Switch LLM plan"
                >
                  <option value="basic">Basic</option>
                  <option value="standard">Standard</option>
                  <option value="premium">Premium</option>
                </select>
              )}
              {streaming && onStop ? (
                <button
                  type="button"
                  onClick={onStop}
                  className="flex items-center justify-center w-9 h-9 rounded-full bg-danger text-white hover:opacity-90 transition-colors"
                  title="Stop generation"
                >
                  <Square size={16} />
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={(!input.trim() && attachments.length === 0) || isActive}
                  className="flex items-center justify-center w-9 h-9 rounded-full bg-primary text-white hover:opacity-90 disabled:opacity-30 disabled:pointer-events-none transition-colors"
                >
                  <Send size={16} />
                </button>
              )}
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
