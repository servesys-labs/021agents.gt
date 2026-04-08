/**
 * Mermaid integration for graph visualization in the portal.
 * 
 * This module connects the runtime's graph visualization generators
 * with the portal's UI components.
 */

import type { GraphSpec } from "~/lib/runtime-types";

// Note: We import these from the runtime via the API
// to avoid bundling runtime code into the frontend

export interface MermaidDiagramOptions {
  direction?: "TD" | "LR" | "BT" | "RL";
  theme?: "default" | "dark" | "forest" | "neutral";
  showLabels?: boolean;
  highlightPath?: string[];
  compact?: boolean;
}

/**
 * Generate Mermaid diagram syntax for a graph spec.
 * This runs client-side to avoid API round-trips for visualization.
 */
export function generateMermaidDiagram(
  graph: GraphSpec,
  options: MermaidDiagramOptions = {}
): string {
  const {
    direction = "TD",
    showLabels = true,
    highlightPath = [],
    compact = false,
  } = options;

  const lines: string[] = [];
  
  // Add flowchart definition
  lines.push(`flowchart ${direction}`);
  
  // Track highlighted edges for styling
  const highlightSet = new Set(
    highlightPath.slice(0, -1).map((node, i) => `${node}→${highlightPath[i + 1]}`)
  );
  
  // Style definitions for node types
  const nodeStyles: string[] = [];
  const typeColors: Record<string, string> = {
    llm: "#e1f5fe",
    agent: "#fff3e0",
    tool: "#f3e5f5",
    condition: "#e8f5e9",
    loop: "#fffde7",
    subgraph: "#fce4ec",
  };
  
  // Generate nodes
  for (const node of graph.nodes) {
    const nodeId = sanitizeNodeId(node.id);
    const type = node.type || "unknown";
    const label = compact ? node.id : formatNodeLabel(node);
    
    // Different shapes based on node type
    switch (type) {
      case "llm":
        lines.push(`    ${nodeId}["${label}"]`);
        break;
      case "tool":
        lines.push(`    ${nodeId}(["${label}"])`);
        break;
      case "condition":
        lines.push(`    ${nodeId}{"${label}"}`);
        break;
      case "loop":
        lines.push(`    ${nodeId}[["${label}"]]`);
        break;
      case "subgraph":
        lines.push(`    ${nodeId}[("${label}")]`);
        break;
      default:
        lines.push(`    ${nodeId}["${label}"]`);
    }
    
    // Apply styling
    const color = typeColors[type] || "#f5f5f5";
    const isHighlighted = highlightPath.includes(node.id);
    const strokeColor = isHighlighted ? "#ff6b6b" : "#333";
    const strokeWidth = isHighlighted ? "3px" : "1px";
    
    nodeStyles.push(
      `    style ${nodeId} fill:${color},stroke:${strokeColor},stroke-width:${strokeWidth}`
    );
  }
  
  // Add styles
  lines.push(...nodeStyles);
  
  // Generate edges
  for (const edge of graph.edges) {
    const sourceId = sanitizeNodeId(edge.source);
    const targetId = sanitizeNodeId(edge.target);
    const edgeKey = `${edge.source}→${edge.target}`;
    const isHighlighted = highlightSet.has(edgeKey);
    
    if (showLabels && edge.label) {
      lines.push(`    ${sourceId} -->|"${edge.label}"| ${targetId}`);
    } else {
      lines.push(`    ${sourceId} --> ${targetId}`);
    }
    
    // Apply edge styling
    if (isHighlighted) {
      lines.push(`    linkStyle ${lines.length - 2} stroke:#ff6b6b,stroke-width:3px`);
    }
  }
  
  // Add subgraphs if present
  if (graph.subgraphs) {
    for (const subgraph of graph.subgraphs) {
      lines.push(`    subgraph ${subgraph.name}["${subgraph.label || subgraph.name}"]`);
      for (const nodeId of subgraph.nodes) {
        lines.push(`        ${sanitizeNodeId(nodeId)}`);
      }
      lines.push(`    end`);
    }
  }
  
  return lines.join("\n");
}

/**
 * Generate a simplified diagram for compact display.
 */
export function generateCompactDiagram(graph: GraphSpec): string {
  return generateMermaidDiagram(graph, { compact: true });
}

/**
 * Generate diagram with execution path highlighted.
 */
export function generateDiagramWithPath(
  graph: GraphSpec,
  path: string[]
): string {
  return generateMermaidDiagram(graph, {
    highlightPath: path,
    showLabels: true,
  });
}

/**
 * Validate that a diagram can be rendered.
 */
export function validateMermaidDiagram(diagram: string): {
  valid: boolean;
  error?: string;
} {
  // Basic validation
  if (!diagram.trim().startsWith("flowchart")) {
    return { valid: false, error: "Diagram must start with 'flowchart'" };
  }
  
  // Check for invalid characters in node IDs
  const nodeIdPattern = /^[a-zA-Z0-9_\-@#$]+$/;
  const lines = diagram.split("\n");
  
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("flowchart")) continue;
    
    // Extract node IDs from definitions
    const match = trimmed.match(/^([a-zA-Z0-9_\-@#$]+)\[/);
    if (match && !nodeIdPattern.test(match[1])) {
      return { valid: false, error: `Invalid node ID: ${match[1]}` };
    }
  }
  
  return { valid: true };
}

/**
 * Export diagram to various formats.
 */
export function exportDiagram(diagram: string, format: "svg" | "png" | "md"): string {
  switch (format) {
    case "svg":
      // Return as-is, Mermaid renders to SVG
      return diagram;
    
    case "md":
      return "```mermaid\n" + diagram + "\n```";
    
    case "png":
      // PNG requires server-side rendering
      throw new Error("PNG export requires server-side rendering");
    
    default:
      throw new Error(`Unsupported format: ${format}`);
  }
}

// --- Helpers ---

function sanitizeNodeId(id: string): string {
  // Replace invalid Mermaid characters
  return id.replace(/[^a-zA-Z0-9_\-@#$]/g, "_");
}

function formatNodeLabel(node: GraphSpec["nodes"][0]): string {
  const parts: string[] = [];
  
  if (node.type) {
    parts.push(`<b>${node.type.toUpperCase()}</b>`);
  }
  
  parts.push(node.id);
  
  if (node.config?.model) {
    parts.push(`<small>${node.config.model}</small>`);
  }
  
  return parts.join("<br/>");
}

/**
 * React hook for Mermaid integration.
 * Usage: const { diagram, error } = useMermaidDiagram(graphSpec);
 */
export function useMermaidDiagram(
  graph: GraphSpec | null,
  options?: MermaidDiagramOptions
): { diagram: string | null; error: string | null } {
  if (!graph) {
    return { diagram: null, error: null };
  }
  
  try {
    const diagram = generateMermaidDiagram(graph, options);
    const validation = validateMermaidDiagram(diagram);
    
    if (!validation.valid) {
      return { diagram: null, error: validation.error || "Invalid diagram" };
    }
    
    return { diagram, error: null };
  } catch (err) {
    return {
      diagram: null,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}
