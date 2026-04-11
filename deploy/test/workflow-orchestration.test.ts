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
    // Bootstrap and hydrate-workspace are intentionally NOT step.do calls
    // anymore — they were inlined/parallelized in commit 22a6df05 for
    // startup latency. Critical step order is now: llm → finalize →
    // write-telemetry → session-cleanup. Match against the first
    // occurrence in the main run loop.
    const idxLlm = source.indexOf("step.do(`llm-${turn}`");
    const idxFinalize = source.indexOf('step.do("finalize"');
    const idxTelemetry = source.indexOf('step.do("write-telemetry"');
    const idxCleanup = source.indexOf('step.do("session-cleanup"');

    expect(idxLlm).toBeGreaterThan(-1);
    expect(idxFinalize).toBeGreaterThan(idxLlm);
    expect(idxTelemetry).toBeGreaterThan(idxFinalize);
    expect(idxCleanup).toBeGreaterThan(idxTelemetry);
  });

  it("inlines bootstrap and hydrate-workspace off the step.do path", () => {
    const source = loadWorkflowSource();
    // Guard against regression: if someone re-wraps bootstrap in a
    // step.do, startup latency goes back up by 500-1500ms. These
    // strings should only appear in explanatory comments, never as
    // real step.do calls.
    expect(source).not.toMatch(/await\s+step\.do\(\s*["`']bootstrap["`']/);
    expect(source).not.toMatch(/await\s+step\.do\(\s*["`']hydrate-workspace["`']/);
  });

  it("executes tools between llm and final answer", () => {
    const source = loadWorkflowSource();
    expect(source).toContain('await memo("tools", () => import("./runtime/tools"))');
    // Match the executeTools call without pinning the exact `const results =`
    // prefix — the call is now wrapped in a try/finally for heartbeat cleanup.
    expect(source).toMatch(/results\s*=\s*await\s+executeTools\(/);
    expect(source).toContain("tool_results:");
    expect(source).toContain("type: \"done\"");
  });

  it("emits done event with session and trace metadata", () => {
    const source = loadWorkflowSource();
    const doneBlock = source.match(/type:\s*"done"[\s\S]*?session_id[\s\S]*?trace_id/s);
    expect(doneBlock).not.toBeNull();
  });
});
