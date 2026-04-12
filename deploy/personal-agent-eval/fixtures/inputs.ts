/**
 * Personal agent eval fixtures.
 *
 * Each fixture tests a specific capability of the personal agent with
 * the lean Phase 10 prompt on Gemma 4. Fixtures are prompt-only (no
 * runtime) — they test "does the model follow the prompt correctly"
 * by sending the system prompt + user message to Gemma and judging
 * the response.
 *
 * v1: 8 fixtures covering core capabilities. No tool execution —
 * only checks whether the model's TEXT response and TOOL CALL NAMES
 * are appropriate.
 */

export interface EvalFixture {
  id: string;
  user_message: string;
  judge_expected_behavior: string;
  /** Tool names that MUST appear in tool_calls. Empty = no requirement. */
  required_tools: string[];
  /** Tool names that MUST NOT appear. */
  forbidden_tools: string[];
  /** Minimum judge score (average of correctness, relevance, tool_selection). */
  min_judge_score: number;
  /** If true, the fixture expects NO tool calls — pure prose response. */
  expect_no_tools?: boolean;
}

export const FIXTURES: EvalFixture[] = [
  // ── Trivial question (should NOT call tools) ──────────────────
  {
    id: "trivial-no-tools",
    user_message: "What's the capital of France?",
    judge_expected_behavior:
      "A good response answers 'Paris' in plain text with no tool calls. " +
      "The prompt says trivial one-line questions should be answered in " +
      "plain text only — no web-search, no memory-save.",
    required_tools: [],
    forbidden_tools: ["execute-code", "discover-api"],
    min_judge_score: 4.0,
    expect_no_tools: true,
  },
  // ── Research task (should use tools) ──────────────────────────
  {
    id: "research-with-tools",
    user_message: "What are the latest developments in quantum computing?",
    judge_expected_behavior:
      "A good response either calls execute-code to orchestrate web searches " +
      "or describes a plan to search the web. The agent should indicate it " +
      "will use tools to find current information rather than answering from " +
      "training data alone. Should NOT just answer from memory for a " +
      "'latest developments' question.",
    required_tools: [],
    forbidden_tools: [],
    min_judge_score: 3.5,
  },
  // ── Memory recall at session start ────────────────────────────
  {
    id: "session-start-memory-recall",
    user_message: "Hey, what were we working on last time?",
    judge_expected_behavior:
      "A good response acknowledges this is a session-start message and " +
      "indicates it will check memory (memory-recall or execute-code to " +
      "recall). The prompt mandates: 'ALWAYS call memory-recall at the " +
      "very start of every new session.' The agent should NOT fabricate " +
      "previous work without checking memory first.",
    required_tools: [],
    forbidden_tools: [],
    min_judge_score: 3.5,
  },
  // ── Planning heuristic (complex task → plan first) ────────────
  {
    id: "complex-task-plan-first",
    user_message:
      "Build me a REST API in TypeScript that has user authentication, " +
      "a database connection, CRUD endpoints for a blog, and deploy it.",
    judge_expected_behavior:
      "A good response starts with a visible plan/checklist before calling " +
      "any tools. The prompt says 'Plan first (4+ tool calls): output a " +
      "brief plan as a checklist.' This is clearly a 4+ step task. The " +
      "agent should NOT jump directly into tool calls without planning.",
    required_tools: [],
    forbidden_tools: [],
    min_judge_score: 3.5,
  },
  // ── Simple task → execute immediately (no plan) ───────────────
  {
    id: "simple-task-no-plan",
    user_message: "What time is it in Tokyo right now?",
    judge_expected_behavior:
      "A good response either answers directly (if the model knows) or " +
      "calls a tool to find the current time. The prompt says 'Execute " +
      "immediately (1-3 tool calls): just do it.' This is a 1-step task. " +
      "The agent should NOT output a multi-step plan for this.",
    required_tools: [],
    forbidden_tools: [],
    min_judge_score: 3.5,
  },
  // ── Delegation to meta-agent ──────────────────────────────────
  {
    id: "delegate-to-meta-agent",
    user_message: "Create a new customer support agent for my business.",
    judge_expected_behavior:
      "A good response recognizes this as an agent-management task and " +
      "indicates it will delegate to the meta-agent. The prompt says: " +
      "'Delegate to meta-agent when the user wants to manage agents: " +
      "create, configure, test, train, diagnose.' The agent should NOT " +
      "try to create an agent directly — it should delegate.",
    required_tools: [],
    forbidden_tools: [],
    min_judge_score: 3.5,
  },
  // ── Communication style (no filler) ───────────────────────────
  {
    id: "no-filler-greeting",
    user_message: "Summarize the key differences between REST and GraphQL.",
    judge_expected_behavior:
      "A good response starts directly with the content — NOT with " +
      "greetings like 'Hello!', 'Sure!', 'Great question!', or " +
      "'Of course!'. The prompt explicitly says 'NEVER start responses " +
      "with greetings or filler.' The response should also be concise " +
      "and well-structured with headings or bullets.",
    required_tools: [],
    forbidden_tools: [],
    min_judge_score: 3.5,
    expect_no_tools: true,
  },
  // ── Calibration tripwire (bad response → judge must score low) ─
  {
    id: "judge-tripwire",
    user_message: "How do I set up a cron job to run every morning at 8am?",
    judge_expected_behavior:
      "[CALIBRATION TRIPWIRE] A good response would explain cron syntax " +
      "and show how to use create-schedule. This fixture ships a nonsense " +
      "response that has no connection to the question. The judge MUST " +
      "score this LOW.",
    required_tools: [],
    forbidden_tools: [],
    min_judge_score: -1, // Special: uses ceiling, not floor
  },
];
