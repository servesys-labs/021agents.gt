import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const WORKFLOW_PATH = path.resolve(__dirname, "../src/workflow.ts");
const STREAM_PATH = path.resolve(__dirname, "../src/runtime/stream.ts");
const DB_PATH = path.resolve(__dirname, "../src/runtime/db.ts");

function load(filePath: string): string {
  return fs.readFileSync(filePath, "utf-8");
}

describe("codemode routing", () => {
  it("workflow narrows LLM-visible tools to execute-code + discover-api", () => {
    const source = load(WORKFLOW_PATH);
    expect(source).toContain("const llmVisibleToolDefs = config.use_code_mode");
    expect(source).toContain('t.function.name === "execute-code" || t.function.name === "discover-api"');
    expect(source).toContain("autoSelectStrategy(p.input, llmVisibleToolDefs.length)");
    expect(source).toContain("tool_count: llmVisibleToolDefs.length");
  });

  it("stream path applies same codemode tool filtering", () => {
    const source = load(STREAM_PATH);
    expect(source).toContain("const activeTools = config.use_code_mode");
    expect(source).toContain('t.function.name === "execute-code" || t.function.name === "discover-api"');
    expect(source).toContain("toolDefs.filter((t) => !blockedSet.has(t.function.name));");
  });

  it("runtime defaults codemode on for personal agents unless explicitly overridden", () => {
    const source = load(DB_PATH);
    expect(source).toContain("const looksLikePersonalAssistant =");
    expect(source).toContain("resolvedHandle === \"my-assistant\"");
    expect(source).toContain("use_code_mode: cfg.use_code_mode === true || cfg.useCodeMode === true || personalAgentDefaultCodeMode");
  });
});
