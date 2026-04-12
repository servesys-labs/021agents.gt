/**
 * Tests for intent-router.ts: classifyIntent, decomposeIntents, getAgentCapabilitiesCached.
 * Phase 9.0 prerequisite — documents current behavior before extraction in 9.3.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  classifyIntent,
  decomposeIntents,
  type AgentCapability,
} from "../src/runtime/intent-router";

// ── classifyIntent ───────────────────────────────────────────────

describe("classifyIntent", () => {
  it("classifies deploy-related inputs", () => {
    const result = classifyIntent("deploy the app to production");
    expect(result.intent).toBe("deploy");
    expect(result.confidence).toBeGreaterThan(0.2);
  });

  it("classifies debug-related inputs", () => {
    const result = classifyIntent("debug the crash in the auth service");
    expect(result.intent).toBe("debug");
    expect(result.confidence).toBeGreaterThan(0.2);
  });

  it("classifies research-related inputs", () => {
    const result = classifyIntent("research the latest AI frameworks");
    expect(result.intent).toBe("research");
    expect(result.confidence).toBeGreaterThan(0.2);
  });

  it("classifies code-related inputs", () => {
    const result = classifyIntent("implement a new authentication flow");
    expect(result.intent).toBe("code");
    expect(result.confidence).toBeGreaterThan(0.2);
  });

  it("classifies data-related inputs", () => {
    const result = classifyIntent("run a SQL query to get user stats");
    expect(result.intent).toBe("data");
    expect(result.confidence).toBeGreaterThan(0.2);
  });

  it("classifies security-related inputs", () => {
    const result = classifyIntent("scan for vulnerabilities in the API");
    expect(result.intent).toBe("security");
    expect(result.confidence).toBeGreaterThan(0.2);
  });

  it("classifies support-related inputs", () => {
    const result = classifyIntent("how do I configure the webhook?");
    expect(result.intent).toBe("support");
    expect(result.confidence).toBeGreaterThan(0.2);
  });

  it("returns general for unrecognized input", () => {
    const result = classifyIntent("hello world");
    expect(result.intent).toBe("general");
    expect(result.confidence).toBe(0.3);
    expect(result.all_intents).toEqual([]);
  });

  it("applies context boosts", () => {
    const withContext = classifyIntent("search the web for AI papers");
    const without = classifyIntent("search for AI papers");
    expect(withContext.confidence).toBeGreaterThan(without.confidence);
  });

  it("applies context penalties", () => {
    const penalized = classifyIntent("fix the deploy pipeline");
    // "fix" gets penalized when deploy-like words are nearby
    expect(penalized.intent).toBe("deploy");
  });

  it("confidence is capped at 0.95", () => {
    const result = classifyIntent("deploy rollback the canary release to staging and promote");
    expect(result.confidence).toBeLessThanOrEqual(0.95);
  });

  it("returns all_intents sorted by score", () => {
    const result = classifyIntent("debug the error in the deployed code");
    expect(result.all_intents!.length).toBeGreaterThan(1);
    for (let i = 1; i < result.all_intents!.length; i++) {
      expect(result.all_intents![i - 1].score).toBeGreaterThanOrEqual(result.all_intents![i].score);
    }
  });

  // ── Agent matching ─────────────────────────────────────────────

  it("suggests matching agent by intent", () => {
    const agents: AgentCapability[] = [
      { agent_name: "deploy-bot", intents: ["deploy"], description: "handles deployments", priority: 1 },
      { agent_name: "debug-bot", intents: ["debug"], description: "debugs issues", priority: 1 },
    ];
    const result = classifyIntent("deploy to production", agents);
    expect(result.suggested_agent).toBe("deploy-bot");
  });

  it("picks highest priority agent when multiple match", () => {
    const agents: AgentCapability[] = [
      { agent_name: "deploy-basic", intents: ["deploy"], description: "", priority: 1 },
      { agent_name: "deploy-pro", intents: ["deploy"], description: "", priority: 10 },
    ];
    const result = classifyIntent("deploy the app", agents);
    expect(result.suggested_agent).toBe("deploy-pro");
  });

  it("falls back to description matching when no intent match", () => {
    const agents: AgentCapability[] = [
      { agent_name: "general-bot", intents: ["other"], description: "handles security audits", priority: 1 },
    ];
    const result = classifyIntent("run a security scan", agents);
    expect(result.suggested_agent).toBe("general-bot");
  });

  it("returns undefined suggested_agent when no agents match", () => {
    const agents: AgentCapability[] = [
      { agent_name: "deploy-bot", intents: ["deploy"], description: "handles deployments", priority: 1 },
    ];
    const result = classifyIntent("analyze the data pipeline", agents);
    expect(result.suggested_agent).toBeUndefined();
  });

  it("works with no agents provided", () => {
    const result = classifyIntent("deploy the app");
    expect(result.suggested_agent).toBeUndefined();
    expect(result.intent).toBe("deploy");
  });
});

// ── decomposeIntents ─────────────────────────────────────────────

describe("decomposeIntents", () => {
  it("returns single intent for simple input", () => {
    const result = decomposeIntents("deploy the app");
    expect(result).toHaveLength(1);
    expect(result[0].intent).toBe("deploy");
    expect(result[0].subtask).toBe("deploy the app");
  });

  it("splits on 'and'", () => {
    const result = decomposeIntents("deploy the app and debug the errors");
    expect(result).toHaveLength(2);
    expect(result[0].intent).toBe("deploy");
    expect(result[1].intent).toBe("debug");
  });

  it("splits on 'then'", () => {
    const result = decomposeIntents("research the topic then implement the solution");
    expect(result).toHaveLength(2);
    expect(result[0].intent).toBe("research");
    expect(result[1].intent).toBe("code");
  });

  it("splits on 'also'", () => {
    const result = decomposeIntents("fix the bug also scan for vulnerabilities");
    expect(result).toHaveLength(2);
  });

  it("splits on commas", () => {
    const result = decomposeIntents("deploy the app, debug errors, run security scan");
    expect(result).toHaveLength(3);
  });

  it("each sub-task has its own confidence", () => {
    const result = decomposeIntents("deploy the app and hello world");
    expect(result[0].intent).toBe("deploy");
    expect(result[0].confidence).toBeGreaterThan(0.2);
    expect(result[1].intent).toBe("general");
    expect(result[1].confidence).toBe(0.3);
  });
});
