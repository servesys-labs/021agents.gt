// Shared stateful SQL mock for the meta-agent eval harness. All fixtures
// run against this one seeded universe so upstream schema changes have a
// single update point. Intentionally self-contained — does not import
// from control-plane/test/helpers/ so the harness can be typechecked
// and run in isolation from the main test suite.
//
// v1 scope: read-only fixtures only. The mock returns sensible data for
// SELECTs and empty arrays for anything unknown — tool dispatch that
// exercises a mutation will silently no-op, and the L1 `forbidden_tools`
// check is responsible for catching unwanted mutation attempts before
// they matter.

export type MockSqlFn = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<unknown>;

/**
 * Build a minimal `vi.mock` factory for `../src/db/client`. Forwards
 * every `withOrgDb` / `withAdminDb` call to the shared mockSql closure.
 * The harness uses this in place of the full buildDbClientMock helper
 * so meta-agent-eval stays independent of test/helpers/.
 */
export function buildEvalDbClientMock(getSql: () => MockSqlFn): Record<string, unknown> {
  const withOrgDb = async (_env: unknown, _orgId: unknown, fn: (sql: unknown) => Promise<unknown>) =>
    fn(getSql());
  const withAdminDb = async (_env: unknown, fn: (sql: unknown) => Promise<unknown>) =>
    fn(getSql());
  return {
    withOrgDb,
    withAdminDb,
    getDb: async () => getSql(),
    getDbForOrg: async () => getSql(),
    OrgSql: null,
    AdminSql: null,
    Sql: null,
  };
}

// Canonical agent config used across all fixtures. Set `plan: "free"` so
// runMetaChat's plan lookup routes to Gemma — though the harness also sets
// `ctx.modelPath = "gemma"` explicitly, making this a belt-and-braces.
const SEED_AGENT_CONFIG = {
  system_prompt: "You are a helpful research assistant.",
  model: "gemma-4-31b",
  plan: "free",
  provider: "cloudflare",
  tools: ["web-search", "read_file"],
  blocked_tools: [],
  max_turns: 20,
  budget_limit_usd: 1.0,
  parallel_tool_calls: false,
  reasoning_strategy: "",
  governance: { budget_limit_usd: 1.0 },
  version: "0.1.0",
};

const SEED_AGENT_ROW = {
  name: "test-research-agent",
  org_id: "eval-org",
  config: JSON.stringify(SEED_AGENT_CONFIG),
  description: "Canonical research agent seeded for the meta-agent eval harness.",
  is_active: true,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-04-01T00:00:00Z",
};

// Session detail rows matching read_sessions' SELECT column list at
// meta-agent-chat.ts case "read_sessions": session_id, model, status,
// step_count, action_count, input_text, output_text, cost_total_usd,
// wall_clock_seconds, created_at, ended_at.
//
// Two rows — one healthy (success, fast, cheap), one slow (success
// but long wall clock) — so a meta-agent asked "how are my recent
// sessions" can talk about variance rather than homogeneous data.
const SEED_SESSIONS: Array<Record<string, unknown>> = [
  {
    session_id: "sess-eval-001",
    agent_name: "test-research-agent",
    org_id: "eval-org",
    model: "gemma-4-31b",
    status: "success",
    step_count: 4,
    action_count: 3,
    input_text: "Summarize the top 3 findings in the latest arxiv paper on RLHF.",
    output_text: "The paper presents three main findings: (1) reward model drift during training, (2) the role of KL penalties in preventing mode collapse, and (3) empirical scaling laws for preference data.",
    cost_total_usd: 0.0042,
    wall_clock_seconds: 11.2,
    created_at: "2026-04-10T14:30:00Z",
    ended_at: "2026-04-10T14:30:11Z",
  },
  {
    session_id: "sess-eval-002",
    agent_name: "test-research-agent",
    org_id: "eval-org",
    model: "gemma-4-31b",
    status: "success",
    step_count: 12,
    action_count: 18,
    input_text: "Find and summarize all the recent papers about diffusion model sampling efficiency.",
    output_text: "Reviewed 7 recent papers. Key themes: DPM++ variants, consistency models, flow matching...",
    cost_total_usd: 0.0189,
    wall_clock_seconds: 47.8,
    created_at: "2026-04-10T17:15:00Z",
    ended_at: "2026-04-10T17:15:48Z",
  },
];

// Audit log rows matching read_audit_log's SELECT column list at
// meta-agent-chat.ts case "read_audit_log": actor_id, action,
// resource_type, resource_name, details, created_at. WHERE clause
// requires resource_name = agent_name OR resource_type in
// ('feature_flag', 'training'), so all rows here target the canonical
// test agent.
const SEED_AUDIT_LOG: Array<Record<string, unknown>> = [
  {
    actor_id: "user-alice",
    action: "update_config",
    resource_type: "agent",
    resource_name: "test-research-agent",
    details: JSON.stringify({ field: "system_prompt", change: "added domain guidance" }),
    created_at: "2026-04-09T10:00:00Z",
  },
  {
    actor_id: "user-bob",
    action: "update_config",
    resource_type: "agent",
    resource_name: "test-research-agent",
    details: JSON.stringify({ field: "tools", change: "added web-search" }),
    created_at: "2026-04-08T16:22:00Z",
  },
  {
    actor_id: "user-alice",
    action: "set_feature_flag",
    resource_type: "feature_flag",
    resource_name: "context_compression",
    details: JSON.stringify({ flag: "context_compression", enabled: true }),
    created_at: "2026-04-07T09:15:00Z",
  },
];

// Turn-level aggregate row for read_observability's primary turn-stats
// query. Column set exactly matches the SELECT list in the tool handler
// at meta-agent-chat.ts case "read_observability": total_turns,
// active_sessions, avg_latency_ms, p50/p95/p99_latency_ms, etc.
//
// Values chosen to be plausibly realistic for a lightly-loaded research
// agent: 124 turns, avg 3.4s, p95 11.2s, p99 24.5s, 3 error turns. This
// gives the meta-agent real signal to reason from ("your p99 latency is
// 7x the p50") instead of empty zeros that cause it to spiral into
// run_query drill-down.
const SEED_TURN_STATS = {
  total_turns: 124,
  active_sessions: 18,
  avg_latency_ms: 3420,
  p50_latency_ms: 2800,
  p95_latency_ms: 11200,
  p99_latency_ms: 24500,
  avg_llm_latency_ms: 2950,
  total_input_tokens: 48920,
  total_output_tokens: 9840,
  total_cache_read_tokens: 12400,
  total_cache_write_tokens: 3200,
  refusal_count: 0,
  error_turn_count: 3,
};

// Session-level aggregate row for read_observability's session-stats
// query. Matches the SELECT list: total_sessions, success_count,
// error_count, avg_duration_s, avg_steps, avg_tool_calls, total_cost_usd.
const SEED_SESSION_STATS = {
  total_sessions: 18,
  success_count: 16,
  error_count: 2,
  avg_duration_s: 28.4,
  avg_steps: 6.2,
  avg_tool_calls: 4.1,
  total_cost_usd: 0.142,
};

const SEED_SKILLS_LIST = [
  { name: "diarize", scope: "public", min_plan: "free" },
  { name: "improve", scope: "public", min_plan: "free" },
];

/** Record of every SQL call made through this mock, in order. */
export interface RecordedCall {
  query: string;
  params: unknown[];
}

/** Create a fresh mock SQL instance with its own call log. */
export function createUniverseSqlMock(): { sql: MockSqlFn; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];

  const handler = async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<unknown[]> => {
    const query = strings.join("?");
    calls.push({ query, params: values });

    // Dispatch is ordered most-specific first. Patterns key on
    // distinctive SQL fragments from the real tool handlers at
    // control-plane/src/logic/meta-agent-chat.ts. When adding a new
    // fixture that hits an unseeded query shape, add the matcher
    // here rather than extending an existing clause.

    // read_agent_config, update_agent_config, analyze_and_suggest,
    // create_sub_agent — all SELECT from agents filtered by name.
    if (query.includes("FROM agents") && query.includes("WHERE name")) {
      return [SEED_AGENT_ROW];
    }
    // read_sessions detail query — distinctive SELECT column list
    // (session_id, model, status, step_count, action_count, ...).
    // Must come before the aggregate checks because read_observability
    // ALSO queries FROM sessions in its session-stats sub-query.
    if (query.includes("session_id, model, status, step_count")) {
      return SEED_SESSIONS;
    }
    // read_observability turn-stats aggregate. Distinctive by the
    // "COUNT(*) as total_turns" prefix. Must come before any generic
    // `FROM turns` matcher if one gets added later.
    if (query.includes("COUNT(*) as total_turns")) {
      return [SEED_TURN_STATS];
    }
    // read_observability session-stats aggregate. Distinctive by the
    // "COUNT(*) as total_sessions" prefix.
    if (query.includes("COUNT(*) as total_sessions")) {
      return [SEED_SESSION_STATS];
    }
    // read_audit_log — distinctive column set, real schema fields.
    if (query.includes("FROM audit_log")) {
      return SEED_AUDIT_LOG;
    }
    // Skills listing + overlays (unchanged from v1).
    if (query.includes("skill_overlays") || query.includes("FROM skills")) {
      return SEED_SKILLS_LIST;
    }
    // Everything else (read_observability aggregates against turns
    // + sessions + billing_records + session_feedback; mine_session_
    // failures against turns; read_session_diagnostics against turns
    // + sessions; eval_runs; feature_flags) returns empty. The tools
    // handle empty gracefully — read_observability emits zeros,
    // read_session_diagnostics returns "no events found", etc. The
    // L1 check is the enforcement layer for tool misuse, not the
    // mock's data shape.
    return [];
  };

  // `unsafe` and `begin` used by run_query and transactional writes.
  // Both record the call and return empty so the harness doesn't
  // explode on exotic paths.
  const sql = Object.assign(handler, {
    unsafe: async (q: string, _params: unknown[] = [], _opts: unknown = {}) => {
      calls.push({ query: q, params: [] });
      return [] as unknown[];
    },
    begin: async (fn: (tx: unknown) => Promise<unknown>) => fn(handler),
  }) as unknown as MockSqlFn;

  return { sql, calls };
}
