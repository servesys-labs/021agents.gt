import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Search,
  Layers,
  LayoutDashboard,
  Activity,
  BarChart3,
  Brain,
  ShieldCheck,
  Bug,
  Shield,
  Phone,
  FlaskConical,
  Settings,
  CreditCard,
  Plus,
  Upload,
  Wrench,
  Globe,
  FileText,
  ShieldAlert,
  Bot,
  Command,
  CornerDownLeft,
  ArrowUp,
  ArrowDown,
} from "lucide-react";
import type { ReactNode } from "react";
import { useApiQuery } from "../../lib/api";
import { safeArray, type AgentInfo } from "../../lib/adapters";

/* ── Types ─────────────────────────────────────────────────────── */

type ResultItem = {
  id: string;
  label: string;
  description?: string;
  icon: ReactNode;
  action: () => void;
  group: "pages" | "agents" | "actions";
};

/* ── Static data ───────────────────────────────────────────────── */

const iconSize = 16;
const iconStroke = 1.5;

const PAGE_ITEMS: Omit<ResultItem, "action">[] = [
  { id: "p-canvas", label: "Canvas", description: "Agent workspace", icon: <Layers size={iconSize} strokeWidth={iconStroke} />, group: "pages" },
  { id: "p-overview", label: "Overview", description: "Dashboard overview", icon: <LayoutDashboard size={iconSize} strokeWidth={iconStroke} />, group: "pages" },
  { id: "p-observability", label: "Observability", description: "Session traces", icon: <Activity size={iconSize} strokeWidth={iconStroke} />, group: "pages" },
  { id: "p-metrics", label: "Metrics", description: "Evolution metrics", icon: <BarChart3 size={iconSize} strokeWidth={iconStroke} />, group: "pages" },
  { id: "p-intelligence", label: "Intelligence", description: "AI intelligence", icon: <Brain size={iconSize} strokeWidth={iconStroke} />, group: "pages" },
  { id: "p-compliance", label: "Compliance", description: "Compliance checks", icon: <ShieldCheck size={iconSize} strokeWidth={iconStroke} />, group: "pages" },
  { id: "p-issues", label: "Issues", description: "Bug tracking", icon: <Bug size={iconSize} strokeWidth={iconStroke} />, group: "pages" },
  { id: "p-security", label: "Security", description: "Security center", icon: <Shield size={iconSize} strokeWidth={iconStroke} />, group: "pages" },
  { id: "p-autoresearch", label: "Autoresearch", description: "Research automation", icon: <FlaskConical size={iconSize} strokeWidth={iconStroke} />, group: "pages" },
  { id: "p-voice", label: "Voice", description: "Voice interface", icon: <Phone size={iconSize} strokeWidth={iconStroke} />, group: "pages" },
  { id: "p-settings", label: "Settings", description: "App settings", icon: <Settings size={iconSize} strokeWidth={iconStroke} />, group: "pages" },
  { id: "p-billing", label: "Billing", description: "Billing & usage", icon: <CreditCard size={iconSize} strokeWidth={iconStroke} />, group: "pages" },
  { id: "p-tools", label: "Tool Registry", description: "Browse and manage tools", icon: <Wrench size={iconSize} strokeWidth={iconStroke} />, group: "pages" },
  { id: "p-a2a", label: "A2A Discovery", description: "Discover A2A agents", icon: <Globe size={iconSize} strokeWidth={iconStroke} />, group: "pages" },
  { id: "p-a2a-compose", label: "A2A Compose Task", description: "Compose an A2A task", icon: <Globe size={iconSize} strokeWidth={iconStroke} />, group: "pages" },
  { id: "p-pricing", label: "Pricing", description: "Plans and pricing", icon: <CreditCard size={iconSize} strokeWidth={iconStroke} />, group: "pages" },
  { id: "p-invoices", label: "Invoices", description: "Billing invoices", icon: <FileText size={iconSize} strokeWidth={iconStroke} />, group: "pages" },
  { id: "p-security-findings", label: "Security Findings", description: "View security findings", icon: <ShieldAlert size={iconSize} strokeWidth={iconStroke} />, group: "pages" },
  { id: "p-security-report", label: "Security Report", description: "Security audit report", icon: <Shield size={iconSize} strokeWidth={iconStroke} />, group: "pages" },
];

const PAGE_ROUTES: Record<string, string> = {
  "p-canvas": "/",
  "p-overview": "/overview",
  "p-observability": "/observability",
  "p-metrics": "/metrics",
  "p-intelligence": "/intelligence",
  "p-compliance": "/compliance",
  "p-issues": "/issues",
  "p-security": "/security",
  "p-autoresearch": "/autoresearch",
  "p-voice": "/voice",
  "p-settings": "/settings",
  "p-billing": "/billing",
  "p-tools": "/tools",
  "p-a2a": "/a2a",
  "p-a2a-compose": "/a2a/compose",
  "p-pricing": "/billing/pricing",
  "p-invoices": "/billing/invoices",
  "p-security-findings": "/security/findings",
  "p-security-report": "/security/report",
};

const ACTION_ITEMS: Omit<ResultItem, "action">[] = [
  { id: "a-create-agent", label: "Create Agent", description: "Configure a new agent", icon: <Plus size={iconSize} strokeWidth={iconStroke} />, group: "actions" },
  { id: "a-upload-doc", label: "Upload Document", description: "Add RAG document", icon: <Upload size={iconSize} strokeWidth={iconStroke} />, group: "actions" },
  { id: "a-create-tool", label: "Create New Tool", description: "Register a new tool", icon: <Wrench size={iconSize} strokeWidth={iconStroke} />, group: "actions" },
  { id: "a-compose-a2a", label: "Compose A2A Task", description: "Send a task to an A2A agent", icon: <Globe size={iconSize} strokeWidth={iconStroke} />, group: "actions" },
];

const ACTION_ROUTES: Record<string, string> = {
  "a-create-agent": "/canvas",
  "a-upload-doc": "/canvas",
  "a-create-tool": "/tools?action=create",
  "a-compose-a2a": "/a2a/compose",
};

/* ── Group labels ──────────────────────────────────────────────── */

const GROUP_LABELS: Record<string, string> = {
  pages: "Pages",
  agents: "Agents",
  actions: "Actions",
};

/* ── Component ─────────────────────────────────────────────────── */

export const CommandPalette = ({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}) => {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  /* ── Fetch agents for search ─────────────────────────────── */
  const agentsQuery = useApiQuery<AgentInfo[]>("/api/v1/agents?limit=100", isOpen);
  const agents = safeArray<AgentInfo>(agentsQuery.data);

  /* ── Build results ───────────────────────────────────────── */
  const results = useMemo<ResultItem[]>(() => {
    const q = query.toLowerCase().trim();

    const pageResults: ResultItem[] = PAGE_ITEMS
      .filter((p) => !q || p.label.toLowerCase().includes(q) || (p.description?.toLowerCase().includes(q) ?? false))
      .map((p) => ({ ...p, action: () => { navigate(PAGE_ROUTES[p.id] || "/"); onClose(); } }));

    const agentResults: ResultItem[] = agents
      .filter((a) => !q || a.name.toLowerCase().includes(q) || (a.description?.toLowerCase().includes(q) ?? false))
      .slice(0, 8)
      .map((a) => ({
        id: `agent-${a.name}`,
        label: a.name,
        description: a.description?.slice(0, 50) || a.model || "Agent",
        icon: <Bot size={iconSize} strokeWidth={iconStroke} />,
        group: "agents" as const,
        action: () => { navigate(`/canvas?agent=${a.name}`); onClose(); },
      }));

    const actionResults: ResultItem[] = ACTION_ITEMS
      .filter((a) => !q || a.label.toLowerCase().includes(q) || (a.description?.toLowerCase().includes(q) ?? false))
      .map((a) => ({ ...a, action: () => { navigate(ACTION_ROUTES[a.id] || "/"); onClose(); } }));

    return [...pageResults, ...agentResults, ...actionResults];
  }, [query, agents, navigate, onClose]);

  /* ── Reset on open/close ─────────────────────────────────── */
  useEffect(() => {
    if (isOpen) {
      setQuery("");
      setActiveIndex(0);
      // Focus after render
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [isOpen]);

  /* ── Clamp active index ──────────────────────────────────── */
  useEffect(() => {
    if (activeIndex >= results.length) {
      setActiveIndex(Math.max(0, results.length - 1));
    }
  }, [results.length, activeIndex]);

  /* ── Scroll active item into view ────────────────────────── */
  useEffect(() => {
    const activeEl = listRef.current?.querySelector(`[data-index="${activeIndex}"]`);
    activeEl?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  /* ── Keyboard handler ────────────────────────────────────── */
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setActiveIndex((prev) => (prev + 1) % Math.max(1, results.length));
          break;
        case "ArrowUp":
          e.preventDefault();
          setActiveIndex((prev) => (prev - 1 + results.length) % Math.max(1, results.length));
          break;
        case "Enter":
          e.preventDefault();
          if (results[activeIndex]) {
            results[activeIndex].action();
          }
          break;
        case "Escape":
          e.preventDefault();
          onClose();
          break;
      }
    },
    [results, activeIndex, onClose],
  );

  if (!isOpen) return null;

  /* ── Group results ───────────────────────────────────────── */
  const grouped = results.reduce<Record<string, ResultItem[]>>((acc, item) => {
    if (!acc[item.group]) acc[item.group] = [];
    acc[item.group].push(item);
    return acc;
  }, {});

  let flatIndex = 0;

  return (
    <>
      {/* Backdrop */}
      <div
        className="command-palette-backdrop glass-backdrop"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Modal */}
      <div
        className="command-palette-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onKeyDown={handleKeyDown}
      >
        {/* Search input */}
        <div className="command-palette-input-wrap">
          <Search size={16} className="command-palette-search-icon" />
          <input
            ref={inputRef}
            type="text"
            className="command-palette-input"
            placeholder="Search pages, agents, actions..."
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIndex(0);
            }}
            autoComplete="off"
            spellCheck={false}
          />
          <kbd className="command-palette-kbd">ESC</kbd>
        </div>

        {/* Results */}
        <div className="command-palette-results" ref={listRef}>
          {results.length === 0 ? (
            <div className="command-palette-empty">
              No results for &ldquo;{query}&rdquo;
            </div>
          ) : (
            Object.entries(grouped).map(([group, items]) => (
              <div key={group} className="command-palette-group">
                <div className="command-palette-group-label">
                  {GROUP_LABELS[group] || group}
                </div>
                {items.map((item) => {
                  const idx = flatIndex++;
                  return (
                    <button
                      key={item.id}
                      data-index={idx}
                      className={`command-palette-item ${idx === activeIndex ? "command-palette-item-active" : ""}`}
                      onClick={item.action}
                      onMouseEnter={() => setActiveIndex(idx)}
                      tabIndex={-1}
                    >
                      <span className="command-palette-item-icon">{item.icon}</span>
                      <span className="command-palette-item-content">
                        <span className="command-palette-item-label">{item.label}</span>
                        {item.description && (
                          <span className="command-palette-item-desc">{item.description}</span>
                        )}
                      </span>
                      {idx === activeIndex && (
                        <CornerDownLeft size={12} className="command-palette-item-enter" />
                      )}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        {/* Footer hints */}
        <div className="command-palette-footer">
          <span className="command-palette-hint">
            <ArrowUp size={10} />
            <ArrowDown size={10} />
            Navigate
          </span>
          <span className="command-palette-hint">
            <CornerDownLeft size={10} />
            Open
          </span>
          <span className="command-palette-hint">
            <span className="command-palette-hint-key">ESC</span>
            Close
          </span>
        </div>
      </div>
    </>
  );
};
