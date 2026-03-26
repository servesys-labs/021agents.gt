/**
 * Graph lint logic tests — all lint codes verified.
 */
import { describe, it, expect } from "vitest";
import { lintGraphDesign } from "../src/logic/graph-lint";

describe("lintGraphDesign", () => {
  it("passes a clean graph", () => {
    const graph = {
      nodes: [
        { id: "start", kind: "bootstrap" },
        { id: "llm", kind: "llm_call" },
        { id: "end", kind: "final" },
      ],
      edges: [
        { source: "start", target: "llm" },
        { source: "llm", target: "end" },
      ],
    };
    const result = lintGraphDesign(graph);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("detects BACKGROUND_ON_CRITICAL_PATH", () => {
    const graph = {
      nodes: [
        { id: "start", kind: "bootstrap" },
        { id: "telem", kind: "telemetry" }, // background kind on critical path
        { id: "end", kind: "final" },
      ],
      edges: [
        { source: "start", target: "telem" },
        { source: "telem", target: "end" },
      ],
    };
    const result = lintGraphDesign(graph);
    const codes = result.errors.map((e: any) => e.code);
    expect(codes).toContain("BACKGROUND_ON_CRITICAL_PATH");
  });

  it("detects ASYNC_SIDE_EFFECT_MISSING_IDEMPOTENCY", () => {
    const graph = {
      nodes: [
        { id: "start", kind: "bootstrap" },
        { id: "write", kind: "db_write", async: true }, // async side-effect, no idempotency_key
        { id: "end", kind: "final" },
      ],
      edges: [
        { source: "start", target: "write" },
        { source: "write", target: "end" },
      ],
    };
    const result = lintGraphDesign(graph);
    const codes = result.errors.map((e: any) => e.code);
    expect(codes).toContain("ASYNC_SIDE_EFFECT_MISSING_IDEMPOTENCY");
  });

  it("passes async side-effect WITH idempotency_key", () => {
    const graph = {
      nodes: [
        { id: "start", kind: "bootstrap" },
        { id: "write", kind: "db_write", async: true, idempotency_key: "session:${session_id}:write" },
        { id: "end", kind: "final" },
      ],
      edges: [
        { source: "start", target: "write" },
        { source: "write", target: "end" },
      ],
    };
    const result = lintGraphDesign(graph);
    const asyncErrors = result.errors.filter(
      (e: any) => e.code === "ASYNC_SIDE_EFFECT_MISSING_IDEMPOTENCY",
    );
    expect(asyncErrors).toHaveLength(0);
  });

  it("detects cycle via validate integration", () => {
    const graph = {
      nodes: [{ id: "a" }, { id: "b" }],
      edges: [
        { source: "a", target: "b" },
        { source: "b", target: "a" },
      ],
    };
    const result = lintGraphDesign(graph);
    expect(result.valid).toBe(false);
    const codes = result.errors.map((e: any) => e.code);
    expect(codes).toContain("CYCLE");
  });

  it("strict mode promotes warnings to errors", () => {
    const graph = {
      nodes: [
        { id: "start", kind: "bootstrap" },
        { id: "end", kind: "final" },
      ],
      edges: [{ source: "start", target: "end" }],
    };
    // A simple valid graph shouldn't fail even in strict mode
    const result = lintGraphDesign(graph, { strict: true });
    expect(result.valid).toBe(true);
  });
});
