import { useState, useRef, useEffect, useCallback } from "react";
import {
  Send, Square, Brain, Wrench, AlertTriangle, Info, ChevronDown, ChevronRight,
  Clock, Zap, Bot, Copy, Check, RefreshCw, Image as ImageIcon, Paperclip,
  X, FileText, FolderOpen, Plus, FolderClosed,
  DollarSign, Layers, ShieldAlert, ShieldOff, Users,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatMessage, SessionMeta, FileChange } from "../lib/use-agent-stream";
import { useScrollAnchor } from "../lib/use-pretext";

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

// ── Tool Call Card ──────────────────────────────────────────

function ToolCallCard({ msg }: { msg: ChatMessage }) {
  const [expanded, setExpanded] = useState(false);
  const isRunning = msg.toolStatus === "running";
  const isError = msg.toolStatus === "error";
  const isDone = msg.toolStatus === "done";
  // Handle missing toolName from old cached sessions
  const toolName = msg.toolName || msg.content || "tool";

  return (
    <div className={`border rounded-xl overflow-hidden text-xs transition-colors ${
      isError ? "border-danger/30 bg-danger-light/30" :
      isRunning ? "border-primary/20 bg-primary/[0.03]" :
      "border-border/60 bg-surface-alt/20"
    }`}>
      <button
        onClick={() => !isRunning && setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-black/[0.02] dark:hover:bg-white/[0.02] transition-colors"
      >
        {isRunning ? (
          <div className="w-4 h-4 rounded-full border-2 border-primary border-t-transparent animate-spin shrink-0" />
        ) : isError ? (
          <AlertTriangle size={13} className="text-danger shrink-0" />
        ) : (
          <div className="w-4 h-4 rounded-full bg-success-light flex items-center justify-center shrink-0">
            <Check size={9} className="text-success" />
          </div>
        )}
        <span className={`font-medium ${isRunning ? "text-primary" : "text-text"}`}>{toolName}</span>
        {msg.toolArgsPreview && (
          <span className="text-text-muted truncate max-w-[280px] font-normal" title={msg.toolArgsPreview}>
            {msg.toolArgsPreview}
          </span>
        )}
        {isRunning && !msg.toolArgsPreview && <span className="text-primary/60 animate-pulse ml-1">running...</span>}
        <span className="flex items-center gap-2 ml-auto shrink-0">
          {msg.toolCostUsd != null && msg.toolCostUsd > 0 && isDone && (
            <span className="text-text-muted">${msg.toolCostUsd.toFixed(4)}</span>
          )}
          {msg.toolLatencyMs && isDone && (
            <span className="text-text-muted flex items-center gap-0.5">
              <Clock size={9} /> {msg.toolLatencyMs < 1000 ? `${msg.toolLatencyMs}ms` : `${(msg.toolLatencyMs / 1000).toFixed(1)}s`}
            </span>
          )}
          {!isRunning && (expanded ? <ChevronDown size={11} className="text-text-muted" /> : <ChevronRight size={11} className="text-text-muted" />)}
        </span>
      </button>
      {expanded && (msg.toolResult || msg.toolError) && (
        <div className="border-t border-border/30 px-3 py-2 max-h-60 overflow-y-auto bg-[#1e1e2e] rounded-b-xl relative group">
          <CopyButton text={msg.toolError || msg.toolResult || ""} />
          {msg.toolError && <pre className="text-red-400 whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed">{msg.toolError}</pre>}
          {msg.toolResult && <pre className="text-[#cdd6f4] whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed">{msg.toolResult}</pre>}
        </div>
      )}
    </div>
  );
}

// ── File Change Card ───────────────────────────────────────

function FileChangeCard({ change }: { change: FileChange }) {
  const [expanded, setExpanded] = useState(false);
  const fileName = change.path.split("/").pop() || change.path;
  const isCreate = change.changeType === "create";

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
        {change.language && <span className="text-text-muted text-[10px]">{change.language}</span>}
        {change.size != null && <span className="text-text-muted text-[10px] ml-auto">{change.size > 1024 ? `${(change.size / 1024).toFixed(1)}KB` : `${change.size}B`}</span>}
        {expanded ? <ChevronDown size={11} className="text-text-muted" /> : <ChevronRight size={11} className="text-text-muted" />}
      </button>
      {expanded && (
        <div className="border-t border-border/30 max-h-80 overflow-y-auto bg-[#1e1e2e] rounded-b-xl relative">
          <div className="absolute top-1 right-1 z-10">
            <CopyButton text={isCreate ? (change.content || "") : (change.newText || "")} />
          </div>
          {isCreate && change.content && (
            <pre className="px-3 py-2 text-[#cdd6f4] whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed">
              {change.content}
            </pre>
          )}
          {!isCreate && (change.oldText || change.newText) && (
            <pre className="px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words">
              <div className="text-[10px] text-[#8b949e] mb-1">--- a/{change.path}</div>
              <div className="text-[10px] text-[#8b949e] mb-2">+++ b/{change.path}</div>
              {change.oldText?.split("\n").map((line, i) => (
                <div key={`old-${i}`} className="text-red-400 bg-red-500/5">- {line}</div>
              ))}
              {change.newText?.split("\n").map((line, i) => (
                <div key={`new-${i}`} className="text-green-400 bg-green-500/5">+ {line}</div>
              ))}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

// ── Thinking Block ──────────────────────────────────────────

function ThinkingBlock({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);
  const preview = content.length > 120 ? content.slice(0, 120) + "..." : content;

  return (
    <div className="flex justify-start animate-[fadeInUp_150ms_ease-out]">
      <div className="max-w-[85%]">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1.5 text-xs font-medium text-purple-600 dark:text-purple-400 hover:text-purple-800 dark:hover:text-purple-300 transition-colors mb-0.5"
        >
          <Brain size={12} />
          <span>Thinking</span>
          {expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        </button>
        {expanded ? (
          <div className="px-3 py-2 rounded-lg border border-purple-200 dark:border-purple-800 bg-purple-50/50 dark:bg-purple-950/30 text-xs leading-relaxed text-purple-800 dark:text-purple-300 whitespace-pre-wrap">
            {content}
          </div>
        ) : (
          <p className="px-3 py-1 text-[11px] text-purple-400 dark:text-purple-500 italic truncate max-w-md">
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
  return (
    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity mt-1 px-1">
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
    </div>
  );
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
  [&_pre]:bg-[#1e1e2e] [&_pre]:text-[#cdd6f4] [&_pre]:rounded-xl [&_pre]:p-4 [&_pre]:my-3 [&_pre]:text-xs [&_pre]:overflow-x-auto [&_pre]:leading-relaxed [&_pre]:relative
  [&_code]:bg-surface-alt [&_code]:text-primary [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:rounded-md [&_code]:text-xs [&_code]:font-mono
  [&_pre_code]:bg-transparent [&_pre_code]:text-inherit [&_pre_code]:p-0 [&_pre_code]:rounded-none
  [&_blockquote]:border-l-2 [&_blockquote]:border-primary/30 [&_blockquote]:pl-3 [&_blockquote]:my-3 [&_blockquote]:text-text-secondary [&_blockquote]:italic
  [&_hr]:my-4 [&_hr]:border-border
  [&_table]:my-3 [&_table]:text-xs [&_table]:w-full [&_table]:border-collapse
  [&_th]:px-3 [&_th]:py-1.5 [&_th]:text-left [&_th]:font-semibold [&_th]:border-b [&_th]:border-border [&_th]:bg-surface-alt
  [&_td]:px-3 [&_td]:py-1.5 [&_td]:border-b [&_td]:border-border/50
  [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2 [&_a]:decoration-primary/30 hover:[&_a]:decoration-primary
  [&_strong]:font-semibold [&_strong]:text-text
  [&_em]:italic
  [&_img]:rounded-lg [&_img]:my-3 [&_img]:max-h-80 [&_img]:object-contain
`;

// ── Main Component ──────────────────────────────────────────

export function ChatInterface({
  messages, onSend, onStop, onRetry, loading, streaming, sessionMeta, placeholder, suggestedPrompts,
  projects, activeProject, onSelectProject, onCreateProject, activePlan, onChangePlan,
}: ChatInterfaceProps) {
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<{ url: string; type: string; name: string }[]>([]);
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [plusMenuOpen, setPlusMenuOpen] = useState(false);
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

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if ((!text && attachments.length === 0) || isActive) return;
    setInput("");
    const atts = attachments.length > 0 ? attachments.map(a => ({ url: a.url, type: a.type })) : undefined;
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
          <div className="flex flex-col items-center justify-center py-16 px-4">
            <div className="w-12 h-12 rounded-2xl bg-primary/10 flex items-center justify-center mb-4">
              <Bot size={24} className="text-primary" />
            </div>
            <p className="text-sm text-text-secondary mb-6">What can I help you with?</p>
            {suggestedPrompts && suggestedPrompts.length > 0 && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-w-lg w-full">
                {suggestedPrompts.map((prompt, i) => (
                  <button
                    key={i}
                    onClick={() => onSend(prompt)}
                    className="px-3.5 py-2.5 text-xs text-text-secondary bg-surface border border-border rounded-xl hover:border-primary/30 hover:bg-surface-alt hover:text-text transition-all text-left leading-relaxed"
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {(messages as ChatMessage[]).map((msg) => {
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

          // Tool call
          if (msg.role === "tool") {
            return (
              <div key={msg.id} className="animate-[fadeInUp_150ms_ease-out]">
                <div className="w-full">
                  <ToolCallCard msg={msg} />
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
                  {msg.content.includes("[") ? (
                    <span dangerouslySetInnerHTML={{
                      __html: msg.content.replace(
                        /\[([^\]]+)\]\(([^)]+)\)/g,
                        '<a href="$2" class="underline font-medium">$1</a>'
                      )
                    }} />
                  ) : msg.content}
                </div>
              </div>
            );
          }

          // Assistant message
          return (
            <div key={msg.id} className="animate-[fadeInUp_200ms_ease-out] group">
              <div className="min-w-0">
                <div className={`px-4 py-3 rounded-2xl rounded-bl-md text-sm leading-relaxed bg-surface border border-border/40 text-text ${PROSE_CLASSES}`}>
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
                </div>
                <div className="flex items-center gap-2 mt-1 px-1">
                  <MessageActions msg={msg} onRetry={onRetry} />
                  {msg.turnInfo && (
                    <span className="text-[10px] text-text-muted ml-auto flex items-center gap-2">
                      <span>{msg.turnInfo.model.split("/").pop()}</span>
                      <span>${msg.turnInfo.cost_usd.toFixed(4)}</span>
                      <span>{msg.turnInfo.tokens.toLocaleString()} tok</span>
                    </span>
                  )}
                </div>
              </div>
            </div>
          );
        })}

        {/* Streaming indicator — always visible when active */}
        {(streaming || loading) && (
          <div className="flex items-center gap-2 text-xs text-text-muted px-1 py-1">
            <div className="flex gap-1">
              <span className="w-1.5 h-1.5 bg-primary/60 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
              <span className="w-1.5 h-1.5 bg-primary/60 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
              <span className="w-1.5 h-1.5 bg-primary/60 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
            </div>
            <span className="animate-pulse">Working...</span>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Session summary */}
      {sessionMeta && <SessionSummary meta={sessionMeta} />}

      {/* Composer — seamless with chat area */}
      <div className="px-4 pb-2 pt-0">
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

          {/* Textarea — borderless inside the card */}
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onInput={handleInput}
            placeholder={placeholder || "How can I help you today?"}
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
