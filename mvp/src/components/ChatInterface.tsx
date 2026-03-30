import { useState, useRef, useEffect, useCallback } from "react";
import {
  Send, Square, Brain, Wrench, AlertTriangle, Info, ChevronDown, ChevronRight,
  Clock, Zap, Bot, Copy, Check, RefreshCw, Image as ImageIcon, Paperclip,
  X, FileText,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatMessage, SessionMeta } from "../lib/use-agent-stream";

// ── Legacy type ─────────────────────────────────────────────
interface LegacyMessage { id: string; role: "user" | "assistant"; content: string; timestamp: string; }
export type Message = LegacyMessage;

// ── Props ───────────────────────────────────────────────────

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
        <span className={`font-medium ${isRunning ? "text-primary" : "text-text"}`}>{msg.toolName}</span>
        {isRunning && <span className="text-primary/60 animate-pulse ml-1">running...</span>}
        <span className="flex items-center gap-2 ml-auto">
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
}: ChatInterfaceProps) {
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<{ url: string; type: string; name: string }[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isActive = loading || streaming;

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
      <div className="flex-1 overflow-y-auto px-4 py-6 space-y-4">
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
              <div key={msg.id} className="flex justify-start animate-[fadeInUp_150ms_ease-out]">
                <div className="max-w-[85%] w-full">
                  <ToolCallCard msg={msg} />
                </div>
              </div>
            );
          }

          // System/warning/reasoning
          if (msg.role === "system") {
            const isWarning = msg.content.startsWith("Warning:");
            return (
              <div key={msg.id} className="flex justify-center animate-[fadeInUp_150ms_ease-out]">
                <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs ${
                  isWarning ? "bg-warning-light text-warning-dark border border-warning" :
                  msg.strategy ? "bg-info-light text-info-dark border border-info" :
                  "bg-surface-alt text-text-muted"
                }`}>
                  {isWarning ? <AlertTriangle size={10} /> : msg.strategy ? <Brain size={10} /> : <Info size={10} />}
                  {msg.content}
                </div>
              </div>
            );
          }

          // Error
          if (msg.role === "error") {
            return (
              <div key={msg.id} className="flex justify-start animate-[fadeInUp_150ms_ease-out]">
                <div className="max-w-[80%] px-4 py-2.5 rounded-2xl rounded-bl-md text-sm leading-relaxed bg-danger-light text-danger border border-danger/30">
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
            <div key={msg.id} className="flex justify-start animate-[fadeInUp_200ms_ease-out] group">
              <div className="max-w-[85%] min-w-0">
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

        {/* Streaming indicator */}
        {(streaming || loading) && !messages.some(m => (m as ChatMessage).role === "tool" && (m as ChatMessage).toolStatus === "running") && (
          <div className="flex justify-start">
            <div className="bg-surface-alt rounded-2xl rounded-bl-md px-4 py-3">
              <div className="flex gap-1.5">
                <span className="w-1.5 h-1.5 bg-text-muted/60 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                <span className="w-1.5 h-1.5 bg-text-muted/60 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                <span className="w-1.5 h-1.5 bg-text-muted/60 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
              </div>
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Session summary */}
      {sessionMeta && <SessionSummary meta={sessionMeta} />}

      {/* Attachment previews */}
      {attachments.length > 0 && (
        <div className="px-4 pt-2 flex gap-2 flex-wrap">
          {attachments.map((att, i) => (
            <div key={i} className="relative group flex items-center gap-2 px-2.5 py-1.5 bg-surface-alt border border-border rounded-lg text-xs">
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

      {/* Input */}
      <form onSubmit={handleSubmit} className="border-t border-border px-4 py-3">
        <div className="flex items-end gap-2">
          {/* Attach button */}
          <input ref={fileInputRef} type="file" className="hidden" multiple accept="image/*,.pdf,.csv,.txt,.json,.md" onChange={handleFileSelect} />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="p-2 rounded-lg text-text-muted hover:text-text hover:bg-surface-alt transition-colors min-w-[40px] min-h-[40px] flex items-center justify-center"
            title="Attach file or image"
          >
            <Paperclip size={18} />
          </button>

          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onInput={handleInput}
            placeholder={placeholder || "Type a message..."}
            rows={1}
            className="flex-1 resize-none rounded-xl border border-border px-3.5 py-2.5 text-sm bg-surface placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary/50 transition-all"
          />
          {streaming && onStop ? (
            <button
              type="button"
              onClick={onStop}
              className="p-2.5 rounded-xl bg-danger text-white hover:opacity-90 transition-colors min-w-[44px] min-h-[44px] flex items-center justify-center"
              title="Stop generation"
            >
              <Square size={18} />
            </button>
          ) : (
            <button
              type="submit"
              disabled={(!input.trim() && attachments.length === 0) || isActive}
              className="p-2.5 rounded-xl bg-primary text-white hover:opacity-90 disabled:opacity-40 disabled:pointer-events-none transition-colors min-w-[44px] min-h-[44px] flex items-center justify-center"
            >
              <Send size={18} />
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
