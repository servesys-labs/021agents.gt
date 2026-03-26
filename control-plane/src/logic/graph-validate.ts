/**
 * Pure graph validation and normalization — ported from agentos/graph/validate.py.
 *
 * Expected shape:
 *   { id?: string, nodes: [{id, ...}], edges: [{source, target} | {from, to}] }
 */

export interface GraphValidationIssue {
  code: string;
  message: string;
  path: string | null;
  details: Record<string, unknown>;
}

export interface GraphValidationResult {
  valid: boolean;
  errors: GraphValidationIssue[];
  warnings: GraphValidationIssue[];
  summary: Record<string, unknown> | null;
}

function issue(
  code: string,
  message: string,
  path: string | null = null,
  details: Record<string, unknown> = {},
): GraphValidationIssue {
  return { code, message, path, details };
}

function edgeEndpoints(
  edge: unknown,
  index: number,
  errors: GraphValidationIssue[],
): [string, string] | null {
  const path = `edges[${index}]`;
  if (typeof edge !== "object" || edge === null || Array.isArray(edge)) {
    errors.push(issue("INVALID_EDGE", `Edge at index ${index} must be an object`, path));
    return null;
  }
  const e = edge as Record<string, unknown>;
  const src = (e.source ?? e.from) as unknown;
  const tgt = (e.target ?? e.to) as unknown;
  if (src == null || tgt == null) {
    errors.push(
      issue("INVALID_EDGE", "Each edge requires 'source' and 'target' (or 'from' and 'to')", path),
    );
    return null;
  }
  if (typeof src !== "string" || typeof tgt !== "string") {
    errors.push(issue("INVALID_EDGE", "Edge endpoints must be non-empty strings", path));
    return null;
  }
  if (!src.trim() || !tgt.trim()) {
    errors.push(issue("INVALID_EDGE", "Edge endpoints must be non-empty strings", path));
    return null;
  }
  return [src.trim(), tgt.trim()];
}

/** DFS-based cycle detection. Returns cycle path or null. */
export function detectCycle(
  nodeIds: Set<string>,
  adj: Map<string, string[]>,
): string[] | null {
  const color = new Map<string, "white" | "gray" | "black">();
  const parent = new Map<string, string | null>();
  for (const n of nodeIds) {
    color.set(n, "white");
    parent.set(n, null);
  }

  let cycleNodes: string[] | null = null;

  function visit(u: string): void {
    if (cycleNodes !== null) return;
    color.set(u, "gray");
    for (const v of adj.get(u) ?? []) {
      if (!color.has(v)) continue;
      if (color.get(v) === "gray") {
        const rev: string[] = [u];
        let w: string | null | undefined = parent.get(u);
        while (w != null && w !== v) {
          rev.push(w);
          w = parent.get(w);
        }
        if (w === v) {
          cycleNodes = [v, ...rev.reverse(), v];
        }
        return;
      }
      if (color.get(v) === "white") {
        parent.set(v, u);
        visit(v);
        if (cycleNodes !== null) return;
      }
    }
    color.set(u, "black");
  }

  for (const n of [...nodeIds].sort()) {
    if (color.get(n) === "white") visit(n);
    if (cycleNodes !== null) break;
  }
  return cycleNodes;
}

/** Kahn's algorithm for topological ordering. */
export function topologicalOrder(
  nodeIds: Set<string>,
  adj: Map<string, string[]>,
): string[] {
  const inDeg = new Map<string, number>();
  for (const n of nodeIds) inDeg.set(n, 0);
  for (const u of nodeIds) {
    for (const v of adj.get(u) ?? []) {
      if (inDeg.has(v)) inDeg.set(v, (inDeg.get(v) ?? 0) + 1);
    }
  }
  const ready = [...nodeIds].filter((n) => (inDeg.get(n) ?? 0) === 0).sort();
  const out: string[] = [];
  while (ready.length > 0) {
    const u = ready.shift()!;
    out.push(u);
    for (const v of [...(adj.get(u) ?? [])].sort()) {
      if (!inDeg.has(v)) continue;
      inDeg.set(v, (inDeg.get(v) ?? 0) - 1);
      if (inDeg.get(v) === 0) {
        ready.push(v);
        ready.sort();
      }
    }
  }
  return out;
}

/** Core graph definition validator — pure and deterministic. */
export function validateGraphDefinition(raw: unknown): GraphValidationResult {
  const errors: GraphValidationIssue[] = [];
  const warnings: GraphValidationIssue[] = [];

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {
      valid: false,
      errors: [issue("GRAPH_NOT_OBJECT", "Graph definition must be a JSON object", "")],
      warnings: [],
      summary: null,
    };
  }

  const g = raw as Record<string, unknown>;
  let graphId: string | null = null;

  if ("id" in g) {
    const gid = g.id;
    if (gid != null && (typeof gid !== "string" || !String(gid).trim())) {
      errors.push(issue("INVALID_GRAPH_ID", "Optional 'id' must be a non-empty string", "id"));
    } else if (typeof gid === "string" && gid.trim()) {
      graphId = gid.trim();
    }
  }

  const nodesRaw = g.nodes ?? [];
  const edgesRaw = g.edges ?? [];

  if (!Array.isArray(nodesRaw)) {
    errors.push(issue("INVALID_NODES", "'nodes' must be a list", "nodes"));
    return { valid: false, errors, warnings, summary: null };
  }
  if (!Array.isArray(edgesRaw)) {
    errors.push(issue("INVALID_EDGES", "'edges' must be a list", "edges"));
    return { valid: false, errors, warnings, summary: null };
  }

  if (nodesRaw.length === 0) {
    warnings.push(issue("EMPTY_GRAPH", "Graph has no nodes", "nodes"));
  }

  const nodeIds = new Set<string>();
  const seenIds = new Map<string, number>();

  for (let i = 0; i < nodesRaw.length; i++) {
    const node = nodesRaw[i];
    const path = `nodes[${i}]`;
    if (typeof node !== "object" || node === null || Array.isArray(node)) {
      errors.push(issue("INVALID_NODE", `Node at index ${i} must be an object`, path));
      continue;
    }
    const n = node as Record<string, unknown>;
    const nid = n.id;
    if (nid == null || (typeof nid === "string" && !nid.trim())) {
      errors.push(issue("MISSING_NODE_ID", "Each node must have a non-empty string 'id'", path));
      continue;
    }
    if (typeof nid !== "string") {
      errors.push(issue("INVALID_NODE_ID", "Node 'id' must be a string", `${path}.id`));
      continue;
    }
    const trimmed = nid.trim();
    if (seenIds.has(trimmed)) {
      errors.push(
        issue("DUPLICATE_NODE_ID", `Duplicate node id '${trimmed}'`, path, {
          id: trimmed,
          first_index: seenIds.get(trimmed),
        }),
      );
    } else {
      seenIds.set(trimmed, i);
      nodeIds.add(trimmed);
    }
  }

  const normalizedEdges: Array<[string, string, number]> = [];
  const edgePairsSeen = new Set<string>();

  for (let i = 0; i < edgesRaw.length; i++) {
    const ends = edgeEndpoints(edgesRaw[i], i, errors);
    if (ends === null) continue;
    const [s, t] = ends;
    if (!nodeIds.has(s)) {
      errors.push(
        issue("MISSING_NODE_REF", `Edge references unknown source node '${s}'`, `edges[${i}]`, {
          source: s,
          target: t,
        }),
      );
    }
    if (!nodeIds.has(t)) {
      errors.push(
        issue("MISSING_NODE_REF", `Edge references unknown target node '${t}'`, `edges[${i}]`, {
          source: s,
          target: t,
        }),
      );
    }
    if (s === t) {
      errors.push(
        issue("SELF_LOOP", `Self-loop on node '${s}' is not allowed`, `edges[${i}]`, {
          node_id: s,
        }),
      );
    }
    const pair = `${s}->${t}`;
    if (edgePairsSeen.has(pair)) {
      warnings.push(
        issue("DUPLICATE_EDGE", `Duplicate edge from '${s}' to '${t}'`, `edges[${i}]`, {
          source: s,
          target: t,
        }),
      );
    }
    edgePairsSeen.add(pair);
    normalizedEdges.push([s, t, i]);
  }

  if (errors.length > 0) {
    return { valid: false, errors, warnings, summary: null };
  }

  // Build adjacency
  const adj = new Map<string, string[]>();
  for (const n of nodeIds) adj.set(n, []);
  for (const [s, t] of normalizedEdges) {
    adj.get(s)!.push(t);
  }
  for (const [k, v] of adj) {
    adj.set(k, [...new Set(v)].sort());
  }

  // Cycle check
  const cycle = detectCycle(nodeIds, adj);
  if (cycle) {
    errors.push(
      issue("CYCLE", "Directed cycle detected", "edges", { cycle }),
    );
    return { valid: false, errors, warnings, summary: null };
  }

  // Entry/exit
  const entryNodes = new Set(nodeIds);
  const exitNodes = new Set(nodeIds);
  for (const [s, t] of normalizedEdges) {
    entryNodes.delete(t);
    exitNodes.delete(s);
  }

  // Isolated nodes
  const edgeNodeIds = new Set<string>();
  for (const [s, t] of normalizedEdges) {
    edgeNodeIds.add(s);
    edgeNodeIds.add(t);
  }
  const isolated = [...nodeIds].filter((n) => !edgeNodeIds.has(n)).sort();
  for (const n of isolated) {
    warnings.push(
      issue("ISOLATED_NODE", `Node '${n}' has no incident edges`, `nodes[${seenIds.get(n)}]`, {
        node_id: n,
      }),
    );
  }

  const topo = topologicalOrder(nodeIds, adj);
  const summary: Record<string, unknown> = {
    node_count: nodeIds.size,
    edge_count: normalizedEdges.length,
    node_ids: [...nodeIds].sort(),
    entry_nodes: [...entryNodes].sort(),
    exit_nodes: [...exitNodes].sort(),
    topological_order: topo,
  };
  if (graphId !== null) summary.graph_id = graphId;

  return { valid: true, errors: [], warnings, summary };
}

// ── Linear path validation ───────────────────────────────────────────

function normalizedEdges(raw: Record<string, unknown>): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const edges = raw.edges;
  if (!Array.isArray(edges)) return out;
  for (const e of edges) {
    if (typeof e !== "object" || e === null) continue;
    const ed = e as Record<string, unknown>;
    const s = (ed.source ?? ed.from) as unknown;
    const t = (ed.target ?? ed.to) as unknown;
    if (typeof s === "string" && typeof t === "string" && s.trim() && t.trim()) {
      out.push([s.trim(), t.trim()]);
    }
  }
  return out;
}

function linearEntryExitPath(
  raw: Record<string, unknown>,
  summary: Record<string, unknown>,
): string[] | null {
  const nodeIds = new Set<string>((summary.node_ids as string[]) ?? []);
  const entry = (summary.entry_nodes as string[]) ?? [];
  const exitN = (summary.exit_nodes as string[]) ?? [];
  if (entry.length !== 1 || exitN.length !== 1) return null;

  const adj = new Map<string, string[]>();
  for (const n of nodeIds) adj.set(n, []);
  for (const [s, t] of normalizedEdges(raw)) {
    if (adj.has(s) && nodeIds.has(t)) adj.get(s)!.push(t);
  }
  for (const [k, v] of adj) adj.set(k, [...new Set(v)].sort());

  const start = entry[0];
  const end = exitN[0];
  const path: string[] = [start];
  const seen = new Set<string>([start]);

  while (true) {
    const outs = adj.get(path[path.length - 1]) ?? [];
    if (outs.length === 0) break;
    if (outs.length !== 1) return null;
    const nxt = outs[0];
    if (seen.has(nxt)) return null;
    seen.add(nxt);
    path.push(nxt);
  }
  if (path[path.length - 1] !== end || seen.size !== nodeIds.size) return null;
  return path;
}

/** Validate that graph is a single linear path from one entry to one exit. */
export function validateLinearDeclarativeGraph(raw: unknown): GraphValidationResult {
  const base = validateGraphDefinition(raw);
  if (!base.valid || base.summary === null) return base;
  if (typeof raw !== "object" || raw === null) return base;

  const path = linearEntryExitPath(raw as Record<string, unknown>, base.summary);
  if (path === null) {
    return {
      valid: false,
      errors: [
        issue(
          "NOT_LINEAR_PATH",
          "Graph must be a single simple path (one entry, one exit, unique outgoing per step)",
          "edges",
        ),
      ],
      warnings: base.warnings,
      summary: base.summary,
    };
  }
  return {
    valid: true,
    errors: [],
    warnings: base.warnings,
    summary: { ...base.summary, linear_path: path },
  };
}

// ── Bounded DAG validation ───────────────────────────────────────────

function topoOrder(
  raw: Record<string, unknown>,
  summary: Record<string, unknown>,
): string[] | null {
  const nodeIds = new Set<string>((summary.node_ids as string[]) ?? []);
  if (nodeIds.size === 0) return null;
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, Set<string>>();
  for (const n of nodeIds) {
    incoming.set(n, 0);
    outgoing.set(n, new Set());
  }
  for (const [s, t] of normalizedEdges(raw)) {
    if (!nodeIds.has(s) || !nodeIds.has(t)) return null;
    if (!outgoing.get(s)!.has(t)) {
      outgoing.get(s)!.add(t);
      incoming.set(t, (incoming.get(t) ?? 0) + 1);
    }
  }
  const ready = [...nodeIds].filter((n) => (incoming.get(n) ?? 0) === 0).sort();
  const order: string[] = [];
  while (ready.length > 0) {
    const nid = ready.shift()!;
    order.push(nid);
    for (const nxt of [...outgoing.get(nid)!].sort()) {
      incoming.set(nxt, (incoming.get(nxt) ?? 0) - 1);
      if (incoming.get(nxt) === 0) {
        ready.push(nxt);
        ready.sort();
      }
    }
  }
  if (order.length !== nodeIds.size) return null;
  return order;
}

/** Validate bounded DAG with max_branching and max_fanin constraints. */
export function validateBoundedDagDeclarativeGraph(
  raw: unknown,
  opts: { maxBranching?: number; maxFanin?: number } = {},
): GraphValidationResult {
  const maxBranching = opts.maxBranching ?? 4;
  const maxFanin = opts.maxFanin ?? 4;

  const base = validateGraphDefinition(raw);
  if (!base.valid || base.summary === null) return base;
  if (typeof raw !== "object" || raw === null) return base;

  const r = raw as Record<string, unknown>;
  const nodeIds = new Set<string>((base.summary.node_ids as string[]) ?? []);
  const outCount = new Map<string, number>();
  const inCount = new Map<string, number>();
  for (const n of nodeIds) {
    outCount.set(n, 0);
    inCount.set(n, 0);
  }

  for (const [s, t] of normalizedEdges(r)) {
    if (nodeIds.has(s) && nodeIds.has(t)) {
      outCount.set(s, (outCount.get(s) ?? 0) + 1);
      inCount.set(t, (inCount.get(t) ?? 0) + 1);
    }
  }

  for (const [nid, deg] of outCount) {
    if (deg > maxBranching) {
      return {
        valid: false,
        errors: [
          issue(
            "TOO_MANY_BRANCHES",
            `Node '${nid}' exceeds max branching (${deg} > ${maxBranching})`,
            `nodes[${nid}]`,
          ),
        ],
        warnings: base.warnings,
        summary: base.summary,
      };
    }
  }

  for (const [nid, deg] of inCount) {
    if (deg > maxFanin) {
      return {
        valid: false,
        errors: [
          issue(
            "TOO_MANY_FANIN",
            `Node '${nid}' exceeds max fan-in (${deg} > ${maxFanin})`,
            `nodes[${nid}]`,
          ),
        ],
        warnings: base.warnings,
        summary: base.summary,
      };
    }
  }

  const order = topoOrder(r, base.summary);
  if (order === null) {
    return {
      valid: false,
      errors: [
        issue(
          "INVALID_TOPOLOGY",
          "Could not derive deterministic topological order",
          "edges",
        ),
      ],
      warnings: base.warnings,
      summary: base.summary,
    };
  }

  return {
    valid: true,
    errors: [],
    warnings: base.warnings,
    summary: {
      ...base.summary,
      execution_order: order,
      max_branching: maxBranching,
      max_fanin: maxFanin,
    },
  };
}
