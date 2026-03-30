/**
 * Edge Runtime — Supabase DB adapter via Hyperdrive.
 *
 * Loads agent configs, writes sessions/turns/events directly.
 * Uses postgres.js (same driver as queue consumer).
 * All writes use idempotency keys to handle retries safely.
 */

import type { AgentConfig, TurnResult, RuntimeEvent } from "./types";
import { applyDeployPolicyToConfigJson } from "./deploy-policy-contract";
import type postgres from "postgres";

type Sql = ReturnType<typeof postgres>;

/**
 * Get a Postgres connection via Hyperdrive.
 * Creates a fresh connection per call — Hyperdrive handles pooling server-side.
 */
export async function getDb(hyperdrive: Hyperdrive): Promise<Sql> {
  const pg = (await import("postgres")).default;
  return pg(hyperdrive.connectionString, {
    max: 1,
    fetch_types: false,
    prepare: false,  // Hyperdrive requires prepare:false (transaction-mode pooling)
    idle_timeout: 5,
    connect_timeout: 3,
  });
}

/** No-op — Hyperdrive manages connection lifecycle. */
export async function closeDb(): Promise<void> {}

// ── Agent Config Loading ──────────────────────────────────────

/**
 * Load agent config from Supabase `agents` table.
 * Falls back to defaults if agent not found.
 */
export async function loadAgentConfig(
  hyperdrive: Hyperdrive,
  agentName: string,
  defaults: { provider: string; model: string; plan: string },
): Promise<AgentConfig> {
  // Default core tools when none are configured — must match TOOL_CATALOG names
  const DEFAULT_TOOLS = [
    "web-search", "browse", "http-request", "web-crawl",
    "python-exec", "bash",
    "read-file", "write-file", "edit-file",
    "knowledge-search", "store-knowledge",
    "create-agent", "list-agents", "run-agent",
    "marketplace-search", "a2a-send", "feed-post",
    "image-generate", "vision-analyze",
    "memory-save", "memory-recall",
    "text-to-speech", "mcp-call",
    "save-project", "load-project",
    "create-schedule", "list-schedules", "delete-schedule",
  ];

  let rows: any[] = [];
  let dbFailed = false;
  try {
    const sql = await getDb(hyperdrive);
    rows = await sql`
      SELECT name, org_id, project_id, config_json, description
      FROM agents
      WHERE name = ${agentName} AND is_active = 1
      LIMIT 1
    `;
  } catch (err) {
    dbFailed = true;
    console.error(`[DB] loadAgentConfig failed for ${agentName}: ${err instanceof Error ? err.message : err}`);
  }

  if (rows.length === 0) {
    if (dbFailed) {
      // DB error — return MINIMAL tools to prevent privilege escalation.
      // A restricted agent must not gain full access because of a transient DB failure.
      console.warn(`[DB] Returning restricted defaults for ${agentName} due to DB error`);
      return {
        agent_name: agentName,
        system_prompt: "You are a helpful AI assistant. Note: your configuration could not be loaded from the database. Some features may be limited.",
        provider: defaults.provider,
        model: defaults.model,
        plan: defaults.plan,
        max_turns: 10,
        budget_limit_usd: 1.0,
        tools: [],  // empty = only discover-api available
        blocked_tools: [],
        allowed_domains: [],
        blocked_domains: [],
        max_tokens_per_turn: 0,
        require_confirmation_for_destructive: true,
        parallel_tool_calls: false,
        require_human_approval: false,
        org_id: "",
        project_id: "",
      };
    }
    // Agent genuinely not in DB — return full defaults for development/onboarding
    return {
      agent_name: agentName,
      system_prompt: "You are a helpful AI assistant. You have access to tools including web search, Python code execution, file operations, and more. Use your tools proactively to help the user — always search for real data instead of guessing.",
      provider: defaults.provider,
      model: defaults.model,
      plan: defaults.plan,
      max_turns: 50,
      budget_limit_usd: 10.0,
      tools: DEFAULT_TOOLS,
      blocked_tools: [],
      allowed_domains: [],
      blocked_domains: [],
      max_tokens_per_turn: 0,
      require_confirmation_for_destructive: false,
      parallel_tool_calls: true,
      require_human_approval: false,
      org_id: "",
      project_id: "",
    };
  }

  const row = rows[0];
  const cfg = parseJson(row.config_json) || {};
  const governance = parseJson(cfg.governance) || {};
  const cfgRec = cfg as Record<string, unknown>;
  const policyAttach = applyDeployPolicyToConfigJson(cfgRec, { fallbackStripOverlay: true });
  if (!policyAttach.ok) {
    console.warn(
      `[DB] deploy_policy could not be attached for ${agentName}: ${policyAttach.errors.join("; ")}`,
    );
  }

  // Tools come from config_json (no top-level tools column in DB)
  const cfgTools = parseJsonArray(cfg.tools);
  let mergedTools = cfgTools;

  // Default core tools when none are configured
  if (mergedTools.length === 0) {
    mergedTools = DEFAULT_TOOLS;
  }

  // ── Runtime Config Validation ──────────────────────────────
  // Validate and warn on bad config — don't crash, but log so operators can fix.
  const KNOWN_PROVIDERS = new Set(["openrouter", "workers-ai", "anthropic", "openai", "google"]);
  const resolvedProvider = String(cfg.provider || defaults.provider);
  const resolvedModel = String(cfg.model || defaults.model);
  if (resolvedProvider && !KNOWN_PROVIDERS.has(resolvedProvider) && !resolvedProvider.includes("/")) {
    console.warn(`[config:${agentName}] Unknown provider '${resolvedProvider}' — may fail at LLM call`);
  }
  if (resolvedModel && !resolvedModel.includes("/") && !resolvedModel.startsWith("@cf/")) {
    console.warn(`[config:${agentName}] Model '${resolvedModel}' missing provider prefix (e.g. 'openai/gpt-5.4-mini') — may fail at LLM call`);
  }
  const VALID_PLANS = new Set(["basic", "standard", "premium"]);
  const resolvedPlan = String(cfg.plan || defaults.plan);
  if (resolvedPlan && !VALID_PLANS.has(resolvedPlan)) {
    console.warn(`[config:${agentName}] Unknown plan '${resolvedPlan}' — falling back to 'standard' routing`);
  }

  return {
    agent_name: row.name || agentName,
    system_prompt: String(cfg.system_prompt || cfg.systemPrompt || row.description || "You are a helpful AI assistant."),
    provider: String(cfg.provider || defaults.provider),
    model: String(cfg.model || defaults.model),
    plan: String(cfg.plan || defaults.plan),
    max_turns: toInt(cfg.max_turns ?? cfg.maxTurns, 50),
    budget_limit_usd: toFloat(cfg.budget_limit_usd ?? cfg.budgetLimitUsd ?? governance.budget_limit_usd, 10.0),
    tools: mergedTools,
    blocked_tools: parseJsonArray(cfg.blocked_tools || cfg.blockedTools || governance.blocked_tools),
    allowed_domains: parseJsonArray(cfg.allowed_domains || cfg.allowedDomains || governance.allowed_domains),
    blocked_domains: parseJsonArray(cfg.blocked_domains || cfg.blockedDomains || governance.blocked_domains),
    deploy_policy: policyAttach.ok ? (cfgRec.deploy_policy as AgentConfig["deploy_policy"]) : undefined,
    max_tokens_per_turn: toInt(cfg.max_tokens_per_turn ?? governance.max_tokens_per_turn, 0),
    require_confirmation_for_destructive:
      cfg.require_confirmation_for_destructive === true
      || governance.require_confirmation_for_destructive === true,
    parallel_tool_calls: cfg.parallel_tool_calls !== false && cfg.parallelToolCalls !== false,
    require_human_approval:
      cfg.require_human_approval === true
      || cfg.requireHumanApproval === true
      || governance.require_human_approval === true,
    org_id: row.org_id || "",
    project_id: row.project_id || "",
    state_reducers: parseJson(cfg.state_reducers || cfg.stateReducers),
    routing: parseJson(cfg.routing),
    codemode_middleware: parseJson(cfg.codemode_middleware || cfg.codemodeMiddleware),
    codemode_observability: cfg.codemode_observability || cfg.codemodeObservability || undefined,
    use_code_mode: cfg.use_code_mode === true || cfg.useCodeMode === true,
    reasoning_strategy: cfg.reasoning_strategy || cfg.reasoningStrategy || undefined,
  };
}

// ── Plan Routing Tables ──────────────────────────────────────
// Embedded from config/default.json — the edge runtime doesn't read JSON files.
// If the agent has a plan but no routing overrides, resolve the plan to a routing table.

// Model IDs use AI Gateway /compat/ format:
//   Workers AI:  @cf/provider/model  (normalizeModelId adds workers-ai/ prefix)
//   Anthropic:   anthropic/model-name (native Anthropic IDs, hyphens not dots)
//   OpenAI:      openai/model-name
//   Google:      google-ai-studio/model-name
//   DeepSeek:    deepseek/model-name
// All paid models route through AI Gateway → OpenRouter (single OPENROUTER key).
// Workers AI models (@cf/) route through AI Gateway directly (CF account token).
// No max_tokens — let models decide their output length.

// Simplified plan routing — one primary model per plan, no per-task classification.
// The model handles all task types (coding, research, creative, etc.)
// Agent can override with config_json.model for specific use cases.
const PLAN_ROUTING: Record<string, Record<string, Record<string, { model: string; provider: string }>>> = {
  // ── Basic: Free Workers AI models (edge, no cost) ──
  basic: {
    general: {
      simple: { model: "@cf/moonshotai/kimi-k2.5", provider: "workers-ai" },
      moderate: { model: "@cf/moonshotai/kimi-k2.5", provider: "workers-ai" },
      complex: { model: "@cf/moonshotai/kimi-k2.5", provider: "workers-ai" },
      tool_call: { model: "@cf/moonshotai/kimi-k2.5", provider: "workers-ai" },
    },
    multimodal: { vision: { model: "@cf/moonshotai/kimi-k2.5", provider: "workers-ai" } },
  },
  // ── Standard: Claude Sonnet 4.6 for everything ──
  standard: {
    general: {
      simple: { model: "anthropic/claude-sonnet-4-6", provider: "openrouter" },
      moderate: { model: "anthropic/claude-sonnet-4-6", provider: "openrouter" },
      complex: { model: "anthropic/claude-sonnet-4-6", provider: "openrouter" },
      tool_call: { model: "anthropic/claude-sonnet-4-6", provider: "openrouter" },
    },
    multimodal: { vision: { model: "anthropic/claude-sonnet-4-6", provider: "openrouter" } },
  },
  // ── Premium: Claude Opus 4.6 for everything ──
  premium: {
    general: {
      simple: { model: "anthropic/claude-sonnet-4-6", provider: "openrouter" },
      moderate: { model: "anthropic/claude-opus-4-6", provider: "openrouter" },
      complex: { model: "anthropic/claude-opus-4-6", provider: "openrouter" },
      tool_call: { model: "anthropic/claude-sonnet-4-6", provider: "openrouter" },
    },
    multimodal: { vision: { model: "anthropic/claude-opus-4-6", provider: "openrouter" } },
  },
};

/**
 * Resolve an agent's plan to its routing table.
 * If the agent has explicit routing overrides in config_json, those win.
 * Otherwise, look up the plan name in PLAN_ROUTING.
 */
export function resolvePlanRouting(
  plan: string,
  agentRouting: Record<string, any> | undefined,
): Record<string, any> | undefined {
  // Agent-level overrides take priority
  if (agentRouting && Object.keys(agentRouting).length > 0) {
    return agentRouting;
  }
  // Look up plan
  const normalized = (plan || "standard").toLowerCase().trim();
  return PLAN_ROUTING[normalized] || PLAN_ROUTING["standard"];
}

// ── Session Persistence ───────────────────────────────────────

export async function writeSession(
  hyperdrive: Hyperdrive,
  session: {
    session_id: string;
    org_id: string;
    project_id: string;
    agent_name: string;
    status: string;
    input_text: string;
    output_text: string;
    model: string;
    trace_id: string;
    step_count: number;
    action_count: number;
    wall_clock_seconds: number;
    cost_total_usd: number;
    parent_session_id?: string;
    depth?: number;
  },
): Promise<void> {
  const sql = await getDb(hyperdrive);
  await sql`
    INSERT INTO sessions (
      session_id, org_id, project_id, agent_name, status,
      input_text, output_text, model, trace_id, parent_session_id,
      depth, step_count, action_count, wall_clock_seconds,
      cost_total_usd, created_at
    ) VALUES (
      ${session.session_id}, ${session.org_id}, ${session.project_id},
      ${session.agent_name}, ${session.status},
      ${session.input_text}, ${session.output_text},
      ${session.model}, ${session.trace_id}, ${session.parent_session_id || ""},
      ${Number(session.depth) || 0}, ${session.step_count}, ${session.action_count},
      ${session.wall_clock_seconds}, ${session.cost_total_usd},
      ${new Date().toISOString()}
    ) ON CONFLICT (session_id) DO UPDATE SET
      status = EXCLUDED.status,
      output_text = EXCLUDED.output_text,
      cost_total_usd = EXCLUDED.cost_total_usd,
      step_count = EXCLUDED.step_count,
      wall_clock_seconds = EXCLUDED.wall_clock_seconds
  `;
}

export async function writeTurn(
  hyperdrive: Hyperdrive,
  turn: {
    session_id: string;
    turn_number: number;
    model_used: string;
    input_tokens: number;
    output_tokens: number;
    latency_ms: number;
    llm_content: string;
    cost_total_usd: number;
    tool_calls_json: string;
    tool_results_json: string;
    errors_json: string;
    execution_mode: string;
  },
): Promise<void> {
  const sql = await getDb(hyperdrive);
  await sql`
    INSERT INTO turns (
      session_id, turn_number, model_used, input_tokens, output_tokens,
      latency_ms, llm_content, cost_total_usd,
      tool_calls_json, tool_results_json, errors_json,
      execution_mode, plan_json, reflection_json
    ) VALUES (
      ${turn.session_id}, ${turn.turn_number}, ${turn.model_used},
      ${turn.input_tokens}, ${turn.output_tokens},
      ${turn.latency_ms}, ${turn.llm_content}, ${turn.cost_total_usd},
      ${turn.tool_calls_json}, ${turn.tool_results_json}, ${turn.errors_json},
      ${turn.execution_mode}, '{}', '{}'
    )
  `;
}

export async function writeEvent(
  hyperdrive: Hyperdrive,
  event: {
    session_id: string;
    turn: number;
    event_type: string;
    action: string;
    plan: string;
    provider: string;
    model: string;
    tool_name: string;
    status: string;
    latency_ms: number;
    input_tokens: number;
    output_tokens: number;
    cost_usd: number;
    details_json: string;
    created_at?: number;
  },
): Promise<void> {
  const sql = await getDb(hyperdrive);
  await sql`
    INSERT INTO otel_events (
      session_id, turn, event_type, action, plan, tier,
      provider, model, tool_name, status, latency_ms,
      input_tokens, output_tokens, cost_usd, details_json, created_at
    ) VALUES (
      ${event.session_id}, ${event.turn}, ${event.event_type},
      ${event.action}, ${event.plan}, '',
      ${event.provider}, ${event.model}, ${event.tool_name},
      ${event.status}, ${event.latency_ms},
      ${event.input_tokens}, ${event.output_tokens}, ${event.cost_usd},
      ${event.details_json},
      ${event.created_at ? (typeof event.created_at === "string" && String(event.created_at).includes("T") ? event.created_at : new Date(Number(event.created_at) * 1000).toISOString()) : new Date().toISOString()}
    )
  `;
}

// ── Billing ───────────────────────────────────────────────────

export async function writeBillingRecord(
  hyperdrive: Hyperdrive,
  record: {
    session_id: string;
    org_id: string;
    agent_name: string;
    model: string;
    input_tokens: number;
    output_tokens: number;
    cost_usd: number;
    plan: string;
    trace_id?: string;
    /** Portal user, end-user id, or channel user id (from RunRequest.channel_user_id). */
    billing_user_id?: string;
    /** API keys table key_id when the run used API key auth. */
    api_key_id?: string;
  },
): Promise<void> {
  const sql = await getDb(hyperdrive);
  const sessionId = String(record.session_id ?? "").trim();
  const orgId = String(record.org_id ?? "").trim();
  if (!orgId) return;

  const traceId = String(record.trace_id ?? sessionId).trim() || sessionId;
  const billingUserId = String(record.billing_user_id ?? "").trim();
  const apiKeyId = String(record.api_key_id ?? "").trim();

  try {
    if (sessionId) {
      const dup = await sql`
        SELECT 1 FROM billing_records
        WHERE org_id = ${orgId} AND session_id = ${sessionId} AND cost_type = 'inference'
        LIMIT 1
      `;
      if (dup.length > 0) return;
    }

    await sql`
      INSERT INTO billing_records (
        org_id, customer_id, agent_name, billing_user_id, api_key_id, cost_type, description,
        model, provider, input_tokens, output_tokens,
        inference_cost_usd, total_cost_usd,
        session_id, trace_id, pricing_source, pricing_key, unit, quantity, unit_price_usd
      ) VALUES (
        ${orgId}, '', ${record.agent_name}, ${billingUserId}, ${apiKeyId}, 'inference',
        ${sessionId ? `Edge session ${sessionId}` : "Edge session"},
        ${record.model}, '',
        ${record.input_tokens}, ${record.output_tokens},
        ${record.cost_usd}, ${record.cost_usd},
        ${sessionId}, ${traceId},
        'fallback_env', ${`edge:${record.plan || "standard"}`}, 'session', 1, ${record.cost_usd}
      )
    `;
  } catch (err) {
    console.error("[writeBillingRecord] billing_records insert failed, retrying...", err);
    // Retry once after 1s — billing records are critical for revenue
    try {
      await new Promise(r => setTimeout(r, 1000));
      const retrySql = await getDb(hyperdrive);
      await retrySql`
        INSERT INTO billing_records (
          org_id, customer_id, agent_name, billing_user_id, api_key_id, cost_type, description,
          model, provider, input_tokens, output_tokens,
          inference_cost_usd, total_cost_usd,
          session_id, trace_id, pricing_source, pricing_key, unit, quantity, unit_price_usd
        ) VALUES (
          ${orgId}, '', ${record.agent_name}, ${billingUserId}, ${apiKeyId}, 'inference',
          ${sessionId ? `Edge session ${sessionId} (retry)` : "Edge session (retry)"},
          ${record.model}, '',
          ${record.input_tokens}, ${record.output_tokens},
          ${record.cost_usd}, ${record.cost_usd},
          ${sessionId}, ${traceId},
          'fallback_env', ${`edge:${record.plan || "standard"}`}, 'session', 1, ${record.cost_usd}
        )
      `;
    } catch (retryErr) {
      console.error("[writeBillingRecord] RETRY ALSO FAILED — billing record lost", retryErr);
    }
  }

  // Legacy metering table (optional schema) — non-fatal
  try {
    await sql`
      INSERT INTO billing_events (
        session_id, org_id, agent_name, model,
        input_tokens, output_tokens, cost_usd, plan, created_at
      ) VALUES (
        ${sessionId}, ${orgId}, ${record.agent_name},
        ${record.model}, ${record.input_tokens}, ${record.output_tokens},
        ${record.cost_usd}, ${record.plan}, ${new Date().toISOString()}
      )
    `;
  } catch {
    /* billing_events may be missing or different shape */
  }
}

// ── Eval Trials ───────────────────────────────────────────────

export async function writeEvalRun(
  hyperdrive: Hyperdrive,
  run: {
    agent_name: string;
    eval_name: string;
    total_tasks: number;
    total_trials: number;
    pass_count: number;
    fail_count: number;
    error_count: number;
    pass_rate: number;
    avg_score: number;
    avg_latency_ms: number;
    total_cost_usd: number;
    eval_conditions_json: string;
  },
): Promise<number> {
  const sql = await getDb(hyperdrive);
  // Try richer schema first, then degrade to the smaller shape.
  try {
    const rows = await sql<{ id: number }[]>`
      INSERT INTO eval_runs (
        agent_name, benchmark_name, protocol,
        total_tasks, total_trials, pass_count, fail_count, error_count,
        pass_rate, avg_score, avg_latency_ms, total_cost_usd,
        eval_conditions_json, created_at
      ) VALUES (
        ${run.agent_name}, ${run.eval_name}, ${"edge_runtime"},
        ${run.total_tasks}, ${run.total_trials}, ${run.pass_count}, ${run.fail_count}, ${run.error_count},
        ${run.pass_rate}, ${run.avg_score}, ${run.avg_latency_ms}, ${run.total_cost_usd},
        ${run.eval_conditions_json}, ${new Date().toISOString()}
      )
      RETURNING id
    `;
    return Number(rows?.[0]?.id || 0);
  } catch {
    try {
      const rows = await sql<{ id: number }[]>`
        INSERT INTO eval_runs (
          agent_name, total_tasks, total_trials, pass_rate,
          avg_score, avg_latency_ms, total_cost_usd, created_at
        ) VALUES (
          ${run.agent_name}, ${run.total_tasks}, ${run.total_trials}, ${run.pass_rate},
          ${run.avg_score}, ${run.avg_latency_ms}, ${run.total_cost_usd}, ${new Date().toISOString()}
        )
        RETURNING id
      `;
      return Number(rows?.[0]?.id || 0);
    } catch {
      return 0;
    }
  }
}

export async function writeEvalTrial(
  hyperdrive: Hyperdrive,
  trial: {
    eval_run_id?: number;
    eval_name: string;
    agent_name: string;
    trial_index: number;
    passed: boolean;
    score: number;
    details_json: string;
    trace_id: string;
    session_id: string;
  },
): Promise<void> {
  const sql = await getDb(hyperdrive);
  // Best-effort — eval_trials schema may differ across environments.
  try {
    await sql`
      INSERT INTO eval_trials (
        eval_run_id, eval_name, agent_name, trial_index, passed, score, details_json,
        trace_id, session_id, created_at
      ) VALUES (
        ${Number(trial.eval_run_id) || 0}, ${trial.eval_name}, ${trial.agent_name}, ${trial.trial_index},
        ${trial.passed}, ${trial.score}, ${trial.details_json},
        ${trial.trace_id}, ${trial.session_id}, ${new Date().toISOString()}
      )
    `;
    return;
  } catch {
    // Fall through to schemas without eval_run_id.
  }
  try {
    await sql`
      INSERT INTO eval_trials (
        eval_name, agent_name, trial_index, passed, score, details_json,
        trace_id, session_id, created_at
      ) VALUES (
        ${trial.eval_name}, ${trial.agent_name}, ${trial.trial_index},
        ${trial.passed}, ${trial.score}, ${trial.details_json},
        ${trial.trace_id}, ${trial.session_id}, ${new Date().toISOString()}
      )
    `;
  } catch {
    // Non-fatal for runtime execution.
  }
}

export async function listEvalRuns(
  hyperdrive: Hyperdrive,
  opts: { agent_name?: string; limit?: number } = {},
): Promise<Array<Record<string, unknown>>> {
  const sql = await getDb(hyperdrive);
  const limit = Math.max(1, Math.min(Number(opts.limit) || 20, 200));
  const agentName = String(opts.agent_name || "").trim();
  try {
    const rows = agentName
      ? await sql`
        SELECT id, agent_name, pass_rate, avg_score, avg_latency_ms, total_cost_usd, total_tasks, total_trials
        FROM eval_runs
        WHERE agent_name = ${agentName}
        ORDER BY created_at DESC
        LIMIT ${limit}
      `
      : await sql`
        SELECT id, agent_name, pass_rate, avg_score, avg_latency_ms, total_cost_usd, total_tasks, total_trials
        FROM eval_runs
        ORDER BY created_at DESC
        LIMIT ${limit}
      `;
    return rows.map((r: any) => ({
      run_id: Number(r.id || 0),
      agent_name: String(r.agent_name || ""),
      pass_rate: Number(r.pass_rate || 0),
      avg_score: Number(r.avg_score || 0),
      avg_latency_ms: Number(r.avg_latency_ms || 0),
      total_cost_usd: Number(r.total_cost_usd || 0),
      total_tasks: Number(r.total_tasks || 0),
      total_trials: Number(r.total_trials || 0),
    }));
  } catch {
    return [];
  }
}

export async function getEvalRun(
  hyperdrive: Hyperdrive,
  runId: number,
): Promise<Record<string, unknown> | null> {
  const sql = await getDb(hyperdrive);
  const rid = Math.max(0, Math.floor(Number(runId) || 0));
  if (rid <= 0) return null;
  try {
    const rows = await sql`
      SELECT *
      FROM eval_runs
      WHERE id = ${rid}
      LIMIT 1
    `;
    if (!rows.length) return null;
    const row: Record<string, unknown> = { ...rows[0] };
    const out: Record<string, unknown> = {
      run_id: Number((row.id as number) || 0),
      ...row,
    };
    try {
      const raw = out.eval_conditions_json;
      out.eval_conditions = typeof raw === "string" ? JSON.parse(raw) : (raw || {});
    } catch {
      out.eval_conditions = {};
    }
    return out;
  } catch {
    return null;
  }
}

export async function listEvalTrialsByRun(
  hyperdrive: Hyperdrive,
  runId: number,
): Promise<Array<Record<string, unknown>>> {
  const sql = await getDb(hyperdrive);
  const rid = Math.max(0, Math.floor(Number(runId) || 0));
  if (rid <= 0) return [];
  try {
    const rows = await sql`
      SELECT *
      FROM eval_trials
      WHERE eval_run_id = ${rid}
      ORDER BY trial_index ASC, id ASC
    `;
    return rows.map((row: any) => {
      const out: Record<string, unknown> = { ...row };
      try {
        const raw = out.details_json;
        out.details = typeof raw === "string" ? JSON.parse(raw) : (raw || {});
      } catch {
        out.details = {};
      }
      return out;
    });
  } catch {
    return [];
  }
}

// ── Runtime Event Replay (LangSmith-style timelines) ─────────

type OtelEventRow = {
  id?: number;
  session_id: string;
  turn_number: number;
  event_type: string;
  details_json: string;
  created_at: string | number;
  trace_id?: string;
};

function otelRowToRuntimeEvent(
  row: OtelEventRow,
  fallbackTraceId: string,
  fallbackSessionId: string,
): RuntimeEvent {
  const data = parseJson(row.details_json) || {};
  const eventTraceId = String(
    (data.trace_id as string | undefined) || row.trace_id || fallbackTraceId || "",
  );
  const rawTs = row.created_at as string | number | undefined;
  const numTs = Number(rawTs);
  const ts = Number.isFinite(numTs) && numTs > 0
    ? numTs * 1000
    : Date.parse(String(rawTs || ""));
  return {
    event_id: row.id ? `otel_${row.id}` : crypto.randomUUID().replace(/-/g, "").slice(0, 16),
    event_type: String(row.event_type || "error") as RuntimeEvent["event_type"],
    trace_id: eventTraceId,
    session_id: String(row.session_id || fallbackSessionId),
    turn: Number(row.turn_number) || 0,
    data,
    timestamp: Number.isNaN(ts) ? Date.now() : ts,
    source: String((data.source as string | undefined) || "edge_runtime"),
  };
}

function foldStateSnapshotFromRuntimeEvents(events: RuntimeEvent[]): Record<string, unknown> {
  let latest: Record<string, unknown> = {};
  for (const ev of events) {
    const snap = ev.data?.state_snapshot;
    if (snap && typeof snap === "object" && !Array.isArray(snap) && Object.keys(snap).length > 0) {
      latest = { ...(snap as Record<string, unknown>) };
    }
  }
  return latest;
}

function parseOtelUpperBoundFromEventId(eventId: string): number {
  const s = String(eventId || "").trim();
  if (!s) return 0;
  if (s.startsWith("otel_")) {
    return Math.max(0, Number.parseInt(s.slice(5), 10) || 0);
  }
  const n = Number.parseInt(s, 10);
  return n > 0 ? n : 0;
}

export interface TraceReplayAtCursor {
  trace_id: string;
  session_id: string;
  cursor_row_id: number;
  cursor_index: number;
  event_count: number;
  state_snapshot: Record<string, unknown>;
  event_at_cursor: RuntimeEvent | null;
  events: RuntimeEvent[];
  has_more: boolean;
  next_row_id: number | null;
  next_cursor_index: number | null;
  watermark_row_id: number;
  watermark_event_count: number;
}

/**
 * Time-travel replay over ``otel_events``: deterministic ``id ASC`` ordering, state from latest
 * ``data.state_snapshot`` in the prefix. Cursor precedence matches backend SQLite helper.
 */
export async function replayOtelEventsAtCursor(
  hyperdrive: Hyperdrive,
  opts: {
    session_id?: string;
    trace_id?: string;
    up_to_row_id?: number;
    cursor_index?: number;
    event_id?: string;
    include_events?: boolean;
    max_scan?: number;
  },
): Promise<TraceReplayAtCursor> {
  const sql = await getDb(hyperdrive);
  const sessionId = String(opts.session_id || "").trim();
  const traceId = String(opts.trace_id || "").trim();
  const empty = (): TraceReplayAtCursor => ({
    trace_id: traceId,
    session_id: sessionId,
    cursor_row_id: 0,
    cursor_index: -1,
    event_count: 0,
    state_snapshot: {},
    event_at_cursor: null,
    events: [],
    has_more: false,
    next_row_id: null,
    next_cursor_index: null,
    watermark_row_id: 0,
    watermark_event_count: 0,
  });
  if (!sessionId && !traceId) return empty();

  const safeScan = Math.max(1, Math.min(Number(opts.max_scan) || 10000, 50000));
  const upFromExplicit = Math.max(0, Math.floor(Number(opts.up_to_row_id) || 0));
  const evBound = parseOtelUpperBoundFromEventId(String(opts.event_id || ""));
  const upToRowId = upFromExplicit > 0 ? upFromExplicit : evBound;
  const cidx = Math.floor(Number(opts.cursor_index) ?? -1);
  const includeEvents = Boolean(opts.include_events);

  try {
    let rows: OtelEventRow[] = [];
    let watermark = 0;
    let totalCount = 0;
    let outTrace = traceId;
    let outSession = sessionId;

    if (sessionId) {
      const statRows = await sql<{ cnt: string | number | null; max_id: number | null }[]>`
        SELECT COUNT(*) AS cnt, MAX(id) AS max_id FROM otel_events WHERE session_id = ${sessionId}
      `;
      totalCount = Number(statRows?.[0]?.cnt || 0);
      watermark = Number(statRows?.[0]?.max_id || 0);

      if (upToRowId > 0) {
        rows = await sql`
          SELECT e.id, e.session_id, e.turn AS turn_number, e.event_type, e.details_json, e.created_at, s.trace_id
          FROM otel_events e
          LEFT JOIN sessions s ON s.session_id = e.session_id
          WHERE e.session_id = ${sessionId} AND e.id <= ${upToRowId}
          ORDER BY e.id ASC
        `;
      } else if (cidx >= 0) {
        const lim = Math.min(cidx + 1, safeScan);
        rows = await sql`
          SELECT e.id, e.session_id, e.turn AS turn_number, e.event_type, e.details_json, e.created_at, s.trace_id
          FROM otel_events e
          LEFT JOIN sessions s ON s.session_id = e.session_id
          WHERE e.session_id = ${sessionId}
          ORDER BY e.id ASC
          LIMIT ${lim}
        `;
      } else {
        rows = await sql`
          SELECT e.id, e.session_id, e.turn AS turn_number, e.event_type, e.details_json, e.created_at, s.trace_id
          FROM otel_events e
          LEFT JOIN sessions s ON s.session_id = e.session_id
          WHERE e.session_id = ${sessionId}
          ORDER BY e.id ASC
          LIMIT ${safeScan}
        `;
      }
      const first = rows[0] as OtelEventRow | undefined;
      if (first?.trace_id) outTrace = String(first.trace_id);
    } else if (traceId) {
      const statRows = await sql<{ cnt: string | number | null; max_id: number | null }[]>`
        SELECT COUNT(*) AS cnt, MAX(e.id) AS max_id
        FROM otel_events e
        INNER JOIN sessions s ON s.session_id = e.session_id
        WHERE s.trace_id = ${traceId}
      `;
      totalCount = Number(statRows?.[0]?.cnt || 0);
      watermark = Number(statRows?.[0]?.max_id || 0);

      if (upToRowId > 0) {
        rows = await sql`
          SELECT e.id, e.session_id, e.turn AS turn_number, e.event_type, e.details_json, e.created_at, s.trace_id
          FROM otel_events e
          INNER JOIN sessions s ON s.session_id = e.session_id
          WHERE s.trace_id = ${traceId} AND e.id <= ${upToRowId}
          ORDER BY e.id ASC
        `;
      } else if (cidx >= 0) {
        const lim = Math.min(cidx + 1, safeScan);
        rows = await sql`
          SELECT e.id, e.session_id, e.turn AS turn_number, e.event_type, e.details_json, e.created_at, s.trace_id
          FROM otel_events e
          INNER JOIN sessions s ON s.session_id = e.session_id
          WHERE s.trace_id = ${traceId}
          ORDER BY e.id ASC
          LIMIT ${lim}
        `;
      } else {
        rows = await sql`
          SELECT e.id, e.session_id, e.turn AS turn_number, e.event_type, e.details_json, e.created_at, s.trace_id
          FROM otel_events e
          INNER JOIN sessions s ON s.session_id = e.session_id
          WHERE s.trace_id = ${traceId}
          ORDER BY e.id ASC
          LIMIT ${safeScan}
        `;
      }
      const first = rows[0] as OtelEventRow | undefined;
      if (first?.session_id) outSession = String(first.session_id);
    }

    const events = (rows as OtelEventRow[]).map((r) =>
      otelRowToRuntimeEvent(r, outTrace, outSession),
    );
    const stateSnapshot = foldStateSnapshotFromRuntimeEvents(events);
    const last = events.length > 0 ? events[events.length - 1]! : null;
    const lastRow = rows.length > 0 ? (rows[rows.length - 1] as OtelEventRow) : undefined;
    const cursorRowId = Number(lastRow?.id || 0);
    const cursorIndex = events.length > 0 ? events.length - 1 : -1;

    let hasMore = false;
    let nextRowId: number | null = null;
    let nextCursorIndex: number | null = null;
    if (events.length > 0 && watermark > 0 && cursorRowId > 0 && cursorRowId < watermark) {
      hasMore = true;
      if (sessionId) {
        const n = await sql<{ n: number | null }[]>`
          SELECT MIN(id) AS n FROM otel_events WHERE session_id = ${sessionId} AND id > ${cursorRowId}
        `;
        nextRowId = n?.[0]?.n != null ? Number(n[0].n) : null;
      } else {
        const n = await sql<{ n: number | null }[]>`
          SELECT MIN(e.id) AS n
          FROM otel_events e
          INNER JOIN sessions s ON s.session_id = e.session_id
          WHERE s.trace_id = ${traceId} AND e.id > ${cursorRowId}
        `;
        nextRowId = n?.[0]?.n != null ? Number(n[0].n) : null;
      }
      if (nextRowId != null && cursorIndex >= 0) nextCursorIndex = cursorIndex + 1;
    } else if (events.length > 0 && totalCount > events.length) {
      hasMore = true;
      if (cursorIndex >= 0) nextCursorIndex = cursorIndex + 1;
    }

    return {
      trace_id: outTrace,
      session_id: outSession,
      cursor_row_id: cursorRowId,
      cursor_index: cursorIndex,
      event_count: events.length,
      state_snapshot: stateSnapshot,
      event_at_cursor: last,
      events: includeEvents ? events : [],
      has_more: hasMore,
      next_row_id: nextRowId,
      next_cursor_index: nextCursorIndex,
      watermark_row_id: watermark,
      watermark_event_count: totalCount,
    };
  } catch {
    return empty();
  }
}

/**
 * Load persisted runtime events for a session or trace.
 * Reads from `otel_events` and reconstructs RuntimeEvent envelopes.
 */
export async function loadRuntimeEvents(
  hyperdrive: Hyperdrive,
  opts: {
    session_id?: string;
    trace_id?: string;
    limit?: number;
    event_type?: string;
    tool_name?: string;
    status?: string;
    from_ts_ms?: number;
    to_ts_ms?: number;
  },
): Promise<RuntimeEvent[]> {
  const sql = await getDb(hyperdrive);
  const limit = Math.max(1, Math.min(Number(opts.limit) || 1000, 5000));
  const sessionId = String(opts.session_id || "").trim();
  const traceId = String(opts.trace_id || "").trim();
  const eventType = String(opts.event_type || "").trim();
  const toolName = String(opts.tool_name || "").trim();
  const status = String(opts.status || "").trim();
  const fromTsMs = Math.max(0, Number(opts.from_ts_ms) || 0);
  const toTsMs = Math.max(0, Number(opts.to_ts_ms) || 0);

  type EventRow = {
    id?: number;
    session_id: string;
    turn_number: number;
    event_type: string;
    details_json: string;
    created_at: string | number;
    trace_id?: string;
  };

  let rows: EventRow[] = [];
  if (sessionId) {
    rows = await sql`
      SELECT
        e.id, e.session_id, e.turn AS turn_number, e.event_type,
        e.details_json, e.created_at, s.trace_id
      FROM otel_events e
      LEFT JOIN sessions s ON s.session_id = e.session_id
      WHERE e.session_id = ${sessionId}
        AND (${eventType} = '' OR e.event_type = ${eventType})
        AND (${toolName} = '' OR e.tool_name = ${toolName})
        AND (${status} = '' OR e.status = ${status})
        AND (${fromTsMs} <= 0 OR e.created_at >= (${fromTsMs} / 1000.0))
        AND (${toTsMs} <= 0 OR e.created_at <= (${toTsMs} / 1000.0))
      ORDER BY e.id ASC
      LIMIT ${limit}
    `;
  } else if (traceId) {
    rows = await sql`
      SELECT
        e.id, e.session_id, e.turn AS turn_number, e.event_type,
        e.details_json, e.created_at, s.trace_id
      FROM otel_events e
      INNER JOIN sessions s ON s.session_id = e.session_id
      WHERE s.trace_id = ${traceId}
        AND (${eventType} = '' OR e.event_type = ${eventType})
        AND (${toolName} = '' OR e.tool_name = ${toolName})
        AND (${status} = '' OR e.status = ${status})
        AND (${fromTsMs} <= 0 OR e.created_at >= (${fromTsMs} / 1000.0))
        AND (${toTsMs} <= 0 OR e.created_at <= (${toTsMs} / 1000.0))
      ORDER BY e.id ASC
      LIMIT ${limit}
    `;
  } else {
    return [];
  }

  return rows.map((row) => {
    const data = parseJson(row.details_json) || {};
    const eventTraceId = String(
      (data.trace_id as string | undefined) || row.trace_id || traceId || "",
    );
    const rawTs = row.created_at as string | number | undefined;
    const numTs = Number(rawTs);
    const ts = Number.isFinite(numTs) && numTs > 0
      ? numTs * 1000
      : Date.parse(String(rawTs || ""));
    return {
      event_id: row.id ? `otel_${row.id}` : crypto.randomUUID().replace(/-/g, "").slice(0, 16),
      event_type: String(row.event_type || "error") as RuntimeEvent["event_type"],
      trace_id: eventTraceId,
      session_id: String(row.session_id || sessionId),
      turn: Number(row.turn_number) || 0,
      data,
      timestamp: Number.isNaN(ts) ? Date.now() : ts,
      source: String((data.source as string | undefined) || "edge_runtime"),
    };
  });
}

export interface RuntimeEventPage {
  events: RuntimeEvent[];
  has_more: boolean;
  next_cursor: string;
  watermark_cursor: string;
}

export interface RuntimeRunTreeNode {
  id: string;
  parent_id: string;
  name: string;
  kind: string;
  status: string;
  start_time: number;
  end_time: number;
  duration_ms: number;
  attributes: Record<string, unknown>;
  children: RuntimeRunTreeNode[];
}

export interface RuntimeRunTree {
  trace_id: string;
  root: RuntimeRunTreeNode | Record<string, never>;
  runtime_events: RuntimeEvent[];
  graph_lineage: Array<{
    graph_id: string;
    parent_graph_id: string;
    event_count: number;
    node_names: string[];
  }>;
  graph_checkpoints: Array<Record<string, unknown>>;
  eval_trials: Array<Record<string, unknown>>;
  annotations: Array<Record<string, unknown>>;
  counts: {
    nodes: number;
    graphs: number;
    runtime_events: number;
    checkpoints: number;
    eval_trials: number;
    annotations: number;
  };
}

/**
 * Cursor-paginated runtime event replay with deterministic ordering.
 * Cursor is the numeric `otel_events.id` of the last event seen.
 */
export async function loadRuntimeEventsPage(
  hyperdrive: Hyperdrive,
  opts: {
    session_id?: string;
    trace_id?: string;
    limit?: number;
    cursor?: string;
    watermark_cursor?: string;
    event_type?: string;
    tool_name?: string;
    status?: string;
    from_ts_ms?: number;
    to_ts_ms?: number;
  },
): Promise<RuntimeEventPage> {
  const sql = await getDb(hyperdrive);
  const limit = Math.max(1, Math.min(Number(opts.limit) || 100, 1000));
  const sessionId = String(opts.session_id || "").trim();
  const traceId = String(opts.trace_id || "").trim();
  const eventType = String(opts.event_type || "").trim();
  const toolName = String(opts.tool_name || "").trim();
  const status = String(opts.status || "").trim();
  const fromTsMs = Math.max(0, Number(opts.from_ts_ms) || 0);
  const toTsMs = Math.max(0, Number(opts.to_ts_ms) || 0);
  const cursorNum = Math.max(0, Number.parseInt(String(opts.cursor || "0"), 10) || 0);
  const providedWatermark = Math.max(
    0,
    Number.parseInt(String(opts.watermark_cursor || "0"), 10) || 0,
  );

  type EventRow = {
    id?: number;
    session_id: string;
    turn_number: number;
    event_type: string;
    details_json: string;
    created_at: string | number;
    trace_id?: string;
  };

  let rows: EventRow[] = [];
  let watermark = providedWatermark;
  if (sessionId) {
    const maxRows = await sql<{ max_id: number | null }[]>`
      SELECT MAX(id) AS max_id
      FROM otel_events
      WHERE session_id = ${sessionId}
        AND (${eventType} = '' OR event_type = ${eventType})
        AND (${toolName} = '' OR tool_name = ${toolName})
        AND (${status} = '' OR status = ${status})
        AND (${fromTsMs} <= 0 OR created_at >= (${fromTsMs} / 1000.0))
        AND (${toTsMs} <= 0 OR created_at <= (${toTsMs} / 1000.0))
    `;
    const maxWatermark = Number(maxRows?.[0]?.max_id || 0);
    watermark = providedWatermark > 0 ? Math.min(providedWatermark, maxWatermark) : maxWatermark;
    if (cursorNum >= watermark) {
      return {
        events: [],
        has_more: false,
        next_cursor: String(watermark),
        watermark_cursor: String(watermark),
      };
    }
    rows = await sql`
      SELECT
        e.id, e.session_id, e.turn AS turn_number, e.event_type,
        e.details_json, e.created_at, s.trace_id
      FROM otel_events e
      LEFT JOIN sessions s ON s.session_id = e.session_id
      WHERE e.session_id = ${sessionId}
        AND e.id > ${cursorNum}
        AND e.id <= ${watermark}
        AND (${eventType} = '' OR e.event_type = ${eventType})
        AND (${toolName} = '' OR e.tool_name = ${toolName})
        AND (${status} = '' OR e.status = ${status})
        AND (${fromTsMs} <= 0 OR e.created_at >= (${fromTsMs} / 1000.0))
        AND (${toTsMs} <= 0 OR e.created_at <= (${toTsMs} / 1000.0))
      ORDER BY e.id ASC
      LIMIT ${limit + 1}
    `;
  } else if (traceId) {
    const maxRows = await sql<{ max_id: number | null }[]>`
      SELECT MAX(e.id) AS max_id
      FROM otel_events e
      INNER JOIN sessions s ON s.session_id = e.session_id
      WHERE s.trace_id = ${traceId}
        AND (${eventType} = '' OR e.event_type = ${eventType})
        AND (${toolName} = '' OR e.tool_name = ${toolName})
        AND (${status} = '' OR e.status = ${status})
        AND (${fromTsMs} <= 0 OR e.created_at >= (${fromTsMs} / 1000.0))
        AND (${toTsMs} <= 0 OR e.created_at <= (${toTsMs} / 1000.0))
    `;
    const maxWatermark = Number(maxRows?.[0]?.max_id || 0);
    watermark = providedWatermark > 0 ? Math.min(providedWatermark, maxWatermark) : maxWatermark;
    if (cursorNum >= watermark) {
      return {
        events: [],
        has_more: false,
        next_cursor: String(watermark),
        watermark_cursor: String(watermark),
      };
    }
    rows = await sql`
      SELECT
        e.id, e.session_id, e.turn AS turn_number, e.event_type,
        e.details_json, e.created_at, s.trace_id
      FROM otel_events e
      INNER JOIN sessions s ON s.session_id = e.session_id
      WHERE s.trace_id = ${traceId}
        AND e.id > ${cursorNum}
        AND e.id <= ${watermark}
        AND (${eventType} = '' OR e.event_type = ${eventType})
        AND (${toolName} = '' OR e.tool_name = ${toolName})
        AND (${status} = '' OR e.status = ${status})
        AND (${fromTsMs} <= 0 OR e.created_at >= (${fromTsMs} / 1000.0))
        AND (${toTsMs} <= 0 OR e.created_at <= (${toTsMs} / 1000.0))
      ORDER BY e.id ASC
      LIMIT ${limit + 1}
    `;
  } else {
    return {
      events: [],
      has_more: false,
      next_cursor: String(cursorNum),
      watermark_cursor: String(providedWatermark || cursorNum),
    };
  }

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const events = pageRows.map((row) => {
    const data = parseJson(row.details_json) || {};
    const eventTraceId = String(
      (data.trace_id as string | undefined) || row.trace_id || traceId || "",
    );
    const rawTs = row.created_at as string | number | undefined;
    const numTs = Number(rawTs);
    const ts = Number.isFinite(numTs) && numTs > 0
      ? numTs * 1000
      : Date.parse(String(rawTs || ""));
    return {
      event_id: row.id ? `otel_${row.id}` : crypto.randomUUID().replace(/-/g, "").slice(0, 16),
      event_type: String(row.event_type || "error") as RuntimeEvent["event_type"],
      trace_id: eventTraceId,
      session_id: String(row.session_id || sessionId),
      turn: Number(row.turn_number) || 0,
      data,
      timestamp: Number.isNaN(ts) ? Date.now() : ts,
      source: String((data.source as string | undefined) || "edge_runtime"),
    };
  });

  const lastId = Number(pageRows[pageRows.length - 1]?.id || cursorNum);
  return {
    events,
    has_more: hasMore,
    next_cursor: String(lastId),
    watermark_cursor: String(watermark),
  };
}

/**
 * Build a lightweight run tree from runtime events.
 * This mirrors backend observability run-tree shape with node-level hierarchy.
 */
export async function buildRuntimeRunTree(
  hyperdrive: Hyperdrive,
  opts: {
    trace_id?: string;
    session_id?: string;
    limit?: number;
    event_type?: string;
    tool_name?: string;
    status?: string;
    from_ts_ms?: number;
    to_ts_ms?: number;
  },
): Promise<RuntimeRunTree> {
  const sql = await getDb(hyperdrive);
  const events = await loadRuntimeEvents(hyperdrive, {
    trace_id: opts.trace_id,
    session_id: opts.session_id,
    limit: Math.max(1, Math.min(Number(opts.limit) || 3000, 10000)),
    event_type: opts.event_type,
    tool_name: opts.tool_name,
    status: opts.status,
    from_ts_ms: opts.from_ts_ms,
    to_ts_ms: opts.to_ts_ms,
  });
  let traceId = String(opts.trace_id || events[0]?.trace_id || "");
  const sessionId = String(opts.session_id || events[0]?.session_id || "");
  if (!traceId && sessionId) {
    try {
      const traceRows = await sql<{ trace_id: string }[]>`
        SELECT trace_id
        FROM sessions
        WHERE session_id = ${sessionId}
        LIMIT 1
      `;
      traceId = String(traceRows?.[0]?.trace_id || "");
    } catch {
      // Best effort only.
    }
  }

  const nodesById = new Map<string, RuntimeRunTreeNode>();
  const turnRoots = new Map<number, RuntimeRunTreeNode>();

  const getTurnRoot = (turn: number): RuntimeRunTreeNode => {
    const existing = turnRoots.get(turn);
    if (existing) return existing;
    const id = `turn_${turn}`;
    const root: RuntimeRunTreeNode = {
      id,
      parent_id: "",
      name: `Turn ${turn}`,
      kind: "turn",
      status: "running",
      start_time: 0,
      end_time: 0,
      duration_ms: 0,
      attributes: { turn },
      children: [],
    };
    turnRoots.set(turn, root);
    nodesById.set(id, root);
    return root;
  };

  for (const e of events) {
    const turn = Number(e.turn) || 0;
    const data = e.data || {};
    const ts = Number(e.timestamp) || Date.now();
    const nodeId = (() => {
      if (e.event_type === "node_start" || e.event_type === "node_end" || e.event_type === "node_error") {
        return `node:${turn}:${String(data.node_id || "node")}`;
      }
      if (e.event_type === "llm_response" || e.event_type === "llm_request") return `llm:${turn}`;
      if (e.event_type === "tool_call" || e.event_type === "tool_result") {
        return `tool:${turn}:${String(data.tool_call_id || data.tool_name || "tool")}`;
      }
      return `${e.event_type}:${turn}:${e.event_id}`;
    })();
    const dataParentId = String(data.parent_node_id || "");
    const parentId = dataParentId || `turn_${turn}`;
    const existing = nodesById.get(nodeId);
    const baseName = String(
      data.node_id
      || data.tool_name
      || (e.event_type.startsWith("llm") ? "llm" : e.event_type),
    );
    const status = String(
      data.status
      || (e.event_type.endsWith("_error") ? "error" : (e.event_type.endsWith("_end") ? "completed" : "running")),
    );

    if (!existing) {
      const node: RuntimeRunTreeNode = {
        id: nodeId,
        parent_id: parentId,
        name: baseName,
        kind: e.event_type.includes("tool") ? "tool" : (e.event_type.includes("llm") ? "llm" : "node"),
        status,
        start_time: ts,
        end_time: ts,
        duration_ms: Number(data.latency_ms) || 0,
        attributes: { ...data, event_type: e.event_type },
        children: [],
      };
      nodesById.set(nodeId, node);
      const root = getTurnRoot(turn);
      if (!root.start_time || ts < root.start_time) root.start_time = ts;
      if (!root.end_time || ts > root.end_time) root.end_time = ts;
      root.duration_ms = Math.max(0, root.end_time - root.start_time);
    } else {
      if (!existing.start_time || ts < existing.start_time) existing.start_time = ts;
      if (!existing.end_time || ts > existing.end_time) existing.end_time = ts;
      existing.duration_ms = Number(data.latency_ms) || Math.max(0, existing.end_time - existing.start_time);
      existing.status = status || existing.status;
      existing.attributes = { ...existing.attributes, ...data, event_type: e.event_type };
      const root = getTurnRoot(turn);
      if (!root.start_time || ts < root.start_time) root.start_time = ts;
      if (!root.end_time || ts > root.end_time) root.end_time = ts;
      root.duration_ms = Math.max(0, root.end_time - root.start_time);
    }
  }

  for (const node of nodesById.values()) {
    if (node.kind === "turn") continue;
    const parentId = String(node.parent_id || "");
    const parent = nodesById.get(parentId);
    if (parent) {
      if (!parent.children.some((child) => child.id === node.id)) {
        parent.children.push(node);
      }
      continue;
    }
    const turn = Number(node.attributes?.turn || 0);
    const turnRoot = turnRoots.get(turn) || getTurnRoot(turn);
    if (!turnRoot.children.some((child) => child.id === node.id)) {
      turnRoot.children.push(node);
    }
  }

  const roots = Array.from(turnRoots.values()).sort(
    (a, b) => (a.start_time || 0) - (b.start_time || 0),
  );
  const traceRoot: RuntimeRunTreeNode | Record<string, never> = roots.length > 0
    ? {
        id: `trace:${traceId || roots[0].id}`,
        parent_id: "",
        name: "trace",
        kind: "trace",
        status: "completed",
        start_time: roots[0].start_time || 0,
        end_time: roots[roots.length - 1].end_time || 0,
        duration_ms: Math.max(0, (roots[roots.length - 1].end_time || 0) - (roots[0].start_time || 0)),
        attributes: { trace_id: traceId },
        children: roots,
      }
    : {};

  const graphCheckpoints = await loadGraphCheckpoints(sql, { trace_id: traceId, session_id: sessionId });
  const evalTrials = await loadEvalTrials(sql, { trace_id: traceId, session_id: sessionId });
  const annotations = await loadAnnotations(sql, { trace_id: traceId });
  const graphLineage = extractGraphLineage(events);

  return {
    trace_id: traceId,
    root: traceRoot,
    runtime_events: events,
    graph_lineage: graphLineage,
    graph_checkpoints: graphCheckpoints,
    eval_trials: evalTrials,
    annotations,
    counts: {
      nodes: roots.reduce((acc, r) => acc + countRunTreeNodes(r), 0),
      graphs: graphLineage.length,
      runtime_events: events.length,
      checkpoints: graphCheckpoints.length,
      eval_trials: evalTrials.length,
      annotations: annotations.length,
    },
  };
}

// ── Helpers ───────────────────────────────────────────────────

function countRunTreeNodes(node: RuntimeRunTreeNode): number {
  if (!Array.isArray(node.children) || node.children.length === 0) return 1;
  return 1 + node.children.reduce((acc, child) => acc + countRunTreeNodes(child), 0);
}

function extractGraphLineage(events: RuntimeEvent[]): Array<{
  graph_id: string;
  parent_graph_id: string;
  event_count: number;
  node_names: string[];
}> {
  const byGraph = new Map<
    string,
    { parent_graph_id: string; event_count: number; node_names: Set<string> }
  >();
  for (const event of events) {
    const data = (event.data || {}) as Record<string, unknown>;
    const graphId = String(data.graph_id || "").trim();
    if (!graphId) continue;
    const parentGraphId = String(data.parent_graph_id || "").trim();
    const nodeName = String(data.node_id || data.tool_name || "").trim();
    const existing = byGraph.get(graphId);
    if (!existing) {
      byGraph.set(graphId, {
        parent_graph_id: parentGraphId,
        event_count: 1,
        node_names: nodeName ? new Set([nodeName]) : new Set(),
      });
      continue;
    }
    existing.event_count += 1;
    if (nodeName) existing.node_names.add(nodeName);
    if (!existing.parent_graph_id && parentGraphId) {
      existing.parent_graph_id = parentGraphId;
    }
  }
  return Array.from(byGraph.entries())
    .map(([graph_id, info]) => ({
      graph_id,
      parent_graph_id: info.parent_graph_id,
      event_count: info.event_count,
      node_names: Array.from(info.node_names.values()).sort((a, b) => a.localeCompare(b)),
    }))
    .sort((a, b) => a.graph_id.localeCompare(b.graph_id));
}

async function loadGraphCheckpoints(
  sql: Sql,
  opts: { trace_id?: string; session_id?: string },
): Promise<Array<Record<string, unknown>>> {
  try {
    const traceId = String(opts.trace_id || "").trim();
    const sessionId = String(opts.session_id || "").trim();
    if (traceId) {
      const rows = await sql`
        SELECT checkpoint_id, agent_name, session_id, trace_id, status, payload, metadata, created_at
        FROM graph_checkpoints
        WHERE trace_id = ${traceId}
        ORDER BY created_at DESC
        LIMIT 1000
      `;
      return rows.map((r: any) => ({ ...r }));
    }
    if (sessionId) {
      const rows = await sql`
        SELECT checkpoint_id, agent_name, session_id, trace_id, status, payload, metadata, created_at
        FROM graph_checkpoints
        WHERE session_id = ${sessionId}
        ORDER BY created_at DESC
        LIMIT 1000
      `;
      return rows.map((r: any) => ({ ...r }));
    }
    return [];
  } catch {
    return [];
  }
}

async function loadEvalTrials(
  sql: Sql,
  opts: { trace_id?: string; session_id?: string },
): Promise<Array<Record<string, unknown>>> {
  try {
    const traceId = String(opts.trace_id || "").trim();
    const sessionId = String(opts.session_id || "").trim();
    if (traceId) {
      const rows = await sql`
        SELECT id, eval_name, agent_name, trial_index, passed, score, details_json, trace_id, session_id, created_at
        FROM eval_trials
        WHERE trace_id = ${traceId}
        ORDER BY created_at DESC
        LIMIT 1000
      `;
      return rows.map((r: any) => ({ ...r }));
    }
    if (sessionId) {
      const rows = await sql`
        SELECT id, eval_name, agent_name, trial_index, passed, score, details_json, trace_id, session_id, created_at
        FROM eval_trials
        WHERE session_id = ${sessionId}
        ORDER BY created_at DESC
        LIMIT 1000
      `;
      return rows.map((r: any) => ({ ...r }));
    }
    return [];
  } catch {
    return [];
  }
}

async function loadAnnotations(
  sql: Sql,
  opts: { trace_id?: string },
): Promise<Array<Record<string, unknown>>> {
  try {
    const traceId = String(opts.trace_id || "").trim();
    if (!traceId) return [];
    const rows = await sql`
      SELECT id, trace_id, span_id, note, author, created_at, updated_at
      FROM trace_annotations
      WHERE trace_id = ${traceId}
      ORDER BY created_at DESC
      LIMIT 1000
    `;
    return rows.map((r: any) => ({ ...r }));
  } catch {
    return [];
  }
}

function parseJsonArray(val: any): string[] {
  if (Array.isArray(val)) return val;
  if (typeof val === "string") {
    try {
      const parsed = JSON.parse(val);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function parseJson(val: any): Record<string, any> | undefined {
  if (val && typeof val === "object" && !Array.isArray(val)) return val;
  if (typeof val === "string") {
    try {
      return JSON.parse(val);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Safe int parse — preserves 0, falls back to default for NaN/undefined/null. */
function toInt(val: unknown, fallback: number): number {
  if (val === null || val === undefined || val === "") return fallback;
  const n = Number(val);
  return Number.isFinite(n) ? Math.floor(n) : fallback;
}

/** Safe float parse — preserves 0.0, falls back to default for NaN/undefined/null. */
function toFloat(val: unknown, fallback: number): number {
  if (val === null || val === undefined || val === "") return fallback;
  const n = Number(val);
  return Number.isFinite(n) ? n : fallback;
}

// ── Durable Conversation Persistence (Supabase) ─────────────
//
// DO SQLite is fast but ephemeral (wiped on deploy).
// Supabase is durable — survives deploys, shared across DO instances.
// Dual-write: DO SQLite (fast reads) + Supabase (durability).
// On cold start: hydrate DO from Supabase.

export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
  channel: string;
  created_at: number;
}

/**
 * Write a conversation message to Supabase (durable storage).
 * Called alongside DO SQLite write for dual-write durability.
 */
export async function writeConversationMessage(
  hyperdrive: Hyperdrive,
  msg: {
    agent_name: string;
    instance_id: string; // DO name (e.g., "my-assistant" or "my-assistant-tg-123")
    role: string;
    content: string;
    channel: string;
  },
): Promise<void> {
  const sql = await getDb(hyperdrive);
  try {
    await sql`
      INSERT INTO conversation_messages (
        agent_name, instance_id, role, content, channel, created_at
      ) VALUES (
        ${msg.agent_name}, ${msg.instance_id}, ${msg.role},
        ${msg.content.slice(0, 8000)}, ${msg.channel}, ${new Date().toISOString()}
      )
    `;
  } catch {
    // Table may not exist — create it
    try {
      await sql`
        CREATE TABLE IF NOT EXISTS conversation_messages (
          id BIGSERIAL PRIMARY KEY,
          agent_name TEXT NOT NULL DEFAULT '',
          instance_id TEXT NOT NULL DEFAULT '',
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          channel TEXT NOT NULL DEFAULT '',
          created_at REAL NOT NULL DEFAULT 0
        )
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS idx_conv_instance ON conversation_messages(instance_id, id)
      `;
      // Retry insert
      await sql`
        INSERT INTO conversation_messages (
          agent_name, instance_id, role, content, channel, created_at
        ) VALUES (
          ${msg.agent_name}, ${msg.instance_id}, ${msg.role},
          ${msg.content.slice(0, 8000)}, ${msg.channel}, ${new Date().toISOString()}
        )
      `;
    } catch {}
  }
}

/**
 * Load conversation history from Supabase for a DO instance.
 * Called on DO cold start to hydrate from durable storage.
 */
export async function loadConversationHistory(
  hyperdrive: Hyperdrive,
  instanceId: string,
  limit: number = 24,
): Promise<ConversationMessage[]> {
  const sql = await getDb(hyperdrive);
  try {
    const rows = await sql`
      SELECT role, content, channel, created_at
      FROM conversation_messages
      WHERE instance_id = ${instanceId}
        AND role IN ('user', 'assistant')
      ORDER BY id DESC
      LIMIT ${Math.max(1, Math.min(limit, 100))}
    `;
    return rows
      .reverse()
      .map((r: any) => ({
        role: r.role === "assistant" ? "assistant" as const : "user" as const,
        content: String(r.content || ""),
        channel: String(r.channel || ""),
        created_at: Number(r.created_at) || 0,
      }))
      .filter((r) => r.content.trim().length > 0);
  } catch {
    return [];
  }
}

// ── Usage / Billing Queries ──────────────────────────────────

export interface UsageSummary {
  org_id: string;
  agent_name: string;
  total_sessions: number;
  total_turns: number;
  total_tool_calls: number;
  total_cost_usd: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_wall_clock_seconds: number;
  period_start: string;
  period_end: string;
}

export interface UsageSessionEntry {
  session_id: string;
  agent_name: string;
  status: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  tool_calls: number;
  wall_clock_seconds: number;
  created_at: number;
}

export interface UsagePage {
  summary: UsageSummary;
  sessions: UsageSessionEntry[];
  has_more: boolean;
  next_cursor: string;
}

/**
 * Query usage/billing for an org, optionally scoped to agent.
 * Cursor-paginated by session_id (descending).
 */
export async function queryUsage(
  hyperdrive: Hyperdrive,
  opts: {
    org_id: string;
    agent_name?: string;
    cursor?: string;
    limit?: number;
    from_ts?: number;  // Unix epoch seconds
    to_ts?: number;
  },
): Promise<UsagePage> {
  const sql = await getDb(hyperdrive);
  const limit = Math.max(1, Math.min(Number(opts.limit) || 20, 100));
  const cursor = opts.cursor || "";
  const orgId = opts.org_id || "";
  const agentName = opts.agent_name || "";
  const fromTs = opts.from_ts ? new Date(Number(opts.from_ts) * 1000).toISOString() : new Date(0).toISOString();
  const toTs = opts.to_ts ? new Date(Number(opts.to_ts) * 1000).toISOString() : new Date().toISOString();

  // Summary aggregation
  let summaryRows: any[];
  if (agentName) {
    summaryRows = await sql`
      SELECT
        COUNT(*) as total_sessions,
        COALESCE(SUM(step_count), 0) as total_turns,
        COALESCE(SUM(action_count), 0) as total_tool_calls,
        COALESCE(SUM(cost_total_usd), 0) as total_cost_usd,
        COALESCE(SUM(wall_clock_seconds), 0) as total_wall_clock_seconds
      FROM sessions
      WHERE org_id = ${orgId}
        AND agent_name = ${agentName}
        AND created_at >= ${fromTs}
        AND created_at <= ${toTs}
    `;
  } else {
    summaryRows = await sql`
      SELECT
        COUNT(*) as total_sessions,
        COALESCE(SUM(step_count), 0) as total_turns,
        COALESCE(SUM(action_count), 0) as total_tool_calls,
        COALESCE(SUM(cost_total_usd), 0) as total_cost_usd,
        COALESCE(SUM(wall_clock_seconds), 0) as total_wall_clock_seconds
      FROM sessions
      WHERE org_id = ${orgId}
        AND created_at >= ${fromTs}
        AND created_at <= ${toTs}
    `;
  }

  const s = summaryRows[0] || {};
  const summary: UsageSummary = {
    org_id: orgId,
    agent_name: agentName || "(all agents)",
    total_sessions: Number(s.total_sessions) || 0,
    total_turns: Number(s.total_turns) || 0,
    total_tool_calls: Number(s.total_tool_calls) || 0,
    total_cost_usd: Number(s.total_cost_usd) || 0,
    total_input_tokens: 0, // Filled from billing_events below
    total_output_tokens: 0,
    total_wall_clock_seconds: Number(s.total_wall_clock_seconds) || 0,
    period_start: fromTs,
    period_end: toTs,
  };

  // Token totals from billing_events (if available), else billing_records inference rows
  try {
    let tokenRows: any[];
    if (agentName) {
      tokenRows = await sql`
        SELECT COALESCE(SUM(input_tokens), 0) as total_in, COALESCE(SUM(output_tokens), 0) as total_out
        FROM billing_events
        WHERE org_id = ${orgId} AND agent_name = ${agentName}
          AND created_at >= ${fromTs} AND created_at <= ${toTs}
      `;
    } else {
      tokenRows = await sql`
        SELECT COALESCE(SUM(input_tokens), 0) as total_in, COALESCE(SUM(output_tokens), 0) as total_out
        FROM billing_events
        WHERE org_id = ${orgId}
          AND created_at >= ${fromTs} AND created_at <= ${toTs}
      `;
    }
    summary.total_input_tokens = Number(tokenRows[0]?.total_in) || 0;
    summary.total_output_tokens = Number(tokenRows[0]?.total_out) || 0;
  } catch {
    // billing_events table may not exist
  }
  if (summary.total_input_tokens === 0 && summary.total_output_tokens === 0) {
    try {
      let br: any[];
      if (agentName) {
        br = await sql`
          SELECT COALESCE(SUM(input_tokens), 0) as total_in, COALESCE(SUM(output_tokens), 0) as total_out
          FROM billing_records
          WHERE org_id = ${orgId} AND agent_name = ${agentName} AND cost_type = 'inference'
            AND created_at >= ${fromTs} AND created_at <= ${toTs}
        `;
      } else {
        br = await sql`
          SELECT COALESCE(SUM(input_tokens), 0) as total_in, COALESCE(SUM(output_tokens), 0) as total_out
          FROM billing_records
          WHERE org_id = ${orgId} AND cost_type = 'inference'
            AND created_at >= ${fromTs} AND created_at <= ${toTs}
        `;
      }
      summary.total_input_tokens = Number(br[0]?.total_in) || 0;
      summary.total_output_tokens = Number(br[0]?.total_out) || 0;
    } catch {
      /* billing_records may be missing */
    }
  }

  // Paginated session list
  let sessionRows: any[];
  if (agentName) {
    sessionRows = cursor
      ? await sql`
          SELECT session_id, agent_name, status, model, cost_total_usd, step_count, action_count, wall_clock_seconds, created_at
          FROM sessions
          WHERE org_id = ${orgId} AND agent_name = ${agentName}
            AND created_at >= ${fromTs} AND created_at <= ${toTs}
            AND session_id < ${cursor}
          ORDER BY session_id DESC
          LIMIT ${limit + 1}
        `
      : await sql`
          SELECT session_id, agent_name, status, model, cost_total_usd, step_count, action_count, wall_clock_seconds, created_at
          FROM sessions
          WHERE org_id = ${orgId} AND agent_name = ${agentName}
            AND created_at >= ${fromTs} AND created_at <= ${toTs}
          ORDER BY session_id DESC
          LIMIT ${limit + 1}
        `;
  } else {
    sessionRows = cursor
      ? await sql`
          SELECT session_id, agent_name, status, model, cost_total_usd, step_count, action_count, wall_clock_seconds, created_at
          FROM sessions
          WHERE org_id = ${orgId}
            AND created_at >= ${fromTs} AND created_at <= ${toTs}
            AND session_id < ${cursor}
          ORDER BY session_id DESC
          LIMIT ${limit + 1}
        `
      : await sql`
          SELECT session_id, agent_name, status, model, cost_total_usd, step_count, action_count, wall_clock_seconds, created_at
          FROM sessions
          WHERE org_id = ${orgId}
            AND created_at >= ${fromTs} AND created_at <= ${toTs}
          ORDER BY session_id DESC
          LIMIT ${limit + 1}
        `;
  }

  const hasMore = sessionRows.length > limit;
  const page = hasMore ? sessionRows.slice(0, limit) : sessionRows;
  const sessions: UsageSessionEntry[] = page.map((r: any) => ({
    session_id: r.session_id || "",
    agent_name: r.agent_name || "",
    status: r.status || "",
    model: r.model || "",
    input_tokens: 0,
    output_tokens: 0,
    cost_usd: Number(r.cost_total_usd) || 0,
    tool_calls: Number(r.action_count) || 0,
    wall_clock_seconds: Number(r.wall_clock_seconds) || 0,
    created_at: Number(r.created_at) || 0,
  }));

  const lastId = page.length > 0 ? page[page.length - 1].session_id : cursor;

  return { summary, sessions, has_more: hasMore, next_cursor: String(lastId) };
}
