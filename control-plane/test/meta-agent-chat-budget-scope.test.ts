/**
 * ToolCallBudget scope regression guard — runMetaChat end-to-end.
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ DO NOT DELETE THIS FILE                                              │
 * │                                                                      │
 * │ This test is the LOAD-BEARING regression guard for a specific bug    │
 * │ class: the `ToolCallBudget` instance in `runMetaChat` being           │
 * │ instantiated INSIDE the `while (round < MAX_TOOL_ROUNDS)` loop body   │
 * │ instead of OUTSIDE it.                                                │
 * │                                                                      │
 * │ The unit tests in `meta-agent-chat.test.ts` verify the                │
 * │ `ToolCallBudget` check/recordSuccess contract in isolation. They      │
 * │ CANNOT catch a scope regression at the call site, because they        │
 * │ instantiate the budget themselves. Only an integration test that     │
 * │ drives the real `runMetaChat` dispatch loop across multiple rounds    │
 * │ with a mocked LLM can observe the "does the count persist across     │
 * │ rounds?" property that the scope guarantees.                          │
 * │                                                                      │
 * │ If this test is deleted, a refactor that moves the budget             │
 * │ declaration inside the `while` loop would compile, pass all other    │
 * │ tests, and silently regress production — turning the per-TURN cap    │
 * │ of 5 into a per-ROUND cap of 5, effectively 5 × 8 = 40 per turn.     │
 * │                                                                      │
 * │ Keep this test. Keep the explicit DO-NOT-DELETE breadcrumb.           │
 * └─────────────────────────────────────────────────────────────────────┘
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

// ── Module mocks (hoisted by vitest before any import below) ─────────

// Mock the DB client so runMetaChat's agent-config read, session/turn
// writes, and tool-handler queries all no-op with empty results. The
// mock sql exposes `unsafe` and `begin` methods because the run_query
// tool uses `sql.unsafe(...)` for the SAVEPOINT/EXPLAIN pre-check and
// for the final execute, and withOrgDb uses sql.begin() internally.
import { buildDbClientMock, type MockSqlFn } from "./helpers/test-env";

// Define the shared mock sql as a callable that also has unsafe + begin.
// Individual tests can mutate query-specific behavior via mockImplementation.
const makeMockSql = () => {
  const handler = (async (_strings: TemplateStringsArray, ..._values: unknown[]) => []) as unknown as MockSqlFn;
  const augmented: any = Object.assign(handler, {
    unsafe: async (_q: string, _params?: unknown[], _opts?: unknown) => [],
    begin: async (fn: any) => fn(augmented),
  });
  return augmented;
};
let mockSql: any = makeMockSql();
vi.mock("../src/db/client", () => buildDbClientMock(() => mockSql));

// Mock the LLM gateway so we can control tool_calls per round.
// runMetaChat does `await import("../lib/llm-gateway")` inside the loop;
// vitest's module-level mock intercepts dynamic imports too.
vi.mock("../src/lib/llm-gateway", () => ({
  callLLMGateway: vi.fn(),
}));

// Mock the prompts module. `buildSystemPrompt` at meta-agent-chat.ts:2828
// does `require("../prompts/meta-agent-chat")` and RUNTIME_INFRASTRUCTURE_DOCS
// is dynamically imported inside the dispatch loop. Both paths hit this mock.
vi.mock("../src/prompts/meta-agent-chat", () => ({
  buildMetaAgentChatPrompt: () => "test-system-prompt",
  RUNTIME_INFRASTRUCTURE_DOCS: "test-infra-docs",
}));

// Imports AFTER mocks — vitest hoisting guarantees the mocks are in place.
import { runMetaChat, PER_TURN_TOOL_CAPS, TOOL_THROTTLED_PREFIX } from "../src/logic/meta-agent-chat";
import { callLLMGateway } from "../src/lib/llm-gateway";

// ── Helpers ───────────────────────────────────────────────────────────

type MockLLMTurn =
  | { content: string; tool_calls?: undefined }
  | { content: string; tool_calls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> };

function buildToolCalls(count: number, prefix: string): MockLLMTurn["tool_calls"] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}-${i}`,
    type: "function" as const,
    function: {
      name: "run_query",
      arguments: JSON.stringify({ query: `SELECT ${i} FROM sessions WHERE 1=0` }),
    },
  }));
}

function buildCtx(): any {
  return {
    agentName: "test-agent",
    orgId: "org-1",
    hyperdrive: {} as any,
    cloudflareAccountId: "",
    aiGatewayId: "",
    cloudflareApiToken: "",
    aiGatewayToken: "",
    gpuServiceKey: "",
    openrouterApiKey: "",
    mode: "live" as const,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("ToolCallBudget scope regression guard (runMetaChat integration)", () => {
  beforeEach(() => {
    mockSql = makeMockSql();
    vi.clearAllMocks();
  });

  it("per-turn cap persists across dispatch rounds (scope guard — DO NOT DELETE)", async () => {
    // Scenario: mock LLM returns 5 run_query calls in round 1 (all should
    // execute and consume the entire budget), then 3 more run_query calls
    // in round 2 (all should be throttled because the budget persists),
    // then a final text response to terminate the loop.
    //
    // Expected if budget scope is CORRECT (declared outside the while loop):
    //   - Round 1: 5 successful run_query executions
    //   - Round 2: 3 throttled results (all return TOOL_THROTTLED_PREFIX)
    //   - Round 3: terminating text response
    //   - result.tool_calls === 5 (throttled calls excluded)
    //
    // Expected if budget scope is WRONG (declared inside the while loop):
    //   - Round 1: 5 successful executions, count resets at top of round 2
    //   - Round 2: 3 more successful executions (budget reset)
    //   - result.tool_calls === 8
    //
    // The assertion `expect(result.tool_calls).toBe(5)` pins the correct
    // scope. A scope regression would set it to 8 and fail the test.

    const cap = PER_TURN_TOOL_CAPS.run_query;
    expect(cap).toBe(5); // sanity check — test math assumes cap=5

    const mockLLM = vi.mocked(callLLMGateway);
    let callIdx = 0;
    mockLLM.mockImplementation(async () => {
      callIdx++;
      if (callIdx === 1) {
        // Round 1 — 5 run_query calls. With cap=5, all execute.
        return {
          content: "",
          tool_calls: buildToolCalls(5, "r1"),
          usage: { prompt_tokens: 100, completion_tokens: 50 },
        } as any;
      }
      if (callIdx === 2) {
        // Round 2 — 3 more run_query calls. Budget is at 5/5 from round 1,
        // so all 3 should be throttled.
        return {
          content: "",
          tool_calls: buildToolCalls(3, "r2"),
          usage: { prompt_tokens: 80, completion_tokens: 40 },
        } as any;
      }
      // Round 3 — final text. Terminates the loop (no tool_calls).
      return {
        content: "finished",
        tool_calls: undefined,
        usage: { prompt_tokens: 60, completion_tokens: 20 },
      } as any;
    });

    const result = await runMetaChat(
      [{ role: "user", content: "run some queries" }],
      buildCtx(),
    );

    // LLM was called exactly 3 times (one per round). If this fails, the
    // loop terminated early or looped extra — indicates a bigger issue.
    expect(mockLLM).toHaveBeenCalledTimes(3);

    // THE SCOPE GUARANTEE. With correct per-turn budget scope, only round
    // 1's 5 calls execute. Round 2's 3 calls are throttled. `tool_calls`
    // counts successful executions only (throttled calls don't increment).
    expect(result.tool_calls).toBe(5);

    // Verify the three throttled tool results appear in the returned
    // message stream with the stable TOOL_THROTTLED_PREFIX. This double-
    // checks that the scope regression would be visible in TWO distinct
    // observation sites — tool_calls count AND tool_result messages.
    const toolResults = (result.messages || []).filter(
      (m: any) => m.role === "tool" && typeof m.content === "string",
    );
    const throttledResults = toolResults.filter((m: any) => {
      try {
        const parsed = JSON.parse(m.content);
        return typeof parsed.error === "string" && parsed.error.startsWith(TOOL_THROTTLED_PREFIX);
      } catch {
        return false;
      }
    });
    expect(throttledResults).toHaveLength(3);
    // And conversely, 5 tool results should NOT be throttled (round 1's).
    expect(toolResults.length - throttledResults.length).toBe(5);
  });

  it("per-turn cap uniformly allows up to cap in a single round (sanity)", async () => {
    // Parallel sanity test: if round 1 alone fires exactly `cap` calls
    // then a terminating text, all `cap` should execute and none should
    // be throttled. Catches a regression where check() incorrectly
    // throttles the Nth call instead of the (N+1)th.
    const cap = PER_TURN_TOOL_CAPS.run_query;
    const mockLLM = vi.mocked(callLLMGateway);
    let callIdx = 0;
    mockLLM.mockImplementation(async () => {
      callIdx++;
      if (callIdx === 1) {
        return {
          content: "",
          tool_calls: buildToolCalls(cap, "r1"),
          usage: { prompt_tokens: 50, completion_tokens: 30 },
        } as any;
      }
      return {
        content: "done",
        tool_calls: undefined,
        usage: { prompt_tokens: 30, completion_tokens: 10 },
      } as any;
    });

    const result = await runMetaChat(
      [{ role: "user", content: "hi" }],
      buildCtx(),
    );

    expect(result.tool_calls).toBe(cap);
    const toolResults = (result.messages || []).filter(
      (m: any) => m.role === "tool" && typeof m.content === "string",
    );
    const throttled = toolResults.filter((m: any) => {
      try {
        const parsed = JSON.parse(m.content);
        return typeof parsed.error === "string" && parsed.error.startsWith(TOOL_THROTTLED_PREFIX);
      } catch {
        return false;
      }
    });
    expect(throttled).toHaveLength(0);
  });
});
