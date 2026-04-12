// Canonical fixture set for the meta-agent eval harness.
//
// Each entry is one user message run end-to-end through runMetaChat
// against a real Gemma call. v1 ships read-only/question-shape fixtures
// only; mutation fixtures (create_sub_agent, update_agent_config) are
// deferred to v2 once the universe mock grows write capture.
//
// Adding a fixture: append a new entry here. If it needs a different
// judge model, set `judge_model`. If it needs a different seeded agent
// state, extend `fixtures/universe.ts` — don't fork the seed.

export interface EvalFixture {
  /** Stable slug — referenced in baseline diffs and CI output. */
  id: string;
  mode: "demo" | "live";
  agent_name: string;
  user_message: string;
  /** One-paragraph hint to the LLM judge about what a good response looks like. */
  judge_expected_behavior: string;
  /** Override the default `gemma-4-31b` judge for specific calibration cases. */
  judge_model?: string;
  // ── L1 rule-based invariants ──────────────────────────────────
  /** Tool names that MUST appear in the trace. Empty = no requirement. */
  required_tools: string[];
  /** Tool names that MUST NOT appear. A match fails the fixture. */
  forbidden_tools: string[];
  /** Upper bound on runMetaChat's internal round counter (≤ 8 by default). */
  max_rounds: number;
  /** Hard cap on cumulative USD cost for this single run. */
  max_cost_usd: number;
  /** Judge score floor — average across {correctness, relevance, tool_selection}, 0-5. */
  min_judge_score: number;
}

export const FIXTURES: EvalFixture[] = [
  {
    id: "explain-skills-zero-tools",
    mode: "live",
    agent_name: "test-research-agent",
    user_message: "Explain what skills you can help me manage on this agent.",
    judge_expected_behavior:
      "A good response describes the skill-management capabilities available " +
      "through the meta-agent (reading skills, appending rules, reverting " +
      "rules) in plain prose. It does NOT call any tools — this is a " +
      "capability-explanation question, not a request for live data. It does " +
      "NOT propose config changes, create sub-agents, or run SQL queries.",
    required_tools: [],
    forbidden_tools: [
      "update_agent_config",
      "create_sub_agent",
      "run_query",
      "start_training",
    ],
    max_rounds: 2,
    max_cost_usd: 0.01,
    min_judge_score: 3.0,
  },
];
