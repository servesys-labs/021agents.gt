import { useState, useRef, useEffect, type KeyboardEvent } from "react";
import { Send, Bot, User, Loader2 } from "lucide-react";

import { apiPost } from "../../../lib/api";
import { useToast } from "../../../components/common/ToastProvider";

/* ── Props ────────────────────────────────────────────────────── */

type PlaygroundTabProps = {
  agentName: string;
};

/* ── Types ────────────────────────────────────────────────────── */

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

type RuntimeResponse = {
  output?: string;
  response?: string;
  result?: string;
  message?: string;
  messages?: Array<{ role: string; content: string }>;
};

/* ── Helpers ──────────────────────────────────────────────────── */

let _msgId = 0;
function nextId(): string {
  return `pg-${Date.now()}-${++_msgId}`;
}

/* ── Component ────────────────────────────────────────────────── */

export const PlaygroundTab = ({ agentName }: PlaygroundTabProps) => {
  const { showToast } = useToast();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);

  /* Auto-scroll to bottom */
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  /* ── Send message ───────────────────────────────────────────── */

  const handleSend = async () => {
    const text = input.trim();
    if (!text || sending) return;

    const userMsg: ChatMessage = { id: nextId(), role: "user", content: text };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setSending(true);

    try {
      const res = await apiPost<RuntimeResponse>("/api/v1/runtime-proxy/agent/run", {
        agent_name: agentName,
        input: text,
      });

      /* The runtime may return data in various shapes */
      let assistantText = "";
      if (res.output) {
        assistantText = res.output;
      } else if (res.response) {
        assistantText = res.response;
      } else if (res.result) {
        assistantText = res.result;
      } else if (res.message) {
        assistantText = res.message;
      } else if (res.messages && Array.isArray(res.messages)) {
        const last = [...res.messages].reverse().find((m) => m.role === "assistant");
        assistantText = last?.content ?? JSON.stringify(res, null, 2);
      } else {
        assistantText = JSON.stringify(res, null, 2);
      }

      const assistantMsg: ChatMessage = {
        id: nextId(),
        role: "assistant",
        content: assistantText,
      };
      setMessages((prev) => [...prev, assistantMsg]);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to send message", "error");
      const errorMsg: ChatMessage = {
        id: nextId(),
        role: "assistant",
        content: `Error: ${err instanceof Error ? err.message : "Request failed"}`,
      };
      setMessages((prev) => [...prev, errorMsg]);
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  };

  /* ── Key handler ────────────────────────────────────────────── */

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  /* ── Render ─────────────────────────────────────────────────── */

  return (
    <div className="card flex flex-col" style={{ height: "calc(100vh - 20rem)", minHeight: "24rem" }}>
      {/* Header */}
      <div className="flex items-center justify-between pb-3 border-b" style={{ borderColor: "var(--color-border-default)" }}>
        <div>
          <h3 className="text-sm font-semibold text-text-primary">Playground</h3>
          <p className="text-xs text-text-muted mt-0.5">
            Chat with <span className="font-mono text-text-secondary">{agentName}</span> in a live session
          </p>
        </div>
        {messages.length > 0 && (
          <button
            type="button"
            onClick={() => setMessages([])}
            className="btn btn-ghost text-xs"
            style={{ minHeight: "var(--touch-target-min)" }}
          >
            Clear
          </button>
        )}
      </div>

      {/* Messages area */}
      <div className="flex-1 overflow-y-auto py-4 space-y-4" style={{ minHeight: 0 }}>
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-text-muted">
            <Bot size={32} />
            <p className="text-sm">Send a message to start chatting</p>
          </div>
        ) : (
          messages.map((msg) => (
            <div key={msg.id} className="flex items-start gap-3">
              <div
                className="w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0"
                style={{
                  backgroundColor:
                    msg.role === "user"
                      ? "var(--color-accent-muted)"
                      : "var(--color-surface-overlay)",
                }}
              >
                {msg.role === "user" ? (
                  <User size={14} className="text-accent" />
                ) : (
                  <Bot size={14} className="text-text-secondary" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <span className="block text-xs font-semibold text-text-muted uppercase tracking-wide mb-1">
                  {msg.role === "user" ? "You" : agentName}
                </span>
                <div className="text-sm text-text-secondary whitespace-pre-wrap break-words leading-relaxed">
                  {msg.content}
                </div>
              </div>
            </div>
          ))
        )}

        {sending && (
          <div className="flex items-start gap-3">
            <div
              className="w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0"
              style={{ backgroundColor: "var(--color-surface-overlay)" }}
            >
              <Bot size={14} className="text-text-secondary" />
            </div>
            <div className="flex items-center gap-2 py-1">
              <Loader2 size={14} className="text-text-muted animate-spin" />
              <span className="text-xs text-text-muted">Thinking...</span>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      <div className="pt-3 border-t" style={{ borderColor: "var(--color-border-default)" }}>
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type a message... (Shift+Enter for new line)"
            rows={2}
            className="flex-1 text-sm resize-none"
            style={{ minHeight: "var(--touch-target-min)" }}
            disabled={sending}
          />
          <button
            type="button"
            onClick={() => void handleSend()}
            disabled={!input.trim() || sending}
            className="btn btn-primary flex-shrink-0"
            style={{ minWidth: "var(--touch-target-min)", minHeight: "var(--touch-target-min)" }}
            aria-label="Send message"
          >
            <Send size={16} />
          </button>
        </div>
      </div>
    </div>
  );
};
