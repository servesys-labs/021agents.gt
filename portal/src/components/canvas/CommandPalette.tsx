import { useState, useEffect, useRef, useCallback } from "react";
import {
  Search,
  Bot,
  BookOpen,
  Database,
  Plug,
  Server,
  Workflow,
  Clock,
  Webhook,
  ShieldCheck,
  FolderKanban,
  Tag,
  Cpu,
  BarChart3,
  Activity,
  Settings,
  CreditCard,
  MessageSquare,
  Brain,
  FlaskConical,
  Command,
} from "lucide-react";

/* ── Command definition ────────────────────────────────────────── */
export type CommandAction =
  | "add-agent" | "add-knowledge" | "add-datasource" | "add-connector" | "add-mcp"
  | "open-workflows" | "open-schedules" | "open-webhooks"
  | "open-governance" | "open-projects" | "open-releases"
  | "open-infrastructure"
  | "open-overview" | "open-observability" | "open-metrics"
  | "open-settings" | "open-billing";

type CommandItem = {
  id: CommandAction;
  label: string;
  description: string;
  icon: React.ReactNode;
  group: string;
  shortcut?: string;
};

const commands: CommandItem[] = [
  // Add to canvas
  { id: "add-agent", label: "Add Agent", description: "Create a new agent node on the canvas", icon: <Bot size={14} />, group: "Add to Canvas", shortcut: "A" },
  { id: "add-knowledge", label: "Add Knowledge Base", description: "Add a RAG knowledge source", icon: <BookOpen size={14} />, group: "Add to Canvas", shortcut: "K" },
  { id: "add-datasource", label: "Add Data Source", description: "Connect a database", icon: <Database size={14} />, group: "Add to Canvas" },
  { id: "add-connector", label: "Add Connector", description: "Add an OAuth integration", icon: <Plug size={14} />, group: "Add to Canvas" },
  { id: "add-mcp", label: "Add MCP Server", description: "Connect an MCP tool server", icon: <Server size={14} />, group: "Add to Canvas" },

  // Operations
  { id: "open-workflows", label: "Workflows & Jobs", description: "Manage workflow definitions and job runs", icon: <Workflow size={14} />, group: "Operations" },
  { id: "open-schedules", label: "Schedules", description: "Create and manage cron schedules", icon: <Clock size={14} />, group: "Operations" },
  { id: "open-webhooks", label: "Webhooks", description: "Manage webhook endpoints and deliveries", icon: <Webhook size={14} />, group: "Operations" },
  { id: "open-governance", label: "Governance", description: "Policies, budgets, and approval rules", icon: <ShieldCheck size={14} />, group: "Operations" },
  { id: "open-projects", label: "Projects & Environments", description: "Manage projects, env vars, and secrets", icon: <FolderKanban size={14} />, group: "Operations" },
  { id: "open-releases", label: "Release Channels", description: "Manage channels, promote, canary splits", icon: <Tag size={14} />, group: "Operations" },
  { id: "open-infrastructure", label: "Infrastructure", description: "GPU endpoints and retention policies", icon: <Cpu size={14} />, group: "Operations" },

  // Navigate
  { id: "open-overview", label: "Overview Dashboard", description: "System-wide KPIs and activity", icon: <BarChart3 size={14} />, group: "Navigate" },
  { id: "open-observability", label: "Observability", description: "Sessions, logs, and traces", icon: <Activity size={14} />, group: "Navigate" },
  { id: "open-metrics", label: "Metrics & Evolution", description: "Agent performance over time", icon: <BarChart3 size={14} />, group: "Navigate" },
  { id: "open-settings", label: "Settings", description: "Team, API keys, and profile", icon: <Settings size={14} />, group: "Navigate" },
  { id: "open-billing", label: "Billing & Usage", description: "Plan, usage breakdown, invoices", icon: <CreditCard size={14} />, group: "Navigate" },
];

/* ── Props ──────────────────────────────────────────────────────── */
interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  onAction: (action: CommandAction) => void;
}

/* ── Component ─────────────────────────────────────────────────── */
export function CommandPalette({ open, onClose, onAction }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = query.trim()
    ? commands.filter(
        (c) =>
          c.label.toLowerCase().includes(query.toLowerCase()) ||
          c.description.toLowerCase().includes(query.toLowerCase()) ||
          c.group.toLowerCase().includes(query.toLowerCase()),
      )
    : commands;

  // Group the filtered commands
  const groups = filtered.reduce<Record<string, CommandItem[]>>((acc, cmd) => {
    if (!acc[cmd.group]) acc[cmd.group] = [];
    acc[cmd.group].push(cmd);
    return acc;
  }, {});

  const flatFiltered = Object.values(groups).flat();

  // Reset selection when query changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  // Focus input when opened
  useEffect(() => {
    if (open) {
      setQuery("");
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  // Keyboard navigation
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((prev) => Math.min(prev + 1, flatFiltered.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((prev) => Math.max(prev - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (flatFiltered[selectedIndex]) {
          onAction(flatFiltered[selectedIndex].id);
          onClose();
        }
      } else if (e.key === "Escape") {
        onClose();
      }
    },
    [flatFiltered, selectedIndex, onAction, onClose],
  );

  // Scroll selected item into view
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-index="${selectedIndex}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  if (!open) return null;

  let flatIndex = -1;

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm" onClick={onClose} />

      {/* Palette */}
      <div className="fixed top-[15%] left-1/2 -translate-x-1/2 z-50 w-[560px] max-w-[calc(100vw-40px)] bg-surface-raised border border-border-default rounded-xl shadow-[0_20px_60px_rgba(0,0,0,0.5)] overflow-hidden"
        style={{ animation: "cmdPaletteIn 0.15s ease-out" }}>

        {/* Search input */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border-default">
          <Search size={16} className="text-text-muted flex-shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type a command or search..."
            className="flex-1 bg-transparent text-sm text-text-primary placeholder:text-text-muted focus:outline-none"
          />
          <kbd className="text-[9px] px-1.5 py-0.5 rounded bg-surface-base border border-border-default text-text-muted font-mono">ESC</kbd>
        </div>

        {/* Results */}
        <div ref={listRef} className="max-h-[400px] overflow-y-auto py-2">
          {Object.entries(groups).map(([groupName, items]) => (
            <div key={groupName}>
              <div className="px-4 py-1.5 text-[10px] font-semibold text-text-muted uppercase tracking-widest">
                {groupName}
              </div>
              {items.map((cmd) => {
                flatIndex++;
                const idx = flatIndex;
                return (
                  <button
                    key={cmd.id}
                    data-index={idx}
                    onClick={() => { onAction(cmd.id); onClose(); }}
                    onMouseEnter={() => setSelectedIndex(idx)}
                    className={`w-full flex items-center gap-3 px-4 py-2 text-left transition-colors ${
                      selectedIndex === idx
                        ? "bg-accent/10 text-accent"
                        : "text-text-secondary hover:bg-surface-overlay"
                    }`}
                  >
                    <span className={`flex-shrink-0 ${selectedIndex === idx ? "text-accent" : "text-text-muted"}`}>
                      {cmd.icon}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium">{cmd.label}</p>
                      <p className="text-[10px] text-text-muted truncate">{cmd.description}</p>
                    </div>
                    {cmd.shortcut && (
                      <kbd className="text-[9px] px-1.5 py-0.5 rounded bg-surface-base border border-border-default text-text-muted font-mono flex-shrink-0">
                        {cmd.shortcut}
                      </kbd>
                    )}
                  </button>
                );
              })}
            </div>
          ))}

          {flatFiltered.length === 0 && (
            <div className="flex items-center justify-center py-8 text-xs text-text-muted">
              No commands found for "{query}"
            </div>
          )}
        </div>

        {/* Footer hint */}
        <div className="flex items-center gap-4 px-4 py-2 border-t border-border-default text-[10px] text-text-muted">
          <span className="flex items-center gap-1">
            <kbd className="px-1 py-0.5 rounded bg-surface-base border border-border-default font-mono">↑↓</kbd> navigate
          </span>
          <span className="flex items-center gap-1">
            <kbd className="px-1 py-0.5 rounded bg-surface-base border border-border-default font-mono">↵</kbd> select
          </span>
          <span className="flex items-center gap-1">
            <kbd className="px-1 py-0.5 rounded bg-surface-base border border-border-default font-mono">esc</kbd> close
          </span>
        </div>
      </div>

      <style>{`
        @keyframes cmdPaletteIn {
          from { transform: translate(-50%, -10px); opacity: 0; }
          to { transform: translate(-50%, 0); opacity: 1; }
        }
      `}</style>
    </>
  );
}
