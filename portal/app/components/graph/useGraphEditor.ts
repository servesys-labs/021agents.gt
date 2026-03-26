/**
 * useGraphEditor hook
 * 
 * State management and actions for the graph editor.
 */

import { useState, useCallback, useMemo } from "react";
import type { Node, Edge, Connection } from "@xyflow/react";

export interface NodeTemplate {
  id: string;
  type: string;
  label: string;
  config?: Record<string, unknown>;
  position?: { x: number; y: number };
}

export interface EdgeTemplate {
  id: string;
  source: string;
  target: string;
  label?: string;
  condition?: string;
}

export interface GraphEditorState {
  nodes: Node[];
  edges: Edge[];
  selectedNodes: string[];
  selectedEdges: string[];
  history: { nodes: Node[]; edges: Edge[] }[];
  historyIndex: number;
  hasChanges: boolean;
}

export interface GraphEditorActions {
  // Node operations
  addNode: (template: NodeTemplate) => void;
  updateNode: (id: string, updates: Partial<Node>) => void;
  removeNode: (id: string) => void;
  duplicateNode: (id: string) => void;
  
  // Edge operations
  addEdge: (connection: Connection) => void;
  updateEdge: (id: string, updates: Partial<Edge>) => void;
  removeEdge: (id: string) => void;
  
  // Selection
  selectNode: (id: string, multi?: boolean) => void;
  selectEdge: (id: string, multi?: boolean) => void;
  clearSelection: () => void;
  
  // History
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  
  // Layout
  autoLayout: () => void;
  
  // Import/Export
  importGraph: (nodes: Node[], edges: Edge[]) => void;
  exportGraph: () => { nodes: Node[]; edges: Edge[] };
  
  // Validation
  validateGraph: () => ValidationResult;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
}

export interface ValidationError {
  type: "node" | "edge" | "graph";
  id: string;
  message: string;
}

export interface ValidationWarning {
  type: "node" | "edge" | "graph";
  id: string;
  message: string;
}

const MAX_HISTORY = 50;

export function useGraphEditor(
  initialNodes: Node[] = [],
  initialEdges: Edge[] = []
): { state: GraphEditorState; actions: GraphEditorActions } {
  const [nodes, setNodes] = useState<Node[]>(initialNodes);
  const [edges, setEdges] = useState<Edge[]>(initialEdges);
  const [selectedNodes, setSelectedNodes] = useState<string[]>([]);
  const [selectedEdges, setSelectedEdges] = useState<string[]>([]);
  const [history, setHistory] = useState<{ nodes: Node[]; edges: Edge[] }[]>([
    { nodes: initialNodes, edges: initialEdges },
  ]);
  const [historyIndex, setHistoryIndex] = useState(0);

  // Push current state to history
  const pushHistory = useCallback((newNodes: Node[], newEdges: Edge[]) => {
    setHistory((prev) => {
      // Remove any future history if we're not at the end
      const truncated = prev.slice(0, historyIndex + 1);
      const updated = [...truncated, { nodes: newNodes, edges: newEdges }];
      // Keep only MAX_HISTORY items
      return updated.slice(-MAX_HISTORY);
    });
    setHistoryIndex((prev) => Math.min(prev + 1, MAX_HISTORY - 1));
  }, [historyIndex]);

  // Node actions
  const addNode = useCallback((template: NodeTemplate) => {
    const newNode: Node = {
      id: template.id || `node-${Date.now()}`,
      type: template.type,
      position: template.position || { x: 0, y: 0 },
      data: {
        label: template.label,
        config: template.config || {},
      },
    };
    setNodes((prev) => {
      const updated = [...prev, newNode];
      pushHistory(updated, edges);
      return updated;
    });
  }, [edges, pushHistory]);

  const updateNode = useCallback((id: string, updates: Partial<Node>) => {
    setNodes((prev) => {
      const updated = prev.map((n) =>
        n.id === id ? { ...n, ...updates } : n
      );
      pushHistory(updated, edges);
      return updated;
    });
  }, [edges, pushHistory]);

  const removeNode = useCallback((id: string) => {
    setNodes((prev) => {
      const updated = prev.filter((n) => n.id !== id);
      pushHistory(updated, edges);
      return updated;
    });
    // Also remove connected edges
    setEdges((prev) => {
      const updated = prev.filter((e) => e.source !== id && e.target !== id);
      return updated;
    });
  }, [edges, pushHistory]);

  const duplicateNode = useCallback((id: string) => {
    const node = nodes.find((n) => n.id === id);
    if (!node) return;
    
    addNode({
      id: `${id}-copy`,
      type: node.type || "default",
      label: `${node.data?.label || id} (Copy)`,
      config: node.data?.config,
      position: {
        x: (node.position?.x || 0) + 50,
        y: (node.position?.y || 0) + 50,
      },
    });
  }, [nodes, addNode]);

  // Edge actions
  const addEdge = useCallback((connection: Connection) => {
    if (!connection.source || !connection.target) return;
    
    const newEdge: Edge = {
      id: `edge-${connection.source}-${connection.target}-${Date.now()}`,
      source: connection.source,
      target: connection.target,
      sourceHandle: connection.sourceHandle || undefined,
      targetHandle: connection.targetHandle || undefined,
    };
    
    setEdges((prev) => {
      const updated = [...prev, newEdge];
      pushHistory(nodes, updated);
      return updated;
    });
  }, [nodes, pushHistory]);

  const updateEdge = useCallback((id: string, updates: Partial<Edge>) => {
    setEdges((prev) => {
      const updated = prev.map((e) =>
        e.id === id ? { ...e, ...updates } : e
      );
      pushHistory(nodes, updated);
      return updated;
    });
  }, [nodes, pushHistory]);

  const removeEdge = useCallback((id: string) => {
    setEdges((prev) => {
      const updated = prev.filter((e) => e.id !== id);
      pushHistory(nodes, updated);
      return updated;
    });
  }, [nodes, pushHistory]);

  // Selection
  const selectNode = useCallback((id: string, multi = false) => {
    setSelectedNodes((prev) =>
      multi
        ? prev.includes(id)
          ? prev.filter((x) => x !== id)
          : [...prev, id]
        : [id]
    );
    if (!multi) setSelectedEdges([]);
  }, []);

  const selectEdge = useCallback((id: string, multi = false) => {
    setSelectedEdges((prev) =>
      multi
        ? prev.includes(id)
          ? prev.filter((x) => x !== id)
          : [...prev, id]
        : [id]
    );
    if (!multi) setSelectedNodes([]);
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedNodes([]);
    setSelectedEdges([]);
  }, []);

  // History
  const undo = useCallback(() => {
    if (historyIndex > 0) {
      const newIndex = historyIndex - 1;
      setHistoryIndex(newIndex);
      setNodes(history[newIndex].nodes);
      setEdges(history[newIndex].edges);
    }
  }, [history, historyIndex]);

  const redo = useCallback(() => {
    if (historyIndex < history.length - 1) {
      const newIndex = historyIndex + 1;
      setHistoryIndex(newIndex);
      setNodes(history[newIndex].nodes);
      setEdges(history[newIndex].edges);
    }
  }, [history, historyIndex]);

  // Layout (simple grid layout)
  const autoLayout = useCallback(() => {
    const cols = Math.ceil(Math.sqrt(nodes.length));
    const spacing = 200;
    
    const updated = nodes.map((node, i) => ({
      ...node,
      position: {
        x: (i % cols) * spacing + 100,
        y: Math.floor(i / cols) * spacing + 100,
      },
    }));
    
    setNodes(updated);
    pushHistory(updated, edges);
  }, [nodes, edges, pushHistory]);

  // Import/Export
  const importGraph = useCallback((newNodes: Node[], newEdges: Edge[]) => {
    setNodes(newNodes);
    setEdges(newEdges);
    pushHistory(newNodes, newEdges);
  }, [pushHistory]);

  const exportGraph = useCallback(() => ({ nodes, edges }), [nodes, edges]);

  // Validation
  const validateGraph = useCallback((): ValidationResult => {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];
    
    // Check for orphaned nodes
    const connectedNodes = new Set<string>();
    for (const edge of edges) {
      connectedNodes.add(edge.source);
      connectedNodes.add(edge.target);
    }
    
    for (const node of nodes) {
      if (!connectedNodes.has(node.id) && node.type !== "start") {
        warnings.push({
          type: "node",
          id: node.id,
          message: "Node is not connected to any other node",
        });
      }
    }
    
    // Check for cycles (simple detection)
    const adjacency = new Map<string, string[]>();
    for (const edge of edges) {
      const list = adjacency.get(edge.source) || [];
      list.push(edge.target);
      adjacency.set(edge.source, list);
    }
    
    // Check for disconnected subgraphs
    const nodeIds = new Set(nodes.map((n) => n.id));
    const edgeNodeIds = new Set<string>();
    for (const edge of edges) {
      edgeNodeIds.add(edge.source);
      edgeNodeIds.add(edge.target);
    }
    
    for (const id of edgeNodeIds) {
      if (!nodeIds.has(id)) {
        errors.push({
          type: "edge",
          id,
          message: `Edge references non-existent node: ${id}`,
        });
      }
    }
    
    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }, [nodes, edges]);

  const state: GraphEditorState = {
    nodes,
    edges,
    selectedNodes,
    selectedEdges,
    history,
    historyIndex,
    hasChanges: historyIndex > 0,
  };

  const actions: GraphEditorActions = {
    addNode,
    updateNode,
    removeNode,
    duplicateNode,
    addEdge,
    updateEdge,
    removeEdge,
    selectNode,
    selectEdge,
    clearSelection,
    undo,
    redo,
    canUndo: historyIndex > 0,
    canRedo: historyIndex < history.length - 1,
    autoLayout,
    importGraph,
    exportGraph,
    validateGraph,
  };

  return { state, actions };
}
