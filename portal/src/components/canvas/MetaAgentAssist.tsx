import { useState, useRef, useEffect } from "react";
import { Sparkles, Send, Loader2, X, ChevronUp, ChevronDown } from "lucide-react";

type Props = {
  onSubmit: (prompt: string) => void;
  isProcessing: boolean;
  lastResult?: string;
};

export function MetaAgentAssist({ onSubmit, isProcessing, lastResult }: Props) {
  const [expanded, setExpanded] = useState(false);
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

  const handleSubmit = () => {
    const trimmed = input.trim();
    if (!trimmed || isProcessing) return;
    setHistory((prev) => [...prev, { role: "user", text: trimmed }]);
    onSubmit(trimmed);
    setInput("");
    setExpanded(true);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="absolute bottom-6 right-6 z-40 w-[360px]">
      {/* Conversation history */}
      {expanded && history.length > 0 && (
        <div className="mb-2 rounded-xl border border-border-default bg-surface-raised shadow-[0_8px_40px_rgba(0,0,0,0.4)] overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2 border-b border-border-default">
            <div className="flex items-center gap-2">
              <Sparkles size={12} className="text-accent" />
              <span className="text-[11px] font-semibold text-text-primary">Meta-Agent</span>
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setHistory([])}
                className="text-[10px] text-text-muted hover:text-text-secondary transition-colors px-1.5"
              >
                Clear
              </button>
              <button
                onClick={() => setExpanded(false)}
                className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-surface-overlay transition-colors"
              >
                <ChevronDown size={12} />
              </button>
            </div>
          </div>
          <div ref={historyRef} className="max-h-[240px] overflow-y-auto p-3 space-y-2.5">
            {history.map((msg, i) => (
              <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                <div
                  className={`max-w-[85%] px-3 py-2 rounded-lg text-[12px] leading-relaxed ${
                    msg.role === "user"
                      ? "bg-accent text-white rounded-br-sm"
                      : "bg-surface-overlay text-text-secondary rounded-bl-sm"
                  }`}
                >
                  {msg.text}
                </div>
              </div>
            ))}
            {isProcessing && (
              <div className="flex justify-start">
                <div className="bg-surface-overlay px-3 py-2 rounded-lg rounded-bl-sm">
                  <div className="flex items-center gap-1.5">
                    <div className="w-1.5 h-1.5 rounded-full bg-accent animate-bounce" style={{ animationDelay: "0ms" }} />
                    <div className="w-1.5 h-1.5 rounded-full bg-accent animate-bounce" style={{ animationDelay: "150ms" }} />
                    <div className="w-1.5 h-1.5 rounded-full bg-accent animate-bounce" style={{ animationDelay: "300ms" }} />
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Input bar */}
      <div className="meta-agent-bar flex items-end gap-2 px-3 py-2.5">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex-shrink-0 w-7 h-7 rounded-lg bg-accent-muted flex items-center justify-center text-accent hover:bg-accent hover:text-white transition-colors"
        >
          <Sparkles size={14} />
        </button>
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Describe an agent to create..."
          rows={1}
          className="flex-1 bg-transparent border-none outline-none text-[12px] text-text-primary placeholder:text-text-muted resize-none max-h-[80px] py-1"
          style={{ minHeight: "24px" }}
          disabled={isProcessing}
        />
        <button
          onClick={handleSubmit}
          disabled={!input.trim() || isProcessing}
          className="flex-shrink-0 w-7 h-7 rounded-lg flex items-center justify-center transition-colors disabled:opacity-30 disabled:cursor-not-allowed bg-accent text-white hover:bg-accent-hover"
        >
          {isProcessing ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <Send size={13} />
          )}
        </button>
      </div>
    </div>
  );
}
