import { useCallback, useMemo, useState, useRef, useEffect } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  addEdge,
  useNodesState,
  useEdgesState,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeMouseHandler,
  BackgroundVariant,
  MarkerType,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { AgentNode } from "../../components/canvas/nodes/AgentNode";
import { KnowledgeNode } from "../../components/canvas/nodes/KnowledgeNode";
import { DataSourceNode } from "../../components/canvas/nodes/DataSourceNode";
import { ConnectorNode } from "../../components/canvas/nodes/ConnectorNode";
import { McpServerNode } from "../../components/canvas/nodes/McpServerNode";
import { CanvasContextMenu } from "../../components/canvas/CanvasContextMenu";
import { MetaAgentAssist } from "../../components/canvas/MetaAgentAssist";
import { AgentLog, type LogEntry } from "../../components/canvas/AgentLog";
import { AddNodeToolbar } from "../../components/canvas/AddNodeToolbar";
import { NodeDetailPanel } from "../../components/canvas/NodeDetailPanel";
import { CommandPalette, type CommandAction } from "../../components/canvas/CommandPalette";
import { CanvasOverlayPanel } from "../../components/canvas/CanvasOverlayPanel";
import {
  WorkflowsPanel,
  SchedulesPanel,
  WebhooksPanel,
  GovernancePanel,
  ProjectsPanel,
  ReleasesPanel,
  InfrastructurePanel,
} from "../../components/canvas/OverlayPanels";
import { apiRequest } from "../../lib/api";
import {
  RotateCcw,
  ChevronDown,
  Globe,
  GitBranch,
  Bell,
  Sparkles,
  Plus,
  Command,
  Search,
  MessageSquare,
} from "lucide-react";
import { useNavigate } from "react-router-dom";

/* ── Node type registry ──────────────────────────────────────── */
const nodeTypes = {
  agent: AgentNode,
  knowledge: KnowledgeNode,
  datasource: DataSourceNode,
  connector: ConnectorNode,
  mcpServer: McpServerNode,
};

/* ── Layout persistence ──────────────────────────────────────── */
const LAYOUT_KEY = "oneshots-canvas-layout";

function loadLayout(): { nodes: Node[]; edges: Edge[] } | null {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.nodes?.length || parsed.nodes.length < 2 || !parsed?.edges?.length) {
      localStorage.removeItem(LAYOUT_KEY);
      return null;
    }
    return parsed;
  } catch {
    localStorage.removeItem(LAYOUT_KEY);
    return null;
  }
}

function saveLayout(nodes: Node[], edges: Edge[]) {
  try {
    localStorage.setItem(
      LAYOUT_KEY,
      JSON.stringify({
        nodes: nodes.map((n) => ({ ...n, selected: false })),
        edges,
      }),
    );
  } catch {}
}

/* ── Edge helpers ────────────────────────────────────────────── */
function getEdgeColor(sourceType?: string, targetType?: string): string {
  if (sourceType === "knowledge" || targetType === "knowledge") return "var(--color-chart-purple)";
  if (sourceType === "datasource" || targetType === "datasource") return "var(--color-chart-cyan)";
  if (sourceType === "connector" || targetType === "connector") return "var(--color-chart-green)";
  if (sourceType === "mcpServer" || targetType === "mcpServer") return "var(--color-chart-blue)";
  return "var(--color-accent)";
}

function makeEdge(id: string, source: string, target: string, color: string): Edge {
  return {
    id,
    source,
    target,
    animated: true,
    style: { stroke: color, strokeDasharray: "6 3", strokeWidth: 1.5 },
    markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14 },
  };
}

/* ── Demo data ───────────────────────────────────────────────── */
const demoNodes: Node[] = [
  {
    id: "agent-1",
    type: "agent",
    position: { x: 480, y: 180 },
    data: {
      name: "Support Bot",
      model: "gpt-4.1-mini",
      status: "online",
      tools: ["slack_send_message", "search_docs", "create_ticket"],
      efficiency: 89,
      activity: [4, 7, 3, 9, 12, 8, 6, 11, 5, 8, 10, 7],
    },
  },
  {
    id: "agent-2",
    type: "agent",
    position: { x: 480, y: 420 },
    data: {
      name: "Data Analyst",
      model: "gpt-4o",
      status: "draft",
      tools: ["query_database", "create_chart"],
      efficiency: undefined,
      activity: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    },
  },
  {
    id: "knowledge-1",
    type: "knowledge",
    position: { x: 80, y: 120 },
    data: {
      name: "Product Docs",
      docCount: 24,
      totalSize: "2.4 MB",
      status: "ready",
      chunkCount: 342,
    },
  },
  {
    id: "knowledge-2",
    type: "knowledge",
    position: { x: 80, y: 320 },
    data: {
      name: "FAQ Database",
      docCount: 156,
      totalSize: "890 KB",
      status: "ready",
      chunkCount: 1204,
    },
  },
  {
    id: "datasource-1",
    type: "datasource",
    position: { x: 100, y: 500 },
    data: {
      name: "Analytics DB",
      type: "postgres",
      status: "connected",
      tableCount: 47,
    },
  },
  {
    id: "connector-1",
    type: "connector",
    position: { x: 860, y: 140 },
    data: {
      name: "Slack",
      app: "Slack Workspace",
      status: "authenticated",
      toolCount: 5,
    },
  },
  {
    id: "connector-2",
    type: "connector",
    position: { x: 860, y: 320 },
    data: {
      name: "GitHub",
      app: "GitHub Org",
      status: "pending",
      toolCount: 0,
    },
  },
  {
    id: "mcp-1",
    type: "mcpServer",
    position: { x: 860, y: 490 },
    data: {
      name: "Internal CRM",
      url: "https://crm.internal/mcp",
      status: "healthy",
      toolCount: 8,
    },
  },
];

const demoEdges: Edge[] = [
  makeEdge("e-k1-a1", "knowledge-1", "agent-1", "var(--color-chart-purple)"),
  makeEdge("e-k2-a1", "knowledge-2", "agent-1", "var(--color-chart-purple)"),
  makeEdge("e-ds1-a2", "datasource-1", "agent-2", "var(--color-chart-cyan)"),
  makeEdge("e-a1-c1", "agent-1", "connector-1", "var(--color-chart-green)"),
  makeEdge("e-a2-mcp1", "agent-2", "mcp-1", "var(--color-chart-blue)"),
];

/* ═══════════════════════════════════════════════════════════════
   CANVAS WORKSPACE — Railway-style
   ═══════════════════════════════════════════════════════════════ */
/* ── Outer wrapper provides ReactFlow context ─────────────── */
export function CanvasWorkspacePage() {
  return (
    <ReactFlowProvider>
      <CanvasWorkspaceInner />
    </ReactFlowProvider>
  );
}

/* ── Inner component with access to useReactFlow ──────────── */
function CanvasWorkspaceInner() {
  const navigate = useNavigate();
  const { setCenter, getZoom } = useReactFlow();
  const saved = loadLayout();
  const [nodes, setNodes, onNodesChange] = useNodesState(saved?.nodes || demoNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(saved?.edges || demoEdges);

  // Context menu
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    nodeType: string;
    nodeId?: string;
  } | null>(null);

  // Node detail panel (Railway-style)
  const [detailNode, setDetailNode] = useState<Node | null>(null);

  // Command palette
  const [cmdPaletteOpen, setCmdPaletteOpen] = useState(false);

  // Overlay panels
  const [overlayPanel, setOverlayPanel] = useState<string | null>(null);

  // Meta-agent
  const [metaProcessing, setMetaProcessing] = useState(false);
  const [metaResult, setMetaResult] = useState<string | undefined>();
  const [agentRailOpen, setAgentRailOpen] = useState(false);

  // Agent log
  const [logEntries, setLogEntries] = useState<LogEntry[]>([
    { id: "init", message: "Canvas workspace initialized", status: "done", timestamp: Date.now() },
  ]);

  // Top bar dropdowns
  const [projectDropdown, setProjectDropdown] = useState(false);
  const [envDropdown, setEnvDropdown] = useState(false);
  const [currentProject, setCurrentProject] = useState("my-agents");
  const [currentEnv, setCurrentEnv] = useState("production");

  const reactFlowRef = useRef<HTMLDivElement>(null);

  /* ── Log helper ──────────────────────────────────────────── */
  const addLogEntry = useCallback((message: string, status: LogEntry["status"]) => {
    setLogEntries((prev) => [
      ...prev,
      { id: Date.now().toString(), message, status, timestamp: Date.now() },
    ]);
  }, []);

  const clearLog = useCallback(() => setLogEntries([]), []);

  /* ── Edge connection ─────────────────────────────────────── */
  const onConnect = useCallback(
    (connection: Connection) => {
      const sourceNode = nodes.find((n) => n.id === connection.source);
      const targetNode = nodes.find((n) => n.id === connection.target);
      const color = getEdgeColor(sourceNode?.type, targetNode?.type);

      const newEdge = {
        ...connection,
        animated: true,
        style: { stroke: color, strokeDasharray: "6 3", strokeWidth: 1.5 },
        markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14 },
      };

      setEdges((eds) => addEdge(newEdge, eds));
      addLogEntry(
        `Connected ${sourceNode?.data?.name || "node"} → ${targetNode?.data?.name || "node"}`,
        "done",
      );
    },
    [nodes, setEdges, addLogEntry],
  );

  /* ── Context menu ────────────────────────────────────────── */
  const onNodeContextMenu: NodeMouseHandler = useCallback((event, node) => {
    event.preventDefault();
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      nodeType: node.type || "agent",
      nodeId: node.id,
    });
  }, []);

  const onPaneContextMenu = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      nodeType: "canvas",
    });
  }, []);

  const onPaneClick = useCallback(() => {
    setContextMenu(null);
  }, []);

  /* ── Node click → open detail panel + center node in remaining canvas ── */
  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      setDetailNode(node);
      setContextMenu(null);

      // Auto-center the clicked node in the LEFT half of the viewport
      // The detail panel takes ~50% of the viewport from the right,
      // so we need to shift the center point leftward in flow-coordinates.
      // setCenter(x,y) puts (x,y) at the center of the ReactFlow container.
      // After the panel opens, the RF container shrinks to ~50% width.
      // We want the node centered within that remaining 50% container,
      // so we just center on the node — React Flow handles the rest
      // because the container itself shrinks.
      const nodeWidth = node.measured?.width ?? 220;
      const nodeHeight = node.measured?.height ?? 140;
      const x = node.position.x + nodeWidth / 2;
      const y = node.position.y + nodeHeight / 2;
      const zoom = getZoom();

      // Delay to let the panel render and the RF container resize,
      // then center the node in the now-smaller container
      setTimeout(() => {
        setCenter(x, y, { zoom: Math.max(zoom, 0.65), duration: 500 });
      }, 120);
    },
    [setCenter, getZoom],
  );

  /* ── Add node ────────────────────────────────────────────── */
  const addNode = useCallback(
    (type: string) => {
      const id = `${type}-${Date.now()}`;
      const centerX = 350 + Math.random() * 300;
      const centerY = 200 + Math.random() * 200;

      const defaults: Record<string, any> = {
        agent: {
          name: "New Agent",
          model: "gpt-4.1-mini",
          status: "draft",
          tools: [],
          activity: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        },
        knowledge: {
          name: "New Knowledge Base",
          docCount: 0,
          totalSize: "0 MB",
          status: "empty",
          chunkCount: 0,
        },
        datasource: {
          name: "New Database",
          type: "postgres",
          status: "disconnected",
          tableCount: 0,
        },
        connector: {
          name: "New Connector",
          app: "—",
          status: "pending",
          toolCount: 0,
        },
        mcpServer: {
          name: "New MCP Server",
          url: "https://...",
          status: "offline",
          toolCount: 0,
        },
      };

      const newNode: Node = {
        id,
        type,
        position: { x: centerX, y: centerY },
        data: defaults[type] || {},
      };

      setNodes((nds) => [...nds, newNode]);
      addLogEntry(`Added ${type} node`, "done");
      setDetailNode(newNode);
    },
    [setNodes, addLogEntry],
  );

  /* ── Command palette action handler ─────────────────────── */
  const handleCommandAction = useCallback(
    (action: CommandAction) => {
      // Add to canvas actions
      if (action === "add-agent") { addNode("agent"); return; }
      if (action === "add-knowledge") { addNode("knowledge"); return; }
      if (action === "add-datasource") { addNode("datasource"); return; }
      if (action === "add-connector") { addNode("connector"); return; }
      if (action === "add-mcp") { addNode("mcpServer"); return; }

      // Overlay panel actions
      if (action === "open-workflows") { setOverlayPanel("workflows"); return; }
      if (action === "open-schedules") { setOverlayPanel("schedules"); return; }
      if (action === "open-webhooks") { setOverlayPanel("webhooks"); return; }
      if (action === "open-governance") { setOverlayPanel("governance"); return; }
      if (action === "open-projects") { setOverlayPanel("projects"); return; }
      if (action === "open-releases") { setOverlayPanel("releases"); return; }
      if (action === "open-infrastructure") { setOverlayPanel("infrastructure"); return; }

      // Navigation actions
      if (action === "open-overview") { navigate("/overview"); return; }
      if (action === "open-observability") { navigate("/observability"); return; }
      if (action === "open-metrics") { navigate("/metrics"); return; }
      if (action === "open-settings") { navigate("/settings"); return; }
      if (action === "open-billing") { navigate("/billing"); return; }
    },
    [addNode, navigate],
  );

  /* ── Context menu actions ────────────────────────────────── */
  const handleContextAction = useCallback(
    (action: string, nodeId?: string) => {
      switch (action) {
        case "edit": {
          const node = nodes.find((n) => n.id === nodeId);
          if (node) setDetailNode(node);
          break;
        }
        case "chat": {
          addLogEntry("Opening agent chat...", "running");
          const node = nodes.find((n) => n.id === nodeId);
          if (node) setDetailNode(node);
          break;
        }
        case "deploy": {
          if (nodeId) handleDeploy(nodeId);
          break;
        }
        case "delete": {
          const node = nodes.find((n) => n.id === nodeId);
          setNodes((nds) => nds.filter((n) => n.id !== nodeId));
          setEdges((eds) => eds.filter((e) => e.source !== nodeId && e.target !== nodeId));
          if (detailNode?.id === nodeId) setDetailNode(null);
          addLogEntry(`Deleted ${node?.data?.name || "node"}`, "done");
          break;
        }
        case "clone": {
          const node = nodes.find((n) => n.id === nodeId);
          if (node) {
            const newId = `${node.type}-${Date.now()}`;
            const newNode: Node = {
              ...node,
              id: newId,
              position: { x: node.position.x + 40, y: node.position.y + 40 },
              data: { ...node.data, name: `${node.data.name} (copy)` },
            };
            setNodes((nds) => [...nds, newNode]);
            addLogEntry(`Cloned ${node.data.name}`, "done");
          }
          break;
        }
        // Canvas-level context menu actions
        case "add-agent": addNode("agent"); break;
        case "add-knowledge": addNode("knowledge"); break;
        case "add-datasource": addNode("datasource"); break;
        case "add-connector": addNode("connector"); break;
        case "add-mcp": addNode("mcpServer"); break;
        // Overlay panels from context menu
        case "open-workflows": setOverlayPanel("workflows"); break;
        case "open-schedules": setOverlayPanel("schedules"); break;
        case "open-webhooks": setOverlayPanel("webhooks"); break;
        case "open-governance": setOverlayPanel("governance"); break;
        case "open-projects": setOverlayPanel("projects"); break;
        case "open-releases": setOverlayPanel("releases"); break;
        case "open-infrastructure": setOverlayPanel("infrastructure"); break;
        default:
          addLogEntry(`Action: ${action}`, "done");
      }
    },
    [nodes, setNodes, setEdges, addNode, addLogEntry, detailNode],
  );

  /* ── Deploy ──────────────────────────────────────────────── */
  const handleDeploy = useCallback(
    async (nodeId: string) => {
      const node = nodes.find((n) => n.id === nodeId);
      if (!node || node.type !== "agent") return;

      addLogEntry(`Deploying ${node.data.name}...`, "running");
      try {
        await apiRequest(`/api/v1/deploy/${node.data.name}`, "POST");
        setNodes((nds) =>
          nds.map((n) =>
            n.id === nodeId ? { ...n, data: { ...n.data, status: "online" } } : n,
          ),
        );
        addLogEntry(`Deployed ${node.data.name} successfully`, "done");
      } catch (err) {
        addLogEntry(`Deploy failed: ${err instanceof Error ? err.message : "Unknown error"}`, "error");
      }
    },
    [nodes, setNodes, addLogEntry],
  );

  /* ── Update node data from detail panel ──────────────────── */
  const handleUpdateNode = useCallback(
    (nodeId: string, data: any) => {
      setNodes((nds) =>
        nds.map((n) => (n.id === nodeId ? { ...n, data } : n)),
      );
      addLogEntry(`Updated ${data.name || "node"}`, "done");
    },
    [setNodes, addLogEntry],
  );

  /* ── Delete node from detail panel ───────────────────────── */
  const handleDeleteNode = useCallback(
    (nodeId: string) => {
      const node = nodes.find((n) => n.id === nodeId);
      setNodes((nds) => nds.filter((n) => n.id !== nodeId));
      setEdges((eds) => eds.filter((e) => e.source !== nodeId && e.target !== nodeId));
      setDetailNode(null);
      addLogEntry(`Deleted ${node?.data?.name || "node"}`, "done");
    },
    [nodes, setNodes, setEdges, addLogEntry],
  );

  /* ── Clone node from detail panel ────────────────────────── */
  const handleCloneNode = useCallback(
    (nodeId: string) => {
      const node = nodes.find((n) => n.id === nodeId);
      if (node) {
        const newId = `${node.type}-${Date.now()}`;
        const newNode: Node = {
          ...node,
          id: newId,
          position: { x: node.position.x + 40, y: node.position.y + 40 },
          data: { ...node.data, name: `${node.data.name} (copy)` },
        };
        setNodes((nds) => [...nds, newNode]);
        addLogEntry(`Cloned ${node.data.name}`, "done");
      }
    },
    [nodes, setNodes, addLogEntry],
  );

  /* ── Meta-agent ──────────────────────────────────────────── */
  const handleMetaSubmit = useCallback(
    async (prompt: string) => {
      setMetaProcessing(true);
      setMetaResult(undefined);
      addLogEntry(`Meta-Agent: "${prompt.slice(0, 60)}${prompt.length > 60 ? "..." : ""}"`, "running");

      try {
        const result = await apiRequest<{ config: any; message: string }>(
          "/api/v1/agents/create-from-description",
          "POST",
          { description: prompt },
        );

        const msg = result.message || "Agent configuration generated.";
        setMetaResult(msg);
        addLogEntry("Meta-Agent completed", "done");

        if (result.config) {
          const id = `agent-${Date.now()}`;
          const newNode: Node = {
            id,
            type: "agent",
            position: { x: 400 + Math.random() * 100, y: 250 + Math.random() * 100 },
            data: {
              name: result.config.name || "Generated Agent",
              model: result.config.model || "gpt-4.1-mini",
              status: "draft",
              tools: result.config.tools || [],
              activity: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
            },
          };
          setNodes((nds) => [...nds, newNode]);
          setDetailNode(newNode);
        }
      } catch (err) {
        const errMsg = `Error: ${err instanceof Error ? err.message : "Failed to create agent"}`;
        setMetaResult(errMsg);
        addLogEntry("Meta-Agent failed", "error");
      } finally {
        setMetaProcessing(false);
      }
    },
    [setNodes, addLogEntry],
  );

  /* ── Save layout on drag stop ────────────────────────────── */
  const onNodeDragStop = useCallback(
    (_: React.MouseEvent, __: Node, allNodes: Node[]) => {
      saveLayout(allNodes, edges);
    },
    [edges],
  );

  /* ── Keyboard shortcuts ──────────────────────────────────── */
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't capture when typing in inputs
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement
      ) return;

      // Cmd+K / Ctrl+K → Command palette
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setCmdPaletteOpen((prev) => !prev);
        return;
      }

      // Escape → close everything
      if (e.key === "Escape") {
        if (cmdPaletteOpen) { setCmdPaletteOpen(false); return; }
        if (overlayPanel) { setOverlayPanel(null); return; }
        if (detailNode) { setDetailNode(null); return; }
        setContextMenu(null);
        return;
      }

      // Delete/Backspace → delete selected node
      if (e.key === "Delete" || e.key === "Backspace") {
        if (detailNode && !overlayPanel && !cmdPaletteOpen) {
          handleDeleteNode(detailNode.id);
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [detailNode, handleDeleteNode, cmdPaletteOpen, overlayPanel]);

  /* ── Default edge options ────────────────────────────────── */
  const defaultEdgeOptions = useMemo(
    () => ({
      animated: true,
      style: { stroke: "var(--color-accent)", strokeDasharray: "6 3", strokeWidth: 1.5 },
      markerEnd: { type: MarkerType.ArrowClosed, color: "var(--color-accent)", width: 14, height: 14 },
    }),
    [],
  );

  /* ═══════════════════════════════════════════════════════════
     RENDER
     ═══════════════════════════════════════════════════════════ */
  return (
    <div className="relative w-full h-full flex flex-col" ref={reactFlowRef}>
      {/* ── Railway-style top bar ───────────────────────────── */}
      <div className="relative z-20 flex items-center gap-0 h-11 px-4 bg-surface-raised border-b border-border-default flex-shrink-0">
        {/* Project selector */}
        <div className="relative">
          <button
            onClick={() => { setProjectDropdown(!projectDropdown); setEnvDropdown(false); }}
            className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-text-primary hover:bg-surface-overlay rounded-md transition-colors"
          >
            <div className="w-4 h-4 rounded bg-accent/20 flex items-center justify-center">
              <span className="text-[8px] font-bold text-accent">O</span>
            </div>
            {currentProject}
            <ChevronDown size={11} className="text-text-muted" />
          </button>
          {projectDropdown && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setProjectDropdown(false)} />
              <div className="absolute left-0 top-full mt-1 z-50 w-52 bg-surface-overlay border border-border-default rounded-lg shadow-xl overflow-hidden">
                <div className="px-3 py-2 border-b border-border-default">
                  <p className="text-[10px] text-text-muted uppercase tracking-wider font-medium">Projects</p>
                </div>
                {["my-agents", "production-bots", "experimental"].map((p) => (
                  <button
                    key={p}
                    onClick={() => { setCurrentProject(p); setProjectDropdown(false); }}
                    className={`flex items-center gap-2 w-full px-3 py-2 text-xs transition-colors ${
                      p === currentProject
                        ? "text-accent bg-accent/5"
                        : "text-text-secondary hover:bg-surface-hover"
                    }`}
                  >
                    <div className="w-3 h-3 rounded bg-accent/20 flex items-center justify-center">
                      <span className="text-[6px] font-bold text-accent">O</span>
                    </div>
                    {p}
                    {p === currentProject && (
                      <span className="ml-auto text-[9px] text-accent">&#10003;</span>
                    )}
                  </button>
                ))}
                <div className="border-t border-border-default">
                  <button
                    onClick={() => { setProjectDropdown(false); setOverlayPanel("projects"); }}
                    className="flex items-center gap-2 w-full px-3 py-2 text-xs text-text-muted hover:bg-surface-hover transition-colors"
                  >
                    <Plus size={10} /> New Project
                  </button>
                </div>
              </div>
            </>
          )}
        </div>

        <span className="text-text-muted text-xs mx-1">/</span>

        {/* Environment selector */}
        <div className="relative">
          <button
            onClick={() => { setEnvDropdown(!envDropdown); setProjectDropdown(false); }}
            className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-text-primary hover:bg-surface-overlay rounded-md transition-colors"
          >
            <Globe size={11} className="text-status-live" />
            {currentEnv}
            <ChevronDown size={11} className="text-text-muted" />
          </button>
          {envDropdown && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setEnvDropdown(false)} />
              <div className="absolute left-0 top-full mt-1 z-50 w-48 bg-surface-overlay border border-border-default rounded-lg shadow-xl overflow-hidden">
                <div className="px-3 py-2 border-b border-border-default">
                  <p className="text-[10px] text-text-muted uppercase tracking-wider font-medium">Environments</p>
                </div>
                {[
                  { name: "production", icon: <Globe size={10} className="text-status-live" /> },
                  { name: "staging", icon: <GitBranch size={10} className="text-yellow-500" /> },
                  { name: "development", icon: <GitBranch size={10} className="text-chart-blue" /> },
                ].map((env) => (
                  <button
                    key={env.name}
                    onClick={() => { setCurrentEnv(env.name); setEnvDropdown(false); }}
                    className={`flex items-center gap-2 w-full px-3 py-2 text-xs transition-colors ${
                      env.name === currentEnv
                        ? "text-accent bg-accent/5"
                        : "text-text-secondary hover:bg-surface-hover"
                    }`}
                  >
                    {env.icon}
                    {env.name}
                    {env.name === currentEnv && (
                      <span className="ml-auto text-[9px] text-accent">&#10003;</span>
                    )}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Command palette trigger */}
        <button
          onClick={() => setCmdPaletteOpen(true)}
          className="flex items-center gap-2 px-3 py-1.5 text-[11px] text-text-muted bg-surface-base border border-border-default rounded-lg hover:border-accent/30 hover:text-text-secondary transition-colors mr-2"
        >
          <Search size={11} />
          <span>Search or command...</span>
          <kbd className="text-[9px] px-1 py-0.5 rounded bg-surface-overlay border border-border-default font-mono ml-2">
            {navigator.platform?.includes("Mac") ? "\u2318" : "Ctrl"}K
          </kbd>
        </button>

        {/* Reset */}
        <button
          onClick={() => {
            localStorage.removeItem(LAYOUT_KEY);
            setNodes(demoNodes);
            setEdges(demoEdges);
            setDetailNode(null);
            addLogEntry("Canvas reset to default layout", "done");
          }}
          className="flex items-center gap-1 px-2 py-1 text-[10px] text-text-muted hover:text-text-primary hover:bg-surface-overlay rounded-md transition-colors mr-1"
          title="Reset canvas"
        >
          <RotateCcw size={10} />
          Reset
        </button>

        <button
          onClick={() => setAgentRailOpen(!agentRailOpen)}
          className={`flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium rounded-md transition-colors mr-1 ${
            agentRailOpen
              ? "bg-accent/15 text-accent border border-accent/30"
              : "text-text-muted hover:text-text-primary hover:bg-surface-overlay border border-transparent"
          }`}
        >
          <MessageSquare size={12} />
          Agent
        </button>

        <button className="flex items-center justify-center w-7 h-7 text-text-muted hover:text-text-primary hover:bg-surface-overlay rounded-md transition-colors mr-1">
          <Bell size={13} />
        </button>

        <div className="w-6 h-6 rounded-full bg-accent/20 flex items-center justify-center ml-1">
          <span className="text-[9px] font-bold text-accent">U</span>
        </div>
      </div>

      {/* ── Canvas area ─────────────────────────────────────── */}
      <div className="flex-1 flex overflow-hidden">
        {/* React Flow canvas — shrinks when detail panel opens */}
        <div className="flex-1 relative" style={{ transition: 'width 0.3s ease' }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeContextMenu={onNodeContextMenu}
          onPaneContextMenu={onPaneContextMenu}
          onPaneClick={onPaneClick}
          onNodeClick={onNodeClick}
          onNodeDragStop={onNodeDragStop}
          nodeTypes={nodeTypes}
          defaultEdgeOptions={defaultEdgeOptions}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          proOptions={{ hideAttribution: true }}
          className="!bg-surface-base"
          minZoom={0.2}
          maxZoom={2}
          snapToGrid
          snapGrid={[20, 20]}
        >
          <Background
            variant={BackgroundVariant.Dots}
            gap={20}
            size={1}
            color="var(--color-border-default)"
          />
          <Controls
            position="top-left"
            style={{ left: "16px", top: "16px" }}
            showInteractive={false}
          />

        </ReactFlow>

        {/* ── Canvas overlays ────────────────────────────────── */}
        <AddNodeToolbar onAdd={addNode} />

        <AgentLog entries={logEntries} onClear={clearLog} />

        {/* Context menu */}
        {contextMenu && (
          <CanvasContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            nodeType={contextMenu.nodeType}
            nodeId={contextMenu.nodeId}
            onAction={handleContextAction}
            onClose={() => setContextMenu(null)}
          />
        )}
        </div>

        {/* Railway-style Node Detail Panel — inline, pushes canvas left */}
        {detailNode && (
          <NodeDetailPanel
            node={detailNode}
            onClose={() => setDetailNode(null)}
            onDelete={handleDeleteNode}
            onClone={handleCloneNode}
            onDeploy={handleDeploy}
            onUpdateNode={handleUpdateNode}
          />
        )}

        {/* Railway-style Agent rail — inline right panel */}
        {agentRailOpen && (
          <MetaAgentAssist
            onSubmit={handleMetaSubmit}
            isProcessing={metaProcessing}
            lastResult={metaResult}
          />
        )}
      </div>

      {/* ── Command Palette (Cmd+K) ──────────────────────────── */}
      <CommandPalette
        open={cmdPaletteOpen}
        onClose={() => setCmdPaletteOpen(false)}
        onAction={handleCommandAction}
      />

      {/* ── Overlay Panels ───────────────────────────────────── */}
      <WorkflowsPanel open={overlayPanel === "workflows"} onClose={() => setOverlayPanel(null)} />
      <SchedulesPanel open={overlayPanel === "schedules"} onClose={() => setOverlayPanel(null)} />
      <WebhooksPanel open={overlayPanel === "webhooks"} onClose={() => setOverlayPanel(null)} />
      <GovernancePanel open={overlayPanel === "governance"} onClose={() => setOverlayPanel(null)} />
      <ProjectsPanel open={overlayPanel === "projects"} onClose={() => setOverlayPanel(null)} />
      <ReleasesPanel open={overlayPanel === "releases"} onClose={() => setOverlayPanel(null)} />
      <InfrastructurePanel open={overlayPanel === "infrastructure"} onClose={() => setOverlayPanel(null)} />
    </div>
  );
}
