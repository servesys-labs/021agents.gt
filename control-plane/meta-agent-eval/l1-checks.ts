// L1 — rule-based invariant checker for meta-agent eval fixtures.
// Runs synchronously on a captured runMetaChat trace, before the slower
// LLM-judge pass. Failures here are deterministic regressions and should
// be the primary signal for Phase 8/9 refactor gates.

import type { MetaChatMessage } from "../src/logic/meta-agent-chat";
import type { EvalFixture } from "./fixtures/inputs";

export interface TraceSummary {
  tool_call_names: string[];
  rounds: number;
  cost_usd: number;
  final_response: string;
}

export interface L1Result {
  passed: boolean;
  failures: string[];
  summary: TraceSummary;
}

/** Extract a canonical trace summary from runMetaChat's output messages. */
export function summarizeTrace(
  outputMessages: MetaChatMessage[],
  meta: { cost_usd?: number; turns?: number },
): TraceSummary {
  const tool_call_names: string[] = [];
  for (const msg of outputMessages) {
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        tool_call_names.push(tc.function.name);
      }
    }
  }
  // Final response = content of the last assistant message without tool_calls,
  // or the last assistant message's content if all have tool_calls.
  let final_response = "";
  for (let i = outputMessages.length - 1; i >= 0; i--) {
    const m = outputMessages[i];
    if (m.role === "assistant") {
      if (!m.tool_calls || m.tool_calls.length === 0) {
        final_response = m.content || "";
        break;
      }
      if (!final_response) final_response = m.content || "";
    }
  }
  return {
    tool_call_names,
    rounds: meta.turns ?? 0,
    cost_usd: meta.cost_usd ?? 0,
    final_response,
  };
}

/** Run all L1 invariants declared on a fixture. */
export function runL1Checks(fixture: EvalFixture, summary: TraceSummary): L1Result {
  const failures: string[] = [];

  for (const required of fixture.required_tools) {
    if (!summary.tool_call_names.includes(required)) {
      failures.push(`required tool "${required}" was never called`);
    }
  }

  for (const forbidden of fixture.forbidden_tools) {
    if (summary.tool_call_names.includes(forbidden)) {
      failures.push(`forbidden tool "${forbidden}" was called`);
    }
  }

  if (summary.rounds > fixture.max_rounds) {
    failures.push(`rounds ${summary.rounds} > max_rounds ${fixture.max_rounds}`);
  }

  if (summary.cost_usd > fixture.max_cost_usd) {
    failures.push(
      `cost ${summary.cost_usd.toFixed(6)} > max_cost_usd ${fixture.max_cost_usd}`,
    );
  }

  if (!summary.final_response || summary.final_response.trim().length === 0) {
    failures.push("final response was empty");
  }

  return { passed: failures.length === 0, failures, summary };
}
