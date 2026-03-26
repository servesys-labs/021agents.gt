/**
 * Graph autofix tests — verifies deterministic transformations.
 */
import { describe, it, expect } from "vitest";
import { lintAndAutofixGraph } from "../src/logic/graph-autofix";

describe("lintAndAutofixGraph", () => {
  it("injects missing idempotency keys on async side-effects", () => {
    const graph = {
      nodes: [
        { id: "start", kind: "bootstrap" },
        { id: "write", kind: "db_write", async: true },
        { id: "end", kind: "final" },
      ],
      edges: [
        { source: "start", target: "write" },
        { source: "write", target: "end" },
      ],
    };

    const result = lintAndAutofixGraph(graph, { strict: false, apply: true });
    expect(result.autofix_applied).toBe(true);
    expect((result.applied_fixes as any[]).length).toBeGreaterThan(0);

    // The fixed graph should have idempotency_key on the write node
    const writeNode = ((result.graph as any).nodes as any[]).find((n: any) => n.id === "write");
    expect(writeNode.idempotency_key).toBeDefined();
    expect(writeNode.idempotency_key).toContain("write");
  });

  it("returns no fixes for a clean graph", () => {
    const graph = {
      nodes: [
        { id: "start", kind: "bootstrap" },
        { id: "end", kind: "final" },
      ],
      edges: [{ source: "start", target: "end" }],
    };

    const result = lintAndAutofixGraph(graph, { strict: false });
    expect((result.applied_fixes as any[])).toHaveLength(0);
  });

  it("includes lint_before and lint_after", () => {
    const graph = {
      nodes: [
        { id: "start", kind: "bootstrap" },
        { id: "write", kind: "db_write", async: true },
        { id: "end", kind: "final" },
      ],
      edges: [
        { source: "start", target: "write" },
        { source: "write", target: "end" },
      ],
    };

    const result = lintAndAutofixGraph(graph, { strict: false, apply: true });
    expect(result.lint_before).toBeDefined();
    expect(result.lint_after).toBeDefined();
  });
});
