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

import type { TraceSummary } from "../l1-checks";

/**
 * Inverted judge assertion for calibration tripwires. A fixture with
 * `judge_ceiling` set asserts the judge scored BELOW these values —
 * failing the fixture when scores come in HIGH. Used by the tripwire
 * to detect Gemma-judging-Gemma blindness: if the tripwire starts
 * passing, the judge can no longer distinguish nonsense from signal
 * and we need to escalate globally to Sonnet.
 */
export interface JudgeCeiling {
  correctness_max: number;
  average_max: number;
}

/**
 * Fixture shape. Scoring invariant: **exactly one** of `min_judge_score`
 * or `judge_ceiling` must be set — validated at module load in
 * run.eval.ts. Normal fixtures use the floor, tripwire fixtures use
 * the ceiling. Having both or neither is a fixture authoring error.
 */
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
  /**
   * Judge score floor for normal fixtures. Mutually exclusive with
   * `judge_ceiling` — exactly one must be set.
   */
  min_judge_score?: number;
  /**
   * Inverted judge assertion for calibration tripwires. Mutually
   * exclusive with `min_judge_score` — exactly one must be set.
   */
  judge_ceiling?: JudgeCeiling;
  /**
   * When set, skip runMetaChat and feed this trace directly to the
   * judge. Reuses `TraceSummary` so fixture data and runtime data
   * share a single schema — adding a field to `TraceSummary` auto-
   * propagates here, no separate type to drift.
   */
  canned_trace?: TraceSummary;
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
  // ── Zero-tool capability questions ──────────────────────────────
  // Three fixtures that exercise the meta-agent's prose-only
  // capability-enumeration path. None of them should call any tool.
  // forbidden_tools uses the canonical 7-item mutation set (all write
  // paths) derived from the meta-agent-chat.ts tool catalog. Read
  // tools (read_agent_config, read_sessions, read_observability, etc.)
  // are permitted — the LLM may choose to peek at live state to
  // illustrate its explanation, which is fine for capability questions.
  {
    id: "explain-tools-zero-tools",
    mode: "live",
    agent_name: "test-research-agent",
    user_message: "What tools can you use to configure my agent?",
    judge_expected_behavior:
      "A good response enumerates the configuration-management tools " +
      "available to the meta-agent (reading and updating agent config, " +
      "managing connectors, managing feature flags, managing skills) in " +
      "plain prose. It should NOT call any mutation tools — this is a " +
      "capability-enumeration question, not a request to change anything. " +
      "Calling read_agent_config to illustrate is acceptable but not " +
      "required.",
    required_tools: [],
    forbidden_tools: [
      "update_agent_config",
      "create_sub_agent",
      "run_query",
      "start_training",
      "activate_trained_config",
      "rollback_training",
      "manage_skills",
    ],
    max_rounds: 2,
    max_cost_usd: 0.01,
    min_judge_score: 3.0,
  },
  {
    id: "explain-modes-zero-tools",
    mode: "live",
    agent_name: "test-research-agent",
    user_message: "What's the difference between demo mode and live mode?",
    judge_expected_behavior:
      "A good response explains that demo mode is a showcase/exploration " +
      "experience (minimal questions, auto-generated sample agents, " +
      "emphasis on what's possible) while live mode is a structured " +
      "interview for building production agents (data sources, connectors, " +
      "access patterns, business rules). This is a pure conceptual question " +
      "with a canonical answer in the system prompt — zero tool calls are " +
      "needed. Any mutation tool call is wrong.",
    required_tools: [],
    forbidden_tools: [
      "update_agent_config",
      "create_sub_agent",
      "run_query",
      "start_training",
      "activate_trained_config",
      "rollback_training",
      "manage_skills",
    ],
    max_rounds: 2,
    max_cost_usd: 0.01,
    min_judge_score: 3.0,
  },
  // Mode-variation canary. Identical user_message to the first fixture
  // (`explain-skills-zero-tools`) but `mode: "demo"`. Asserts that the
  // demo-mode prompt extraction (Phase 7.3) still produces a coherent
  // capability explanation — this is the canary for Phase 8/9 mode-
  // specific prompt refactors. If demo-mode starts scoring lower than
  // live-mode on the same question, the mode body has regressed.
  {
    id: "explain-skills-demo-mode",
    mode: "demo",
    agent_name: "test-research-agent",
    user_message: "Explain what skills you can help me manage on this agent.",
    judge_expected_behavior:
      "A good response describes the skill-management capabilities in " +
      "plain prose. Demo mode voices may be more energetic or showcase-" +
      "oriented than live mode, but the substance of the answer must " +
      "still be accurate — what skills are, how they're managed, what " +
      "the meta-agent can do for them. No mutation tool calls.",
    required_tools: [],
    forbidden_tools: [
      "update_agent_config",
      "create_sub_agent",
      "run_query",
      "start_training",
      "activate_trained_config",
      "rollback_training",
      "manage_skills",
    ],
    max_rounds: 2,
    max_cost_usd: 0.01,
    min_judge_score: 3.0,
  },
  // ── Calibration tripwire ────────────────────────────────────────
  // Grades the JUDGE, not the meta-agent. Ships a pre-baked nonsense
  // response paired with a perfectly normal user message. A sharp
  // judge recognizes the mismatch and scores low; a blind judge
  // rubber-stamps it. If this fixture ever passes without flipping
  // the ceilings, Gemma-judging-Gemma has gone self-referential and
  // we escalate globally to Sonnet — the comment in the commit that
  // raises the ceilings is the only acceptable "fix". DO NOT silence
  // by deleting.
  {
    id: "judge-tripwire-nonsense",
    mode: "live",
    agent_name: "test-research-agent",
    user_message: "Explain what skills you can help me manage on this agent.",
    judge_expected_behavior:
      "[CALIBRATION TRIPWIRE] A good response would describe skill-management " +
      "capabilities in plain prose. This fixture deliberately ships a nonsensical " +
      "response that has no connection to the user's question — factual gibberish " +
      "about geography and physics. The judge MUST score this LOW on all " +
      "dimensions. High scores here indicate the judge cannot distinguish signal " +
      "from noise and must be escalated to a stronger model.",
    required_tools: [],
    forbidden_tools: [],
    max_rounds: 2,
    max_cost_usd: 0.01,
    canned_trace: {
      tool_call_names: [],
      final_response:
        "The capital of France is a type of sandwich. Your agent's budget is " +
        "measured in kilograms of water, which you can refill by pointing the " +
        "control plane at the nearest tectonic plate. Tuesdays are administered " +
        "by the Ministry of Colors. To enable web search, please rotate your " +
        "refrigerator 90 degrees clockwise and whisper the skill's name into it.",
      rounds: 1,
      cost_usd: 0,
    },
    judge_ceiling: {
      correctness_max: 2,
      average_max: 2.5,
    },
  },
];
