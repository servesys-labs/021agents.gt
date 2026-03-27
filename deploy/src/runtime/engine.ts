/**
 * Edge Runtime — orchestration around the graph executor (`edge_graph.ts`).
 *
 * Execution flows through deterministic graph nodes (memory → governance → route/LLM → tools →
 * loop detection → turn advance). `edgeRun` and `edgeResume` both delegate to that executor.
 */

import {
  loadAgentConfig,
  writeSession,
  writeBillingRecord,
  writeEvalTrial,
} from "./db";
import {
  buildFreshGraphCtx,
  executeFreshRunGraph,
  executeResumeTurnGraph,
  buildResumeGraphCtx,
  freshRunPostLoop,
  pushRuntimeEvent,
} from "./edge_graph";
import type { RuntimeEnv, RuntimeEvent, RunRequest, RunResponse, CheckpointPayload } from "./types";

export type { RunRequest, RunResponse, CheckpointPayload } from "./types";

/**
 * Execute a full agent run at the edge (graph executor).
 */
export async function edgeRun(
  env: RuntimeEnv,
  hyperdrive: Hyperdrive,
  request: RunRequest,
  telemetryQueue?: Queue,
): Promise<RunResponse> {
  const started = Date.now();
  const sessionId = crypto.randomUUID().slice(0, 16);
  const traceId = crypto.randomUUID().slice(0, 16);
  const rootGraphId = "root";

  const config = await loadAgentConfig(hyperdrive, request.agent_name, {
    provider: env.DEFAULT_PROVIDER,
    model: env.DEFAULT_MODEL,
    plan: "standard",
  });

  if (request.org_id) config.org_id = request.org_id;
  if (request.project_id) config.project_id = request.project_id;

  // Hydrate sandbox workspace from R2 before execution so non-stream runs
  // have the same persistent machine illusion as stream runs.
  if (env.STORAGE && env.SANDBOX) {
    try {
      const { getSandbox } = await import("@cloudflare/sandbox");
      const { hydrateWorkspace } = await import("./workspace");
      const sandbox = getSandbox(env.SANDBOX, `session-${sessionId}`);
      await hydrateWorkspace(
        env.STORAGE,
        sandbox,
        config.org_id || "default",
        config.agent_name || request.agent_name,
      );
    } catch {
      // Best-effort hydration; execution should continue on failures.
    }
  }

  // Startup sequence: load cross-session progress to orient the agent (harness pattern).
  // The context block is injected into the system prompt so the agent knows what happened
  // in prior sessions without burning tokens on archaeology.
  try {
    const { loadStartupContext } = await import("./progress");
    const startup = await loadStartupContext(hyperdrive, config.agent_name, config.org_id);
    if (startup.context_block) {
      config.system_prompt = config.system_prompt + "\n\n" + startup.context_block;
    }
  } catch {
    // Best-effort — startup context should never block execution
  }

  const ctx = buildFreshGraphCtx(
    env,
    hyperdrive,
    request,
    config,
    sessionId,
    traceId,
    telemetryQueue,
  );

  // Create session row early so turn inserts satisfy FK(session_id -> sessions.session_id).
  await writeSessionAsync(hyperdrive, {
    session_id: sessionId,
    org_id: config.org_id,
    project_id: config.project_id,
    agent_name: config.agent_name,
    status: "running",
    input_text: request.task,
    output_text: "",
    model: "",
    trace_id: traceId,
    step_count: 0,
    action_count: 0,
    wall_clock_seconds: 0,
    cost_total_usd: 0,
  });

  try {
    await executeFreshRunGraph(ctx);
  } catch (err: unknown) {
    ctx.stopReason = "error";
    ctx.output = "";
    const msg = err instanceof Error ? err.message : String(err);
    ctx.results.push({
      turn_number: ctx.results.length + 1,
      content: "",
      tool_results: [],
      done: true,
      stop_reason: "error",
      error: msg,
      cost_usd: 0,
      cumulative_cost_usd: ctx.cumulativeCost,
      model: ctx.lastModel,
      execution_mode: "sequential",
      latency_ms: Date.now() - started,
    });
  }

  freshRunPostLoop(ctx);

  const elapsedMs = Date.now() - started;
  const hasError = ctx.results.some((r) => r.error);
  const checkpointId = ctx.pendingCheckpoint?.checkpoint_id || "";

  // Calculate infrastructure overhead (DO, Hyperdrive, Queue, Supabase, Vectorize)
  const { calculateInfraCost } = await import("./tools");
  const fileWriteToolsForInfra = new Set(["write-file", "edit-file", "save-project"]);
  const infra = calculateInfraCost({
    wall_clock_ms: elapsedMs,
    turns: ctx.results.length,
    tool_calls: ctx.totalToolCalls,
    events_count: ctx.events.length,
    had_memory_search: true,
    had_file_writes: ctx.results.some((r) =>
      r.tool_results?.some((tr) => fileWriteToolsForInfra.has(tr.tool)),
    ),
  });
  ctx.cumulativeCost += infra.total_usd;

  pushRuntimeEvent(ctx.events, "session_end", 0, {
    session_id: sessionId,
    trace_id: traceId,
    graph_id: rootGraphId,
    parent_graph_id: "",
    org_id: config.org_id,
    agent_name: config.agent_name,
    turns: ctx.results.length,
    tool_calls: ctx.totalToolCalls,
    cost_usd: ctx.cumulativeCost,
    cost_infra_usd: infra.total_usd,
    cost_breakdown: infra.breakdown,
    latency_ms: elapsedMs,
    stop_reason: ctx.stopReason,
    success: !hasError,
  });

  // Run codemode observability processor if configured
  if (config.codemode_observability) {
    try {
      const { getDb } = await import("./db");
      const sql = await getDb(hyperdrive);
      const snippetRows = await sql`
        SELECT code FROM codemode_snippets WHERE id = ${config.codemode_observability} AND org_id = ${config.org_id} LIMIT 1
      `;
      if (snippetRows.length > 0) {
        const { executeObservabilityProcessor } = await import("./codemode");
        const { getToolDefinitions } = await import("./tools");
        const code = String((snippetRows[0] as Record<string, unknown>).code || "");
        const allTools = getToolDefinitions([]);
        const obsResult = await executeObservabilityProcessor(
          env, code, ctx.events, allTools, sessionId,
        );
        // Push alerts as additional events
        for (const alert of obsResult.alerts) {
          pushRuntimeEvent(ctx.events, "error", 0, {
            session_id: sessionId, trace_id: traceId,
            severity: alert.severity, message: alert.message,
            source: "codemode_observability",
          });
        }
      }
    } catch {
      // Observability processing is best-effort
    }
  }

  const persistenceTasks: Promise<unknown>[] = [];

  persistenceTasks.push(writeSessionAsync(hyperdrive, {
    session_id: sessionId,
    org_id: config.org_id,
    project_id: config.project_id,
    agent_name: config.agent_name,
    status: checkpointId ? "pending_approval" : (hasError ? "error" : "success"),
    input_text: request.task,
    output_text: ctx.output,
    model: ctx.lastModel,
    trace_id: traceId,
    step_count: ctx.results.length,
    action_count: ctx.totalToolCalls,
    wall_clock_seconds: elapsedMs / 1000,
    cost_total_usd: ctx.cumulativeCost,
  }));

  persistenceTasks.push(writeBillingAsync(hyperdrive, {
    session_id: sessionId,
    org_id: config.org_id,
    agent_name: config.agent_name,
    model: ctx.lastModel,
    input_tokens: ctx.totalInputTokens,
    output_tokens: ctx.totalOutputTokens,
    cost_usd: ctx.cumulativeCost,
    plan: config.plan,
  }));

  if (telemetryQueue) {
    for (const event of ctx.events) {
      try {
        persistenceTasks.push(
          telemetryQueue
          .send({
            type: "event",
            payload: {
              session_id: sessionId,
              turn: event.turn,
              event_type: event.event_type,
              created_at: Number(event.timestamp) > 0 ? new Date(Number(event.timestamp)).toISOString() : new Date().toISOString(),
              details: event.data || {},
              ...event.data,
            },
          })
          .catch(() => {}),
        );
      } catch {
        /* best-effort */
      }
    }
  }

  // Emit cost_ledger entry via telemetry queue for per-session cost tracking
  if (telemetryQueue && ctx.cumulativeCost > 0) {
    persistenceTasks.push(
      telemetryQueue.send({
        type: "cost_ledger",
        payload: {
          session_id: sessionId,
          org_id: config.org_id,
          agent_name: config.agent_name,
          model: ctx.lastModel,
          input_tokens: ctx.totalInputTokens,
          output_tokens: ctx.totalOutputTokens,
          cost_usd: ctx.cumulativeCost,
          plan: config.plan,
          created_at: new Date().toISOString(),
        },
      }).catch(() => {}),
    );
  }

  // Emit runtime_events for each turn result via telemetry queue
  if (telemetryQueue) {
    for (const result of ctx.results) {
      persistenceTasks.push(
        telemetryQueue.send({
          type: "runtime_event",
          payload: {
            trace_id: traceId,
            session_id: sessionId,
            org_id: config.org_id,
            event_type: "turn_completed",
            node_id: "",
            status: result.error ? "error" : "success",
            duration_ms: result.latency_ms || 0,
            details: {
              model: result.model || ctx.lastModel,
              turn_number: result.turn_number,
              tool_calls: result.tool_results?.length || 0,
              cost_usd: result.cost_usd,
              error: result.error || null,
            },
            created_at: new Date().toISOString(),
          },
        }).catch(() => {}),
      );
    }
  }

  // Events go via TELEMETRY_QUEUE only (Hyperdrive connection dies after response)

  if (ctx.pendingCheckpoint) {
    persistenceTasks.push(writeCheckpoint(hyperdrive, ctx.pendingCheckpoint));
  }

  // Auto-snapshot workspace to R2 if any file-write tools were used
  const snapshotTools = new Set(["write-file", "edit-file", "python-exec", "bash"]);
  const hadSnapshotWrites = ctx.results.some((r) =>
    r.tool_results?.some((tr) => snapshotTools.has(tr.tool)),
  );
  if (hadSnapshotWrites && env.STORAGE && env.SANDBOX) {
    persistenceTasks.push(
      autoSnapshotWorkspace(env, sessionId, config.agent_name, config.org_id).catch((err) => {
        console.error("[runtime] auto-snapshot failed:", err instanceof Error ? err.message : err);
      }),
    );
  }

  const firstError = ctx.results.find((r) => r.error)?.error;
  const response: RunResponse = {
    success: !hasError,
    output: ctx.output,
    ...(firstError ? { error: firstError } : {}),
    turns: ctx.results.length,
    tool_calls: ctx.totalToolCalls,
    cost_usd: Math.round(ctx.cumulativeCost * 1_000_000) / 1_000_000,
    latency_ms: elapsedMs,
    session_id: sessionId,
    trace_id: traceId,
    stop_reason: ctx.stopReason,
    events: ctx.events,
    run_id: traceId || sessionId,
    checkpoint_id: checkpointId || undefined,
  };
  const evalTrial = buildEvalTrialCandidate(request, response, config.agent_name);
  if (evalTrial) {
    persistenceTasks.push(writeEvalTrialAsync(hyperdrive, {
      eval_name: evalTrial.eval_name,
      agent_name: config.agent_name,
      trial_index: evalTrial.trial_index,
      passed: evalTrial.passed,
      score: evalTrial.score,
      details_json: JSON.stringify(evalTrial.details),
      trace_id: traceId,
      session_id: sessionId,
    }));
  }

  // Write cross-session progress entry (harness pattern: cognitive anchor)
  try {
    const { buildProgressSummary, writeProgress } = await import("./progress");
    const summary = buildProgressSummary(ctx.results, ctx.events, elapsedMs / 1000, ctx.stopReason);
    persistenceTasks.push(
      writeProgress(hyperdrive, {
        session_id: sessionId,
        trace_id: traceId,
        agent_name: config.agent_name,
        org_id: config.org_id,
        timestamp: Date.now(),
        summary,
      }),
    );
  } catch {
    // Best-effort — progress tracking should never block execution
  }

  // Ensure writes are not dropped when request scope ends.
  await Promise.allSettled(persistenceTasks);

  return response;
}

// ── Helpers ───────────────────────────────────────────────────

/** Fire-and-forget session write. */
function writeSessionAsync(
  hyperdrive: Hyperdrive,
  session: Parameters<typeof writeSession>[1],
): Promise<void> {
  return writeSession(hyperdrive, session).catch((err) => {
    console.error("[runtime] writeSession failed", err);
  });
}

/** Fire-and-forget billing write. */
function writeBillingAsync(
  hyperdrive: Hyperdrive,
  record: Parameters<typeof writeBillingRecord>[1],
): Promise<void> {
  return writeBillingRecord(hyperdrive, record).catch((err) => {
    console.error("[runtime] writeBilling failed", err);
  });
}

/** Fire-and-forget eval trial write. */
function writeEvalTrialAsync(
  hyperdrive: Hyperdrive,
  trial: Parameters<typeof writeEvalTrial>[1],
): Promise<void> {
  return writeEvalTrial(hyperdrive, trial).catch((err) => {
    console.error("[runtime] writeEvalTrial failed", err);
  });
}

/** Fire-and-forget runtime event persistence to Postgres. */
// Events are written exclusively via TELEMETRY_QUEUE → queue consumer → Supabase.
// No direct Hyperdrive event writes — those were failing with "Network connection lost"
// because the connection dies when the Worker response lifecycle ends.

/**
 * Session-end workspace sync — verify manifest is up to date.
 * Per-file sync already happened during tool execution.
 * This catches any files that were missed (bash/python output, etc.).
 */
async function autoSnapshotWorkspace(
  env: RuntimeEnv,
  sessionId: string,
  agentName: string,
  orgId: string,
): Promise<void> {
  const { getSandbox } = await import("@cloudflare/sandbox");
  const { syncFileToR2 } = await import("./workspace");
  const sandbox = getSandbox(env.SANDBOX, `session-${sessionId}`);
  const org = orgId || "default";
  const agent = agentName || "agent";

  // List all files in /workspace that might not have been synced
  const lsResult = await sandbox.exec(
    "find /workspace -type f -newer /tmp/.session_start 2>/dev/null || find /workspace -type f 2>/dev/null",
    { timeout: 10 },
  );
  const files = (lsResult.stdout || "").split("\n").filter((f) => f.trim());
  if (files.length === 0) return;

  // Sync each file that exists in workspace
  for (const filePath of files.slice(0, 50)) { // Cap at 50 files
    try {
      const catResult = await sandbox.exec(`cat "${filePath}"`, { timeout: 10 });
      if (catResult.exitCode === 0 && catResult.stdout) {
        await syncFileToR2(env.STORAGE, org, agent, filePath, catResult.stdout, sessionId);
      }
    } catch {
      // Best-effort per file
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function numOr(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function boolOr(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (v === "true" || v === "1" || v === "yes" || v === "pass" || v === "passed") return true;
    if (v === "false" || v === "0" || v === "no" || v === "fail" || v === "failed") return false;
  }
  return fallback;
}

type EvalTrialCandidate = {
  eval_name: string;
  trial_index: number;
  score: number;
  passed: boolean;
  details: Record<string, unknown>;
};

function buildEvalTrialCandidate(
  request: RunRequest,
  response: RunResponse,
  agentName: string,
): EvalTrialCandidate | null {
  const metadata = asRecord(request.metadata) || {};
  const nested =
    asRecord(metadata.eval_trial) ||
    asRecord(metadata.eval) ||
    asRecord(metadata.evaluation) ||
    {};
  const merged: Record<string, unknown> = { ...metadata, ...nested };
  const hasEvalSignal =
    merged.eval_name !== undefined ||
    merged.eval_run_id !== undefined ||
    merged.trial_index !== undefined ||
    merged.trial !== undefined ||
    merged.task_name !== undefined ||
    merged.expected !== undefined;
  if (!hasEvalSignal) return null;

  const evalName = String(merged.eval_name || request.run_name || "edge_eval").trim();
  const trialIndex = Math.max(0, Math.floor(numOr(merged.trial_index ?? merged.trial, 0)));
  const fallbackScore = response.success ? 1 : 0;
  const score = numOr(merged.score, fallbackScore);
  const passed = boolOr(merged.passed, score >= 1);
  const details: Record<string, unknown> = {
    run_name: request.run_name || "",
    task_name: String(merged.task_name || ""),
    eval_run_id: numOr(merged.eval_run_id, 0),
    expected: merged.expected ?? null,
    output: response.output,
    error: response.error || "",
    stop_reason: response.stop_reason,
    turns: response.turns,
    tool_calls: response.tool_calls,
    cost_usd: response.cost_usd,
    latency_ms: response.latency_ms,
    run_id: response.run_id || "",
    trace_id: response.trace_id,
    session_id: response.session_id,
    agent_name: agentName,
    metadata,
  };
  return {
    eval_name: evalName,
    trial_index: trialIndex,
    score,
    passed,
    details,
  };
}

// ── Batch Invoke ──────────────────────────────────────────────

export interface BatchRequest {
  inputs: RunRequest[];
}

export interface BatchResponse {
  results: RunResponse[];
  total_latency_ms: number;
}

/**
 * Execute multiple agent runs concurrently.
 * Each input gets its own session/trace.
 */
export async function edgeBatch(
  env: RuntimeEnv,
  hyperdrive: Hyperdrive,
  batch: BatchRequest,
  telemetryQueue?: Queue,
): Promise<BatchResponse> {
  const started = Date.now();
  const results = await Promise.all(
    batch.inputs.map((input) => edgeRun(env, hyperdrive, input, telemetryQueue)),
  );
  return {
    results,
    total_latency_ms: Date.now() - started,
  };
}

// ── Latency Breakdown ─────────────────────────────────────────

export interface LatencyBreakdown {
  total_ms: number;
  llm_ms: number;
  tools_ms: number;
  db_ms: number;
  overhead_ms: number;
  per_turn: Array<{
    turn: number;
    llm_ms: number;
    tools_ms: number;
    total_ms: number;
  }>;
}

/**
 * Compute latency breakdown from runtime events.
 */
export function computeLatencyBreakdown(events: RuntimeEvent[]): LatencyBreakdown {
  let totalMs = 0;
  let llmMs = 0;
  let toolsMs = 0;

  const turnMap = new Map<number, { llm_ms: number; tools_ms: number; total_ms: number }>();

  for (const event of events) {
    if (event.event_type === "session_end") {
      totalMs = Number(event.data.latency_ms) || 0;
    }
    if (event.event_type === "llm_response") {
      const ms = Number(event.data.latency_ms) || 0;
      llmMs += ms;
      const entry = turnMap.get(event.turn) || { llm_ms: 0, tools_ms: 0, total_ms: 0 };
      entry.llm_ms += ms;
      entry.total_ms += ms;
      turnMap.set(event.turn, entry);
    }
    if (event.event_type === "tool_result") {
      const ms = Number(event.data.latency_ms) || 0;
      toolsMs += ms;
      const entry = turnMap.get(event.turn) || { llm_ms: 0, tools_ms: 0, total_ms: 0 };
      entry.tools_ms += ms;
      entry.total_ms += ms;
      turnMap.set(event.turn, entry);
    }
  }

  const overheadMs = Math.max(0, totalMs - llmMs - toolsMs);

  const perTurn = Array.from(turnMap.entries())
    .sort(([a], [b]) => a - b)
    .map(([turn, data]) => ({ turn, ...data }));

  return {
    total_ms: totalMs,
    llm_ms: llmMs,
    tools_ms: toolsMs,
    db_ms: 0,
    overhead_ms: overheadMs,
    per_turn: perTurn,
  };
}

// ── Checkpoint Persistence ────────────────────────────────────

/**
 * Persist a checkpoint to Supabase for later resume.
 */
export async function writeCheckpoint(
  hyperdrive: Hyperdrive,
  checkpoint: CheckpointPayload,
): Promise<void> {
  const { getDb } = await import("./db");
  const sql = await getDb(hyperdrive);
  await sql`
    INSERT INTO graph_checkpoints (
      checkpoint_id, agent_name, session_id, trace_id,
      status, payload, metadata, created_at
    ) VALUES (
      ${checkpoint.checkpoint_id}, ${checkpoint.agent_name},
      ${checkpoint.session_id}, ${checkpoint.trace_id},
      ${checkpoint.status}, ${JSON.stringify(checkpoint)},
      '{}', ${new Date().toISOString()}
    ) ON CONFLICT (checkpoint_id) DO UPDATE SET
      status = EXCLUDED.status,
      payload = EXCLUDED.payload
  `;
}

/**
 * Load a checkpoint from Supabase.
 */
export async function loadCheckpoint(
  hyperdrive: Hyperdrive,
  checkpointId: string,
): Promise<CheckpointPayload | null> {
  const { getDb } = await import("./db");
  const sql = await getDb(hyperdrive);
  const rows = await sql`
    SELECT payload FROM graph_checkpoints
    WHERE checkpoint_id = ${checkpointId}
    LIMIT 1
  `;
  if (rows.length === 0) return null;
  try {
    const payload =
      typeof rows[0].payload === "string" ? JSON.parse(rows[0].payload) : rows[0].payload;
    return payload as CheckpointPayload;
  } catch {
    return null;
  }
}

/**
 * Resume an agent run from a checkpoint (graph executor).
 */
export async function edgeResume(
  env: RuntimeEnv,
  hyperdrive: Hyperdrive,
  checkpointId: string,
  telemetryQueue?: Queue,
): Promise<RunResponse> {
  const checkpoint = await loadCheckpoint(hyperdrive, checkpointId);
  if (!checkpoint) {
    return {
      success: false,
      output: "",
      turns: 0,
      tool_calls: 0,
      cost_usd: 0,
      latency_ms: 0,
      session_id: "",
      trace_id: "",
      stop_reason: "checkpoint_not_found",
      events: [],
    };
  }

  await writeCheckpoint(hyperdrive, { ...checkpoint, status: "approved" });

  const config = await loadAgentConfig(hyperdrive, checkpoint.agent_name, {
    provider: env.DEFAULT_PROVIDER,
    model: env.DEFAULT_MODEL,
    plan: "standard",
  });

  const started = Date.now();
  const resumedSessionId = crypto.randomUUID().slice(0, 16);
  const rootGraphId = "root";

  const ctx = buildResumeGraphCtx(
    env,
    hyperdrive,
    checkpoint,
    checkpointId,
    resumedSessionId,
    config,
    telemetryQueue,
  );

  pushRuntimeEvent(ctx.events, "session_resume", 0, {
    session_id: resumedSessionId,
    trace_id: checkpoint.trace_id,
    graph_id: rootGraphId,
    parent_graph_id: "",
    checkpoint_id: checkpointId,
    parent_session_id: checkpoint.session_id,
  });

  // Create resumed session row early so turn inserts satisfy FK.
  await writeSessionAsync(hyperdrive, {
    session_id: resumedSessionId,
    org_id: config.org_id,
    project_id: config.project_id,
    agent_name: config.agent_name,
    status: "running",
    input_text: "(resumed)",
    output_text: "",
    model: "",
    trace_id: checkpoint.trace_id,
    step_count: 0,
    action_count: 0,
    wall_clock_seconds: 0,
    cost_total_usd: 0,
    parent_session_id: checkpoint.session_id,
    depth: 1,
  });

  try {
    await executeResumeTurnGraph(ctx);
  } catch (err: unknown) {
    ctx.stopReason = "error";
    const msg = err instanceof Error ? err.message : String(err);
    ctx.results.push({
      turn_number: ctx.results.length + 1,
      content: "",
      tool_results: [],
      done: true,
      stop_reason: "error",
      error: msg,
      cost_usd: 0,
      cumulative_cost_usd: ctx.cumulativeCost,
      model: ctx.lastModel,
      execution_mode: "sequential",
      latency_ms: Date.now() - started,
    });
  }

  const elapsedMs = Date.now() - started;
  const hasError = ctx.results.some((r) => r.error);

  pushRuntimeEvent(ctx.events, "session_end", 0, {
    session_id: resumedSessionId,
    trace_id: checkpoint.trace_id,
    graph_id: rootGraphId,
    parent_graph_id: "",
    turns: ctx.results.length,
    cost_usd: ctx.cumulativeCost,
    latency_ms: elapsedMs,
    stop_reason: ctx.stopReason,
    success: !hasError,
    resumed_from: checkpointId,
    parent_session_id: checkpoint.session_id,
  });

  // Events go via TELEMETRY_QUEUE only (Hyperdrive connection dies after response)

  await writeSessionAsync(hyperdrive, {
    session_id: resumedSessionId,
    org_id: config.org_id,
    project_id: config.project_id,
    agent_name: config.agent_name,
    status: hasError ? "error" : "success",
    input_text: "(resumed)",
    output_text: ctx.output,
    model: ctx.lastModel,
    trace_id: checkpoint.trace_id,
    step_count: ctx.results.length,
    action_count: ctx.totalToolCalls,
    wall_clock_seconds: elapsedMs / 1000,
    cost_total_usd: ctx.cumulativeCost,
    parent_session_id: checkpoint.session_id,
    depth: 1,
  });

  await writeCheckpoint(hyperdrive, { ...checkpoint, status: "resumed" });

  // Billing record for resumed session (was missing — gap #3)
  writeBillingAsync(hyperdrive, {
    session_id: resumedSessionId,
    org_id: config.org_id,
    agent_name: config.agent_name,
    model: ctx.lastModel,
    input_tokens: ctx.totalInputTokens,
    output_tokens: ctx.totalOutputTokens,
    cost_usd: ctx.cumulativeCost,
    plan: config.plan,
  });

  return {
    success: !hasError,
    output: ctx.output,
    turns: ctx.results.length,
    tool_calls: ctx.totalToolCalls,
    cost_usd: Math.round(ctx.cumulativeCost * 1_000_000) / 1_000_000,
    latency_ms: elapsedMs,
    session_id: resumedSessionId,
    trace_id: checkpoint.trace_id,
    stop_reason: ctx.stopReason,
    events: ctx.events,
    run_id: checkpoint.trace_id || resumedSessionId,
    parent_session_id: checkpoint.session_id,
    resumed_from_checkpoint: checkpointId,
  };
}
