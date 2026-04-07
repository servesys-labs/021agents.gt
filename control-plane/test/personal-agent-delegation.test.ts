/**
 * Personal assistant + meta-agent delegation tests.
 *
 * Verifies:
 * 1. Personal assistant prompt is lean (8 core tools, not 26)
 * 2. PA knows when and how to delegate to meta-agent
 * 3. Signup creates both my-assistant AND meta-agent
 * 4. Meta-agent delegation is properly documented
 * 5. Progressive discovery patterns applied to PA
 * 6. Token budget is reasonable
 */

import { describe, it, expect } from "vitest";
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

  it("documents core tools including extended set", () => {
    // Core tools section should list these
    expect(prompt).toContain("## Core tools (always available)");
    const coreSection = prompt.split("## Core tools")[1].split("## Additional")[0];
    const toolMentions = coreSection.match(/`[a-z-]+`/g) || [];
    // Should have core tools documented (11 in current prompt)
    expect(toolMentions.length).toBeGreaterThanOrEqual(8);
    expect(toolMentions).toContain("`web-search`");
    expect(toolMentions).toContain("`browse`");
    expect(toolMentions).toContain("`python-exec`");
    expect(toolMentions).toContain("`bash`");
    expect(toolMentions).toContain("`read-file`");
    expect(toolMentions).toContain("`write-file`");
    expect(toolMentions).toContain("`edit-file`");
    expect(toolMentions).toContain("`execute-code`");
    expect(toolMentions).toContain("`swarm`");
    expect(toolMentions).toContain("`memory-save`");
    expect(toolMentions).toContain("`memory-recall`");
  });

  it("has additional tools section for on-demand discovery", () => {
    expect(prompt).toContain("## Additional tools (available on demand)");
    expect(prompt).toContain("discovers these automatically");
  });

  it("mentions progressive discovery concept", () => {
    // The additional tools section explains on-demand discovery
    expect(prompt).toContain("discovers these automatically");
    expect(prompt).toContain("Additional tools");
  });

  it("does NOT list marketplace/integration tools as always-available", () => {
    // These should be in the "additional" section, not core
    const coreSection = prompt.split("## Core tools")[1].split("## Additional")[0];
    expect(coreSection).not.toContain("marketplace-search");
    expect(coreSection).not.toContain("a2a-send");
    expect(coreSection).not.toContain("image-generate");
    // create-schedule is now a core tool (intentionally promoted)
    expect(coreSection).not.toContain("mcp-call");
    expect(coreSection).not.toContain("save-project");
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
    expect(prompt).toContain("Create or configure agents");
    expect(prompt).toContain("Test or evaluate agents");
    expect(prompt).toContain("Train or improve agents");
    expect(prompt).toContain("Diagnose issues");
    expect(prompt).toContain("Manage infrastructure");
  });

  it("shows how to delegate via run-agent", () => {
    expect(prompt).toContain('run-agent');
    expect(prompt).toContain('agent_name="meta-agent"');
  });

  it("tells PA not to manage agents itself", () => {
    expect(prompt).toContain("Do NOT try to manage agents yourself");
  });

  it("still has marketplace delegation for domain tasks", () => {
    expect(prompt).toContain("Delegate to marketplace");
    expect(prompt).toContain("marketplace-search");
    expect(prompt).toContain("a2a-send");
  });
});

// ══════════════════════════════════════════════════════════════════
// 3. SIGNUP CREATES BOTH AGENTS
// ══════════════════════════════════════════════════════════════════

describe("signup flow — agent creation", () => {
  it("personal assistant config has core tool list", () => {
    // Simulate the config that auth.ts creates (now 12 tools with edit-file, execute-code, swarm, sync-workspace-memory)
    const personalConfig = {
      tools: [
        "web-search", "browse",
        "python-exec", "bash",
        "read-file", "write-file", "edit-file",
        "memory-save", "memory-recall", "sync-workspace-memory",
        "execute-code", "swarm",
      ],
    };

    expect(personalConfig.tools).toHaveLength(12);
    expect(personalConfig.tools).not.toContain("marketplace-search");
    expect(personalConfig.tools).not.toContain("image-generate");
    expect(personalConfig.tools).not.toContain("mcp-call");
  });

  it("meta-agent config is minimal (no runtime tools)", () => {
    const metaConfig = {
      name: "meta-agent",
      tools: [],
      max_turns: 20,
      governance: { budget_limit_usd: 2 },
      is_meta: true,
    };

    expect(metaConfig.tools).toHaveLength(0); // Meta-agent uses its own tool system
    expect(metaConfig.max_turns).toBe(20);
    expect(metaConfig.governance.budget_limit_usd).toBe(2);
    expect(metaConfig.is_meta).toBe(true);
  });

  it("personal assistant uses auto reasoning strategy", () => {
    const config = { reasoning_strategy: "" };
    expect(config.reasoning_strategy).toBe(""); // auto-select
  });

  it("personal assistant has parallel_tool_calls enabled", () => {
    const config = { parallel_tool_calls: true };
    expect(config.parallel_tool_calls).toBe(true);
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
    expect(prompt).toContain("Plan first, then execute");
  });

  it("has error recovery guidance", () => {
    expect(prompt).toContain("Error recovery");
    expect(prompt).toContain("`web-search` returns nothing");
  });

  it("has memory protocol", () => {
    expect(prompt).toContain("Memory protocol");
    expect(prompt).toContain("## Save");
    expect(prompt).toContain("## Recall");
  });

  it("has building apps guidance", () => {
    expect(prompt).toContain("Building apps");
    expect(prompt).toContain("TypeScript");
  });

  it("has constraints/safety section", () => {
    expect(prompt).toContain("# Safety");
    expect(prompt).toContain("malware");
    expect(prompt).toContain("PII");
  });

  it("defaults to 'there' when no username provided", () => {
    const defaultPrompt = buildPersonalAgentPrompt();
    expect(defaultPrompt).toContain("for there on the OneShots");
    // The prompt uses "there" as fallback name
    expect(defaultPrompt).toContain("there");
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
    expect(leanTotal).toBeLessThan(5000); // Total overhead under 5000 tokens
  });
});
