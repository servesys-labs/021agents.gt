/**
 * Minimal linear declarative graph execution for the control-plane ↔ edge bridge.
 */

export const EDGE_FRESH_GRAPH_KIND_MAP: Record<string, string> = {
  bootstrap: "fresh_bootstrap",
  turn_budget: "fresh_turn_budget",
  summarize: "fresh_summarize",
  route_llm: "fresh_route_llm",
  post_llm: "fresh_post_llm",
  approval: "fresh_approval",
  final: "fresh_final_answer",
  tools: "fresh_tools",
  loop_detect: "fresh_loop_detect",
  after_tools: "fresh_after_tools",
};

export interface GraphNodeRecord {
  id: string;
  kind?: string;
  type?: string;
  config?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface GraphSpec {
  id?: string;
  nodes: GraphNodeRecord[];
  edges: Array<Record<string, unknown>>;
}

export interface GraphAgentContext {
  agent_name: string;
  org_id?: string;
  project_id?: string;
  channel?: string;
  channel_user_id?: string;
}

export interface LinearGraphRunInput {
  graph: GraphSpec;
  task: string;
  agent_context: GraphAgentContext;
  initial_state?: Record<string, unknown>;
  /** When set (from control-plane validation), must match recomputed linear path. */
  validation?: { linear_path?: string[]; graph_id?: string };
}

export interface BoundedDagValidation {
  execution_order?: string[];
  graph_id?: string;
}

export interface BoundedDagRunInput extends Omit<LinearGraphRunInput, "validation"> {
  validation?: BoundedDagValidation;
  max_branching?: number;
  max_fanin?: number;
}

export interface LinearValidationIssue {
  code: string;
  message: string;
  path?: string | null;
}

export interface LinearTraceEntry {
  node_id: string;
  kind: string;
  edge_executor_id: string;
}

function normalizedEdges(raw: GraphSpec): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const e of raw.edges || []) {
    const s = (e as { source?: unknown; from?: unknown }).source ?? (e as { from?: unknown }).from;
    const t = (e as { target?: unknown; to?: unknown }).target ?? (e as { to?: unknown }).to;
    if (typeof s === "string" && typeof t === "string" && s.trim() && t.trim()) {
      out.push([s.trim(), t.trim()]);
    }
  }
  return out;
}

export function resolveDeclarativeNodeKind(node: GraphNodeRecord | undefined): string {
  if (!node) return "";
  const k = node.kind;
  if (typeof k === "string" && k.trim()) return k.trim();
  const t = node.type;
  if (typeof t === "string" && t.trim()) return t.trim();
  return "";
}

/**
 * If the graph is a single simple path from unique entry to unique exit, return node ids in order.
 */
export function linearEntryExitPath(raw: GraphSpec): string[] | null {
  const nodes = raw.nodes || [];
  const nodeIds = new Set<string>();
  for (const n of nodes) {
    if (n && typeof n.id === "string" && n.id.trim()) {
      nodeIds.add(n.id.trim());
    }
  }
  if (nodeIds.size !== nodes.length) {
    return null;
  }
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const id of nodeIds) {
    incoming.set(id, 0);
    outgoing.set(id, []);
  }
  for (const [s, t] of normalizedEdges(raw)) {
    if (!nodeIds.has(s) || !nodeIds.has(t)) {
      return null;
    }
    incoming.set(t, (incoming.get(t) || 0) + 1);
    outgoing.get(s)!.push(t);
  }
  const entries = [...nodeIds].filter((id) => (incoming.get(id) || 0) === 0).sort();
  const exits = [...nodeIds].filter((id) => (outgoing.get(id) || []).length === 0).sort();
  if (entries.length !== 1 || exits.length !== 1) {
    return null;
  }
  for (const id of nodeIds) {
    const outs = [...new Set((outgoing.get(id) || []).sort())];
    outgoing.set(id, outs);
  }
  const start = entries[0];
  const end = exits[0];
  const path: string[] = [start];
  const seen = new Set<string>([start]);
  while (true) {
    const outs = outgoing.get(path[path.length - 1]) || [];
    if (outs.length === 0) break;
    if (outs.length !== 1) {
      return null;
    }
    const nxt = outs[0];
    if (seen.has(nxt)) {
      return null;
    }
    seen.add(nxt);
    path.push(nxt);
  }
  if (path[path.length - 1] !== end || seen.size !== nodeIds.size) {
    return null;
  }
  return path;
}

function topologicalOrder(raw: GraphSpec): string[] | null {
  const nodes = raw.nodes || [];
  const nodeIds = new Set<string>();
  for (const n of nodes) {
    if (n && typeof n.id === "string" && n.id.trim()) nodeIds.add(n.id.trim());
  }
  if (nodeIds.size !== nodes.length || nodeIds.size === 0) return null;
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, Set<string>>();
  for (const id of nodeIds) {
    incoming.set(id, 0);
    outgoing.set(id, new Set<string>());
  }
  for (const [s, t] of normalizedEdges(raw)) {
    if (!nodeIds.has(s) || !nodeIds.has(t)) return null;
    if (!outgoing.get(s)!.has(t)) {
      outgoing.get(s)!.add(t);
      incoming.set(t, (incoming.get(t) || 0) + 1);
    }
  }
  const ready = [...nodeIds].filter((id) => (incoming.get(id) || 0) === 0).sort();
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const nxt of [...(outgoing.get(id) || new Set<string>())].sort()) {
      incoming.set(nxt, (incoming.get(nxt) || 0) - 1);
      if ((incoming.get(nxt) || 0) === 0) {
        ready.push(nxt);
      }
    }
    ready.sort();
  }
  if (order.length !== nodeIds.size) return null;
  return order;
}

export function validateLinearDeclarativeGraph(graph: unknown): {
  valid: boolean;
  errors: LinearValidationIssue[];
  linear_path: string[] | null;
} {
  const errors: LinearValidationIssue[] = [];
  if (!graph || typeof graph !== "object") {
    return {
      valid: false,
      errors: [{ code: "GRAPH_NOT_OBJECT", message: "Graph must be an object" }],
      linear_path: null,
    };
  }
  const g = graph as GraphSpec;
  if (!Array.isArray(g.nodes)) {
    return {
      valid: false,
      errors: [{ code: "INVALID_NODES", message: "'nodes' must be an array", path: "nodes" }],
      linear_path: null,
    };
  }
  if (!Array.isArray(g.edges)) {
    return {
      valid: false,
      errors: [{ code: "INVALID_EDGES", message: "'edges' must be an array", path: "edges" }],
      linear_path: null,
    };
  }
  const path = linearEntryExitPath(g);
  if (!path) {
    errors.push({
      code: "NOT_LINEAR_PATH",
      message: "Graph must be a single simple path (one entry, one exit, unique outgoing per step)",
      path: "edges",
    });
    return { valid: false, errors, linear_path: null };
  }
  return { valid: true, errors: [], linear_path: path };
}

export function validateBoundedDagDeclarativeGraph(
  graph: unknown,
  maxBranching = 4,
  maxFanin = 4,
): {
  valid: boolean;
  errors: LinearValidationIssue[];
  execution_order: string[] | null;
} {
  const errors: LinearValidationIssue[] = [];
  if (!graph || typeof graph !== "object") {
    return { valid: false, errors: [{ code: "GRAPH_NOT_OBJECT", message: "Graph must be an object" }], execution_order: null };
  }
  const g = graph as GraphSpec;
  if (!Array.isArray(g.nodes)) {
    return {
      valid: false,
      errors: [{ code: "INVALID_NODES", message: "'nodes' must be an array", path: "nodes" }],
      execution_order: null,
    };
  }
  if (!Array.isArray(g.edges)) {
    return {
      valid: false,
      errors: [{ code: "INVALID_EDGES", message: "'edges' must be an array", path: "edges" }],
      execution_order: null,
    };
  }
  const nodeIds = new Set<string>(g.nodes.map((n) => String(n.id || "").trim()).filter(Boolean));
  if (nodeIds.size !== g.nodes.length) {
    return {
      valid: false,
      errors: [{ code: "DUPLICATE_NODE_ID", message: "Node ids must be unique", path: "nodes" }],
      execution_order: null,
    };
  }
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, number>();
  for (const id of nodeIds) {
    incoming.set(id, 0);
    outgoing.set(id, 0);
  }
  for (const [s, t] of normalizedEdges(g)) {
    if (!nodeIds.has(s) || !nodeIds.has(t)) {
      return {
        valid: false,
        errors: [{ code: "UNKNOWN_EDGE_NODE", message: "Edges must reference existing nodes", path: "edges" }],
        execution_order: null,
      };
    }
    outgoing.set(s, (outgoing.get(s) || 0) + 1);
    incoming.set(t, (incoming.get(t) || 0) + 1);
  }
  for (const [id, deg] of outgoing.entries()) {
    if (deg > maxBranching) {
      return {
        valid: false,
        errors: [{ code: "TOO_MANY_BRANCHES", message: `Node '${id}' exceeds max branching (${deg} > ${maxBranching})`, path: "edges" }],
        execution_order: null,
      };
    }
  }
  for (const [id, deg] of incoming.entries()) {
    if (deg > maxFanin) {
      return {
        valid: false,
        errors: [{ code: "TOO_MANY_FANIN", message: `Node '${id}' exceeds max fan-in (${deg} > ${maxFanin})`, path: "edges" }],
        execution_order: null,
      };
    }
  }
  const order = topologicalOrder(g);
  if (!order) {
    return {
      valid: false,
      errors: [{ code: "INVALID_TOPOLOGY", message: "Could not derive deterministic topological order", path: "edges" }],
      execution_order: null,
    };
  }
  return { valid: true, errors: [], execution_order: order };
}

export function executeLinearDeclarativeRun(input: LinearGraphRunInput): {
  success: boolean;
  linear_path: string[];
  linear_trace: LinearTraceEntry[];
  state: Record<string, unknown>;
  error?: string;
  error_code?: string;
} {
  const v = validateLinearDeclarativeGraph(input.graph);
  if (!v.valid || !v.linear_path) {
    return {
      success: false,
      linear_path: [],
      linear_trace: [],
      state: {},
      error: v.errors[0]?.message || "invalid graph",
      error_code: v.errors[0]?.code || "INVALID_GRAPH",
    };
  }
  const path = v.linear_path;
  if (input.validation?.linear_path?.length) {
    const a = input.validation.linear_path.join("\0");
    const b = path.join("\0");
    if (a !== b) {
      return {
        success: false,
        linear_path: path,
        linear_trace: [],
        state: {},
        error: "validation.linear_path does not match graph structure",
        error_code: "VALIDATION_MISMATCH",
      };
    }
  }

  const byId = new Map<string, GraphNodeRecord>();
  for (const n of input.graph.nodes || []) {
    if (n && typeof n.id === "string" && n.id.trim()) {
      byId.set(n.id.trim(), n);
    }
  }

  const ctx = input.agent_context;
  const state: Record<string, unknown> = {
    ...((input.initial_state && typeof input.initial_state === "object") ? input.initial_state : {}),
    task: input.task,
    agent_name: ctx.agent_name,
  };
  if (ctx.org_id) state.org_id = ctx.org_id;
  if (ctx.project_id) state.project_id = ctx.project_id;
  if (ctx.channel) state.channel = ctx.channel;
  if (ctx.channel_user_id) state.channel_user_id = ctx.channel_user_id;

  const linear_trace: LinearTraceEntry[] = [];
  for (const nid of path) {
    const node = byId.get(nid);
    const kind = resolveDeclarativeNodeKind(node);
    if (!kind) {
      return {
        success: false,
        linear_path: path,
        linear_trace,
        state,
        error: `node ${nid} has no non-empty kind or type`,
        error_code: "MISSING_NODE_KIND",
      };
    }
    const edgeExecutorId = EDGE_FRESH_GRAPH_KIND_MAP[kind] || "";
    linear_trace.push({ node_id: nid, kind, edge_executor_id: edgeExecutorId });
    state.last_node_id = nid;
    state.last_kind = kind;
    if (node?.config && typeof node.config === "object") {
      state[`node_${nid}`] = node.config;
    }
  }

  state.__linear_trace__ = linear_trace;
  return {
    success: true,
    linear_path: path,
    linear_trace,
    state,
  };
}

export function executeBoundedDagDeclarativeRun(input: BoundedDagRunInput): {
  success: boolean;
  execution_order: string[];
  execution_trace: LinearTraceEntry[];
  state: Record<string, unknown>;
  error?: string;
  error_code?: string;
} {
  const maxBranching = Number.isFinite(Number(input.max_branching)) ? Number(input.max_branching) : 4;
  const maxFanin = Number.isFinite(Number(input.max_fanin)) ? Number(input.max_fanin) : 4;
  const v = validateBoundedDagDeclarativeGraph(input.graph, maxBranching, maxFanin);
  if (!v.valid || !v.execution_order) {
    return {
      success: false,
      execution_order: [],
      execution_trace: [],
      state: {},
      error: v.errors[0]?.message || "invalid graph",
      error_code: v.errors[0]?.code || "INVALID_GRAPH",
    };
  }
  const order = v.execution_order;
  if (input.validation?.execution_order?.length) {
    const expected = input.validation.execution_order.join("\0");
    const actual = order.join("\0");
    if (expected !== actual) {
      return {
        success: false,
        execution_order: order,
        execution_trace: [],
        state: {},
        error: "validation.execution_order does not match graph structure",
        error_code: "VALIDATION_MISMATCH",
      };
    }
  }
  const byId = new Map<string, GraphNodeRecord>();
  for (const n of input.graph.nodes || []) {
    if (n && typeof n.id === "string" && n.id.trim()) byId.set(n.id.trim(), n);
  }
  const ctx = input.agent_context;
  const state: Record<string, unknown> = {
    ...((input.initial_state && typeof input.initial_state === "object") ? input.initial_state : {}),
    task: input.task,
    agent_name: ctx.agent_name,
  };
  if (ctx.org_id) state.org_id = ctx.org_id;
  if (ctx.project_id) state.project_id = ctx.project_id;
  if (ctx.channel) state.channel = ctx.channel;
  if (ctx.channel_user_id) state.channel_user_id = ctx.channel_user_id;

  const executionTrace: LinearTraceEntry[] = [];
  for (const nid of order) {
    const node = byId.get(nid);
    const kind = resolveDeclarativeNodeKind(node);
    if (!kind) {
      return {
        success: false,
        execution_order: order,
        execution_trace: executionTrace,
        state,
        error: `node ${nid} has no non-empty kind or type`,
        error_code: "MISSING_NODE_KIND",
      };
    }
    const edgeExecutorId = EDGE_FRESH_GRAPH_KIND_MAP[kind] || "";
    executionTrace.push({ node_id: nid, kind, edge_executor_id: edgeExecutorId });
    state.last_node_id = nid;
    state.last_kind = kind;
    if (node?.config && typeof node.config === "object") {
      state[`node_${nid}`] = node.config;
    }
  }
  state.__execution_trace__ = executionTrace;
  state.__execution_order__ = order;
  return {
    success: true,
    execution_order: order,
    execution_trace: executionTrace,
    state,
  };
}
