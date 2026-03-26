import { useState, useEffect, useRef, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  ChevronDown,
  LayoutDashboard,
  Settings2,
  BookOpen,
  Wrench,
  Play,
  Activity,
  Sparkles,
  FlaskConical,
  Shield,
  Rocket,
} from "lucide-react";

import { useApiQuery } from "../../lib/api";
import { type AgentConfig } from "../../lib/adapters";
import { AssistInlineHint } from "../../components/common/AssistPanel";

import {
  OverviewTab,
  ConfigTab,
  KnowledgeTab,
  ToolsTab,
  PlaygroundTab,
  TracesTab,
  EvolveTab,
  EvalTab,
  SecurityTab,
  ReleasesTab,
} from "./detail-tabs";

/* ── Tab definitions ───────────────────────────────────────────── */

type TabId =
  | "overview"
  | "config"
  | "knowledge"
  | "tools"
  | "playground"
  | "traces"
  | "evolve"
  | "eval"
  | "security"
  | "releases";

interface TabDef {
  id: TabId;
  label: string;
  icon: React.ReactNode;
}

/* Primary tabs — always visible, core workflow */
const PRIMARY_TABS: TabDef[] = [
  { id: "overview", label: "Overview", icon: <LayoutDashboard size={14} /> },
  { id: "config", label: "Config", icon: <Settings2 size={14} /> },
  { id: "playground", label: "Playground", icon: <Play size={14} /> },
  { id: "traces", label: "Traces", icon: <Activity size={14} /> },
];

/* Secondary tabs — under "More" dropdown, organized by concern */
const SECONDARY_TABS: TabDef[] = [
  /* Build */
  { id: "knowledge", label: "Knowledge", icon: <BookOpen size={14} /> },
  { id: "tools", label: "Tools", icon: <Wrench size={14} /> },
  /* Assess */
  { id: "eval", label: "Eval", icon: <FlaskConical size={14} /> },
  { id: "evolve", label: "Evolve", icon: <Sparkles size={14} /> },
  { id: "security", label: "Security", icon: <Shield size={14} /> },
  /* Ship */
  { id: "releases", label: "Releases", icon: <Rocket size={14} /> },
];

const SECONDARY_TAB_IDS = new Set(SECONDARY_TABS.map((t) => t.id));

/* ── More menu item ────────────────────────────────────────────── */

function MoreMenuItem({ tab, activeTab, onSelect }: { tab: TabDef; activeTab: TabId; onSelect: (id: TabId) => void }) {
  return (
    <button
      role="menuitem"
      onClick={() => onSelect(tab.id)}
      className="flex items-center gap-2 w-full px-3 text-xs font-medium text-left transition-colors"
      style={{
        minHeight: "var(--touch-target-min)",
        padding: "var(--space-2) var(--space-3)",
        color: activeTab === tab.id ? "var(--color-accent)" : "var(--color-text-secondary)",
        background: activeTab === tab.id ? "var(--color-accent-muted)" : "transparent",
        border: "none",
        cursor: "pointer",
      }}
      onMouseEnter={(e) => {
        if (activeTab !== tab.id) e.currentTarget.style.background = "var(--color-white-alpha-5)";
      }}
      onMouseLeave={(e) => {
        if (activeTab !== tab.id) e.currentTarget.style.background = "transparent";
      }}
    >
      {tab.icon}
      {tab.label}
    </button>
  );
}

/* ── Component ─────────────────────────────────────────────────── */

export const AgentDetailPage = () => {
  const { agentName } = useParams<{ agentName: string }>();
  const navigate = useNavigate();

  const [activeTab, setActiveTab] = useState<TabId>("overview");
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);

  /* ── Data ────────────────────────────────────────────────────── */
  const configQuery = useApiQuery<AgentConfig>(
    `/api/v1/agents/${agentName ?? ""}/config`,
    Boolean(agentName),
  );

  /* ── Close dropdown on outside click ────────────────────────── */
  const handleOutsideClick = useCallback((e: MouseEvent) => {
    if (moreRef.current && !moreRef.current.contains(e.target as Node)) {
      setMoreOpen(false);
    }
  }, []);

  useEffect(() => {
    if (moreOpen) {
      document.addEventListener("mousedown", handleOutsideClick);
    }
    return () => document.removeEventListener("mousedown", handleOutsideClick);
  }, [moreOpen, handleOutsideClick]);

  /* ── Close dropdown on Escape ───────────────────────────────── */
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMoreOpen(false);
    };
    if (moreOpen) {
      document.addEventListener("keydown", handleEsc);
    }
    return () => document.removeEventListener("keydown", handleEsc);
  }, [moreOpen]);

  /* ── Derived state ──────────────────────────────────────────── */
  const isSecondaryActive = SECONDARY_TAB_IDS.has(activeTab);
  const activeSecondaryLabel = SECONDARY_TABS.find((t) => t.id === activeTab)?.label;

  /* ── Tab selection handler ──────────────────────────────────── */
  const selectTab = (id: TabId) => {
    setActiveTab(id);
    setMoreOpen(false);
  };

  /* ── Tab content renderer ───────────────────────────────────── */
  const renderTabContent = () => {
    if (configQuery.loading) {
      return (
        <div className="flex items-center justify-center py-16">
          <p className="text-sm text-text-muted">Loading agent config...</p>
        </div>
      );
    }

    if (configQuery.error) {
      return (
        <div className="card flex flex-col items-center justify-center py-12">
          <p className="text-sm text-status-error mb-3">{configQuery.error}</p>
          <button
            className="btn btn-secondary text-xs"
            onClick={() => void configQuery.refetch()}
          >
            Retry
          </button>
        </div>
      );
    }

    if (!configQuery.data) return null;
    const agent = configQuery.data;

    switch (activeTab) {
      case "overview":
        return <OverviewTab agent={agent} />;
      case "config":
        return <ConfigTab agent={agent} />;
      case "knowledge":
        return <KnowledgeTab agentName={agent.name} />;
      case "tools":
        return <ToolsTab agent={agent} />;
      case "playground":
        return <PlaygroundTab agentName={agent.name} />;
      case "traces":
        return <TracesTab agentName={agent.name} />;
      case "evolve":
        return <EvolveTab agentName={agent.name} />;
      case "eval":
        return <EvalTab agentName={agent.name} />;
      case "security":
        return <SecurityTab agent={agent} />;
      case "releases":
        return <ReleasesTab agentName={agent.name} />;
      default:
        return null;
    }
  };

  return (
    <div className="min-h-screen">
      {/* ── Back button ────────────────────────────────────────── */}
      <button
        onClick={() => navigate("/agents")}
        className="btn btn-ghost text-xs mb-4 -ml-2 gap-1.5"
        style={{ minHeight: "var(--touch-target-min)" }}
      >
        <ArrowLeft size={14} />
        Back to Agents
      </button>

      {/* ── Header ─────────────────────────────────────────────── */}
      <div className="mb-6">
        <h1 className="text-lg font-semibold text-text-primary">
          {agentName}
        </h1>
        {configQuery.data?.description && (
          <p className="text-sm text-text-muted mt-1">
            {configQuery.data.description}
          </p>
        )}
      </div>

      {/* ── Tab bar ────────────────────────────────────────────── */}
      <div
        className="flex items-center gap-1 mb-6 border-b"
        style={{ borderColor: "var(--color-border-default)" }}
        role="tablist"
        aria-label="Agent detail tabs"
      >
        {/* Primary tabs */}
        {PRIMARY_TABS.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            aria-selected={activeTab === tab.id}
            onClick={() => selectTab(tab.id)}
            className="inline-flex items-center gap-1.5 px-3 text-xs font-medium transition-colors relative"
            style={{
              minHeight: "var(--touch-target-min)",
              color:
                activeTab === tab.id
                  ? "var(--color-accent)"
                  : "var(--color-text-muted)",
              background: "transparent",
              border: "none",
              cursor: "pointer",
            }}
          >
            {tab.icon}
            {tab.label}
            {/* Active indicator line */}
            {activeTab === tab.id && (
              <span
                className="absolute bottom-0 left-0 right-0"
                style={{
                  height: "2px",
                  background: "var(--color-accent)",
                  borderRadius: "1px 1px 0 0",
                }}
              />
            )}
          </button>
        ))}

        {/* More dropdown */}
        <div className="relative" ref={moreRef}>
          <button
            role="tab"
            aria-selected={isSecondaryActive}
            aria-expanded={moreOpen}
            aria-haspopup="true"
            onClick={() => setMoreOpen((prev) => !prev)}
            className="inline-flex items-center gap-1.5 px-3 text-xs font-medium transition-colors relative"
            style={{
              minHeight: "var(--touch-target-min)",
              color: isSecondaryActive
                ? "var(--color-accent)"
                : "var(--color-text-muted)",
              background: "transparent",
              border: "none",
              cursor: "pointer",
            }}
          >
            {isSecondaryActive ? activeSecondaryLabel : "More"}
            <ChevronDown
              size={12}
              className="transition-transform"
              style={{
                transform: moreOpen ? "rotate(180deg)" : "rotate(0deg)",
              }}
            />
            {/* Active indicator line when a secondary tab is selected */}
            {isSecondaryActive && (
              <span
                className="absolute bottom-0 left-0 right-0"
                style={{
                  height: "2px",
                  background: "var(--color-accent)",
                  borderRadius: "1px 1px 0 0",
                }}
              />
            )}
          </button>

          {/* Dropdown menu with grouped sections */}
          {moreOpen && (
            <div
              className="glass-dropdown absolute top-full left-0 mt-2 rounded-lg border overflow-hidden z-50"
              style={{
                minWidth: "180px",
                animation: "fadeIn 0.15s ease-out",
              }}
              role="menu"
            >
              {/* Build group */}
              <div className="px-3 pt-2 pb-1">
                <span className="text-[9px] font-semibold uppercase tracking-wider text-text-muted">Build</span>
              </div>
              {SECONDARY_TABS.filter((t) => t.id === "knowledge" || t.id === "tools").map((tab) => (
                <MoreMenuItem key={tab.id} tab={tab} activeTab={activeTab} onSelect={selectTab} />
              ))}

              {/* Assess group */}
              <div className="border-t border-border-default mx-2 my-1" />
              <div className="px-3 pt-1 pb-1">
                <span className="text-[9px] font-semibold uppercase tracking-wider text-text-muted">Assess</span>
              </div>
              {SECONDARY_TABS.filter((t) => t.id === "eval" || t.id === "evolve" || t.id === "security").map((tab) => (
                <MoreMenuItem key={tab.id} tab={tab} activeTab={activeTab} onSelect={selectTab} />
              ))}

              {/* Ship group */}
              <div className="border-t border-border-default mx-2 my-1" />
              <div className="px-3 pt-1 pb-1">
                <span className="text-[9px] font-semibold uppercase tracking-wider text-text-muted">Ship</span>
              </div>
              {SECONDARY_TABS.filter((t) => t.id === "releases").map((tab) => (
                <MoreMenuItem key={tab.id} tab={tab} activeTab={activeTab} onSelect={selectTab} />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── Meta-agent contextual hint ──────────────────────────── */}
      {activeTab === "traces" && agentName && (
        <div className="mb-4">
          <AssistInlineHint
            message={`Meta-agent can analyze ${agentName}'s traces for patterns and failures`}
            actionLabel="Analyze traces"
            prompt={`Analyze the recent traces for ${agentName} — find failure patterns, slow tool calls, and suggest optimizations`}
          />
        </div>
      )}
      {activeTab === "eval" && agentName && (
        <div className="mb-4">
          <AssistInlineHint
            message={`Run an eval loop to test ${agentName} and get improvement suggestions`}
            actionLabel="Run eval"
            prompt={`Run an eval loop for ${agentName}: pick tasks, run trials, summarize failures, and propose the top 3 improvements`}
          />
        </div>
      )}
      {activeTab === "security" && agentName && (
        <div className="mb-4">
          <AssistInlineHint
            message={`Get a security risk assessment for ${agentName}`}
            actionLabel="Assess risk"
            prompt={`Analyze the security posture of ${agentName} — AIVSS risk score, open findings, and recommended mitigations`}
          />
        </div>
      )}

      {/* ── Tab content ────────────────────────────────────────── */}
      <div role="tabpanel">{renderTabContent()}</div>
    </div>
  );
};
