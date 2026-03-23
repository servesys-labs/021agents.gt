import { useState, useCallback, type ReactNode } from "react";
import {
  X,
  Bot,
  Database,
  BookOpen,
  Plug,
  Server,
  Rocket,
  Settings,
  Activity,
  Code,
  ShieldCheck,
  FileText,
  Layers,
  Link2,
  Cpu,
  Zap,
  Globe,
  Key,
  BarChart3,
  Play,
  Trash2,
  Copy,
  MoreVertical,
} from "lucide-react";
import type { Node } from "@xyflow/react";

/* ── Tab definition ─────────────────────────────────────────────── */
type Tab = {
  id: string;
  label: string;
  icon: ReactNode;
};

/* ── Props ──────────────────────────────────────────────────────── */
interface NodeDetailPanelProps {
  node: Node | null;
  onClose: () => void;
  onDelete?: (nodeId: string) => void;
  onClone?: (nodeId: string) => void;
  onDeploy?: (nodeId: string) => void;
  onUpdateNode?: (nodeId: string, data: any) => void;
}

/* ── Tab configs per node type ──────────────────────────────────── */
const tabsByType: Record<string, Tab[]> = {
  agent: [
    { id: "overview", label: "Overview", icon: <Bot size={13} /> },
    { id: "deployments", label: "Deployments", icon: <Rocket size={13} /> },
    { id: "variables", label: "Variables", icon: <Code size={13} /> },
    { id: "tools", label: "Tools", icon: <Zap size={13} /> },
    { id: "metrics", label: "Metrics", icon: <BarChart3 size={13} /> },
    { id: "governance", label: "Governance", icon: <ShieldCheck size={13} /> },
    { id: "settings", label: "Settings", icon: <Settings size={13} /> },
  ],
  knowledge: [
    { id: "overview", label: "Overview", icon: <BookOpen size={13} /> },
    { id: "documents", label: "Documents", icon: <FileText size={13} /> },
    { id: "chunks", label: "Chunks", icon: <Layers size={13} /> },
    { id: "settings", label: "Settings", icon: <Settings size={13} /> },
  ],
  datasource: [
    { id: "overview", label: "Overview", icon: <Database size={13} /> },
    { id: "tables", label: "Tables", icon: <Layers size={13} /> },
    { id: "queries", label: "Queries", icon: <Code size={13} /> },
    { id: "settings", label: "Settings", icon: <Settings size={13} /> },
  ],
  connector: [
    { id: "overview", label: "Overview", icon: <Plug size={13} /> },
    { id: "tools", label: "Tools", icon: <Zap size={13} /> },
    { id: "oauth", label: "OAuth", icon: <Key size={13} /> },
    { id: "settings", label: "Settings", icon: <Settings size={13} /> },
  ],
  mcpServer: [
    { id: "overview", label: "Overview", icon: <Server size={13} /> },
    { id: "tools", label: "Tools", icon: <Zap size={13} /> },
    { id: "health", label: "Health", icon: <Activity size={13} /> },
    { id: "settings", label: "Settings", icon: <Settings size={13} /> },
  ],
};

/* ── Node type icons ────────────────────────────────────────────── */
function getNodeIcon(type: string) {
  switch (type) {
    case "agent": return <Bot size={18} className="text-accent" />;
    case "knowledge": return <BookOpen size={18} className="text-chart-purple" />;
    case "datasource": return <Database size={18} className="text-chart-cyan" />;
    case "connector": return <Plug size={18} className="text-chart-green" />;
    case "mcpServer": return <Server size={18} className="text-chart-blue" />;
    default: return <Cpu size={18} className="text-text-muted" />;
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

/* ── Status colors ──────────────────────────────────────────────── */
function getStatusColor(status: string): string {
  switch (status?.toLowerCase()) {
    case "online":
    case "live":
    case "connected":
    case "authenticated":
    case "authed":
    case "healthy":
    case "ready":
      return "bg-status-live";
    case "draft":
    case "pending":
    case "sleeping":
      return "bg-yellow-500";
    case "offline":
    case "disconnected":
    case "error":
      return "bg-status-error";
    default:
      return "bg-text-muted";
  }
}

/* ═══════════════════════════════════════════════════════════════════
   MAIN COMPONENT
   ═══════════════════════════════════════════════════════════════════ */
export function NodeDetailPanel({
  node,
  onClose,
  onDelete,
  onClone,
  onDeploy,
  onUpdateNode,
}: NodeDetailPanelProps) {
  const [activeTab, setActiveTab] = useState("overview");
  const [actionMenuOpen, setActionMenuOpen] = useState(false);

  const nodeType = node?.type || "agent";
  const tabs = tabsByType[nodeType] || tabsByType.agent;
  const data = node?.data || {};

  // Reset tab when node changes
  const prevNodeId = useState(node?.id)[0];
  if (node?.id !== prevNodeId) {
    // Will be set on next render
  }

  if (!node) return null;

  return (
    <>
      {/* Backdrop — click to close */}
      <div className="fixed inset-0 z-30" onClick={onClose} />

      {/* Panel */}
      <div
        className="fixed top-0 right-0 z-40 h-full w-[520px] max-w-[calc(100vw-80px)] bg-surface-raised border-l border-border-default shadow-2xl flex flex-col animate-slide-in-right"
        style={{
          animation: "slideInRight 0.2s ease-out",
        }}
      >
        {/* ── Header ──────────────────────────────────────────── */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-border-default">
          <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-surface-overlay">
            {getNodeIcon(nodeType)}
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-semibold text-text-primary truncate">
              {(data as any).name || "Untitled"}
            </h2>
            <div className="flex items-center gap-2 mt-0.5">
              <span className={`inline-block w-1.5 h-1.5 rounded-full ${getStatusColor((data as any).status || "")}`} />
              <span className="text-[10px] text-text-muted uppercase tracking-wide">
                {(data as any).status || "unknown"}
              </span>
              <span className="text-[10px] text-text-muted">
                {getNodeTypeLabel(nodeType)}
              </span>
            </div>
          </div>

          {/* Action menu */}
          <div className="relative">
            <button
              onClick={() => setActionMenuOpen(!actionMenuOpen)}
              className="flex items-center justify-center w-7 h-7 rounded-md text-text-muted hover:bg-surface-overlay hover:text-text-primary transition-colors"
            >
              <MoreVertical size={14} />
            </button>
            {actionMenuOpen && (
              <>
                <div className="fixed inset-0 z-50" onClick={() => setActionMenuOpen(false)} />
                <div className="absolute right-0 top-full mt-1 z-50 w-40 bg-surface-overlay border border-border-default rounded-lg shadow-xl overflow-hidden">
                  {nodeType === "agent" && onDeploy && (
                    <button
                      onClick={() => { onDeploy(node.id); setActionMenuOpen(false); }}
                      className="flex items-center gap-2 w-full px-3 py-2 text-xs text-text-secondary hover:bg-surface-hover transition-colors"
                    >
                      <Play size={11} /> Deploy
                    </button>
                  )}
                  {onClone && (
                    <button
                      onClick={() => { onClone(node.id); setActionMenuOpen(false); }}
                      className="flex items-center gap-2 w-full px-3 py-2 text-xs text-text-secondary hover:bg-surface-hover transition-colors"
                    >
                      <Copy size={11} /> Clone
                    </button>
                  )}
                  {onDelete && (
                    <button
                      onClick={() => { onDelete(node.id); setActionMenuOpen(false); }}
                      className="flex items-center gap-2 w-full px-3 py-2 text-xs text-status-error hover:bg-surface-hover transition-colors"
                    >
                      <Trash2 size={11} /> Delete
                    </button>
                  )}
                </div>
              </>
            )}
          </div>

          {/* Close */}
          <button
            onClick={onClose}
            className="flex items-center justify-center w-7 h-7 rounded-md text-text-muted hover:bg-surface-overlay hover:text-text-primary transition-colors"
          >
            <X size={14} />
          </button>
        </div>

        {/* ── Tab bar ─────────────────────────────────────────── */}
        <div className="flex items-center gap-0 px-5 border-b border-border-default overflow-x-auto">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-1.5 px-3 py-2.5 text-[11px] font-medium border-b-2 transition-colors whitespace-nowrap ${
                activeTab === tab.id
                  ? "border-accent text-accent"
                  : "border-transparent text-text-muted hover:text-text-secondary"
              }`}
            >
              {tab.icon}
              {tab.label}
            </button>
          ))}
        </div>

        {/* ── Tab content ─────────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto p-5">
          <TabContent
            nodeType={nodeType}
            tabId={activeTab}
            data={data}
            nodeId={node.id}
            onUpdateNode={onUpdateNode}
          />
        </div>
      </div>

      {/* Slide-in animation */}
      <style>{`
        @keyframes slideInRight {
          from { transform: translateX(100%); opacity: 0; }
          to { transform: translateX(0); opacity: 1; }
        }
      `}</style>
    </>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   TAB CONTENT ROUTER
   ═══════════════════════════════════════════════════════════════════ */
function TabContent({
  nodeType,
  tabId,
  data,
  nodeId,
  onUpdateNode,
}: {
  nodeType: string;
  tabId: string;
  data: any;
  nodeId: string;
  onUpdateNode?: (nodeId: string, data: any) => void;
}) {
  switch (nodeType) {
    case "agent":
      return <AgentTabContent tabId={tabId} data={data} nodeId={nodeId} onUpdateNode={onUpdateNode} />;
    case "knowledge":
      return <KnowledgeTabContent tabId={tabId} data={data} nodeId={nodeId} />;
    case "datasource":
      return <DataSourceTabContent tabId={tabId} data={data} nodeId={nodeId} />;
    case "connector":
      return <ConnectorTabContent tabId={tabId} data={data} nodeId={nodeId} />;
    case "mcpServer":
      return <McpServerTabContent tabId={tabId} data={data} nodeId={nodeId} />;
    default:
      return <EmptyTab message="Unknown node type" />;
  }
}

/* ── Shared components ──────────────────────────────────────────── */

function SectionTitle({ children }: { children: ReactNode }) {
  return <h3 className="text-xs font-semibold text-text-primary mb-3 uppercase tracking-wider">{children}</h3>;
}

function InfoRow({ label, value, mono }: { label: string; value: string | ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between py-2 border-b border-border-default last:border-0">
      <span className="text-[11px] text-text-muted">{label}</span>
      <span className={`text-[11px] text-text-primary text-right max-w-[60%] ${mono ? "font-mono" : ""}`}>
        {value}
      </span>
    </div>
  );
}

function EmptyTab({ message }: { message: string }) {
  return (
    <div className="flex items-center justify-center h-32 text-xs text-text-muted">
      {message}
    </div>
  );
}

function InlineInput({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <div className="mb-3">
      <label className="block text-[10px] font-medium text-text-muted uppercase tracking-wider mb-1">
        {label}
      </label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full px-3 py-2 text-xs bg-surface-base border border-border-default rounded-lg text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent/50 transition-colors"
      />
    </div>
  );
}

function InlineTextarea({
  label,
  value,
  onChange,
  placeholder,
  rows = 4,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
}) {
  return (
    <div className="mb-3">
      <label className="block text-[10px] font-medium text-text-muted uppercase tracking-wider mb-1">
        {label}
      </label>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={rows}
        className="w-full px-3 py-2 text-xs bg-surface-base border border-border-default rounded-lg text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent/50 transition-colors font-mono resize-none"
      />
    </div>
  );
}

function InlineSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div className="mb-3">
      <label className="block text-[10px] font-medium text-text-muted uppercase tracking-wider mb-1">
        {label}
      </label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-3 py-2 text-xs bg-surface-base border border-border-default rounded-lg text-text-primary focus:outline-none focus:border-accent/50 transition-colors"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  );
}

function ToggleRow({ label, description, checked, onChange }: { label: string; description?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-start justify-between py-3 border-b border-border-default last:border-0">
      <div>
        <p className="text-xs text-text-primary">{label}</p>
        {description && <p className="text-[10px] text-text-muted mt-0.5">{description}</p>}
      </div>
      <button
        onClick={() => onChange(!checked)}
        className={`relative w-8 h-4.5 rounded-full transition-colors flex-shrink-0 ${checked ? "bg-accent" : "bg-surface-overlay"}`}
        style={{ minWidth: 32, height: 18 }}
      >
        <span
          className={`absolute top-0.5 left-0.5 w-3.5 h-3.5 rounded-full bg-white transition-transform ${checked ? "translate-x-3.5" : ""}`}
          style={{ width: 14, height: 14 }}
        />
      </button>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   AGENT TAB CONTENT
   ═══════════════════════════════════════════════════════════════════ */
function AgentTabContent({
  tabId,
  data,
  nodeId,
  onUpdateNode,
}: {
  tabId: string;
  data: any;
  nodeId: string;
  onUpdateNode?: (nodeId: string, data: any) => void;
}) {
  const [editName, setEditName] = useState(data.name || "");
  const [editModel, setEditModel] = useState(data.model || "gpt-4.1-mini");
  const [editSystemPrompt, setEditSystemPrompt] = useState(data.systemPrompt || "You are a helpful AI assistant.");
  const [editTemp, setEditTemp] = useState(data.temperature?.toString() || "0.7");
  const [editMaxTokens, setEditMaxTokens] = useState(data.maxTokens?.toString() || "4096");

  // Variables state
  const [vars, setVars] = useState<{ key: string; value: string }[]>(
    data.variables || [
      { key: "OPENAI_API_KEY", value: "sk-***" },
      { key: "LOG_LEVEL", value: "info" },
    ],
  );
  const [newVarKey, setNewVarKey] = useState("");
  const [newVarValue, setNewVarValue] = useState("");

  // Governance
  const [budgetLimit, setBudgetLimit] = useState(data.budgetLimit?.toString() || "50");
  const [requireApproval, setRequireApproval] = useState(data.requireApproval || false);
  const [humanInLoop, setHumanInLoop] = useState(data.humanInLoop || false);

  switch (tabId) {
    case "overview":
      return (
        <div>
          <SectionTitle>Agent Configuration</SectionTitle>
          <div className="bg-surface-base rounded-lg border border-border-default p-4 mb-4">
            <InfoRow label="Name" value={data.name || "—"} />
            <InfoRow label="Model" value={data.model || "—"} mono />
            <InfoRow label="Status" value={
              <span className="flex items-center gap-1.5">
                <span className={`w-1.5 h-1.5 rounded-full ${getStatusColor(data.status)}`} />
                {(data.status || "unknown").toUpperCase()}
              </span>
            } />
            <InfoRow label="Tools" value={`${(data.tools || []).length} configured`} />
            <InfoRow label="Efficiency" value={data.efficiency ? `${data.efficiency}%` : "—"} />
          </div>

          <SectionTitle>Recent Activity</SectionTitle>
          <div className="bg-surface-base rounded-lg border border-border-default p-4">
            <div className="flex items-center gap-2 mb-2">
              <Activity size={12} className="text-text-muted" />
              <span className="text-[10px] text-text-muted uppercase">24h Sparkline</span>
            </div>
            <div className="flex items-end gap-0.5 h-8">
              {(data.activity || [0,0,0,0,0,0,0,0,0,0,0,0]).map((v: number, i: number) => (
                <div
                  key={i}
                  className="flex-1 bg-accent/40 rounded-sm min-h-[2px]"
                  style={{ height: `${Math.max(8, (v / 15) * 100)}%` }}
                />
              ))}
            </div>
          </div>
        </div>
      );

    case "deployments":
      return (
        <div>
          <SectionTitle>Deployment History</SectionTitle>
          <div className="space-y-2">
            {[
              { id: "d1", version: "v1.3.2", status: "active", time: "2 hours ago", env: "production" },
              { id: "d2", version: "v1.3.1", status: "superseded", time: "1 day ago", env: "production" },
              { id: "d3", version: "v1.3.0", status: "superseded", time: "3 days ago", env: "staging" },
            ].map((d) => (
              <div key={d.id} className="bg-surface-base rounded-lg border border-border-default p-3 flex items-center gap-3">
                <span className={`w-2 h-2 rounded-full ${d.status === "active" ? "bg-status-live" : "bg-text-muted"}`} />
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-text-primary font-mono">{d.version}</p>
                  <p className="text-[10px] text-text-muted">{d.env} &middot; {d.time}</p>
                </div>
                <span className={`text-[10px] px-2 py-0.5 rounded-full ${d.status === "active" ? "bg-status-live/10 text-status-live" : "bg-surface-overlay text-text-muted"}`}>
                  {d.status}
                </span>
              </div>
            ))}
          </div>
        </div>
      );

    case "variables":
      return (
        <div>
          <SectionTitle>Environment Variables</SectionTitle>
          <div className="bg-surface-base rounded-lg border border-border-default overflow-hidden mb-3">
            {vars.map((v, i) => (
              <div key={i} className="flex items-center gap-2 px-3 py-2 border-b border-border-default last:border-0">
                <code className="text-[11px] text-accent font-mono flex-shrink-0">{v.key}</code>
                <span className="text-[10px] text-text-muted">=</span>
                <code className="text-[11px] text-text-secondary font-mono truncate flex-1">{v.value}</code>
                <button
                  onClick={() => setVars(vars.filter((_, idx) => idx !== i))}
                  className="text-text-muted hover:text-status-error transition-colors flex-shrink-0"
                >
                  <Trash2 size={10} />
                </button>
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              value={newVarKey}
              onChange={(e) => setNewVarKey(e.target.value)}
              placeholder="KEY"
              className="flex-1 px-2 py-1.5 text-[11px] font-mono bg-surface-base border border-border-default rounded-md text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent/50"
            />
            <input
              value={newVarValue}
              onChange={(e) => setNewVarValue(e.target.value)}
              placeholder="value"
              className="flex-1 px-2 py-1.5 text-[11px] font-mono bg-surface-base border border-border-default rounded-md text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent/50"
            />
            <button
              onClick={() => {
                if (newVarKey.trim()) {
                  setVars([...vars, { key: newVarKey.trim(), value: newVarValue }]);
                  setNewVarKey("");
                  setNewVarValue("");
                }
              }}
              className="px-3 py-1.5 text-[10px] font-medium bg-accent text-white rounded-md hover:bg-accent/90 transition-colors"
            >
              Add
            </button>
          </div>
        </div>
      );

    case "tools":
      return (
        <div>
          <SectionTitle>Configured Tools</SectionTitle>
          <div className="space-y-1.5 mb-4">
            {(data.tools || []).map((tool: string, i: number) => (
              <div key={i} className="flex items-center gap-2 px-3 py-2 bg-surface-base rounded-lg border border-border-default">
                <Zap size={11} className="text-accent flex-shrink-0" />
                <code className="text-[11px] font-mono text-text-primary">{tool}</code>
              </div>
            ))}
            {(!data.tools || data.tools.length === 0) && (
              <EmptyTab message="No tools configured" />
            )}
          </div>

          <SectionTitle>Available Tools</SectionTitle>
          <div className="space-y-1 max-h-48 overflow-y-auto">
            {["web_search", "sandbox_exec", "file_read", "file_write", "send_email", "http_request", "create_chart", "query_database"].map((tool) => (
              <div key={tool} className="flex items-center gap-2 px-3 py-1.5 bg-surface-base rounded-md border border-border-default">
                <Zap size={10} className="text-text-muted flex-shrink-0" />
                <code className="text-[10px] font-mono text-text-secondary flex-1">{tool}</code>
                <button className="text-[9px] text-accent hover:underline">+ Add</button>
              </div>
            ))}
          </div>
        </div>
      );

    case "metrics":
      return (
        <div>
          <SectionTitle>Performance Metrics</SectionTitle>
          <div className="grid grid-cols-2 gap-3 mb-4">
            {[
              { label: "Avg Latency", value: "1.2s", trend: "-5%" },
              { label: "Success Rate", value: "98.7%", trend: "+0.3%" },
              { label: "Token Usage", value: "12.4K/day", trend: "+12%" },
              { label: "Cost (24h)", value: "$2.41", trend: "-8%" },
            ].map((m) => (
              <div key={m.label} className="bg-surface-base rounded-lg border border-border-default p-3">
                <p className="text-[10px] text-text-muted">{m.label}</p>
                <p className="text-lg font-semibold text-text-primary mt-0.5">{m.value}</p>
                <p className={`text-[10px] mt-0.5 ${m.trend.startsWith("-") ? "text-status-live" : "text-yellow-500"}`}>
                  {m.trend}
                </p>
              </div>
            ))}
          </div>
        </div>
      );

    case "governance":
      return (
        <div>
          <SectionTitle>Governance Rules</SectionTitle>
          <div className="bg-surface-base rounded-lg border border-border-default p-4 space-y-0">
            <ToggleRow
              label="Require approval for deployment"
              description="All deployments must be approved by a team admin"
              checked={requireApproval}
              onChange={setRequireApproval}
            />
            <ToggleRow
              label="Human-in-the-loop"
              description="Agent must get human confirmation for sensitive actions"
              checked={humanInLoop}
              onChange={setHumanInLoop}
            />
          </div>

          <div className="mt-4">
            <SectionTitle>Budget Limits</SectionTitle>
            <InlineInput
              label="Monthly budget ($)"
              value={budgetLimit}
              onChange={setBudgetLimit}
              type="number"
              placeholder="50"
            />
          </div>
        </div>
      );

    case "settings":
      return (
        <div>
          <SectionTitle>Agent Settings</SectionTitle>
          <InlineInput label="Name" value={editName} onChange={setEditName} placeholder="Agent name" />
          <InlineSelect
            label="Model"
            value={editModel}
            onChange={setEditModel}
            options={[
              { value: "gpt-4.1-mini", label: "gpt-4.1-mini" },
              { value: "gpt-4.1-nano", label: "gpt-4.1-nano" },
              { value: "gpt-4o", label: "gpt-4o" },
              { value: "gemini-2.5-flash", label: "gemini-2.5-flash" },
              { value: "claude-sonnet-4", label: "claude-sonnet-4" },
            ]}
          />
          <InlineTextarea
            label="System Prompt"
            value={editSystemPrompt}
            onChange={setEditSystemPrompt}
            placeholder="You are a helpful AI assistant..."
            rows={6}
          />
          <InlineInput label="Temperature" value={editTemp} onChange={setEditTemp} type="number" placeholder="0.7" />
          <InlineInput label="Max Tokens" value={editMaxTokens} onChange={setEditMaxTokens} type="number" placeholder="4096" />

          <button
            onClick={() => {
              onUpdateNode?.(nodeId, {
                ...data,
                name: editName,
                model: editModel,
                systemPrompt: editSystemPrompt,
                temperature: parseFloat(editTemp),
                maxTokens: parseInt(editMaxTokens),
              });
            }}
            className="mt-4 w-full py-2 text-xs font-medium bg-accent text-white rounded-lg hover:bg-accent/90 transition-colors"
          >
            Save Changes
          </button>

          <div className="mt-6 pt-4 border-t border-border-default">
            <SectionTitle>Danger Zone</SectionTitle>
            <p className="text-[10px] text-text-muted mb-2">Permanently delete this agent and all associated data.</p>
            <button className="px-4 py-1.5 text-[10px] font-medium text-status-error border border-status-error/30 rounded-md hover:bg-status-error/10 transition-colors">
              Delete Agent
            </button>
          </div>
        </div>
      );

    default:
      return <EmptyTab message={`Tab "${tabId}" not implemented`} />;
  }
}

/* ═══════════════════════════════════════════════════════════════════
   KNOWLEDGE TAB CONTENT
   ═══════════════════════════════════════════════════════════════════ */
function KnowledgeTabContent({ tabId, data, nodeId }: { tabId: string; data: any; nodeId: string }) {
  switch (tabId) {
    case "overview":
      return (
        <div>
          <SectionTitle>Knowledge Base</SectionTitle>
          <div className="bg-surface-base rounded-lg border border-border-default p-4">
            <InfoRow label="Name" value={data.name || "—"} />
            <InfoRow label="Documents" value={`${data.docCount || 0}`} />
            <InfoRow label="Total Size" value={data.totalSize || "—"} />
            <InfoRow label="Chunks" value={`${data.chunkCount || 0}`} />
            <InfoRow label="Status" value={
              <span className="flex items-center gap-1.5">
                <span className={`w-1.5 h-1.5 rounded-full ${getStatusColor(data.status)}`} />
                {(data.status || "unknown").toUpperCase()}
              </span>
            } />
          </div>
        </div>
      );

    case "documents":
      return (
        <div>
          <SectionTitle>Documents</SectionTitle>
          <div className="space-y-1.5 mb-4">
            {[
              { name: "getting-started.md", size: "24 KB", chunks: 12 },
              { name: "api-reference.md", size: "156 KB", chunks: 89 },
              { name: "faq.md", size: "8 KB", chunks: 6 },
              { name: "troubleshooting.pdf", size: "2.1 MB", chunks: 142 },
            ].map((doc) => (
              <div key={doc.name} className="flex items-center gap-2 px-3 py-2 bg-surface-base rounded-lg border border-border-default">
                <FileText size={12} className="text-text-muted flex-shrink-0" />
                <span className="text-[11px] text-text-primary flex-1 truncate font-mono">{doc.name}</span>
                <span className="text-[10px] text-text-muted">{doc.size}</span>
                <span className="text-[10px] text-text-muted">{doc.chunks} chunks</span>
              </div>
            ))}
          </div>
          <button className="w-full py-2 text-xs font-medium border border-dashed border-border-default rounded-lg text-text-muted hover:border-accent/40 hover:text-accent transition-colors">
            + Upload Document
          </button>
        </div>
      );

    case "chunks":
      return (
        <div>
          <SectionTitle>Chunk Browser</SectionTitle>
          <div className="space-y-2">
            {[1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="bg-surface-base rounded-lg border border-border-default p-3">
                <div className="flex items-center gap-2 mb-1.5">
                  <span className="text-[9px] font-mono text-accent bg-accent/10 px-1.5 py-0.5 rounded">chunk-{i}</span>
                  <span className="text-[9px] text-text-muted">score: 0.{90 + i}</span>
                </div>
                <p className="text-[10px] text-text-secondary leading-relaxed line-clamp-3">
                  Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua...
                </p>
              </div>
            ))}
          </div>
        </div>
      );

    case "settings":
      return (
        <div>
          <SectionTitle>Knowledge Base Settings</SectionTitle>
          <InlineInput label="Name" value={data.name || ""} onChange={() => {}} placeholder="Knowledge base name" />
          <InlineSelect
            label="Embedding Model"
            value="text-embedding-3-small"
            onChange={() => {}}
            options={[
              { value: "text-embedding-3-small", label: "text-embedding-3-small" },
              { value: "text-embedding-3-large", label: "text-embedding-3-large" },
            ]}
          />
          <InlineInput label="Chunk Size" value="512" onChange={() => {}} type="number" />
          <InlineInput label="Chunk Overlap" value="50" onChange={() => {}} type="number" />
        </div>
      );

    default:
      return <EmptyTab message={`Tab "${tabId}" not implemented`} />;
  }
}

/* ═══════════════════════════════════════════════════════════════════
   DATASOURCE TAB CONTENT
   ═══════════════════════════════════════════════════════════════════ */
function DataSourceTabContent({ tabId, data, nodeId }: { tabId: string; data: any; nodeId: string }) {
  switch (tabId) {
    case "overview":
      return (
        <div>
          <SectionTitle>Data Source</SectionTitle>
          <div className="bg-surface-base rounded-lg border border-border-default p-4">
            <InfoRow label="Name" value={data.name || "—"} />
            <InfoRow label="Type" value={(data.type || "postgres").toUpperCase()} mono />
            <InfoRow label="Status" value={
              <span className="flex items-center gap-1.5">
                <span className={`w-1.5 h-1.5 rounded-full ${getStatusColor(data.status)}`} />
                {(data.status || "unknown").toUpperCase()}
              </span>
            } />
            <InfoRow label="Tables" value={`${data.tableCount || 0}`} />
          </div>
        </div>
      );

    case "tables":
      return (
        <div>
          <SectionTitle>Tables</SectionTitle>
          <div className="space-y-1.5">
            {["users", "orders", "products", "analytics_events", "sessions"].map((t) => (
              <div key={t} className="flex items-center gap-2 px-3 py-2 bg-surface-base rounded-lg border border-border-default">
                <Layers size={11} className="text-chart-cyan flex-shrink-0" />
                <code className="text-[11px] font-mono text-text-primary">{t}</code>
                <span className="text-[10px] text-text-muted ml-auto">{Math.floor(Math.random() * 10000)} rows</span>
              </div>
            ))}
          </div>
        </div>
      );

    case "queries":
      return (
        <div>
          <SectionTitle>Query Console</SectionTitle>
          <InlineTextarea
            label="SQL Query"
            value="SELECT * FROM users LIMIT 10;"
            onChange={() => {}}
            rows={4}
          />
          <button className="w-full py-2 text-xs font-medium bg-chart-cyan/20 text-chart-cyan rounded-lg hover:bg-chart-cyan/30 transition-colors">
            Run Query
          </button>
        </div>
      );

    case "settings":
      return (
        <div>
          <SectionTitle>Connection Settings</SectionTitle>
          <InlineInput label="Host" value="db.internal.co" onChange={() => {}} />
          <InlineInput label="Port" value="5432" onChange={() => {}} type="number" />
          <InlineInput label="Database" value="analytics" onChange={() => {}} />
          <InlineInput label="Username" value="readonly_user" onChange={() => {}} />
          <InlineInput label="Password" value="••••••••" onChange={() => {}} type="password" />
          <button className="mt-2 w-full py-2 text-xs font-medium bg-accent text-white rounded-lg hover:bg-accent/90 transition-colors">
            Test Connection
          </button>
        </div>
      );

    default:
      return <EmptyTab message={`Tab "${tabId}" not implemented`} />;
  }
}

/* ═══════════════════════════════════════════════════════════════════
   CONNECTOR TAB CONTENT
   ═══════════════════════════════════════════════════════════════════ */
function ConnectorTabContent({ tabId, data, nodeId }: { tabId: string; data: any; nodeId: string }) {
  switch (tabId) {
    case "overview":
      return (
        <div>
          <SectionTitle>Connector</SectionTitle>
          <div className="bg-surface-base rounded-lg border border-border-default p-4">
            <InfoRow label="Name" value={data.name || "—"} />
            <InfoRow label="App" value={data.app || "—"} />
            <InfoRow label="Status" value={
              <span className="flex items-center gap-1.5">
                <span className={`w-1.5 h-1.5 rounded-full ${getStatusColor(data.status)}`} />
                {(data.status || "unknown").toUpperCase()}
              </span>
            } />
            <InfoRow label="Tools" value={`${data.toolCount || 0} available`} />
          </div>
        </div>
      );

    case "tools":
      return (
        <div>
          <SectionTitle>Available Tools</SectionTitle>
          <div className="space-y-1.5">
            {["send_message", "list_channels", "create_channel", "upload_file", "search_messages"].slice(0, data.toolCount || 3).map((t) => (
              <div key={t} className="flex items-center gap-2 px-3 py-2 bg-surface-base rounded-lg border border-border-default">
                <Zap size={11} className="text-chart-green flex-shrink-0" />
                <code className="text-[11px] font-mono text-text-primary">{t}</code>
              </div>
            ))}
          </div>
        </div>
      );

    case "oauth":
      return (
        <div>
          <SectionTitle>OAuth Configuration</SectionTitle>
          <div className="bg-surface-base rounded-lg border border-border-default p-4 mb-4">
            <InfoRow label="OAuth Status" value={
              <span className="flex items-center gap-1.5">
                <span className={`w-1.5 h-1.5 rounded-full ${getStatusColor(data.status)}`} />
                {(data.status || "pending").toUpperCase()}
              </span>
            } />
            <InfoRow label="Scopes" value="read, write, admin" />
            <InfoRow label="Token Expires" value="30 days" />
          </div>
          {data.status !== "authenticated" && data.status !== "authed" && (
            <button className="w-full py-2 text-xs font-medium bg-chart-green/20 text-chart-green rounded-lg hover:bg-chart-green/30 transition-colors">
              Connect OAuth
            </button>
          )}
        </div>
      );

    case "settings":
      return (
        <div>
          <SectionTitle>Connector Settings</SectionTitle>
          <InlineInput label="Name" value={data.name || ""} onChange={() => {}} />
          <InlineInput label="Client ID" value="xoxb-***" onChange={() => {}} />
          <InlineInput label="Client Secret" value="••••••••" onChange={() => {}} type="password" />
          <InlineInput label="Redirect URI" value="https://oneshots.co/oauth/callback" onChange={() => {}} />
        </div>
      );

    default:
      return <EmptyTab message={`Tab "${tabId}" not implemented`} />;
  }
}

/* ═══════════════════════════════════════════════════════════════════
   MCP SERVER TAB CONTENT
   ═══════════════════════════════════════════════════════════════════ */
function McpServerTabContent({ tabId, data, nodeId }: { tabId: string; data: any; nodeId: string }) {
  switch (tabId) {
    case "overview":
      return (
        <div>
          <SectionTitle>MCP Server</SectionTitle>
          <div className="bg-surface-base rounded-lg border border-border-default p-4">
            <InfoRow label="Name" value={data.name || "—"} />
            <InfoRow label="URL" value={data.url || "—"} mono />
            <InfoRow label="Status" value={
              <span className="flex items-center gap-1.5">
                <span className={`w-1.5 h-1.5 rounded-full ${getStatusColor(data.status)}`} />
                {(data.status || "unknown").toUpperCase()}
              </span>
            } />
            <InfoRow label="Tools" value={`${data.toolCount || 0} synced`} />
          </div>
        </div>
      );

    case "tools":
      return (
        <div>
          <SectionTitle>Synced Tools</SectionTitle>
          <div className="space-y-1.5">
            {["get_customer", "update_customer", "search_contacts", "create_deal", "list_deals", "get_pipeline", "create_task", "update_task"].slice(0, data.toolCount || 4).map((t) => (
              <div key={t} className="flex items-center gap-2 px-3 py-2 bg-surface-base rounded-lg border border-border-default">
                <Zap size={11} className="text-chart-blue flex-shrink-0" />
                <code className="text-[11px] font-mono text-text-primary">{t}</code>
              </div>
            ))}
          </div>
          <button className="mt-3 w-full py-2 text-xs font-medium border border-dashed border-border-default rounded-lg text-text-muted hover:border-chart-blue/40 hover:text-chart-blue transition-colors">
            Sync Tools
          </button>
        </div>
      );

    case "health":
      return (
        <div>
          <SectionTitle>Health Check</SectionTitle>
          <div className="grid grid-cols-2 gap-3 mb-4">
            {[
              { label: "Uptime", value: "99.9%" },
              { label: "Avg Response", value: "45ms" },
              { label: "Last Check", value: "2m ago" },
              { label: "Errors (24h)", value: "0" },
            ].map((m) => (
              <div key={m.label} className="bg-surface-base rounded-lg border border-border-default p-3">
                <p className="text-[10px] text-text-muted">{m.label}</p>
                <p className="text-sm font-semibold text-text-primary mt-0.5">{m.value}</p>
              </div>
            ))}
          </div>
        </div>
      );

    case "settings":
      return (
        <div>
          <SectionTitle>Server Settings</SectionTitle>
          <InlineInput label="Name" value={data.name || ""} onChange={() => {}} />
          <InlineInput label="Server URL" value={data.url || ""} onChange={() => {}} />
          <InlineInput label="API Key" value="••••••••" onChange={() => {}} type="password" />
          <InlineSelect
            label="Transport"
            value="sse"
            onChange={() => {}}
            options={[
              { value: "sse", label: "SSE (Server-Sent Events)" },
              { value: "stdio", label: "stdio" },
              { value: "websocket", label: "WebSocket" },
            ]}
          />
          <button className="mt-2 w-full py-2 text-xs font-medium bg-accent text-white rounded-lg hover:bg-accent/90 transition-colors">
            Save & Reconnect
          </button>
        </div>
      );

    default:
      return <EmptyTab message={`Tab "${tabId}" not implemented`} />;
  }
}
