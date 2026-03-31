/**
 * Edge Runtime — LLM caller.
 *
 * ALL models go through CF AI Gateway /compat/ endpoint.
 * One endpoint, one token (CF_AIG_TOKEN), all providers:
 *
 *   model: "workers-ai/@cf/moonshotai/kimi-k2.5"  → Workers AI (edge)
 *   model: "anthropic/claude-sonnet-4-5"           → Anthropic (gateway credits)
 *   model: "openai/gpt-5.4"                       → OpenAI (gateway credits)
 *   model: "deepseek/deepseek-v3.2"               → DeepSeek (gateway credits)
 *   model: "google-ai-studio/gemini-3.1-pro"      → Google (gateway credits)
 *   model: "dynamic/my-route"                      → Gateway dynamic routing
 *
 * No BYOK keys needed. Gateway handles billing from loaded credits.
 * Gateway provides: logging, caching, rate limiting, fallbacks, cost tracking.
 */

import type { LLMMessage, LLMResponse, ToolCall, ToolDefinition, RuntimeEnv } from "./types";
// Pricing imported dynamically in callLLM to avoid circular deps

/**
 * Call an LLM through CF AI Gateway /compat/ endpoint.
 * Model name determines provider routing at the gateway level.
 */
export async function callLLM(
  env: RuntimeEnv,
  messages: LLMMessage[],
  tools: ToolDefinition[],
  opts: {
    model: string;
    provider?: string;
    max_tokens?: number;
    temperature?: number;
    // Metadata for AI Gateway logging — enables per-agent/session cost tracking
    metadata?: {
      agent_name?: string;
      session_id?: string;
      trace_id?: string;
      org_id?: string;
      turn?: number;
      channel?: string;
    };
  },
): Promise<LLMResponse> {
  const started = Date.now();
  const isWorkersAI = opts.model.startsWith("@cf/") || opts.model.startsWith("@hf/");

  // ── Workers AI: use env.AI binding directly (zero latency, no external hop) ──
  if (isWorkersAI && env.AI) {
    const aiMessages = messages.map(formatMessage);
    const aiOpts: Record<string, any> = {};
    if (opts.max_tokens) aiOpts.max_tokens = opts.max_tokens;
    if (opts.temperature !== undefined && opts.temperature > 0) aiOpts.temperature = opts.temperature;
    if (tools.length > 0) aiOpts.tools = tools.map(fixToolSchema);

    const result = await env.AI.run(opts.model as any, {
      messages: aiMessages,
      ...aiOpts,
    }) as any;

    const latencyMs = Date.now() - started;
    const content = typeof result === "string" ? result
      : result?.response || result?.content || result?.choices?.[0]?.message?.content || "";
    const rawToolCalls = result?.tool_calls || result?.choices?.[0]?.message?.tool_calls || [];
    const inputTokens = result?.usage?.prompt_tokens || 0;
    const outputTokens = result?.usage?.completion_tokens || 0;

    const { calculateCustomerCost } = await import("./pricing");

    return {
      content,
      model: opts.model,
      tool_calls: parseToolCalls(rawToolCalls),
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      cost_usd: calculateCustomerCost(opts.model, inputTokens, outputTokens, 0),
      latency_ms: latencyMs,
      gateway_log_id: "",
      gateway_event_id: "",
    };
  }

  // ── All other models: OpenRouter via AI Gateway ──
  const accountId = env.CLOUDFLARE_ACCOUNT_ID || "";
  const gatewayId = env.AI_GATEWAY_ID || "";

  if (!accountId || !gatewayId) {
    throw new Error("AI Gateway not configured — set CLOUDFLARE_ACCOUNT_ID and AI_GATEWAY_ID");
  }

  const model = normalizeModelId(opts.model);

  const payload: Record<string, any> = {
    model,
    messages: messages.map(formatMessage),
  };

  if (opts.temperature !== undefined && opts.temperature > 0) {
    payload.temperature = opts.temperature;
  }

  if (opts.max_tokens) {
    if (model.includes("openai/") || model.includes("gpt-")) {
      payload.max_completion_tokens = opts.max_tokens;
    } else {
      payload.max_tokens = opts.max_tokens;
    }
  }

  if (tools.length > 0) {
    payload.tools = tools.map(fixToolSchema);
  }

  const endpoint = `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/openrouter/chat/completions`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (opts.metadata) {
    headers["cf-aig-metadata"] = JSON.stringify(opts.metadata);
    // Phase 5.1: Propagate trace_id for distributed tracing
    if (opts.metadata.trace_id) {
      headers["X-Trace-Id"] = opts.metadata.trace_id;
    }
  }

  // OpenRouter auth
  const orKey = (env as any).OPENROUTER_API_KEY;
  if (orKey) {
    headers["cf-aig-authorization"] = `Bearer ${orKey}`;
  } else {
    const cfToken = env.AI_GATEWAY_TOKEN || env.CLOUDFLARE_API_TOKEN;
    if (cfToken) headers["cf-aig-authorization"] = `Bearer ${cfToken}`;
  }

  // ── Phase 1.3: Retry logic with backoff ──
  // Retries on transient errors (429, 529, 502, 503, network errors).
  // Does NOT retry on 400, 401, 403, 404 (permanent failures).
  const MAX_LLM_RETRIES = 3;
  const BACKOFF_MS = [500, 2000, 8000];
  const RETRYABLE_STATUS = new Set([429, 502, 503, 529]);
  const NON_RETRYABLE_STATUS = new Set([400, 401, 403, 404]);

  let resp: Response | undefined;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < MAX_LLM_RETRIES; attempt++) {
    try {
      resp = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });

      if (resp.ok) break; // Success

      const status = resp.status;

      if (NON_RETRYABLE_STATUS.has(status)) {
        // Permanent error — don't retry
        const errBody = await resp.text();
        throw new Error(`LLM ${status}: ${errBody.slice(0, 300)}`);
      }

      if (RETRYABLE_STATUS.has(status) && attempt < MAX_LLM_RETRIES - 1) {
        // Transient error — respect Retry-After header or use backoff
        const retryAfter = resp.headers.get("Retry-After");
        const retryAfterSec = retryAfter ? Number(retryAfter) : NaN;
        const delayMs = !isNaN(retryAfterSec) && retryAfterSec > 0
          ? Math.min(retryAfterSec * 1000, 30_000) // Cap at 30s
          : BACKOFF_MS[attempt] || 8000;
        console.warn(`[llm] ${status} on attempt ${attempt + 1}, retrying in ${delayMs}ms`);
        await new Promise(r => setTimeout(r, delayMs));
        continue;
      }

      // Non-retryable status or final attempt
      const errBody = await resp.text();
      throw new Error(`LLM ${status}: ${errBody.slice(0, 300)}`);
    } catch (e: any) {
      lastError = e;
      // Network errors (ECONNRESET, EPIPE, fetch failures) are retryable
      if (e.message?.includes("LLM ") || NON_RETRYABLE_STATUS.has(e.status)) {
        throw e; // Re-throw non-retryable errors
      }
      if (attempt < MAX_LLM_RETRIES - 1) {
        console.warn(`[llm] Network error on attempt ${attempt + 1}: ${e.message?.slice(0, 100)}`);
        await new Promise(r => setTimeout(r, BACKOFF_MS[attempt] || 8000));
        continue;
      }
      throw e; // Final attempt failed
    }
  }

  if (!resp || !resp.ok) {
    throw lastError || new Error("LLM request failed after retries");
  }

  // Capture gateway correlation IDs from response headers
  const gatewayLogId = resp.headers.get("cf-aig-log-id") || "";
  const gatewayEventId = resp.headers.get("cf-aig-event-id") || "";

  const data = (await resp.json()) as any;
  const choice = (data.choices || [{}])[0];
  const msg = choice.message || {};
  const latencyMs = Date.now() - started;

  let inputTokens = data.usage?.prompt_tokens || data.usage?.input_tokens || 0;
  let outputTokens = data.usage?.completion_tokens || data.usage?.output_tokens || 0;
  let providerCost = Number(data.usage?.total_cost) || 0;

  // If provider didn't return tokens, query AI Gateway Logs API for exact data
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
          if (entry.cost && entry.cost > 0) providerCost = entry.cost;
        }
      }
    } catch {}
  }

  const { calculateCustomerCost } = await import("./pricing");
  const costUsd = calculateCustomerCost(data.model || model, inputTokens, outputTokens, providerCost);

  // Phase 9.3: Detect model refusal (stop_reason=refusal or content_filter)
  const stopReason = choice.finish_reason || data.stop_reason || "";
  const isRefusal = stopReason === "refusal" || stopReason === "content_filter";

  const content = isRefusal
    ? "I'm unable to help with that request due to usage policies. Try rephrasing your request or adjusting the task."
    : (msg.content || msg.reasoning || (choice as any).text || "");

  return {
    content,
    model: data.model || model,
    tool_calls: isRefusal ? [] : parseToolCalls(msg.tool_calls || []),
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    cost_usd: costUsd,
    latency_ms: latencyMs,
    gateway_log_id: gatewayLogId,
    gateway_event_id: gatewayEventId,
    refusal: isRefusal,
  };
}

// ── Model ID Normalization ────────────────────────────────────
//
// Our plan routing tables use shorthand IDs. The /compat/ endpoint
// needs provider-prefixed IDs. This function normalizes:
//
//   @cf/moonshotai/kimi-k2.5       → workers-ai/@cf/moonshotai/kimi-k2.5
//   anthropic/claude-sonnet-4.6     → anthropic/claude-sonnet-4.6 (already correct)
//   openai/gpt-5.4                  → openai/gpt-5.4 (already correct)
//   deepseek/deepseek-v3.2          → deepseek/deepseek-v3.2 (already correct)
//   dynamic/my-route                → dynamic/my-route (gateway dynamic routing)

function normalizeModelId(model: string): string {
  // Workers AI models: keep @cf/ prefix as-is (gateway URL path handles routing)
  // The /workers-ai/v1/chat/completions endpoint expects bare @cf/ model IDs
  if (model.startsWith("@cf/")) {
    return model;
  }
  // All other models: anthropic/, openai/, google/, deepseek/ — pass through
  // OpenRouter accepts these prefixes natively
  return model;
}

// ── Helpers ───────────────────────────────────────────────────

function formatMessage(m: LLMMessage): Record<string, any> {
  const msg: Record<string, any> = { role: m.role, content: m.content };
  if (m.tool_calls && m.tool_calls.length > 0) {
    msg.tool_calls = m.tool_calls.map((tc) => ({
      id: tc.id,
      type: "function",
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

/** Fix array schemas missing `items` for strict validation models. */
function fixToolSchema(tool: ToolDefinition): ToolDefinition {
  const params = tool.function?.parameters || {};
  const fixed = JSON.parse(JSON.stringify(params));
  const fixArrays = (obj: any) => {
    if (!obj || typeof obj !== "object") return;
    for (const [, v] of Object.entries(obj)) {
      if (v && typeof v === "object") {
        const val = v as Record<string, any>;
        if (val.type === "array" && !val.items) val.items = { type: "string" };
        fixArrays(val);
      }
    }
  };
  fixArrays(fixed);
  return {
    type: "function",
    function: {
      name: tool.function.name,
      description: tool.function.description,
      parameters: fixed,
    },
  };
}

// LLM cost estimation removed — trust AI Gateway analytics for billing.
// The gateway tracks exact per-model pricing. Our runtime only stores
// token counts (input_tokens, output_tokens) and model name.
// Billing is computed from CF AI Gateway dashboard, not runtime estimates.
