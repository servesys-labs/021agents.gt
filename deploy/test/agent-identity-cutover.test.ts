import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";

import { getAmbientPlatformAgentConfig, isAmbientPlatformAgentHandle } from "../src/runtime/platform-agents";
import { resolveRunAgentTarget } from "../src/runtime/tools";
import { buildMemoryDigestParams, buildMemoryConsolidateParams } from "../src/runtime/memory-digest";

function readDeploySource(file: string): string {
  return fs.readFileSync(path.resolve(__dirname, "../src", file), "utf-8");
}

describe("agent identity cutover — ambient platform agents", () => {
  it("resolves memory-agent as an ambient hidden runtime definition", () => {
    expect(isAmbientPlatformAgentHandle("memory-agent")).toBe(true);
    const config = getAmbientPlatformAgentConfig("memory-agent", {
      provider: "workers-ai",
      model: "@cf/moonshotai/kimi-k2.5",
      plan: "free",
    }, "org-1");
    expect(config).not.toBeNull();
    expect(config!.agent_id).toBe("platform-memory-agent");
    expect(config!.agent_handle).toBe("memory-agent");
    expect(config!.agent_name).toBe("memory-agent");
    expect(config!.internal).toBe(true);
    expect(config!.hidden).toBe(true);
    expect(config!.enabled_skills).toEqual([
      "memory-digest",
      "memory-consolidate",
      "memory-recall-deep",
    ]);
  });
});

describe("agent identity cutover — run-agent routing", () => {
  it("prefers handle when both handle and id are present", () => {
    expect(resolveRunAgentTarget({
      agent_id: "agt_123",
      agent_handle: "research-bot",
      agent_name: "legacy-name",
    })).toEqual({
      agentId: "agt_123",
      agentHandle: "research-bot",
      routedName: "research-bot",
    });
  });

  it("supports id-only delegation for runtime lookup", () => {
    expect(resolveRunAgentTarget({
      agent_id: "agt_456",
      task: "summarize",
    })).toEqual({
      agentId: "agt_456",
      agentHandle: "",
      routedName: "agt_456",
    });
  });
});

describe("agent identity cutover — org_id propagation through memory pipeline", () => {
  it("memory-agent ambient config inherits org_id from parent workflow", () => {
    const config = getAmbientPlatformAgentConfig("memory-agent", {
      provider: "workers-ai", model: "test", plan: "free",
    }, "org_oneshots_001");
    expect(config!.org_id).toBe("org_oneshots_001");
  });

  it("memory-agent ambient config has empty org_id when none provided", () => {
    const config = getAmbientPlatformAgentConfig("memory-agent", {
      provider: "workers-ai", model: "test", plan: "free",
    });
    expect(config!.org_id).toBe("");
  });

  it("memory-digest params propagate org_id to child workflow", () => {
    const params = buildMemoryDigestParams("my-assistant", "sess-123", "org_oneshots_001", 0, true);
    expect(params).not.toBeNull();
    expect(params!.org_id).toBe("org_oneshots_001");
    expect(params!.agent_name).toBe("memory-agent");
    expect(params!.input).toContain("agent_name=my-assistant");
    expect(params!.input).toContain("session_id=sess-123");
  });

  it("memory-consolidate params propagate org_id to child workflow", () => {
    const params = buildMemoryConsolidateParams("my-assistant", "sess-456", "org_021agents_001", 0, true);
    expect(params).not.toBeNull();
    expect(params!.org_id).toBe("org_021agents_001");
  });

  it("memory-digest skips when agent is memory-agent (prevents infinite loop)", () => {
    const params = buildMemoryDigestParams("memory-agent", "sess-789", "org_001", 0, true);
    expect(params).toBeNull();
  });
});

// ─── DO cold-start org_id recovery ────────────────────────────────
// The DO starts with orgId="" in initialState. These tests verify the
// source code contains the recovery paths that populate it from the DB.
// We can't instantiate a real DO in vitest, so we verify by source inspection.
describe("DO cold-start org_id recovery", () => {
  const doSource = readDeploySource("index.ts");

  // Extract only the AgentOSAgent class (between its declaration and the next export class)
  const agentClassBlock = (() => {
    const start = doSource.indexOf("export class AgentOSAgent");
    const nextClass = doSource.indexOf("export class AgentOSWorker", start + 1);
    return doSource.slice(start, nextClass > start ? nextClass : undefined);
  })();

  it("onStart() resolves org_id from agents table before hydration", () => {
    // The org_id lookup must appear in AgentOSAgent.onStart() BEFORE hydration
    const onStartBlock = agentClassBlock.match(
      /Resolve org_id from Supabase[\s\S]*?\/\/ Hydrate from Supabase/,
    );
    expect(onStartBlock).not.toBeNull();
    const block = onStartBlock![0];
    expect(block).toContain("SELECT org_id FROM agents WHERE name =");
    expect(block).toContain("is_active = true");
    expect(block).toContain("!this.state.config.orgId");
    expect(block).toContain("orgId: row.org_id");
  });

  it("onStart() org_id lookup has a timeout to prevent blocking", () => {
    const onStartBlock = agentClassBlock.match(
      /Resolve org_id from Supabase[\s\S]*?Non-fatal/,
    );
    expect(onStartBlock).not.toBeNull();
    const block = onStartBlock![0];
    expect(block).toContain("Promise.race");
    expect(block).toMatch(/timeout.*3000|3000.*timeout/i);
  });

  it("_syncCheckpointFlagFromDb also propagates org_id as belt-and-suspenders", () => {
    // Match from the function signature through the catch block
    const syncBlock = agentClassBlock.match(
      /_syncCheckpointFlagFromDb[\s\S]*?\/\* keep existing flag \*\//,
    );
    expect(syncBlock).not.toBeNull();
    const block = syncBlock![0];
    expect(block).toContain("cfg.org_id");
    expect(block).toContain("!this.state.config.orgId");
    expect(block).toContain("updates.orgId");
  });

  it("initialState starts with empty orgId (the bug baseline)", () => {
    const initialBlock = agentClassBlock.match(
      /initialState:\s*AgentState\s*=\s*\{[\s\S]*?config:\s*\{[\s\S]*?\}/,
    );
    expect(initialBlock).not.toBeNull();
    expect(initialBlock![0]).toContain('orgId: ""');
  });
});

// ─── memory-recall session lookup: org_id scoping ─────────────────
// SECURITY: session lookup must NOT be fail-open when org_id is blank.
describe("memory-recall org_id scoping", () => {
  const toolsSource = readDeploySource("runtime/tools.ts");

  it("session lookup requires org_id (no fail-open)", () => {
    // Find the session-lookup block: from the SECURITY comment to LIMIT 1
    const recallBlock = toolsSource.match(
      /SECURITY: always scope by org_id[\s\S]*?LIMIT 1/,
    );
    expect(recallBlock).not.toBeNull();
    const block = recallBlock![0];
    // Must NOT contain the old fail-open pattern
    expect(block).not.toMatch(/\$\{orgId\}\s*=\s*''/);
    expect(block).not.toContain("OR org_id =");
    // Must enforce org_id strictly in the WHERE clause
    expect(block).toMatch(/AND\s+org_id\s*=\s*\$\{orgId\}/);
  });

  it("session lookup is gated on both sessionId and orgId", () => {
    // The if-guard must check both
    expect(toolsSource).toContain("if (sessionId && orgId)");
  });
});
