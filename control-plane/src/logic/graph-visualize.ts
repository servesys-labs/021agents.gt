/**
 * Graph visualization — convert declarative graphs to Mermaid, DOT, or SVG.
 * 
 * Supports:
 * - Mermaid (for portal rendering)
 * - DOT (for Graphviz)
 * - SVG (via simple edge bundling)
 */

export type VizFormat = "mermaid" | "dot" | "svg";

interface GraphNode {
  id: string;
  kind?: string;
  type?: string;
  label?: string;
  config?: Record<string, unknown>;
}

interface GraphEdge {
  source: string;
  target: string;
  label?: string;
  condition?: string;
}

interface GraphSpec {
  nodes: GraphNode[];
  edges: Array<Record<string, unknown>>;
}

interface VizOptions {
  direction?: "TB" | "LR" | "BT" | "RL"; // Top-Bottom, Left-Right, etc.
  showConfig?: boolean;
  highlightPath?: string[]; // Node IDs to highlight
  theme?: "default" | "dark";
}

// ── Mermaid ─────────────────────────────────────────────────────────

function toMermaid(graph: GraphSpec, opts: VizOptions = {}): string {
  const { direction = "TB", showConfig = false, highlightPath = [] } = opts;
  const highlightSet = new Set(highlightPath);
  
  const nodeMap = new Map<string, GraphNode>();
  for (const n of graph.nodes) {
    nodeMap.set(n.id, n);
  }
  
  const lines: string[] = [];
  lines.push(`flowchart ${direction}`);
  lines.push("");
  
  // Define nodes with styling
  for (const node of graph.nodes) {
    const kind = node.kind || node.type || "unknown";
    const label = node.label || node.id;
    const isHighlighted = highlightSet.has(node.id);
    
    // Node shape based on kind
    let shapeStart = "[";
    let shapeEnd = "]";
    
    if (kind.includes("start") || kind.includes("bootstrap")) {
      shapeStart = "((";
      shapeEnd = "))";
    } else if (kind.includes("final") || kind.includes("answer")) {
      shapeStart = "([";
      shapeEnd = "])";
    } else if (kind.includes("tools")) {
      shapeStart = "{";
      shapeEnd = "}";
    } else if (kind.includes("decision") || kind.includes("route")) {
      shapeStart = "{";
      shapeEnd = "}";
    }
    
    const displayLabel = showConfig && node.config 
      ? `${label}<br/><small>${JSON.stringify(node.config).slice(0, 50)}...</small>`
      : label;
    
    lines.push(`    ${node.id}${shapeStart}"${displayLabel}"${shapeEnd}`);
    
    // Apply styling for highlighted nodes
    if (isHighlighted) {
      lines.push(`    style ${node.id} fill:#e1f5fe,stroke:#01579b,stroke-width:3px`);
    } else if (kind.includes("error")) {
      lines.push(`    style ${node.id} fill:#ffebee,stroke:#c62828`);
    } else if (kind.includes("final")) {
      lines.push(`    style ${node.id} fill:#e8f5e9,stroke:#2e7d32`);
    }
  }
  
  lines.push("");
  
  // Define edges
  for (const edge of normalizeEdges(graph.edges)) {
    const sourceExists = nodeMap.has(edge.source);
    const targetExists = nodeMap.has(edge.target);
    
    if (!sourceExists || !targetExists) continue;
    
    let edgeStr = `    ${edge.source} --> ${edge.target}`;
    
    if (edge.label) {
      edgeStr = `    ${edge.source} -->|"${edge.label}"| ${edge.target}`;
    } else if (edge.condition) {
      edgeStr = `    ${edge.source} -->|"${edge.condition}"| ${edge.target}`;
    }
    
    // Highlight edges on the path
    if (highlightSet.has(edge.source) && highlightSet.has(edge.target)) {
      lines.push(`${edgeStr}:::highlight`);
    } else {
      lines.push(edgeStr);
    }
  }
  
  // Add highlight class definition
  if (highlightPath.length > 0) {
    lines.push("");
    lines.push("    classDef highlight stroke:#01579b,stroke-width:3px");
  }
  
  return lines.join("\n");
}

// ── DOT (Graphviz) ───────────────────────────────────────────────────

function toDOT(graph: GraphSpec, opts: VizOptions = {}): string {
  const { direction = "TB", showConfig = false, highlightPath = [], theme = "default" } = opts;
  const highlightSet = new Set(highlightPath);
  
  const isDark = theme === "dark";
  const bgColor = isDark ? "#1a1a2e" : "#ffffff";
  const textColor = isDark ? "#e4e4e7" : "#1f2937";
  const edgeColor = isDark ? "#4b5563" : "#9ca3af";
  
  const lines: string[] = [];
  lines.push("digraph AgentGraph {");
  lines.push(`    bgcolor="${bgColor}";`);
  lines.push(`    fontcolor="${textColor}";`);
  lines.push(`    rankdir=${direction === "LR" ? "LR" : direction === "RL" ? "RL" : direction === "BT" ? "BT" : "TB"};`);
  lines.push("    node [shape=box, style=\"rounded,filled\", fontname=\"system-ui, sans-serif\"];");
  lines.push("    edge [fontname=\"system-ui, sans-serif\"];");
  lines.push("");
  
  // Define nodes
  for (const node of graph.nodes) {
    const kind = node.kind || node.type || "unknown";
    const label = node.label || node.id;
    const isHighlighted = highlightSet.has(node.id);
    
    // Color scheme
    let fillColor = isDark ? "#374151" : "#f3f4f6";
    let strokeColor = isDark ? "#6b7280" : "#d1d5db";
    
    if (isHighlighted) {
      fillColor = "#dbeafe";
      strokeColor = "#2563eb";
    } else if (kind.includes("start") || kind.includes("bootstrap")) {
      fillColor = isDark ? "#064e3b" : "#d1fae5";
      strokeColor = "#059669";
    } else if (kind.includes("final") || kind.includes("answer")) {
      fillColor = isDark ? "#14532d" : "#dcfce7";
      strokeColor = "#16a34a";
    } else if (kind.includes("tools")) {
      fillColor = isDark ? "#7c2d12" : "#ffedd5";
      strokeColor = "#ea580c";
    } else if (kind.includes("decision") || kind.includes("route")) {
      fillColor = isDark ? "#581c87" : "#f3e8ff";
      strokeColor = "#9333ea";
      lines.push(`    ${node.id} [shape=diamond, fillcolor="${fillColor}", color="${strokeColor}", label="${label}"];`);
      continue;
    } else if (kind.includes("error")) {
      fillColor = isDark ? "#7f1d1d" : "#fee2e2";
      strokeColor = "#dc2626";
    }
    
    const shape = kind.includes("start") ? "ellipse" : "box";
    const displayLabel = showConfig && node.config 
      ? `${label}\\n${JSON.stringify(node.config).slice(0, 40)}...`
      : label;
    
    lines.push(`    ${node.id} [shape=${shape}, fillcolor="${fillColor}", color="${strokeColor}", fontcolor="${textColor}", label="${displayLabel}"];`);
  }
  
  lines.push("");
  
  // Define edges
  for (const edge of normalizeEdges(graph.edges)) {
    let attrs = `color="${edgeColor}", fontcolor="${textColor}"`;
    
    if (highlightSet.has(edge.source) && highlightSet.has(edge.target)) {
      attrs = `color="#2563eb", penwidth=2`;
    }
    
    if (edge.label) {
      lines.push(`    ${edge.source} -> ${edge.target} [${attrs}, label="${edge.label}"];`);
    } else if (edge.condition) {
      lines.push(`    ${edge.source} -> ${edge.target} [${attrs}, label="${edge.condition}"];`);
    } else {
      lines.push(`    ${edge.source} -> ${edge.target} [${attrs}];`);
    }
  }
  
  lines.push("}");
  
  return lines.join("\n");
}

// ── Simple SVG (server-side) ────────────────────────────────────────

function toSVG(graph: GraphSpec, opts: VizOptions = {}): string {
  const { direction = "TB", highlightPath = [], theme = "default" } = opts;
  const isDark = theme === "dark";
  const highlightSet = new Set(highlightPath);
  
  // Simple grid layout
  const nodeMap = new Map<string, { x: number; y: number; node: GraphNode }>();
  const levels: string[][] = [[]];
  
  // BFS to assign levels
  const edges = normalizeEdges(graph.edges);
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();
  
  for (const n of graph.nodes) {
    inDegree.set(n.id, 0);
    adj.set(n.id, []);
  }
  
  for (const e of edges) {
    inDegree.set(e.target, (inDegree.get(e.target) || 0) + 1);
    adj.get(e.source)?.push(e.target);
  }
  
  // Topological sort with level assignment
  const queue: string[] = [];
  for (const [id, deg] of inDegree.entries()) {
    if (deg === 0) queue.push(id);
  }
  
  while (queue.length > 0) {
    const id = queue.shift()!;
    const level = levels.findIndex(l => l.includes(id)) !== -1 
      ? levels.findIndex(l => l.includes(id))
      : levels.length - 1;
    
    if (!levels[level]) levels[level] = [];
    if (!levels[level].includes(id)) levels[level].push(id);
    
    for (const next of adj.get(id) || []) {
      const nextDegree = inDegree.get(next)! - 1;
      inDegree.set(next, nextDegree);
      
      if (nextDegree === 0) {
        if (!levels[level + 1]) levels[level + 1] = [];
        levels[level + 1].push(next);
        queue.push(next);
      }
    }
  }
  
  // Position nodes
  const nodeWidth = 140;
  const nodeHeight = 50;
  const levelGap = direction === "LR" || direction === "RL" ? 200 : 100;
  const nodeGap = direction === "LR" || direction === "RL" ? 80 : 180;
  
  const isHorizontal = direction === "LR" || direction === "RL";
  const reverse = direction === "BT" || direction === "RL";
  
  levels.forEach((level, i) => {
    const levelIndex = reverse ? levels.length - 1 - i : i;
    level.forEach((id, j) => {
      const node = graph.nodes.find(n => n.id === id)!;
      const offset = (level.length - 1) * nodeGap / 2;
      
      if (isHorizontal) {
        nodeMap.set(id, {
          x: levelIndex * levelGap + 50,
          y: j * nodeGap + 50 - offset + 200,
          node
        });
      } else {
        nodeMap.set(id, {
          x: j * nodeGap + 100 - offset + 200,
          y: levelIndex * levelGap + 50,
          node
        });
      }
    });
  });
  
  // Calculate SVG bounds
  const maxX = Math.max(...Array.from(nodeMap.values()).map(n => n.x)) + nodeWidth + 50;
  const maxY = Math.max(...Array.from(nodeMap.values()).map(n => n.y)) + nodeHeight + 50;
  
  const bgColor = isDark ? "#1a1a2e" : "#ffffff";
  const textColor = isDark ? "#e4e4e7" : "#1f2937";
  
  const svgLines: string[] = [];
  svgLines.push(`<svg width="${maxX}" height="${maxY}" xmlns="http://www.w3.org/2000/svg">`);
  svgLines.push(`  <rect width="100%" height="100%" fill="${bgColor}"/>`);
  
  // Draw edges first (behind nodes)
  for (const edge of edges) {
    const source = nodeMap.get(edge.source);
    const target = nodeMap.get(edge.target);
    if (!source || !target) continue;
    
    const x1 = source.x + nodeWidth / 2;
    const y1 = source.y + nodeHeight / 2;
    const x2 = target.x + nodeWidth / 2;
    const y2 = target.y + nodeHeight / 2;
    
    const isHighlighted = highlightSet.has(edge.source) && highlightSet.has(edge.target);
    const stroke = isHighlighted ? "#2563eb" : isDark ? "#4b5563" : "#9ca3af";
    const strokeWidth = isHighlighted ? 3 : 1.5;
    
    // Arrow marker
    svgLines.push(`  <defs>`);
    svgLines.push(`    <marker id="arrow-${edge.source}-${edge.target}" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto" markerUnits="strokeWidth">`);
    svgLines.push(`      <path d="M0,0 L0,6 L9,3 z" fill="${stroke}"/>`);
    svgLines.push(`    </marker>`);
    svgLines.push(`  </defs>`);
    
    svgLines.push(`  <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="${strokeWidth}" marker-end="url(#arrow-${edge.source}-${edge.target})"/>`);
    
    if (edge.label) {
      const mx = (x1 + x2) / 2;
      const my = (y1 + y2) / 2;
      svgLines.push(`  <text x="${mx}" y="${my - 5}" text-anchor="middle" fill="${textColor}" font-size="10" font-family="system-ui, sans-serif">${edge.label}</text>`);
    }
  }
  
  // Draw nodes
  for (const [id, pos] of nodeMap) {
    const isHighlighted = highlightSet.has(id);
    const kind = pos.node.kind || pos.node.type || "unknown";
    
    let fill = isDark ? "#374151" : "#f3f4f6";
    let stroke = isDark ? "#6b7280" : "#d1d5db";
    
    if (isHighlighted) {
      fill = "#dbeafe";
      stroke = "#2563eb";
    } else if (kind.includes("start")) {
      fill = isDark ? "#064e3b" : "#d1fae5";
      stroke = "#059669";
    } else if (kind.includes("final")) {
      fill = isDark ? "#14532d" : "#dcfce7";
      stroke = "#16a34a";
    } else if (kind.includes("tools")) {
      fill = isDark ? "#7c2d12" : "#ffedd5";
      stroke = "#ea580c";
    }
    
    const rx = kind.includes("start") || kind.includes("final") ? nodeHeight / 2 : 6;
    
    svgLines.push(`  <rect x="${pos.x}" y="${pos.y}" width="${nodeWidth}" height="${nodeHeight}" rx="${rx}" fill="${fill}" stroke="${stroke}" stroke-width="${isHighlighted ? 3 : 1.5}"/>`);
    
    // Label
    const label = pos.node.label || id;
    const shortLabel = label.length > 15 ? label.slice(0, 12) + "..." : label;
    svgLines.push(`  <text x="${pos.x + nodeWidth / 2}" y="${pos.y + nodeHeight / 2 + 4}" text-anchor="middle" fill="${textColor}" font-size="11" font-weight="500" font-family="system-ui, sans-serif">${shortLabel}</text>`);
    
    // Kind badge
    const shortKind = kind.length > 8 ? kind.slice(0, 6) + "..." : kind;
    svgLines.push(`  <text x="${pos.x + nodeWidth / 2}" y="${pos.y + nodeHeight - 6}" text-anchor="middle" fill="${isDark ? "#9ca3af" : "#6b7280"}" font-size="8" font-family="system-ui, sans-serif">${shortKind}</text>`);
  }
  
  svgLines.push("</svg>");
  
  return svgLines.join("\n");
}

// ── Helpers ─────────────────────────────────────────────────────────

function normalizeEdges(raw: Array<Record<string, unknown>>): GraphEdge[] {
  const edges: GraphEdge[] = [];
  for (const e of raw) {
    const source = String((e.source ?? e.from) || "");
    const target = String((e.target ?? e.to) || "");
    if (source && target) {
      edges.push({
        source,
        target,
        label: e.label ? String(e.label) : undefined,
        condition: e.condition ? String(e.condition) : undefined,
      });
    }
  }
  return edges;
}

// ── Main Export ─────────────────────────────────────────────────────

export function visualizeGraph(
  graph: GraphSpec,
  format: VizFormat,
  opts: VizOptions = {}
): { content: string; contentType: string } {
  switch (format) {
    case "mermaid":
      return {
        content: toMermaid(graph, opts),
        contentType: "text/plain",
      };
    case "dot":
      return {
        content: toDOT(graph, opts),
        contentType: "text/vnd.graphviz",
      };
    case "svg":
      return {
        content: toSVG(graph, opts),
        contentType: "image/svg+xml",
      };
    default:
      throw new Error(`Unsupported format: ${format}`);
  }
}

/**
 * Compute a highlighted path through the graph given a sequence of executed node IDs.
 */
export function computeHighlightPath(graph: GraphSpec, executedNodes: string[]): string[] {
  const nodeSet = new Set(graph.nodes.map(n => n.id));
  return executedNodes.filter(id => nodeSet.has(id));
}
