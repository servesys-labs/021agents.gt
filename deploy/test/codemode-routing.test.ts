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

// ═══════════════════════════════════════════════════════════════════
// Codemode tool RPC: camelCase aliases for hyphenated tool names
// ═══════════════════════════════════════════════════════════════════

describe("codemode camelCase tool aliases", () => {
  const CODEMODE_PATH = path.resolve(__dirname, "../src/runtime/codemode.ts");

  it("registers kebab-case, camelCase, and snake_case aliases for hyphenated tools", () => {
    const source = load(CODEMODE_PATH);
    // camelCase alias
    expect(source).toContain('.replace(/-([a-z])/g');
    expect(source).toContain("if (camel !== toolName) toolFns[camel] = handler");
    // snake_case alias
    expect(source).toContain('.replace(/-/g, "_")');
    expect(source).toContain("if (snake !== toolName) toolFns[snake] = handler");
  });

  it("camelCase and snake_case conversions are correct for common tool names", () => {
    const toCamel = (name: string) => name.replace(/-([a-z])/g, (_: string, c: string) => c.toUpperCase());
    const toSnake = (name: string) => name.replace(/-/g, "_");

    // camelCase
    expect(toCamel("web-search")).toBe("webSearch");
    expect(toCamel("knowledge-search")).toBe("knowledgeSearch");
    expect(toCamel("python-exec")).toBe("pythonExec");
    expect(toCamel("read-file")).toBe("readFile");
    expect(toCamel("execute-code")).toBe("executeCode");
    expect(toCamel("memory-save")).toBe("memorySave");
    expect(toCamel("share-artifact")).toBe("shareArtifact");

    // snake_case (used by swarm-generated code)
    expect(toSnake("web-search")).toBe("web_search");
    expect(toSnake("knowledge-search")).toBe("knowledge_search");
    expect(toSnake("python-exec")).toBe("python_exec");
    expect(toSnake("http-request")).toBe("http_request");

    // No-op for single-word names
    expect(toCamel("bash")).toBe("bash");
    expect(toSnake("swarm")).toBe("swarm");
  });
});

// ═══════════════════════════════════════════════════════════════════
// Research routing: Kimi K2.5 for research tasks
// ═══════════════════════════════════════════════════════════════════

describe("research task routing", () => {
  it("all plans route research and creative complex tasks to Kimi K2.5", () => {
    const source = load(DB_PATH);
    const routingBlock = source.match(
      /const PLAN_ROUTING[\s\S]*?\/\/ ── Paid plans/,
    );
    expect(routingBlock).not.toBeNull();
    const block = routingBlock![0];

    for (const plan of ["free", "basic", "standard", "premium"]) {
      // Research: search, analyze, synthesize all Kimi
      const researchMatch = block.match(new RegExp(`${plan}:\\s*\\{[\\s\\S]*?research:\\s*\\{([^}]+)\\}`));
      expect(researchMatch).not.toBeNull();
      const researchLine = researchMatch![1];
      expect(researchLine).toContain("search: KIMI_COMPLEX");
      expect(researchLine).toContain("analyze: KIMI_COMPLEX");
      expect(researchLine).toContain("synthesize: KIMI_COMPLEX");

      // Creative: write and complex both Kimi
      const creativeMatch = block.match(new RegExp(`${plan}:\\s*\\{[\\s\\S]*?creative:\\s*\\{([^}]+)\\}`));
      expect(creativeMatch).not.toBeNull();
      const creativeLine = creativeMatch![1];
      expect(creativeLine).toContain("write: KIMI_COMPLEX");
      expect(creativeLine).toContain("complex: KIMI_COMPLEX");
    }
  });
});
