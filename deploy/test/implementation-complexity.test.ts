import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { diffLineCounts, summarizeImplementationComplexity } from "../src/runtime/implementation-complexity";

const WORKFLOW_PATH = path.resolve(__dirname, "../src/workflow.ts");

function loadWorkflowSource(): string {
  return fs.readFileSync(WORKFLOW_PATH, "utf-8");
}

describe("implementation complexity helper", () => {
  it("counts a new workspace file as added lines and a created file", () => {
    const summary = summarizeImplementationComplexity([
      {
        tool: "write-file",
        file_mutation: {
          tool: "write-file",
          path: "/workspace/src/new.ts",
          existed_before: false,
          before_content: "",
          after_content: "line1\nline2\n",
        },
      },
    ]);

    expect(summary.files_touched).toBe(1);
    expect(summary.lines_added).toBe(2);
    expect(summary.lines_removed).toBe(0);
    expect(summary.new_files_created).toBe(1);
  });

  it("does not treat overwriting an existing empty file as a new file", () => {
    const summary = summarizeImplementationComplexity([
      {
        tool: "write-file",
        file_mutation: {
          tool: "write-file",
          path: "/workspace/src/existing.ts",
          existed_before: true,
          before_content: "",
          after_content: "const x = 1;\n",
        },
      },
    ]);

    expect(summary.files_touched).toBe(1);
    expect(summary.lines_added).toBe(1);
    expect(summary.lines_removed).toBe(0);
    expect(summary.new_files_created).toBe(0);
  });

  it("counts a single-line replacement as one add and one remove", () => {
    const summary = summarizeImplementationComplexity([
      {
        tool: "edit-file",
        file_mutation: {
          tool: "edit-file",
          path: "/workspace/src/app.ts",
          existed_before: true,
          before_content: "a\nb\nc\n",
          after_content: "a\nx\nc\n",
        },
      },
    ]);

    expect(summary.lines_added).toBe(1);
    expect(summary.lines_removed).toBe(1);
  });

  it("counts multiline replacements using full before/after content", () => {
    const diff = diffLineCounts("a\nb\nc\nd\n", "a\nx\ny\nd\n");
    expect(diff.lines_added).toBe(2);
    expect(diff.lines_removed).toBe(2);
  });

  it("deduplicates files_touched while summing line churn across repeated edits", () => {
    const summary = summarizeImplementationComplexity([
      {
        tool: "write-file",
        file_mutation: {
          tool: "write-file",
          path: "/workspace/src/repeat.ts",
          existed_before: false,
          before_content: "",
          after_content: "a\n",
        },
      },
      {
        tool: "edit-file",
        file_mutation: {
          tool: "edit-file",
          path: "/workspace/src/repeat.ts",
          existed_before: true,
          before_content: "a\n",
          after_content: "a\nb\n",
        },
      },
    ]);

    expect(summary.files_touched).toBe(1);
    expect(summary.new_files_created).toBe(1);
    expect(summary.lines_added).toBe(2);
    expect(summary.lines_removed).toBe(0);
  });

  it("excludes failed tracked mutations from the totals", () => {
    const summary = summarizeImplementationComplexity([
      {
        tool: "edit-file",
        error: "old_text not found",
        file_mutation: {
          tool: "edit-file",
          path: "/workspace/src/ignored.ts",
          existed_before: true,
          before_content: "a\n",
          after_content: "b\n",
        },
      },
    ]);

    expect(summary.files_touched).toBe(0);
    expect(summary.lines_added).toBe(0);
    expect(summary.lines_removed).toBe(0);
    expect(summary.new_files_created).toBe(0);
  });

  it("excludes non-workspace paths from tracked complexity", () => {
    const summary = summarizeImplementationComplexity([
      {
        tool: "write-file",
        file_mutation: {
          tool: "write-file",
          path: "/tmp/output.txt",
          existed_before: false,
          before_content: "",
          after_content: "temp\n",
        },
      },
    ]);

    expect(summary.files_touched).toBe(0);
    expect(summary.lines_added).toBe(0);
    expect(summary.new_files_created).toBe(0);
  });

  it("flags possible untracked mutations when command tools ran", () => {
    const summary = summarizeImplementationComplexity([
      { tool: "bash", error: undefined },
      {
        tool: "write-file",
        file_mutation: {
          tool: "write-file",
          path: "/workspace/src/kept.ts",
          existed_before: false,
          before_content: "",
          after_content: "ok\n",
        },
      },
    ]);

    expect(summary.possible_untracked_mutations).toBe(true);
    expect(summary.files_touched).toBe(1);
  });

  it("keeps the tracked tool list and measurement scope stable", () => {
    const summary = summarizeImplementationComplexity([]);
    expect(summary.measurement_scope).toBe("tracked_file_tools_only");
    expect(summary.tracked_tools).toEqual(["write-file", "edit-file"]);
  });
});

describe("workflow wiring — implementation complexity event", () => {
  const source = loadWorkflowSource();

  it("emits implementation_complexity exactly once", () => {
    const matches = source.match(/event_type:\s*"implementation_complexity"/g) || [];
    expect(matches).toHaveLength(1);
  });

  it("emits from the write-telemetry block with the standard workflow envelope", () => {
    const block = source.slice(
      source.indexOf('step.do("write-telemetry"'),
      source.indexOf('step.do("session-cleanup"'),
    );

    expect(block).toContain('type: "event"');
    expect(block).toContain('event_type: "implementation_complexity" satisfies RuntimeEventType');
    expect(block).toContain('action: "measured"');
    expect(block).toContain('status: "ok"');
    expect(block).toContain("org_id:");
    expect(block).toContain("agent_name:");
    expect(block).toContain("session_id:");
    expect(block).toContain("trace_id:");
    expect(block).toContain("plan:");
    expect(block).toContain("provider:");
    expect(block).toContain("model:");
    expect(block).toContain("details: implementationComplexity");
    expect(block).toContain("created_at: Date.now()");
  });
});
