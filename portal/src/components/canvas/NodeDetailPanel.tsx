import { useState, useRef, useEffect, type ReactNode } from "react";
import {
  X, Bot, Database, BookOpen, Plug, Server, Rocket, Settings, Activity, Code,
  ShieldCheck, FileText, Layers, Zap, Key, BarChart3, Play, Trash2, Copy,
  MoreVertical, MessageSquare, Brain, FlaskConical, Tag, Send, Clock,
  CheckCircle2, XCircle, AlertTriangle, Pause, RotateCcw, Upload, Search,
  ChevronRight, Cpu,
} from "lucide-react";
import type { Node } from "@xyflow/react";
import { apiRequest, useApiQuery } from "../../lib/api";
import { SectionTitle, InlineInput, InlineTextarea, InlineSelect, ToggleRow, StatusPill, InfoRow, EmptyTab } from "./primitives";

/* ── Types ─────────────────────────────────────────────────────── */
type Tab = { id: string; label: string; icon: ReactNode };

type AgentNodeData = {
  name?: string;
  model?: string;
  status?: string;
  tools?: string[];
  efficiency?: number;
  activity?: number[];
  variables?: { key: string; value: string }[];
  systemPrompt?: string;
  system_prompt?: string;
  temperature?: number;
  maxTokens?: number;
  max_tokens?: number;
  budgetLimit?: number;
  requireApproval?: boolean;
  humanInLoop?: boolean;
  facts?: { key: string; value: string }[];
  hideHandles?: boolean;
};

type KnowledgeNodeData = {
  name?: string;
  docCount?: number;
  totalSize?: string;
  status?: string;
  chunkCount?: number;
};

type DataSourceNodeData = {
  name?: string;
  type?: string;
  dbType?: string;
  status?: string;
  tableCount?: number;
  host?: string;
  port?: number;
  database?: string;
};

type ConnectorNodeData = {
  name?: string;
  app?: string;
  status?: string;
  toolCount?: number;
  provider?: string;
  toolList?: string[];
};

type McpServerNodeData = {
  name?: string;
  url?: string;
  status?: string;
  toolCount?: number;
  toolList?: string[];
};

type NodeData = AgentNodeData | KnowledgeNodeData | DataSourceNodeData | ConnectorNodeData | McpServerNodeData;

interface NodeDetailPanelProps {
  node: Node | null;
  onClose: () => void;
  onDelete?: (nodeId: string) => void;
  onClone?: (nodeId: string) => void;
  onDeploy?: (nodeId: string) => void;
  onUpdateNode?: (nodeId: string, data: NodeData) => void;
}

/* ── Tab configs per node type ──────────────────────────────────
   Railway uses ~5 top-level tabs. We group our 12 agent tabs into
   5 top-level tabs, with "Settings" having a vertical section nav. */
const tabsByType: Record<string, Tab[]> = {
  agent: [
    { id: "overview", label: "Overview", icon: <Bot size={14} /> },
    { id: "deployments", label: "Deployments", icon: <Rocket size={14} /> },
    { id: "variables", label: "Variables", icon: <Code size={14} /> },
    { id: "metrics", label: "Metrics", icon: <BarChart3 size={14} /> },
    { id: "settings", label: "Settings", icon: <Settings size={14} /> },
  ],
  knowledge: [
    { id: "overview", label: "Overview", icon: <BookOpen size={14} /> },
    { id: "documents", label: "Documents", icon: <FileText size={14} /> },
    { id: "chunks", label: "Chunks", icon: <Layers size={14} /> },
    { id: "settings", label: "Settings", icon: <Settings size={14} /> },
  ],
  datasource: [
    { id: "overview", label: "Overview", icon: <Database size={14} /> },
    { id: "tables", label: "Tables", icon: <Layers size={14} /> },
    { id: "queries", label: "Queries", icon: <Code size={14} /> },
    { id: "settings", label: "Settings", icon: <Settings size={14} /> },
  ],
  connector: [
    { id: "overview", label: "Overview", icon: <Plug size={14} /> },
    { id: "tools", label: "Tools", icon: <Zap size={14} /> },
    { id: "oauth", label: "OAuth", icon: <Key size={14} /> },
    { id: "settings", label: "Settings", icon: <Settings size={14} /> },
  ],
  mcpServer: [
    { id: "overview", label: "Overview", icon: <Server size={14} /> },
    { id: "tools", label: "Tools", icon: <Zap size={14} /> },
    { id: "health", label: "Health", icon: <Activity size={14} /> },
    { id: "settings", label: "Settings", icon: <Settings size={14} /> },
  ],
};

/* ── Agent settings sections (vertical right nav like Railway) ── */
const agentSettingsSections = [
  { id: "tools", label: "Tools", icon: <Zap size={13} /> },
  { id: "sessions", label: "Sessions", icon: <Activity size={13} /> },
  { id: "memory", label: "Memory", icon: <Brain size={13} /> },
  { id: "chat", label: "Chat", icon: <MessageSquare size={13} /> },
  { id: "sandbox", label: "Sandbox", icon: <Cpu size={13} /> },
  { id: "eval", label: "Eval", icon: <FlaskConical size={13} /> },
  { id: "releases", label: "Releases", icon: <Tag size={13} /> },
  { id: "governance", label: "Governance", icon: <ShieldCheck size={13} /> },
  { id: "config", label: "Config", icon: <Settings size={13} /> },
  { id: "danger", label: "Danger", icon: <AlertTriangle size={13} /> },
];

/* ── Helpers ────────────────────────────────────────────────────── */
function getNodeIcon(type: string) {
  switch (type) {
    case "agent": return <Bot size={20} className="text-accent" />;
    case "knowledge": return <BookOpen size={20} className="text-chart-purple" />;
    case "datasource": return <Database size={20} className="text-chart-cyan" />;
    case "connector": return <Plug size={20} className="text-chart-green" />;
    case "mcpServer": return <Server size={20} className="text-chart-blue" />;
    default: return <Cpu size={20} className="text-text-muted" />;
  }
}

function getNodeTypeLabel(type: string) {
  switch (type) {
    case "agent": return "Agent";
    case "knowledge": return "Knowledge Base";
    case "datasource": return "Data Source";
    case "connector": return "Connector";
    case "mcpServer": return "MCP Server";
    default: return "Node";
  }
}

function getStatusColor(status?: string): string {
  switch (status?.toLowerCase()) {
    case "online": case "live": case "connected": case "authenticated":
    case "authed": case "healthy": case "ready": case "active": case "passed":
      return "bg-status-live";
    case "draft": case "pending": case "sleeping": case "running": case "in_progress":
      return "bg-status-warning";
    case "offline": case "disconnected": case "error": case "failed": case "terminated":
      return "bg-status-error";
    default: return "bg-text-muted";
  }
}

/* ═══════════════════════════════════════════════════════════════════
   MAIN COMPONENT — Railway-style floating card
   ═══════════════════════════════════════════════════════════════════ */
export function NodeDetailPanel({
  node, onClose, onDelete, onClone, onDeploy, onUpdateNode,
}: NodeDetailPanelProps) {
  const [activeTab, setActiveTab] = useState("overview");
  const [settingsSection, setSettingsSection] = useState("tools");
  const [actionMenuOpen, setActionMenuOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  const nodeType = node?.type || "agent";
  const tabs = tabsByType[nodeType] || tabsByType.agent;

  /* Reset activeTab when selected node changes */
  useEffect(() => {
    setActiveTab(tabs[0]?.id || "overview");
  }, [node?.id]);
  const data = (node?.data || {}) as NodeData;

  /* Escape to close */
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  if (!node) return null;

  const isSettingsTab = activeTab === "settings" && nodeType === "agent";

  return (
      <div
        ref={panelRef}
        className="h-full border-l flex flex-col overflow-hidden flex-shrink-0 glass-heavy relative"
        style={{ width: "100%" }}
      >
        {/* ── Header ──────────────────────────────────────────── */}
        <div className="flex items-center gap-3 px-6 py-4 border-b border-border-default flex-shrink-0">
          <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-white-alpha-8">
            {getNodeIcon(nodeType)}
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-base font-semibold text-text-primary truncate">
              {data.name || "Untitled"}
            </h2>
            <div className="flex items-center gap-2 mt-0.5">
              <span className={`inline-block w-2 h-2 rounded-full ${getStatusColor(data.status || "")}`} />
              <span className="text-xs text-text-muted">
                {data.status || "unknown"}
              </span>
              <span className="text-xs text-text-muted opacity-50">|</span>
              <span className="text-xs text-text-muted">{getNodeTypeLabel(nodeType)}</span>
            </div>
          </div>

          {/* Action buttons */}
          <div className="flex items-center gap-1">
            {nodeType === "agent" && onDeploy && (
              <button onClick={() => onDeploy(node.id)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium bg-accent/10 text-accent rounded-md hover:bg-accent/20 transition-colors">
                <Rocket size={12} /> Deploy
              </button>
            )}
            <div className="relative">
              <button onClick={() => setActionMenuOpen(!actionMenuOpen)}
                className="flex items-center justify-center w-8 h-8 rounded-md text-text-muted hover:bg-white-alpha-8 hover:text-text-primary transition-colors">
                <MoreVertical size={15} />
              </button>
              {actionMenuOpen && (
                <>
                  <div className="fixed inset-0 z-50" onClick={() => setActionMenuOpen(false)} />
                  <div className="absolute right-0 top-full mt-1 z-50 w-44 bg-white-alpha-8 border border-border-default rounded-lg shadow-xl overflow-hidden">
                    {onClone && (
                      <button onClick={() => { onClone(node.id); setActionMenuOpen(false); }}
                        className="flex items-center gap-2 w-full px-3 py-2.5 text-xs text-text-secondary hover:bg-surface-hover transition-colors">
                        <Copy size={12} /> Clone
                      </button>
                    )}
                    {onDelete && (
                      <button onClick={() => { onDelete(node.id); setActionMenuOpen(false); }}
                        className="flex items-center gap-2 w-full px-3 py-2.5 text-xs text-status-error hover:bg-surface-hover transition-colors">
                        <Trash2 size={12} /> Delete
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
            <button onClick={onClose}
              className="flex items-center justify-center w-8 h-8 rounded-md text-text-muted hover:bg-white-alpha-8 hover:text-text-primary transition-colors">
              <X size={16} />
            </button>
          </div>
        </div>

        {/* ── Horizontal tab bar ──────────────────────────────── */}
        <div className="flex items-center gap-0 px-6 border-b border-border-default flex-shrink-0">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => { setActiveTab(tab.id); if (tab.id === "settings") setSettingsSection("tools"); }}
              className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                activeTab === tab.id
                  ? "border-accent text-accent"
                  : "border-transparent text-text-muted hover:text-text-secondary"
              }`}
            >
              {tab.icon}
              {tab.label}
            </button>
          ))}
          {/* Filter settings search (like Railway) */}
          {isSettingsTab && (
            <div className="ml-auto flex items-center gap-2 text-text-muted">
              <Search size={13} />
              <span className="text-[11px]">Filter Settings...</span>
              <kbd className="text-[10px] px-1.5 py-0.5 bg-white-alpha-8 rounded border border-border-default">/</kbd>
            </div>
          )}
        </div>

        {/* ── Content area ────────────────────────────────────── */}
        {isSettingsTab ? (
          /* Settings tab: content + right section nav (Railway-style) */
          <div className="flex flex-1 overflow-hidden">
            {/* Main content */}
            <div className="flex-1 overflow-y-auto p-6">
              <AgentSettingsContent section={settingsSection} data={data as AgentNodeData} nodeId={node.id} onUpdateNode={onUpdateNode} />
            </div>
            {/* Right section nav */}
            <div className="w-[140px] border-l border-border-default py-4 px-2 flex-shrink-0 overflow-y-auto">
              {agentSettingsSections.map((s) => (
                <button
                  key={s.id}
                  onClick={() => setSettingsSection(s.id)}
                  className={`flex items-center gap-2 w-full px-3 py-2 text-[12px] rounded-md transition-colors mb-0.5 ${
                    settingsSection === s.id
                      ? "text-accent font-medium bg-accent/5"
                      : "text-text-muted hover:text-text-secondary hover:bg-white-alpha-8"
                  }`}
                >
                  {s.icon}
                  <span className="truncate">{s.label}</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          /* Other tabs: full-width scrollable content */
          <div className="flex-1 overflow-y-auto p-6">
            <TabContent nodeType={nodeType} tabId={activeTab} data={data} nodeId={node.id} onUpdateNode={onUpdateNode} />
          </div>
        )}
      </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   TAB CONTENT ROUTER (non-settings tabs)
   ═══════════════════════════════════════════════════════════════════ */
function TabContent({ nodeType, tabId, data, nodeId, onUpdateNode }: {
  nodeType: string; tabId: string; data: NodeData; nodeId: string;
  onUpdateNode?: (nodeId: string, data: NodeData) => void;
}) {
  switch (nodeType) {
    case "agent": return <AgentTabContent tabId={tabId} data={data as AgentNodeData} nodeId={nodeId} onUpdateNode={onUpdateNode} />;
    case "knowledge": return <KnowledgeTabContent tabId={tabId} data={data as KnowledgeNodeData} nodeId={nodeId} />;
    case "datasource": return <DataSourceTabContent tabId={tabId} data={data as DataSourceNodeData} nodeId={nodeId} />;
    case "connector": return <ConnectorTabContent tabId={tabId} data={data as ConnectorNodeData} nodeId={nodeId} />;
    case "mcpServer": return <McpServerTabContent tabId={tabId} data={data as McpServerNodeData} nodeId={nodeId} />;
    default: return <EmptyTab message="Unknown node type" />;
  }
}

/* ═══════════════════════════════════════════════════════════════════
   AGENT TAB CONTENT (top-level tabs: Overview, Deployments, Variables, Metrics)
   ═══════════════════════════════════════════════════════════════════ */
/* ── Deploy Status inline component ────────────────────────────── */
function DeployStatusSection({ agentName }: { agentName: string }) {
  const deployQuery = useApiQuery<{
    status?: string;
    version?: string;
    last_deployed_at?: string;
    replicas?: number;
    url?: string;
  }>(
    `/api/v1/deploy/${encodeURIComponent(agentName)}/status`,
    Boolean(agentName),
  );

  if (!agentName) return null;

  return (
    <>
      <SectionTitle>Deployment</SectionTitle>
      <div className="bg-white-alpha-5 rounded-lg border border-border-default p-5 mb-6">
        {deployQuery.loading && (
          <p className="text-xs text-text-muted">Loading deploy status...</p>
        )}
        {deployQuery.error && (
          <p className="text-xs text-text-muted">No deployment info available</p>
        )}
        {!deployQuery.loading && !deployQuery.error && deployQuery.data && (
          <>
            <InfoRow label="Deploy Status" value={
              <span className="flex items-center gap-1.5">
                <span className={`w-2 h-2 rounded-full ${
                  deployQuery.data.status === "running" || deployQuery.data.status === "active" || deployQuery.data.status === "healthy"
                    ? "bg-status-live"
                    : deployQuery.data.status === "deploying" || deployQuery.data.status === "pending"
                    ? "bg-status-warning"
                    : deployQuery.data.status === "failed" || deployQuery.data.status === "error"
                    ? "bg-status-error"
                    : "bg-text-muted"
                }`} />
                {(deployQuery.data.status || "unknown").toUpperCase()}
              </span>
            } />
            {deployQuery.data.version && (
              <InfoRow label="Version" value={deployQuery.data.version} mono />
            )}
            {deployQuery.data.last_deployed_at && (
              <InfoRow
                label="Last Deployed"
                value={new Date(deployQuery.data.last_deployed_at).toLocaleString()}
              />
            )}
            {deployQuery.data.replicas !== undefined && (
              <InfoRow label="Replicas" value={String(deployQuery.data.replicas)} mono />
            )}
            {deployQuery.data.url && (
              <InfoRow label="URL" value={deployQuery.data.url} mono />
            )}
          </>
        )}
      </div>
    </>
  );
}

function AgentTabContent({ tabId, data, nodeId, onUpdateNode }: {
  tabId: string; data: AgentNodeData; nodeId: string;
  onUpdateNode?: (nodeId: string, data: NodeData) => void;
}) {
  const [vars, setVars] = useState<{ key: string; value: string }[]>(
    data.variables || [{ key: "OPENAI_API_KEY", value: "sk-***" }, { key: "LOG_LEVEL", value: "info" }],
  );
  const [newVarKey, setNewVarKey] = useState("");
  const [newVarValue, setNewVarValue] = useState("");

  switch (tabId) {
    /* ── Overview ──────────────────────────────────────────── */
    case "overview":
      return (
        <div className="max-w-2xl">
          <SectionTitle>Agent Configuration</SectionTitle>
          <div className="bg-white-alpha-5 rounded-lg border border-border-default p-5 mb-6">
            <InfoRow label="Name" value={data.name || "—"} />
            <InfoRow label="Model" value={data.model || "—"} mono />
            <InfoRow label="Status" value={
              <span className="flex items-center gap-1.5">
                <span className={`w-2 h-2 rounded-full ${getStatusColor(data.status)}`} />
                {(data.status || "unknown").toUpperCase()}
              </span>
            } />
            <InfoRow label="Tools" value={`${(data.tools || []).length} configured`} />
            <InfoRow label="Efficiency" value={data.efficiency ? `${data.efficiency}%` : "—"} />
          </div>
          <DeployStatusSection agentName={data.name || ""} />
          <SectionTitle>Recent Activity</SectionTitle>
          <div className="bg-white-alpha-5 rounded-lg border border-border-default p-5">
            <div className="flex items-center gap-2 mb-3">
              <Activity size={14} className="text-text-muted" />
              <span className="text-xs text-text-muted uppercase">24h Sparkline</span>
            </div>
            <div className="flex items-end gap-1 h-12">
              {(data.activity || [0,0,0,0,0,0,0,0,0,0,0,0]).map((v: number, i: number) => (
                <div key={i} className="flex-1 bg-accent/40 rounded-sm min-h-[2px]" style={{ height: `${Math.max(8, (v / 15) * 100)}%` }} />
              ))}
            </div>
          </div>
        </div>
      );

    /* ── Deployments ───────────────────────────────────────── */
    case "deployments":
      return (
        <div className="max-w-2xl">
          <SectionTitle>Deployment History</SectionTitle>
          <div className="space-y-2">
            {[
              { id: "d1", version: "v1.3.2", status: "active", time: "2 hours ago", env: "production" },
              { id: "d2", version: "v1.3.1", status: "superseded", time: "1 day ago", env: "production" },
              { id: "d3", version: "v1.3.0", status: "superseded", time: "3 days ago", env: "staging" },
            ].map((d) => (
              <div key={d.id} className="bg-white-alpha-5 rounded-lg border border-border-default p-4 flex items-center gap-3">
                <span className={`w-2.5 h-2.5 rounded-full ${d.status === "active" ? "bg-status-live" : "bg-text-muted"}`} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-text-primary font-mono">{d.version}</p>
                  <p className="text-xs text-text-muted">{d.env} &middot; {d.time}</p>
                </div>
                <StatusPill status={d.status} />
              </div>
            ))}
          </div>
          <button className="mt-4 w-full py-2.5 text-sm font-medium border border-dashed border-border-default rounded-lg text-text-muted hover:border-accent/40 hover:text-accent transition-colors">
            + Deploy New Version
          </button>
        </div>
      );

    /* ── Variables ─────────────────────────────────────────── */
    case "variables":
      return (
        <div className="max-w-2xl">
          <SectionTitle>Environment Variables</SectionTitle>
          <div className="bg-white-alpha-5 rounded-lg border border-border-default overflow-hidden mb-4">
            {vars.map((v, i) => (
              <div key={i} className="flex items-center gap-3 px-4 py-3 border-b border-border-default last:border-0">
                <code className="text-sm text-accent font-mono flex-shrink-0">{v.key}</code>
                <span className="text-xs text-text-muted">=</span>
                <code className="text-sm text-text-secondary font-mono truncate flex-1">{v.value}</code>
                <button onClick={() => setVars(vars.filter((_, idx) => idx !== i))} className="text-text-muted hover:text-status-error transition-colors flex-shrink-0">
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <input value={newVarKey} onChange={(e) => setNewVarKey(e.target.value)} placeholder="KEY"
              className="flex-1 px-3 py-2 text-sm font-mono bg-white-alpha-5 border border-border-default rounded-lg text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent/50" />
            <input value={newVarValue} onChange={(e) => setNewVarValue(e.target.value)} placeholder="value"
              className="flex-1 px-3 py-2 text-sm font-mono bg-white-alpha-5 border border-border-default rounded-lg text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent/50" />
            <button onClick={() => { if (newVarKey.trim()) { setVars([...vars, { key: newVarKey.trim(), value: newVarValue }]); setNewVarKey(""); setNewVarValue(""); } }}
              className="px-4 py-2 text-sm font-medium bg-accent text-text-inverse rounded-lg hover:bg-accent/90 transition-colors">Add</button>
          </div>
        </div>
      );

    /* ── Metrics ──────────────────────────────────────────── */
    case "metrics":
      return (
        <div className="max-w-2xl">
          <SectionTitle>Performance Metrics</SectionTitle>
          <div className="grid grid-cols-2 gap-4 mb-6">
            {[
              { label: "Avg Latency", value: "1.2s", trend: "-5%" },
              { label: "Success Rate", value: "98.7%", trend: "+0.3%" },
              { label: "Token Usage", value: "12.4K/day", trend: "+12%" },
              { label: "Cost (24h)", value: "$2.41", trend: "-8%" },
            ].map((m) => (
              <div key={m.label} className="bg-white-alpha-5 rounded-lg border border-border-default p-4">
                <p className="text-xs text-text-muted">{m.label}</p>
                <p className="text-xl font-semibold text-text-primary mt-1">{m.value}</p>
                <p className={`text-xs mt-1 ${m.trend.startsWith("-") ? "text-status-live" : "text-status-warning"}`}>{m.trend}</p>
              </div>
            ))}
          </div>
        </div>
      );

    default:
      return <EmptyTab message={`Tab "${tabId}" not implemented`} />;
  }
}

/* ═══════════════════════════════════════════════════════════════════
   AGENT SETTINGS CONTENT (vertical section nav)
   ═══════════════════════════════════════════════════════════════════ */
function AgentSettingsContent({ section, data, nodeId, onUpdateNode }: {
  section: string; data: AgentNodeData; nodeId: string;
  onUpdateNode?: (nodeId: string, data: NodeData) => void;
}) {
  const [editName, setEditName] = useState(data.name || "");
  const [editModel, setEditModel] = useState(data.model || "gpt-4.1-mini");
  const [editSystemPrompt, setEditSystemPrompt] = useState(data.systemPrompt || "You are a helpful AI assistant.");
  const [editTemp, setEditTemp] = useState(data.temperature?.toString() || "0.7");
  const [editMaxTokens, setEditMaxTokens] = useState(data.maxTokens?.toString() || "4096");
  const [budgetLimit, setBudgetLimit] = useState(data.budgetLimit?.toString() || "50");
  const [requireApproval, setRequireApproval] = useState(data.requireApproval || false);
  const [humanInLoop, setHumanInLoop] = useState(data.humanInLoop || false);
  const [chatMessages, setChatMessages] = useState<{ role: string; content: string }[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const [chatSessionId, setChatSessionId] = useState("");
  const [memoryTab, setMemoryTab] = useState<"facts" | "episodes" | "procedures">("facts");
  const [newFact, setNewFact] = useState({ key: "", value: "" });
  const [sessionFilter, setSessionFilter] = useState("all");
  // Sandbox state must stay at top-level to preserve hook order across sections.
  const [sbId, setSbId] = useState("");
  const [sbLoading, setSbLoading] = useState(false);
  const [sbCmd, setSbCmd] = useState("");
  const [sbOutput, setSbOutput] = useState<Array<{ cmd: string; stdout: string; stderr: string; exit_code: number }>>([]);
  const [sbFiles, setSbFiles] = useState<Array<{ name: string; size: number }>>([]);

  /* Sync local state when data props change */
  useEffect(() => {
    setEditSystemPrompt(data?.systemPrompt || data?.system_prompt || "You are a helpful AI assistant.");
    setEditTemp(data?.temperature?.toString() ?? "0.7");
    setEditMaxTokens(data?.maxTokens?.toString() ?? data?.max_tokens?.toString() ?? "4096");
  }, [data?.systemPrompt, data?.system_prompt, data?.temperature, data?.maxTokens, data?.max_tokens]);

  switch (section) {
    /* ── Tools ─────────────────────────────────────────────── */
    case "tools":
      return (
        <div>
          <SectionTitle>Configured Tools</SectionTitle>
          <div className="space-y-2 mb-6">
            {(data.tools || []).map((tool: string, i: number) => (
              <div key={i} className="flex items-center gap-3 px-4 py-3 bg-white-alpha-5 rounded-lg border border-border-default">
                <Zap size={13} className="text-accent flex-shrink-0" />
                <code className="text-sm font-mono text-text-primary flex-1">{tool}</code>
                <button className="text-text-muted hover:text-status-error transition-colors"><Trash2 size={13} /></button>
              </div>
            ))}
            {(!data.tools || data.tools.length === 0) && <EmptyTab message="No tools configured" />}
          </div>
          <SectionTitle>Available Tools</SectionTitle>
          <div className="space-y-1.5 max-h-64 overflow-y-auto">
            {["web_search", "sandbox_exec", "file_read", "file_write", "send_email", "http_request", "create_chart", "query_database"].map((tool) => (
              <div key={tool} className="flex items-center gap-3 px-4 py-2.5 bg-white-alpha-5 rounded-lg border border-border-default">
                <Zap size={12} className="text-text-muted flex-shrink-0" />
                <code className="text-xs font-mono text-text-secondary flex-1">{tool}</code>
                <button className="text-xs text-accent hover:underline">+ Add</button>
              </div>
            ))}
          </div>
        </div>
      );

    /* ── Sessions ─────────────────────────────────────────── */
    case "sessions":
      return (
        <div>
          <div className="flex items-center justify-between mb-4">
            <SectionTitle>Agent Sessions</SectionTitle>
            <div className="flex gap-1">
              {["all", "active", "completed", "failed"].map((f) => (
                <button key={f} onClick={() => setSessionFilter(f)}
                  className={`px-2.5 py-1 text-xs rounded-md transition-colors ${sessionFilter === f ? "bg-accent/20 text-accent" : "text-text-muted hover:bg-white-alpha-8"}`}>
                  {f}
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-2">
            {[
              { id: "sess_a1b2", status: "active", turns: 12, started: "5 min ago", tokens: "3.2K", task: "Analyzing Q4 revenue data" },
              { id: "sess_c3d4", status: "completed", turns: 8, started: "1 hour ago", tokens: "2.1K", task: "Draft weekly report" },
              { id: "sess_e5f6", status: "completed", turns: 24, started: "3 hours ago", tokens: "8.7K", task: "Customer support ticket #4521" },
              { id: "sess_g7h8", status: "failed", turns: 3, started: "5 hours ago", tokens: "0.4K", task: "API integration test" },
              { id: "sess_i9j0", status: "completed", turns: 15, started: "1 day ago", tokens: "5.3K", task: "Code review PR #287" },
            ].filter((s) => sessionFilter === "all" || s.status === sessionFilter).map((s) => (
              <div key={s.id} className="bg-white-alpha-5 rounded-lg border border-border-default p-4">
                <div className="flex items-center gap-2 mb-2">
                  <code className="text-xs font-mono text-accent">{s.id}</code>
                  <StatusPill status={s.status} />
                  {s.status === "active" && (
                    <button className="ml-auto text-xs text-status-error hover:underline flex items-center gap-1">
                      <Pause size={11} /> Terminate
                    </button>
                  )}
                </div>
                <p className="text-sm text-text-primary mb-1.5">{s.task}</p>
                <div className="flex items-center gap-4 text-xs text-text-muted">
                  <span className="flex items-center gap-1"><MessageSquare size={11} /> {s.turns} turns</span>
                  <span className="flex items-center gap-1"><Zap size={11} /> {s.tokens} tokens</span>
                  <span className="flex items-center gap-1"><Clock size={11} /> {s.started}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      );

    /* ── Memory ───────────────────────────────────────────── */
    case "memory":
      return (
        <div>
          <div className="flex items-center gap-1 mb-4">
            {(["facts", "episodes", "procedures"] as const).map((t) => (
              <button key={t} onClick={() => setMemoryTab(t)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${memoryTab === t ? "bg-accent/20 text-accent" : "text-text-muted hover:bg-white-alpha-8"}`}>
                {t.charAt(0).toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>

          {memoryTab === "facts" && (
            <div>
              <div className="space-y-2 mb-4">
                {[
                  { key: "user_preference", value: "Prefers concise responses with bullet points" },
                  { key: "timezone", value: "America/Chicago (CDT)" },
                  { key: "role", value: "Senior Product Manager at TechCorp" },
                  { key: "communication_style", value: "Direct and data-driven" },
                  { key: "project_context", value: "Working on Q1 2026 product roadmap" },
                ].map((f) => (
                  <div key={f.key} className="bg-white-alpha-5 rounded-lg border border-border-default p-3">
                    <div className="flex items-center gap-2 mb-1">
                      <code className="text-xs font-mono text-accent">{f.key}</code>
                      <button className="ml-auto text-text-muted hover:text-status-error"><Trash2 size={11} /></button>
                    </div>
                    <p className="text-sm text-text-secondary">{f.value}</p>
                  </div>
                ))}
              </div>
              <div className="flex gap-2">
                <input value={newFact.key} onChange={(e) => setNewFact({ ...newFact, key: e.target.value })} placeholder="key"
                  className="flex-1 px-3 py-2 text-sm font-mono bg-white-alpha-5 border border-border-default rounded-lg text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent/50" />
                <input value={newFact.value} onChange={(e) => setNewFact({ ...newFact, value: e.target.value })} placeholder="value"
                  className="flex-[2] px-3 py-2 text-sm bg-white-alpha-5 border border-border-default rounded-lg text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent/50" />
                <button onClick={() => {
                  if (newFact.key.trim() && newFact.value.trim()) {
                    const facts = [...(data?.facts || []), { key: newFact.key, value: newFact.value }];
                    onUpdateNode?.(nodeId, { ...data, facts });
                    setNewFact({ key: "", value: "" });
                  }
                }}
                  className="px-4 py-2 text-sm font-medium bg-accent text-text-inverse rounded-lg hover:bg-accent/90 transition-colors">Add</button>
              </div>
            </div>
          )}

          {memoryTab === "episodes" && (
            <div className="space-y-2">
              {[
                { id: "ep_1", summary: "Helped user draft product requirements document", turns: 15, time: "2 hours ago" },
                { id: "ep_2", summary: "Analyzed competitor pricing data from CSV upload", turns: 8, time: "5 hours ago" },
                { id: "ep_3", summary: "Debugged API integration with Stripe webhooks", turns: 22, time: "1 day ago" },
              ].map((ep) => (
                <div key={ep.id} className="bg-white-alpha-5 rounded-lg border border-border-default p-3">
                  <div className="flex items-center gap-2 mb-1">
                    <code className="text-xs font-mono text-accent">{ep.id}</code>
                    <span className="text-xs text-text-muted">{ep.time}</span>
                    <button className="ml-auto text-text-muted hover:text-status-error"><Trash2 size={11} /></button>
                  </div>
                  <p className="text-sm text-text-primary">{ep.summary}</p>
                  <span className="text-xs text-text-muted">{ep.turns} turns</span>
                </div>
              ))}
            </div>
          )}

          {memoryTab === "procedures" && (
            <div className="space-y-2">
              {[
                { name: "weekly_report", description: "Generate weekly status report from Jira + Slack data", successRate: 95 },
                { name: "code_review", description: "Review PR against team coding standards", successRate: 88 },
                { name: "customer_response", description: "Draft customer support response using knowledge base", successRate: 92 },
              ].map((p) => (
                <div key={p.name} className="bg-white-alpha-5 rounded-lg border border-border-default p-3">
                  <div className="flex items-center gap-2 mb-1">
                    <code className="text-xs font-mono text-accent">{p.name}</code>
                    <span className="ml-auto text-xs text-status-live">{p.successRate}%</span>
                  </div>
                  <p className="text-sm text-text-secondary">{p.description}</p>
                  <div className="mt-2 h-1.5 bg-white-alpha-8 rounded-full overflow-hidden">
                    <div className="h-full bg-status-live rounded-full" style={{ width: `${p.successRate}%` }} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      );

    /* ── Chat ─────────────────────────────────────────────── */
    case "chat": {
      const handleSendMessage = async () => {
        if (chatInput.trim() && !chatLoading) {
          const userMsg = chatInput.trim();
          setChatMessages((prev) => [...prev, { role: "user", content: userMsg }]);
          setChatInput("");
          setChatLoading(true);
          try {
            const res = await apiRequest<{ response: string; session_id?: string; turns?: number; cost_usd?: number }>(
              `/api/v1/agents/${data.name}/chat`,
              "POST",
              { message: userMsg, session_id: chatSessionId },
            );
            if (res.session_id) setChatSessionId(res.session_id);
            setChatMessages((prev) => [...prev, { role: "assistant", content: res.response }]);
          } catch (err) {
            setChatMessages((prev) => [...prev, {
              role: "assistant",
              content: `Error: ${err instanceof Error ? err.message : "Failed to reach agent"}`,
            }]);
          } finally {
            setChatLoading(false);
          }
        }
      };
      return (
        <div className="flex flex-col" style={{ height: "calc(92vh - 200px)" }}>
          <div className="flex-1 overflow-y-auto space-y-3 mb-4">
            {chatMessages.length === 0 && (
              <div className="flex flex-col items-center justify-center h-full text-center">
                <MessageSquare size={28} className="text-text-muted mb-2" />
                <p className="text-sm text-text-muted mb-1">Chat with {data.name || "this agent"}</p>
                <p className="text-xs text-text-muted">Send a message to start a conversation</p>
              </div>
            )}
            {chatMessages.map((msg, i) => (
              <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                <div className={`max-w-[80%] rounded-lg px-4 py-2.5 text-sm ${
                  msg.role === "user" ? "bg-accent/20 text-text-primary" : "bg-white-alpha-5 border border-border-default text-text-primary"
                }`}>
                  {msg.content}
                </div>
              </div>
            ))}
            {chatLoading && (
              <div className="flex justify-start">
                <div className="bg-white-alpha-5 border border-border-default rounded-lg px-4 py-2.5">
                  <div className="flex gap-1">
                    <span className="w-2 h-2 bg-text-muted rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                    <span className="w-2 h-2 bg-text-muted rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                    <span className="w-2 h-2 bg-text-muted rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
                  </div>
                </div>
              </div>
            )}
          </div>
          <div className="border-t border-border-default pt-3">
            <div className="flex gap-2">
              <input
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSendMessage();
                }}
                placeholder={`Message ${data.name || "agent"}...`}
                className="flex-1 px-3 py-2.5 text-sm bg-white-alpha-5 border border-border-default rounded-lg text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent/50"
              />
              <button
                onClick={handleSendMessage}
                disabled={!chatInput.trim() || chatLoading}
                className="flex items-center justify-center w-10 h-10 bg-accent text-text-inverse rounded-lg hover:bg-accent/90 transition-colors disabled:opacity-40"
              >
                <Send size={16} />
              </button>
            </div>
          </div>
        </div>
      );
    }

    /* ── Sandbox ──────────────────────────────────────────── */
    case "sandbox": {
      const agentName = data.name || "";
      const isOnline = data.status === "online";

      const createSandbox = async () => {
        setSbLoading(true);
        try {
          const resp = await apiRequest<{ sandbox_id: string }>("/api/v1/sandbox/create", "POST", {
            agent_name: agentName, template: "default", timeout_seconds: 300,
          });
          setSbId(resp.sandbox_id || "");
        } catch { /* handled by loading state */ }
        finally { setSbLoading(false); }
      };

      const execCommand = async () => {
        if (!sbId || !sbCmd.trim()) return;
        setSbLoading(true);
        try {
          const resp = await apiRequest<{ stdout: string; stderr: string; exit_code: number }>("/api/v1/sandbox/exec", "POST", {
            sandbox_id: sbId, command: sbCmd,
          });
          setSbOutput((prev) => [...prev, { cmd: sbCmd, stdout: resp.stdout || "", stderr: resp.stderr || "", exit_code: resp.exit_code ?? 0 }]);
          setSbCmd("");
        } catch {
          setSbOutput((prev) => [...prev, { cmd: sbCmd, stdout: "", stderr: "Execution failed", exit_code: 1 }]);
        } finally { setSbLoading(false); }
      };

      const killSandbox = async () => {
        if (!sbId) return;
        setSbLoading(true);
        try {
          await apiRequest("/api/v1/sandbox/kill", "POST", { sandbox_id: sbId });
          setSbId(""); setSbOutput([]); setSbFiles([]);
        } catch { /* ignore */ }
        finally { setSbLoading(false); }
      };

      const listFiles = async () => {
        if (!sbId) return;
        try {
          const resp = await apiRequest<{ files: Array<{ name: string; size: number }> }>(`/api/v1/sandbox/${sbId}/files`);
          setSbFiles(resp.files || []);
        } catch { /* ignore */ }
      };

      if (!isOnline) {
        return (
          <div>
            <SectionTitle>Sandbox</SectionTitle>
            <div className="bg-white-alpha-5 rounded-lg border border-border-default p-5 text-center">
              <Cpu size={24} className="mx-auto text-text-muted mb-2" />
              <p className="text-sm text-text-muted">Deploy this agent first to use sandboxes.</p>
            </div>
          </div>
        );
      }

      return (
        <div>
          <SectionTitle>Sandbox</SectionTitle>
          {!sbId ? (
            <div className="bg-white-alpha-5 rounded-lg border border-border-default p-5 text-center">
              <Cpu size={24} className="mx-auto text-text-muted mb-3" />
              <p className="text-sm text-text-primary mb-1">No active sandbox</p>
              <p className="text-xs text-text-muted mb-4">Create an isolated execution environment for {agentName}.</p>
              <button onClick={createSandbox} disabled={sbLoading}
                className="px-5 py-2.5 text-sm font-medium bg-accent text-text-inverse rounded-lg hover:bg-accent/90 transition-colors disabled:opacity-50">
                {sbLoading ? "Creating..." : "Create Sandbox"}
              </button>
            </div>
          ) : (
            <>
              <div className="bg-white-alpha-5 rounded-lg border border-border-default p-4 mb-4">
                <div className="flex items-center gap-2 mb-2">
                  <span className="w-2 h-2 rounded-full bg-status-live" />
                  <span className="text-sm font-medium text-text-primary">Active</span>
                  <code className="ml-auto text-xs font-mono text-text-muted">{sbId.slice(0, 12)}...</code>
                </div>
                <div className="flex gap-2">
                  <button onClick={listFiles} className="text-xs text-accent hover:text-accent-hover transition-colors">List Files</button>
                  <button onClick={killSandbox} className="text-xs text-status-error hover:text-status-error/80 transition-colors ml-auto">Kill Sandbox</button>
                </div>
              </div>

              {sbFiles.length > 0 && (
                <div className="mb-4">
                  <p className="text-xs font-medium text-text-muted uppercase tracking-wider mb-2">Files</p>
                  <div className="bg-white-alpha-5 rounded-lg border border-border-default divide-y divide-border-default">
                    {sbFiles.map((f) => (
                      <div key={f.name} className="px-3 py-2 flex items-center justify-between">
                        <span className="text-xs font-mono text-text-primary">{f.name}</span>
                        <span className="text-xs text-text-muted">{f.size}B</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {sbOutput.length > 0 && (
                <div className="mb-4 bg-surface-base rounded-lg border border-border-default p-3 max-h-60 overflow-y-auto font-mono text-xs">
                  {sbOutput.map((entry, i) => (
                    <div key={i} className="mb-2">
                      <div className="text-accent">$ {entry.cmd}</div>
                      {entry.stdout && <pre className="text-text-primary whitespace-pre-wrap">{entry.stdout}</pre>}
                      {entry.stderr && <pre className="text-status-error whitespace-pre-wrap">{entry.stderr}</pre>}
                      {entry.exit_code !== 0 && <span className="text-status-error text-[10px]">exit {entry.exit_code}</span>}
                    </div>
                  ))}
                </div>
              )}

              <div className="flex gap-2">
                <input value={sbCmd} onChange={(e) => setSbCmd(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") execCommand(); }}
                  placeholder="$ type a command..."
                  className="flex-1 px-3 py-2.5 text-sm bg-white-alpha-5 border border-border-default rounded-lg text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent/50 font-mono" />
                <button onClick={execCommand} disabled={!sbCmd.trim() || sbLoading}
                  className="px-4 py-2.5 text-sm font-medium bg-accent text-text-inverse rounded-lg hover:bg-accent/90 transition-colors disabled:opacity-40">
                  {sbLoading ? "..." : "Run"}
                </button>
              </div>
            </>
          )}
        </div>
      );
    }

    /* ── Eval ─────────────────────────────────────────────── */
    case "eval":
      return (
        <div>
          <SectionTitle>Evaluation Runs</SectionTitle>
          <div className="space-y-2 mb-6">
            {[
              { id: "eval_001", taskFile: "support-tasks.jsonl", status: "passed", score: 94, tasks: 50, time: "2 hours ago", latency: "1.2s", cost: "$0.85" },
              { id: "eval_002", taskFile: "coding-tasks.jsonl", status: "passed", score: 87, tasks: 30, time: "1 day ago", latency: "2.4s", cost: "$1.20" },
              { id: "eval_003", taskFile: "reasoning-tasks.jsonl", status: "failed", score: 62, tasks: 25, time: "3 days ago", latency: "3.1s", cost: "$0.95" },
            ].map((ev) => (
              <div key={ev.id} className="bg-white-alpha-5 rounded-lg border border-border-default p-4">
                <div className="flex items-center gap-2 mb-2">
                  <code className="text-xs font-mono text-accent">{ev.id}</code>
                  <StatusPill status={ev.status} />
                  <span className="ml-auto text-xs text-text-muted">{ev.time}</span>
                </div>
                <p className="text-sm text-text-primary mb-2">{ev.taskFile}</p>
                <div className="grid grid-cols-4 gap-3">
                  {[
                    { label: "Score", value: `${ev.score}%` },
                    { label: "Tasks", value: `${ev.tasks}` },
                    { label: "Latency", value: ev.latency },
                    { label: "Cost", value: ev.cost },
                  ].map((m) => (
                    <div key={m.label} className="text-center">
                      <p className="text-[10px] text-text-muted">{m.label}</p>
                      <p className="text-sm font-semibold text-text-primary">{m.value}</p>
                    </div>
                  ))}
                </div>
                <div className="mt-2 h-1.5 bg-white-alpha-8 rounded-full overflow-hidden">
                  <div className={`h-full rounded-full ${ev.score >= 80 ? "bg-status-live" : ev.score >= 60 ? "bg-status-warning" : "bg-status-error"}`}
                    style={{ width: `${ev.score}%` }} />
                </div>
              </div>
            ))}
          </div>

          <SectionTitle>Run New Evaluation</SectionTitle>
          <div className="bg-white-alpha-5 rounded-lg border border-border-default p-5">
            <InlineSelect label="Task File" value="support-tasks.jsonl" onChange={() => {}}
              options={[
                { value: "support-tasks.jsonl", label: "support-tasks.jsonl (50 tasks)" },
                { value: "coding-tasks.jsonl", label: "coding-tasks.jsonl (30 tasks)" },
                { value: "reasoning-tasks.jsonl", label: "reasoning-tasks.jsonl (25 tasks)" },
              ]} />
            <button className="w-full py-2.5 text-sm font-medium bg-accent text-text-inverse rounded-lg hover:bg-accent/90 transition-colors flex items-center justify-center gap-2">
              <Play size={14} /> Start Eval Run
            </button>
          </div>
          <button className="mt-4 w-full py-2.5 text-sm font-medium border border-dashed border-border-default rounded-lg text-text-muted hover:border-accent/40 hover:text-accent transition-colors flex items-center justify-center gap-2">
            <Upload size={14} /> Upload Task File
          </button>
        </div>
      );

    /* ── Releases ─────────────────────────────────────────── */
    case "releases":
      return (
        <div>
          <SectionTitle>Release Channels</SectionTitle>
          <div className="space-y-2 mb-6">
            {[
              { name: "production", version: "v1.3.2", traffic: 100, status: "active" },
              { name: "staging", version: "v1.4.0-rc1", traffic: 100, status: "active" },
              { name: "canary", version: "v1.4.0-beta", traffic: 5, status: "active" },
            ].map((ch) => (
              <div key={ch.name} className="bg-white-alpha-5 rounded-lg border border-border-default p-4">
                <div className="flex items-center gap-2 mb-2">
                  <Tag size={13} className="text-accent" />
                  <span className="text-sm font-medium text-text-primary">{ch.name}</span>
                  <StatusPill status={ch.status} />
                  <span className="ml-auto text-xs font-mono text-text-muted">{ch.version}</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="flex-1 h-1.5 bg-white-alpha-8 rounded-full overflow-hidden">
                    <div className="h-full bg-accent rounded-full" style={{ width: `${ch.traffic}%` }} />
                  </div>
                  <span className="text-xs text-text-muted">{ch.traffic}%</span>
                </div>
              </div>
            ))}
          </div>

          <SectionTitle>Promote</SectionTitle>
          <div className="bg-white-alpha-5 rounded-lg border border-border-default p-5">
            <InlineSelect label="From" value="staging" onChange={() => {}}
              options={[{ value: "staging", label: "staging (v1.4.0-rc1)" }, { value: "canary", label: "canary (v1.4.0-beta)" }]} />
            <InlineSelect label="To" value="production" onChange={() => {}}
              options={[{ value: "production", label: "production" }, { value: "staging", label: "staging" }]} />
            <InlineInput label="Traffic %" value="100" onChange={() => {}} type="number" />
            <button className="w-full py-2.5 text-sm font-medium bg-accent text-text-inverse rounded-lg hover:bg-accent/90 transition-colors flex items-center justify-center gap-2">
              <Rocket size={14} /> Promote Release
            </button>
          </div>
        </div>
      );

    /* ── Governance ────────────────────────────────────────── */
    case "governance":
      return (
        <div>
          <SectionTitle>Governance Rules</SectionTitle>
          <div className="bg-white-alpha-5 rounded-lg border border-border-default p-5 space-y-0">
            <ToggleRow label="Require approval for deployment" description="All deployments must be approved by a team admin" checked={requireApproval} onChange={setRequireApproval} />
            <ToggleRow label="Human-in-the-loop" description="Agent must get human confirmation for sensitive actions" checked={humanInLoop} onChange={setHumanInLoop} />
          </div>
          <div className="mt-6">
            <SectionTitle>Budget Limits</SectionTitle>
            <InlineInput label="Monthly budget ($)" value={budgetLimit} onChange={setBudgetLimit} type="number" placeholder="50" />
          </div>
        </div>
      );

    /* ── Config ───────────────────────────────────────────── */
    case "config":
      return (
        <div>
          <SectionTitle>Agent Settings</SectionTitle>
          <InlineInput label="Name" value={editName} onChange={setEditName} placeholder="Agent name" />
          <InlineSelect label="Model" value={editModel} onChange={setEditModel}
            options={[
              { value: "gpt-4.1-mini", label: "gpt-4.1-mini" },
              { value: "gpt-4.1-nano", label: "gpt-4.1-nano" },
              { value: "gpt-4o", label: "gpt-4o" },
              { value: "gemini-2.5-flash", label: "gemini-2.5-flash" },
              { value: "claude-sonnet-4", label: "claude-sonnet-4" },
            ]} />
          <InlineTextarea label="System Prompt" value={editSystemPrompt} onChange={setEditSystemPrompt} placeholder="You are a helpful AI assistant..." rows={6} />
          <InlineInput label="Temperature" value={editTemp} onChange={setEditTemp} type="number" placeholder="0.7" />
          <InlineInput label="Max Tokens" value={editMaxTokens} onChange={setEditMaxTokens} type="number" placeholder="4096" />
          <button onClick={() => { onUpdateNode?.(nodeId, { ...data, name: editName, model: editModel, systemPrompt: editSystemPrompt, temperature: parseFloat(editTemp), maxTokens: parseInt(editMaxTokens) }); }}
            className="mt-2 w-full py-2.5 text-sm font-medium bg-accent text-text-inverse rounded-lg hover:bg-accent/90 transition-colors">Save Changes</button>
        </div>
      );

    /* ── Danger ───────────────────────────────────────────── */
    case "danger":
      return (
        <div>
          <SectionTitle>Danger Zone</SectionTitle>
          <div className="bg-white-alpha-5 rounded-lg border border-status-error/20 p-5">
            <p className="text-sm text-text-primary mb-1">Delete this agent</p>
            <p className="text-xs text-text-muted mb-4">Permanently delete this agent and all associated data. This action cannot be undone.</p>
            <button className="px-5 py-2 text-sm font-medium text-status-error border border-status-error/30 rounded-lg hover:bg-status-error/10 transition-colors">Delete Agent</button>
          </div>
        </div>
      );

    default:
      return <EmptyTab message={`Section "${section}" not implemented`} />;
  }
}

/* ═══════════════════════════════════════════════════════════════════
   KNOWLEDGE TAB CONTENT
   ═══════════════════════════════════════════════════════════════════ */
function KnowledgeTabContent({ tabId, data, nodeId }: { tabId: string; data: KnowledgeNodeData; nodeId: string }) {
  switch (tabId) {
    case "overview":
      return (
        <div className="max-w-2xl">
          <SectionTitle>Knowledge Base</SectionTitle>
          <div className="bg-white-alpha-5 rounded-lg border border-border-default p-5">
            <InfoRow label="Name" value={data.name || "—"} />
            <InfoRow label="Documents" value={`${data.docCount || 0}`} />
            <InfoRow label="Total Size" value={data.totalSize || "—"} />
            <InfoRow label="Chunks" value={`${data.chunkCount || 0}`} />
            <InfoRow label="Status" value={<span className="flex items-center gap-1.5"><span className={`w-2 h-2 rounded-full ${getStatusColor(data.status)}`} />{(data.status || "unknown").toUpperCase()}</span>} />
          </div>
        </div>
      );
    case "documents":
      return (
        <div className="max-w-2xl">
          <SectionTitle>Documents</SectionTitle>
          <div className="space-y-2 mb-4">
            {[
              { name: "getting-started.md", size: "24 KB", chunks: 12 },
              { name: "api-reference.md", size: "156 KB", chunks: 89 },
              { name: "faq.md", size: "8 KB", chunks: 6 },
              { name: "troubleshooting.pdf", size: "2.1 MB", chunks: 142 },
              { name: "changelog.md", size: "45 KB", chunks: 28 },
            ].map((doc) => (
              <div key={doc.name} className="flex items-center gap-3 px-4 py-3 bg-white-alpha-5 rounded-lg border border-border-default">
                <FileText size={14} className="text-chart-purple flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-mono text-text-primary truncate">{doc.name}</p>
                  <p className="text-xs text-text-muted">{doc.size} &middot; {doc.chunks} chunks</p>
                </div>
                <button className="text-text-muted hover:text-status-error transition-colors"><Trash2 size={13} /></button>
              </div>
            ))}
          </div>
          <button className="w-full py-2.5 text-sm font-medium border border-dashed border-border-default rounded-lg text-text-muted hover:border-accent/40 hover:text-accent transition-colors flex items-center justify-center gap-2">
            <Upload size={14} /> Upload Document
          </button>
        </div>
      );
    case "chunks":
      return (
        <div className="max-w-2xl">
          <SectionTitle>Chunk Browser</SectionTitle>
          <div className="space-y-2">
            {[
              { id: "chunk_001", source: "api-reference.md", text: "The /agents endpoint accepts POST requests with a JSON body containing the agent configuration..." },
              { id: "chunk_002", source: "getting-started.md", text: "To create your first agent, navigate to the Canvas and right-click to add a new Agent node..." },
              { id: "chunk_003", source: "faq.md", text: "Q: How do I connect a knowledge base? A: Click the Knowledge node and use the Documents tab to upload files..." },
            ].map((chunk) => (
              <div key={chunk.id} className="bg-white-alpha-5 rounded-lg border border-border-default p-4">
                <div className="flex items-center gap-2 mb-2">
                  <code className="text-xs font-mono text-accent">{chunk.id}</code>
                  <span className="text-xs text-text-muted">{chunk.source}</span>
                </div>
                <p className="text-sm text-text-secondary leading-relaxed">{chunk.text}</p>
              </div>
            ))}
          </div>
        </div>
      );
    case "settings":
      return (
        <div className="max-w-2xl">
          <SectionTitle>Knowledge Base Settings</SectionTitle>
          <InlineInput label="Name" value={data.name || ""} onChange={() => {}} placeholder="Knowledge base name" />
          <InlineSelect label="Embedding Model" value="text-embedding-3-small" onChange={() => {}}
            options={[
              { value: "text-embedding-3-small", label: "text-embedding-3-small" },
              { value: "text-embedding-3-large", label: "text-embedding-3-large" },
            ]} />
          <InlineInput label="Chunk Size" value="512" onChange={() => {}} type="number" />
          <InlineInput label="Chunk Overlap" value="50" onChange={() => {}} type="number" />
          <button className="mt-2 w-full py-2.5 text-sm font-medium bg-accent text-text-inverse rounded-lg hover:bg-accent/90 transition-colors">Save Changes</button>
        </div>
      );
    default:
      return <EmptyTab message={`Tab "${tabId}" not implemented`} />;
  }
}

/* ═══════════════════════════════════════════════════════════════════
   DATA SOURCE TAB CONTENT
   ═══════════════════════════════════════════════════════════════════ */
function DataSourceTabContent({ tabId, data, nodeId }: { tabId: string; data: DataSourceNodeData; nodeId: string }) {
  switch (tabId) {
    case "overview":
      return (
        <div className="max-w-2xl">
          <SectionTitle>Data Source</SectionTitle>
          <div className="bg-white-alpha-5 rounded-lg border border-border-default p-5">
            <InfoRow label="Name" value={data.name || "—"} />
            <InfoRow label="Type" value={data.dbType || "—"} />
            <InfoRow label="Status" value={<span className="flex items-center gap-1.5"><span className={`w-2 h-2 rounded-full ${getStatusColor(data.status)}`} />{(data.status || "unknown").toUpperCase()}</span>} />
            <InfoRow label="Tables" value={`${data.tableCount || 0}`} />
          </div>
        </div>
      );
    case "tables":
      return (
        <div className="max-w-2xl">
          <SectionTitle>Tables</SectionTitle>
          <div className="space-y-1.5">
            {["users", "orders", "products", "analytics_events", "sessions", "invoices"].map((t) => (
              <div key={t} className="flex items-center gap-3 px-4 py-3 bg-white-alpha-5 rounded-lg border border-border-default">
                <Layers size={13} className="text-chart-cyan flex-shrink-0" />
                <code className="text-sm font-mono text-text-primary">{t}</code>
              </div>
            ))}
          </div>
        </div>
      );
    case "queries":
      return (
        <div className="max-w-2xl">
          <SectionTitle>Saved Queries</SectionTitle>
          <div className="space-y-2">
            {[
              { name: "Active users", query: "SELECT COUNT(*) FROM users WHERE last_active > NOW() - INTERVAL '7 days'" },
              { name: "Revenue today", query: "SELECT SUM(amount) FROM orders WHERE created_at::date = CURRENT_DATE" },
            ].map((q) => (
              <div key={q.name} className="bg-white-alpha-5 rounded-lg border border-border-default p-4">
                <p className="text-sm font-medium text-text-primary mb-2">{q.name}</p>
                <code className="text-xs font-mono text-text-secondary block bg-white-alpha-8 rounded p-2">{q.query}</code>
              </div>
            ))}
          </div>
        </div>
      );
    case "settings":
      return (
        <div className="max-w-2xl">
          <SectionTitle>Connection Settings</SectionTitle>
          <InlineInput label="Host" value={data.host || "localhost"} onChange={() => {}} />
          <InlineInput label="Port" value={data.port?.toString() || "5432"} onChange={() => {}} type="number" />
          <InlineInput label="Database" value={data.database || "mydb"} onChange={() => {}} />
          <button className="mt-2 w-full py-2.5 text-sm font-medium bg-accent text-text-inverse rounded-lg hover:bg-accent/90 transition-colors">Save Changes</button>
        </div>
      );
    default:
      return <EmptyTab message={`Tab "${tabId}" not implemented`} />;
  }
}

/* ═══════════════════════════════════════════════════════════════════
   CONNECTOR TAB CONTENT
   ═══════════════════════════════════════════════════════════════════ */
function ConnectorTabContent({ tabId, data, nodeId }: { tabId: string; data: ConnectorNodeData; nodeId: string }) {
  switch (tabId) {
    case "overview":
      return (
        <div className="max-w-2xl">
          <SectionTitle>Connector</SectionTitle>
          <div className="bg-white-alpha-5 rounded-lg border border-border-default p-5">
            <InfoRow label="Name" value={data.name || "—"} />
            <InfoRow label="Provider" value={data.provider || "—"} />
            <InfoRow label="Status" value={<span className="flex items-center gap-1.5"><span className={`w-2 h-2 rounded-full ${getStatusColor(data.status)}`} />{(data.status || "unknown").toUpperCase()}</span>} />
            <InfoRow label="Tools" value={`${data.toolCount || 0}`} />
          </div>
        </div>
      );
    case "tools":
      return (
        <div className="max-w-2xl">
          <SectionTitle>Available Tools</SectionTitle>
          <div className="space-y-1.5">
            {(data.toolList || ["send_message", "list_channels", "create_channel", "upload_file", "search_messages"]).map((t: string) => (
              <div key={t} className="flex items-center gap-3 px-4 py-3 bg-white-alpha-5 rounded-lg border border-border-default">
                <Zap size={13} className="text-chart-green flex-shrink-0" />
                <code className="text-sm font-mono text-text-primary">{t}</code>
              </div>
            ))}
          </div>
        </div>
      );
    case "oauth":
      return (
        <div className="max-w-2xl">
          <SectionTitle>OAuth Configuration</SectionTitle>
          <div className="bg-white-alpha-5 rounded-lg border border-border-default p-5">
            <InfoRow label="Auth Status" value={<StatusPill status={data.status === "authed" ? "active" : "pending"} />} />
            <InfoRow label="Scopes" value="read, write, admin" />
            <InfoRow label="Token Expires" value="in 30 days" />
          </div>
          <button className="mt-4 w-full py-2.5 text-sm font-medium border border-dashed border-border-default rounded-lg text-text-muted hover:border-accent/40 hover:text-accent transition-colors">
            Re-authorize OAuth
          </button>
        </div>
      );
    case "settings":
      return (
        <div className="max-w-2xl">
          <SectionTitle>Connector Settings</SectionTitle>
          <InlineInput label="Display Name" value={data.name || ""} onChange={() => {}} />
          <InlineInput label="Webhook URL" value="" onChange={() => {}} placeholder="https://..." />
          <button className="mt-2 w-full py-2.5 text-sm font-medium bg-accent text-text-inverse rounded-lg hover:bg-accent/90 transition-colors">Save Changes</button>
        </div>
      );
    default:
      return <EmptyTab message={`Tab "${tabId}" not implemented`} />;
  }
}

/* ═══════════════════════════════════════════════════════════════════
   MCP SERVER TAB CONTENT
   ═══════════════════════════════════════════════════════════════════ */
function McpServerTabContent({ tabId, data, nodeId }: { tabId: string; data: McpServerNodeData; nodeId: string }) {
  switch (tabId) {
    case "overview":
      return (
        <div className="max-w-2xl">
          <SectionTitle>MCP Server</SectionTitle>
          <div className="bg-white-alpha-5 rounded-lg border border-border-default p-5">
            <InfoRow label="Name" value={data.name || "—"} />
            <InfoRow label="URL" value={data.url || "—"} mono />
            <InfoRow label="Status" value={<span className="flex items-center gap-1.5"><span className={`w-2 h-2 rounded-full ${getStatusColor(data.status)}`} />{(data.status || "unknown").toUpperCase()}</span>} />
            <InfoRow label="Tools" value={`${data.toolCount || 0}`} />
          </div>
        </div>
      );
    case "tools":
      return (
        <div className="max-w-2xl">
          <SectionTitle>Server Tools</SectionTitle>
          <div className="space-y-1.5">
            {(data.toolList || ["get_customer", "update_customer", "list_tickets", "create_ticket", "search_kb", "get_order", "update_order", "send_notification"]).map((t: string) => (
              <div key={t} className="flex items-center gap-3 px-4 py-3 bg-white-alpha-5 rounded-lg border border-border-default">
                <Zap size={13} className="text-chart-blue flex-shrink-0" />
                <code className="text-sm font-mono text-text-primary">{t}</code>
              </div>
            ))}
          </div>
        </div>
      );
    case "health":
      return (
        <div className="max-w-2xl">
          <SectionTitle>Health Status</SectionTitle>
          <div className="grid grid-cols-2 gap-4 mb-6">
            {[
              { label: "Uptime", value: "99.9%" },
              { label: "Avg Latency", value: "45ms" },
              { label: "Requests (24h)", value: "12,847" },
              { label: "Errors (24h)", value: "3" },
            ].map((m) => (
              <div key={m.label} className="bg-white-alpha-5 rounded-lg border border-border-default p-4">
                <p className="text-xs text-text-muted">{m.label}</p>
                <p className="text-xl font-semibold text-text-primary mt-1">{m.value}</p>
              </div>
            ))}
          </div>
        </div>
      );
    case "settings":
      return (
        <div className="max-w-2xl">
          <SectionTitle>Server Settings</SectionTitle>
          <InlineInput label="Display Name" value={data.name || ""} onChange={() => {}} />
          <InlineInput label="Server URL" value={data.url || ""} onChange={() => {}} placeholder="https://..." />
          <InlineInput label="API Key" value="***" onChange={() => {}} type="password" />
          <button className="mt-2 w-full py-2.5 text-sm font-medium bg-accent text-text-inverse rounded-lg hover:bg-accent/90 transition-colors">Save Changes</button>
        </div>
      );
    default:
      return <EmptyTab message={`Tab "${tabId}" not implemented`} />;
  }
}
