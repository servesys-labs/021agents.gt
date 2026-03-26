import {
  useState,
  useCallback,
  useRef,
  useEffect,
  useMemo,
  type KeyboardEvent,
  type FormEvent,
} from "react";
import {
  Send,
  Search,
  Trash2,
  Copy,
  Check,
  ChevronRight,
  ChevronDown,
  Bot,
  User,
  Terminal,
  X,
  ArrowDown,
} from "lucide-react";
import { useSearchParams } from "react-router-dom";

import { ConfirmDialog } from "../../components/common/ConfirmDialog";
import { useToast } from "../../components/common/ToastProvider";
import { apiRequest } from "../../lib/api";

/* ================================================================
   Types
   ================================================================ */

interface ToolCall {
  id: string;
  name: string;
  status: "running" | "success" | "error";
  input: Record<string, unknown>;
  output?: unknown;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  timestamp: number;
  tool_calls?: ToolCall[];
}

/* ================================================================
   Helpers
   ================================================================ */

let _msgId = 0;
function nextId(): string {
  return `msg-${Date.now()}-${++_msgId}`;
}

function relativeTime(ts: number): string {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 5) return "just now";
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

/** CSS-only syntax highlighting via token classes. */
function highlightCode(code: string, lang: string): string {
  // Keywords by language family
  const jsKeywords =
    /\b(const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|this|class|extends|import|export|default|from|async|await|try|catch|finally|throw|typeof|instanceof|in|of|yield|void|delete|null|undefined|true|false|NaN|Infinity)\b/g;
  const pyKeywords =
    /\b(def|class|if|elif|else|for|while|return|import|from|as|try|except|finally|raise|with|yield|lambda|pass|break|continue|and|or|not|is|in|None|True|False|self|async|await|print)\b/g;
  const tsTypes =
    /\b(string|number|boolean|any|void|never|unknown|interface|type|enum|declare|readonly|keyof|typeof|infer|extends|implements)\b/g;
  const goKeywords =
    /\b(func|package|import|var|const|type|struct|interface|return|if|else|for|range|switch|case|default|break|continue|go|select|chan|defer|map|make|new|nil|true|false|error|string|int|bool|byte|float64|float32)\b/g;
  const rustKeywords =
    /\b(fn|let|mut|const|struct|enum|impl|trait|pub|use|mod|match|if|else|for|while|loop|return|self|Self|super|crate|as|in|ref|move|async|await|where|type|true|false|None|Some|Ok|Err|Box|Vec|String|Option|Result)\b/g;
  const bashKeywords =
    /\b(if|then|else|elif|fi|for|while|do|done|case|esac|function|return|exit|echo|export|source|local|readonly|declare|set|unset|shift|cd|pwd|ls|grep|sed|awk|cat|chmod|chown|mkdir|rm|cp|mv|curl|wget|sudo|apt|brew|npm|yarn|pip|git)\b/g;
  const sqlKeywords =
    /\b(SELECT|FROM|WHERE|INSERT|INTO|UPDATE|DELETE|CREATE|DROP|ALTER|TABLE|INDEX|JOIN|LEFT|RIGHT|INNER|OUTER|ON|AND|OR|NOT|NULL|IS|AS|ORDER|BY|GROUP|HAVING|LIMIT|OFFSET|SET|VALUES|DISTINCT|COUNT|SUM|AVG|MIN|MAX|LIKE|IN|BETWEEN|EXISTS|UNION|ALL|PRIMARY|KEY|FOREIGN|REFERENCES|CONSTRAINT|DEFAULT|CASCADE|UNIQUE|CHECK)\b/gi;

  let result = code
    // Escape HTML
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // Strings (double and single quoted, backtick)
  result = result.replace(
    /(["'`])(?:(?!\1|\\).|\\.)*?\1/g,
    '<span class="syn-str">$&</span>',
  );
  // Comments (single-line)
  result = result.replace(
    /(\/\/.*$|#(?!!).*$|--\s.*$)/gm,
    '<span class="syn-cmt">$&</span>',
  );
  // Numbers
  result = result.replace(
    /\b(\d+\.?\d*(?:e[+-]?\d+)?|0x[\da-fA-F]+|0b[01]+|0o[0-7]+)\b/g,
    '<span class="syn-num">$&</span>',
  );

  // Language-specific keywords
  const family = lang.toLowerCase();
  if (["js", "javascript", "jsx", "ts", "tsx", "typescript"].includes(family)) {
    result = result.replace(
      jsKeywords,
      '<span class="syn-kw">$&</span>',
    );
    if (["ts", "tsx", "typescript"].includes(family)) {
      result = result.replace(
        tsTypes,
        '<span class="syn-type">$&</span>',
      );
    }
  } else if (["py", "python"].includes(family)) {
    result = result.replace(
      pyKeywords,
      '<span class="syn-kw">$&</span>',
    );
  } else if (["go", "golang"].includes(family)) {
    result = result.replace(
      goKeywords,
      '<span class="syn-kw">$&</span>',
    );
  } else if (["rs", "rust"].includes(family)) {
    result = result.replace(
      rustKeywords,
      '<span class="syn-kw">$&</span>',
    );
  } else if (["sh", "bash", "zsh", "shell"].includes(family)) {
    result = result.replace(
      bashKeywords,
      '<span class="syn-kw">$&</span>',
    );
  } else if (["sql"].includes(family)) {
    result = result.replace(
      sqlKeywords,
      '<span class="syn-kw">$&</span>',
    );
  } else {
    // Generic: highlight common keywords
    result = result.replace(
      /\b(function|return|if|else|for|while|class|import|export|const|let|var|true|false|null|undefined|None|nil)\b/g,
      '<span class="syn-kw">$&</span>',
    );
  }

  // Function calls
  result = result.replace(
    /\b([a-zA-Z_]\w*)(?=\s*\()/g,
    '<span class="syn-fn">$&</span>',
  );

  return result;
}

/* ================================================================
   Sub-components
   ================================================================ */

/** Copy-to-clipboard button (inline, shows check on success). */
function CopyButton({ text, className = "" }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* noop */
    }
  }, [text]);

  return (
    <button
      onClick={handleCopy}
      className={`inline-flex items-center justify-center rounded
        transition-colors min-w-[var(--touch-target-min)] min-h-[var(--touch-target-min)]
        ${copied ? "text-status-live" : "text-text-muted hover:text-text-primary"}
        ${className}`}
      title="Copy to clipboard"
      aria-label={copied ? "Copied" : "Copy to clipboard"}
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
    </button>
  );
}

/** Rendered code block with syntax highlighting and copy button. */
function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const html = useMemo(() => highlightCode(code, lang), [code, lang]);

  return (
    <div className="group/code relative my-2 rounded-md border border-border-default bg-surface-base overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-border-default bg-surface-raised/60">
        <span className="text-[10px] font-mono text-text-muted uppercase tracking-wider">
          {lang || "code"}
        </span>
        <CopyButton text={code} className="!min-w-0 !min-h-0 p-1" />
      </div>
      {/* Code body */}
      <pre className="p-3 overflow-x-auto text-xs leading-relaxed font-mono">
        <code dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
    </div>
  );
}

/** Render message content, extracting code fences. */
function MessageContent({ content }: { content: string }) {
  // Split on fenced code blocks: ```lang\n...\n```
  const parts = content.split(/(```[\s\S]*?```)/g);

  return (
    <div className="chat-msg-content text-sm leading-relaxed">
      {parts.map((part, i) => {
        const fenceMatch = part.match(/^```(\w*)\n?([\s\S]*?)```$/);
        if (fenceMatch) {
          const lang = fenceMatch[1] || "text";
          const code = fenceMatch[2].replace(/\n$/, "");
          return <CodeBlock key={i} code={code} lang={lang} />;
        }
        // Inline code
        const inlineParts = part.split(/(`[^`]+`)/g);
        return (
          <span key={i}>
            {inlineParts.map((ip, j) => {
              if (ip.startsWith("`") && ip.endsWith("`")) {
                return (
                  <code
                    key={j}
                    className="px-1.5 py-0.5 rounded text-xs font-mono bg-surface-overlay text-accent border border-border-default"
                  >
                    {ip.slice(1, -1)}
                  </code>
                );
              }
              // Render newlines as <br>
              return (
                <span key={j}>
                  {ip.split("\n").map((line, k, arr) => (
                    <span key={k}>
                      {line}
                      {k < arr.length - 1 && <br />}
                    </span>
                  ))}
                </span>
              );
            })}
          </span>
        );
      })}
    </div>
  );
}

/** Collapsible tool call tree node. */
function ToolCallNode({ call }: { call: ToolCall }) {
  const [expanded, setExpanded] = useState(false);

  const statusColors: Record<string, string> = {
    running: "text-status-warning",
    success: "text-status-live",
    error: "text-status-error",
  };

  return (
    <div className="tool-call-node border-l-2 border-border-default pl-3 ml-1 my-1.5">
      <button
        className="flex items-center gap-2 w-full text-left py-1 group/tool"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
      >
        {expanded ? (
          <ChevronDown size={12} className="text-text-muted shrink-0" />
        ) : (
          <ChevronRight size={12} className="text-text-muted shrink-0" />
        )}
        <Terminal size={12} className="text-accent shrink-0" />
        <span className="text-xs font-mono font-medium text-text-primary group-hover/tool:text-accent transition-colors">
          {call.name}
        </span>
        <span className={`text-[10px] uppercase font-semibold tracking-wider ${statusColors[call.status] || "text-text-muted"}`}>
          {call.status}
        </span>
      </button>
      {expanded && (
        <div className="mt-1 ml-5 space-y-2">
          {/* Input */}
          <div>
            <span className="text-[10px] font-semibold text-text-muted uppercase tracking-wider">Input</span>
            <pre className="mt-1 p-2 text-xs font-mono bg-surface-base border border-border-default rounded overflow-x-auto max-h-48">
              {JSON.stringify(call.input, null, 2)}
            </pre>
          </div>
          {/* Output */}
          {call.output !== undefined && (
            <div>
              <span className="text-[10px] font-semibold text-text-muted uppercase tracking-wider">Output</span>
              <pre className="mt-1 p-2 text-xs font-mono bg-surface-base border border-border-default rounded overflow-x-auto max-h-48">
                {typeof call.output === "string"
                  ? call.output
                  : JSON.stringify(call.output, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** A single chat message bubble. */
function MessageBubble({
  message,
  now,
}: {
  message: ChatMessage;
  now: number;
}) {
  const isUser = message.role === "user";
  const isSystem = message.role === "system";

  const bubbleClasses = isUser
    ? "bg-accent/10 border-accent/20 ml-auto"
    : isSystem
      ? "bg-surface-overlay/60 border-border-default italic"
      : "bg-glass-heavy border-glass-border";

  const roleIcon = isUser ? (
    <User size={14} className="text-accent" />
  ) : isSystem ? (
    <Terminal size={14} className="text-text-muted" />
  ) : (
    <Bot size={14} className="text-chart-purple" />
  );

  const roleLabel = isUser ? "You" : isSystem ? "System" : "Assistant";
  const _now = now; // use for relative timestamp freshness

  return (
    <div
      className={`group/msg relative max-w-[85%] rounded-lg border px-4 py-3 ${bubbleClasses} ${
        isUser ? "self-end" : "self-start"
      }`}
    >
      {/* Header: role + timestamp */}
      <div className="flex items-center gap-2 mb-1.5">
        {roleIcon}
        <span className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">
          {roleLabel}
        </span>
        <span className="text-[10px] text-text-muted ml-auto tabular-nums">
          {relativeTime(message.timestamp)}
        </span>
        {/* Copy button appears on hover */}
        <div className="opacity-0 group-hover/msg:opacity-100 transition-opacity">
          <CopyButton text={message.content} className="!min-w-0 !min-h-0 p-0.5" />
        </div>
      </div>

      {/* Content */}
      <MessageContent content={message.content} />

      {/* Tool calls */}
      {message.tool_calls && message.tool_calls.length > 0 && (
        <div className="mt-3 pt-2 border-t border-border-default">
          <span className="text-[10px] font-semibold text-text-muted uppercase tracking-wider">
            Tool Calls ({message.tool_calls.length})
          </span>
          {message.tool_calls.map((tc) => (
            <ToolCallNode key={tc.id} call={tc} />
          ))}
        </div>
      )}
    </div>
  );
}

/* ================================================================
   Main Playground Page
   ================================================================ */

export function PlaygroundPage() {
  const [searchParams] = useSearchParams();
  const agentName = searchParams.get("agent") || "default";
  const { showToast } = useToast();

  /* ── State ──────────────────────────────────────────────────── */
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const [now, setNow] = useState(Date.now());

  /* ── Auto-scroll ────────────────────────────────────────────── */
  const scrollRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  const [showScrollDown, setShowScrollDown] = useState(false);

  const checkIfAtBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    isAtBottomRef.current = atBottom;
    setShowScrollDown(!atBottom);
  }, []);

  const scrollToBottom = useCallback((smooth = true) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({
      top: el.scrollHeight,
      behavior: smooth ? "smooth" : "instant",
    });
    isAtBottomRef.current = true;
    setShowScrollDown(false);
  }, []);

  // Auto-scroll when messages change (only if user is at bottom)
  useEffect(() => {
    if (isAtBottomRef.current) {
      scrollToBottom(true);
    }
  }, [messages, scrollToBottom]);

  // Update timestamps every 15s
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(interval);
  }, []);

  /* ── Filtered messages ──────────────────────────────────────── */
  const filteredMessages = useMemo(() => {
    if (!searchQuery.trim()) return messages;
    const q = searchQuery.toLowerCase();
    return messages.filter(
      (m) =>
        m.content.toLowerCase().includes(q) ||
        m.role.toLowerCase().includes(q) ||
        m.tool_calls?.some((tc) => tc.name.toLowerCase().includes(q)),
    );
  }, [messages, searchQuery]);

  /* ── Send message ───────────────────────────────────────────── */
  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || sending) return;

    const userMsg: ChatMessage = {
      id: nextId(),
      role: "user",
      content: text,
      timestamp: Date.now(),
    };

    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setSending(true);

    try {
      const response = await apiRequest<{
        message?: string;
        content?: string;
        tool_calls?: ToolCall[];
      }>(`/api/v1/agents/${agentName}/chat`, "POST", {
        message: text,
        history: messages.map((m) => ({ role: m.role, content: m.content })),
      });

      const assistantMsg: ChatMessage = {
        id: nextId(),
        role: "assistant",
        content: response.message || response.content || "No response received.",
        timestamp: Date.now(),
        tool_calls: response.tool_calls,
      };

      setMessages((prev) => [...prev, assistantMsg]);
    } catch (err) {
      const errorMsg: ChatMessage = {
        id: nextId(),
        role: "system",
        content: `Error: ${err instanceof Error ? err.message : "Request failed"}`,
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, errorMsg]);
      showToast("Failed to send message", "error");
    } finally {
      setSending(false);
    }
  }, [input, sending, agentName, messages, showToast]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void sendMessage();
      }
    },
    [sendMessage],
  );

  const handleSubmit = useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      void sendMessage();
    },
    [sendMessage],
  );

  /* ── Clear chat ─────────────────────────────────────────────── */
  const handleClear = useCallback(() => {
    setMessages([]);
    setClearConfirmOpen(false);
    showToast("Chat cleared", "success");
  }, [showToast]);

  /* ── Keyboard shortcut: Cmd/Ctrl+K for search ──────────────── */
  useEffect(() => {
    const handler = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setSearchOpen((prev) => !prev);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  /* ── Textarea auto-resize ───────────────────────────────────── */
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [input]);

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)]">
      {/* ── Header bar ────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border-default bg-surface-raised/40">
        <div className="flex items-center gap-3">
          <Bot size={18} className="text-chart-purple" />
          <div>
            <h1 className="text-sm font-semibold text-text-primary">
              Playground
            </h1>
            <p className="text-[10px] text-text-muted">
              Chatting with{" "}
              <span className="font-mono text-accent">{agentName}</span>
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Search toggle */}
          <button
            className="btn btn-ghost text-xs gap-1.5"
            onClick={() => setSearchOpen(!searchOpen)}
            title="Search messages (Cmd+K)"
            aria-label="Toggle search"
          >
            <Search size={14} />
            <span className="hidden sm:inline">Search</span>
            <kbd className="hidden sm:inline-block text-[9px] font-mono px-1 py-0.5 rounded bg-surface-overlay border border-border-default text-text-muted">
              {"\u2318"}K
            </kbd>
          </button>

          {/* Clear chat */}
          <button
            className="btn btn-ghost text-xs gap-1.5 hover:text-status-error"
            onClick={() => {
              if (messages.length === 0) return;
              setClearConfirmOpen(true);
            }}
            disabled={messages.length === 0}
            title="Clear chat"
            aria-label="Clear chat"
          >
            <Trash2 size={14} />
            <span className="hidden sm:inline">Clear</span>
          </button>
        </div>
      </div>

      {/* ── Search bar (collapsible) ──────────────────────────── */}
      {searchOpen && (
        <div className="px-4 py-2 border-b border-border-default bg-surface-raised/30 flex items-center gap-2">
          <Search size={14} className="text-text-muted shrink-0" />
          <input
            type="text"
            placeholder="Filter messages..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="flex-1 text-xs bg-transparent border-0 outline-none focus:ring-0 text-text-primary placeholder:text-text-muted"
            autoFocus
          />
          {searchQuery && (
            <span className="text-[10px] text-text-muted tabular-nums shrink-0">
              {filteredMessages.length} / {messages.length}
            </span>
          )}
          <button
            className="p-1 text-text-muted hover:text-text-primary transition-colors"
            onClick={() => {
              setSearchOpen(false);
              setSearchQuery("");
            }}
            aria-label="Close search"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {/* ── Messages area ─────────────────────────────────────── */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-4 py-6"
        onScroll={checkIfAtBottom}
      >
        {filteredMessages.length === 0 && !searchQuery ? (
          <div className="flex flex-col items-center justify-center h-full text-center gap-4">
            <div className="w-16 h-16 rounded-2xl bg-surface-overlay/60 border border-border-default flex items-center justify-center">
              <Bot size={28} className="text-chart-purple" />
            </div>
            <div>
              <p className="text-sm font-medium text-text-primary">
                Start a conversation
              </p>
              <p className="text-xs text-text-muted mt-1">
                Send a message to <span className="font-mono text-accent">{agentName}</span> below
              </p>
            </div>
          </div>
        ) : filteredMessages.length === 0 && searchQuery ? (
          <div className="flex flex-col items-center justify-center h-full text-center gap-2">
            <Search size={24} className="text-text-muted" />
            <p className="text-sm text-text-muted">
              No messages match "{searchQuery}"
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3 max-w-3xl mx-auto">
            {filteredMessages.map((msg) => (
              <MessageBubble key={msg.id} message={msg} now={now} />
            ))}
            {sending && (
              <div className="self-start flex items-center gap-2 px-4 py-3 rounded-lg border bg-glass-heavy border-glass-border max-w-[85%]">
                <div className="flex gap-1">
                  <span className="chat-typing-dot" />
                  <span className="chat-typing-dot" style={{ animationDelay: "0.15s" }} />
                  <span className="chat-typing-dot" style={{ animationDelay: "0.3s" }} />
                </div>
                <span className="text-xs text-text-muted">Thinking...</span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Scroll-to-bottom fab ──────────────────────────────── */}
      {showScrollDown && (
        <div className="absolute bottom-28 left-1/2 -translate-x-1/2 z-10">
          <button
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs
              bg-surface-overlay/90 border border-border-default text-text-secondary
              hover:text-text-primary hover:border-border-strong transition-all
              shadow-lg backdrop-blur-sm"
            onClick={() => scrollToBottom(true)}
            aria-label="Scroll to bottom"
          >
            <ArrowDown size={12} />
            New messages
          </button>
        </div>
      )}

      {/* ── Input area ────────────────────────────────────────── */}
      <form
        onSubmit={handleSubmit}
        className="px-4 py-3 border-t border-border-default bg-surface-raised/40"
      >
        <div className="flex items-end gap-2 max-w-3xl mx-auto">
          <div className="flex-1 relative">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={`Message ${agentName}...`}
              rows={1}
              disabled={sending}
              className="w-full resize-none text-sm bg-surface-base border border-border-default rounded-lg
                px-4 py-3 pr-12 min-h-[var(--touch-target-min)] max-h-40
                focus:border-accent focus:ring-1 focus:ring-accent
                placeholder:text-text-muted disabled:opacity-50"
              aria-label="Chat message input"
            />
            <span className="absolute right-3 bottom-3 text-[10px] text-text-muted pointer-events-none">
              {input.length > 0 ? `${input.length}` : ""}
            </span>
          </div>
          <button
            type="submit"
            disabled={!input.trim() || sending}
            className="btn btn-primary min-h-[var(--touch-target-min)] min-w-[var(--touch-target-min)] shrink-0"
            aria-label="Send message"
          >
            <Send size={16} />
          </button>
        </div>
        <p className="text-center text-[10px] text-text-muted mt-2">
          Press <kbd className="font-mono px-1 py-0.5 rounded bg-surface-overlay border border-border-default text-[9px]">Enter</kbd> to send, <kbd className="font-mono px-1 py-0.5 rounded bg-surface-overlay border border-border-default text-[9px]">Shift+Enter</kbd> for new line
        </p>
      </form>

      {/* ── Clear confirm dialog ──────────────────────────────── */}
      {clearConfirmOpen && (
        <ConfirmDialog
          title="Clear Chat"
          description={`This will remove all ${messages.length} messages from this session. This action cannot be undone.`}
          confirmLabel="Clear All"
          tone="danger"
          onConfirm={handleClear}
          onCancel={() => setClearConfirmOpen(false)}
        />
      )}
    </div>
  );
}
