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

const SEED_EVOLUTION_REPORT = {
  agent_name: "test-research-agent",
  org_id: "eval-org",
  report: JSON.stringify({
    failure_clusters: [],
    recent_runs: 12,
    success_rate: 0.92,
    avg_cost_usd: 0.008,
    suggestions: [],
  }),
  created_at: "2026-04-01T12:00:00Z",
};

const SEED_SESSION_DIAGNOSTICS = {
  agent_name: "test-research-agent",
  total_sessions: 42,
  active_sessions: 0,
  avg_duration_ms: 14_200,
  p95_duration_ms: 28_400,
  error_rate: 0.02,
  last_activity: "2026-04-10T18:23:00Z",
};

const SEED_AUDIT_LOG: Array<Record<string, unknown>> = [
  {
    id: "audit-1",
    actor: "user@test.example",
    action: "update_config",
    target: "test-research-agent",
    created_at: "2026-04-09T10:00:00Z",
  },
];

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

    // Plan lookup — runMetaChat's first DB call, at the top of every turn.
    if (query.includes("FROM agents") && query.includes("WHERE name")) {
      return [SEED_AGENT_ROW];
    }
    // Evolution analyzer / recent runs
    if (query.includes("evolution_reports") || query.includes("failure_clusters")) {
      return [SEED_EVOLUTION_REPORT];
    }
    // Session diagnostics
    if (query.includes("session_diagnostics") || query.includes("FROM sessions")) {
      return [SEED_SESSION_DIAGNOSTICS];
    }
    // Audit log window
    if (query.includes("audit_log")) {
      return SEED_AUDIT_LOG;
    }
    // Skills listing + overlays
    if (query.includes("skill_overlays") || query.includes("FROM skills")) {
      return SEED_SKILLS_LIST;
    }
    // Anything else — empty result. Tool dispatch sees "no data" and
    // either responds gracefully or moves on. The L1 check catches
    // unexpected tool calls before they turn into noise.
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
