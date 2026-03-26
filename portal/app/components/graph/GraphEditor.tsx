/**
 * GraphEditor Component
 * 
 * Interactive graph editor using XYFlow.
 */

import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Panel,
  useNodesState,
  useEdgesState,
  addEdge,
  Connection,
  Node,
  Edge,
  NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useCallback, useMemo } from "react";
import type { GraphSpec } from "~/lib/runtime-types";
import { useGraphEditor } from "./useGraphEditor";

// Custom node components
import { LLMNode } from "./nodes/LLMNode";
import { ToolNode } from "./nodes/ToolNode";
import { ConditionNode } from "./nodes/ConditionNode";
import { LoopNode } from "./nodes/LoopNode";
import { SubgraphNode } from "./nodes/SubgraphNode";

interface GraphEditorProps {
  initialGraph?: GraphSpec;
  onChange?: (graph: GraphSpec) => void;
  readOnly?: boolean;
  className?: string;
}

const nodeTypes: NodeTypes = {
  llm: LLMNode,
  tool: ToolNode,
  condition: ConditionNode,
  loop: LoopNode,
  subgraph: SubgraphNode,
};

export function GraphEditor({
  initialGraph,
  onChange,
  readOnly = false,
  className = "",
}: GraphEditorProps) {
  const { state, actions } = useGraphEditor();

  // Convert GraphSpec to XYFlow nodes/edges on mount
  useMemo(() => {
    if (initialGraph) {
      const nodes: Node[] = initialGraph.nodes.map((n, i) => ({
        id: n.id,
        type: n.type,
        position: n.position || { x: i * 200, y: 100 },
        data: {
          label: n.label || n.id,
          config: n.config || {},
        },
      }));

      const edges: Edge[] = initialGraph.edges.map((e) => ({
        id: `${e.source}-${e.target}`,
        source: e.source,
        target: e.target,
        label: e.label,
      }));

      actions.importGraph(nodes, edges);
    }
  }, []); // Only on mount

  // Handle connections
  const onConnect = useCallback(
    (connection: Connection) => {
      if (readOnly) return;
      actions.addEdge(connection);
    },
    [actions, readOnly]
  );

  // Convert back to GraphSpec on change
  const handleExport = useCallback(() => {
    const { nodes, edges } = actions.exportGraph();
    const graph: GraphSpec = {
      nodes: nodes.map((n) => ({
        id: n.id,
        type: n.type || "default",
        position: n.position,
        label: n.data?.label,
        config: n.data?.config,
      })),
      edges: edges.map((e) => ({
        source: e.source,
        target: e.target,
        label: e.label,
      })),
    };
    onChange?.(graph);
  }, [actions, onChange]);

  // Validation
  const validation = actions.validateGraph();

  return (
    <div className={`h-[600px] w-full ${className}`}>
      <ReactFlow
        nodes={state.nodes.map((n) => ({
          ...n,
          selected: state.selectedNodes.includes(n.id),
        }))}
        edges={state.edges.map((e) => ({
          ...e,
          selected: state.selectedEdges.includes(e.id),
        }))}
        nodeTypes={nodeTypes}
        onConnect={onConnect}
        onNodeClick={(_, node) => actions.selectNode(node.id)}
        onEdgeClick={(_, edge) => actions.selectEdge(edge.id)}
        onPaneClick={() => actions.clearSelection()}
        fitView
        snapToGrid
        snapGrid={[15, 15]}
        attributionPosition="bottom-left"
      >
        <Background gap={15} size={1} />
        <Controls />
        <MiniMap
          nodeStrokeWidth={3}
          zoomable
          pannable
        />

        {/* Toolbar */}
        {!readOnly && (
          <Panel position="top-left" className="bg-white rounded-lg shadow p-2">
            <div className="flex flex-col gap-2">
              <button
                onClick={() =>
                  actions.addNode({
                    id: `llm-${Date.now()}`,
                    type: "llm",
                    label: "LLM Call",
                    position: { x: 100, y: 100 },
                  })
                }
                className="px-3 py-1.5 text-sm bg-blue-100 hover:bg-blue-200 rounded text-blue-800"
              >
                + LLM
              </button>
              <button
                onClick={() =>
                  actions.addNode({
                    id: `tool-${Date.now()}`,
                    type: "tool",
                    label: "Tool Call",
                    position: { x: 100, y: 100 },
                  })
                }
                className="px-3 py-1.5 text-sm bg-purple-100 hover:bg-purple-200 rounded text-purple-800"
              >
                + Tool
              </button>
              <button
                onClick={() =>
                  actions.addNode({
                    id: `condition-${Date.now()}`,
                    type: "condition",
                    label: "Condition",
                    position: { x: 100, y: 100 },
                  })
                }
                className="px-3 py-1.5 text-sm bg-green-100 hover:bg-green-200 rounded text-green-800"
              >
                + Condition
              </button>
              <button
                onClick={() =>
                  actions.addNode({
                    id: `loop-${Date.now()}`,
                    type: "loop",
                    label: "Loop",
                    position: { x: 100, y: 100 },
                  })
                }
                className="px-3 py-1.5 text-sm bg-yellow-100 hover:bg-yellow-200 rounded text-yellow-800"
              >
                + Loop
              </button>
              <button
                onClick={() =>
                  actions.addNode({
                    id: `subgraph-${Date.now()}`,
                    type: "subgraph",
                    label: "Subgraph",
                    position: { x: 100, y: 100 },
                  })
                }
                className="px-3 py-1.5 text-sm bg-pink-100 hover:bg-pink-200 rounded text-pink-800"
              >
                + Subgraph
              </button>
              <hr className="border-gray-200" />
              <button
                onClick={actions.undo}
                disabled={!actions.canUndo}
                className="px-3 py-1.5 text-sm bg-gray-100 hover:bg-gray-200 disabled:opacity-50 rounded"
              >
                Undo
              </button>
              <button
                onClick={actions.redo}
                disabled={!actions.canRedo}
                className="px-3 py-1.5 text-sm bg-gray-100 hover:bg-gray-200 disabled:opacity-50 rounded"
              >
                Redo
              </button>
              <button
                onClick={actions.autoLayout}
                className="px-3 py-1.5 text-sm bg-gray-100 hover:bg-gray-200 rounded"
              >
                Auto Layout
              </button>
            </div>
          </Panel>
        )}

        {/* Status */}
        <Panel position="bottom-right" className="bg-white rounded-lg shadow p-2">
          <div className="text-xs">
            {validation.valid ? (
              <span className="text-green-600">✓ Valid</span>
            ) : (
              <span className="text-red-600">✗ {validation.errors.length} errors</span>
            )}
            {validation.warnings.length > 0 && (
              <span className="text-yellow-600 ml-2">
                ⚠ {validation.warnings.length} warnings
              </span>
            )}
          </div>
        </Panel>
      </ReactFlow>
    </div>
  );
}
