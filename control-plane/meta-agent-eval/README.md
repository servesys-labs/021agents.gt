# meta-agent eval harness

A fixed-input grader for the meta-agent. Runs canonical user messages through `runMetaChat` end-to-end against real Gemma, applies deterministic invariant checks, and grades the trimmed trace with an LLM-as-judge pass. Built to gate Phase 8/9 refactors of `meta-agent-chat.ts` — a byte-identity test cannot catch a semantic regression in tool selection, and this harness can.

## Running it

```sh
pnpm --filter control-plane eval
```

The harness is isolated from `pnpm --filter control-plane test` via its own `vitest.config.ts` (`include: ["**/*.eval.ts"]`), so the regular test suite never touches the AI Gateway.

## Required environment

The harness calls the real CF AI Gateway. Set these before running:

| Var                     | Purpose                                                  |
| ----------------------- | -------------------------------------------------------- |
| `CLOUDFLARE_ACCOUNT_ID` | AI Gateway account                                       |
| `AI_GATEWAY_ID`         | AI Gateway slug                                          |
| `AI_GATEWAY_TOKEN`      | Gateway bearer (or falls back to `CLOUDFLARE_API_TOKEN`) |
| `GPU_SERVICE_KEY`       | GPU origin bearer (or falls back to `SERVICE_TOKEN`)     |

Without `CLOUDFLARE_ACCOUNT_ID`, `AI_GATEWAY_ID`, and `GPU_SERVICE_KEY` / `SERVICE_TOKEN`, the whole suite auto-skips with a warning. CI is expected to inject them explicitly; local devs without staging access will simply see a skip.

## Layers

- **L1 — rule-based invariants** (`l1-checks.ts`). Deterministic. Reads the captured trace and asserts `required_tools` / `forbidden_tools` / `max_rounds` / `max_cost_usd`. Runs synchronously. Most Phase 8 regressions should trip here first.
- **L2 — LLM-as-judge** (`l2-judge.ts`). Semantic. Calls `gemma-4-31b` via the AI Gateway and scores the *trimmed* trace (user message + tool call names + final response, not the full turn history) on `{correctness, relevance, tool_selection}`. Per-fixture `judge_model` override escalates to Sonnet for calibration-sensitive cases.

## Adding a fixture

Append an entry to `fixtures/inputs.ts`. Each fixture is one `EvalFixture`:

```ts
{
  id: "stable-slug",
  mode: "live",
  agent_name: "test-research-agent",
  user_message: "What the user says.",
  judge_expected_behavior: "One paragraph for the judge describing what a good response looks like.",
  required_tools: [],
  forbidden_tools: ["update_agent_config"],
  max_rounds: 2,
  max_cost_usd: 0.01,
  min_judge_score: 3.5,
}
```

v1 fixtures are read-only / question-shape only. Mutation fixtures (anything that exercises `create_sub_agent`, `update_agent_config`, `manage_skills append_rule`) need the universe mock to grow write capture; that is v2 work.

If a fixture needs seed data that isn't in the shared universe, add it to `fixtures/universe.ts` — do **not** fork the seed. The shared universe is a correctness invariant: 20 fixtures × 5 bespoke mocks each is a maintenance disaster we're deliberately avoiding.

## Judge calibration tripwire

Gemma grading Gemma is self-referential; if the judge goes blind we need to notice. A calibration tripwire fixture (deliberately-bad response that must score low) will be added once the basic plumbing is green, and should stay in the suite permanently. If that fixture ever passes, escalate to Sonnet globally — a silent judge is worse than no judge.

## Why `meta-agent-eval/` and not `eval/`

The `/eval/` directory space is already used by `control-plane/src/routes/eval.ts` and a bunch of eval-run SQL. The harness directory name is deliberately distinct to avoid conceptual overlap.

## Thresholds

Per-fixture thresholds (`min_judge_score`, `max_cost_usd`, etc.) live inline in `fixtures/inputs.ts`. There are no baseline snapshot files in git — re-running the suite is cheap (self-hosted Gemma), and a committed baseline would become stale the moment the model weights update without the repo knowing. If the trajectory of real runs motivates a baseline file later, add it as `baselines/<ISO-date>.json` and gitignore; don't commit scores.
