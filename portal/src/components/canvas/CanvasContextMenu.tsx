import { useCallback, useEffect, useRef } from "react";
import {
  MessageSquare,
  Play,
  Settings,
  Rocket,
  ArrowUpRight,
  BarChart3,
  Copy,
  Download,
  Trash2,
  Upload,
  Eye,
  Pencil,
  Zap,
  Link2,
  Unplug,
  RefreshCw,
  Bot,
  FileText,
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
  Command,
} from "lucide-react";

type ContextMenuAction = {
  label: string;
  icon: React.ReactNode;
  action: string;
  shortcut?: string;
  variant?: "default" | "danger";
  dividerBefore?: boolean;
};

const agentActions: ContextMenuAction[] = [
  { label: "Edit Config", icon: <Settings size={13} />, action: "edit", shortcut: "E" },
  { label: "Chat", icon: <MessageSquare size={13} />, action: "chat" },
  { label: "Run Task", icon: <Play size={13} />, action: "run" },
  { label: "Deploy", icon: <Rocket size={13} />, action: "deploy", shortcut: "D", dividerBefore: true },
  { label: "Promote", icon: <ArrowUpRight size={13} />, action: "promote" },
  { label: "View Sessions", icon: <BarChart3 size={13} />, action: "sessions", dividerBefore: true },
  { label: "Clone", icon: <Copy size={13} />, action: "clone", shortcut: "C", dividerBefore: true },
  { label: "Export", icon: <Download size={13} />, action: "export" },
  { label: "Delete", icon: <Trash2 size={13} />, action: "delete", variant: "danger", shortcut: "Del", dividerBefore: true },
];

const knowledgeActions: ContextMenuAction[] = [
  { label: "Upload Documents", icon: <Upload size={13} />, action: "upload" },
  { label: "View Chunks", icon: <Eye size={13} />, action: "view-chunks" },
  { label: "Edit Settings", icon: <Pencil size={13} />, action: "edit" },
  { label: "Delete", icon: <Trash2 size={13} />, action: "delete", variant: "danger", dividerBefore: true },
];

const dataSourceActions: ContextMenuAction[] = [
  { label: "Test Connection", icon: <Zap size={13} />, action: "test" },
  { label: "Browse Schema", icon: <Eye size={13} />, action: "browse" },
  { label: "Edit Auth", icon: <Pencil size={13} />, action: "edit" },
  { label: "Delete", icon: <Trash2 size={13} />, action: "delete", variant: "danger", dividerBefore: true },
];

const connectorActions: ContextMenuAction[] = [
  { label: "Authenticate", icon: <Link2 size={13} />, action: "auth" },
  { label: "View Tools", icon: <Eye size={13} />, action: "view-tools" },
  { label: "Test Tool", icon: <Zap size={13} />, action: "test" },
  { label: "Disconnect", icon: <Unplug size={13} />, action: "disconnect", variant: "danger", dividerBefore: true },
];

const mcpServerActions: ContextMenuAction[] = [
  { label: "Sync Tools", icon: <RefreshCw size={13} />, action: "sync" },
  { label: "Check Status", icon: <Zap size={13} />, action: "status" },
  { label: "Edit Config", icon: <Pencil size={13} />, action: "edit" },
  { label: "Delete", icon: <Trash2 size={13} />, action: "delete", variant: "danger", dividerBefore: true },
];

const canvasActions: ContextMenuAction[] = [
  // Add nodes
  { label: "Add Agent", icon: <Bot size={13} />, action: "add-agent", shortcut: "A" },
  { label: "Add Knowledge Base", icon: <FileText size={13} />, action: "add-knowledge", shortcut: "K" },
  { label: "Add Data Source", icon: <Database size={13} />, action: "add-datasource" },
  { label: "Add Connector", icon: <Plug size={13} />, action: "add-connector" },
  { label: "Add MCP Server", icon: <Server size={13} />, action: "add-mcp" },
  // Operations — accessible from canvas background right-click
  { label: "Workflows & Jobs", icon: <Workflow size={13} />, action: "open-workflows", dividerBefore: true },
  { label: "Schedules", icon: <Clock size={13} />, action: "open-schedules" },
  { label: "Webhooks", icon: <Webhook size={13} />, action: "open-webhooks" },
  { label: "Governance", icon: <ShieldCheck size={13} />, action: "open-governance" },
  // Project-level
  { label: "Projects & Envs", icon: <FolderKanban size={13} />, action: "open-projects", dividerBefore: true },
  { label: "Release Channels", icon: <Tag size={13} />, action: "open-releases" },
  { label: "Infrastructure", icon: <Cpu size={13} />, action: "open-infrastructure" },
];

const actionsByType: Record<string, ContextMenuAction[]> = {
  agent: agentActions,
  knowledge: knowledgeActions,
  datasource: dataSourceActions,
  connector: connectorActions,
  mcpServer: mcpServerActions,
  canvas: canvasActions,
};

type Props = {
  x: number;
  y: number;
  nodeType: string;
  nodeId?: string;
  onAction: (action: string, nodeId?: string) => void;
  onClose: () => void;
};

export function CanvasContextMenu({ x, y, nodeType, nodeId, onAction, onClose }: Props) {
  const menuRef = useRef<HTMLDivElement>(null);
  const actions = actionsByType[nodeType] || canvasActions;

  const handleClickOutside = useCallback(
    (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    },
    [onClose],
  );

  useEffect(() => {
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [handleClickOutside]);

  // Adjust position to keep menu in viewport
  const menuHeight = actions.length * 32 + 20;
  const adjustedX = Math.min(x, window.innerWidth - 240);
  const adjustedY = Math.min(y, window.innerHeight - menuHeight);

  return (
    <div
      ref={menuRef}
      className="fixed z-50 min-w-[220px] py-1 rounded-xl border border-border-default bg-surface-raised shadow-[0_8px_40px_rgba(0,0,0,0.5)] backdrop-blur-sm animate-[fadeIn_0.1s_ease-out]"
      style={{ left: adjustedX, top: adjustedY, maxHeight: "80vh", overflowY: "auto" }}
    >
      {/* Header label */}
      {nodeType !== "canvas" ? (
        <div className="px-3 py-1.5 text-[10px] font-semibold text-text-muted uppercase tracking-widest border-b border-border-default mb-1">
          {nodeType === "mcpServer" ? "MCP Server" : nodeType}
        </div>
      ) : (
        <div className="px-3 py-1.5 text-[10px] font-semibold text-text-muted uppercase tracking-widest border-b border-border-default mb-1">
          Canvas
        </div>
      )}

      {actions.map((item, i) => (
        <div key={item.action}>
          {item.dividerBefore && i > 0 && (
            <div className="my-1 mx-2 border-t border-border-default" />
          )}
          <button
            onClick={() => {
              onAction(item.action, nodeId);
              onClose();
            }}
            className={`
              w-full flex items-center gap-2.5 px-3 py-1.5 text-[12px] transition-colors group
              ${item.variant === "danger"
                ? "text-status-error hover:bg-[rgba(239,68,68,0.08)]"
                : "text-text-secondary hover:bg-surface-overlay hover:text-text-primary"
              }
            `}
          >
            <span className="flex-shrink-0 opacity-70 group-hover:opacity-100 transition-opacity">{item.icon}</span>
            <span className="flex-1 text-left">{item.label}</span>
            {item.shortcut && (
              <kbd className="text-[9px] px-1.5 py-0.5 rounded bg-surface-base border border-border-default text-text-muted font-mono">
                {item.shortcut}
              </kbd>
            )}
          </button>
        </div>
      ))}
    </div>
  );
}
