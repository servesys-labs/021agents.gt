import { useState, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Plus, Trash2, Zap, Brain, Wrench, GitBranch, MessageSquare } from "lucide-react";
import { Button } from "../components/ui/Button";
import { AgentNav } from "../components/AgentNav";
import { AgentNotFound } from "../components/AgentNotFound";
import { Input } from "../components/ui/Input";
import { Select } from "../components/ui/Select";
import { Card } from "../components/ui/Card";
import { Modal } from "../components/ui/Modal";
import { useToast } from "../components/ui/Toast";
import { MOCK_AGENTS, type FlowNode, type FlowEdge } from "../lib/mock-data";

const nodeColors: Record<FlowNode["type"], { bg: string; border: string; icon: React.ComponentType<any> }> = {
  trigger: { bg: "#dbeafe", border: "#3b82f6", icon: Zap },
  llm: { bg: "#f3e8ff", border: "#a855f7", icon: Brain },
  tool: { bg: "#dcfce7", border: "#22c55e", icon: Wrench },
  condition: { bg: "#fef3c7", border: "#f59e0b", icon: GitBranch },
  response: { bg: "#e0e7ff", border: "#6366f1", icon: MessageSquare },
};

const NODE_W = 160;
const NODE_H = 48;
const CANVAS_W = 600;
const CANVAS_H = 500;
const OFFSET_X = CANVAS_W / 2;
const OFFSET_Y = 20;

export default function AgentFlowPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const agent = MOCK_AGENTS.find((a) => a.id === id);

  const [nodes, setNodes] = useState<FlowNode[]>(agent?.nodes || []);
  const [edges, setEdges] = useState<FlowEdge[]>(agent?.edges || []);
  const [showAddNode, setShowAddNode] = useState(false);
  const [newNodeType, setNewNodeType] = useState<FlowNode["type"]>("llm");
  const [newNodeLabel, setNewNodeLabel] = useState("");
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [connectFrom, setConnectFrom] = useState<string | null>(null);

  const addNode = useCallback(() => {
    if (!newNodeLabel.trim()) return;
    const nodeId = `node-${Date.now()}`;
    const maxY = nodes.length > 0 ? Math.max(...nodes.map((n) => n.y)) : -60;
    setNodes((prev) => [...prev, { id: nodeId, type: newNodeType, label: newNodeLabel.trim(), x: 0, y: maxY + 120 }]);
    setNewNodeLabel("");
    setShowAddNode(false);
    toast("Node added");
  }, [newNodeLabel, newNodeType, nodes, toast]);

  const deleteNode = useCallback((nodeId: string) => {
    setNodes((prev) => prev.filter((n) => n.id !== nodeId));
    setEdges((prev) => prev.filter((e) => e.from !== nodeId && e.to !== nodeId));
    setSelectedNode(null);
    toast("Node removed");
  }, [toast]);

  const handleNodeClick = useCallback((nodeId: string) => {
    if (connectFrom) {
      if (connectFrom !== nodeId && !edges.find((e) => e.from === connectFrom && e.to === nodeId)) {
        setEdges((prev) => [...prev, { id: `e-${Date.now()}`, from: connectFrom, to: nodeId }]);
        toast("Connected");
      }
      setConnectFrom(null);
    } else {
      setSelectedNode(nodeId === selectedNode ? null : nodeId);
    }
  }, [connectFrom, selectedNode, edges, toast]);

  const deleteEdge = useCallback((edgeId: string) => {
    setEdges((prev) => prev.filter((e) => e.id !== edgeId));
  }, []);

  const handleSave = () => {
    // TODO: PUT to /api/v1/agents/:id/flow
    toast("Flow saved");
  };

  if (!agent) return <AgentNotFound />;

  const getNodeCenter = (node: FlowNode) => ({
    cx: OFFSET_X + node.x,
    cy: OFFSET_Y + node.y + NODE_H / 2,
  });

  return (
    <div>
      <AgentNav agentName={agent.name}>
        <Button size="sm" variant="secondary" onClick={() => setShowAddNode(true)}>
          <Plus size={14} /> Add Step
        </Button>
        <Button size="sm" onClick={handleSave}>Save</Button>
      </AgentNav>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Canvas */}
        <div className="lg:col-span-2 bg-white rounded-xl border border-border overflow-hidden">
          <svg viewBox={`0 0 ${CANVAS_W} ${CANVAS_H}`} className="w-full" style={{ minHeight: 400 }}>
            {/* Grid dots */}
            <defs>
              <pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse">
                <circle cx="1" cy="1" r="0.5" fill="#e5e7eb" />
              </pattern>
            </defs>
            <rect width={CANVAS_W} height={CANVAS_H} fill="url(#grid)" />

            {/* Edges */}
            {edges.map((edge) => {
              const fromNode = nodes.find((n) => n.id === edge.from);
              const toNode = nodes.find((n) => n.id === edge.to);
              if (!fromNode || !toNode) return null;
              const from = getNodeCenter(fromNode);
              const to = getNodeCenter(toNode);
              const midY = (from.cy + to.cy) / 2;
              return (
                <g key={edge.id} onClick={() => deleteEdge(edge.id)} className="cursor-pointer">
                  <path
                    d={`M ${from.cx} ${from.cy + NODE_H / 2} C ${from.cx} ${midY}, ${to.cx} ${midY}, ${to.cx} ${to.cy - NODE_H / 2}`}
                    fill="none"
                    stroke="#94a3b8"
                    strokeWidth="1.5"
                  />
                  {edge.label && (
                    <text x={(from.cx + to.cx) / 2 + 8} y={midY} className="text-[8px] fill-text-muted" textAnchor="start">
                      {edge.label}
                    </text>
                  )}
                  {/* Arrow */}
                  <circle cx={to.cx} cy={to.cy - NODE_H / 2} r="3" fill="#94a3b8" />
                </g>
              );
            })}

            {/* Nodes */}
            {nodes.map((node) => {
              const style = nodeColors[node.type];
              const x = OFFSET_X + node.x - NODE_W / 2;
              const y = OFFSET_Y + node.y;
              const isSelected = selectedNode === node.id;
              const isConnecting = connectFrom === node.id;

              return (
                <g
                  key={node.id}
                  onClick={() => handleNodeClick(node.id)}
                  className="cursor-pointer"
                >
                  <rect
                    x={x}
                    y={y}
                    width={NODE_W}
                    height={NODE_H}
                    rx={8}
                    fill={style.bg}
                    stroke={isSelected || isConnecting ? style.border : "transparent"}
                    strokeWidth={isSelected || isConnecting ? 2 : 0}
                  />
                  <text x={x + 32} y={y + NODE_H / 2 + 1} className="text-[10px] font-medium" fill="#111827" dominantBaseline="middle">
                    {node.label}
                  </text>
                  {/* Type icon placeholder circle */}
                  <circle cx={x + 16} cy={y + NODE_H / 2} r={8} fill={style.border} opacity={0.2} />
                  <text x={x + 16} y={y + NODE_H / 2 + 1} className="text-[7px] font-bold" fill={style.border} textAnchor="middle" dominantBaseline="middle">
                    {node.type[0].toUpperCase()}
                  </text>
                </g>
              );
            })}
          </svg>

          {connectFrom && (
            <div className="px-4 py-2 bg-blue-50 text-blue-700 text-xs text-center">
              Click a node to connect to, or press Escape to cancel
            </div>
          )}
        </div>

        {/* Side panel */}
        <div className="space-y-4">
          <Card>
            <h3 className="text-sm font-medium text-text mb-3">Legend</h3>
            <div className="space-y-2">
              {(Object.entries(nodeColors) as [FlowNode["type"], typeof nodeColors[FlowNode["type"]]][]).map(([type, style]) => (
                <div key={type} className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded" style={{ backgroundColor: style.border }} />
                  <span className="text-xs text-text-secondary capitalize">{type}</span>
                </div>
              ))}
            </div>
          </Card>

          {selectedNode && (() => {
            const node = nodes.find((n) => n.id === selectedNode);
            if (!node) return null;
            return (
              <Card>
                <h3 className="text-sm font-medium text-text mb-3">Selected: {node.label}</h3>
                <p className="text-xs text-text-secondary mb-3 capitalize">Type: {node.type}</p>
                <div className="flex gap-2">
                  <Button size="sm" variant="secondary" onClick={() => { setConnectFrom(node.id); setSelectedNode(null); }}>
                    Connect
                  </Button>
                  {node.type !== "trigger" && (
                    <Button size="sm" variant="danger" onClick={() => deleteNode(node.id)}>
                      <Trash2 size={14} /> Remove
                    </Button>
                  )}
                </div>
              </Card>
            );
          })()}

          <Card>
            <h3 className="text-sm font-medium text-text mb-2">How it works</h3>
            <p className="text-xs text-text-secondary leading-relaxed">
              Each step in the flow defines how your agent processes a message.
              Click a node to select it, then click "Connect" to link it to another step.
              The flow starts at the trigger and follows the connections you define.
            </p>
          </Card>
        </div>
      </div>

      {/* Add node modal */}
      <Modal open={showAddNode} onClose={() => setShowAddNode(false)} title="Add a step">
        <div className="space-y-4">
          <Select
            label="Step type"
            value={newNodeType}
            onChange={(e) => setNewNodeType(e.target.value as FlowNode["type"])}
            options={[
              { value: "llm", label: "LLM - AI processes the message" },
              { value: "tool", label: "Tool - Call an external service" },
              { value: "condition", label: "Condition - Branch based on criteria" },
              { value: "response", label: "Response - Send a reply" },
            ]}
          />
          <Input label="Label" placeholder="e.g. Check order status" value={newNodeLabel} onChange={(e) => setNewNodeLabel(e.target.value)} />
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => setShowAddNode(false)}>Cancel</Button>
            <Button onClick={addNode} disabled={!newNodeLabel.trim()}>Add Step</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
