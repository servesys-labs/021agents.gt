import { useState, useRef, useEffect, type ReactNode } from "react";
import { Sparkles, Send, Loader2, Settings, MessageSquare } from "lucide-react";

type Props = {
  onSubmit: (prompt: string) => void;
  isProcessing: boolean;
  lastResult?: string;
};

/* ── Quick-action suggestion chips (like Railway) ──────────────── */
const SUGGESTIONS = [
  { icon: "?", label: "How can I configure my agent?" },
  { icon: "🚀", label: "Deploy to production" },
  { icon: "⚙", label: "Manage environment variables" },
  { icon: "⏰", label: "Set up a cron schedule" },
  { icon: "❓", label: "Why is my agent failing?" },
  { icon: "📦", label: "Deploy Knowledge Base" },
];

export function MetaAgentAssist({ onSubmit, isProcessing, lastResult }: Props) {
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<Array<{ role: "user" | "assistant"; text: string }>>([]);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const historyRef = useRef<HTMLDivElement>(null);

  // Auto-scroll history
  useEffect(() => {
    if (historyRef.current) {
      historyRef.current.scrollTop = historyRef.current.scrollHeight;
    }
  }, [history]);

  // Add result to history
  useEffect(() => {
    if (lastResult) {
      setHistory((prev) => [...prev, { role: "assistant", text: lastResult }]);
    }
  }, [lastResult]);

  const handleSubmit = (text?: string) => {
    const trimmed = (text || input).trim();
    if (!trimmed || isProcessing) return;
    setHistory((prev) => [...prev, { role: "user", text: trimmed }]);
    onSubmit(trimmed);
    setInput("");
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="h-full flex flex-col bg-surface-raised border-l border-border-default flex-shrink-0"
      style={{ width: 340 }}>

      {/* ── Header ──────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border-default flex-shrink-0">
        <div className="flex items-center gap-2">
          <MessageSquare size={14} className="text-accent" />
          <span className="text-sm font-semibold text-text-primary">Agent</span>
        </div>
        <button className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-surface-overlay transition-colors">
          <Settings size={13} />
        </button>
      </div>

      {/* ── Chat history ────────────────────────────────────── */}
      <div ref={historyRef} className="flex-1 overflow-y-auto">
        {history.length === 0 ? (
          /* Empty state: show suggestion chips like Railway */
          <div className="p-5">
            <div className="flex flex-col gap-2">
              {SUGGESTIONS.map((s, i) => (
                <button
                  key={i}
                  onClick={() => handleSubmit(s.label)}
                  className="flex items-center gap-2 px-4 py-3 text-[13px] text-text-secondary bg-surface-base border border-border-default rounded-xl hover:bg-surface-hover hover:border-border-hover transition-colors text-left leading-normal"
                >
                  <span className="text-[13px] flex-shrink-0">{s.icon}</span>
                  <span>{s.label}</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          /* Chat messages */
          <div className="p-3 space-y-3">
            {history.map((msg, i) => (
              <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                <div
                  className={`max-w-[90%] px-3 py-2 rounded-lg text-[12px] leading-relaxed ${
                    msg.role === "user"
                      ? "bg-accent/15 text-text-primary rounded-br-sm"
                      : "bg-surface-base text-text-secondary rounded-bl-sm border border-border-default"
                  }`}
                >
                  {msg.text}
                </div>
              </div>
            ))}
            {isProcessing && (
              <div className="flex justify-start">
                <div className="bg-surface-base px-3 py-2 rounded-lg rounded-bl-sm border border-border-default">
                  <div className="flex items-center gap-1.5">
                    <div className="w-1.5 h-1.5 rounded-full bg-accent animate-bounce" style={{ animationDelay: "0ms" }} />
                    <div className="w-1.5 h-1.5 rounded-full bg-accent animate-bounce" style={{ animationDelay: "150ms" }} />
                    <div className="w-1.5 h-1.5 rounded-full bg-accent animate-bounce" style={{ animationDelay: "300ms" }} />
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Input area (pinned to bottom like Railway) ───── */}
      <div className="border-t border-border-default p-4 flex-shrink-0">
        <div className="flex items-end gap-2 bg-surface-base border border-border-default rounded-xl px-4 py-3 focus-within:border-accent/40 transition-colors">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Develop, debug, deploy anything..."
            rows={1}
            className="flex-1 bg-transparent border-none outline-none text-[13px] text-text-primary placeholder:text-text-muted resize-none max-h-[100px] py-0.5"
            style={{ minHeight: "24px" }}
            disabled={isProcessing}
          />
          <button
            onClick={() => handleSubmit()}
            disabled={!input.trim() || isProcessing}
            className="flex-shrink-0 w-7 h-7 rounded-lg flex items-center justify-center transition-colors disabled:opacity-30 disabled:cursor-not-allowed text-text-muted hover:text-accent"
          >
            {isProcessing ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Send size={14} />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
