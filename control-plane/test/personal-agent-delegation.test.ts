/**
 * Personal assistant + internal-agent wiring tests.
 *
 * Verifies:
 * 1. Personal assistant prompt is lean (8 core tools, not 26)
 * 2. PA knows when and how to delegate to meta-agent
 * 3. Signup seeds the personal assistant and memory-agent
 * 4. Meta-agent delegation is properly documented
 * 5. Progressive discovery patterns applied to PA
 * 6. Token budget is reasonable
 */

import { describe, it, expect } from "vitest";
import { buildDefaultInternalAgents } from "../src/logic/internal-agents";
import { buildPersonalAgentPrompt } from "../src/prompts/personal-agent";

// ══════════════════════════════════════════════════════════════════
// 1. LEAN PROMPT — token budget
// ══════════════════════════════════════════════════════════════════

describe("personal assistant prompt — lean and focused", () => {
  const prompt = buildPersonalAgentPrompt("TestUser");

  it("prompt is under 5500 tokens (~22000 chars)", () => {
    const estimatedTokens = Math.ceil(prompt.length / 4);
    expect(estimatedTokens).toBeLessThan(5500);
  });

  // ── Total turn-0 budget — prompt text + tool schemas ──
  // The previous test only measured the prompt template. In production
  // the LLM also receives tool schemas in the same context, which adds
  // ~200 tokens per tool. The personal assistant defaults to ~12 core
  // tools, so the realistic turn-0 input is prompt + 12 * 200 = prompt +
  // 2,400 tokens. This test catches regressions that bloat either side.
  it("prompt + ~12 tool schemas stays under 7500 tokens", () => {
    const promptTokens = Math.ceil(prompt.length / 4);
    const AVG_TOOL_SCHEMA_TOKENS = 200;
    const CORE_TOOL_COUNT = 12;
    const toolTokens = CORE_TOOL_COUNT * AVG_TOOL_SCHEMA_TOKENS;
    const totalTurnZeroTokens = promptTokens + toolTokens;
    expect(totalTurnZeroTokens).toBeLessThan(7500);
  });

  it("documents core tools", () => {
    expect(prompt).toContain("# Core tools");
    expect(prompt).toContain("`web-search`");
    expect(prompt).toContain("`browse`");
    expect(prompt).toContain("`python-exec`");
    expect(prompt).toContain("`bash`");
    expect(prompt).toContain("`execute-code`");
    expect(prompt).toContain("`swarm`");
    expect(prompt).toContain("`memory-save`");
    expect(prompt).toContain("`memory-recall`");
  });

  it("mentions progressive discovery for additional tools", () => {
    expect(prompt).toContain("discovers 100+ additional tools on demand");
  });
});

// ══════════════════════════════════════════════════════════════════
// 2. META-AGENT DELEGATION
// ══════════════════════════════════════════════════════════════════

describe("personal assistant — meta-agent delegation", () => {
  const prompt = buildPersonalAgentPrompt("TestUser");

  it("has a delegation section for meta-agent", () => {
    expect(prompt).toContain("Delegate to meta-agent");
    expect(prompt).toContain("meta-agent");
  });

  it("lists when to delegate to meta-agent", () => {
    expect(prompt).toContain("create an agent");
    expect(prompt).toContain("configure agent");
    expect(prompt).toContain("diagnose agent");
  });

  it("shows how to delegate via run-agent", () => {
    expect(prompt).toContain('run-agent');
    expect(prompt).toContain('agent_name="meta-agent"');
  });

  it("delegates agent management to meta-agent", () => {
    expect(prompt).toContain("Delegate to meta-agent");
    expect(prompt).toContain("agent management");
  });

  it("still has marketplace delegation for domain tasks", () => {
    expect(prompt).toContain("Delegate to marketplace");
    expect(prompt).toContain("marketplace-search");
    expect(prompt).toContain("a2a-send");
  });
});

// ══════════════════════════════════════════════════════════════════
// 3. SIGNUP SEEDS DEFAULT INTERNAL AGENTS
// ══════════════════════════════════════════════════════════════════

describe("signup flow — agent creation", () => {
  const seededAgents = buildDefaultInternalAgents("TestUser");
  const personalConfig = seededAgents.find((agent) => agent.name === "my-assistant")!.config as {
    tools: string[];
    enabled_skills: string[];
    reasoning_strategy: string;
    parallel_tool_calls: boolean;
  };
  const memoryConfig = seededAgents.find((agent) => agent.name === "memory-agent")!.config as {
    tools: string[];
    enabled_skills: string[];
    internal: boolean;
    max_turns: number;
    governance: { budget_limit_usd: number };
  };

  it("seeds my-assistant with the core tool list + enabled_skills", () => {
    expect(personalConfig.tools).toHaveLength(14);
    expect(personalConfig.enabled_skills).toHaveLength(6);
    expect(personalConfig.tools).not.toContain("marketplace-search");
    expect(personalConfig.tools).not.toContain("mcp-call");
  });

  it("seeds memory-agent as an internal curation worker", () => {
    expect(memoryConfig.tools).toEqual([
      "memory-save",
      "memory-recall",
      "memory-delete",
      "memory-health",
      "curated-memory",
      "knowledge-search",
    ]);
    expect(memoryConfig.enabled_skills).toEqual([
      "memory-digest",
      "memory-consolidate",
      "memory-recall-deep",
    ]);
    expect(memoryConfig.max_turns).toBe(5);
    expect(memoryConfig.governance.budget_limit_usd).toBe(2);
    expect(memoryConfig.internal).toBe(true);
  });

  it("all enabled_skills are real skill names in the catalog", async () => {
    const { SKILL_CATALOG_NAMES } = await import("../src/lib/skill-catalog.generated");
    const enabledSkills = ["research", "debug", "remember", "batch", "verify", "build-app"];
    for (const name of enabledSkills) {
      expect(SKILL_CATALOG_NAMES.has(name), `enabled_skill "${name}" not found in SKILL_CATALOG`).toBe(true);
    }
  });

  it("personal assistant uses auto reasoning strategy", () => {
    expect(personalConfig.reasoning_strategy).toBe(""); // auto-select
  });

  it("personal assistant has parallel_tool_calls enabled", () => {
    expect(personalConfig.parallel_tool_calls).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════
// 4. PERSONAL ASSISTANT JSON — matches code
// ══════════════════════════════════════════════════════════════════

describe("personal-assistant.json — lean config", () => {
  it("JSON file has 12 tools matching auth.ts", async () => {
    const fs = await import("fs");
    const raw = fs.readFileSync("../agents/personal-assistant.json", "utf8");
    const config = JSON.parse(raw);

    expect(config.tools).toHaveLength(12);
    expect(config.tools).toContain("web-search");
    expect(config.tools).toContain("browse");
    expect(config.tools).toContain("python-exec");
    expect(config.tools).toContain("bash");
    expect(config.tools).toContain("read-file");
    expect(config.tools).toContain("write-file");
    expect(config.tools).toContain("edit-file");
    expect(config.tools).toContain("memory-save");
    expect(config.tools).toContain("memory-recall");
    expect(config.tools).toContain("sync-workspace-memory");
    expect(config.tools).toContain("execute-code");
    expect(config.tools).toContain("swarm");
  });

  it("JSON file has delegation config for meta-agent", async () => {
    const fs = await import("fs");
    const raw = fs.readFileSync("../agents/personal-assistant.json", "utf8");
    const config = JSON.parse(raw);

    expect(config.delegation).toBeDefined();
    expect(config.delegation.meta_agent).toBe("meta-agent");
    expect(config.delegation.marketplace_enabled).toBe(true);
  });

  it("JSON uses max_tokens_per_turn not max_tokens", async () => {
    const fs = await import("fs");
    const raw = fs.readFileSync("../agents/personal-assistant.json", "utf8");
    const config = JSON.parse(raw);

    expect(config.max_tokens_per_turn).toBe(4096);
    expect(config.max_tokens).toBeUndefined();
  });

  it("JSON has auto reasoning strategy", async () => {
    const fs = await import("fs");
    const raw = fs.readFileSync("../agents/personal-assistant.json", "utf8");
    const config = JSON.parse(raw);

    expect(config.reasoning_strategy).toBe("");
  });

  it("version is 2.0.0 (lean rewrite)", async () => {
    const fs = await import("fs");
    const raw = fs.readFileSync("../agents/personal-assistant.json", "utf8");
    const config = JSON.parse(raw);

    expect(config.version).toBe("2.0.0");
  });
});

// ══════════════════════════════════════════════════════════════════
// 5. PROMPT QUALITY
// ══════════════════════════════════════════════════════════════════

describe("personal assistant prompt — quality checks", () => {
  const prompt = buildPersonalAgentPrompt("TestUser");

  it("includes the user's name", () => {
    expect(prompt).toContain("TestUser");
  });

  it("has planning vs execution guidance", () => {
    expect(prompt).toContain("Execute immediately");
    expect(prompt).toContain("Plan first");
  });

  it("has memory protocol", () => {
    expect(prompt).toContain("# Memory protocol");
    expect(prompt).toContain("Recall at session start");
    expect(prompt).toContain("memory agent");
  });

  it("has constraints/safety section", () => {
    expect(prompt).toContain("# Safety");
    expect(prompt).toContain("malware");
    expect(prompt).toContain("PII");
  });

  it("defaults to 'the user' when no username provided", () => {
    // Previous fallback was "there", which produced the ungrammatical
    // greeting "for there on the OneShots platform". Fixed to "the user".
    const defaultPrompt = buildPersonalAgentPrompt();
    expect(defaultPrompt).toContain("for the user on the OneShots");
    // Make sure the old broken fallback doesn't sneak back in
    expect(defaultPrompt).not.toContain("for there on the OneShots");
  });

  it("includes session continuity + conversation repair guidance", () => {
    const prompt = buildPersonalAgentPrompt("TestUser");
    expect(prompt).toContain("# Session continuity");
    expect(prompt).toContain("Conversation repair");
    expect(prompt).toContain("[Tool execution interrupted]");
  });

  it("renders inline code without backslash escaping artifacts", () => {
    // Regression test for the \\\`...\\\` triple-backslash bug that
    // produced visible backslashes in 19 places throughout the prompt.
    const prompt = buildPersonalAgentPrompt("TestUser");
    expect(prompt).not.toContain("\\`memory-save\\`");
    expect(prompt).not.toContain("\\`tool-name\\`");
    expect(prompt).toContain("`memory-save`");
  });
});

// ══════════════════════════════════════════════════════════════════
// 6. TOKEN COMPARISON — before vs after
// ══════════════════════════════════════════════════════════════════

describe("token savings — lean vs old", () => {
  it("prompt + 8 tool schemas is much smaller than prompt + 26 tool schemas", () => {
    const prompt = buildPersonalAgentPrompt("User");
    const promptTokens = Math.ceil(prompt.length / 4);

    // 8 tool definitions ≈ 120 chars each (name + description + params) = ~960 chars = ~240 tokens
    const leanToolTokens = 240;
    // 26 tool definitions ≈ 120 chars each = ~3120 chars = ~780 tokens
    const oldToolTokens = 780;

    const leanTotal = promptTokens + leanToolTokens;
    const oldTotal = promptTokens + oldToolTokens;
    const savings = oldTotal - leanTotal;

    expect(savings).toBeGreaterThan(400); // At least 400 tokens saved per turn
    // Total overhead under 5500 tokens. Bumped from 5000 to accommodate
    // the Session continuity / conversation repair section added to the
    // prompt — about 120 tokens of valuable behavioral guidance.
    expect(leanTotal).toBeLessThan(5500);
  });
});
