import { describe, expect, it, vi } from "vitest";

let shouldFail = true;
let sqlCallCount = 0;

vi.mock("postgres", () => {
  return {
    default: () => {
      const tag = async () => {
        sqlCallCount += 1;
        if (shouldFail) throw new Error("mock db unavailable");
        return [];
      };
      return tag;
    },
  };
});

import { getCircuitBreakerState, writeTurn } from "../src/runtime/db";

describe("db circuit breaker integration", () => {
  it("opens after 5 failures and recovers after cooldown", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);

    const turn = {
      session_id: "sess-cb-1",
      turn_number: 1,
      model_used: "test/model",
      input_tokens: 1,
      output_tokens: 1,
      latency_ms: 1,
      llm_content: "x",
      cost_total_usd: 0.001,
      tool_calls: "[]",
      tool_results: "[]",
      errors: "[]",
      execution_mode: "sequential",
    };

    for (let i = 0; i < 5; i++) {
      await writeTurn({} as any, turn);
    }
    const opened = getCircuitBreakerState();
    expect(opened.open).toBe(true);
    expect(opened.failures).toBeGreaterThanOrEqual(5);

    const callsBeforeShortCircuit = sqlCallCount;
    await writeTurn({} as any, turn);
    expect(sqlCallCount).toBe(callsBeforeShortCircuit);

    now += 31_000;
    shouldFail = false;
    await writeTurn({} as any, turn);
    const recovered = getCircuitBreakerState();
    expect(recovered.open).toBe(false);
    expect(recovered.failures).toBe(0);
    expect(sqlCallCount).toBe(callsBeforeShortCircuit + 1);
  });
});
