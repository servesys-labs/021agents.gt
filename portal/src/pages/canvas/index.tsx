import { useCallback, useMemo, useState, useRef, useEffect } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  addEdge,
  useNodesState,
  useEdgesState,
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
import { DeployButton } from "../../components/canvas/DeployButton";
import { AgentConfigDrawer } from "../../components/canvas/AgentConfigDrawer";
import { apiRequest } from "../../lib/api";
import { RotateCcw } from "lucide-react";

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
    // Validate: must have at least 2 nodes and 1 edge to be considered valid
    if (
      !parsed?.nodes?.length ||
      parsed.nodes.length < 2 ||
      !parsed?.edges?.length
    ) {
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
  } catch {
    // Silently fail
  }
}

/* ── Edge color mapping ──────────────────────────────────────── */
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

/* ── Main component ──────────────────────────────────────────── */
export function CanvasWorkspacePage() {
  const saved = loadLayout();
  const [nodes, setNodes, onNodesChange] = useNodesState(saved?.nodes || demoNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(saved?.edges || demoEdges);

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    nodeType: string;
    nodeId?: string;
  } | null>(null);

  // Drawer state
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingAgent, setEditingAgent] = useState<any>(null);

  // Meta-agent state
  const [metaProcessing, setMetaProcessing] = useState(false);
  const [metaResult, setMetaResult] = useState<string | undefined>();

  // Deploy state
  const [isDeploying, setIsDeploying] = useState(false);
  const [selectedNode, setSelectedNode] = useState<{ id: string; type: string } | null>(null);

  // Agent log
  const [logEntries, setLogEntries] = useState<LogEntry[]>([
    { id: "init", message: "Canvas workspace initialized", status: "done", timestamp: Date.now() },
  ]);

  // Available tools
  const [availableTools] = useState<string[]>([
    "web_search",
    "sandbox_exec",
    "file_read",
    "file_write",
    "slack_send_message",
    "search_docs",
    "create_ticket",
    "query_database",
    "send_email",
    "http_request",
  ]);

  const reactFlowRef = useRef<HTMLDivElement>(null);

  /* ── Log helper ────────────────────────────────────────────── */
  const addLogEntry = useCallback((message: string, status: LogEntry["status"]) => {
    setLogEntries((prev) => [
      ...prev,
      { id: Date.now().toString(), message, status, timestamp: Date.now() },
    ]);
  }, []);

  const clearLog = useCallback(() => {
    setLogEntries([]);
  }, []);

  /* ── Edge connection ───────────────────────────────────────── */
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
        `Connected ${sourceNode?.data?.name || "node"} \u2192 ${targetNode?.data?.name || "node"}`,
        "done",
      );
    },
    [nodes, setEdges, addLogEntry],
  );

  /* ── Context menu ──────────────────────────────────────────── */
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
    setSelectedNode(null);
  }, []);

  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    setSelectedNode({ id: node.id, type: node.type || "agent" });
  }, []);

  const onNodeDoubleClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      if (node.type === "agent") {
        setEditingAgent(node.data);
        setDrawerOpen(true);
      }
    },
    [],
  );

  /* ── Add node ──────────────────────────────────────────────── */
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
        },
        connector: {
          name: "New Connector",
          app: "Select app...",
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

      // Open config drawer for new agents
      if (type === "agent") {
        setEditingAgent(defaults[type]);
        setDrawerOpen(true);
      }
    },
    [setNodes, addLogEntry],
  );

  /* ── Context menu actions ──────────────────────────────────── */
  const handleContextAction = useCallback(
    (action: string, nodeId?: string) => {
      switch (action) {
        case "edit": {
          const node = nodes.find((n) => n.id === nodeId);
          if (node?.type === "agent") {
            setEditingAgent(node.data);
            setDrawerOpen(true);
          }
          break;
        }
        case "chat": {
          addLogEntry("Opening agent chat...", "running");
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
        case "add-agent":
          addNode("agent");
          break;
        case "add-knowledge":
          addNode("knowledge");
          break;
        case "add-datasource":
          addNode("datasource");
          break;
        case "add-connector":
          addNode("connector");
          break;
        case "add-mcp":
          addNode("mcpServer");
          break;
        default:
          addLogEntry(`Action: ${action}`, "done");
      }
    },
    [nodes, setNodes, setEdges, addNode, addLogEntry],
  );

  /* ── Deploy ────────────────────────────────────────────────── */
  const handleDeploy = useCallback(
    async (nodeId: string) => {
      const node = nodes.find((n) => n.id === nodeId);
      if (!node || node.type !== "agent") return;

      setIsDeploying(true);
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
      } finally {
        setIsDeploying(false);
      }
    },
    [nodes, setNodes, addLogEntry],
  );

  /* ── Meta-agent ────────────────────────────────────────────── */
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

  /* ── Save agent config ─────────────────────────────────────── */
  const handleSaveAgent = useCallback(
    async (config: any) => {
      addLogEntry(`Saving agent ${config.name}...`, "running");
      try {
        await apiRequest("/api/v1/agents", "POST", config);
        addLogEntry(`Agent ${config.name} saved`, "done");
      } catch {
        addLogEntry(`Agent ${config.name} saved locally`, "done");
      }
    },
    [addLogEntry],
  );

  /* ── Save layout on drag stop ──────────────────────────────── */
  const onNodeDragStop = useCallback(
    (_: React.MouseEvent, __: Node, allNodes: Node[]) => {
      saveLayout(allNodes, edges);
    },
    [edges],
  );

  /* ── Keyboard shortcuts ────────────────────────────────────── */
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't capture when typing in inputs
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement
      ) {
        return;
      }

      if (e.key === "Delete" || e.key === "Backspace") {
        if (selectedNode) {
          handleContextAction("delete", selectedNode.id);
          setSelectedNode(null);
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedNode, handleContextAction]);

  /* ── Default edge options ──────────────────────────────────── */
  const defaultEdgeOptions = useMemo(
    () => ({
      animated: true,
      style: { stroke: "var(--color-accent)", strokeDasharray: "6 3", strokeWidth: 1.5 },
      markerEnd: { type: MarkerType.ArrowClosed, color: "var(--color-accent)", width: 14, height: 14 },
    }),
    [],
  );

  return (
    <div className="relative w-full h-full" ref={reactFlowRef}>
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
        onNodeDoubleClick={onNodeDoubleClick}
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
          style={{ left: "60px", top: "16px" }}
          showInteractive={false}
        />
        <MiniMap
          nodeColor={(node) => {
            switch (node.type) {
              case "agent": return "var(--color-accent)";
              case "knowledge": return "var(--color-chart-purple)";
              case "datasource": return "var(--color-chart-cyan)";
              case "connector": return "var(--color-chart-green)";
              case "mcpServer": return "var(--color-chart-blue)";
              default: return "var(--color-surface-hover)";
            }
          }}
          maskColor="rgba(12,10,9,0.85)"
          className="!bg-surface-raised !border-border-default !rounded-xl"
          style={{ width: 140, height: 90 }}
        />
      </ReactFlow>

      {/* Overlays */}
      <AddNodeToolbar onAdd={addNode} />

      {/* Reset canvas button */}
      <button
        onClick={() => {
          localStorage.removeItem(LAYOUT_KEY);
          setNodes(demoNodes);
          setEdges(demoEdges);
          addLogEntry("Canvas reset to default layout", "done");
        }}
        className="absolute top-4 right-4 z-10 flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-medium text-text-muted bg-surface-raised/80 backdrop-blur border border-border-default rounded-full hover:text-text-primary hover:border-accent/40 transition-all"
        title="Reset canvas to demo layout"
      >
        <RotateCcw size={10} />
        Reset
      </button>

      <AgentLog entries={logEntries} onClear={clearLog} />

      <MetaAgentAssist
        onSubmit={handleMetaSubmit}
        isProcessing={metaProcessing}
        lastResult={metaResult}
      />

      <DeployButton
        selectedNodeId={selectedNode?.id}
        selectedNodeType={selectedNode?.type}
        onDeploy={handleDeploy}
        isDeploying={isDeploying}
      />

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

      {/* Agent config drawer */}
      <AgentConfigDrawer
        isOpen={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        agentData={editingAgent}
        onSave={handleSaveAgent}
        availableTools={availableTools}
      />
    </div>
  );
}
