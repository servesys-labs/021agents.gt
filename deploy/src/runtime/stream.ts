/**
 * Edge Runtime — Streaming Engine.
 *
 * Real-time token streaming over WebSocket:
 *   1. Client opens WebSocket to DO
 *   2. Client sends { type: "run", input: "..." }
 *   3. DO streams back:
 *      - { type: "token", content: "..." }         — LLM token chunks
 *      - { type: "tool_call", name, args }          — tool call started
 *      - { type: "tool_result", name, result }      — tool call completed
 *      - { type: "turn_end", turn, model, cost }    — turn finished
 *      - { type: "done", output, turns, cost }      — run complete
 *      - { type: "error", message }                 — error
 *
 * LLM tokens flow directly from provider SSE → WebSocket.
 * Tool execution pauses the stream, sends results, then resumes.
 * DB writes and telemetry are fire-and-forget (non-blocking).
 */

import type { LLMMessage, LLMResponse, ToolCall, ToolDefinition, RuntimeEnv, ToolResult } from "./types";
import type { RuntimeEvent, TurnEndEvent, DoneEvent } from "./protocol";
import { executeTools, getToolDefinitions } from "./tools";
import { loadAgentConfig, resolvePlanRouting, writeSession, writeTurn, writeBillingRecord } from "./db";
import { createWorkingMemory, buildMemoryContext, queueFactExtraction } from "./memory";
import { selectModel, type PlanRouting } from "./router";
import { createLoopState, detectLoop, maybeSummarize } from "./middleware";
import { serializeForWebSocket } from "./protocol";
import { createBackpressureController } from "./backpressure";
import { estimateTokenCost } from "./pricing";
import { attachDelegationLineage, type DelegationContextInput } from "./delegation";
import { attachToolPolicyEnvelope } from "./policy-envelope";
import { selectReasoningStrategy, autoSelectStrategy } from "./reasoning-strategies";
import { loadSkills, formatSkillsPrompt } from "./skills";
import { loadStartupContext } from "./progress";

type WsSend = (data: string) => void;

// Model pricing imported from shared module (pricing.ts)

/**
 * Helper for progress reporting on long-running tools.
 * Sends periodic "tool_progress" events over the WebSocket while awaiting a tool result.
 */
function withProgress(
  toolName: string,
  promise: Promise<string>,
  send?: WsSend,
  intervalMs = 5000,
): Promise<string> {
  if (!send) return promise;

  let elapsed = 0;
  const timer = setInterval(() => {
    elapsed += intervalMs;
    send(JSON.stringify({
      type: "tool_progress",
      tool: toolName,
      status: "running",
      elapsed_ms: elapsed,
      message: `Still running... (${Math.round(elapsed / 1000)}s elapsed)`,
    }));
  }, intervalMs);

  return promise.finally(() => clearInterval(timer));
}

/**
 * Streaming LLM call — sends tokens to WebSocket as they arrive.
 * Returns the assembled LLMResponse when complete.
 */
async function streamLLM(
  env: RuntimeEnv,
  messages: LLMMessage[],
  tools: ToolDefinition[],
  opts: { model: string; provider?: string; max_tokens?: number; temperature?: number },
  send: WsSend,
): Promise<LLMResponse> {
  const model = opts.model;
  const isWorkersAI = model.startsWith("@cf/");
  const started = Date.now();

  // All models go through AI Gateway /compat/ — single endpoint, single token
  const accountId = env.CLOUDFLARE_ACCOUNT_ID || "";
  const gatewayId = env.AI_GATEWAY_ID || "";

  if (!accountId || !gatewayId) {
    throw new Error("AI Gateway not configured");
  }

  // Normalize model ID for /compat/ endpoint
  const gatewayModel = model.startsWith("@cf/") ? `workers-ai/${model}` : model;

  const payload: Record<string, any> = {
    model: gatewayModel,
    messages: messages.map(formatMessage),
    ...(opts.temperature !== undefined && opts.temperature > 0 ? { temperature: opts.temperature } : {}),
    stream: true,
  };

  // Only set max_tokens if explicitly provided — let models decide output length by default
  if (opts.max_tokens) {
    if (model.includes("openai/") || model.includes("gpt-") ) {
      payload.max_completion_tokens = opts.max_tokens;
    } else {
      payload.max_tokens = opts.max_tokens;
    }
  }

  if (tools.length > 0) {
    payload.tools = tools;
  }

  // Workers AI models use /compat/ (direct CF), everything else uses /openrouter/ (via OpenRouter)
  const providerPath = isWorkersAI ? "compat" : "openrouter";
  const endpoint = `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/${providerPath}/chat/completions`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  // CF gateway auth — gateway routes to OpenRouter (paid models) or Workers AI (@cf/)
  // OpenRouter API key is configured on the AI Gateway, not passed from code
  const cfToken = env.CLOUDFLARE_API_TOKEN || env.AI_GATEWAY_TOKEN;
  if (cfToken) {
    headers["cf-aig-authorization"] = `Bearer ${cfToken}`;
  }

  const resp = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const errBody = await resp.text();
    throw new Error(`LLM ${resp.status}: ${errBody.slice(0, 300)}`);
  }

  // Capture gateway log ID for post-hoc exact token lookup
  const gatewayLogId = resp.headers.get("cf-aig-log-id") || "";

  // Parse SSE stream and forward tokens
  let content = "";
  let toolCalls: ToolCall[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let resolvedModel = model;

  // Accumulate partial tool calls by index
  const partialToolCalls: Map<number, { id: string; name: string; arguments: string }> = new Map();

  const reader = resp.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let buffer = "";
  let streamDone = false;

  // Read with per-chunk timeout to prevent hanging on stalled streams
  const CHUNK_TIMEOUT_MS = 60_000; // 60s max wait per chunk

  while (!streamDone) {
    let readResult: ReadableStreamReadResult<Uint8Array>;
    try {
      readResult = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Stream chunk timeout")), CHUNK_TIMEOUT_MS),
        ),
      ]);
    } catch {
      // Timeout or read error — finalize with what we have
      break;
    }

    const { done, value } = readResult;
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (data === "[DONE]") {
        streamDone = true;
        break;
      }

      let chunk: any;
      try { chunk = JSON.parse(data); } catch { continue; }

      const delta = chunk.choices?.[0]?.delta || {};
      resolvedModel = chunk.model || resolvedModel;

      // Detect finish_reason to handle stream close
      const finishReason = chunk.choices?.[0]?.finish_reason;
      if (finishReason === "stop" || finishReason === "tool_calls" || finishReason === "length") {
        streamDone = true;
      }

      // Token content
      if (delta.content) {
        content += delta.content;
        send(JSON.stringify({ type: "token", content: delta.content }));
      }

      // Tool call chunks (streamed incrementally)
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          const existing = partialToolCalls.get(idx) || { id: "", name: "", arguments: "" };
          if (tc.id) existing.id = tc.id;
          if (tc.function?.name) existing.name = tc.function.name;
          if (tc.function?.arguments) existing.arguments += tc.function.arguments;
          partialToolCalls.set(idx, existing);
        }
      }

      // Usage (usually in the final chunk)
      if (chunk.usage) {
        inputTokens = chunk.usage.prompt_tokens || chunk.usage.input_tokens || 0;
        outputTokens = chunk.usage.completion_tokens || chunk.usage.output_tokens || 0;
      }
    }
  }

  // If streaming didn't include usage, query AI Gateway Logs API for exact tokens + cost
  if ((inputTokens === 0 || outputTokens === 0) && gatewayLogId && accountId && gatewayId) {
    try {
      const logResp = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai-gateway/gateways/${gatewayId}/logs?id=${gatewayLogId}`,
        { headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN || env.AI_GATEWAY_TOKEN || ""}` } },
      );
      if (logResp.ok) {
        const logData = await logResp.json() as { result?: Array<{ tokens_in?: number; tokens_out?: number; cost?: number }> };
        const entry = logData.result?.[0];
        if (entry) {
          if (entry.tokens_in && entry.tokens_in > 0) inputTokens = entry.tokens_in;
          if (entry.tokens_out && entry.tokens_out > 0) outputTokens = entry.tokens_out;
        }
      }
    } catch {}
  }

  // Clean up reader
  try { reader.cancel(); } catch {}

  // Finalize tool calls
  toolCalls = Array.from(partialToolCalls.values())
    .filter((tc) => tc.name)
    .map((tc) => ({
      id: tc.id || crypto.randomUUID().slice(0, 12),
      name: tc.name,
      arguments: tc.arguments || "{}",
    }));

  const latencyMs = Date.now() - started;
  return {
    content,
    model: resolvedModel,
    tool_calls: toolCalls,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    cost_usd: estimateTokenCost(resolvedModel, inputTokens, outputTokens),
    latency_ms: latencyMs,
  };
}

/**
 * Streaming agent run over WebSocket.
 * This is the main entry point called from the DO's onMessage handler.
 */
export async function streamRun(
  env: RuntimeEnv,
  hyperdrive: Hyperdrive,
  input: string,
  agentName: string,
  send: WsSend,
  opts?: {
    org_id?: string;
    project_id?: string;
    channel?: string;
    channel_user_id?: string;
    api_key_id?: string;
    history_messages?: Array<{ role: "user" | "assistant"; content: string }>;
    delegation?: DelegationContextInput;
  },
): Promise<void> {
  const started = Date.now();
  const sessionId = crypto.randomUUID().slice(0, 16);
  const traceId = crypto.randomUUID().slice(0, 16);

  try {
    // Load config
    const config = await loadAgentConfig(hyperdrive, agentName, {
      provider: env.DEFAULT_PROVIDER,
      model: env.DEFAULT_MODEL,
      plan: "standard",
    });
    if (opts?.org_id) config.org_id = opts.org_id;
    if (opts?.project_id) config.project_id = opts.project_id;
    attachToolPolicyEnvelope(env, config);
    const lineage = attachDelegationLineage(env, config, { session_id: sessionId, trace_id: traceId }, {
      agent_name: agentName,
      org_id: opts?.org_id,
      project_id: opts?.project_id,
      delegation: opts?.delegation,
    });

    // ── 1. TOOLS ──────────────────────────────────────────────
    const toolDefs = getToolDefinitions(config.tools, config.blocked_tools);
    const blockedSet = new Set(config.blocked_tools);
    const activeTools = toolDefs.filter((t) => !blockedSet.has(t.function.name));

    // ── 2. WORKSPACE HYDRATION (restore files from R2) ──────
    if (env.STORAGE && env.SANDBOX) {
      try {
        const { hydrateWorkspace } = await import("./workspace");
        const sandbox = (await import("@cloudflare/sandbox")).getSandbox(env.SANDBOX, `session-${sessionId}`);
        const { restored } = await hydrateWorkspace(
          env.STORAGE, sandbox, config.org_id || "default", config.agent_name || agentName,
        );
        if (restored > 0) {
          send(JSON.stringify({ type: "system", message: `Restored ${restored} files from previous session.` }));
        }
      } catch {}
    }

    // ── 3. STATE INITIALIZATION ─────────────────────────────
    const workingMemory = createWorkingMemory(100);
    const loopState = createLoopState();
    const isVoiceChannel = opts?.channel === "voice";

    // Voice: override model for speed + reliable tool calling
    if (isVoiceChannel) {
      config.model = "openai/gpt-5.4-mini";
      config.provider = "openrouter";
    }

    // ── 4. SYSTEM PROMPT ASSEMBLY ───────────────────────────
    // Build a cohesive system prompt from: base prompt + skills + startup context + voice rules
    const messages: LLMMessage[] = [];
    const sysPromptParts: string[] = [];

    // 4a. Base system prompt
    if (config.system_prompt) {
      sysPromptParts.push(config.system_prompt);
    }

    // 4b. Skills (loaded from DB, cached 1min) — agent-specific capabilities
    if (!isVoiceChannel) {
      try {
        const skills = await loadSkills(hyperdrive, config.org_id || "", config.agent_name || agentName);
        const skillsBlock = formatSkillsPrompt(skills);
        if (skillsBlock) sysPromptParts.push(skillsBlock);
      } catch {}
    }

    // 4c. Startup context (prior session progress) — cross-session awareness
    if (!isVoiceChannel) {
      try {
        const startup = await loadStartupContext(hyperdrive, config.agent_name || agentName, config.org_id || "");
        if (startup.context_block) sysPromptParts.push(startup.context_block);
      } catch {}
    }

    // 4d. Voice mode rules
    if (isVoiceChannel) {
      sysPromptParts.push(`[VOICE MODE — The user is on a phone call. You MUST follow these rules:
1. Keep every response to 1-2 sentences MAX. Be extremely concise.
2. Speak naturally — use contractions, casual tone. Say "I'll" not "I will".
3. NEVER use markdown, asterisks, hashes, bullet points, code blocks, or any formatting.
4. NEVER read out URLs, file paths, or technical syntax.
5. If you need to share details, summarize them verbally — don't list them.
6. Ask one question at a time. Don't give multiple options in one turn.
7. Use filler phrases naturally: "Sure thing", "Got it", "Let me check that for you".
8. If a tool call takes time, say "One moment" before running it.]`);
    }

    if (sysPromptParts.length > 0) {
      messages.push({ role: "system", content: sysPromptParts.join("\n\n") });
    }

    // ── 5. MEMORY CONTEXT (working + episodic + semantic + procedural) ──
    try {
      const memCtx = await buildMemoryContext(env, hyperdrive, input, workingMemory, {
        agent_name: config.agent_name, org_id: config.org_id,
      });
      if (memCtx) messages.push({ role: "system", content: memCtx });
    } catch {}

    // ── 6. CONVERSATION HISTORY (from DO, shared across channels) ──
    const history = Array.isArray(opts?.history_messages) ? opts?.history_messages : [];
    for (const msg of history) {
      const role = msg?.role;
      const content = String(msg?.content || "").trim();
      if (!content || (role !== "user" && role !== "assistant")) continue;
      messages.push({ role, content });
    }

    // ── 7. REASONING STRATEGY (injected before user message) ──
    // Auto-selects reasoning approach based on task complexity, or uses agent config.
    if (!isVoiceChannel) {
      const strategyPrompt =
        selectReasoningStrategy(config.reasoning_strategy as string | undefined, input, 1) ||
        autoSelectStrategy(input, activeTools.length);
      if (strategyPrompt) {
        messages.push({ role: "system", content: strategyPrompt });
        send(serializeForWebSocket({
          type: "reasoning",
          strategy: config.reasoning_strategy || "auto",
          prompt: strategyPrompt.slice(0, 200),
        } as any));
      }
    }

    // ── 8. USER MESSAGE ─────────────────────────────────────
    let task = input;
    const channel = (opts?.channel || "").toLowerCase();
    if (["telegram", "discord", "whatsapp", "sms"].includes(channel)) {
      task = `[Channel: ${channel} — Keep response under 500 chars, bold key facts.]\n\n${input}`;
    }
    messages.push({ role: "user", content: task });

    send(serializeForWebSocket({
      type: "session_start",
      session_id: sessionId,
      trace_id: traceId,
      agent_name: config.agent_name,
      delegation: lineage.parent_session_id
        ? {
            parent_session_id: lineage.parent_session_id,
            parent_trace_id: lineage.parent_trace_id,
            parent_agent_name: lineage.parent_agent_name,
            depth: lineage.depth,
          }
        : undefined,
    }));

    // Plan routing
    const planRouting = resolvePlanRouting(config.plan, config.routing as Record<string, any> | undefined);

    // Turn loop
    let cumulativeCost = 0;
    let totalToolCalls = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let output = "";
    let lastModel = config.model;

    for (let turn = 1; turn <= config.max_turns; turn++) {
      const lineage = (env as any).__delegationLineage;
      if (lineage && typeof lineage === "object") {
        lineage.turn = turn;
        lineage.cumulative_cost_usd = cumulativeCost;
      }

      // ── CONTEXT COMPRESSION — summarize when messages exceed token budget ──
      if (turn > 2 && !isVoiceChannel) {
        try {
          const compressed = await maybeSummarize(env, messages, {
            maxChars: 80_000,
            keepRecentCount: 8,
            model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
            provider: "workers-ai",
          });
          if (compressed.summarized) {
            messages.splice(0, messages.length, ...compressed.messages);
            cumulativeCost += compressed.cost_usd;
            send(serializeForWebSocket({
              type: "system",
              message: "Context compressed to fit token budget.",
            } as any));
          }
        } catch {}
      }

      // Budget check
      if (cumulativeCost >= config.budget_limit_usd) {
        send(serializeForWebSocket({ type: "error", message: "Budget exhausted", code: "BUDGET_EXHAUSTED" }));
        break;
      }

      // Route model
      const route = await selectModel(task, planRouting as PlanRouting | undefined, config.model, config.provider, env);

      send(serializeForWebSocket({ type: "turn_start", turn, model: route.model }));

      // Stream LLM response
      let llmResponse: LLMResponse;
      try {
        llmResponse = await streamLLM(env, messages, activeTools, {
          model: route.model,
          provider: route.provider,
          max_tokens: route.max_tokens,
        }, send);
      } catch (err: any) {
        send(serializeForWebSocket({ type: "error", message: `LLM failed: ${err.message}`, code: "LLM_ERROR" }));
        break;
      }

      lastModel = llmResponse.model;
      cumulativeCost += llmResponse.cost_usd;
      totalInputTokens += llmResponse.usage.input_tokens;
      totalOutputTokens += llmResponse.usage.output_tokens;

      // Always capture the latest non-empty content as output
      if (llmResponse.content && llmResponse.content.trim()) {
        output = llmResponse.content;
      }

      // ── EXTENDED THINKING TRACE ──────────────────────────
      // When the model produces content alongside tool calls, that content is
      // the model's reasoning ("I'll search for...", "Let me check...").
      // Emit it as a visible thinking trace so users see WHY the agent acts.
      if (llmResponse.tool_calls.length > 0 && llmResponse.content && llmResponse.content.trim()) {
        send(serializeForWebSocket({
          type: "thinking",
          content: llmResponse.content.trim(),
          turn,
        } as any));
      }

      // No tool calls → final answer
      if (llmResponse.tool_calls.length === 0) {
        output = llmResponse.content;
        const turnTokens = llmResponse.usage.input_tokens + llmResponse.usage.output_tokens;
        const turnEndEvent: TurnEndEvent = {
          type: "turn_end", turn, model: llmResponse.model,
          cost_usd: llmResponse.cost_usd, tokens: turnTokens, done: true,
        };
        send(serializeForWebSocket(turnEndEvent));

        // DB write (fire-and-forget)
        writeTurn(hyperdrive, {
          session_id: sessionId, turn_number: turn, model_used: llmResponse.model,
          input_tokens: llmResponse.usage.input_tokens, output_tokens: llmResponse.usage.output_tokens,
          latency_ms: llmResponse.latency_ms, llm_content: llmResponse.content,
          cost_total_usd: llmResponse.cost_usd, tool_calls_json: "[]",
          tool_results_json: "[]", errors_json: "[]", execution_mode: "sequential",
        }).catch(() => {});
        break;
      }

      // Tool execution
      messages.push({ role: "assistant", content: llmResponse.content, tool_calls: llmResponse.tool_calls });

      for (const tc of llmResponse.tool_calls) {
        send(serializeForWebSocket({ type: "tool_call", name: tc.name, tool_call_id: tc.id }));
      }

      // P0 Fix: Report progress for ALL long-running tools, not just the first
      const LONG_RUNNING_TOOLS = new Set(["python-exec", "bash", "web-crawl", "browser-render"]);
      const longRunningNames = llmResponse.tool_calls
        .filter((tc) => LONG_RUNNING_TOOLS.has(tc.name))
        .map((tc) => tc.name);

      // Send initial "Executing..." for each long-running tool
      for (const name of longRunningNames) {
        send(JSON.stringify({
          type: "tool_progress",
          tool: name,
          status: "running",
          elapsed_ms: 0,
          message: "Executing...",
        }));
      }

      // Progress timer reports ALL active long-running tools
      const toolResultsPromise = executeTools(
        env,
        llmResponse.tool_calls,
        sessionId,
        config.parallel_tool_calls,
        config.tools,
      );
      let toolProgressTimer: ReturnType<typeof setInterval> | null = null;
      if (longRunningNames.length > 0) {
        let elapsed = 0;
        toolProgressTimer = setInterval(() => {
          elapsed += 5000;
          for (const name of longRunningNames) {
            try {
              send(JSON.stringify({
                type: "tool_progress",
                tool: name,
                status: "running",
                elapsed_ms: elapsed,
                message: `Still running... (${Math.round(elapsed / 1000)}s elapsed)`,
              }));
            } catch { /* WebSocket may be closed */ }
          }
        }, 5000);
      }

      let toolResults: ToolResult[];
      try {
        toolResults = await toolResultsPromise;
      } finally {
        if (toolProgressTimer) clearInterval(toolProgressTimer);
      }
      totalToolCalls += toolResults.length;
      // Accumulate tool execution costs (search, crawl, etc.)
      cumulativeCost += toolResults.reduce((sum: number, tr: ToolResult) => sum + (tr.cost_usd || 0), 0);

      for (let i = 0; i < llmResponse.tool_calls.length; i++) {
        const tc = llmResponse.tool_calls[i];
        const tr = toolResults[i] || { result: "No result", tool: tc.name, tool_call_id: tc.id, latency_ms: 0 };
        messages.push({
          role: "tool", tool_call_id: tc.id, name: tc.name,
          content: tr.error ? `Error: ${tr.error}` : tr.result,
        });
        send(serializeForWebSocket({
          type: "tool_result", name: tc.name, tool_call_id: tc.id,
          result: (tr.error || tr.result || "").slice(0, 500),
          error: tr.error || undefined,
          latency_ms: tr.latency_ms,
        }));
      }

      const turnTokens = llmResponse.usage.input_tokens + llmResponse.usage.output_tokens;
      const turnEndEvent: TurnEndEvent = {
        type: "turn_end", turn, model: llmResponse.model,
        cost_usd: llmResponse.cost_usd, tokens: turnTokens, tool_calls: toolResults.length, done: false,
      };
      send(serializeForWebSocket(turnEndEvent));

      // DB write (fire-and-forget)
      writeTurn(hyperdrive, {
        session_id: sessionId, turn_number: turn, model_used: llmResponse.model,
        input_tokens: llmResponse.usage.input_tokens, output_tokens: llmResponse.usage.output_tokens,
        latency_ms: llmResponse.latency_ms, llm_content: llmResponse.content,
        cost_total_usd: llmResponse.cost_usd,
        tool_calls_json: JSON.stringify(llmResponse.tool_calls),
        tool_results_json: JSON.stringify(toolResults),
        errors_json: JSON.stringify(toolResults.filter((tr: ToolResult) => tr.error)),
        execution_mode: config.parallel_tool_calls && llmResponse.tool_calls.length > 1 ? "parallel" : "sequential",
      }).catch(() => {});

      // Loop detection
      const loopResult = detectLoop(loopState, llmResponse.tool_calls.map((tc) => ({
        name: tc.name, arguments: tc.arguments,
      })));
      if (loopResult?.halt) {
        send(serializeForWebSocket({ type: "error", message: loopResult.halt, code: "LOOP_DETECTED" }));
        break;
      }
      if (loopResult?.warn) {
        messages.push({ role: "system", content: loopResult.warn });
        send(serializeForWebSocket({ type: "warning", message: loopResult.warn }));
      }

      // Fact extraction (first turn only, non-blocking)
      if (turn === 1) {
        queueFactExtraction(env, hyperdrive, input, sessionId, config.agent_name, config.org_id);
      }
    }

    // Recovery: if tools ran but no final text output, make one last LLM call
    // without tools to force the model to synthesize a response.
    if (!output && totalToolCalls > 0 && messages.length > 1) {
      try {
        send(serializeForWebSocket({ type: "turn_start", turn: 0, model: lastModel }));
        const recoveryResponse = await streamLLM(env, messages, [], {
          model: lastModel,
          provider: config.provider,
          max_tokens: 4096,
        }, send);
        output = recoveryResponse.content || "";
        cumulativeCost += recoveryResponse.cost_usd;
        totalInputTokens += recoveryResponse.usage.input_tokens;
        totalOutputTokens += recoveryResponse.usage.output_tokens;
        send(serializeForWebSocket({
          type: "turn_end", turn: 0, model: recoveryResponse.model,
          cost_usd: recoveryResponse.cost_usd,
          tokens: recoveryResponse.usage.input_tokens + recoveryResponse.usage.output_tokens,
          done: true,
        }));
      } catch {}
    }

    const elapsedMs = Date.now() - started;

    // Session write (fire-and-forget)
    writeSession(hyperdrive, {
      session_id: sessionId, org_id: config.org_id, project_id: config.project_id,
      agent_name: config.agent_name, status: output ? "success" : "error",
      input_text: input, output_text: output, model: lastModel, trace_id: traceId,
      step_count: totalToolCalls > 0 ? totalToolCalls : 1, action_count: totalToolCalls,
      wall_clock_seconds: elapsedMs / 1000, cost_total_usd: cumulativeCost,
      parent_session_id: lineage.parent_session_id,
      depth: lineage.depth,
    }).catch(() => {});

    // Billing write (fire-and-forget)
    writeBillingRecord(hyperdrive, {
      session_id: sessionId, org_id: config.org_id, agent_name: config.agent_name,
      model: lastModel, input_tokens: totalInputTokens, output_tokens: totalOutputTokens,
      cost_usd: cumulativeCost, plan: config.plan,
      trace_id: traceId,
      billing_user_id: opts?.channel_user_id,
      api_key_id: opts?.api_key_id,
    }).catch(() => {});

    const doneEvent: DoneEvent = {
      type: "done",
      session_id: sessionId,
      trace_id: traceId,
      output,
      turns: totalToolCalls > 0 ? Math.ceil(totalToolCalls) : 1,
      tool_calls: totalToolCalls,
      cost_usd: Math.round(cumulativeCost * 1_000_000) / 1_000_000,
      latency_ms: elapsedMs,
    };
    send(serializeForWebSocket(doneEvent));

  } catch (err: any) {
    send(serializeForWebSocket({ type: "error", message: err.message || String(err), code: "INTERNAL_ERROR" }));
  }
}

// ── Helpers ───────────────────────────────────────────────────

function formatMessage(m: LLMMessage): Record<string, any> {
  const msg: Record<string, any> = { role: m.role, content: m.content };
  if (m.tool_calls?.length) {
    msg.tool_calls = m.tool_calls.map((tc) => ({
      id: tc.id, type: "function",
      function: { name: tc.name, arguments: tc.arguments },
    }));
  }
  if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
  if (m.name) msg.name = m.name;
  return msg;
}

function parseToolCalls(raw: any[]): ToolCall[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((tc) => tc && (tc.function?.name || tc.name))
    .map((tc) => ({
      id: tc.id || crypto.randomUUID().slice(0, 12),
      name: tc.function?.name || tc.name,
      arguments: tc.function?.arguments || tc.arguments || "{}",
    }));
}

// LLM cost estimation removed — trust AI Gateway analytics for billing.
