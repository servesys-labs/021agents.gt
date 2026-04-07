import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const WORKFLOW_PATH = path.resolve(__dirname, "../src/workflow.ts");

function loadWorkflowSource(): string {
  return fs.readFileSync(WORKFLOW_PATH, "utf-8");
}

describe("workflow orchestration", () => {
  it("preserves the critical step order", () => {
    const source = loadWorkflowSource();
    const idxBootstrap = source.indexOf('step.do("bootstrap"');
    const idxHydrate = source.indexOf('step.do("hydrate-workspace"');
    const idxLlm = source.indexOf("step.do(`llm-${turn}`");
    const idxFinalize = source.indexOf('step.do("finalize"');
    const idxTelemetry = source.indexOf('step.do("write-telemetry"');
    const idxCleanup = source.indexOf('step.do("session-cleanup"');

    expect(idxBootstrap).toBeGreaterThan(-1);
    expect(idxHydrate).toBeGreaterThan(idxBootstrap);
    expect(idxLlm).toBeGreaterThan(idxHydrate);
    expect(idxFinalize).toBeGreaterThan(idxLlm);
    expect(idxTelemetry).toBeGreaterThan(idxFinalize);
    expect(idxCleanup).toBeGreaterThan(idxTelemetry);
  });

  it("executes tools between llm and final answer", () => {
    const source = loadWorkflowSource();
    expect(source).toContain('await memo("tools", () => import("./runtime/tools"))');
    expect(source).toContain("const results = await executeTools(");
    expect(source).toContain("tool_results:");
    expect(source).toContain("type: \"done\"");
  });

  it("emits done event with session and trace metadata", () => {
    const source = loadWorkflowSource();
    const doneBlock = source.match(/type:\s*"done"[\s\S]*?session_id[\s\S]*?trace_id/s);
    expect(doneBlock).not.toBeNull();
  });
});
