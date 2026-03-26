import { useCallback, useEffect, useRef, useState } from "react";
import { MessageSquare, X, Send, Loader2, Trash2, Sparkles, RotateCcw } from "lucide-react";
import { useMetaAgent, type ChatMessage } from "../../providers/MetaAgentProvider";

/* ── Floating Action Button + Chat Panel ────────────────────────── */

export function MetaAgentFAB() {
  const {
    messages,
    processing,
    panelOpen,
    suggestions,
    send,
    openPanel,
    closePanel,
    clearHistory,
  } = useMetaAgent();

  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  // Focus input when panel opens
  useEffect(() => {
    if (panelOpen) {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [panelOpen]);

  // Close on Escape
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape" && panelOpen) closePanel();
    };
    document.addEventListener("keydown", handleEsc);
    return () => document.removeEventListener("keydown", handleEsc);
  }, [panelOpen, closePanel]);

  /* ── Focus trap: Tab cycles within panel ──────────────────────── */
  const handleFocusTrap = useCallback(
    (e: KeyboardEvent) => {
      if (e.key !== "Tab" || !panelOpen || !panelRef.current) return;

      const focusable = panelRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    },
    [panelOpen],
  );

  useEffect(() => {
    document.addEventListener("keydown", handleFocusTrap);
    return () => document.removeEventListener("keydown", handleFocusTrap);
  }, [handleFocusTrap]);

  const handleSubmit = (text?: string) => {
    const msg = (text || input).trim();
    if (!msg || processing) return;
    void send(msg);
    setInput("");
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  /* ── Retry a failed message ───────────────────────────────────── */
  const handleRetry = (failedMsg: ChatMessage) => {
    // Find the user message that preceded this error
    const idx = messages.indexOf(failedMsg);
    const userMsg = idx > 0 ? messages[idx - 1] : null;
    if (userMsg?.role === "user") {
      void send(userMsg.text);
    }
  };

  const isErrorMessage = (msg: ChatMessage) =>
    msg.role === "assistant" && msg.text.startsWith("Something went wrong:");

  return (
    <>
      {/* Chat panel */}
      {panelOpen && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-40"
            onClick={closePanel}
            aria-hidden="true"
          />

          {/* Panel — dynamic height, responsive width */}
          <div
            ref={panelRef}
            className="fixed bottom-20 right-4 sm:right-6 z-50 w-[calc(100vw-2rem)] sm:w-[400px] flex flex-col rounded-2xl border overflow-hidden glass-medium"
            style={{
              maxHeight: "calc(100vh - 8rem)",
              animation: "fadeIn 0.15s ease-out",
            }}
            role="dialog"
            aria-modal="true"
            aria-label="Meta-Agent Chat"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-border-default flex-shrink-0">
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 rounded-lg bg-accent/15 flex items-center justify-center">
                  <Sparkles size={14} className="text-accent" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-text-primary">Meta-Agent</p>
                  <p className="text-[10px] text-text-muted">AI copilot for your agent platform</p>
                </div>
              </div>
              <div className="flex items-center gap-1">
                {messages.length > 0 && (
                  <button
                    onClick={clearHistory}
                    className="p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-surface-overlay transition-colors"
                    title="Clear chat"
                    aria-label="Clear chat history"
                  >
                    <Trash2 size={13} />
                  </button>
                )}
                <button
                  onClick={closePanel}
                  className="p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-surface-overlay transition-colors"
                  aria-label="Close chat"
                >
                  <X size={14} />
                </button>
              </div>
            </div>

            {/* Messages area — aria-live for screen reader announcements */}
            <div
              className="flex-1 overflow-y-auto min-h-0"
              aria-live="polite"
              aria-relevant="additions"
            >
              {messages.length === 0 ? (
                /* Empty state: context-aware suggestions */
                <div className="p-4 space-y-2">
                  <p className="text-xs text-text-muted mb-3">
                    What would you like help with?
                  </p>
                  {suggestions.map((s) => (
                    <button
                      key={s.label}
                      onClick={() => handleSubmit(s.prompt)}
                      className="w-full flex items-center gap-2.5 px-3 py-2.5 text-left text-xs text-text-secondary bg-surface-base border border-border-default rounded-xl hover:bg-surface-hover hover:border-accent/30 transition-colors"
                    >
                      <span className="w-6 h-6 rounded-md bg-accent/10 flex items-center justify-center text-accent text-[10px] font-bold flex-shrink-0">
                        {s.icon || "?"}
                      </span>
                      <span>{s.label}</span>
                    </button>
                  ))}
                </div>
              ) : (
                /* Chat messages */
                <div className="p-4 space-y-3">
                  {messages.map((msg, i) => (
                    <div key={`${msg.timestamp}-${i}`}>
                      <MessageBubble message={msg} />
                      {/* Retry button for error messages */}
                      {isErrorMessage(msg) && (
                        <div className="flex justify-start mt-1 ml-1">
                          <button
                            onClick={() => handleRetry(msg)}
                            disabled={processing}
                            className="inline-flex items-center gap-1 px-2 py-1 text-[10px] text-text-muted hover:text-accent transition-colors rounded-md hover:bg-accent/5 disabled:opacity-50"
                          >
                            <RotateCcw size={10} />
                            Retry
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                  {processing && <TypingIndicator />}
                  <div ref={messagesEndRef} />
                </div>
              )}
            </div>

            {/* Input area */}
            <div className="border-t border-border-default px-3 py-3 flex-shrink-0">
              <div className="relative bg-surface-base border border-border-default rounded-xl focus-within:border-accent/50 transition-colors">
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Ask the meta-agent..."
                  rows={2}
                  className="w-full bg-transparent border-none outline-none text-xs leading-relaxed text-text-primary placeholder:text-text-muted resize-none px-3 pt-2.5 pb-8"
                  disabled={processing}
                />
                <div className="absolute bottom-2 right-2 flex items-center gap-1.5">
                  <span className="text-[9px] text-text-muted hidden sm:inline">
                    Enter to send
                  </span>
                  <button
                    onClick={() => handleSubmit()}
                    disabled={!input.trim() || processing}
                    className="w-6 h-6 rounded-md flex items-center justify-center transition-all disabled:opacity-20 text-text-muted hover:text-accent hover:bg-accent/10"
                    aria-label="Send message"
                  >
                    {processing ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      <Send size={12} />
                    )}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </>
      )}

      {/* FAB button — responsive positioning */}
      <button
        onClick={panelOpen ? closePanel : openPanel}
        className="fixed bottom-4 right-4 sm:bottom-6 sm:right-6 z-50 w-12 h-12 rounded-full bg-accent text-white shadow-lg hover:bg-accent-hover transition-all flex items-center justify-center group"
        aria-label={panelOpen ? "Close meta-agent" : "Open meta-agent"}
        style={{ minWidth: 48, minHeight: 48 }}
      >
        {panelOpen ? (
          <X size={20} />
        ) : (
          <>
            <MessageSquare size={20} />
            {processing && (
              <span
                className="absolute -top-0.5 -right-0.5 w-3 h-3 rounded-full bg-status-live border-2 border-surface-raised animate-pulse"
                aria-label="Processing"
              />
            )}
          </>
        )}
        {/* Tooltip — hidden on mobile */}
        {!panelOpen && (
          <span className="absolute right-full mr-2 px-2 py-1 rounded-md bg-surface-overlay text-text-primary text-[11px] whitespace-nowrap opacity-0 pointer-events-none group-hover:opacity-100 transition-opacity shadow-dropdown border border-border-default hidden sm:block">
            Meta-Agent
          </span>
        )}
      </button>
    </>
  );
}

/* ── Message Bubble ─────────────────────────────────────────────── */

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] px-3 py-2 rounded-xl text-xs leading-relaxed ${
          isUser
            ? "bg-accent/15 text-text-primary rounded-br-sm"
            : "bg-surface-base text-text-secondary rounded-bl-sm border border-border-default"
        }`}
      >
        <div className="whitespace-pre-wrap">{message.text}</div>
      </div>
    </div>
  );
}

/* ── Typing Indicator ───────────────────────────────────────────── */

function TypingIndicator() {
  return (
    <div className="flex justify-start" aria-label="Meta-agent is thinking">
      <div className="bg-surface-base px-3 py-2 rounded-xl rounded-bl-sm border border-border-default">
        <div className="flex items-center gap-1.5" role="status" aria-label="Typing">
          <div className="w-1.5 h-1.5 rounded-full bg-text-muted animate-bounce" style={{ animationDelay: "0ms" }} />
          <div className="w-1.5 h-1.5 rounded-full bg-text-muted animate-bounce" style={{ animationDelay: "150ms" }} />
          <div className="w-1.5 h-1.5 rounded-full bg-text-muted animate-bounce" style={{ animationDelay: "300ms" }} />
        </div>
      </div>
    </div>
  );
}
