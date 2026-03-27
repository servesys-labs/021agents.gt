/**
 * Edge graph executor — deterministic node transitions for agent runs.
 *
 * Fresh (`edgeRun`) and resume (`edgeResume`) share the same executor shape:
 * each node returns the next node id (or HALT). Per-turn looping is modeled
 * as explicit transitions back to the turn header node after tools + loop checks.
 */

import { callLLM } from "./llm";
import { executeTools, getToolDefinitions } from "./tools";
import { resolvePlanRouting, writeTurn, writeSession } from "./db";
import {
  createWorkingMemory,
  buildMemoryContext,
  queueFactExtraction,
  type WorkingMemory,
} from "./memory";
import { selectModel, type PlanRouting } from "./router";
import { createLoopState, detectLoop, maybeSummarize } from "./middleware";
import { loadSkills, formatSkillsPrompt } from "./skills";
import type {
  AgentConfig,
  LLMMessage,
  LLMResponse,
  TurnResult,
  ToolResult,
  RuntimeEnv,
  RuntimeEvent,
  ToolDefinition,
  RunRequest,
  CheckpointPayload,
} from "./types";

/** Next graph node id, or HALT to exit the executor (then run post-loop hooks). */
export const GRAPH_HALT = "__HALT__";

export type GraphTransition = typeof GRAPH_HALT | string;

export interface EdgeGraphNode<TCtx> {
  readonly id: string;
  readonly description: string;
  run(ctx: TCtx): Promise<GraphTransition>;
}

/**
 * Deterministic executor: follows `next` pointers until HALT.
 * Bounded step count prevents accidental cycles.
 *
 * Breakpoint support: if the context has a `breakpointNodeIds` Set and the
 * current node id is in it, the executor creates a checkpoint and halts
 * with stop_reason="breakpoint" (same mechanism as approval gates).
 */
export async function runEdgeGraph<TCtx>(
  ctx: TCtx,
  entry: string,
  nodes: Record<string, EdgeGraphNode<TCtx>>,
  maxSteps = 50_000,
): Promise<void> {
  let cursor: GraphTransition = entry;
  for (let step = 0; step < maxSteps; step++) {
    if (cursor === GRAPH_HALT) return;
    const node = nodes[cursor];
    if (!node) {
      throw new Error(`edge graph: unknown node ${cursor}`);
    }

    // ── Breakpoint gate ──────────────────────────────────────────────
    const bpSet = (ctx as Record<string, unknown>).breakpointNodeIds;
    if (bpSet instanceof Set && bpSet.has(cursor)) {
      const fctx = ctx as unknown as FreshGraphCtx;
      const checkpointId = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
      fctx.pendingCheckpoint = {
        checkpoint_id: checkpointId,
        session_id: fctx.sessionId,
        trace_id: fctx.traceId,
        agent_name: fctx.config.agent_name,
        messages: fctx.messages,
        current_turn: fctx.turn,
        cumulative_cost_usd: fctx.cumulativeCost,
        status: "breakpoint",
        created_at: Date.now(),
      };
      fctx.stopReason = "breakpoint";
      fctx.output = "";
      fctx.results.push({
        turn_number: fctx.turn,
        content: "",
        tool_results: [],
        done: true,
        stop_reason: "breakpoint",
        cost_usd: 0,
        cumulative_cost_usd: fctx.cumulativeCost,
        model: fctx.lastModel,
        execution_mode: "sequential",
        latency_ms: Date.now() - fctx.turnStartedMs,
      });
      pushRuntimeEvent(fctx.events, "governance_check", fctx.turn, {
        session_id: fctx.sessionId,
        trace_id: fctx.traceId,
        breakpoint: true,
        breakpoint_node_id: cursor,
        checkpoint_id: checkpointId,
      });
      pushRuntimeEvent(fctx.events, "turn_end", fctx.turn, {
        session_id: fctx.sessionId,
        trace_id: fctx.traceId,
        graph_id: fctx.rootGraphId,
        parent_graph_id: "",
        done: true,
        stop_reason: "breakpoint",
        checkpoint_id: checkpointId,
      });
      return; // halt — caller persists checkpoint for resume
    }
    // ── End breakpoint gate ──────────────────────────────────────────

    cursor = await node.run(ctx);
  }
  throw new Error("edge graph: exceeded maxSteps (possible cycle)");
}

// ── State snapshot merge (same semantics as former engine.ts) ───────────────

export type StateMergeStrategy =
  | "replace"
  | "sum_numeric"
  | "max_numeric"
  | "append_list"
  | "merge_dict";

function coerceReducerMap(
  raw: Record<string, unknown> | undefined,
): Record<string, StateMergeStrategy> {
  const allowed = new Set<StateMergeStrategy>([
    "replace",
    "sum_numeric",
    "max_numeric",
    "append_list",
    "merge_dict",
  ]);
  const out: Record<string, StateMergeStrategy> = {};
  if (!raw) return out;
  for (const key of Object.keys(raw)) {
    const v = String(raw[key] || "");
    if (allowed.has(v as StateMergeStrategy)) {
      out[key] = v as StateMergeStrategy;
    }
  }
  return out;
}

function stableStringify(value: unknown): string {
  try {
    return JSON.stringify(value, Object.keys((value as Record<string, unknown>) || {}).sort());
  } catch {
    return String(value);
  }
}

function reduceStateValue(
  current: unknown,
  incoming: unknown,
  strategy: StateMergeStrategy,
): unknown {
  if (strategy === "sum_numeric") return Number(current || 0) + Number(incoming || 0);
  if (strategy === "max_numeric") return Math.max(Number(current || 0), Number(incoming || 0));
  if (strategy === "append_list") {
    const left = Array.isArray(current) ? current : [];
    const right = Array.isArray(incoming) ? incoming : [incoming];
    return [...left, ...right];
  }
  if (strategy === "merge_dict") {
    const left =
      current && typeof current === "object" && !Array.isArray(current)
        ? (current as Record<string, unknown>)
        : {};
    const right =
      incoming && typeof incoming === "object" && !Array.isArray(incoming)
        ? (incoming as Record<string, unknown>)
        : {};
    const merged = { ...left, ...right };
    return Object.keys(merged)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = merged[key];
        return acc;
      }, {});
  }
  return incoming;
}

export function mergeStateSnapshots(
  branchStates: Array<{ branch_id?: string; state: Record<string, unknown> }>,
  reducers: Record<string, StateMergeStrategy>,
): Record<string, unknown> {
  const ordered = [...branchStates].sort((a, b) => {
    const aId = String(a.branch_id || "");
    const bId = String(b.branch_id || "");
    if (aId !== bId) return aId.localeCompare(bId);
    return stableStringify(a.state).localeCompare(stableStringify(b.state));
  });
  const out: Record<string, unknown> = {};
  for (const branch of ordered) {
    const keys = Object.keys(branch.state).sort();
    for (const key of keys) {
      const incoming = branch.state[key];
      if (!(key in out)) {
        out[key] = incoming;
        continue;
      }
      const strategy = reducers[key] || "replace";
      out[key] = reduceStateValue(out[key], incoming, strategy);
    }
  }
  return out;
}

export function pushRuntimeEvent(
  events: RuntimeEvent[],
  eventType: RuntimeEvent["event_type"],
  turn: number,
  data: Record<string, unknown>,
): void {
  const sessionId = String(
    data.session_id || events.find((e) => e.session_id)?.session_id || "",
  );
  const traceId = String(
    data.trace_id || events.find((e) => e.trace_id)?.trace_id || "",
  );
  events.push({
    event_id: crypto.randomUUID().replace(/-/g, "").slice(0, 16),
    event_type: eventType,
    trace_id: traceId,
    session_id: sessionId,
    turn,
    data,
    timestamp: Date.now(),
    source: "edge_runtime",
  });
}

function writeTurnAsync(
  hyperdrive: Hyperdrive,
  sessionId: string,
  turnNumber: number,
  llmResponse: LLMResponse,
  toolResults: ToolResult[],
  telemetryQueue?: Queue,
): Promise<void> {
  return writeTurn(hyperdrive, {
    session_id: sessionId,
    turn_number: turnNumber,
    model_used: llmResponse.model,
    input_tokens: llmResponse.usage.input_tokens,
    output_tokens: llmResponse.usage.output_tokens,
    latency_ms: llmResponse.latency_ms,
    llm_content: llmResponse.content,
    cost_total_usd: llmResponse.cost_usd,
    tool_calls_json: JSON.stringify(
      llmResponse.tool_calls.map((tc) => ({
        id: tc.id,
        name: tc.name,
        arguments: tc.arguments,
      })),
    ),
    tool_results_json: JSON.stringify(toolResults),
    errors_json: JSON.stringify(
      toolResults.filter((tr) => tr.error).map((tr) => ({ tool: tr.tool, error: tr.error })),
    ),
    execution_mode: toolResults.length > 1 ? "parallel" : "sequential",
  }).catch((err) => {
    console.error("[runtime] writeTurn failed", err);
  });
}

// ── Fresh run context ───────────────────────────────────────────────────────

export interface FreshGraphCtx {
  env: RuntimeEnv;
  hyperdrive: Hyperdrive;
  telemetryQueue?: Queue;
  started: number;
  sessionId: string;
  traceId: string;
  rootGraphId: string;
  request: RunRequest;
  config: AgentConfig;
  messages: LLMMessage[];
  events: RuntimeEvent[];
  results: TurnResult[];
  workingMemory: WorkingMemory;
  loopState: ReturnType<typeof createLoopState>;
  activeTools: ToolDefinition[];
  stateReducerOverrides: Record<string, StateMergeStrategy>;
  turn: number;
  cumulativeCost: number;
  totalToolCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  output: string;
  stopReason: string;
  lastModel: string;
  task: string;
  channel: string;
  /** Scratch: wall clock for current turn (LLM + tools). */
  turnStartedMs: number;
  /** Scratch: last LLM response for branching nodes. */
  llmResponse: LLMResponse | null;
  /** Scratch: routing for current turn. */
  route: { model: string; provider: string; max_tokens: number } | null;
  /** If set, run halts and caller must persist for resume. */
  pendingCheckpoint: CheckpointPayload | null;
  /** Node IDs with active breakpoints — halts before executing that node. */
  breakpointNodeIds: Set<string>;
  /** Whether the reflection gate has already retried once (max 1 retry). */
  reflectionRetried: boolean;
}

const FRESH_BOOTSTRAP = "fresh_bootstrap";
const FRESH_TURN_BUDGET = "fresh_turn_budget";
const FRESH_SUMMARIZE = "fresh_summarize";
const FRESH_ROUTE_LLM = "fresh_route_llm";
const FRESH_POST_LLM = "fresh_post_llm";
const FRESH_APPROVAL = "fresh_approval";
const FRESH_REFLECT = "fresh_reflect";
const FRESH_FINAL = "fresh_final_answer";
const FRESH_TOOLS = "fresh_tools";
const FRESH_LOOP = "fresh_loop_detect";
const FRESH_AFTER_TOOLS = "fresh_after_tools";

// ── Codemode Middleware Hook Helper ────────────────────────────────────

/**
 * Execute a codemode middleware hook if configured.
 * Returns the middleware action (continue, halt, modify) or null if no hook configured.
 */
async function runMiddlewareHook(
  ctx: FreshGraphCtx,
  hookName: "pre_llm" | "post_llm" | "pre_tool" | "post_tool" | "pre_output",
  context: unknown,
): Promise<{ action: string; modified?: unknown } | null> {
  const hooks = ctx.config.codemode_middleware;
  if (!hooks) return null;
  const snippetId = (hooks as Record<string, string | undefined>)[hookName];
  if (!snippetId) return null;

  try {
    const { loadSnippetCached, executeScopedCode } = await import("./codemode");
    const { getToolDefinitions } = await import("./tools");
    const snippet = await loadSnippetCached(ctx.hyperdrive, snippetId, ctx.config.org_id);
    if (!snippet) return null;

    const allTools = getToolDefinitions([]);
    const result = await executeScopedCode(ctx.env, snippet.code, allTools, ctx.sessionId, {
      scope: "middleware",
      input: context,
      traceId: ctx.traceId,
      orgId: ctx.config.org_id,
      snippetId,
    });

    if (!result.success) return null;
    const output = result.result as Record<string, unknown> | null;
    if (output && typeof output === "object" && output.action) {
      return output as { action: string; modified?: unknown };
    }
    return null;
  } catch {
    return null; // Middleware hooks are best-effort
  }
}

/**
 * Adjacency (fresh run):
 * bootstrap → turn_budget ⇄ summarize → route_llm → post_llm → reflect → final | approval | tools → loop → after_tools → turn_budget
 * post_llm → HALT on LLM error; final → HALT; loop → HALT on loop halt; after_tools → turn_budget or HALT
 */
const freshNodes: Record<string, EdgeGraphNode<FreshGraphCtx>> = {
  [FRESH_BOOTSTRAP]: {
    id: FRESH_BOOTSTRAP,
    description: "Memory/context init + codemode setup + session_start",
    async run(ctx) {
      const { env, hyperdrive, request, config, sessionId, traceId, rootGraphId, events } = ctx;
      ctx.workingMemory = createWorkingMemory(100);
      ctx.loopState = createLoopState();
      ctx.messages = [];

      if (config.system_prompt) {
        ctx.messages.push({ role: "system", content: config.system_prompt });
      }
      try {
        const memoryContext = await buildMemoryContext(
          env,
          hyperdrive,
          request.task,
          ctx.workingMemory,
          { agent_name: config.agent_name, org_id: config.org_id },
        );
        if (memoryContext) {
          ctx.messages.push({ role: "system", content: memoryContext });
        }
      } catch {
        /* best-effort */
      }

      // Code mode: collapse all tools into a single codemode tool if enabled
      // This saves ~85% of tool tokens in the context window
      if (config.use_code_mode) {
        try {
          const { getHarnessToolDefs } = await import("./codemode");
          ctx.activeTools = await getHarnessToolDefs(env, ctx.activeTools, sessionId, true);
        } catch (err) {
          console.error("[edge_graph] code mode init failed, falling back to tool mode:", err);
          // Fall back to regular tool mode
        }
      }

      // Reasoning strategy injection (harness pattern: reasoning prompts)
      // Selects a strategy based on config or auto-detects from task characteristics.
      // Injected as a system message before the user's task.
      try {
        const { selectReasoningStrategy, autoSelectStrategy } = await import("./reasoning-strategies");
        const strategyName = (config as any).reasoning_strategy;
        const strategyPrompt = selectReasoningStrategy(strategyName, request.task, 1)
          || (!strategyName ? autoSelectStrategy(request.task, ctx.activeTools.length) : null);
        if (strategyPrompt) {
          ctx.messages.push({ role: "system", content: strategyPrompt });
        }
      } catch {
        /* best-effort */
      }

      // Load and inject skills into system prompt
      try {
        const skills = await loadSkills(hyperdrive, config.org_id, config.agent_name);
        if (skills.length > 0) {
          const skillsSection = formatSkillsPrompt(skills);
          const sysMsg = ctx.messages.find((m) => m.role === "system");
          if (sysMsg) {
            sysMsg.content += skillsSection;
          }
        }
      } catch {
        /* best-effort */
      }

      let task = request.task;
      const channel = (request.channel || "").toLowerCase();
      if (["telegram", "discord", "whatsapp", "sms"].includes(channel)) {
        task =
          `[Channel: ${channel} — IMPORTANT RULES: ` +
          `1) Use AT MOST 2 tool calls then give your answer. ` +
          `2) Keep response under 500 characters. ` +
          `3) Use short paragraphs with bold key facts. ` +
          `4) No long essays or multiple searches.]\n\n` +
          request.task;
      }
      ctx.task = task;
      ctx.channel = channel || "api";
      ctx.messages.push({ role: "user", content: task });

      pushRuntimeEvent(events, "session_start", 0, {
        session_id: sessionId,
        trace_id: traceId,
        graph_id: rootGraphId,
        parent_graph_id: "",
        agent_name: config.agent_name,
        input: task,
        input_raw: request.input_raw ?? request.task,
        run_name: request.run_name || "",
        tags: request.tags || [],
        metadata: request.metadata || {},
        channel: ctx.channel,
      });

      // Write placeholder session row so turns FK doesn't fail
      writeSession(hyperdrive, {
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
      }).catch((err) => {
        console.error("[runtime] placeholder session write failed", err);
      });

      ctx.turn = 1;
      return FRESH_TURN_BUDGET;
    },
  },

  [FRESH_TURN_BUDGET]: {
    id: FRESH_TURN_BUDGET,
    description: "Governance budget gate + turn_start",
    async run(ctx) {
      if (ctx.turn > ctx.config.max_turns) return GRAPH_HALT;
      // Token-per-turn limit (0 = unlimited)
      const maxTpt = ctx.config.max_tokens_per_turn || 0;
      if (maxTpt > 0 && ctx.totalInputTokens + ctx.totalOutputTokens > maxTpt * ctx.turn) {
        ctx.stopReason = "token_limit";
        return GRAPH_HALT;
      }
      if (ctx.cumulativeCost >= ctx.config.budget_limit_usd) {
        ctx.stopReason = "budget";
        ctx.results.push({
          turn_number: ctx.turn,
          content: "",
          tool_results: [],
          done: true,
          stop_reason: "budget",
          error: "Budget exhausted",
          cost_usd: 0,
          cumulative_cost_usd: ctx.cumulativeCost,
          model: ctx.lastModel,
          execution_mode: "sequential",
          latency_ms: 0,
        });
        return GRAPH_HALT;
      }

      const { sessionId, traceId, rootGraphId, events, turn } = ctx;
      pushRuntimeEvent(events, "turn_start", turn, {
        turn,
        session_id: sessionId,
        trace_id: traceId,
        graph_id: rootGraphId,
        parent_graph_id: "",
      });
      pushRuntimeEvent(events, "governance_check", turn, {
        session_id: sessionId,
        trace_id: traceId,
        node_id: "governance",
        budget_remaining_usd: ctx.config.budget_limit_usd - ctx.cumulativeCost,
        budget_ok: ctx.cumulativeCost < ctx.config.budget_limit_usd,
      });
      return FRESH_SUMMARIZE;
    },
  },

  [FRESH_SUMMARIZE]: {
    id: FRESH_SUMMARIZE,
    description: "Optional context summarization",
    async run(ctx) {
      const { env, messages, events, sessionId, traceId, turn } = ctx;
      const { messages: compactedMessages, summarized, cost_usd: summaryCost } = await maybeSummarize(env, messages, {
        maxChars: 50_000,
        keepRecentCount: 6,
      });
      if (summarized) {
        messages.length = 0;
        messages.push(...compactedMessages);
        ctx.cumulativeCost += summaryCost; // Track summarization LLM cost
        pushRuntimeEvent(events, "context_summarized" as any, turn, {
          session_id: sessionId,
          trace_id: traceId,
          cost_usd: summaryCost,
        });
        // Emit middleware_event for summarization
        if (ctx.telemetryQueue) {
          ctx.telemetryQueue.send({
            type: "middleware_event",
            payload: {
              org_id: ctx.config.org_id,
              session_id: sessionId,
              middleware_name: "summarization",
              event_type: "context_summarized",
              details: { cost_usd: summaryCost, turn },
              created_at: new Date().toISOString(),
            },
          }).catch(() => {});
        }
      }
      return FRESH_ROUTE_LLM;
    },
  },

  [FRESH_ROUTE_LLM]: {
    id: FRESH_ROUTE_LLM,
    description: "Plan routing + pre_llm middleware + LLM call",
    async run(ctx) {
      const { env, config, messages, activeTools, events, sessionId, traceId, rootGraphId, turn } =
        ctx;
      ctx.turnStartedMs = Date.now();

      // Fire pre_llm middleware hook (can modify messages before LLM call)
      const preLlmResult = await runMiddlewareHook(ctx, "pre_llm", {
        messages: messages.map((m) => ({ role: m.role, content: m.content?.slice(0, 500) })),
        turn,
        cumulative_cost_usd: ctx.cumulativeCost,
      });
      if (preLlmResult?.action === "halt") {
        ctx.stopReason = "middleware_halt";
        ctx.output = String(preLlmResult.modified || "Halted by pre_llm middleware");
        return GRAPH_HALT;
      }
      if (preLlmResult?.action === "inject" && typeof preLlmResult.modified === "string") {
        messages.push({ role: "system", content: preLlmResult.modified });
      }
      const planRouting = resolvePlanRouting(
        config.plan,
        config.routing as Record<string, unknown> | undefined,
      );
      const route = selectModel(
        ctx.task,
        planRouting as PlanRouting | undefined,
        config.model,
        config.provider,
      );
      ctx.route = route;

      try {
        ctx.llmResponse = await callLLM(env, messages, activeTools, {
          model: route.model,
          provider: route.provider,
          max_tokens: route.max_tokens,
          metadata: {
            agent_name: config.agent_name,
            session_id: sessionId,
            org_id: config.org_id,
            turn,
            channel: ctx.channel,
          },
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? err.stack?.slice(0, 300) : "";
        console.error(`[EDGE_GRAPH] LLM error model=${route.model} task=${ctx.task?.slice(0,50)}: ${msg} ${stack}`);
        ctx.stopReason = "llm_error";
        ctx.llmResponse = null;
        ctx.results.push({
          turn_number: turn,
          content: "",
          tool_results: [],
          done: true,
          stop_reason: "llm_error",
          error: `LLM call failed: ${msg}`,
          cost_usd: 0,
          cumulative_cost_usd: ctx.cumulativeCost,
          model: route.model,
          execution_mode: "sequential",
          latency_ms: Date.now() - ctx.turnStartedMs,
        });
        return GRAPH_HALT;
      }

      const llmResponse = ctx.llmResponse!;
      ctx.lastModel = llmResponse.model;
      ctx.cumulativeCost += llmResponse.cost_usd;
      ctx.totalInputTokens += llmResponse.usage.input_tokens;
      ctx.totalOutputTokens += llmResponse.usage.output_tokens;

      pushRuntimeEvent(events, "node_start", turn, {
        node_id: "llm",
        session_id: sessionId,
        trace_id: traceId,
        graph_id: rootGraphId,
        parent_graph_id: "",
      });
      pushRuntimeEvent(events, "llm_response", turn, {
        session_id: sessionId,
        trace_id: traceId,
        graph_id: rootGraphId,
        parent_graph_id: "",
        model: llmResponse.model,
        provider: config.provider,
        input_tokens: llmResponse.usage.input_tokens,
        output_tokens: llmResponse.usage.output_tokens,
        cost_usd: llmResponse.cost_usd,
        latency_ms: llmResponse.latency_ms,
        has_tool_calls: llmResponse.tool_calls.length > 0,
        tool_call_count: llmResponse.tool_calls.length,
        tool_names: llmResponse.tool_calls.map((tc) => tc.name),
      });
      pushRuntimeEvent(events, "node_end", turn, {
        node_id: "llm",
        session_id: sessionId,
        trace_id: traceId,
        graph_id: rootGraphId,
        parent_graph_id: "",
        status: "completed",
        latency_ms: llmResponse.latency_ms,
      });

      return FRESH_POST_LLM;
    },
  },

  [FRESH_POST_LLM]: {
    id: FRESH_POST_LLM,
    description: "Branch: reflection → final answer vs tools",
    async run(ctx) {
      const llm = ctx.llmResponse;
      if (!llm) return GRAPH_HALT;
      if (llm.tool_calls.length === 0) return FRESH_REFLECT;
      if (ctx.config.require_human_approval) return FRESH_APPROVAL;
      return FRESH_TOOLS;
    },
  },

  [FRESH_REFLECT]: {
    id: FRESH_REFLECT,
    description: "Reflection gate: assess confidence before finalizing (harness pattern)",
    async run(ctx) {
      const llm = ctx.llmResponse!;
      const { results, events, sessionId, traceId, turn } = ctx;

      // Calculate confidence score (1.0 baseline, deducted for failures/warnings)
      let confidence = 1.0;
      const toolFailures: string[] = [];
      const warnings: string[] = [];

      for (const result of results) {
        if (result.tool_results) {
          for (const tr of result.tool_results) {
            if (tr.error) {
              confidence -= 0.15;
              toolFailures.push(`${tr.tool}: ${(tr.error || "").slice(0, 80)}`);
            }
          }
        }
        if (result.error) {
          confidence -= 0.2;
          warnings.push(result.error.slice(0, 80));
        }
      }
      // Penalize if answer is very short relative to task complexity
      if (llm.content.length < 20 && ctx.task.length > 100) {
        confidence -= 0.2;
        warnings.push("Answer is very short relative to task complexity");
      }
      confidence = Math.max(0, Math.min(1, confidence));

      // Record reflection artifact as telemetry event
      pushRuntimeEvent(events, "governance_check" as any, turn, {
        session_id: sessionId,
        trace_id: traceId,
        node_id: "reflection",
        confidence,
        tool_failures: toolFailures,
        warnings,
        action: confidence >= 0.6 ? "finalize" : "retry",
      });

      // If confidence is below threshold and we haven't retried yet, ask model to reconsider
      if (confidence < 0.6 && !ctx.reflectionRetried) {
        ctx.reflectionRetried = true;
        const issues = [
          ...toolFailures.map((f) => `Tool failure: ${f}`),
          ...warnings.map((w) => `Warning: ${w}`),
        ];
        ctx.messages.push({
          role: "system",
          content:
            `[Reflection gate] Confidence is ${confidence.toFixed(2)} (below 0.6 threshold). ` +
            `Issues: ${issues.join("; ")}. ` +
            `Please reconsider your answer and try again with a more thorough approach.`,
        });
        // Route back to LLM for another attempt
        return FRESH_ROUTE_LLM;
      }

      // Fire pre_output middleware hook (can modify or reject the final answer)
      const preOutputResult = await runMiddlewareHook(ctx, "pre_output", {
        output: llm.content,
        confidence,
        tool_failures: toolFailures,
        turn,
      });
      if (preOutputResult?.action === "reject" && typeof preOutputResult.modified === "string") {
        if (!ctx.reflectionRetried) {
          ctx.reflectionRetried = true;
          ctx.messages.push({ role: "system", content: preOutputResult.modified });
          return FRESH_ROUTE_LLM;
        }
      }
      if (preOutputResult?.action === "modify" && typeof preOutputResult.modified === "string") {
        ctx.llmResponse = { ...llm, content: preOutputResult.modified };
      }

      return FRESH_FINAL;
    },
  },

  [FRESH_APPROVAL]: {
    id: FRESH_APPROVAL,
    description: "Create pending approval checkpoint and halt",
    async run(ctx) {
      const llm = ctx.llmResponse!;
      const checkpointId = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
      ctx.pendingCheckpoint = {
        checkpoint_id: checkpointId,
        session_id: ctx.sessionId,
        trace_id: ctx.traceId,
        agent_name: ctx.config.agent_name,
        messages: ctx.messages,
        current_turn: ctx.turn,
        cumulative_cost_usd: ctx.cumulativeCost,
        status: "pending_approval",
        created_at: Date.now(),
      };
      ctx.stopReason = "human_approval_required";
      ctx.output = "";
      ctx.results.push({
        turn_number: ctx.turn,
        content: llm.content || "",
        tool_results: [],
        done: true,
        stop_reason: "human_approval_required",
        cost_usd: llm.cost_usd,
        cumulative_cost_usd: ctx.cumulativeCost,
        model: llm.model,
        execution_mode: "sequential",
        latency_ms: Date.now() - ctx.turnStartedMs,
      });
      pushRuntimeEvent(ctx.events, "governance_check", ctx.turn, {
        session_id: ctx.sessionId,
        trace_id: ctx.traceId,
        approval_required: true,
        checkpoint_id: checkpointId,
        tool_call_count: llm.tool_calls.length,
        tool_names: llm.tool_calls.map((tc) => tc.name),
      });
      pushRuntimeEvent(ctx.events, "turn_end", ctx.turn, {
        session_id: ctx.sessionId,
        trace_id: ctx.traceId,
        graph_id: ctx.rootGraphId,
        parent_graph_id: "",
        done: true,
        stop_reason: "human_approval_required",
        checkpoint_id: checkpointId,
      });
      return GRAPH_HALT;
    },
  },

  [FRESH_FINAL]: {
    id: FRESH_FINAL,
    description: "Record final turn + turn_end + HALT",
    async run(ctx) {
      const llm = ctx.llmResponse!;
      const {
        hyperdrive,
        sessionId,
        events,
        traceId,
        rootGraphId,
        turn,
        stateReducerOverrides,
        results,
      } = ctx;
      ctx.output = llm.content;
      ctx.stopReason = "end_turn";
      results.push({
        turn_number: turn,
        content: llm.content,
        tool_results: [],
        done: true,
        stop_reason: "end_turn",
        cost_usd: llm.cost_usd,
        cumulative_cost_usd: ctx.cumulativeCost,
        model: llm.model,
        execution_mode: "sequential",
        latency_ms: Date.now() - ctx.turnStartedMs,
      });

      await writeTurnAsync(hyperdrive, sessionId, turn, llm, [], ctx.telemetryQueue);
      const stateSnapshot = mergeStateSnapshots(
        [
          {
            branch_id: "final",
            state: {
              cost_usd: llm.cost_usd,
              tool_calls: 0,
              model: llm.model,
            },
          },
        ],
        {
          cost_usd: stateReducerOverrides.cost_usd || "sum_numeric",
          tool_calls: stateReducerOverrides.tool_calls || "sum_numeric",
          model: stateReducerOverrides.model || "replace",
        },
      );
      pushRuntimeEvent(events, "turn_end", turn, {
        session_id: sessionId,
        trace_id: traceId,
        graph_id: rootGraphId,
        parent_graph_id: "",
        done: true,
        stop_reason: "end_turn",
        state_snapshot: stateSnapshot,
      });
      return GRAPH_HALT;
    },
  },

  [FRESH_TOOLS]: {
    id: FRESH_TOOLS,
    description: "Tool fanout/fanin + turn recording",
    async run(ctx) {
      const llm = ctx.llmResponse!;
      const {
        env,
        messages,
        hyperdrive,
        sessionId,
        events,
        traceId,
        rootGraphId,
        turn,
        config,
        stateReducerOverrides,
        results,
      } = ctx;

      messages.push({
        role: "assistant",
        content: llm.content,
        tool_calls: llm.tool_calls,
      });

      const toolStageStarted = Date.now();
      pushRuntimeEvent(events, "node_start", turn, {
        node_id: "subgraph_tools",
        session_id: sessionId,
        trace_id: traceId,
        graph_id: `tool_fanout:${turn}`,
        parent_graph_id: rootGraphId,
        parent_node_id: `llm:${turn}`,
      });

      // Attach governance config for domain allowlist + destructive detection
      (env as any).__agentConfig = {
        allowed_domains: config.allowed_domains || [],
        require_confirmation_for_destructive: config.require_confirmation_for_destructive || false,
        max_tokens_per_turn: config.max_tokens_per_turn || 0,
      };
      const toolResults = await executeTools(
        env,
        llm.tool_calls,
        sessionId,
        config.parallel_tool_calls,
        config.tools, // Pass agent's enabled tools to prevent codemode privilege escalation
      );
      ctx.totalToolCalls += toolResults.length;
      // Accumulate tool execution costs (search, crawl, etc.)
      ctx.cumulativeCost += toolResults.reduce((sum, tr) => sum + (tr.cost_usd || 0), 0);

      for (let i = 0; i < llm.tool_calls.length; i++) {
        const tc = llm.tool_calls[i];
        const tr =
          toolResults[i] ||
          ({ result: "No result", tool: tc.name, tool_call_id: tc.id, latency_ms: 0 } as ToolResult);
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          name: tc.name,
          content: tr.error ? `Error: ${tr.error}` : tr.result,
        });

        pushRuntimeEvent(events, "tool_call", turn, {
          session_id: sessionId,
          trace_id: traceId,
          tool_name: tc.name,
          tool_call_id: tc.id,
          graph_id: `tool_fanout:${turn}`,
          parent_graph_id: rootGraphId,
          parent_node_id: `node:${turn}:subgraph_tools`,
          arguments_preview: tc.arguments.slice(0, 200),
        });
        pushRuntimeEvent(events, "tool_result", turn, {
          session_id: sessionId,
          trace_id: traceId,
          tool_name: tc.name,
          tool_call_id: tc.id,
          graph_id: `tool_fanout:${turn}`,
          parent_graph_id: rootGraphId,
          parent_node_id: `node:${turn}:subgraph_tools`,
          latency_ms: tr.latency_ms,
          status: tr.error ? "error" : "ok",
          error: tr.error || "",
          result_preview: (tr.result || "").slice(0, 200),
        });
      }

      pushRuntimeEvent(events, "node_end", turn, {
        node_id: "subgraph_tools",
        session_id: sessionId,
        trace_id: traceId,
        graph_id: `tool_fanout:${turn}`,
        parent_graph_id: rootGraphId,
        parent_node_id: `llm:${turn}`,
        status: "completed",
        latency_ms: Date.now() - toolStageStarted,
      });

      // Tool failure recovery: inject guidance when tools fail (harness pattern)
      // Instead of blind retry, we tell the agent what failed so it can try
      // a different approach on the next turn.
      const failedTools = toolResults.filter((tr) => tr.error);
      if (failedTools.length > 0) {
        const failureSummary = failedTools
          .map((tr) => `- ${tr.tool}: ${(tr.error || "").slice(0, 150)}`)
          .join("\n");
        messages.push({
          role: "system",
          content:
            `[Tool failure notice] ${failedTools.length} tool(s) failed this turn:\n${failureSummary}\n` +
            `Consider an alternative approach — use different tools, different arguments, ` +
            `or break the task into smaller steps.`,
        });
      }

      const executionMode =
        config.parallel_tool_calls && llm.tool_calls.length > 1 ? "parallel" : "sequential";

      results.push({
        turn_number: turn,
        content: llm.content,
        tool_results: toolResults,
        done: false,
        stop_reason: "tool_call",
        cost_usd: llm.cost_usd,
        cumulative_cost_usd: ctx.cumulativeCost,
        model: llm.model,
        execution_mode: executionMode,
        latency_ms: Date.now() - ctx.turnStartedMs,
      });

      await writeTurnAsync(hyperdrive, sessionId, turn, llm, toolResults, ctx.telemetryQueue);
      const toolResultById = new Map(
        toolResults
          .filter((tr) => typeof tr?.tool_call_id === "string" && tr.tool_call_id.length > 0)
          .map((tr) => [tr.tool_call_id, tr] as const),
      );
      const stateSnapshot = mergeStateSnapshots(
        llm.tool_calls.map((tc, idx) => ({
          branch_id: tc.id || `${idx}`,
          state: {
            cost_usd: llm.cost_usd,
            tool_calls: 1,
            tool_latency_ms: Number(toolResultById.get(tc.id || "")?.latency_ms || 0),
            tool_results: [toolResultById.get(tc.id || "") || null],
          },
        })),
        {
          cost_usd: stateReducerOverrides.cost_usd || "max_numeric",
          tool_calls: stateReducerOverrides.tool_calls || "sum_numeric",
          tool_results: stateReducerOverrides.tool_results || "append_list",
          tool_latency_ms: stateReducerOverrides.tool_latency_ms || "max_numeric",
        },
      );
      pushRuntimeEvent(events, "turn_end", turn, {
        session_id: sessionId,
        trace_id: traceId,
        graph_id: rootGraphId,
        parent_graph_id: "",
        done: false,
        stop_reason: "tool_call",
        state_snapshot: stateSnapshot,
      });

      return FRESH_LOOP;
    },
  },

  [FRESH_LOOP]: {
    id: FRESH_LOOP,
    description: "Loop detection (+ optional halt)",
    async run(ctx) {
      const llm = ctx.llmResponse!;
      const loopResult = detectLoop(
        ctx.loopState,
        llm.tool_calls.map((tc) => ({
          name: tc.name,
          arguments: tc.arguments,
        })),
      );
      if (loopResult?.halt) {
        ctx.output = loopResult.halt;
        ctx.stopReason = "loop_detected";
        ctx.results.push({
          turn_number: ctx.turn + 1,
          content: loopResult.halt,
          tool_results: [],
          done: true,
          stop_reason: "loop_detected",
          error: loopResult.halt,
          cost_usd: 0,
          cumulative_cost_usd: ctx.cumulativeCost,
          model: ctx.lastModel,
          execution_mode: "sequential",
          latency_ms: 0,
        });
        // Emit middleware_event for loop detection halt
        if (ctx.telemetryQueue) {
          ctx.telemetryQueue.send({
            type: "middleware_event",
            payload: {
              org_id: ctx.config.org_id,
              session_id: ctx.sessionId,
              middleware_name: "loop_detection",
              event_type: "loop_halt",
              details: { message: loopResult.halt, turn: ctx.turn },
              created_at: new Date().toISOString(),
            },
          }).catch(() => {});
        }
        return GRAPH_HALT;
      }
      if (loopResult?.warn) {
        ctx.messages.push({ role: "system", content: loopResult.warn });
        // Emit middleware_event for loop detection warning
        if (ctx.telemetryQueue) {
          ctx.telemetryQueue.send({
            type: "middleware_event",
            payload: {
              org_id: ctx.config.org_id,
              session_id: ctx.sessionId,
              middleware_name: "loop_detection",
              event_type: "loop_warn",
              details: { message: loopResult.warn, turn: ctx.turn },
              created_at: new Date().toISOString(),
            },
          }).catch(() => {});
        }
      }
      return FRESH_AFTER_TOOLS;
    },
  },

  [FRESH_AFTER_TOOLS]: {
    id: FRESH_AFTER_TOOLS,
    description: "Fact extraction (turn 1) + next turn",
    async run(ctx) {
      if (ctx.turn === 1) {
        queueFactExtraction(
          ctx.env,
          ctx.hyperdrive,
          ctx.request.task,
          ctx.sessionId,
          ctx.config.agent_name,
          ctx.config.org_id,
        );
      }
      ctx.turn += 1;
      ctx.llmResponse = null;
      ctx.route = null;
      return FRESH_TURN_BUDGET;
    },
  },
};

/**
 * Run the fresh-session graph (memory → … → per-turn loop until HALT).
 */
export async function executeFreshRunGraph(ctx: FreshGraphCtx): Promise<void> {
  await runEdgeGraph(ctx, FRESH_BOOTSTRAP, freshNodes);
}

export function freshRunPostLoop(ctx: FreshGraphCtx): void {
  if (!ctx.results.some((r) => r.done)) {
    ctx.stopReason = "max_turns";
    const lastResult = ctx.results[ctx.results.length - 1];
    if (lastResult) {
      ctx.output = lastResult.content;
      lastResult.done = true;
      lastResult.stop_reason = "max_turns";
    }
  }
}

export function buildFreshGraphCtx(
  env: RuntimeEnv,
  hyperdrive: Hyperdrive,
  request: RunRequest,
  config: AgentConfig,
  sessionId: string,
  traceId: string,
  telemetryQueue?: Queue,
): FreshGraphCtx {
  const toolDefs = getToolDefinitions(config.tools);
  const blockedSet = new Set(config.blocked_tools);
  const activeTools = toolDefs.filter((t) => !blockedSet.has(t.function.name));
  const stateReducerOverrides = coerceReducerMap(
    config.state_reducers && typeof config.state_reducers === "object"
      ? (config.state_reducers as Record<string, unknown>)
      : undefined,
  );
  return {
    env,
    hyperdrive,
    telemetryQueue,
    started: Date.now(),
    sessionId,
    traceId,
    rootGraphId: "root",
    request,
    config,
    messages: [],
    events: [],
    results: [],
    workingMemory: createWorkingMemory(100),
    loopState: createLoopState(),
    activeTools,
    stateReducerOverrides,
    turn: 1,
    cumulativeCost: 0,
    totalToolCalls: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    output: "",
    stopReason: "end_turn",
    lastModel: config.model,
    task: "",
    channel: "api",
    turnStartedMs: 0,
    llmResponse: null,
    route: null,
    pendingCheckpoint: null,
    breakpointNodeIds: extractBreakpointNodeIds(config),
    reflectionRetried: false,
  };
}

/**
 * Extract breakpoint node IDs from the agent config's declarative graph.
 * Nodes with `breakpoint: true` cause the graph executor to halt before them.
 */
function extractBreakpointNodeIds(config: AgentConfig): Set<string> {
  const ids = new Set<string>();
  try {
    const raw = config as unknown as Record<string, unknown>;
    // Try harness.declarative_graph.nodes, harness.graph.nodes, or top-level graph.nodes
    const candidates = [
      (raw.harness as Record<string, unknown> | undefined)?.declarative_graph,
      (raw.harness as Record<string, unknown> | undefined)?.graph,
      raw.declarative_graph,
      raw.graph,
    ];
    for (const candidate of candidates) {
      if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
        const nodes = (candidate as Record<string, unknown>).nodes;
        if (nodes && typeof nodes === "object" && !Array.isArray(nodes)) {
          for (const [nodeId, nodeCfg] of Object.entries(nodes as Record<string, unknown>)) {
            if (nodeCfg && typeof nodeCfg === "object" && (nodeCfg as Record<string, unknown>).breakpoint === true) {
              ids.add(nodeId);
            }
          }
          break; // found a valid graph, stop searching
        }
      }
    }
  } catch {
    // best-effort
  }
  return ids;
}

// ── Resume graph ───────────────────────────────────────────────────────────

export interface ResumeGraphCtx {
  env: RuntimeEnv;
  hyperdrive: Hyperdrive;
  telemetryQueue?: Queue;
  started: number;
  resumedSessionId: string;
  checkpoint: CheckpointPayload;
  checkpointId: string;
  rootGraphId: string;
  config: AgentConfig;
  messages: LLMMessage[];
  events: RuntimeEvent[];
  results: TurnResult[];
  activeTools: ToolDefinition[];
  stateReducerOverrides: Record<string, StateMergeStrategy>;
  turn: number;
  cumulativeCost: number;
  totalToolCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  output: string;
  stopReason: string;
  lastModel: string;
  turnStartedMs: number;
  llmResponse: LLMResponse | null;
}

const RESUME_TURN_GATE = "resume_turn_gate";
const RESUME_LLM = "resume_llm";
const RESUME_POST_LLM = "resume_post_llm";
const RESUME_FINAL = "resume_final";
const RESUME_TOOLS = "resume_tools";
const RESUME_BUMP_TURN = "resume_bump_turn";

/**
 * Pytest contract: emit types for resume **turn** graph nodes only (`session_resume` /
 * `session_end` live in `engine.edgeResume`). Source-order branch narrative.
 */
export const EDGE_RESUME_GRAPH_EMIT_ORDER = [
  "turn_start",
  "node_error",
  "turn_end",
  "node_start",
  "llm_response",
  "node_end",
  "turn_end",
  "node_start",
  "tool_call",
  "tool_result",
  "node_end",
  "turn_end",
] as const;

const resumeNodes: Record<string, EdgeGraphNode<ResumeGraphCtx>> = {
  [RESUME_TURN_GATE]: {
    id: RESUME_TURN_GATE,
    description: "Budget gate + turn_start",
    async run(ctx) {
      if (ctx.turn > ctx.config.max_turns) return GRAPH_HALT;
      if (ctx.cumulativeCost >= ctx.config.budget_limit_usd) {
        ctx.stopReason = "budget";
        return GRAPH_HALT;
      }
      const { resumedSessionId, events, checkpoint, rootGraphId, turn } = ctx;
      pushRuntimeEvent(events, "turn_start", turn, {
        turn,
        session_id: resumedSessionId,
        trace_id: checkpoint.trace_id,
        graph_id: rootGraphId,
        parent_graph_id: "",
      });
      return RESUME_LLM;
    },
  },

  [RESUME_LLM]: {
    id: RESUME_LLM,
    description: "LLM call (fixed model) + telemetry",
    async run(ctx) {
      const { env, config, messages, activeTools, resumedSessionId, events, checkpoint, rootGraphId, turn } =
        ctx;
      ctx.turnStartedMs = Date.now();
      try {
        ctx.llmResponse = await callLLM(env, messages, activeTools, {
          model: config.model,
          provider: config.provider,
          max_tokens: 4096,
          metadata: {
            agent_name: config.agent_name,
            session_id: resumedSessionId,
            org_id: config.org_id,
            turn,
          },
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.stopReason = "llm_error";
        ctx.llmResponse = null;
        const errorMs = Date.now() - ctx.turnStartedMs;
        pushRuntimeEvent(events, "node_error", turn, {
          node_id: "llm",
          session_id: resumedSessionId,
          trace_id: checkpoint.trace_id,
          graph_id: rootGraphId,
          parent_graph_id: "",
          error: String(msg || "LLM call failed"),
          status: "error",
          latency_ms: errorMs,
        });
        pushRuntimeEvent(events, "turn_end", turn, {
          session_id: resumedSessionId,
          trace_id: checkpoint.trace_id,
          graph_id: rootGraphId,
          parent_graph_id: "",
          done: true,
          stop_reason: "llm_error",
          state_snapshot: {
            cost_usd: ctx.cumulativeCost,
            tool_calls: 0,
            model: config.model,
          },
        });
        ctx.results.push({
          turn_number: turn,
          content: "",
          tool_results: [],
          done: true,
          stop_reason: "llm_error",
          error: `LLM call failed: ${msg}`,
          cost_usd: 0,
          cumulative_cost_usd: ctx.cumulativeCost,
          model: config.model,
          execution_mode: "sequential",
          latency_ms: errorMs,
        });
        return GRAPH_HALT;
      }

      const llmResponse = ctx.llmResponse!;
      ctx.lastModel = llmResponse.model;
      ctx.cumulativeCost += llmResponse.cost_usd;
      ctx.totalInputTokens += llmResponse.usage.input_tokens;
      ctx.totalOutputTokens += llmResponse.usage.output_tokens;

      pushRuntimeEvent(events, "node_start", turn, {
        node_id: "llm",
        session_id: resumedSessionId,
        trace_id: checkpoint.trace_id,
        graph_id: rootGraphId,
        parent_graph_id: "",
      });
      pushRuntimeEvent(events, "llm_response", turn, {
        session_id: resumedSessionId,
        trace_id: checkpoint.trace_id,
        graph_id: rootGraphId,
        parent_graph_id: "",
        model: llmResponse.model,
        provider: config.provider,
        input_tokens: llmResponse.usage.input_tokens,
        output_tokens: llmResponse.usage.output_tokens,
        cost_usd: llmResponse.cost_usd,
        latency_ms: llmResponse.latency_ms,
        has_tool_calls: llmResponse.tool_calls.length > 0,
        tool_call_count: llmResponse.tool_calls.length,
        tool_names: llmResponse.tool_calls.map((tc) => tc.name),
      });
      pushRuntimeEvent(events, "node_end", turn, {
        node_id: "llm",
        session_id: resumedSessionId,
        trace_id: checkpoint.trace_id,
        graph_id: rootGraphId,
        parent_graph_id: "",
        status: "completed",
        latency_ms: llmResponse.latency_ms,
      });

      return RESUME_POST_LLM;
    },
  },

  [RESUME_POST_LLM]: {
    id: RESUME_POST_LLM,
    description: "Branch: final vs tools",
    async run(ctx) {
      const llm = ctx.llmResponse;
      if (!llm) return GRAPH_HALT;
      if (llm.tool_calls.length === 0) return RESUME_FINAL;
      return RESUME_TOOLS;
    },
  },

  [RESUME_FINAL]: {
    id: RESUME_FINAL,
    description: "Final turn record + turn_end",
    async run(ctx) {
      const llm = ctx.llmResponse!;
      const { resumedSessionId, events, checkpoint, rootGraphId, turn, stateReducerOverrides, results } =
        ctx;
      ctx.output = llm.content;
      ctx.stopReason = "end_turn";
      results.push({
        turn_number: turn,
        content: llm.content,
        tool_results: [],
        done: true,
        stop_reason: "end_turn",
        cost_usd: llm.cost_usd,
        cumulative_cost_usd: ctx.cumulativeCost,
        model: llm.model,
        execution_mode: "sequential",
        latency_ms: Date.now() - ctx.turnStartedMs,
      });
      const stateSnapshot = mergeStateSnapshots(
        [
          {
            branch_id: "final",
            state: {
              cost_usd: llm.cost_usd,
              tool_calls: 0,
              model: llm.model,
            },
          },
        ],
        {
          cost_usd: stateReducerOverrides.cost_usd || "sum_numeric",
          tool_calls: stateReducerOverrides.tool_calls || "sum_numeric",
          model: stateReducerOverrides.model || "replace",
        },
      );
      pushRuntimeEvent(events, "turn_end", turn, {
        session_id: resumedSessionId,
        trace_id: checkpoint.trace_id,
        graph_id: rootGraphId,
        parent_graph_id: "",
        done: true,
        stop_reason: "end_turn",
        state_snapshot: stateSnapshot,
      });
      return GRAPH_HALT;
    },
  },

  [RESUME_TOOLS]: {
    id: RESUME_TOOLS,
    description: "Tool fanout/fanin + turn_end (tool_call)",
    async run(ctx) {
      const llm = ctx.llmResponse!;
      const {
        env,
        messages,
        resumedSessionId,
        events,
        checkpoint,
        rootGraphId,
        turn,
        config,
        stateReducerOverrides,
        results,
      } = ctx;

      messages.push({
        role: "assistant",
        content: llm.content,
        tool_calls: llm.tool_calls,
      });
      const toolStageStarted = Date.now();
      pushRuntimeEvent(events, "node_start", turn, {
        node_id: "subgraph_tools",
        session_id: resumedSessionId,
        trace_id: checkpoint.trace_id,
        graph_id: `tool_fanout:${turn}`,
        parent_graph_id: rootGraphId,
        parent_node_id: `llm:${turn}`,
      });
      const toolResults = await executeTools(
        env,
        llm.tool_calls,
        resumedSessionId,
        config.parallel_tool_calls,
      );
      ctx.totalToolCalls += toolResults.length;
      // Accumulate tool execution costs (search, crawl, etc.)
      ctx.cumulativeCost += toolResults.reduce((sum, tr) => sum + (tr.cost_usd || 0), 0);

      for (let i = 0; i < llm.tool_calls.length; i++) {
        const tc = llm.tool_calls[i];
        const tr =
          toolResults[i] ||
          ({ result: "No result", tool: tc.name, tool_call_id: tc.id, latency_ms: 0 } as ToolResult);
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          name: tc.name,
          content: tr.error ? `Error: ${tr.error}` : tr.result,
        });
        pushRuntimeEvent(events, "tool_call", turn, {
          session_id: resumedSessionId,
          trace_id: checkpoint.trace_id,
          tool_name: tc.name,
          tool_call_id: tc.id,
          graph_id: `tool_fanout:${turn}`,
          parent_graph_id: rootGraphId,
          parent_node_id: `node:${turn}:subgraph_tools`,
          arguments_preview: tc.arguments.slice(0, 200),
        });
        pushRuntimeEvent(events, "tool_result", turn, {
          session_id: resumedSessionId,
          trace_id: checkpoint.trace_id,
          tool_name: tc.name,
          tool_call_id: tc.id,
          graph_id: `tool_fanout:${turn}`,
          parent_graph_id: rootGraphId,
          parent_node_id: `node:${turn}:subgraph_tools`,
          latency_ms: tr.latency_ms,
          status: tr.error ? "error" : "ok",
          error: tr.error || "",
          result_preview: (tr.result || "").slice(0, 200),
        });
      }
      pushRuntimeEvent(events, "node_end", turn, {
        node_id: "subgraph_tools",
        session_id: resumedSessionId,
        trace_id: checkpoint.trace_id,
        graph_id: `tool_fanout:${turn}`,
        parent_graph_id: rootGraphId,
        parent_node_id: `llm:${turn}`,
        status: "completed",
        latency_ms: Date.now() - toolStageStarted,
      });

      results.push({
        turn_number: turn,
        content: llm.content,
        tool_results: toolResults,
        done: false,
        stop_reason: "tool_call",
        cost_usd: llm.cost_usd,
        cumulative_cost_usd: ctx.cumulativeCost,
        model: llm.model,
        execution_mode:
          config.parallel_tool_calls && llm.tool_calls.length > 1 ? "parallel" : "sequential",
        latency_ms: Date.now() - ctx.turnStartedMs,
      });
      const toolResultById = new Map(
        toolResults
          .filter((tr) => typeof tr?.tool_call_id === "string" && tr.tool_call_id.length > 0)
          .map((tr) => [tr.tool_call_id, tr] as const),
      );
      const stateSnapshot = mergeStateSnapshots(
        llm.tool_calls.map((tc, idx) => ({
          branch_id: tc.id || `${idx}`,
          state: {
            cost_usd: llm.cost_usd,
            tool_calls: 1,
            tool_latency_ms: Number(toolResultById.get(tc.id || "")?.latency_ms || 0),
            tool_results: [toolResultById.get(tc.id || "") || null],
          },
        })),
        {
          cost_usd: stateReducerOverrides.cost_usd || "max_numeric",
          tool_calls: stateReducerOverrides.tool_calls || "sum_numeric",
          tool_results: stateReducerOverrides.tool_results || "append_list",
          tool_latency_ms: stateReducerOverrides.tool_latency_ms || "max_numeric",
        },
      );
      pushRuntimeEvent(events, "turn_end", turn, {
        session_id: resumedSessionId,
        trace_id: checkpoint.trace_id,
        graph_id: rootGraphId,
        parent_graph_id: "",
        done: false,
        stop_reason: "tool_call",
        state_snapshot: stateSnapshot,
      });
      return RESUME_BUMP_TURN;
    },
  },

  [RESUME_BUMP_TURN]: {
    id: RESUME_BUMP_TURN,
    description: "Advance turn counter for resume loop",
    async run(ctx) {
      ctx.turn += 1;
      ctx.llmResponse = null;
      return RESUME_TURN_GATE;
    },
  },
};

/**
 * Execute checkpoint resume via the resume graph (session_resume emit must be done by caller).
 */
export async function executeResumeTurnGraph(ctx: ResumeGraphCtx): Promise<void> {
  await runEdgeGraph(ctx, RESUME_TURN_GATE, resumeNodes);
}

export function buildResumeGraphCtx(
  env: RuntimeEnv,
  hyperdrive: Hyperdrive,
  checkpoint: CheckpointPayload,
  checkpointId: string,
  resumedSessionId: string,
  config: AgentConfig,
  telemetryQueue?: Queue,
): ResumeGraphCtx {
  const toolDefs = getToolDefinitions(config.tools);
  const blockedSet = new Set(config.blocked_tools);
  const activeTools = toolDefs.filter((t) => !blockedSet.has(t.function.name));
  const stateReducerOverrides = coerceReducerMap(
    config.state_reducers as Record<string, unknown> | undefined,
  );
  return {
    env,
    hyperdrive,
    telemetryQueue,
    started: Date.now(),
    resumedSessionId,
    checkpoint,
    checkpointId,
    rootGraphId: "root",
    config,
    messages: checkpoint.messages,
    events: [],
    results: [],
    activeTools,
    stateReducerOverrides,
    turn: checkpoint.current_turn,
    cumulativeCost: checkpoint.cumulative_cost_usd,
    totalToolCalls: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    output: "",
    stopReason: "end_turn",
    lastModel: config.model,
    turnStartedMs: 0,
    llmResponse: null,
  };
}
