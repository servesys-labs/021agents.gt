/**
 * Workflow DAG validator tests.
 */
import { describe, it, expect } from "vitest";
import { validateWorkflow } from "../src/logic/workflow-validator";

describe("validateWorkflow", () => {
  it("accepts a valid linear workflow", () => {
    const steps = [
      { id: "s1", type: "llm", depends_on: [] },
      { id: "s2", type: "tool", depends_on: ["s1"] },
      { id: "s3", type: "finalize", depends_on: ["s2"] },
    ];
    const result = validateWorkflow(steps as any);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("detects cycle in workflow", () => {
    const steps = [
      { id: "s1", type: "llm", depends_on: ["s2"] },
      { id: "s2", type: "tool", depends_on: ["s1"] },
    ];
    const result = validateWorkflow(steps as any);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("detects missing dependency reference", () => {
    const steps = [
      { id: "s1", type: "llm", depends_on: ["nonexistent"] },
    ];
    const result = validateWorkflow(steps as any);
    expect(result.valid).toBe(false);
  });

  it("accepts parallel branches with join", () => {
    const steps = [
      { id: "start", type: "llm", depends_on: [] },
      { id: "branch_a", type: "tool", depends_on: ["start"] },
      { id: "branch_b", type: "tool", depends_on: ["start"] },
      { id: "join", type: "join", depends_on: ["branch_a", "branch_b"] },
    ];
    const result = validateWorkflow(steps as any);
    expect(result.valid).toBe(true);
  });
});
