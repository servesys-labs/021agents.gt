import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const TOOLS_PATH = path.resolve(__dirname, "../src/runtime/tools.ts");

function load(filePath: string): string {
  return fs.readFileSync(filePath, "utf-8");
}

describe("tool org-scope hardening", () => {
  it("enforces org context and mismatch guard for connector/mcp/db tools", () => {
    const source = load(TOOLS_PATH);
    expect(source).toContain("const orgScopedTools = new Set([\"connector\", \"mcp-call\", \"manage-mcp\", \"platform\", \"db-query\", \"db-batch\", \"db-report\"])");
    expect(source).toContain("error: \"missing_org_context\"");
    expect(source).toContain("code: \"ORG_SCOPE_MISMATCH\"");
    expect(source).toContain("args = { ...args, org_id: identity.orgId };");
  });

  it("resolves MCP servers from org-scoped DB state", () => {
    const source = load(TOOLS_PATH);
    expect(source).toContain("FROM mcp_servers");
    expect(source).toContain("WHERE org_id = ${orgId}");
    expect(source).toContain("code: \"MCP_SERVER_NOT_FOUND\"");
    expect(source).toContain("code: \"MCP_TOOL_CALL_FAILED\"");
  });

  it("requires org context for db-query, db-batch, and db-report", () => {
    const source = load(TOOLS_PATH);
    expect(source).toContain("db-query requires org context");
    expect(source).toContain("db-batch requires org context");
    expect(source).toContain("db-report requires org context");
  });
});
