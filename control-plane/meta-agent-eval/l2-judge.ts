// L2 — LLM-as-judge for the meta-agent eval harness.
//
// Grades a trimmed trace (user message + tool-call names + final
// response) on {correctness, relevance, tool_selection}, each 0-5.
// Default judge is gemma-4-31b — same model class that runs the
// production meta-agent for free/basic plans. Per-fixture override
// available for calibration-sensitive cases (escalate to Sonnet).
//
// Intentionally does NOT pass the full turn trace — the judge gets
// only what a reviewer would see at a glance: what was asked, what
// tools were touched, what the user got back. Keeps judge cost flat
// and forces the grader to score the user-visible artifact, not the
// internal wiring.

import { callLLMGateway, type GatewayConfig } from "../src/lib/llm-gateway";
import type { TraceSummary } from "./l1-checks";

export interface JudgeScores {
  correctness: number;
  relevance: number;
  tool_selection: number;
  notes: string;
}

export interface JudgeResult {
  scores: JudgeScores;
  average: number;
  raw: string;
  judge_model: string;
}

const DEFAULT_JUDGE_MODEL = "gemma-4-31b";

const JUDGE_SYSTEM_PROMPT = `You are an impartial grader for a meta-agent system. You will be shown:

1. A user's message to the meta-agent
2. A one-paragraph description of the expected behavior
3. The names of any tools the meta-agent called (in order)
4. The meta-agent's final text response

Score the response on three dimensions, each 0-5:

- correctness: Does the response accurately address the user's question? (0 = wrong or misleading, 5 = fully correct)
- relevance: Is the response on-topic and appropriately scoped? (0 = off-topic, 5 = perfectly scoped)
- tool_selection: Were tools used appropriately? (0 = wrong tools or wrong time, 5 = ideal tool use — including "correctly called no tools")

Return ONLY a JSON object with this exact shape and no prose around it:

{"correctness": 0-5, "relevance": 0-5, "tool_selection": 0-5, "notes": "one short sentence"}`;

function buildJudgeUserMessage(
  userMessage: string,
  expectedBehavior: string,
  summary: TraceSummary,
): string {
  const toolList = summary.tool_call_names.length === 0
    ? "(no tools called)"
    : summary.tool_call_names.join(", ");
  return [
    `USER MESSAGE:\n${userMessage}`,
    `EXPECTED BEHAVIOR:\n${expectedBehavior}`,
    `TOOLS CALLED:\n${toolList}`,
    `FINAL RESPONSE:\n${summary.final_response}`,
  ].join("\n\n");
}

function parseScores(raw: string): JudgeScores {
  // Tolerate models that wrap JSON in prose or code fences. Extract the
  // first balanced object and parse it.
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`judge response contained no JSON object: ${raw.slice(0, 200)}`);
  }
  const jsonStr = raw.slice(start, end + 1);
  const parsed = JSON.parse(jsonStr) as Partial<JudgeScores>;
  const pick = (v: unknown): number => {
    const n = typeof v === "number" ? v : Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 5) {
      throw new Error(`judge returned out-of-range score: ${String(v)}`);
    }
    return n;
  };
  return {
    correctness: pick(parsed.correctness),
    relevance: pick(parsed.relevance),
    tool_selection: pick(parsed.tool_selection),
    notes: typeof parsed.notes === "string" ? parsed.notes : "",
  };
}

export async function judgeTrace(
  config: GatewayConfig,
  userMessage: string,
  expectedBehavior: string,
  summary: TraceSummary,
  judgeModel: string = DEFAULT_JUDGE_MODEL,
): Promise<JudgeResult> {
  const llmResult = await callLLMGateway(config, {
    model: judgeModel,
    messages: [
      { role: "system", content: JUDGE_SYSTEM_PROMPT },
      { role: "user", content: buildJudgeUserMessage(userMessage, expectedBehavior, summary) },
    ],
    // Gemma-4 emits reasoning_content that counts against max_tokens.
    // A tight budget (256) leaves nothing for the final JSON object
    // after the model's internal reasoning phase. 2048 gives room for
    // both reasoning and the scorecard JSON without being wasteful.
    max_tokens: 2048,
    temperature: 0,
    timeout_ms: 60_000,
    metadata: { agent: "meta-agent-eval-judge" },
  });

  const raw = llmResult.content ?? "";
  const scores = parseScores(raw);
  const average = (scores.correctness + scores.relevance + scores.tool_selection) / 3;

  return { scores, average, raw, judge_model: judgeModel };
}
