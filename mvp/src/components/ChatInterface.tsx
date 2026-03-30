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

  return (
    <div className={`border rounded-lg overflow-hidden text-xs ${
      isError ? "border-red-200 bg-red-50" : isRunning ? "border-amber-200 bg-amber-50" : "border-border bg-surface"
    }`}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-black/5 transition-colors"
      >
        <Wrench size={12} className={isError ? "text-red-500" : isRunning ? "text-amber-500 animate-spin" : "text-green-600"} />
        <span className="font-medium text-text">{msg.toolName}</span>
        {isRunning && <span className="text-amber-600 animate-pulse">running...</span>}
        {msg.toolLatencyMs && !isRunning && (
          <span className="text-text-muted ml-auto flex items-center gap-1">
            <Clock size={10} /> {msg.toolLatencyMs < 1000 ? `${msg.toolLatencyMs}ms` : `${(msg.toolLatencyMs / 1000).toFixed(1)}s`}
          </span>
        )}
        {!isRunning && (expanded ? <ChevronDown size={12} className="ml-auto text-text-muted" /> : <ChevronRight size={12} className="ml-auto text-text-muted" />)}
      </button>
      {expanded && (msg.toolResult || msg.toolError) && (
        <div className="border-t border-border/50 px-3 py-2 max-h-48 overflow-y-auto">
          {msg.toolError && <pre className="text-red-600 whitespace-pre-wrap break-words">{msg.toolError}</pre>}
          {msg.toolResult && <pre className="text-text-secondary whitespace-pre-wrap break-words">{msg.toolResult}</pre>}
        </div>
      )}
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

          // Thinking trace
          if (msg.role === "thinking") {
            return (
              <div key={msg.id} className="flex justify-start animate-[fadeInUp_150ms_ease-out]">
                <div className="max-w-[85%] px-3 py-2 rounded-lg border border-purple-200 bg-purple-50 text-xs leading-relaxed text-purple-800">
                  <div className="flex items-center gap-1.5 font-medium mb-1 text-purple-600">
                    <Brain size={12} /> Thinking
                  </div>
                  <div className="whitespace-pre-wrap">{msg.content}</div>
                </div>
              </div>
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
                  isWarning ? "bg-amber-50 text-amber-700 border border-amber-200" :
                  msg.strategy ? "bg-indigo-50 text-indigo-700 border border-indigo-200" :
                  "bg-gray-100 text-text-muted"
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
                <div className="max-w-[80%] px-4 py-2.5 rounded-2xl rounded-bl-md text-sm leading-relaxed bg-red-50 text-red-700 border border-red-200">
                  {msg.content.includes("[") ? (
                    <span dangerouslySetInnerHTML={{
                      __html: msg.content.replace(
                        /\[([^\]]+)\]\(([^)]+)\)/g,
                        '<a href="$2" class="underline font-medium hover:text-red-900">$1</a>'
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
                <div className="px-4 py-2.5 rounded-2xl rounded-bl-md text-sm leading-relaxed bg-neutral-light text-text prose prose-sm prose-neutral max-w-none [&_pre]:bg-gray-800 [&_pre]:text-gray-100 [&_pre]:rounded-lg [&_pre]:p-3 [&_pre]:text-xs [&_pre]:overflow-x-auto [&_code]:bg-gray-200 [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-xs [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_table]:text-xs [&_th]:px-2 [&_th]:py-1 [&_td]:px-2 [&_td]:py-1 [&_a]:text-primary [&_a]:underline">
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
            <div className="bg-gray-100 rounded-2xl rounded-bl-md px-4 py-3">
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
            <div className="bg-gray-100 rounded-2xl rounded-bl-md px-4 py-3">
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
            className="flex-1 resize-none rounded-lg border border-border px-3 py-2 text-sm bg-white placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
          />
          {streaming && onStop ? (
            <button
              type="button"
              onClick={onStop}
              className="p-2.5 rounded-lg bg-red-500 text-white hover:bg-red-600 transition-colors min-w-[44px] min-h-[44px] flex items-center justify-center"
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
