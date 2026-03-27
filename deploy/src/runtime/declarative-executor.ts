/**
 * Unified Declarative Graph Executor
 * 
 * Integrates subgraph expansion, schema validation, caching, and node registry
 * into a single execution path for user-defined declarative graphs.
 */

import { callLLM } from "./llm";
import { executeTools, getToolDefinitions } from "./tools";
import { writeSession, resolvePlanRouting } from "./db";
import { selectModel, type PlanRouting } from "./router";
import { buildMemoryContext, createWorkingMemory } from "./memory";
import { detectLoop, createLoopState } from "./middleware";
import { pushRuntimeEvent, mergeStateSnapshots, type StateMergeStrategy } from "./edge_graph";
import { subgraphRegistry, expandSubgraphs, type SubgraphDefinition } from "./subgraph";
import { schemaRegistry, validateDataAgainstSchema, validateGraphSchemas, type JsonSchema } from "./graph-schema";
import { 
  getCachedValidation, 
  setCachedValidation, 
  getCachedExpansion, 
  setCachedExpansion,
  getCachedLinearPath,
  setCachedLinearPath,
} from "./graph-cache";
import { nodeRegistry } from "./node-registry";
import {
  executeScopedCode,
  executeValidator,
  executeMiddleware,
  type CodemodeScope,
  type CodemodeResult,
  type MiddlewareAction,
} from "./codemode";
import type {
  RuntimeEnv,
  AgentConfig,
  LLMMessage,
  LLMResponse,
  ToolResult,
  TurnResult,
  RunRequest,
  ToolDefinition,
  RuntimeEvent,
} from "./types";
import type { GraphSpec, GraphNodeRecord } from "./linear_declarative";

// Re-export for consumers
export { subgraphRegistry, schemaRegistry, nodeRegistry };

// --- Types ---

export interface DeclarativeGraphContext {
  env: RuntimeEnv;
  hyperdrive: Hyperdrive;
  telemetryQueue?: Queue;
  
  sessionId: string;
  traceId: string;
  rootGraphId: string;
  parentGraphId?: string;
  depth: number;
  
  config: AgentConfig & {
    skip_schema_validation?: boolean;
    strict_schema_validation?: boolean;
  };
  request: RunRequest;
  
  messages: LLMMessage[];
  workingMemory: ReturnType<typeof createWorkingMemory>;
  loopState: ReturnType<typeof createLoopState>;
  
  activeTools: ToolDefinition[];
  blockedTools: Set<string>;
  
  events: RuntimeEvent[];
  results: TurnResult[];
  turn: number;
  cumulativeCost: number;
  totalToolCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  
  output: string;
  stopReason: string;
  lastModel: string;
  
  started: number;
  turnStartedMs: number;
  
  stateReducerOverrides: Record<string, StateMergeStrategy>;
  nodeState: Map<string, unknown>;
  
  onEvent?: (event: RuntimeEvent) => void | Promise<void>;
  
  validationErrors: Array<{
    nodeId: string;
    schemaType: "input" | "output";
    error: string;
  }>;
}

export interface NodeExecutionResult {
  success: boolean;
  nextNodeId?: string;
  output?: unknown;
  error?: string;
  costUsd: number;
  latencyMs: number;
}

export interface PreparedGraph {
  original: GraphSpec;
  expanded: GraphSpec;
  executionOrder: string[];
  nodeMap: Map<string, GraphNodeRecord>;
  validationResult: {
    valid: boolean;
    errors: Array<{ code: string; message: string; path?: string }>;
  };
  fromCache: boolean;
}

export interface DeclarativeGraphResult {
  success: boolean;
  output: string;
  events: RuntimeEvent[];
  costUsd: number;
  latencyMs: number;
  turnCount: number;
  toolCallCount: number;
  validationErrors: Array<{ nodeId: string; schemaType: "input" | "output"; error: string }>;
  error?: string;
}

// --- Context Builder ---

export async function buildDeclarativeGraphContext(
  env: RuntimeEnv,
  hyperdrive: Hyperdrive,
  request: RunRequest,
  config: AgentConfig,
  options: {
    sessionId?: string;
    traceId?: string;
    rootGraphId?: string;
    parentGraphId?: string;
    depth?: number;
    onEvent?: (event: RuntimeEvent) => void | Promise<void>;
    telemetryQueue?: Queue;
  } = {}
): Promise<DeclarativeGraphContext> {
  const sessionId = options.sessionId || crypto.randomUUID().slice(0, 16);
  const traceId = options.traceId || crypto.randomUUID().slice(0, 16);
  
  const toolDefs = getToolDefinitions(config.tools, config.blocked_tools);
  const blockedSet = new Set(config.blocked_tools);
  const activeTools = toolDefs.filter((t) => !blockedSet.has(t.function.name));
  
  const stateReducerOverrides = coerceReducerMap(
    config.state_reducers as Record<string, unknown> | undefined
  );
  
  const ctx: DeclarativeGraphContext = {
    env,
    hyperdrive,
    telemetryQueue: options.telemetryQueue,
    sessionId,
    traceId,
    rootGraphId: options.rootGraphId || "root",
    parentGraphId: options.parentGraphId,
    depth: options.depth || 0,
    config: config as any,
    request,
    messages: [],
    workingMemory: createWorkingMemory(100),
    loopState: createLoopState(),
    activeTools,
    blockedTools: blockedSet,
    events: [],
    results: [],
    turn: 1,
    cumulativeCost: 0,
    totalToolCalls: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    output: "",
    stopReason: "end_turn",
    lastModel: config.model,
    started: Date.now(),
    turnStartedMs: 0,
    stateReducerOverrides,
    nodeState: new Map(),
    onEvent: options.onEvent,
    validationErrors: [],
  };
  
  if (config.system_prompt) {
    ctx.messages.push({ role: "system", content: config.system_prompt });
  }
  
  try {
    const memoryContext = await buildMemoryContext(
      env,
      hyperdrive,
      request.task,
      ctx.workingMemory,
      { agent_name: config.agent_name, org_id: config.org_id }
    );
    if (memoryContext) {
      ctx.messages.push({ role: "system", content: memoryContext });
    }
  } catch {
    // Best-effort
  }
  
  ctx.messages.push({ role: "user", content: request.task });
  
  return ctx;
}

// --- Graph Preparation ---

export async function prepareDeclarativeGraph(
  ctx: DeclarativeGraphContext,
  graph: GraphSpec,
  options: {
    skipCache?: boolean;
    skipExpansion?: boolean;
    skipValidation?: boolean;
    maxDepth?: number;
  } = {}
): Promise<PreparedGraph> {
  const graphId = graph.id || "graph";
  let fromCache = false;
  
  // Step 1: Validate with cache
  let validationResult: { valid: boolean; errors: Array<{ code: string; message: string; path?: string }> } = { valid: true, errors: [] };
  
  if (!options.skipValidation) {
    const cachedValidation = options.skipCache ? undefined : getCachedValidation(graph);
    if (cachedValidation) {
      validationResult = { valid: true, errors: [] };
      fromCache = true;
    } else {
      const schemaResult = validateGraphSchemas(graph, schemaRegistry);
      validationResult = { valid: schemaResult.valid, errors: schemaResult.errors };
      if (validationResult.valid) {
        setCachedValidation(graph, { valid: true, errors: [], timestamp: Date.now() });
      }
    }
  }
  
  // Step 2: Expand subgraphs with cache
  let expanded = graph;
  if (!options.skipExpansion && ctx.depth < (options.maxDepth || 3)) {
    const cachedExpansion = options.skipCache ? undefined : await getCachedExpansion(graph);
    if (cachedExpansion) {
      expanded = cachedExpansion;
      fromCache = true;
    } else {
      expanded = await expandSubgraphs(graph, ctx.env, subgraphRegistry, ctx.depth, options.maxDepth || 3);
      await setCachedExpansion(graph, expanded);
    }
  }
  
  // Step 3: Build node map and execution order
  const nodeMap = new Map<string, GraphNodeRecord>();
  for (const node of expanded.nodes) {
    nodeMap.set(node.id, node);
  }
  
  let executionOrder: string[] = [];
  const cachedPath = options.skipCache ? undefined : getCachedLinearPath(expanded);
  if (cachedPath !== undefined && cachedPath !== null) {
    executionOrder = cachedPath;
    fromCache = true;
  } else {
    executionOrder = computeExecutionOrder(expanded);
    setCachedLinearPath(graph, executionOrder);
  }
  
  return {
    original: graph,
    expanded,
    executionOrder,
    nodeMap,
    validationResult,
    fromCache,
  };
}

// --- Node Execution ---

export async function executeDeclarativeNode(
  ctx: DeclarativeGraphContext,
  node: GraphNodeRecord,
  prepared: PreparedGraph,
  inputData: unknown
): Promise<NodeExecutionResult> {
  const nodeId = node.id;
  const nodeType = node.type || node.kind || "unknown";
  const started = Date.now();
  
  pushRuntimeEvent(ctx.events, "node_start", ctx.turn, {
    node_id: nodeId,
    node_type: nodeType,
    session_id: ctx.sessionId,
    trace_id: ctx.traceId,
    graph_id: ctx.rootGraphId,
    parent_graph_id: ctx.parentGraphId || "",
  });
  await emitEvent(ctx, ctx.events[ctx.events.length - 1]);
  
  if (node.config?.input_schema && !ctx.config.skip_schema_validation) {
    const validation = validateDataAgainstSchema(inputData, node.config.input_schema as JsonSchema, schemaRegistry);
    if (!validation.valid) {
      const error = `Input validation failed for node ${nodeId}: ${validation.errors.map((e: {message: string}) => e.message).join(", ")}`;
      ctx.validationErrors.push({ nodeId, schemaType: "input", error });
      
      if (ctx.config.strict_schema_validation) {
        return { success: false, error, costUsd: 0, latencyMs: Date.now() - started };
      }
    }
  }
  
  let result: NodeExecutionResult;
  
  try {
    switch (nodeType) {
      case "llm":
        result = await executeLLMNode(ctx, node, inputData);
        break;
      case "tool":
        result = await executeToolNode(ctx, node, inputData);
        break;
      case "condition":
        result = await executeConditionNode(ctx, node, inputData);
        break;
      case "loop":
        result = await executeLoopNode(ctx, node, inputData, prepared);
        break;
      case "subgraph":
        result = await executeSubgraphNode(ctx, node, inputData);
        break;
      case "memory":
        result = await executeMemoryNode(ctx, node, inputData);
        break;
      case "output":
        result = await executeOutputNode(ctx, node, inputData);
        break;
      case "codemode":
      case "codemode_transform":
      case "codemode_validator":
      case "codemode_middleware":
        result = await executeCodemodeNode(ctx, node, inputData);
        break;
      default:
        const handler = nodeRegistry.get(nodeType);
        if (handler) {
          try {
            const output = await handler.handler(inputData, { node, env: ctx.env } as any);
            result = { success: true, output, costUsd: 0, latencyMs: Date.now() - started };
          } catch (err) {
            result = { success: false, error: err instanceof Error ? err.message : String(err), costUsd: 0, latencyMs: Date.now() - started };
          }
        } else {
          result = { success: false, error: `Unknown node type: ${nodeType}`, costUsd: 0, latencyMs: Date.now() - started };
        }
    }
  } catch (err) {
    result = { success: false, error: err instanceof Error ? err.message : String(err), costUsd: 0, latencyMs: Date.now() - started };
  }
  
  if (result.success && node.config?.output_schema && !ctx.config.skip_schema_validation) {
    const validation = validateDataAgainstSchema(result.output, node.config.output_schema as JsonSchema, schemaRegistry);
    if (!validation.valid) {
      const error = `Output validation failed for node ${nodeId}: ${validation.errors.map((e: {message: string}) => e.message).join(", ")}`;
      ctx.validationErrors.push({ nodeId, schemaType: "output", error });
      
      if (ctx.config.strict_schema_validation) {
        result.success = false;
        result.error = error;
      }
    }
  }
  
  pushRuntimeEvent(ctx.events, "node_end", ctx.turn, {
    node_id: nodeId,
    session_id: ctx.sessionId,
    trace_id: ctx.traceId,
    graph_id: ctx.rootGraphId,
    parent_graph_id: ctx.parentGraphId || "",
    status: result.success ? "completed" : "error",
    latency_ms: Date.now() - started,
    error: result.error || "",
  });
  await emitEvent(ctx, ctx.events[ctx.events.length - 1]);
  
  return result;
}

// --- Middleware Hook Helper ---

/**
 * Run a codemode middleware hook if configured on the agent.
 * Returns the middleware action. If no hook is configured, returns "continue".
 */
async function runMiddlewareHook(
  ctx: DeclarativeGraphContext,
  hookPoint: "pre_llm" | "post_llm" | "pre_tool" | "post_tool" | "pre_output",
  hookContext: unknown,
): Promise<MiddlewareAction> {
  const middleware = ctx.config.codemode_middleware;
  if (!middleware) return { action: "continue" };

  const snippetId = middleware[hookPoint];
  if (!snippetId) return { action: "continue" };

  // Load snippet code from DB
  try {
    const { getDb } = await import("./db");
    const sql = await getDb((ctx.env as any).HYPERDRIVE);
    const rows = await sql`
      SELECT code FROM codemode_snippets WHERE id = ${snippetId} AND org_id = ${ctx.config.org_id} LIMIT 1
    `;
    if (rows.length === 0) return { action: "continue" };
    const code = String((rows[0] as Record<string, unknown>).code || "");
    if (!code) return { action: "continue" };

    return executeMiddleware(ctx.env, code, hookContext, ctx.activeTools, ctx.sessionId);
  } catch {
    return { action: "continue" };
  }
}

// --- Node Type Implementations ---

async function executeLLMNode(
  ctx: DeclarativeGraphContext,
  node: GraphNodeRecord,
  inputData: unknown
): Promise<NodeExecutionResult> {
  const started = Date.now();
  ctx.turnStartedMs = started;

  const planRouting = resolvePlanRouting(ctx.config.plan, ctx.config.routing as Record<string, unknown> | undefined);

  const route = selectModel(
    ctx.request.task,
    planRouting as PlanRouting | undefined,
    (node.config?.model as string) || ctx.config.model,
    ctx.config.provider
  );

  const messages = [...ctx.messages];
  if (inputData && typeof inputData === "string") {
    messages.push({ role: "user", content: inputData });
  }

  // Pre-LLM middleware hook
  const preLlmAction = await runMiddlewareHook(ctx, "pre_llm", {
    messages, turn: ctx.turn, model: route.model,
  });
  if (preLlmAction.action === "interrupt") {
    return { success: false, error: `Middleware interrupted: ${(preLlmAction as any).reason}`, costUsd: 0, latencyMs: Date.now() - started };
  }
  if (preLlmAction.action === "modify" && (preLlmAction as any).data) {
    // Middleware can modify messages before LLM call
    const modified = (preLlmAction as any).data;
    if (Array.isArray(modified.messages)) {
      messages.length = 0;
      messages.push(...modified.messages);
    }
  }

  try {
    const response = await callLLM(ctx.env, messages, ctx.activeTools, {
      model: route.model,
      provider: route.provider,
      max_tokens: route.max_tokens,
      metadata: {
        agent_name: ctx.config.agent_name,
        session_id: ctx.sessionId,
        org_id: ctx.config.org_id,
        turn: ctx.turn,
      },
    });
    
    ctx.lastModel = response.model;
    ctx.cumulativeCost += response.cost_usd;
    ctx.totalInputTokens += response.usage.input_tokens;
    ctx.totalOutputTokens += response.usage.output_tokens;
    
    ctx.messages.push({
      role: "assistant",
      content: response.content,
      tool_calls: response.tool_calls,
    });
    
    pushRuntimeEvent(ctx.events, "llm_response", ctx.turn, {
      session_id: ctx.sessionId,
      trace_id: ctx.traceId,
      model: response.model,
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      cost_usd: response.cost_usd,
      latency_ms: response.latency_ms,
      has_tool_calls: response.tool_calls.length > 0,
    });
    await emitEvent(ctx, ctx.events[ctx.events.length - 1]);

    // Post-LLM middleware hook
    let content = response.content;
    let toolCalls = response.tool_calls;
    const postLlmAction = await runMiddlewareHook(ctx, "post_llm", {
      content, tool_calls: toolCalls, model: response.model, turn: ctx.turn,
    });
    if (postLlmAction.action === "modify" && (postLlmAction as any).data) {
      const mod = (postLlmAction as any).data;
      if (typeof mod.content === "string") content = mod.content;
      if (Array.isArray(mod.tool_calls)) toolCalls = mod.tool_calls;
    }
    if (postLlmAction.action === "interrupt") {
      return { success: false, error: `Post-LLM middleware interrupted: ${(postLlmAction as any).reason}`, costUsd: response.cost_usd, latencyMs: Date.now() - started };
    }

    return {
      success: true,
      output: { content, tool_calls: toolCalls, model: response.model },
      costUsd: response.cost_usd,
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    return { success: false, error: `LLM call failed: ${err instanceof Error ? err.message : String(err)}`, costUsd: 0, latencyMs: Date.now() - started };
  }
}

async function executeToolNode(
  ctx: DeclarativeGraphContext,
  _node: GraphNodeRecord,
  inputData: unknown
): Promise<NodeExecutionResult> {
  const started = Date.now();
  
  let toolCalls = (inputData as any)?.tool_calls || [];
  if (toolCalls.length === 0) {
    return { success: true, output: { results: [] }, costUsd: 0, latencyMs: Date.now() - started };
  }

  // Pre-tool middleware hook
  const preToolAction = await runMiddlewareHook(ctx, "pre_tool", {
    tool_calls: toolCalls, turn: ctx.turn,
  });
  if (preToolAction.action === "interrupt") {
    return { success: false, error: `Pre-tool middleware interrupted: ${(preToolAction as any).reason}`, costUsd: 0, latencyMs: Date.now() - started };
  }
  if (preToolAction.action === "modify" && (preToolAction as any).data) {
    const mod = (preToolAction as any).data;
    if (Array.isArray(mod.tool_calls)) toolCalls = mod.tool_calls;
  }

  const results = await executeTools(ctx.env, toolCalls, ctx.sessionId, ctx.config.parallel_tool_calls ?? true);
  
  const toolCost = results.reduce((sum, r) => sum + (r.cost_usd || 0), 0);
  ctx.cumulativeCost += toolCost;
  ctx.totalToolCalls += results.length;
  
  for (let i = 0; i < toolCalls.length; i++) {
    const tc = toolCalls[i];
    const tr = results[i];
    ctx.messages.push({
      role: "tool",
      tool_call_id: tc.id,
      name: tc.name,
      content: tr.error ? `Error: ${tr.error}` : tr.result,
    });
    
    pushRuntimeEvent(ctx.events, "tool_call", ctx.turn, {
      session_id: ctx.sessionId,
      trace_id: ctx.traceId,
      tool_name: tc.name,
      tool_call_id: tc.id,
    });
    pushRuntimeEvent(ctx.events, "tool_result", ctx.turn, {
      session_id: ctx.sessionId,
      trace_id: ctx.traceId,
      tool_name: tc.name,
      tool_call_id: tc.id,
      status: tr.error ? "error" : "ok",
      latency_ms: tr.latency_ms,
    });
    await emitEvent(ctx, ctx.events[ctx.events.length - 1]);
  }
  
  // Post-tool middleware hook
  const postToolAction = await runMiddlewareHook(ctx, "post_tool", {
    tool_calls: toolCalls, results, turn: ctx.turn,
  });
  if (postToolAction.action === "modify" && (postToolAction as any).data) {
    return { success: true, output: { results: (postToolAction as any).data.results || results }, costUsd: toolCost, latencyMs: Date.now() - started };
  }

  return { success: true, output: { results }, costUsd: toolCost, latencyMs: Date.now() - started };
}

async function executeConditionNode(
  _ctx: DeclarativeGraphContext,
  node: GraphNodeRecord,
  inputData: unknown
): Promise<NodeExecutionResult> {
  const started = Date.now();
  const condition = node.config?.condition as string;
  
  let result = false;
  try {
    if (condition && typeof inputData === "object" && inputData !== null) {
      const fn = new Function("data", `with(data) { return ${condition}; }`);
      result = fn(inputData);
    }
  } catch {
    result = false;
  }
  
  return { success: true, output: { condition, result }, costUsd: 0, latencyMs: Date.now() - started };
}

async function executeLoopNode(
  ctx: DeclarativeGraphContext,
  node: GraphNodeRecord,
  inputData: unknown,
  prepared: PreparedGraph
): Promise<NodeExecutionResult> {
  const started = Date.now();
  const maxIterations = (node.config?.max_iterations as number) || 10;
  
  let iteration = 0;
  let loopOutput = inputData;
  
  while (iteration < maxIterations) {
    iteration++;
    
    const bodyNodeId = prepared.executionOrder.find(id => {
      const n = prepared.nodeMap.get(id);
      return n?.type === "loop_body" || n?.kind === "loop_body";
    });
    
    if (!bodyNodeId) break;
    
    const bodyNode = prepared.nodeMap.get(bodyNodeId);
    if (!bodyNode) break;
    
    const result = await executeDeclarativeNode(ctx, bodyNode, prepared, loopOutput);
    if (!result.success) return result;
    
    loopOutput = result.output;
  }
  
  return { success: true, output: loopOutput, costUsd: 0, latencyMs: Date.now() - started };
}

async function executeSubgraphNode(
  ctx: DeclarativeGraphContext,
  node: GraphNodeRecord,
  inputData: unknown
): Promise<NodeExecutionResult> {
  const started = Date.now();
  
  if (ctx.depth >= 3) {
    return { success: false, error: "Maximum subgraph nesting depth exceeded (3)", costUsd: 0, latencyMs: Date.now() - started };
  }
  
  const subgraphId = node.config?.subgraph_id as string;
  if (!subgraphId) {
    return { success: false, error: "Subgraph node missing subgraph_id", costUsd: 0, latencyMs: Date.now() - started };
  }
  
  const subgraphDef = await subgraphRegistry.load(subgraphId, ctx.env);
  if (!subgraphDef) {
    return { success: false, error: `Subgraph not found: ${subgraphId}`, costUsd: 0, latencyMs: Date.now() - started };
  }
  
  const parentState = (inputData as Record<string, unknown>) || {};
  const subgraphInput: Record<string, unknown> = {};
  for (const [key, mapping] of Object.entries(subgraphDef.input_mapping || {})) {
    subgraphInput[key] = parentState[mapping] ?? parentState[key];
  }
  
  const childCtx = await buildDeclarativeGraphContext(
    ctx.env,
    ctx.hyperdrive,
    { ...ctx.request, task: JSON.stringify(subgraphInput) },
    ctx.config,
    {
      sessionId: ctx.sessionId,
      traceId: ctx.traceId,
      rootGraphId: subgraphId,
      parentGraphId: ctx.rootGraphId,
      depth: ctx.depth + 1,
      onEvent: ctx.onEvent,
      telemetryQueue: ctx.telemetryQueue,
    }
  );
  
  const result = await executeDeclarativeGraph(childCtx, subgraphDef.graph);
  
  ctx.cumulativeCost += result.costUsd;
  ctx.events.push(...childCtx.events);
  
  const output: Record<string, unknown> = {};
  const resultOutput = (result.output as unknown as Record<string, unknown>) || {};
  for (const [parentKey, subgraphKey] of Object.entries(subgraphDef.output_mapping || {})) {
    output[parentKey] = resultOutput[subgraphKey];
  }
  
  return { success: result.success, output, error: result.error, costUsd: result.costUsd, latencyMs: Date.now() - started };
}

async function executeMemoryNode(
  ctx: DeclarativeGraphContext,
  node: GraphNodeRecord,
  inputData: unknown
): Promise<NodeExecutionResult> {
  const started = Date.now();
  const operation = node.config?.operation as string || "read";
  const key = node.config?.key as string;
  
  if (operation === "write" && key) {
    ctx.nodeState.set(key, inputData);
  } else if (operation === "read" && key) {
    return { success: true, output: ctx.nodeState.get(key), costUsd: 0, latencyMs: Date.now() - started };
  }
  
  return { success: true, output: inputData, costUsd: 0, latencyMs: Date.now() - started };
}

async function executeOutputNode(
  ctx: DeclarativeGraphContext,
  node: GraphNodeRecord,
  inputData: unknown
): Promise<NodeExecutionResult> {
  const started = Date.now();
  
  let output = inputData;
  const format = node.config?.format as string;
  if (format === "json" && typeof inputData === "object") {
    output = JSON.stringify(inputData);
  } else if (format === "text") {
    output = String(inputData);
  }
  
  // Pre-output middleware hook
  const preOutputAction = await runMiddlewareHook(ctx, "pre_output", {
    output, turn: ctx.turn,
  });
  if (preOutputAction.action === "modify" && (preOutputAction as any).data) {
    output = (preOutputAction as any).data.output ?? (preOutputAction as any).data;
  }

  ctx.output = String(output);

  return { success: true, output, costUsd: 0, latencyMs: Date.now() - started };
}

// --- Codemode Node Execution ---

/**
 * Execute a codemode node — runs user-defined JavaScript in a sandboxed V8 isolate.
 *
 * Supports four sub-types via node.type:
 *   - "codemode"           → general-purpose graph node (scope: graph_node)
 *   - "codemode_transform" → data transformation (scope: transform)
 *   - "codemode_validator"  → validation, returns {valid, errors} (scope: validator)
 *   - "codemode_middleware"  → middleware hook, returns MiddlewareAction (scope: middleware)
 *
 * Config fields:
 *   - code: string                  — the JavaScript to execute
 *   - snippet_id: string            — OR reference a stored snippet (loaded from DB)
 *   - scope: CodemodeScope          — override scope (default inferred from node type)
 *   - scope_config: object          — override scope defaults
 *   - globals: Record<string,any>   — extra variables injected into sandbox
 */
async function executeCodemodeNode(
  ctx: DeclarativeGraphContext,
  node: GraphNodeRecord,
  inputData: unknown
): Promise<NodeExecutionResult> {
  const started = Date.now();
  const nodeType = node.type || node.kind || "codemode";

  // Determine scope from node type or config override
  let scope: CodemodeScope = "graph_node";
  if (nodeType === "codemode_transform") scope = "transform";
  else if (nodeType === "codemode_validator") scope = "validator";
  else if (nodeType === "codemode_middleware") scope = "middleware";
  if (node.config?.scope) scope = node.config.scope as CodemodeScope;

  // Get code from config or snippet_id
  let code = node.config?.code as string | undefined;

  if (!code && node.config?.snippet_id) {
    // Load snippet from cache/DB
    try {
      const { loadSnippetCached } = await import("./codemode");
      const snippet = await loadSnippetCached(
        (ctx.env as any).HYPERDRIVE,
        String(node.config.snippet_id),
        ctx.config.org_id,
      );
      if (snippet) {
        code = snippet.code;
        if (snippet.scope) scope = snippet.scope;
      }
    } catch {
      // DB access might fail — fall through to error
    }
  }

  if (!code) {
    return {
      success: false,
      error: `Codemode node "${node.id}" has no code or valid snippet_id`,
      costUsd: 0,
      latencyMs: Date.now() - started,
    };
  }

  // For validator nodes, use the specialized executeValidator
  if (scope === "validator") {
    const validationResult = await executeValidator(
      ctx.env,
      code,
      inputData,
      ctx.activeTools,
      ctx.sessionId,
      node.config?.scope_config as any,
    );

    return {
      success: validationResult.valid,
      output: validationResult,
      error: validationResult.valid ? undefined : validationResult.errors.join("; "),
      costUsd: 0,
      latencyMs: Date.now() - started,
    };
  }

  // For middleware nodes, use the specialized executeMiddleware
  if (scope === "middleware") {
    const middlewareResult = await executeMiddleware(
      ctx.env,
      code,
      inputData,
      ctx.activeTools,
      ctx.sessionId,
      node.config?.scope_config as any,
    );

    return {
      success: true,
      output: middlewareResult,
      costUsd: 0,
      latencyMs: Date.now() - started,
    };
  }

  // General codemode / transform execution
  const result = await executeScopedCode(
    ctx.env,
    code,
    ctx.activeTools,
    ctx.sessionId,
    {
      scope,
      scopeOverrides: node.config?.scope_config as any,
      input: inputData,
      globals: node.config?.globals as Record<string, unknown> | undefined,
      traceId: ctx.traceId,
      orgId: ctx.config.org_id,
      snippetId: node.config?.snippet_id as string | undefined,
      events: ctx.events,
    },
  );

  ctx.cumulativeCost += result.costUsd;
  ctx.totalToolCalls += result.toolCallCount;

  if (!result.success) {
    return {
      success: false,
      error: result.error,
      costUsd: result.costUsd,
      latencyMs: Date.now() - started,
    };
  }

  return {
    success: true,
    output: result.result,
    costUsd: result.costUsd,
    latencyMs: Date.now() - started,
  };
}

// --- Main Execution ---

export async function executeDeclarativeGraph(
  ctx: DeclarativeGraphContext,
  graph: GraphSpec,
  options: {
    maxTurns?: number;
    budgetLimitUsd?: number;
    timeoutMs?: number;
  } = {}
): Promise<DeclarativeGraphResult> {
  const started = Date.now();
  const maxTurns = options.maxTurns || ctx.config.max_turns || 50;
  const budgetLimit = options.budgetLimitUsd || ctx.config.budget_limit_usd || 10;
  const timeoutMs = options.timeoutMs || (ctx.config.timeout_seconds ? ctx.config.timeout_seconds * 1000 : 300000); // Default 5 min
  
  try {
    const prepared = await prepareDeclarativeGraph(ctx, graph);
    
    if (!prepared.validationResult.valid) {
      return {
        success: false,
        output: "",
        events: ctx.events,
        costUsd: 0,
        latencyMs: Date.now() - started,
        turnCount: 0,
        toolCallCount: 0,
        validationErrors: prepared.validationResult.errors.map((e: {message: string}) => ({
          nodeId: "",
          schemaType: "input" as const,
          error: e.message,
        })),
        error: `Graph validation failed: ${prepared.validationResult.errors[0]?.message}`,
      };
    }
    
    let currentNodeId = prepared.executionOrder[0];
    let currentInput: unknown = ctx.request.task;
    
    while (currentNodeId && ctx.turn <= maxTurns) {
      // Check budget limit
      if (ctx.cumulativeCost >= budgetLimit) {
        ctx.stopReason = "budget";
        break;
      }
      
      // Check timeout
      if (Date.now() - started >= timeoutMs) {
        ctx.stopReason = "timeout";
        break;
      }
      
      const node = prepared.nodeMap.get(currentNodeId);
      if (!node) break;
      
      const result = await executeDeclarativeNode(ctx, node, prepared, currentInput);
      
      if (!result.success) {
        return {
          success: false,
          output: "",
          events: ctx.events,
          costUsd: ctx.cumulativeCost,
          latencyMs: Date.now() - started,
          turnCount: ctx.turn,
          toolCallCount: ctx.totalToolCalls,
          validationErrors: ctx.validationErrors,
          error: result.error,
        };
      }
      
      currentInput = result.output;
      currentNodeId = result.nextNodeId || findNextNode(currentNodeId, prepared) || "";
      
      if (node.type === "tool" || node.kind === "tool") {
        const loopResult = detectLoop(ctx.loopState, (currentInput as any)?.tool_calls || []);
        if (loopResult?.halt) {
          ctx.stopReason = "loop_detected";
          break;
        }
      }
      
      ctx.turn++;
    }
    
    await writeSession(ctx.hyperdrive, {
      session_id: ctx.sessionId,
      org_id: ctx.config.org_id,
      project_id: ctx.config.project_id,
      agent_name: ctx.config.agent_name,
      status: ctx.stopReason === "end_turn" ? "completed" : "stopped",
      input_text: ctx.request.task,
      output_text: ctx.output,
      model: ctx.lastModel,
      trace_id: ctx.traceId,
      step_count: ctx.turn,
      action_count: ctx.totalToolCalls,
      wall_clock_seconds: (Date.now() - started) / 1000,
      cost_total_usd: ctx.cumulativeCost,
    });
    
    return {
      success: true,
      output: ctx.output,
      events: ctx.events,
      costUsd: ctx.cumulativeCost,
      latencyMs: Date.now() - started,
      turnCount: ctx.turn,
      toolCallCount: ctx.totalToolCalls,
      validationErrors: ctx.validationErrors,
    };
    
  } catch (err) {
    return {
      success: false,
      output: "",
      events: ctx.events,
      costUsd: ctx.cumulativeCost,
      latencyMs: Date.now() - started,
      turnCount: ctx.turn,
      toolCallCount: ctx.totalToolCalls,
      validationErrors: ctx.validationErrors,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// --- Helpers ---

function coerceReducerMap(raw?: Record<string, unknown>): Record<string, StateMergeStrategy> {
  const allowed = new Set<StateMergeStrategy>(["replace", "sum_numeric", "max_numeric", "append_list", "merge_dict"]);
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

function computeExecutionOrder(graph: GraphSpec): string[] {
  const adj = new Map<string, string[]>();
  const inDegree = new Map<string, number>();
  
  for (const node of graph.nodes) {
    adj.set(node.id, []);
    inDegree.set(node.id, 0);
  }
  
  for (const edge of graph.edges) {
    const source = (edge as any).source || (edge as any).from;
    const target = (edge as any).target || (edge as any).to;
    if (source && target) {
      adj.get(source)?.push(target);
      inDegree.set(target, (inDegree.get(target) || 0) + 1);
    }
  }
  
  const queue: string[] = [];
  for (const [nodeId, degree] of inDegree) {
    if (degree === 0) queue.push(nodeId);
  }
  
  const result: string[] = [];
  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    result.push(nodeId);
    
    for (const neighbor of adj.get(nodeId) || []) {
      const newDegree = (inDegree.get(neighbor) || 0) - 1;
      inDegree.set(neighbor, newDegree);
      if (newDegree === 0) {
        queue.push(neighbor);
      }
    }
  }
  
  return result;
}

function findNextNode(currentNodeId: string, prepared: PreparedGraph): string | undefined {
  const idx = prepared.executionOrder.indexOf(currentNodeId);
  if (idx >= 0 && idx < prepared.executionOrder.length - 1) {
    return prepared.executionOrder[idx + 1];
  }
  return undefined;
}

async function emitEvent(ctx: DeclarativeGraphContext, event: RuntimeEvent): Promise<void> {
  if (ctx.onEvent) {
    await ctx.onEvent(event);
  }
}
