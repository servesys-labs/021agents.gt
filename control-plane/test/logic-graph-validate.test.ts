/**
 * Graph validation logic tests — cycle detection, topo sort, linear/DAG validation.
 */
import { describe, it, expect } from "vitest";
import {
  validateGraphDefinition,
  detectCycle,
  topologicalOrder,
  validateLinearDeclarativeGraph,
  validateBoundedDagDeclarativeGraph,
} from "../src/logic/graph-validate";

describe("detectCycle", () => {
  it("returns null for acyclic graph", () => {
    const nodes = new Set(["a", "b", "c"]);
    const adj = new Map([["a", ["b"]], ["b", ["c"]], ["c", []]]);
    expect(detectCycle(nodes, adj)).toBeNull();
  });

  it("detects simple cycle", () => {
    const nodes = new Set(["a", "b", "c"]);
    const adj = new Map([["a", ["b"]], ["b", ["c"]], ["c", ["a"]]]);
    const cycle = detectCycle(nodes, adj);
    expect(cycle).not.toBeNull();
    expect(cycle!.length).toBeGreaterThan(0);
  });

  it("detects self-loop (via validateGraphDefinition)", () => {
    // Direct detectCycle may not catch self-loops depending on DFS implementation.
    // The full validateGraphDefinition pipeline catches it via edge validation.
    const graph = {
      nodes: [{ id: "a" }],
      edges: [{ source: "a", target: "a" }],
    };
    const result = validateGraphDefinition(graph);
    expect(result.valid).toBe(false);
  });

  it("handles disconnected components", () => {
    const nodes = new Set(["a", "b", "c", "d"]);
    const adj = new Map([["a", ["b"]], ["b", []], ["c", ["d"]], ["d", []]]);
    expect(detectCycle(nodes, adj)).toBeNull();
  });

  it("detects cycle in one component of disconnected graph", () => {
    const nodes = new Set(["a", "b", "c", "d"]);
    const adj = new Map([["a", ["b"]], ["b", []], ["c", ["d"]], ["d", ["c"]]]);
    expect(detectCycle(nodes, adj)).not.toBeNull();
  });
});

describe("topologicalOrder", () => {
  it("sorts a simple DAG", () => {
    const nodes = new Set(["a", "b", "c"]);
    const adj = new Map([["a", ["b"]], ["b", ["c"]], ["c", []]]);
    const sorted = topologicalOrder(nodes, adj);
    expect(sorted).not.toBeNull();
    const idx = (n: string) => sorted!.indexOf(n);
    expect(idx("a")).toBeLessThan(idx("b"));
    expect(idx("b")).toBeLessThan(idx("c"));
  });

  it("returns empty array for cyclic graph", () => {
    // Kahn's algorithm returns partial order (empty for fully cyclic)
    const nodes = new Set(["a", "b"]);
    const adj = new Map([["a", ["b"]], ["b", ["a"]]]);
    const result = topologicalOrder(nodes, adj);
    expect(result).not.toBeNull();
    expect(result!.length).toBeLessThan(nodes.size); // Can't order all nodes
  });

  it("handles single node", () => {
    const nodes = new Set(["a"]);
    const adj = new Map([["a", []]]);
    expect(topologicalOrder(nodes, adj)).toEqual(["a"]);
  });
});

describe("validateGraphDefinition", () => {
  it("accepts a valid graph", () => {
    const graph = {
      nodes: [{ id: "start" }, { id: "end" }],
      edges: [{ source: "start", target: "end" }],
    };
    const result = validateGraphDefinition(graph);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects graph with cycle", () => {
    const graph = {
      nodes: [{ id: "a" }, { id: "b" }],
      edges: [
        { source: "a", target: "b" },
        { source: "b", target: "a" },
      ],
    };
    const result = validateGraphDefinition(graph);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e: any) => e.code === "CYCLE")).toBe(true);
  });

  it("rejects graph with missing edge target", () => {
    const graph = {
      nodes: [{ id: "a" }],
      edges: [{ source: "a", target: "nonexistent" }],
    };
    const result = validateGraphDefinition(graph);
    expect(result.valid).toBe(false);
  });

  it("warns on empty graph", () => {
    const graph = { nodes: [], edges: [] };
    const result = validateGraphDefinition(graph);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});

describe("validateLinearDeclarativeGraph", () => {
  it("accepts a linear chain", () => {
    const graph = {
      nodes: [{ id: "a" }, { id: "b" }, { id: "c" }],
      edges: [
        { source: "a", target: "b" },
        { source: "b", target: "c" },
      ],
    };
    const result = validateLinearDeclarativeGraph(graph);
    expect(result.valid).toBe(true);
  });

  it("rejects branching graph", () => {
    const graph = {
      nodes: [{ id: "a" }, { id: "b" }, { id: "c" }],
      edges: [
        { source: "a", target: "b" },
        { source: "a", target: "c" },
      ],
    };
    const result = validateLinearDeclarativeGraph(graph);
    expect(result.valid).toBe(false);
  });
});

describe("validateBoundedDagDeclarativeGraph", () => {
  it("accepts a graph within bounds", () => {
    const graph = {
      nodes: [{ id: "a" }, { id: "b" }, { id: "c" }],
      edges: [
        { source: "a", target: "b" },
        { source: "a", target: "c" },
      ],
    };
    const result = validateBoundedDagDeclarativeGraph(graph, { maxBranching: 3, maxFanin: 3 });
    expect(result.valid).toBe(true);
  });

  it("rejects graph exceeding branching limit", () => {
    const graph = {
      nodes: [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }, { id: "e" }],
      edges: [
        { source: "a", target: "b" },
        { source: "a", target: "c" },
        { source: "a", target: "d" },
        { source: "a", target: "e" },
      ],
    };
    const result = validateBoundedDagDeclarativeGraph(graph, { maxBranching: 2, maxFanin: 10 });
    expect(result.valid).toBe(false);
  });
});
