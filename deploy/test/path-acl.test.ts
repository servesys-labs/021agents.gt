import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { normalizeFilePath, checkPathACL } from "../src/runtime/tools";

const WORKFLOW_PATH = path.resolve(__dirname, "../src/workflow.ts");
const TOOLS_PATH = path.resolve(__dirname, "../src/runtime/tools.ts");

function loadSource(p: string): string {
  return fs.readFileSync(p, "utf-8");
}

// ── Unit tests: normalizeFilePath ─────────────────────────────

describe("normalizeFilePath", () => {
  it("prefixes relative paths with /workspace/", () => {
    expect(normalizeFilePath("src/index.ts")).toBe("/workspace/src/index.ts");
    expect(normalizeFilePath("foo.txt")).toBe("/workspace/foo.txt");
  });

  it("preserves absolute /workspace/ paths", () => {
    expect(normalizeFilePath("/workspace/src/index.ts")).toBe("/workspace/src/index.ts");
  });

  it("preserves absolute /tmp/ paths", () => {
    expect(normalizeFilePath("/tmp/scratch.txt")).toBe("/tmp/scratch.txt");
  });

  it("resolves .. traversal segments", () => {
    expect(normalizeFilePath("/workspace/src/../../etc/passwd")).toBe("/etc/passwd");
    expect(normalizeFilePath("src/../../../etc/shadow")).toBe("/etc/shadow");
  });

  it("strips . segments", () => {
    expect(normalizeFilePath("/workspace/./src/./index.ts")).toBe("/workspace/src/index.ts");
  });

  it("handles empty string", () => {
    expect(normalizeFilePath("")).toBe("/workspace");
  });

  it("handles deeply nested relative paths", () => {
    expect(normalizeFilePath("a/b/c/d/e.ts")).toBe("/workspace/a/b/c/d/e.ts");
  });
});

// ── Unit tests: checkPathACL ──────────────────────────────────

describe("checkPathACL", () => {
  it("returns null when allowedPaths is undefined (top-level run)", () => {
    expect(checkPathACL("/workspace/anything", undefined)).toBeNull();
  });

  it("returns null when allowedPaths is empty array (backward compat)", () => {
    expect(checkPathACL("/workspace/anything", [])).toBeNull();
  });

  it("allows paths matching exact pattern", () => {
    expect(checkPathACL("/workspace/src/index.ts", ["/workspace/src/index.ts"])).toBeNull();
  });

  it("allows paths matching ** glob (any depth)", () => {
    expect(checkPathACL("/workspace/src/deep/nested/file.ts", ["/workspace/src/**"])).toBeNull();
    expect(checkPathACL("/workspace/src/index.ts", ["/workspace/**"])).toBeNull();
  });

  it("allows paths matching * glob (single segment)", () => {
    expect(checkPathACL("/workspace/src/index.ts", ["/workspace/src/*"])).toBeNull();
    // * should NOT match across /
    expect(checkPathACL("/workspace/src/deep/file.ts", ["/workspace/src/*"])).not.toBeNull();
  });

  it("blocks paths not matching any pattern", () => {
    const err = checkPathACL("/workspace/secrets/key.pem", ["/workspace/src/**", "/workspace/test/**"]);
    expect(err).not.toBeNull();
    expect(err).toContain("outside the allowed paths");
    expect(err).toContain("/workspace/secrets/key.pem");
  });

  it("allows /tmp/ when included in allowed_paths", () => {
    expect(checkPathACL("/tmp/scratch.txt", ["/workspace/**", "/tmp/**"])).toBeNull();
  });

  it("blocks /tmp/ when not included in allowed_paths", () => {
    const err = checkPathACL("/tmp/scratch.txt", ["/workspace/src/**"]);
    expect(err).not.toBeNull();
  });

  it("blocks traversal attempts that escape allowed scope", () => {
    // normalizeFilePath resolves ../.. before the check
    const err = checkPathACL("/workspace/src/../../etc/passwd", ["/workspace/**"]);
    expect(err).not.toBeNull();
    expect(err).toContain("/etc/passwd");
  });

  it("handles default delegation ACL [/workspace/**, /tmp/**]", () => {
    const delegationDefault = ["/workspace/**", "/tmp/**"];
    expect(checkPathACL("/workspace/src/index.ts", delegationDefault)).toBeNull();
    expect(checkPathACL("/tmp/output.json", delegationDefault)).toBeNull();
    expect(checkPathACL("/etc/passwd", delegationDefault)).not.toBeNull();
    expect(checkPathACL("/home/user/.ssh/id_rsa", delegationDefault)).not.toBeNull();
  });

  it("supports multiple patterns — any match is sufficient", () => {
    const patterns = ["/workspace/src/**", "/workspace/test/**", "/tmp/**"];
    expect(checkPathACL("/workspace/src/file.ts", patterns)).toBeNull();
    expect(checkPathACL("/workspace/test/spec.ts", patterns)).toBeNull();
    expect(checkPathACL("/tmp/cache.json", patterns)).toBeNull();
    expect(checkPathACL("/workspace/deploy/secret.key", patterns)).not.toBeNull();
  });

  it("normalizes relative paths before checking", () => {
    // Relative path gets /workspace/ prefix before ACL check
    expect(checkPathACL("src/index.ts", ["/workspace/src/**"])).toBeNull();
    expect(checkPathACL("test/spec.ts", ["/workspace/src/**"])).not.toBeNull();
  });
});

// ── Workflow integration: schema + threading ───────────────────

describe("workflow — allowed_paths schema and threading", () => {
  const source = loadSource(WORKFLOW_PATH);

  it("AgentRunParams includes allowed_paths field", () => {
    expect(source).toContain("allowed_paths?: string[]");
  });

  it("resolves allowed_paths with delegation default for child runs", () => {
    // Delegated runs (parent_session_id set) should default to ["/workspace/**", "/tmp/**"]
    expect(source).toContain('p.parent_session_id ? ["/workspace/**", "/tmp/**"] : undefined');
  });

  it("threads __allowedPaths into executeTools env", () => {
    const toolEnvBlock = source.slice(
      source.indexOf("results = await executeTools("),
      source.indexOf("} as any,", source.indexOf("results = await executeTools(")),
    );
    expect(toolEnvBlock).toContain("__allowedPaths: resolvedAllowedPaths");
  });
});

// ── Tools integration: ACL enforcement on all file + discovery tools ──

describe("tools — ACL enforcement on file operations", () => {
  const source = loadSource(TOOLS_PATH);

  // Write + read tools
  for (const toolCase of ["read-file", "write-file", "edit-file"]) {
    it(`${toolCase} calls checkPathACL with normalizeFilePath before operation`, () => {
      const caseStart = source.indexOf(`case "${toolCase}":`);
      const nextCase = source.indexOf("case ", caseStart + 10);
      const caseBlock = source.slice(caseStart, nextCase);
      expect(caseBlock).toContain("checkPathACL(");
      expect(caseBlock).toContain("normalizeFilePath(");
      expect(caseBlock).toContain("(env as any).__allowedPaths");
    });
  }

  // Sandbox file tools
  for (const toolCase of ["sandbox-file-write", "sandbox-file-read"]) {
    it(`${toolCase} calls checkPathACL with normalizeFilePath before operation`, () => {
      const caseStart = source.indexOf(`case "${toolCase}":`);
      const nextCase = source.indexOf("case ", caseStart + 10);
      const caseBlock = source.slice(caseStart, nextCase);
      expect(caseBlock).toContain("checkPathACL(");
      expect(caseBlock).toContain("normalizeFilePath(");
      expect(caseBlock).toContain("(env as any).__allowedPaths");
    });
  }

  // Read-side discovery tools
  for (const toolCase of ["view-file", "search-file", "find-file", "grep", "glob"]) {
    it(`${toolCase} calls checkPathACL with normalizeFilePath before operation`, () => {
      const caseStart = source.indexOf(`case "${toolCase}":`);
      expect(caseStart).toBeGreaterThan(-1);
      const nextCase = source.indexOf("case ", caseStart + 10);
      const caseBlock = source.slice(caseStart, nextCase);
      expect(caseBlock).toContain("checkPathACL(");
      expect(caseBlock).toContain("normalizeFilePath(");
      expect(caseBlock).toContain("(env as any).__allowedPaths");
    });
  }
});

// ── Delegation: allowed_paths propagated to child workflows ───

describe("delegation — allowed_paths inheritance", () => {
  const source = loadSource(TOOLS_PATH);

  it("childWorkflowParams includes allowed_paths from parent or caller", () => {
    const delegationBlock = source.slice(
      source.indexOf("const childWorkflowParams"),
      source.indexOf("const instance = await workflow.create"),
    );
    expect(delegationBlock).toContain("allowed_paths");
    expect(delegationBlock).toContain("(env as any).__allowedPaths");
  });

  it("run-agent tool schema exposes allowed_paths parameter", () => {
    // The tool schema must include allowed_paths so the LLM can narrow file scope
    const runAgentDef = source.slice(
      source.indexOf('name: "run-agent"'),
      source.indexOf("required: [", source.indexOf('name: "run-agent"')),
    );
    expect(runAgentDef).toContain("allowed_paths");
    expect(runAgentDef).toContain("Glob patterns limiting");
  });
});

// ── Fail-closed: ACL-bypassing tools stripped from delegated runs ─

describe("ACL bypass closure — bash/python-exec stripped when allowed_paths active", () => {
  const source = loadSource(WORKFLOW_PATH);

  it("strips ACL-bypassing tools from config.tools when resolvedAllowedPaths is active", () => {
    expect(source).toContain("ACL_BYPASS_TOOLS");
    expect(source).toContain('"bash"');
    expect(source).toContain('"python-exec"');
    expect(source).toContain('"sandbox-exec"');
    expect(source).toContain('"dynamic-exec"');
  });

  it("only strips when tools_override is NOT set (parent can opt back in)", () => {
    // The guard !p.tools_override means explicit tool lists are respected
    expect(source).toContain("!p.tools_override");
  });

  it("stripping happens after resolvedAllowedPaths is computed", () => {
    const resolvedIdx = source.indexOf("const resolvedAllowedPaths");
    const stripIdx = source.indexOf("ACL_BYPASS_TOOLS");
    expect(resolvedIdx).toBeGreaterThan(-1);
    expect(stripIdx).toBeGreaterThan(resolvedIdx);
  });
});

// ── Swarm ACL closure ─────────────────────────────────────────

describe("swarm — respects delegated path ACL", () => {
  const source = loadSource(TOOLS_PATH);

  it("auto mode does not resolve to parallel-exec when __allowedPaths is active", () => {
    // The mode resolution should check aclActive and skip parallel-exec
    const modeBlock = source.slice(
      source.indexOf("const resolvedMode = (() => {"),
      source.indexOf("})();", source.indexOf("const resolvedMode = (() => {")),
    );
    expect(modeBlock).toContain("aclActive");
    // parallel-exec should be gated by !aclActive
    expect(modeBlock).toContain("!aclActive");
  });

  it("explicit parallel-exec is downgraded to codemode when ACL active", () => {
    const modeBlock = source.slice(
      source.indexOf("const resolvedMode = (() => {"),
      source.indexOf("})();", source.indexOf("const resolvedMode = (() => {")),
    );
    // When swarmMode === "parallel-exec" && aclActive, return "codemode"
    expect(modeBlock).toMatch(/swarmMode\s*===\s*"parallel-exec"\s*&&\s*aclActive/);
  });

  it("swarm agent-mode child params include allowed_paths from parent", () => {
    // Find the swarm agent workflow creation (the one with swarmDepth, not parentDepth)
    const swarmAgentBlock = source.slice(
      source.indexOf("parent_depth: swarmDepth"),
      source.indexOf("const inst = await agentWorkflow.create", source.indexOf("parent_depth: swarmDepth")) > -1
        ? source.indexOf("});", source.indexOf("parent_depth: swarmDepth"))
        : source.indexOf("parent_depth: swarmDepth") + 500,
    );
    expect(swarmAgentBlock).toContain("allowed_paths");
    expect(swarmAgentBlock).toContain("(env as any).__allowedPaths");
  });
});

// ── Normalized path used for execution, not just ACL check ────

describe("normalized path wiring — ACL and execution use same path", () => {
  const source = loadSource(TOOLS_PATH);

  for (const toolCase of ["read-file", "write-file", "edit-file"]) {
    it(`${toolCase} uses normalizeFilePath for execution path`, () => {
      const caseStart = source.indexOf(`case "${toolCase}":`);
      const nextCase = source.indexOf("case ", caseStart + 10);
      const caseBlock = source.slice(caseStart, nextCase);
      // The tool must call normalizeFilePath before both ACL and file ops
      expect(caseBlock).toContain("normalizeFilePath(");
    });
  }

  for (const toolCase of ["sandbox-file-write", "sandbox-file-read"]) {
    it(`${toolCase} uses normalizeFilePath for execution path`, () => {
      const caseStart = source.indexOf(`case "${toolCase}":`);
      const nextCase = source.indexOf("case ", caseStart + 10);
      const caseBlock = source.slice(caseStart, nextCase);
      expect(caseBlock).toContain("normalizeFilePath(");
    });
  }

  it("traversal attack is blocked at both ACL and execution level", () => {
    // normalizeFilePath resolves ../.. BEFORE the path reaches sandbox.exec,
    // so the ACL check and execution both see the resolved path.
    const resolved = normalizeFilePath("/workspace/src/../../etc/passwd");
    expect(resolved).toBe("/etc/passwd");
    // And the ACL blocks it
    const err = checkPathACL("/workspace/src/../../etc/passwd", ["/workspace/**"]);
    expect(err).not.toBeNull();
    expect(err).toContain("/etc/passwd");
  });
});
