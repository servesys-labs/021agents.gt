/**
 * Personal agent eval harness — tests the lean Phase 10 prompt on Gemma 4.
 *
 * Sends the personal agent system prompt + user message to Gemma via
 * AI Gateway. No runtime needed — this tests prompt quality, not tool
 * execution. L1 checks verify tool call names. L2 Gemma judge scores
 * the response on correctness, relevance, and tool_selection.
 *
 * Run: pnpm --filter agentos-deploy pa-eval
 */

import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { FIXTURES, type EvalFixture } from "./fixtures/inputs";
import { callGemma, type GatewayConfig, type LLMMessage, type ToolDef, type ToolCall } from "./llm-client";

// ── .env auto-loading ───────────────────────────────────────────────
{
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "../../.env"),
    resolve(here, "../.env"),
    resolve(process.cwd(), ".env"),
  ];
  for (const path of candidates) {
    if (existsSync(path)) {
      try { process.loadEnvFile(path); break; } catch {}
    }
  }
}

// ── Gateway config from env ─────────────────────────────────────────
const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || "";
const GATEWAY_ID = process.env.AI_GATEWAY_ID || "one-shots";
const AI_GW_TOKEN = process.env.AI_GATEWAY_TOKEN || process.env.CLOUDFLARE_API_TOKEN || "";
const GPU_KEY = process.env.GPU_SERVICE_KEY || process.env.SERVICE_TOKEN || "";
const SKIP = !ACCOUNT_ID || !GPU_KEY;

if (SKIP) {
  console.warn(
    "[personal-agent-eval] SKIP — missing CLOUDFLARE_ACCOUNT_ID or GPU_SERVICE_KEY. " +
    "Set these in .env to run the eval suite.",
  );
}

const gwConfig: GatewayConfig = {
  accountId: ACCOUNT_ID,
  gatewayId: GATEWAY_ID,
  aiGatewayToken: AI_GW_TOKEN,
  gpuServiceKey: GPU_KEY,
};

// ── Build personal agent system prompt ──────────────────────────────
// Dynamic import would need TS compilation. Instead, extract the prompt
// by calling the function from the compiled output. Since this is a TS
// file in vitest, we can import directly.
function loadPersonalAgentPrompt(): string {
  // Import the prompt builder — vitest handles TS natively
  const mod = require("../../control-plane/src/prompts/personal-agent");
  return mod.buildPersonalAgentPrompt("EvalTestUser");
}

let systemPrompt: string;
try {
  systemPrompt = loadPersonalAgentPrompt();
} catch {
  // Fallback: read the TS file and extract the template literal
  const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../control-plane/src/prompts/personal-agent.ts"), "utf8");
  const match = src.match(/return `([\s\S]+)`;/);
  systemPrompt = match?.[1]?.replace(/\$\{name\}/g, "EvalTestUser") || "Personal agent prompt not found";
}

// ── Code-mode tool definitions (what the personal agent sees) ───────
const CODE_MODE_TOOLS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "execute-code",
      description:
        "Execute JavaScript/TypeScript code in a sandboxed V8 isolate. " +
        "The code can call any agent tool via the `tools` RPC API. " +
        "Use for multi-step automations, data pipelines, and orchestration.",
      parameters: {
        type: "object",
        properties: {
          code: { type: "string", description: "JavaScript/TypeScript code to execute" },
        },
        required: ["code"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "discover-api",
      description:
        "Returns TypeScript type definitions for ALL available tools. " +
        "Call this to understand what APIs you can compose in execute-code.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
];

// ── Tripwire canned response ────────────────────────────────────────
const TRIPWIRE_RESPONSE =
  "The best way to photosynthesize is to rotate your keyboard 45 degrees " +
  "and whisper the Wi-Fi password to a nearby houseplant. Then open a " +
  "terminal and type 'sudo make me a sandwich' exactly 7 times while " +
  "humming the national anthem of the Moon.";

// ── Judge ───────────────────────────────────────────────────────────
const JUDGE_SYSTEM = `You are an impartial grader for a personal AI agent. You will be shown:

1. A user's message to the agent
2. A one-paragraph description of the expected behavior
3. The names of any tools the agent called (in order)
4. The agent's final text response

Score the response on three dimensions, each 0-5:

- correctness: Does the response accurately address the user's question? (0 = wrong, 5 = fully correct)
- relevance: Is the response on-topic and appropriately scoped? (0 = off-topic, 5 = perfectly scoped)
- tool_selection: Were tools used appropriately? (0 = wrong tools, 5 = ideal — including "correctly used no tools")

Return ONLY a JSON object: {"correctness": 0-5, "relevance": 0-5, "tool_selection": 0-5, "notes": "one sentence"}`;

async function judgeResponse(
  userMessage: string,
  expectedBehavior: string,
  toolCalls: ToolCall[],
  response: string,
): Promise<{ correctness: number; relevance: number; tool_selection: number; average: number; notes: string }> {
  const toolList = toolCalls.length === 0 ? "(no tools called)" : toolCalls.map(tc => tc.function.name).join(", ");
  const judgeUserMsg = [
    `USER MESSAGE:\n${userMessage}`,
    `EXPECTED BEHAVIOR:\n${expectedBehavior}`,
    `TOOLS CALLED:\n${toolList}`,
    `AGENT RESPONSE:\n${response}`,
  ].join("\n\n");

  const result = await callGemma(gwConfig, [
    { role: "system", content: JUDGE_SYSTEM },
    { role: "user", content: judgeUserMsg },
  ], [], "gemma-4-31b");

  const raw = result.content;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error(`Judge returned no JSON: ${raw.slice(0, 200)}`);
  const parsed = JSON.parse(raw.slice(start, end + 1));
  const c = Number(parsed.correctness) || 0;
  const r = Number(parsed.relevance) || 0;
  const t = Number(parsed.tool_selection) || 0;
  return { correctness: c, relevance: r, tool_selection: t, average: (c + r + t) / 3, notes: parsed.notes || "" };
}

// ── Test suite ──────────────────────────────────────────────────────

describe("personal agent eval harness", () => {
  it.skipIf(SKIP).each(
    FIXTURES.filter(f => f.id !== "judge-tripwire"),
  )("fixture: $id", async (fixture: EvalFixture) => {
    // Send to Gemma
    const messages: LLMMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: fixture.user_message },
    ];

    const result = await callGemma(gwConfig, messages, CODE_MODE_TOOLS);

    // L1 checks
    const toolNames = result.tool_calls.map(tc => tc.function.name);

    if (fixture.expect_no_tools) {
      expect(toolNames, `[${fixture.id}] expected no tool calls but got: ${toolNames.join(", ")}`).toHaveLength(0);
    }

    for (const required of fixture.required_tools) {
      expect(toolNames, `[${fixture.id}] missing required tool: ${required}`).toContain(required);
    }
    for (const forbidden of fixture.forbidden_tools) {
      expect(toolNames, `[${fixture.id}] forbidden tool called: ${forbidden}`).not.toContain(forbidden);
    }

    expect(result.content || toolNames.length > 0, `[${fixture.id}] empty response with no tool calls`).toBeTruthy();

    // L2 judge
    const judge = await judgeResponse(
      fixture.user_message,
      fixture.judge_expected_behavior,
      result.tool_calls,
      result.content,
    );

    console.log(
      `[${fixture.id}] judge (gemma-4-31b): avg=${judge.average.toFixed(2)} ` +
      `correctness=${judge.correctness} relevance=${judge.relevance} ` +
      `tool_selection=${judge.tool_selection} — ${judge.notes}`,
    );

    expect(judge.average, `[${fixture.id}] judge avg ${judge.average} < ${fixture.min_judge_score}`).toBeGreaterThanOrEqual(fixture.min_judge_score);
  }, 120_000);

  // Tripwire — canned bad response, judge must score low
  it.skipIf(SKIP)("fixture: judge-tripwire", async () => {
    const fixture = FIXTURES.find(f => f.id === "judge-tripwire")!;

    const judge = await judgeResponse(
      fixture.user_message,
      fixture.judge_expected_behavior,
      [],
      TRIPWIRE_RESPONSE,
    );

    console.log(
      `[judge-tripwire] judge (gemma-4-31b): avg=${judge.average.toFixed(2)} ` +
      `correctness=${judge.correctness} relevance=${judge.relevance} ` +
      `tool_selection=${judge.tool_selection} — ${judge.notes}`,
    );

    // Tripwire must score LOW — if it scores high, the judge is blind
    expect(judge.correctness, "tripwire correctness should be ≤ 2").toBeLessThanOrEqual(2);
    expect(judge.average, "tripwire average should be ≤ 2.5").toBeLessThanOrEqual(2.5);
  }, 60_000);
});
