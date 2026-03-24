import { useState, useRef, useEffect, useCallback, type ReactNode } from "react";
import {
  X, Bot, Database, BookOpen, Plug, Server, Rocket, Settings, Activity, Code,
  ShieldCheck, FileText, Layers, Zap, Key, BarChart3, Play, Trash2, Copy,
  MoreVertical, MessageSquare, Brain, FlaskConical, Tag, Send, Clock,
  CheckCircle2, XCircle, AlertTriangle, Pause, RotateCcw, Upload, Search,
  ChevronRight, Cpu,
} from "lucide-react";
import type { Node } from "@xyflow/react";
import { apiRequest, useApiQuery, getToken } from "../../lib/api";
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

/* ── Memory Episodes list (fetched from API) ──────────────────────── */
function MemoryEpisodesList({ agentName }: { agentName: string }) {
  const episodesQuery = useApiQuery<{ episodes?: Array<{ id: string; summary: string; turns?: number; created_at?: string }> }>(
    `/api/v1/memory/${encodeURIComponent(agentName)}/episodes?limit=20`,
    Boolean(agentName),
  );
  const episodes = episodesQuery.data?.episodes ?? [];

  if (episodesQuery.loading) return <p className="text-xs text-text-muted">Loading episodes...</p>;
  if (episodes.length === 0) return <EmptyTab message="No episodes recorded yet." />;

  return (
    <div className="space-y-2">
      {episodes.map((ep) => (
        <div key={ep.id} className="bg-white-alpha-5 rounded-lg border border-border-default p-3">
          <div className="flex items-center gap-2 mb-1">
            <code className="text-xs font-mono text-accent">{ep.id}</code>
            <span className="text-xs text-text-muted">{ep.created_at ? new Date(ep.created_at).toLocaleString() : "—"}</span>
            <button className="ml-auto text-text-muted hover:text-status-error"><Trash2 size={11} /></button>
          </div>
          <p className="text-sm text-text-primary">{ep.summary}</p>
          <span className="text-xs text-text-muted">{ep.turns ?? 0} turns</span>
        </div>
      ))}
    </div>
  );
}

/* ── Memory Procedures list (fetched from API) ────────────────────── */
function MemoryProceduresList({ agentName }: { agentName: string }) {
  const proceduresQuery = useApiQuery<{ procedures?: Array<{ name: string; description: string; success_rate?: number }> }>(
    `/api/v1/memory/${encodeURIComponent(agentName)}/procedures?limit=20`,
    Boolean(agentName),
  );
  const procedures = proceduresQuery.data?.procedures ?? [];

  if (proceduresQuery.loading) return <p className="text-xs text-text-muted">Loading procedures...</p>;
  if (procedures.length === 0) return <EmptyTab message="No learned procedures yet." />;

  return (
    <div className="space-y-2">
      {procedures.map((p) => (
        <div key={p.name} className="bg-white-alpha-5 rounded-lg border border-border-default p-3">
          <div className="flex items-center gap-2 mb-1">
            <code className="text-xs font-mono text-accent">{p.name}</code>
            <span className="ml-auto text-xs text-status-live">{p.success_rate != null ? `${p.success_rate}%` : "—"}</span>
          </div>
          <p className="text-sm text-text-secondary">{p.description}</p>
          {p.success_rate != null && (
            <div className="mt-2 h-1.5 bg-white-alpha-8 rounded-full overflow-hidden">
              <div className="h-full bg-status-live rounded-full" style={{ width: `${p.success_rate}%` }} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/* ── Memory Facts list (fetched from API) ─────────────────────────── */
function MemoryFactsList({ agentName }: { agentName: string }) {
  const factsQuery = useApiQuery<{ facts?: Array<{ key: string; value: string }> }>(
    `/api/v1/memory/${encodeURIComponent(agentName)}/facts?limit=20`,
    Boolean(agentName),
  );
  const facts = factsQuery.data?.facts ?? [];

  if (factsQuery.loading) return <p className="text-xs text-text-muted mb-4">Loading facts...</p>;
  if (facts.length === 0) return <div className="mb-4"><EmptyTab message="No facts stored — the agent will learn over time." /></div>;

  return (
    <div className="space-y-2 mb-4">
      {facts.map((f) => (
        <div key={f.key} className="bg-white-alpha-5 rounded-lg border border-border-default p-3">
          <div className="flex items-center gap-2 mb-1">
            <code className="text-xs font-mono text-accent">{f.key}</code>
            <button className="ml-auto text-text-muted hover:text-status-error"><Trash2 size={11} /></button>
          </div>
          <p className="text-sm text-text-secondary">{f.value}</p>
        </div>
      ))}
    </div>
  );
}

/* ── Available Tools list (fetched from API) ──────────────────────── */
function AvailableToolsList({ agentName }: { agentName: string }) {
  const toolsQuery = useApiQuery<{ tools?: string[] } | string[]>(
    `/api/v1/agents/${encodeURIComponent(agentName)}/tools`,
    Boolean(agentName),
  );
  const availableTools: string[] = Array.isArray(toolsQuery.data)
    ? toolsQuery.data
    : (toolsQuery.data?.tools ?? []);

  if (toolsQuery.loading) return <p className="text-xs text-text-muted">Loading available tools...</p>;
  if (availableTools.length === 0) return <EmptyTab message="No additional tools available from the server." />;

  return (
    <div className="space-y-1.5 max-h-64 overflow-y-auto">
      {availableTools.map((tool) => (
        <div key={tool} className="flex items-center gap-3 px-4 py-2.5 bg-white-alpha-5 rounded-lg border border-border-default">
          <Zap size={12} className="text-text-muted flex-shrink-0" />
          <code className="text-xs font-mono text-text-secondary flex-1">{tool}</code>
          <button className="text-xs text-accent hover:underline">+ Add</button>
        </div>
      ))}
    </div>
  );
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
    data.variables || [],
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
    case "deployments": {
      const deployHistoryQuery = useApiQuery<{ deployments?: Array<{ id: string; version: string; status: string; created_at?: string; environment?: string }> }>(
        `/api/v1/deploy/${encodeURIComponent(data.name || "")}/history`,
        Boolean(data.name),
      );
      const deployments = deployHistoryQuery.data?.deployments ?? [];

      return (
        <div className="max-w-2xl">
          <DeployStatusSection agentName={data.name || ""} />
          <SectionTitle>Deployment History</SectionTitle>
          {deployHistoryQuery.loading && <p className="text-xs text-text-muted mb-4">Loading deployment history...</p>}
          <div className="space-y-2">
            {deployments.map((d) => (
              <div key={d.id} className="bg-white-alpha-5 rounded-lg border border-border-default p-4 flex items-center gap-3">
                <span className={`w-2.5 h-2.5 rounded-full ${d.status === "active" || d.status === "deployed" ? "bg-status-live" : "bg-text-muted"}`} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-text-primary font-mono">{d.version}</p>
                  <p className="text-xs text-text-muted">{d.environment || "—"} &middot; {d.created_at ? new Date(d.created_at).toLocaleString() : "—"}</p>
                </div>
                <StatusPill status={d.status} />
              </div>
            ))}
          </div>
          {deployments.length === 0 && !deployHistoryQuery.loading && (
            <EmptyTab message="No deployments yet — deploy this agent to see history here." />
          )}
          <button className="mt-4 w-full py-2.5 text-sm font-medium border border-dashed border-border-default rounded-lg text-text-muted hover:border-accent/40 hover:text-accent transition-colors">
            + Deploy New Version
          </button>
        </div>
      );
    }

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
    case "metrics": {
      const statsQuery = useApiQuery<{
        avg_latency_ms?: number;
        success_rate?: number;
        total_tokens?: number;
        total_cost_usd?: number;
      }>(
        `/api/v1/sessions/stats/summary?agent_name=${encodeURIComponent(data.name || "")}&since_days=1`,
        Boolean(data.name),
      );
      const stats = statsQuery.data;

      const metricCards = [
        { label: "Avg Latency", value: stats?.avg_latency_ms != null ? `${(stats.avg_latency_ms / 1000).toFixed(1)}s` : "—" },
        { label: "Success Rate", value: stats?.success_rate != null ? `${(stats.success_rate * 100).toFixed(1)}%` : "—" },
        { label: "Token Usage (24h)", value: stats?.total_tokens != null ? `${(stats.total_tokens / 1000).toFixed(1)}K` : "—" },
        { label: "Cost (24h)", value: stats?.total_cost_usd != null ? `$${stats.total_cost_usd.toFixed(2)}` : "—" },
      ];

      return (
        <div className="max-w-2xl">
          <SectionTitle>Performance Metrics</SectionTitle>
          {statsQuery.loading && <p className="text-xs text-text-muted mb-4">Loading metrics...</p>}
          {statsQuery.error && !statsQuery.loading && (
            <EmptyTab message="No metrics available — run the agent to start collecting data." />
          )}
          {!statsQuery.loading && !statsQuery.error && (
            <div className="grid grid-cols-2 gap-4 mb-6">
              {metricCards.map((m) => (
                <div key={m.label} className="bg-white-alpha-5 rounded-lg border border-border-default p-4">
                  <p className="text-xs text-text-muted">{m.label}</p>
                  <p className="text-xl font-semibold text-text-primary mt-1">{m.value}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      );
    }

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
  const [streamingOutput, setStreamingOutput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const streamingRef = useRef<HTMLDivElement>(null);
  const [memoryTab, setMemoryTab] = useState<"facts" | "episodes" | "procedures">("facts");
  const [newFact, setNewFact] = useState({ key: "", value: "" });
  const [sessionFilter, setSessionFilter] = useState("all");
  // Sandbox state must stay at top-level to preserve hook order across sections.
  const [sbId, setSbId] = useState("");
  const [sbLoading, setSbLoading] = useState(false);
  const [sbCmd, setSbCmd] = useState("");
  const [sbOutput, setSbOutput] = useState<Array<{ cmd: string; stdout: string; stderr: string; exit_code: number }>>([]);
  const [sbFiles, setSbFiles] = useState<Array<{ name: string; size: number }>>([]);
  const [refreshedTools, setRefreshedTools] = useState<string[] | null>(null);
  const [toolsRefreshing, setToolsRefreshing] = useState(false);
  const [promoteFrom, setPromoteFrom] = useState("staging");
  const [promoteTo, setPromoteTo] = useState("production");
  const [promoteTraffic, setPromoteTraffic] = useState("100");
  const [promoteLoading, setPromoteLoading] = useState(false);

  /* Sync local state when data props change */
  useEffect(() => {
    setEditSystemPrompt(data?.systemPrompt || data?.system_prompt || "You are a helpful AI assistant.");
    setEditTemp(data?.temperature?.toString() ?? "0.7");
    setEditMaxTokens(data?.maxTokens?.toString() ?? data?.max_tokens?.toString() ?? "4096");
  }, [data?.systemPrompt, data?.system_prompt, data?.temperature, data?.maxTokens, data?.max_tokens]);

  switch (section) {
    /* ── Tools ─────────────────────────────────────────────── */
    case "tools": {
      const toolsList = refreshedTools ?? data.tools ?? [];

      const handleRefreshTools = async () => {
        if (!data.name) return;
        setToolsRefreshing(true);
        try {
          const res = await apiRequest<{ tools: string[] } | string[]>(
            `/api/v1/agents/${encodeURIComponent(data.name)}/tools`,
          );
          const tools = Array.isArray(res) ? res : (res.tools || []);
          setRefreshedTools(tools);
          onUpdateNode?.(nodeId, { ...data, tools });
        } catch {
          // keep existing tools on failure
        } finally {
          setToolsRefreshing(false);
        }
      };

      return (
        <div>
          <div className="flex items-center justify-between mb-2">
            <SectionTitle>Configured Tools</SectionTitle>
            <button
              onClick={handleRefreshTools}
              disabled={toolsRefreshing}
              className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium text-accent border border-accent/30 rounded-md hover:bg-accent/10 transition-colors disabled:opacity-50"
            >
              <RotateCcw size={11} className={toolsRefreshing ? "animate-spin" : ""} />
              {toolsRefreshing ? "Refreshing..." : "Refresh from server"}
            </button>
          </div>
          <div className="space-y-2 mb-6">
            {toolsList.map((tool: string, i: number) => (
              <div key={i} className="flex items-center gap-3 px-4 py-3 bg-white-alpha-5 rounded-lg border border-border-default">
                <Zap size={13} className="text-accent flex-shrink-0" />
                <code className="text-sm font-mono text-text-primary flex-1">{tool}</code>
                <button className="text-text-muted hover:text-status-error transition-colors"><Trash2 size={13} /></button>
              </div>
            ))}
            {toolsList.length === 0 && <EmptyTab message="No tools configured" />}
          </div>
          <SectionTitle>Available Tools</SectionTitle>
          <AvailableToolsList agentName={data.name || ""} />
        </div>
      );
    }

    /* ── Sessions ─────────────────────────────────────────── */
    case "sessions": {
      const sessionsQuery = useApiQuery<{ sessions: Array<{ session_id?: string; id?: string; status?: string; turns?: number; started_at?: string; total_tokens?: number; task?: string }> }>(
        `/api/v1/sessions?agent_name=${encodeURIComponent(data.name || "")}&limit=10`,
        Boolean(data.name),
      );
      const sessions = sessionsQuery.data?.sessions ?? [];
      const filteredSessions = sessions.filter((s) => sessionFilter === "all" || s.status === sessionFilter);

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
          {sessionsQuery.loading && <p className="text-xs text-text-muted mb-4">Loading sessions...</p>}
          <div className="space-y-2">
            {filteredSessions.map((s) => (
              <div key={s.session_id || s.id} className="bg-white-alpha-5 rounded-lg border border-border-default p-4">
                <div className="flex items-center gap-2 mb-2">
                  <code className="text-xs font-mono text-accent">{s.session_id || s.id || "—"}</code>
                  <StatusPill status={s.status || "unknown"} />
                  {s.status === "active" && (
                    <button className="ml-auto text-xs text-status-error hover:underline flex items-center gap-1">
                      <Pause size={11} /> Terminate
                    </button>
                  )}
                </div>
                <p className="text-sm text-text-primary mb-1.5">{s.task || "—"}</p>
                <div className="flex items-center gap-4 text-xs text-text-muted">
                  <span className="flex items-center gap-1"><MessageSquare size={11} /> {s.turns ?? 0} turns</span>
                  <span className="flex items-center gap-1"><Zap size={11} /> {s.total_tokens != null ? `${(s.total_tokens / 1000).toFixed(1)}K` : "—"} tokens</span>
                  <span className="flex items-center gap-1"><Clock size={11} /> {s.started_at ? new Date(s.started_at).toLocaleString() : "—"}</span>
                </div>
              </div>
            ))}
          </div>
          {filteredSessions.length === 0 && !sessionsQuery.loading && (
            <EmptyTab message="No sessions yet — run the agent to see data here." />
          )}
        </div>
      );
    }

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
              <MemoryFactsList agentName={data.name || ""} />
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
            <MemoryEpisodesList agentName={data.name || ""} />
          )}

          {memoryTab === "procedures" && (
            <MemoryProceduresList agentName={data.name || ""} />
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

      const handleStreamRun = async () => {
        if (!chatInput.trim() || isStreaming) return;
        const task = chatInput.trim();
        setChatInput("");
        setStreamingOutput("");
        setIsStreaming(true);
        try {
          const token = getToken();
          const response = await fetch(`/api/v1/agents/${encodeURIComponent(data.name || "")}/run/stream`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            body: JSON.stringify({ task }),
          });
          if (!response.ok) {
            setStreamingOutput(`Error: ${response.status} ${response.statusText}`);
            setIsStreaming(false);
            return;
          }
          const reader = response.body?.getReader();
          if (!reader) {
            setStreamingOutput("Error: No readable stream in response");
            setIsStreaming(false);
            return;
          }
          const decoder = new TextDecoder();
          let buffer = "";
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";
            for (const line of lines) {
              if (!line.startsWith("data: ")) continue;
              const jsonStr = line.slice(6).trim();
              if (!jsonStr) continue;
              try {
                const event = JSON.parse(jsonStr) as { type: string; text?: string; output?: string; name?: string; cost_usd?: number };
                if (event.type === "content" && event.text) {
                  setStreamingOutput((prev) => prev + event.text);
                } else if (event.type === "tool_call" && event.name) {
                  setStreamingOutput((prev) => prev + `\n[tool_call: ${event.name}]\n`);
                } else if (event.type === "tool_result" && (event as { output?: string }).output) {
                  setStreamingOutput((prev) => prev + `\n[tool_result]: ${(event as { output: string }).output}\n`);
                } else if (event.type === "complete" && event.output) {
                  setStreamingOutput((prev) => prev + `\n--- Complete (cost: $${event.cost_usd?.toFixed(4) ?? "?"}) ---`);
                }
              } catch {
                // skip malformed JSON lines
              }
            }
            // Auto-scroll streaming output
            if (streamingRef.current) {
              streamingRef.current.scrollTop = streamingRef.current.scrollHeight;
            }
          }
        } catch (err) {
          setStreamingOutput((prev) => prev + `\nError: ${err instanceof Error ? err.message : "Stream failed"}`);
        } finally {
          setIsStreaming(false);
        }
      };

      return (
        <div className="flex flex-col" style={{ height: "calc(92vh - 200px)" }}>
          {/* Chat messages area */}
          <div className="flex-1 overflow-y-auto space-y-3 mb-4">
            {chatMessages.length === 0 && !streamingOutput && (
              <div className="flex flex-col items-center justify-center h-full text-center">
                <MessageSquare size={28} className="text-text-muted mb-2" />
                <p className="text-sm text-text-muted mb-1">Chat with {data.name || "this agent"}</p>
                <p className="text-xs text-text-muted">Send a message to start a conversation, or use Run (Streaming) for streamed task execution</p>
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

          {/* Streaming output area */}
          {(streamingOutput || isStreaming) && (
            <div className="mb-4">
              <div className="flex items-center gap-2 mb-2">
                <Play size={12} className="text-accent" />
                <span className="text-xs font-medium text-text-muted uppercase tracking-wider">Streaming Output</span>
                {isStreaming && <span className="w-2 h-2 rounded-full bg-status-live animate-pulse" />}
              </div>
              <div
                ref={streamingRef}
                className="bg-surface-base rounded-lg border border-border-default p-3 max-h-48 overflow-y-auto font-mono text-xs text-text-primary whitespace-pre-wrap"
              >
                {streamingOutput || "Waiting for stream..."}
              </div>
            </div>
          )}

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
                disabled={!chatInput.trim() || chatLoading || isStreaming}
                className="flex items-center justify-center w-10 h-10 bg-accent text-text-inverse rounded-lg hover:bg-accent/90 transition-colors disabled:opacity-40"
              >
                <Send size={16} />
              </button>
            </div>
            <button
              onClick={handleStreamRun}
              disabled={!chatInput.trim() || isStreaming || chatLoading}
              className="mt-2 w-full py-2.5 text-sm font-medium border border-accent/30 text-accent rounded-lg hover:bg-accent/10 transition-colors disabled:opacity-40 flex items-center justify-center gap-2"
            >
              <Play size={14} />
              {isStreaming ? "Streaming..." : "Run (Streaming)"}
            </button>
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

      const handleFileUpload = async (file: File) => {
        if (!sbId) return;
        setSbLoading(true);
        try {
          const formData = new FormData();
          formData.append("file", file);
          await apiUpload(`/api/v1/sandbox/${sbId}/files/upload`, formData);
          setSbOutput((prev) => [...prev, { cmd: `upload ${file.name}`, stdout: `Uploaded ${file.name} (${file.size} bytes)`, stderr: "", exit_code: 0 }]);
          void listFiles();
        } catch {
          setSbOutput((prev) => [...prev, { cmd: `upload ${file.name}`, stdout: "", stderr: "Upload failed", exit_code: 1 }]);
        } finally { setSbLoading(false); }
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
                  <label className="text-xs text-accent hover:text-accent-hover transition-colors cursor-pointer flex items-center gap-1">
                    <Upload size={10} /> Upload File
                    <input
                      type="file"
                      className="hidden"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) void handleFileUpload(file);
                        e.target.value = "";
                      }}
                    />
                  </label>
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
    case "eval": {
      const evalQuery = useApiQuery<{ runs?: Array<{ id: string; task_file?: string; status?: string; score?: number; tasks?: number; created_at?: string; avg_latency_ms?: number; cost_usd?: number }> }>(
        `/api/v1/eval/runs?agent_name=${encodeURIComponent(data.name || "")}&limit=10`,
        Boolean(data.name),
      );
      const evalRuns = evalQuery.data?.runs ?? [];

      return (
        <div>
          <SectionTitle>Evaluation Runs</SectionTitle>
          {evalQuery.loading && <p className="text-xs text-text-muted mb-4">Loading evaluation runs...</p>}
          <div className="space-y-2 mb-6">
            {evalRuns.map((ev) => (
              <div key={ev.id} className="bg-white-alpha-5 rounded-lg border border-border-default p-4">
                <div className="flex items-center gap-2 mb-2">
                  <code className="text-xs font-mono text-accent">{ev.id}</code>
                  <StatusPill status={ev.status || "unknown"} />
                  <span className="ml-auto text-xs text-text-muted">{ev.created_at ? new Date(ev.created_at).toLocaleString() : "—"}</span>
                </div>
                <p className="text-sm text-text-primary mb-2">{ev.task_file || "—"}</p>
                <div className="grid grid-cols-4 gap-3">
                  {[
                    { label: "Score", value: ev.score != null ? `${ev.score}%` : "—" },
                    { label: "Tasks", value: ev.tasks != null ? `${ev.tasks}` : "—" },
                    { label: "Latency", value: ev.avg_latency_ms != null ? `${(ev.avg_latency_ms / 1000).toFixed(1)}s` : "—" },
                    { label: "Cost", value: ev.cost_usd != null ? `$${ev.cost_usd.toFixed(2)}` : "—" },
                  ].map((m) => (
                    <div key={m.label} className="text-center">
                      <p className="text-[10px] text-text-muted">{m.label}</p>
                      <p className="text-sm font-semibold text-text-primary">{m.value}</p>
                    </div>
                  ))}
                </div>
                {ev.score != null && (
                  <div className="mt-2 h-1.5 bg-white-alpha-8 rounded-full overflow-hidden">
                    <div className={`h-full rounded-full ${ev.score >= 80 ? "bg-status-live" : ev.score >= 60 ? "bg-status-warning" : "bg-status-error"}`}
                      style={{ width: `${ev.score}%` }} />
                  </div>
                )}
              </div>
            ))}
          </div>
          {evalRuns.length === 0 && !evalQuery.loading && (
            <EmptyTab message="No evaluations yet — upload a task file and run an eval." />
          )}

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
    }

    /* ── Releases ─────────────────────────────────────────── */
    case "releases": {
      const relAgentName = data.name || "";
      const channelsQuery = useApiQuery<Array<{ name: string; version: string; traffic: number; status: string }>>(
        `/api/v1/releases/${encodeURIComponent(relAgentName)}/channels`,
        Boolean(relAgentName),
      );
      const versionsQuery = useApiQuery<Array<{ version: string; created_at: string; status: string; changelog?: string }>>(
        `/api/v1/agents/${encodeURIComponent(relAgentName)}/versions`,
        Boolean(relAgentName),
      );

      const channels = channelsQuery.data || [];
      const versions = versionsQuery.data || [];

      const handlePromote = async () => {
        setPromoteLoading(true);
        try {
          await apiRequest(`/api/v1/releases/${encodeURIComponent(relAgentName)}/promote`, "POST", {
            from_channel: promoteFrom,
            to_channel: promoteTo,
            traffic_percent: parseInt(promoteTraffic) || 100,
          });
          channelsQuery.refetch();
        } catch {
          // error handled silently
        } finally {
          setPromoteLoading(false);
        }
      };

      const channelOptions = channels.length > 0
        ? channels.map((ch) => ({ value: ch.name, label: `${ch.name} (${ch.version})` }))
        : [{ value: "staging", label: "staging" }, { value: "canary", label: "canary" }, { value: "production", label: "production" }];

      return (
        <div>
          <SectionTitle>Release Channels</SectionTitle>
          {channelsQuery.loading && <p className="text-xs text-text-muted mb-4">Loading channels...</p>}
          {channelsQuery.error && <p className="text-xs text-status-error mb-4">Failed to load channels: {channelsQuery.error}</p>}
          <div className="space-y-2 mb-6">
            {channels.map((ch) => (
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
            {channels.length === 0 && !channelsQuery.loading && (
              <EmptyTab message="No channels configured." />
            )}
          </div>

          <SectionTitle>Version History</SectionTitle>
          {versionsQuery.loading && <p className="text-xs text-text-muted mb-4">Loading versions...</p>}
          {versionsQuery.error && <p className="text-xs text-text-muted mb-4">No version history available</p>}
          <div className="space-y-2 mb-6">
            {versions.map((v) => (
              <div key={v.version} className="bg-white-alpha-5 rounded-lg border border-border-default p-3 flex items-center gap-3">
                <span className={`w-2 h-2 rounded-full ${v.status === "active" || v.status === "deployed" ? "bg-status-live" : "bg-text-muted"}`} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-text-primary font-mono">{v.version}</p>
                  <p className="text-xs text-text-muted">{v.created_at ? new Date(v.created_at).toLocaleString() : "\u2014"}{v.changelog ? ` \u2014 ${v.changelog}` : ""}</p>
                </div>
                <StatusPill status={v.status} />
              </div>
            ))}
            {versions.length === 0 && !versionsQuery.loading && (
              <p className="text-xs text-text-muted">No versions found</p>
            )}
          </div>

          <SectionTitle>Promote</SectionTitle>
          <div className="bg-white-alpha-5 rounded-lg border border-border-default p-5">
            <InlineSelect label="From" value={promoteFrom} onChange={setPromoteFrom}
              options={channelOptions} />
            <InlineSelect label="To" value={promoteTo} onChange={setPromoteTo}
              options={channelOptions} />
            <InlineInput label="Traffic %" value={promoteTraffic} onChange={setPromoteTraffic} type="number" />
            <button
              onClick={handlePromote}
              disabled={promoteLoading}
              className="w-full py-2.5 text-sm font-medium bg-accent text-text-inverse rounded-lg hover:bg-accent/90 transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
            >
              <Rocket size={14} /> {promoteLoading ? "Promoting..." : "Promote Release"}
            </button>
          </div>
        </div>
      );
    }

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
    case "documents": {
      const docsQuery = useApiQuery<{ documents?: Array<{ name: string; size?: string; chunks?: number }> }>(
        `/api/v1/knowledge/${encodeURIComponent(data.name || "")}/documents`,
        Boolean(data.name),
      );
      const documents = docsQuery.data?.documents ?? [];

      return (
        <div className="max-w-2xl">
          <SectionTitle>Documents</SectionTitle>
          {docsQuery.loading && <p className="text-xs text-text-muted mb-4">Loading documents...</p>}
          <div className="space-y-2 mb-4">
            {documents.map((doc) => (
              <div key={doc.name} className="flex items-center gap-3 px-4 py-3 bg-white-alpha-5 rounded-lg border border-border-default">
                <FileText size={14} className="text-chart-purple flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-mono text-text-primary truncate">{doc.name}</p>
                  <p className="text-xs text-text-muted">{doc.size || "—"} &middot; {doc.chunks ?? 0} chunks</p>
                </div>
                <button className="text-text-muted hover:text-status-error transition-colors"><Trash2 size={13} /></button>
              </div>
            ))}
          </div>
          {documents.length === 0 && !docsQuery.loading && (
            <EmptyTab message="No documents uploaded yet." />
          )}
          <button className="w-full py-2.5 text-sm font-medium border border-dashed border-border-default rounded-lg text-text-muted hover:border-accent/40 hover:text-accent transition-colors flex items-center justify-center gap-2">
            <Upload size={14} /> Upload Document
          </button>
        </div>
      );
    }
    case "chunks": {
      const chunksQuery = useApiQuery<{ chunks?: Array<{ id: string; source?: string; text?: string }> }>(
        `/api/v1/knowledge/${encodeURIComponent(data.name || "")}/chunks?limit=20`,
        Boolean(data.name),
      );
      const chunks = chunksQuery.data?.chunks ?? [];

      return (
        <div className="max-w-2xl">
          <SectionTitle>Chunk Browser</SectionTitle>
          {chunksQuery.loading && <p className="text-xs text-text-muted mb-4">Loading chunks...</p>}
          <div className="space-y-2">
            {chunks.map((chunk) => (
              <div key={chunk.id} className="bg-white-alpha-5 rounded-lg border border-border-default p-4">
                <div className="flex items-center gap-2 mb-2">
                  <code className="text-xs font-mono text-accent">{chunk.id}</code>
                  <span className="text-xs text-text-muted">{chunk.source || "—"}</span>
                </div>
                <p className="text-sm text-text-secondary leading-relaxed">{chunk.text || "—"}</p>
              </div>
            ))}
          </div>
          {chunks.length === 0 && !chunksQuery.loading && (
            <EmptyTab message="No chunks yet — upload documents to generate chunks." />
          )}
        </div>
      );
    }
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
    case "tables": {
      const tablesQuery = useApiQuery<{ tables?: string[] }>(
        `/api/v1/datasources/${encodeURIComponent(data.name || "")}/tables`,
        Boolean(data.name),
      );
      const tables = tablesQuery.data?.tables ?? [];

      return (
        <div className="max-w-2xl">
          <SectionTitle>Tables</SectionTitle>
          {tablesQuery.loading && <p className="text-xs text-text-muted mb-4">Loading tables...</p>}
          <div className="space-y-1.5">
            {tables.map((t) => (
              <div key={t} className="flex items-center gap-3 px-4 py-3 bg-white-alpha-5 rounded-lg border border-border-default">
                <Layers size={13} className="text-chart-cyan flex-shrink-0" />
                <code className="text-sm font-mono text-text-primary">{t}</code>
              </div>
            ))}
          </div>
          {tables.length === 0 && !tablesQuery.loading && (
            <EmptyTab message="No tables found — connect the data source to see tables." />
          )}
        </div>
      );
    }
    case "queries": {
      const queriesQuery = useApiQuery<{ queries?: Array<{ name: string; query: string }> }>(
        `/api/v1/datasources/${encodeURIComponent(data.name || "")}/queries`,
        Boolean(data.name),
      );
      const savedQueries = queriesQuery.data?.queries ?? [];

      return (
        <div className="max-w-2xl">
          <SectionTitle>Saved Queries</SectionTitle>
          {queriesQuery.loading && <p className="text-xs text-text-muted mb-4">Loading queries...</p>}
          <div className="space-y-2">
            {savedQueries.map((q) => (
              <div key={q.name} className="bg-white-alpha-5 rounded-lg border border-border-default p-4">
                <p className="text-sm font-medium text-text-primary mb-2">{q.name}</p>
                <code className="text-xs font-mono text-text-secondary block bg-white-alpha-8 rounded p-2">{q.query}</code>
              </div>
            ))}
          </div>
          {savedQueries.length === 0 && !queriesQuery.loading && (
            <EmptyTab message="No saved queries yet." />
          )}
        </div>
      );
    }
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
            {(data.toolList || []).map((t: string) => (
              <div key={t} className="flex items-center gap-3 px-4 py-3 bg-white-alpha-5 rounded-lg border border-border-default">
                <Zap size={13} className="text-chart-green flex-shrink-0" />
                <code className="text-sm font-mono text-text-primary">{t}</code>
              </div>
            ))}
            {(data.toolList || []).length === 0 && (
              <EmptyTab message="No tools available — authorize the connector to discover tools." />
            )}
          </div>
        </div>
      );
    case "oauth": {
      const oauthQuery = useApiQuery<{ status?: string; scopes?: string; token_expires_at?: string }>(
        `/api/v1/connectors/${encodeURIComponent(data.name || "")}/oauth/status`,
        Boolean(data.name),
      );
      const oauth = oauthQuery.data;

      return (
        <div className="max-w-2xl">
          <SectionTitle>OAuth Configuration</SectionTitle>
          {oauthQuery.loading && <p className="text-xs text-text-muted mb-4">Loading OAuth status...</p>}
          <div className="bg-white-alpha-5 rounded-lg border border-border-default p-5">
            <InfoRow label="Auth Status" value={<StatusPill status={oauth?.status || (data.status === "authed" || data.status === "authenticated" ? "active" : "pending")} />} />
            <InfoRow label="Scopes" value={oauth?.scopes || "—"} />
            <InfoRow label="Token Expires" value={oauth?.token_expires_at ? new Date(oauth.token_expires_at).toLocaleString() : "—"} />
          </div>
          <button className="mt-4 w-full py-2.5 text-sm font-medium border border-dashed border-border-default rounded-lg text-text-muted hover:border-accent/40 hover:text-accent transition-colors">
            Re-authorize OAuth
          </button>
        </div>
      );
    }
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
            {(data.toolList || []).map((t: string) => (
              <div key={t} className="flex items-center gap-3 px-4 py-3 bg-white-alpha-5 rounded-lg border border-border-default">
                <Zap size={13} className="text-chart-blue flex-shrink-0" />
                <code className="text-sm font-mono text-text-primary">{t}</code>
              </div>
            ))}
            {(data.toolList || []).length === 0 && (
              <EmptyTab message="No tools discovered — connect to the MCP server to see tools." />
            )}
          </div>
        </div>
      );
    case "health": {
      const healthQuery = useApiQuery<{
        uptime_percent?: number;
        avg_latency_ms?: number;
        requests_24h?: number;
        errors_24h?: number;
      }>(
        `/api/v1/mcp/${encodeURIComponent(data.name || "")}/health`,
        Boolean(data.name),
      );
      const health = healthQuery.data;

      const healthMetrics = [
        { label: "Uptime", value: health?.uptime_percent != null ? `${health.uptime_percent}%` : "—" },
        { label: "Avg Latency", value: health?.avg_latency_ms != null ? `${health.avg_latency_ms}ms` : "—" },
        { label: "Requests (24h)", value: health?.requests_24h != null ? health.requests_24h.toLocaleString() : "—" },
        { label: "Errors (24h)", value: health?.errors_24h != null ? `${health.errors_24h}` : "—" },
      ];

      return (
        <div className="max-w-2xl">
          <SectionTitle>Health Status</SectionTitle>
          {healthQuery.loading && <p className="text-xs text-text-muted mb-4">Loading health data...</p>}
          {healthQuery.error && !healthQuery.loading && (
            <EmptyTab message="Connect to see health data." />
          )}
          {!healthQuery.loading && !healthQuery.error && (
            <div className="grid grid-cols-2 gap-4 mb-6">
              {healthMetrics.map((m) => (
                <div key={m.label} className="bg-white-alpha-5 rounded-lg border border-border-default p-4">
                  <p className="text-xs text-text-muted">{m.label}</p>
                  <p className="text-xl font-semibold text-text-primary mt-1">{m.value}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      );
    }
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
