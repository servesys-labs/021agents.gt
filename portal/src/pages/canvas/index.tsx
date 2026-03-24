import { useCallback, useMemo, useState, useRef, useEffect } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  useNodesState,
  useEdgesState,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeMouseHandler,
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
import { CanvasControls } from "../../components/canvas/CanvasControls";
import { CanvasGlow } from "../../components/canvas/CanvasGlow"; // mouse glow effect
import { AlignmentGuides } from "../../components/canvas/AlignmentGuides";
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
  SecretsPanel,
} from "../../components/canvas/OverlayPanels";
import { apiRequest } from "../../lib/api";
import { useUndoRedo } from "../../hooks/useUndoRedo";
import { getStoredUserRole } from "../../auth/tokens";
import {
  RotateCcw,
  ChevronDown,
  Globe,
  GitBranch,
  Bell,
  Sparkles,
  Plus,
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

/* ── Static ReactFlow options (defined outside component to avoid re-renders) ── */
const FIT_VIEW_OPTIONS = { padding: 0.2 };
const PRO_OPTIONS = { hideAttribution: true };
const SNAP_GRID: [number, number] = [20, 20];

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

type MetaResource = { type: "connector" | "datasource" | "knowledge" | "mcpServer"; name: string };
type MetaDraft = {
  agentNodeId: string;
  clusterNodeIds: string[];
  prompt: string;
  agentName: string;
  model: string;
  tools: string[];
  resources: Array<{ type: string; name: string }>;
  createdAt: number;
};

type ProjectSummary = {
  project_id: string;
  name: string;
  slug: string;
};

type CanvasLayoutResponse = {
  nodes?: Node[];
  edges?: Edge[];
  assignments?: Array<Record<string, unknown>>;
};

function inferResourcesFromPromptAndTools(prompt: string, tools: string[]): MetaResource[] {
  const normalized = `${prompt} ${(tools || []).join(" ")}`.toLowerCase();
  const resources: MetaResource[] = [];
  const pushUnique = (res: MetaResource) => {
    if (!resources.find((r) => r.type === res.type && r.name === res.name)) resources.push(res);
  };

  if (/\bslack\b/.test(normalized)) pushUnique({ type: "connector", name: "Slack" });
  if (/\bgithub\b/.test(normalized)) pushUnique({ type: "connector", name: "GitHub" });
  if (/\bnotion\b/.test(normalized)) pushUnique({ type: "connector", name: "Notion" });
  if (/\bteams\b|\bmicrosoft teams\b/.test(normalized)) pushUnique({ type: "connector", name: "Microsoft Teams" });
  if (/\bpostgres\b|\bmysql\b|\bsnowflake\b|\bdatabase\b|\bsql\b/.test(normalized)) {
    pushUnique({ type: "datasource", name: "Primary Database" });
  }
  if (/\bknowledge\b|\brag\b|\bdocs?\b|\bpdf\b/.test(normalized)) {
    pushUnique({ type: "knowledge", name: "Knowledge Base" });
  }
  if (/\bmcp\b|\binternal api\b|\btool server\b/.test(normalized)) {
    pushUnique({ type: "mcpServer", name: "Internal MCP Server" });
  }
  return resources;
}

/* ── Demo data removed — canvas starts empty ─────────────────── */

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
  const { setCenter, getZoom, fitView } = useReactFlow();
  // Start empty — project-scoped layout loads via API effect below.
  // localStorage is only an offline/instant-render fallback.
  const localFallback = loadLayout();
  const [nodes, setNodes, onNodesChange] = useNodesState(localFallback?.nodes || []);
  const [edges, setEdges, onEdgesChange] = useEdgesState(localFallback?.edges || []);
  const [canvasReady, setCanvasReady] = useState(false);

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
  const [metaDraft, setMetaDraft] = useState<MetaDraft | null>(null);

  // Agent log
  const [logEntries, setLogEntries] = useState<LogEntry[]>([
    { id: "init", message: "Canvas workspace initialized", status: "done", timestamp: Date.now() },
  ]);

  // Top bar dropdowns
  const [projectDropdown, setProjectDropdown] = useState(false);
  const [envDropdown, setEnvDropdown] = useState(false);
  const [currentProject, setCurrentProject] = useState("my-agents");
  const [currentEnv, setCurrentEnv] = useState("production");
  const [projectOptions, setProjectOptions] = useState<ProjectSummary[]>([]);
  const [activeProjectId, setActiveProjectId] = useState("");
  const userRole = getStoredUserRole();
  const roleCanEdit = useMemo(
    () => ["admin", "owner", "editor", "developer", "member"].includes(userRole),
    [userRole],
  );
  const [editMode, setEditMode] = useState(roleCanEdit);

  const reactFlowRef = useRef<HTMLDivElement>(null);
  const skipLayoutPersistRef = useRef(false);
  const deployPollRef = useRef<Record<string, ReturnType<typeof setInterval>>>({});

  // Grid visibility
  const [showGrid, setShowGrid] = useState(true);
  const [agentsOnly, setAgentsOnly] = useState(false);

  // Layer toggles
  const [hiddenLayers, setHiddenLayers] = useState<Set<string>>(new Set());
  const handleToggleLayer = useCallback((layer: string) => {
    setHiddenLayers((prev) => {
      const next = new Set(prev);
      if (next.has(layer)) {
        next.delete(layer);
      } else {
        next.add(layer);
      }
      return next;
    });
  }, []);

  // Undo/redo for node positions
  const { takeSnapshot, undo, redo, canUndo, canRedo } = useUndoRedo();

  /* ── Derived display nodes/edges using `hidden` property (best practice) ── */
  const displayNodes = useMemo(
    () => {
      let result = nodes;
      if (agentsOnly) {
        result = result.map((n) =>
          n.type === 'agent'
            ? { ...n, hidden: false, data: { ...n.data, hideHandles: true } }
            : { ...n, hidden: true }
        );
      } else {
        result = result.map((n) =>
          n.data?.hideHandles ? { ...n, data: { ...n.data, hideHandles: false } } : n
        );
        // "variables" layer toggle: hide non-agent nodes
        if (hiddenLayers.has("variables")) {
          result = result.map((n) =>
            n.type !== 'agent' ? { ...n, hidden: true } : n
          );
        }
      }
      return result;
    },
    [nodes, agentsOnly, hiddenLayers],
  );

  const displayEdges = useMemo(
    () => {
      if (agentsOnly) return edges.map((e) => ({ ...e, hidden: true }));
      // "network" layer toggle: hide all edges
      if (hiddenLayers.has("network")) return edges.map((e) => ({ ...e, hidden: true }));
      return edges;
    },
    [edges, agentsOnly, hiddenLayers],
  );

  /* ── Sync detailNode when nodes change (e.g., after deploy) ── */
  useEffect(() => {
    if (detailNode) {
      const updated = nodes.find(n => n.id === detailNode.id);
      if (updated) {
        setDetailNode(updated);
      } else {
        setDetailNode(null);
      }
    }
  }, [nodes]);

  /* ── Log helper ──────────────────────────────────────────── */
  const addLogEntry = useCallback((message: string, status: LogEntry["status"]) => {
    setLogEntries((prev) => [
      ...prev,
      { id: crypto.randomUUID(), message, status, timestamp: Date.now() },
    ]);
  }, []);

  const clearLog = useCallback(() => setLogEntries([]), []);

  useEffect(() => {
    let active = true;
    const loadProjects = async () => {
      try {
        const resp = await apiRequest<{ projects?: Array<Record<string, unknown>> }>("/api/v1/projects");
        const rows = Array.isArray(resp.projects) ? resp.projects : [];
        const mapped: ProjectSummary[] = rows.map((p) => ({
          project_id: String(p.project_id || ""),
          name: String(p.name || ""),
          slug: String(p.slug || ""),
        })).filter((p) => p.project_id);
        if (!active) return;
        setProjectOptions(mapped);
        if (mapped.length > 0) {
          const preferred = mapped.find((p) => p.slug === currentProject || p.name === currentProject) ?? mapped[0];
          setCurrentProject(preferred.slug || preferred.name);
          setActiveProjectId(preferred.project_id);
        } else {
          // No projects yet — start with empty canvas
          const local = loadLayout();
          setNodes(local?.nodes || []);
          setEdges(local?.edges || []);
          setCanvasReady(true);
        }
      } catch {
        // API unavailable — start with empty canvas or localStorage fallback
        const local = loadLayout();
        setNodes(local?.nodes || []);
        setEdges(local?.edges || []);
        setCanvasReady(true);
      }
    };
    void loadProjects();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!projectOptions.length) return;
    const match = projectOptions.find((p) => p.slug === currentProject || p.name === currentProject);
    if (match?.project_id && match.project_id !== activeProjectId) {
      setActiveProjectId(match.project_id);
    }
  }, [currentProject, projectOptions, activeProjectId]);

  useEffect(() => {
    if (!activeProjectId) return;
    let active = true;

    // Immediately clear canvas when switching projects to avoid stale flash
    skipLayoutPersistRef.current = true;
    setNodes([]);
    setEdges([]);

    const loadRemoteLayout = async () => {
      try {
        const resp = await apiRequest<CanvasLayoutResponse>(`/api/v1/projects/${activeProjectId}/canvas-layout`);
        if (!active) return;
        const loadedNodes = Array.isArray(resp.nodes) ? resp.nodes : [];
        const loadedEdges = Array.isArray(resp.edges) ? resp.edges : [];

        setNodes(loadedNodes as Node[]);
        setEdges(loadedEdges as Edge[]);
        setTimeout(() => {
          if (loadedNodes.length > 0) fitView({ padding: 0.2, duration: 300 });
          skipLayoutPersistRef.current = false;
        }, 120);
        addLogEntry(
          loadedNodes.length > 0
            ? `Loaded canvas for ${currentProject}`
            : `Empty canvas for ${currentProject} — add nodes to get started`,
          "done",
        );
        setCanvasReady(true);
      } catch {
        // API unavailable — try localStorage fallback
        const local = loadLayout();
        if (!active) return;
        if (local) {
          setNodes(local.nodes);
          setEdges(local.edges);
        } else {
          setNodes([]);
          setEdges([]);
        }
        skipLayoutPersistRef.current = false;
        setCanvasReady(true);
      }
    };
    void loadRemoteLayout();
    return () => {
      active = false;
    };
  }, [activeProjectId, setNodes, setEdges, fitView, addLogEntry, currentProject]);

  useEffect(() => {
    // Don't persist during project switch transitions or when canvas is empty (cleared state)
    if (!activeProjectId || skipLayoutPersistRef.current || nodes.length === 0) return;
    const timer = setTimeout(() => {
      const safeNodes = nodes.map((n) => ({ ...n, selected: false }));
      saveLayout(safeNodes, edges);
      void apiRequest(`/api/v1/projects/${activeProjectId}/canvas-layout`, "PUT", {
        nodes: safeNodes,
        edges,
      }).catch(() => undefined);
    }, 800);
    return () => clearTimeout(timer);
  }, [nodes, edges, activeProjectId]);

  const deployAgentByName = useCallback(
    async (agentName: string) => {
      if (!agentName) return;
      addLogEntry(`Deploying ${agentName}...`, "running");
      try {
        await apiRequest(`/api/v1/deploy/${agentName}`, "POST");

        // Set status to "deploying" immediately
        setNodes((nds) =>
          nds.map((n) =>
            n.type === "agent" && String(n.data?.name || "") === agentName
              ? { ...n, data: { ...n.data, status: "deploying" } }
              : n,
          ),
        );

        // Clear any existing poll for this agent
        if (deployPollRef.current[agentName]) {
          clearInterval(deployPollRef.current[agentName]);
        }

        // Poll deploy status every 3 seconds, timeout after 60s
        const startTime = Date.now();
        deployPollRef.current[agentName] = setInterval(async () => {
          try {
            const status = await apiRequest<{ status: string }>(`/api/v1/deploy/${agentName}/status`, "GET");
            if (status.status === "deployed" || status.status === "online") {
              clearInterval(deployPollRef.current[agentName]);
              delete deployPollRef.current[agentName];
              setNodes((nds) =>
                nds.map((n) =>
                  n.type === "agent" && String(n.data?.name || "") === agentName
                    ? { ...n, data: { ...n.data, status: "online" } }
                    : n,
                ),
              );
              addLogEntry(`Deployed ${agentName} successfully`, "done");
            }
          } catch {
            // Status endpoint may not be ready yet, keep polling
          }
          // Timeout after 60 seconds
          if (Date.now() - startTime > 60_000) {
            clearInterval(deployPollRef.current[agentName]);
            delete deployPollRef.current[agentName];
            setNodes((nds) =>
              nds.map((n) =>
                n.type === "agent" && String(n.data?.name || "") === agentName
                  ? { ...n, data: { ...n.data, status: "error" } }
                  : n,
              ),
            );
            addLogEntry(`Deploy timeout for ${agentName}`, "error");
          }
        }, 3000);
      } catch (err) {
        addLogEntry(`Deploy failed: ${err instanceof Error ? err.message : "Unknown error"}`, "error");
      }
    },
    [addLogEntry, setNodes],
  );

  // Cleanup deploy polling on unmount
  useEffect(() => {
    return () => {
      Object.values(deployPollRef.current).forEach((id) => clearInterval(id));
    };
  }, []);

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

  const onPaneContextMenu = useCallback((event: MouseEvent | React.MouseEvent<Element, MouseEvent>) => {
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
      const id = `${type}-${crypto.randomUUID().slice(0, 8)}`;
      const centerX = 350 + Math.random() * 300;
      const centerY = 200 + Math.random() * 200;

      const defaults: Record<string, Record<string, unknown>> = {
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

  /* ── Import agent handler ──────────────────────────────── */
  const handleImportAgent = useCallback(
    async (agentData: Record<string, unknown>) => {
      addLogEntry("Importing agent...", "running");
      try {
        const result = await apiRequest<{ name?: string; agent_name?: string; model?: string; tools?: string[] }>(
          "/api/v1/agents/import",
          "POST",
          agentData,
        );
        const agentName = result.name || result.agent_name || (agentData.name as string) || "Imported Agent";
        const id = `agent-${crypto.randomUUID().slice(0, 8)}`;
        const centerX = 350 + Math.random() * 300;
        const centerY = 200 + Math.random() * 200;
        const newNode: Node = {
          id,
          type: "agent",
          position: { x: centerX, y: centerY },
          data: {
            name: agentName,
            model: result.model || (agentData.model as string) || "gpt-4.1-mini",
            status: "draft",
            tools: result.tools || (agentData.tools as string[]) || [],
            activity: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
          },
        };
        setNodes((nds) => [...nds, newNode]);
        addLogEntry(`Imported agent: ${agentName}`, "done");
        setDetailNode(newNode);
      } catch (err) {
        addLogEntry(`Import failed: ${err instanceof Error ? err.message : "Unknown error"}`, "error");
      }
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
      if (action === "open-secrets") { setOverlayPanel("secrets"); return; }

      // Navigation actions
      if (action === "open-overview") { navigate("/overview"); return; }
      if (action === "open-observability") { navigate("/observability"); return; }
      if (action === "open-metrics") { navigate("/metrics"); return; }
      if (action === "open-settings") { navigate("/settings"); return; }
      if (action === "open-billing") { navigate("/billing"); return; }
    },
    [addNode, navigate],
  );

  /* ── Deploy ──────────────────────────────────────────────── */
  const handleDeploy = useCallback(
    async (nodeId: string) => {
      const node = nodes.find((n) => n.id === nodeId);
      if (!node || node.type !== "agent") return;
      await deployAgentByName(String(node.data?.name || ""));
    },
    [nodes, deployAgentByName],
  );

  /* ── Update node data from detail panel ──────────────────── */
  const handleUpdateNode = useCallback(
    (nodeId: string, data: Record<string, unknown>) => {
      setNodes((nds) =>
        nds.map((n) => (n.id === nodeId ? { ...n, data } : n)),
      );
      addLogEntry(`Updated ${(data.name as string) || "node"}`, "done");
    },
    [setNodes, addLogEntry],
  );

  /* ── Delete node ─────────────────────────────────────────── */
  const handleDeleteNode = useCallback(
    async (nodeId: string) => {
      const node = nodes.find((n) => n.id === nodeId);
      const agentName = String(node?.data?.name || "");

      // If it's an agent node, call the backend DELETE endpoint first
      if (node?.type === "agent" && agentName) {
        try {
          await apiRequest(`/api/v1/agents/${encodeURIComponent(agentName)}`, "DELETE");
          addLogEntry(`Deleted agent "${agentName}" from backend`, "done");
        } catch (err) {
          addLogEntry(`Backend delete failed: ${err instanceof Error ? err.message : "Unknown error"} — removing from canvas`, "error");
        }
      }

      setNodes((nds) => nds.filter((n) => n.id !== nodeId));
      setEdges((eds) => eds.filter((e) => e.source !== nodeId && e.target !== nodeId));
      setDetailNode(null);
      setTimeout(() => fitView({ padding: 0.2, duration: 300 }), 50);
      addLogEntry(`Deleted ${agentName || "node"}`, "done");
    },
    [nodes, setNodes, setEdges, addLogEntry, fitView],
  );

  /* ── Clone node ──────────────────────────────────────────── */
  const handleCloneNode = useCallback(
    async (nodeId: string) => {
      const node = nodes.find((n) => n.id === nodeId);
      if (!node) return;
      const agentName = String(node.data?.name || "");

      const nodeData = (node.data ?? {}) as Record<string, unknown>;
      let clonedName = `${agentName} (copy)`;
      let clonedData: Record<string, unknown> = { ...nodeData, name: clonedName };

      // If it's an agent node, call the backend clone endpoint
      if (node.type === "agent" && agentName) {
        try {
          const result = await apiRequest<{ name?: string; model?: string; tools?: string[] }>(
            `/api/v1/agents/${encodeURIComponent(agentName)}/clone`,
            "POST",
          );
          clonedName = String(result.name || clonedName);
          clonedData = {
            ...nodeData,
            name: clonedName,
            model: result.model || nodeData.model,
            tools: Array.isArray(result.tools) ? result.tools : (nodeData.tools || []),
            status: "draft",
          };
          addLogEntry(`Cloned agent "${agentName}" to "${clonedName}" on backend`, "done");
        } catch (err) {
          addLogEntry(`Backend clone failed: ${err instanceof Error ? err.message : "Unknown error"} — cloning locally`, "error");
        }
      }

      const newId = `${node.type}-${crypto.randomUUID().slice(0, 8)}`;
      const newNode: Node = {
        ...node,
        id: newId,
        position: { x: node.position.x + 40, y: node.position.y + 40 },
        data: clonedData,
      };
      setNodes((nds) => [...nds, newNode]);
      addLogEntry(`Cloned ${agentName || "node"}`, "done");
    },
    [nodes, setNodes, addLogEntry],
  );

  /* ── Context menu actions ────────────────────────────────── */
  const handleContextAction = useCallback(
    (action: string, nodeId?: string) => {
      const mutatingActions = new Set([
        "edit", "deploy", "delete", "clone", "export", "add-agent", "add-knowledge",
        "add-datasource", "add-connector", "add-mcp",
      ]);
      if (!editMode && mutatingActions.has(action)) {
        addLogEntry(`Blocked in view mode: ${action}`, "error");
        return;
      }
      switch (action) {
        case "edit": {
          const node = nodes.find((n) => n.id === nodeId);
          if (node) setDetailNode(node);
          break;
        }
        case "run": {
          const runNode = nodes.find((n) => n.id === nodeId);
          if (runNode) {
            addLogEntry(`Opening ${runNode.data?.name || "agent"} for run...`, "running");
            setDetailNode(runNode);
          }
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
          if (nodeId) void handleDeleteNode(nodeId);
          break;
        }
        case "clone": {
          if (nodeId) void handleCloneNode(nodeId);
          break;
        }
        case "export": {
          const exportNode = nodes.find((n) => n.id === nodeId);
          if (exportNode?.type === "agent") {
            const agentName = String(exportNode.data?.name || "");
            if (agentName) {
              addLogEntry(`Exporting ${agentName}...`, "running");
              apiRequest<Record<string, unknown>>(`/api/v1/agents/${encodeURIComponent(agentName)}/export`, "GET")
                .then((data) => {
                  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = `${agentName}-export.json`;
                  document.body.appendChild(a);
                  a.click();
                  document.body.removeChild(a);
                  URL.revokeObjectURL(url);
                  addLogEntry(`Exported ${agentName}`, "done");
                })
                .catch((err) => {
                  addLogEntry(`Export failed: ${err instanceof Error ? err.message : "Unknown error"}`, "error");
                });
            }
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
        case "open-secrets": setOverlayPanel("secrets"); break;
        default:
          addLogEntry(`Action: ${action}`, "done");
      }
    },
    [nodes, addNode, addLogEntry, editMode, handleDeploy, handleDeleteNode, handleCloneNode, setNodes],
  );

  /* ── Meta-agent ──────────────────────────────────────────── */
  const handleMetaSubmit = useCallback(
    async (prompt: string) => {
      setMetaProcessing(true);
      setMetaResult(undefined);
      addLogEntry(`Meta-Agent: "${prompt.slice(0, 60)}${prompt.length > 60 ? "..." : ""}"`, "running");

      try {
        const draftPath = `/api/v1/agents/create-from-description?draft_only=true&description=${encodeURIComponent(prompt)}`;
        const result = await apiRequest<{ name?: string; model?: string; tools?: string[] }>(
          draftPath,
          "POST",
        );

        const msg = "Meta-Agent generated a draft. Approve & Create to persist it.";
        setMetaResult(msg);
        addLogEntry("Meta-Agent completed", "done");

        const agentName = String(result.name || "Generated Agent");
        const model = String(result.model || "gpt-4.1-mini");
        const tools = Array.isArray(result.tools) ? result.tools.map(String) : [];
        const resources = inferResourcesFromPromptAndTools(prompt, tools);

        const clusterNodeIds: string[] = [];
        const agentId = `agent-${crypto.randomUUID().slice(0, 8)}`;
        clusterNodeIds.push(agentId);
        const agentNode: Node = {
          id: agentId,
          type: "agent",
          position: { x: 420 + Math.random() * 40, y: 230 + Math.random() * 40 },
          data: {
            name: agentName,
            model,
            status: "draft",
            tools,
            activity: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
          },
        };

        const resourceNodes: Node[] = resources.map((resource, index) => {
          const spacingY = 140;
          const top = 120;
          const y = top + index * spacingY;
          const x = resource.type === "knowledge" || resource.type === "datasource" ? 150 : 760;
          const idPrefix = resource.type === "datasource" ? "datasource" : resource.type;
          const id = `${idPrefix}-${crypto.randomUUID().slice(0, 8)}`;
          clusterNodeIds.push(id);
          if (resource.type === "knowledge") {
            return {
              id,
              type: "knowledge",
              position: { x, y },
              data: { name: resource.name, docCount: 0, totalSize: "0 MB", status: "empty", chunkCount: 0 },
            };
          }
          if (resource.type === "datasource") {
            return {
              id,
              type: "datasource",
              position: { x, y },
              data: { name: resource.name, type: "postgres", status: "disconnected", tableCount: 0 },
            };
          }
          if (resource.type === "mcpServer") {
            return {
              id,
              type: "mcpServer",
              position: { x, y },
              data: { name: resource.name, url: "https://...", status: "offline", toolCount: 0 },
            };
          }
          return {
            id,
            type: "connector",
            position: { x, y },
            data: { name: resource.name, app: `${resource.name} Workspace`, status: "pending", toolCount: 0 },
          };
        });

        const resourceEdges: Edge[] = resourceNodes.map((r) =>
          makeEdge(
            `e-${r.id}-${agentId}`,
            r.id,
            agentId,
            getEdgeColor(r.type, "agent"),
          ),
        );

        setNodes((nds) => [...nds, agentNode, ...resourceNodes]);
        setEdges((eds) => [...eds, ...resourceEdges]);
        setDetailNode(agentNode);
        setMetaDraft({
          agentNodeId: agentId,
          clusterNodeIds,
          prompt,
          agentName,
          model,
          tools,
          resources,
          createdAt: Date.now(),
        });
        addLogEntry(
          `Meta-Agent created ${agentName}${resources.length ? ` with ${resources.length} resource nodes` : ""}`,
          "done",
        );
      } catch (err) {
        const errMsg = `Error: ${err instanceof Error ? err.message : "Failed to create agent"}`;
        setMetaResult(errMsg);
        addLogEntry("Meta-Agent failed", "error");
      } finally {
        setMetaProcessing(false);
      }
    },
    [setNodes, setEdges, addLogEntry],
  );

  const handleMetaReviewDraft = useCallback(() => {
    if (!metaDraft) return;
    const node = nodes.find((n) => n.id === metaDraft.agentNodeId);
    if (!node) return;
    setDetailNode(node);
    addLogEntry(`Reviewing ${metaDraft.agentName}`, "running");
  }, [metaDraft, nodes, addLogEntry]);

  const handleMetaCenterDraft = useCallback(() => {
    if (!metaDraft) return;
    const clusterNodes = nodes.filter((n) => metaDraft.clusterNodeIds.includes(n.id));
    if (!clusterNodes.length) return;
    const centerX = clusterNodes.reduce((sum, n) => sum + n.position.x, 0) / clusterNodes.length;
    const centerY = clusterNodes.reduce((sum, n) => sum + n.position.y, 0) / clusterNodes.length;
    setCenter(centerX + 120, centerY + 60, { zoom: 0.85, duration: 500 });
    addLogEntry(`Centered on ${metaDraft.agentName} cluster`, "done");
  }, [metaDraft, nodes, setCenter, addLogEntry]);

  const handleMetaDeployDraft = useCallback(async () => {
    if (!metaDraft) return;
    addLogEntry(`Approving draft ${metaDraft.agentName}...`, "running");
    try {
      const createPath = `/api/v1/agents/create-from-description?draft_only=false&description=${encodeURIComponent(metaDraft.prompt)}&name=${encodeURIComponent(metaDraft.agentName)}&tools=${encodeURIComponent(metaDraft.tools.length ? metaDraft.tools.join(",") : "none")}`;
      const created = await apiRequest<{ created?: boolean; name?: string; model?: string; tools?: string[] }>(
        createPath,
        "POST",
      );
      const createdName = String(created.name || metaDraft.agentName);
      setNodes((nds) =>
        nds.map((n) =>
          n.id === metaDraft.agentNodeId
            ? { ...n, data: { ...n.data, name: createdName, model: created.model || metaDraft.model } }
            : n,
        ),
      );
      setMetaDraft((prev) => (prev ? { ...prev, agentName: createdName } : prev));
      addLogEntry(`Approved draft for ${createdName}`, "done");
      await deployAgentByName(createdName);
    } catch (err) {
      addLogEntry(`Approve failed: ${err instanceof Error ? err.message : "Unknown error"}`, "error");
      return;
    }
  }, [metaDraft, deployAgentByName, addLogEntry, setNodes, setMetaDraft]);

  /* ── Snapshot before drag starts (for undo) ─────────────── */
  const onNodeDragStart = useCallback(
    () => {
      takeSnapshot(nodes);
    },
    [nodes, takeSnapshot],
  );

  /* ── Save layout on drag stop ────────────────────────────── */
  const onNodeDragStop = useCallback(
    (_: React.MouseEvent, __: Node, allNodes: Node[]) => {
      saveLayout(allNodes, edges);
    },
    [edges],
  );

  /* ── Undo / Redo handlers ───────────────────────────────── */
  const handleUndo = useCallback(() => {
    undo(nodes, setNodes);
  }, [nodes, setNodes, undo]);

  const handleRedo = useCallback(() => {
    redo(nodes, setNodes);
  }, [nodes, setNodes, redo]);

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

      // Cmd+Z / Ctrl+Z → Undo
      if ((e.metaKey || e.ctrlKey) && e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        handleUndo();
        return;
      }

      // Cmd+Shift+Z / Ctrl+Shift+Z or Ctrl+Y → Redo
      if ((e.metaKey || e.ctrlKey) && (e.key === "Z" || e.key === "y")) {
        e.preventDefault();
        handleRedo();
        return;
      }

      // Escape → close everything
      if (e.key === "Escape") {
        if (cmdPaletteOpen) { setCmdPaletteOpen(false); return; }
        if (overlayPanel) { setOverlayPanel(null); return; }
        if (detailNode) { setDetailNode(null); setTimeout(() => fitView({ padding: 0.2, duration: 300 }), 50); return; }
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
  }, [detailNode, handleDeleteNode, cmdPaletteOpen, overlayPanel, handleUndo, handleRedo]);

  /* ── Listen for canvas:run-agent events from AgentNode ──── */
  useEffect(() => {
    const handleRunAgent = (e: Event) => {
      const detail = (e as CustomEvent).detail as { name: string } | undefined;
      if (!detail?.name) return;
      const agentNode = nodes.find(
        (n) => n.type === "agent" && String(n.data?.name || "") === detail.name,
      );
      if (agentNode) {
        addLogEntry(`Opening ${detail.name} for run...`, "running");
        setDetailNode(agentNode);
      }
    };
    window.addEventListener("canvas:run-agent", handleRunAgent);
    return () => window.removeEventListener("canvas:run-agent", handleRunAgent);
  }, [nodes, addLogEntry]);

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
      <div className="relative z-20 flex items-center gap-0 h-11 px-4 border-b flex-shrink-0 glass-heavy">
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
              <div className="absolute left-0 top-full mt-1 z-50 w-52 rounded-lg shadow-xl overflow-hidden glass-dropdown border border-border-default">
                <div className="px-3 py-2 border-b border-border-default">
                  <p className="text-[10px] text-text-muted uppercase tracking-wider font-medium">Projects</p>
                </div>
                {(projectOptions.length
                  ? projectOptions.map((p) => p.slug || p.name)
                  : ["my-agents", "production-bots", "experimental"]).map((p) => (
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
              <div className="absolute left-0 top-full mt-1 z-50 w-48 rounded-lg shadow-xl overflow-hidden glass-dropdown border border-border-default">
                <div className="px-3 py-2 border-b border-border-default">
                  <p className="text-[10px] text-text-muted uppercase tracking-wider font-medium">Environments</p>
                </div>
                {[
                  { name: "production", icon: <Globe size={10} className="text-status-live" /> },
                  { name: "staging", icon: <GitBranch size={10} className="text-status-warning" /> },
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

        <button
          onClick={() => {
            if (!roleCanEdit) return;
            setEditMode((v) => !v);
          }}
          disabled={!roleCanEdit}
          className={`flex items-center gap-1 px-2 py-1 text-[10px] rounded-md transition-colors mr-1 ${
            editMode
              ? "bg-accent/15 text-accent border border-accent/30"
              : "text-text-muted hover:text-text-primary hover:bg-surface-overlay border border-transparent"
          } ${!roleCanEdit ? "opacity-50 cursor-not-allowed" : ""}`}
          title={roleCanEdit ? "Toggle canvas edit mode" : "Insufficient permissions"}
        >
          {editMode ? "Edit" : "View"}
        </button>

        {/* Reset */}
        <button
          onClick={() => {
            localStorage.removeItem(LAYOUT_KEY);
            setNodes([]);
            setEdges([]);
            setDetailNode(null);
            addLogEntry("Canvas cleared", "done");
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
          Meta-Agent
        </button>

        <button className="flex items-center justify-center w-7 h-7 text-text-muted hover:text-text-primary hover:bg-surface-overlay rounded-md transition-colors mr-1">
          <Bell size={13} />
        </button>

        <div className="w-6 h-6 rounded-full bg-accent/20 flex items-center justify-center ml-1">
          <span className="text-[9px] font-bold text-accent">U</span>
        </div>
      </div>

      {/* ── Canvas area ─────────────────────────────────────── */}
      <div className="flex-1 flex overflow-hidden min-h-0 relative">
        {/* React Flow canvas — shrinks when detail panel opens */}
        <div className="flex-1 relative bg-surface-base" style={{ transition: 'width 0.3s ease' }}>
        <ReactFlow
          nodes={displayNodes}
          edges={displayEdges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeContextMenu={onNodeContextMenu}
          onPaneContextMenu={onPaneContextMenu}
          onPaneClick={onPaneClick}
          onNodeClick={onNodeClick}
          onNodeDragStart={onNodeDragStart}
          onNodeDragStop={onNodeDragStop}
          nodeTypes={nodeTypes}
          defaultEdgeOptions={defaultEdgeOptions}
          fitView
          fitViewOptions={FIT_VIEW_OPTIONS}
          proOptions={PRO_OPTIONS}
          className=""
          minZoom={0.2}
          maxZoom={2}
          snapToGrid
          snapGrid={SNAP_GRID}
        >
          {/* Alignment guide lines shown during node drag */}
          <AlignmentGuides />

        </ReactFlow>

        {/* Mouse cursor glow effect on dots */}
        <CanvasGlow visible={showGrid} />

        {/* ── Canvas overlays ────────────────────────────────────────────────── */}
        <CanvasControls
          showGrid={showGrid}
          onToggleGrid={() => setShowGrid(!showGrid)}
          agentsOnly={agentsOnly}
          onToggleAgentsOnly={() => setAgentsOnly(!agentsOnly)}
          onUndo={handleUndo}
          onRedo={handleRedo}
          canUndo={canUndo}
          canRedo={canRedo}
          hiddenLayers={hiddenLayers}
          onToggleLayer={handleToggleLayer}
        />

        <AddNodeToolbar onAdd={addNode} onImportAgent={(data) => void handleImportAgent(data)} />

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

        {/* Railway-style Node Detail Panel — absolute overlay for glassmorphic refraction */}
        {detailNode && (
          <div className="absolute top-0 h-full z-40" style={{ right: agentRailOpen ? 380 : 0, width: '50%', minWidth: 420, maxWidth: 720, transition: 'right 0.3s ease' }}>
            <NodeDetailPanel
              node={detailNode}
              onClose={() => {
                setDetailNode(null);
                // Re-center canvas to use full available space
                setTimeout(() => fitView({ padding: 0.2, duration: 300 }), 50);
              }}
              onDelete={handleDeleteNode}
              onClone={handleCloneNode}
              onDeploy={handleDeploy}
              onUpdateNode={handleUpdateNode}
            />
          </div>
        )}

        {/* Railway-style Agent rail — absolute right overlay, always on top */}
        {agentRailOpen && (
          <div className="absolute top-0 right-0 h-full z-50" style={{ width: 380 }}>
            <MetaAgentAssist
              onSubmit={handleMetaSubmit}
              isProcessing={metaProcessing}
              lastResult={metaResult}
              latestDraft={metaDraft ? {
                agentName: metaDraft.agentName,
                model: metaDraft.model,
                tools: metaDraft.tools,
                resources: metaDraft.resources,
                createdAt: metaDraft.createdAt,
              } : null}
              onReviewDraft={handleMetaReviewDraft}
              onCenterDraft={handleMetaCenterDraft}
              onDeployDraft={handleMetaDeployDraft}
            />
          </div>
        )}
      </div>

      {/* ── Command Palette (Cmd+K) ──────────────────────────── */}
      <CommandPalette
        open={cmdPaletteOpen}
        onClose={() => setCmdPaletteOpen(false)}
        onAction={handleCommandAction}
      />

      {/* ── Overlay Panels ───────────────────────────────────── */}
      <WorkflowsPanel open={overlayPanel === "workflows"} onClose={() => setOverlayPanel(null)} editable={editMode && roleCanEdit} />
      <SchedulesPanel open={overlayPanel === "schedules"} onClose={() => setOverlayPanel(null)} editable={editMode && roleCanEdit} />
      <WebhooksPanel open={overlayPanel === "webhooks"} onClose={() => setOverlayPanel(null)} editable={editMode && roleCanEdit} />
      <GovernancePanel open={overlayPanel === "governance"} onClose={() => setOverlayPanel(null)} editable={editMode && roleCanEdit} />
      <ProjectsPanel open={overlayPanel === "projects"} onClose={() => setOverlayPanel(null)} editable={editMode && roleCanEdit} />
      <ReleasesPanel open={overlayPanel === "releases"} onClose={() => setOverlayPanel(null)} editable={editMode && roleCanEdit} />
      <InfrastructurePanel open={overlayPanel === "infrastructure"} onClose={() => setOverlayPanel(null)} editable={editMode && roleCanEdit} />
      <SecretsPanel open={overlayPanel === "secrets"} onClose={() => setOverlayPanel(null)} editable={editMode && roleCanEdit} />
    </div>
  );
}
