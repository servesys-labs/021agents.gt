import { useState, useRef, useEffect } from "react";
import { Check, Loader2, X as XIcon, ChevronUp, ChevronDown, Terminal, Trash2 } from "lucide-react";

export type LogEntry = {
  id: string;
  message: string;
  status: "done" | "running" | "error";
  timestamp?: number;
};

type Props = {
  entries: LogEntry[];
  onClear?: () => void;
};

export function AgentLog({ entries, onClear }: Props) {
  const [expanded, setExpanded] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll on new entries
  useEffect(() => {
    if (scrollRef.current && expanded) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries, expanded]);

  const statusIcon = (status: LogEntry["status"]) => {
    switch (status) {
      case "done":
        return <Check size={11} className="text-status-live" />;
      case "running":
        return <Loader2 size={11} className="text-accent animate-spin" />;
      case "error":
        return <XIcon size={11} className="text-status-error" />;
      default:
        return null;
    }
  };

  const formatTime = (ts?: number) => {
    if (!ts) return "";
    const d = new Date(ts);
    return d.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  };

  const runningCount = entries.filter((e) => e.status === "running").length;
  const errorCount = entries.filter((e) => e.status === "error").length;

  return (
    <div className="absolute bottom-6 left-16 z-40">
      {/* Expanded log panel */}
      {expanded && entries.length > 0 && (
        <div className="agent-log-panel mb-2 w-[280px] overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-3 py-2 border-b border-border-default">
            <div className="flex items-center gap-2">
              <Terminal size={12} className="text-accent" />
              <span className="text-[11px] font-semibold text-text-primary">Activity Log</span>
              <span className="text-[10px] text-text-muted">({entries.length})</span>
            </div>
            <div className="flex items-center gap-1">
              {onClear && (
                <button
                  onClick={onClear}
                  className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-surface-overlay transition-colors"
                  title="Clear log"
                >
                  <Trash2 size={11} />
                </button>
              )}
              <button
                onClick={() => setExpanded(false)}
                className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-surface-overlay transition-colors"
              >
                <ChevronDown size={12} />
              </button>
            </div>
          </div>

          {/* Entries */}
          <div ref={scrollRef} className="max-h-[220px] overflow-y-auto px-3 py-2 space-y-1">
            {entries.map((entry) => (
              <div key={entry.id} className="flex items-start gap-2 group">
                <span className="mt-0.5 flex-shrink-0">{statusIcon(entry.status)}</span>
                <div className="flex-1 min-w-0">
                  <span className="text-[11px] text-text-secondary leading-tight block">
                    {entry.message}
                  </span>
                </div>
                {entry.timestamp && (
                  <span className="text-[9px] text-text-muted font-mono flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                    {formatTime(entry.timestamp)}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Toggle bar */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 px-3 py-1.5 rounded-xl border border-border-default glass-dropdown hover:brightness-110 transition-all"
      >
        <Terminal size={12} className="text-accent" />
        <span className="text-[11px] text-text-secondary font-medium">Log</span>
        {runningCount > 0 && (
          <span className="flex items-center gap-1">
            <Loader2 size={10} className="text-accent animate-spin" />
            <span className="text-[10px] text-accent">{runningCount}</span>
          </span>
        )}
        {errorCount > 0 && (
          <span className="text-[10px] text-status-error font-medium">{errorCount} err</span>
        )}
        {expanded ? (
          <ChevronDown size={12} className="text-text-muted" />
        ) : (
          <ChevronUp size={12} className="text-text-muted" />
        )}
      </button>
    </div>
  );
}
