import { useState, useRef, useEffect } from "react";
import { Send, Square, Brain, Wrench, AlertTriangle, Info, ChevronDown, ChevronRight, Clock, Zap, Bot } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatMessage, SessionMeta } from "../lib/use-agent-stream";

// ── Legacy type for backward compat ──────────────────────────
interface LegacyMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}
export type Message = LegacyMessage;

// ── Props ────────────────────────────────────────────────────

interface ChatInterfaceProps {
  messages: ChatMessage[] | Message[];
  onSend: (text: string) => void;
  onStop?: () => void;
  loading?: boolean;
  streaming?: boolean;
  sessionMeta?: SessionMeta | null;
  placeholder?: string;
}

// ── Tool Call Card ───────────────────────────────────────────

function ToolCallCard({ msg }: { msg: ChatMessage }) {
  const [expanded, setExpanded] = useState(false);
  const isRunning = msg.toolStatus === "running";
  const isError = msg.toolStatus === "error";
  const isDone = msg.toolStatus === "done";

  return (
    <div className={`border rounded-xl overflow-hidden text-xs transition-colors ${
      isError ? "border-danger bg-danger-light/50" :
      isRunning ? "border-primary/20 bg-primary/[0.03]" :
      "border-border/60 bg-surface-alt/30"
    }`}>
      <button
        onClick={() => !isRunning && setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-black/[0.03] transition-colors"
      >
        {isRunning ? (
          <div className="w-4 h-4 rounded-full border-2 border-primary border-t-transparent animate-spin shrink-0" />
        ) : isError ? (
          <AlertTriangle size={13} className="text-danger shrink-0" />
        ) : (
          <div className="w-4 h-4 rounded-full bg-success-light flex items-center justify-center shrink-0">
            <Wrench size={9} className="text-success" />
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
        <div className="border-t border-border/30 px-3 py-2 max-h-60 overflow-y-auto bg-[#1e1e2e] rounded-b-xl">
          {msg.toolError && <pre className="text-red-400 whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed">{msg.toolError}</pre>}
          {msg.toolResult && <pre className="text-[#cdd6f4] whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed">{msg.toolResult}</pre>}
        </div>
      )}
    </div>
  );
}

// ── Thinking Block (collapsible like Claude) ────────────────

function ThinkingBlock({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);
  const preview = content.length > 120 ? content.slice(0, 120) + "..." : content;

  return (
    <div className="flex justify-start animate-[fadeInUp_150ms_ease-out]">
      <div className="max-w-[85%]">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1.5 text-xs font-medium text-purple-600 hover:text-purple-800 transition-colors mb-0.5"
        >
          <Brain size={12} />
          <span>Thinking</span>
          {expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        </button>
        {expanded ? (
          <div className="px-3 py-2 rounded-lg border border-purple-200 bg-purple-50/50 text-xs leading-relaxed text-purple-800 whitespace-pre-wrap">
            {content}
          </div>
        ) : (
          <p className="px-3 py-1 text-[11px] text-purple-400 italic truncate max-w-md">
            {preview}
          </p>
        )}
      </div>
    </div>
  );
}

// ── Session Summary Bar ──────────────────────────────────────

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

// ── Main Component ───────────────────────────────────────────

export function ChatInterface({ messages, onSend, onStop, loading, streaming, sessionMeta, placeholder, suggestedPrompts }: ChatInterfaceProps & { suggestedPrompts?: string[] }) {
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isActive = loading || streaming;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isActive]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text || isActive) return;
    setInput("");
    onSend(text);
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
      el.style.height = Math.min(el.scrollHeight, 120) + "px";
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-6 space-y-3">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 px-4">
            <Bot size={32} className="text-text-muted mb-3 opacity-60" />
            <p className="text-sm text-text-secondary mb-6">What can I help you with?</p>
            {suggestedPrompts && suggestedPrompts.length > 0 && (
              <div className="flex flex-wrap justify-center gap-2 max-w-lg">
                {suggestedPrompts.map((prompt, i) => (
                  <button
                    key={i}
                    onClick={() => onSend(prompt)}
                    className="px-3 py-2 text-xs text-text-secondary bg-surface-alt border border-border rounded-lg hover:border-primary/30 hover:text-text transition-colors text-left"
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
              <div key={msg.id} className="flex justify-end animate-[fadeInUp_200ms_ease-out]">
                <div className="max-w-[80%] px-4 py-2.5 rounded-2xl rounded-br-md text-sm leading-relaxed bg-primary text-white">
                  {msg.content}
                </div>
              </div>
            );
          }

          // Thinking trace (collapsible like Claude)
          if (msg.role === "thinking") {
            return (
              <ThinkingBlock key={msg.id} content={msg.content} />
            );
          }

          // Tool call card
          if (msg.role === "tool") {
            return (
              <div key={msg.id} className="flex justify-start animate-[fadeInUp_150ms_ease-out]">
                <div className="max-w-[85%] w-full">
                  <ToolCallCard msg={msg} />
                </div>
              </div>
            );
          }

          // System / warning / reasoning
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
                <div className="max-w-[80%] px-4 py-2.5 rounded-2xl rounded-bl-md text-sm leading-relaxed bg-danger-light text-danger border border-danger">
                  {msg.content.includes("[") ? (
                    <span dangerouslySetInnerHTML={{
                      __html: msg.content.replace(
                        /\[([^\]]+)\]\(([^)]+)\)/g,
                        '<a href="$2" class="underline font-medium hover:text-danger-dark">$1</a>'
                      )
                    }} />
                  ) : msg.content}
                </div>
              </div>
            );
          }

          // Assistant message (default) — rendered with markdown
          return (
            <div key={msg.id} className="flex justify-start animate-[fadeInUp_200ms_ease-out]">
              <div className="max-w-[80%]">
                <div className={`px-4 py-3 rounded-2xl rounded-bl-md text-sm leading-relaxed bg-surface border border-border/50 text-text
                  prose prose-sm prose-neutral dark:prose-invert max-w-none
                  [&>*:first-child]:mt-0 [&>*:last-child]:mb-0
                  [&_p]:my-2 [&_p]:leading-relaxed
                  [&_h1]:text-base [&_h1]:font-bold [&_h1]:mt-4 [&_h1]:mb-2
                  [&_h2]:text-sm [&_h2]:font-bold [&_h2]:mt-3 [&_h2]:mb-1.5
                  [&_h3]:text-sm [&_h3]:font-semibold [&_h3]:mt-3 [&_h3]:mb-1
                  [&_ul]:my-2 [&_ul]:pl-4 [&_ul]:space-y-1
                  [&_ol]:my-2 [&_ol]:pl-4 [&_ol]:space-y-1
                  [&_li]:leading-relaxed
                  [&_pre]:bg-[#1e1e2e] [&_pre]:text-[#cdd6f4] [&_pre]:rounded-xl [&_pre]:p-4 [&_pre]:my-3 [&_pre]:text-xs [&_pre]:overflow-x-auto [&_pre]:leading-relaxed
                  [&_code]:bg-surface-alt [&_code]:text-primary [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:rounded-md [&_code]:text-xs [&_code]:font-mono
                  [&_pre_code]:bg-transparent [&_pre_code]:text-inherit [&_pre_code]:p-0 [&_pre_code]:rounded-none
                  [&_blockquote]:border-l-2 [&_blockquote]:border-primary/30 [&_blockquote]:pl-3 [&_blockquote]:my-2 [&_blockquote]:text-text-secondary [&_blockquote]:italic
                  [&_hr]:my-3 [&_hr]:border-border
                  [&_table]:my-3 [&_table]:text-xs [&_table]:w-full
                  [&_th]:px-3 [&_th]:py-1.5 [&_th]:text-left [&_th]:font-semibold [&_th]:border-b [&_th]:border-border [&_th]:bg-surface-alt
                  [&_td]:px-3 [&_td]:py-1.5 [&_td]:border-b [&_td]:border-border/50
                  [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2
                  [&_strong]:font-semibold [&_strong]:text-text
                  [&_em]:italic
                `}>
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
                </div>
                {msg.turnInfo && (
                  <div className="flex items-center gap-3 mt-1 px-2 text-[10px] text-text-muted">
                    <span>{msg.turnInfo.model.split("/").pop()}</span>
                    <span>${msg.turnInfo.cost_usd.toFixed(4)}</span>
                    <span>{msg.turnInfo.tokens.toLocaleString()} tokens</span>
                  </div>
                )}
              </div>
            </div>
          );
        })}

        {/* Streaming indicator */}
        {streaming && !messages.some(m => (m as ChatMessage).role === "tool" && (m as ChatMessage).toolStatus === "running") && (
          <div className="flex justify-start">
            <div className="bg-surface-alt rounded-2xl rounded-bl-md px-4 py-3">
              <div className="flex gap-1">
                <span className="w-2 h-2 bg-text-muted rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                <span className="w-2 h-2 bg-text-muted rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                <span className="w-2 h-2 bg-text-muted rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
              </div>
            </div>
          </div>
        )}

        {/* Legacy loading indicator */}
        {loading && !streaming && (
          <div className="flex justify-start">
            <div className="bg-surface-alt rounded-2xl rounded-bl-md px-4 py-3">
              <div className="flex gap-1">
                <span className="w-2 h-2 bg-text-muted rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                <span className="w-2 h-2 bg-text-muted rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                <span className="w-2 h-2 bg-text-muted rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
              </div>
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Session summary */}
      {sessionMeta && <SessionSummary meta={sessionMeta} />}

      {/* Input */}
      <form onSubmit={handleSubmit} className="border-t border-border px-4 py-3">
        <div className="flex items-end gap-2">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onInput={handleInput}
            placeholder={placeholder || "Type a message..."}
            rows={1}
            className="flex-1 resize-none rounded-lg border border-border px-3 py-2 text-sm bg-surface placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
          />
          {streaming && onStop ? (
            <button
              type="button"
              onClick={onStop}
              className="p-2.5 rounded-lg bg-danger text-white hover:bg-danger transition-colors min-w-[44px] min-h-[44px] flex items-center justify-center"
              title="Stop generation"
            >
              <Square size={18} />
            </button>
          ) : (
            <button
              type="submit"
              disabled={!input.trim() || isActive}
              className="p-2.5 rounded-lg bg-primary text-white hover:bg-primary-hover disabled:opacity-50 disabled:pointer-events-none transition-colors min-w-[44px] min-h-[44px] flex items-center justify-center"
            >
              <Send size={18} />
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
