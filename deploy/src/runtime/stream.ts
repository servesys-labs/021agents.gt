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
import { createWorkingMemory, buildMemoryContext, queueFactExtraction, queueSessionEpisodicNote } from "./memory";
import { selectModel, type PlanRouting } from "./router";
import { createLoopState, detectLoop, maybeSummarize } from "./middleware";
import { serializeForWebSocket } from "./protocol";
import { createBackpressureController } from "./backpressure";
import { estimateTokenCost, estimateTokensFromText } from "./pricing";
import { attachDelegationLineage, type DelegationContextInput } from "./delegation";
import { attachToolPolicyEnvelope } from "./policy-envelope";
import { selectReasoningStrategy, autoSelectStrategy } from "./reasoning-strategies";
import { loadSkills, formatSkillsPrompt } from "./skills";
import { loadStartupContext } from "./progress";
import { EventSequencer, BoundedUUIDSet } from "./ws-dedup";

type WsSend = (data: string) => void;

// Model pricing imported from shared module (pricing.ts)

/**
 * Helper for progress reporting on long-running tools.
 * Sends periodic "tool_progress" events AND heartbeats over the WebSocket
 * while awaiting a tool result.
 *
 * Phase 3.4: Heartbeat events every 15s prevent client-side timeouts
 * during long-running tools (>30s with no output).
 *
 * Exported for use by DO WebSocket handlers and workflow progress emission.
 *
 * Event shape conforms to ToolProgressEvent in protocol.ts:
 *   { type: "tool_progress", name, tool_call_id, progress: {...} }
 *
 * Previously this helper sent a flat shape (tool/status/elapsed_ms/message)
 * that the frontend silently dropped because it didn't match the union
 * type. The fix moves the runtime fields into a `progress` sub-object so
 * any consumer typed against ToolProgressEvent can read them.
 */
export function withProgress(
  toolName: string,
  toolCallId: string,
  promise: Promise<string>,
  send?: WsSend,
  intervalMs = 5000,
): Promise<string> {
  if (!send) return promise;

  let elapsed = 0;
  const HEARTBEAT_INTERVAL = 15_000;
  let lastHeartbeat = Date.now();

  const timer = setInterval(() => {
    elapsed += intervalMs;
    // Tool progress event — matches ToolProgressEvent in protocol.ts
    send(JSON.stringify({
      type: "tool_progress",
      name: toolName,
      tool_call_id: toolCallId,
      progress: {
        status: "running",
        elapsed_ms: elapsed,
        message: `Still running... (${Math.round(elapsed / 1000)}s elapsed)`,
      },
    }));
    // Phase 3.4: Heartbeat every 15s
    if (Date.now() - lastHeartbeat >= HEARTBEAT_INTERVAL) {
      send(JSON.stringify({ type: "heartbeat", timestamp: Date.now() }));
      lastHeartbeat = Date.now();
    }
  }, intervalMs);

  return promise.finally(() => clearInterval(timer));
}

// ── Phase 3.2: Backpressure state for WebSocket streaming ──
const HIGH_WATERMARK = 1000;  // messages — pause reading from LLM
const LOW_WATERMARK = 200;    // messages — resume reading
const SEND_TIMEOUT_MS = 30_000;

export interface StreamBackpressure {
  pendingCount: number;
  paused: boolean;
  dropped: number;
}

export function createStreamBackpressure(): StreamBackpressure {
  return { pendingCount: 0, paused: false, dropped: 0 };
}

/**
 * Backpressure-aware send. Tracks pending messages and drops if
 * client is too slow (prevents OOM from unbounded buffer growth).
 * Exported for use by DO WebSocket handlers.
 */
export function backpressureSend(
  rawSend: WsSend,
  bp: StreamBackpressure,
  data: string,
): void {
  if (bp.pendingCount > HIGH_WATERMARK) {
    bp.dropped++;
    bp.paused = true;
    return; // Drop message — client can't keep up
  }
  bp.pendingCount++;
  try {
    rawSend(data);
  } finally {
    bp.pendingCount--;
    if (bp.paused && bp.pendingCount < LOW_WATERMARK) {
      bp.paused = false;
    }
  }
}

/**
 * Streaming LLM call — sends tokens to WebSocket as they arrive.
 * Returns the assembled LLMResponse when complete.
 */
async function streamLLM(
  env: RuntimeEnv,
  messages: LLMMessage[],
  tools: ToolDefinition[],
  opts: { model: string; provider?: string; max_tokens?: number; temperature?: number; signal?: AbortSignal },
  send: WsSend,
): Promise<LLMResponse> {
  const model = opts.model;
  const isWorkersAI = model.startsWith("@cf/");
  const started = Date.now();
  const bp = createStreamBackpressure();

  // All models go through AI Gateway — Workers AI via /workers-ai/v1/, others via /openrouter/
  const accountId = env.CLOUDFLARE_ACCOUNT_ID || "";
  const gatewayId = env.AI_GATEWAY_ID || "";

  if (!accountId || !gatewayId) {
    throw new Error("AI Gateway not configured");
  }

  const payload: Record<string, any> = {
    model, // bare @cf/ for Workers AI, provider-prefixed for others
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

  // Workers AI: /workers-ai/v1/ (CF account token), others: /openrouter/ (OpenRouter key)
  const providerPath = isWorkersAI ? "workers-ai/v1" : "openrouter";
  const endpoint = `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/${providerPath}/chat/completions`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    // AI Gateway caching: identical streaming requests within TTL served from cache.
    // Note: streaming responses may not be cacheable on all providers.
    "cf-aig-cache-ttl": "300",
  };
  // Auth: CF account token or AI Gateway token
  const cfToken = env.CLOUDFLARE_API_TOKEN || env.AI_GATEWAY_TOKEN;
  if (cfToken) {
    headers["cf-aig-authorization"] = `Bearer ${cfToken}`;
  }

  const resp = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: opts.signal,
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
        // High-volume path: apply best-effort backpressure to avoid client OOM.
        backpressureSend(send, bp, JSON.stringify({ type: "token", content: delta.content }));
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

  // Fallback token estimation when API doesn't report usage.
  // Uses word-based estimation (more accurate than chars/4 across languages):
  // English: ~1.3 tokens/word. Code/JSON: ~2 tokens/word. CJK: ~1 token/char.
  if (inputTokens === 0 && messages.length > 0) {
    const totalInputText = messages.map(m => m.content || "").join(" ");
    inputTokens = estimateTokensFromText(totalInputText);
  }
  if (outputTokens === 0 && content.length > 0) {
    outputTokens = estimateTokensFromText(content);
  }

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
    /** Called between turns — allows the DO to yield the run lock so queued requests can proceed. */
    yieldBetweenTurns?: () => Promise<void>;
    /** Abort signal tied to WebSocket disconnect/cancellation (provided by DO). */
    signal?: AbortSignal;
  },
): Promise<void> {
  const started = Date.now();
  const sessionId = crypto.randomUUID().slice(0, 16);
  const traceId = crypto.randomUUID().slice(0, 16);

  // Cloud C3.2: WebSocket dedup — assign seq-nums to events for reconnect
  const sequencer = new EventSequencer(500);
  const seenUUIDs = new BoundedUUIDSet(1000);
  const bp = createStreamBackpressure();
  const rawSend = send;
  send = ((data: string) => {
    // Assign seq-num for reconnect support
    try {
      const parsed = JSON.parse(data);
      const seqEvent = sequencer.push(parsed.type || "unknown", parsed);
      parsed._seq = seqEvent.seq;
      data = JSON.stringify(parsed);
    } catch { /* non-JSON data, pass through */ }
    backpressureSend(rawSend, bp, data);
  }) as WsSend;

  try {
    // Load config
    const config = await loadAgentConfig(hyperdrive, agentName, {
      provider: env.DEFAULT_PROVIDER,
      model: env.DEFAULT_MODEL,
      plan: "standard",
    }, opts?.org_id || undefined);
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
        const { getSandbox: _getSandbox } = await import("@cloudflare/sandbox");
        const sandboxId = `session-${sessionId}`;
        const rawSandbox = _getSandbox(env.SANDBOX, sandboxId);
        // Wrap with 30s timeout so workspace hydration doesn't hang if capacity is exhausted.
        // Also normalizes exec timeout from seconds → ms (the rest of the
        // codebase passes seconds, but @cloudflare/sandbox 0.7+ takes ms).
        const sandbox = new Proxy(rawSandbox, {
          get: (target, prop) => {
            const val = (target as any)[prop];
            if (typeof val !== "function") return val;
            return (...args: any[]) => {
              if (prop === "exec" && args.length >= 2 && args[1] && typeof args[1] === "object") {
                const opts = args[1] as { timeout?: number };
                if (typeof opts.timeout === "number" && opts.timeout <= 600) {
                  args = [args[0], { ...opts, timeout: opts.timeout * 1000 }];
                }
              }
              const result = val.apply(target, args);
              if (result && typeof result.then === "function") {
                return Promise.race([
                  result,
                  new Promise((_, reject) =>
                    setTimeout(() => reject(new Error(
                      `Sandbox unavailable — no container could be allocated within 30 seconds. ` +
                      `Please try again in a moment. (sandbox: ${sandboxId})`
                    )), 30_000)
                  ),
                ]);
              }
              return result;
            };
          },
        });
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

    // 4b. Skills (loaded from DB, cached 1min) + marketplace delegation guidance
    if (!isVoiceChannel) {
      try {
        const skills = await loadSkills(hyperdrive, config.org_id || "", config.agent_name || agentName);
        const skillsBlock = formatSkillsPrompt(skills, config.plan);
        if (skillsBlock) sysPromptParts.push(skillsBlock);
      } catch {}

      // Marketplace delegation — always available to all agents
      sysPromptParts.push(
        `## Marketplace Delegation\n` +
        `You can delegate specialized tasks to skill agents in the OneShots marketplace.\n` +
        `1. Use \`marketplace-search\` to find specialist agents (e.g., "flight search", "legal review")\n` +
        `2. Review pricing, ratings, and capabilities in the results\n` +
        `3. Use \`a2a-send\` to delegate the task — payments are handled automatically via x-402\n` +
        `4. If the skill agent returns artifacts (files, code), they'll be included in the response\n` +
        `5. Use \`share-artifact\` to send files/code back to a caller if you are being delegated to\n` +
        `For paid tasks > $0.10, confirm with the user before delegating.`
      );
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

    // ── 7b. COORDINATOR MODE (auto-detect complex multi-part tasks) ──
    if (!isVoiceChannel) {
      try {
        const { shouldCoordinate, buildCoordinatorPrompt } = await import("./coordinator");
        if ((config as any).reasoning_strategy === "coordinator" || shouldCoordinate(input, activeTools.length)) {
          // Fetch available agents for delegation
          let agentNames: string[] = [];
          try {
            const { loadAgentList } = await import("./db");
            const agents = await loadAgentList((env as any).HYPERDRIVE, (opts as any)?.org_id || "");
            agentNames = agents.map((a: any) => a.name);
          } catch {}
          const coordinatorPrompt = buildCoordinatorPrompt(config.agent_name, agentNames);
          if (coordinatorPrompt) {
            messages.push({ role: "system", content: coordinatorPrompt });
          }
        }
      } catch {
        // Coordinator module not available — skip
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
    let lastTurnUsed = 0;
    const sessionToolNames: string[] = [];

    // Checkpointing handled by Workflow steps — no manual DO SQLite checkpoints needed.

    for (let turn = 1; turn <= config.max_turns; turn++) {
      lastTurnUsed = turn;
      const lineage = (env as any).__delegationLineage;
      if (lineage && typeof lineage === "object") {
        lineage.turn = turn;
        lineage.cumulative_cost_usd = cumulativeCost;
      }


      // Yield between turns: cooperative yield to the event loop.
      // If the run was aborted (lock timeout, new request cancelled us), stop cleanly.
      if (turn > 1 && opts?.yieldBetweenTurns) {
        try {
          await opts.yieldBetweenTurns();
        } catch {
          // Abort signal fired — stop the run cleanly
          send(serializeForWebSocket({ type: "error", message: "Run cancelled", code: "ABORTED" } as any));
          break;
        }
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
      cumulativeCost += route.routing_cost_usd || 0;

      send(serializeForWebSocket({ type: "turn_start", turn, model: route.model }));

      // Stream LLM response (with per-turn timeout to prevent hanging)
      let llmResponse: LLMResponse;
      try {
        const PER_TURN_TIMEOUT_MS = 120_000; // 2 min max per turn
        llmResponse = await Promise.race([
          streamLLM(env, messages, activeTools, {
            model: route.model,
            provider: route.provider,
            max_tokens: route.max_tokens,
            signal: opts?.signal,
          }, send),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`Turn ${turn} timed out after ${PER_TURN_TIMEOUT_MS / 1000}s`)), PER_TURN_TIMEOUT_MS),
          ),
        ]);
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
          cost_total_usd: llmResponse.cost_usd, tool_calls: "[]",
          tool_results: "[]", errors: "[]", execution_mode: "sequential",
        }).catch(() => {});
        break;
      }

      // Tool execution
      messages.push({ role: "assistant", content: llmResponse.content, tool_calls: llmResponse.tool_calls });

      for (const tc of llmResponse.tool_calls) {
        let argsPreview = "";
        try {
          const parsed = JSON.parse(tc.arguments || "{}");
          argsPreview = parsed.query || parsed.code?.slice(0, 120) || parsed.url || parsed.path || parsed.input?.slice(0, 120) || "";
        } catch {}
        send(serializeForWebSocket({ type: "tool_call", name: tc.name, tool_call_id: tc.id, args_preview: argsPreview }));
      }

      // P0 Fix: Report progress for ALL long-running tools, not just the first
      const LONG_RUNNING_TOOLS = new Set(["python-exec", "bash", "web-crawl", "browser-render"]);
      const longRunningToolCalls = llmResponse.tool_calls.filter((tc) => LONG_RUNNING_TOOLS.has(tc.name));

      // Send initial "Executing..." for each long-running tool
      for (const tc of longRunningToolCalls) {
        send(serializeForWebSocket({
          type: "tool_progress",
          name: tc.name,
          tool_call_id: tc.id,
          progress: { status: "running", elapsed_ms: 0, message: "Executing..." },
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
      let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
      if (longRunningToolCalls.length > 0) {
        let elapsed = 0;
        toolProgressTimer = setInterval(() => {
          elapsed += 5000;
          for (const tc of longRunningToolCalls) {
            try {
              send(serializeForWebSocket({
                type: "tool_progress",
                name: tc.name,
                tool_call_id: tc.id,
                progress: {
                  status: "running",
                  elapsed_ms: elapsed,
                  message: `Still running... (${Math.round(elapsed / 1000)}s elapsed)`,
                },
              }));
            } catch { /* WebSocket may be closed */ }
          }
        }, 5000);

        // Heartbeat during long-running tool execution (client keepalive)
        heartbeatTimer = setInterval(() => {
          try {
            send(serializeForWebSocket({ type: "heartbeat" }));
          } catch { /* WebSocket may be closed */ }
        }, 15000);
      }

      let toolResults: ToolResult[];
      try {
        toolResults = await toolResultsPromise;
      } finally {
        if (toolProgressTimer) clearInterval(toolProgressTimer);
        if (heartbeatTimer) clearInterval(heartbeatTimer);
      }
      totalToolCalls += toolResults.length;
      // Accumulate tool execution costs (search, crawl, etc.)
      cumulativeCost += toolResults.reduce((sum: number, tr: ToolResult) => sum + (tr.cost_usd || 0), 0);

      for (const tc of llmResponse.tool_calls) {
        sessionToolNames.push(tc.name);
      }

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
          cost_usd: tr.cost_usd || 0,
        }));

        // Emit file_change for write-file/edit-file so UI shows code diffs
        if (!tr.error && (tc.name === "write-file" || tc.name === "edit-file")) {
          try {
            const tcArgs = JSON.parse(tc.arguments || "{}");
            const filePath = tcArgs.path || "";
            const ext = filePath.split(".").pop()?.toLowerCase() || "";
            const lang = ({ ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", py: "python", json: "json", html: "html", css: "css", md: "markdown" } as Record<string, string>)[ext] || ext;
            if (tc.name === "write-file") {
              send(serializeForWebSocket({
                type: "file_change", change_type: "create", path: filePath, language: lang,
                content: (tcArgs.content || "").slice(0, 10000), size: (tcArgs.content || "").length,
                tool_call_id: tc.id,
              } as any));
            } else {
              send(serializeForWebSocket({
                type: "file_change", change_type: "edit", path: filePath, language: lang,
                old_text: (tcArgs.old_text || tcArgs.old_string || "").slice(0, 5000),
                new_text: (tcArgs.new_text || tcArgs.new_string || "").slice(0, 5000),
                tool_call_id: tc.id,
              } as any));
            }
          } catch {}
        }
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
        tool_calls: JSON.stringify(llmResponse.tool_calls),
        tool_results: JSON.stringify(toolResults),
        errors: JSON.stringify(toolResults.filter((tr: ToolResult) => tr.error)),
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

    queueSessionEpisodicNote(hyperdrive, {
      sessionId,
      agentName: config.agent_name,
      orgId: config.org_id || "",
      userInput: input,
      assistantOutput: output,
      toolNames: sessionToolNames,
      turnsUsed: lastTurnUsed,
      toolCallCount: totalToolCalls,
    });

    // Billing write (fire-and-forget, with KV dead-letter on failure)
    writeBillingRecord(hyperdrive, {
      session_id: sessionId, org_id: config.org_id, agent_name: config.agent_name,
      model: lastModel, input_tokens: totalInputTokens, output_tokens: totalOutputTokens,
      cost_usd: cumulativeCost, plan: config.plan,
      trace_id: traceId,
      billing_user_id: opts?.channel_user_id,
      api_key_id: opts?.api_key_id,
    }, env.AGENT_PROGRESS_KV).catch(() => {});

    const doneEvent: DoneEvent = {
      type: "done",
      session_id: sessionId,
      trace_id: traceId,
      output,
      turns: totalToolCalls > 0 ? Math.ceil(totalToolCalls) : 1,
      tool_calls: totalToolCalls,
      cost_usd: Math.round(cumulativeCost * 1_000_000) / 1_000_000,
      input_tokens: totalInputTokens,
      output_tokens: totalOutputTokens,
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
