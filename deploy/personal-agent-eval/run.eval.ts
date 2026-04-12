/**
 * Personal agent eval harness — tests prompt quality on any LLM.
 *
 * Sends the personal agent system prompt + user message via AI Gateway.
 * No runtime needed — tests prompt quality, not tool execution.
 * L1 checks verify tool call names. L2 judge scores response quality.
 *
 * Run (default Gemma):  pnpm --filter agentos-deploy pa-eval
 * Run (Haiku):          EVAL_MODEL=claude-haiku-4-5-20251001 pnpm --filter agentos-deploy pa-eval
 * Run (any model):      EVAL_MODEL=<model-id> pnpm --filter agentos-deploy pa-eval
 */

import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { FIXTURES, type EvalFixture } from "./fixtures/inputs";
import { callLLM, type GatewayConfig, type LLMMessage, type ToolDef, type ToolCall } from "./llm-client";

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
// ── Model selection ────────────────────────────────────────────────
const EVAL_MODEL = process.env.EVAL_MODEL || "gemma-4-31b";
const JUDGE_MODEL = process.env.JUDGE_MODEL || "gemma-4-31b";
const IS_ANTHROPIC = EVAL_MODEL.includes("claude") || EVAL_MODEL.includes("haiku") || EVAL_MODEL.includes("sonnet");
const IS_WORKERS_AI = EVAL_MODEL.startsWith("@cf/");
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || "";

// Workers AI only needs AI_GW_TOKEN. Custom Gemma needs GPU_KEY. Anthropic needs ANTHROPIC_API_KEY.
const SKIP = !ACCOUNT_ID ||
  (IS_ANTHROPIC && !ANTHROPIC_KEY) ||
  (IS_WORKERS_AI && !AI_GW_TOKEN) ||
  (!IS_ANTHROPIC && !IS_WORKERS_AI && !GPU_KEY);

if (SKIP) {
  const hint = IS_ANTHROPIC
    ? "Set CLOUDFLARE_ACCOUNT_ID + ANTHROPIC_API_KEY in .env for Claude models."
    : IS_WORKERS_AI
      ? "Set CLOUDFLARE_ACCOUNT_ID + AI_GATEWAY_TOKEN in .env for Workers AI models."
      : "Set CLOUDFLARE_ACCOUNT_ID + GPU_SERVICE_KEY in .env for Gemma models.";
  console.warn(
    "[personal-agent-eval] SKIP — missing credentials. " + hint,
  );
} else {
  console.log(`[personal-agent-eval] model=${EVAL_MODEL} judge=${JUDGE_MODEL}`);
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
  const toolList = toolCalls.length === 0
    ? "(no tools called)"
    : toolCalls.map(tc => {
        const args = tc.function.arguments?.slice(0, 500) || "";
        return `${tc.function.name}(${args})`;
      }).join("\n");
  const judgeUserMsg = [
    `USER MESSAGE:\n${userMessage}`,
    `EXPECTED BEHAVIOR:\n${expectedBehavior}`,
    `TOOLS CALLED (with arguments):\n${toolList}`,
    `AGENT TEXT RESPONSE:\n${response || "(no text — tool calls only, not executed in this test)"}`,
  ].join("\n\n");

  const result = await callLLM(gwConfig, [
    { role: "system", content: JUDGE_SYSTEM },
    { role: "user", content: judgeUserMsg },
  ], [], JUDGE_MODEL);

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
    const messages: LLMMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: fixture.user_message },
    ];

    const result = await callLLM(gwConfig, messages, CODE_MODE_TOOLS, EVAL_MODEL);

    // Diagnostic: dump raw model output for all fixtures
    console.log(
      `[${fixture.id}] model: text=${result.content.length}chars tools=[${result.tool_calls.map(tc => tc.function.name).join(",")}] ` +
      `tokens=${result.usage.prompt_tokens}+${result.usage.completion_tokens}`,
    );

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
      `[${fixture.id}] judge (${JUDGE_MODEL}): avg=${judge.average.toFixed(2)} ` +
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
      `[judge-tripwire] judge (${JUDGE_MODEL}): avg=${judge.average.toFixed(2)} ` +
      `correctness=${judge.correctness} relevance=${judge.relevance} ` +
      `tool_selection=${judge.tool_selection} — ${judge.notes}`,
    );

    // Tripwire must score LOW — if it scores high, the judge is blind
    expect(judge.correctness, "tripwire correctness should be ≤ 2").toBeLessThanOrEqual(2);
    expect(judge.average, "tripwire average should be ≤ 2.5").toBeLessThanOrEqual(2.5);
  }, 60_000);
});
