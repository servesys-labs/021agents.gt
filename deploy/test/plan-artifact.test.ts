import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  extractPlanningArtifact,
  requiresPlanningArtifact,
  validatePlanningArtifact,
} from "../src/runtime/plan-artifact";

const WORKFLOW_PATH = path.resolve(__dirname, "../src/workflow.ts");
const INDEX_PATH = path.resolve(__dirname, "../src/index.ts");

function readSource(p: string): string {
  return fs.readFileSync(p, "utf-8");
}

describe("plan artifact helpers", () => {
  it("extracts a fenced json plan artifact from mixed markdown", () => {
    const artifact = extractPlanningArtifact(`
## Plan
1. Inspect the repo
2. Implement the change

\`\`\`json
{
  "schema_version": "plan.v1",
  "goal": "Ship Phase 4 cleanly.",
  "steps": [
    { "id": "1", "title": "Add validator", "acceptance": "Validator passes unit tests." }
  ],
  "assumptions": ["The workflow can re-prompt before tools run."],
  "alternatives": [
    { "option": "Prompt-only contract", "rationale": "Rejected because it is not enforceable." }
  ],
  "tradeoffs": ["Adds one extra turn before execution on complex tasks."]
}
\`\`\`
    `);
    expect(artifact).not.toBeNull();
    expect(artifact?.schema_version).toBe("plan.v1");
  });

  it("accepts a valid plan.v1 artifact", () => {
    const result = validatePlanningArtifact({
      schema_version: "plan.v1",
      goal: "Ship Phase 4 cleanly.",
      steps: [
        { id: "1", title: "Add validator", acceptance: "Validator passes unit tests." },
      ],
      assumptions: ["The workflow can re-prompt before tools run."],
      alternatives: [
        { option: "Prompt-only contract", rationale: "Rejected because it is not enforceable." },
      ],
      tradeoffs: ["Adds one extra turn before execution on complex tasks."],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.artifact.steps[0].title).toBe("Add validator");
    }
  });

  it("rejects missing artifacts", () => {
    expect(validatePlanningArtifact(null)).toEqual({
      ok: false,
      reason: "planning_artifact_missing",
    });
  });

  it("rejects invalid artifacts", () => {
    expect(validatePlanningArtifact({
      schema_version: "plan.v1",
      goal: "Missing the structured fields",
      steps: [],
      assumptions: [],
      alternatives: [],
      tradeoffs: [],
    })).toEqual({
      ok: false,
      reason: "planning_artifact_invalid",
    });
  });

  it("requires a planning artifact for complex routed tasks", () => {
    expect(requiresPlanningArtifact(
      { complexity: "complex", category: "coding", role: "implementer" },
      "Fix the runtime and update the control-plane",
    )).toBe(true);
  });

  it("requires a planning artifact for planner and build/deploy tasks", () => {
    expect(requiresPlanningArtifact(
      { complexity: "moderate", category: "coding", role: "planner" },
      "Plan a safe refactor",
    )).toBe(true);
    expect(requiresPlanningArtifact(
      { complexity: "moderate", category: "general", role: "moderate" },
      "Build and deploy a new service",
    )).toBe(true);
  });

  it("does not require a planning artifact for simple tasks", () => {
    expect(requiresPlanningArtifact(
      { complexity: "simple", category: "general", role: "simple" },
      "What time is it?",
    )).toBe(false);
  });
});

describe("workflow planning artifact gate", () => {
  it("blocks tool execution until a valid artifact exists", () => {
    const source = readSource(WORKFLOW_PATH);
    const toolGateBlock = source.match(
      /const executableCalls = llm\.tool_calls\.filter[\s\S]*?Planning contract: before executing tools for this task[\s\S]*?transitionPhase\("executing"\)/,
    );
    expect(toolGateBlock).not.toBeNull();
    expect(toolGateBlock![0]).toContain("planningArtifactRequired");
    expect(toolGateBlock![0]).toContain("validatedPlanningArtifact");
    expect(toolGateBlock![0]).toContain("planning_artifact_reason");
  });

  it("requires a valid artifact before plan-only completion", () => {
    const source = readSource(WORKFLOW_PATH);
    const finalGateBlock = source.match(
      /if \(llm\.tool_calls\.length === 0\)[\s\S]*?Planning contract: for this complex plan-first task[\s\S]*?const completionGate/,
    );
    expect(finalGateBlock).not.toBeNull();
    expect(finalGateBlock![0]).toContain("planOnlyRequested");
    expect(finalGateBlock![0]).toContain("planning_artifact_exhausted");
  });

  it("includes plan_artifact in queued turn payloads", () => {
    const source = readSource(WORKFLOW_PATH);
    const queueSection = source.match(
      /type: "turn"[\s\S]*?plan_artifact: turnData\.plan_artifact \|\| \{\}/,
    );
    expect(queueSection).not.toBeNull();
  });
});

describe("queue consumer persistence", () => {
  it("writes the canonical plan_artifact column with legacy fallback", () => {
    const source = readSource(INDEX_PATH);
    const turnInsert = source.match(
      /else if \(type === "turn"\)[\s\S]*?ON CONFLICT/,
    );
    expect(turnInsert).not.toBeNull();
    expect(turnInsert![0]).toContain("execution_mode, plan_artifact, reflection");
    expect(turnInsert![0]).toContain("jp(p.plan_artifact || p.plan, {})");
  });
});
