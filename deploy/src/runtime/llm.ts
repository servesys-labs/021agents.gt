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
import { estimateTokenCost } from "./pricing";

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
      org_id?: string;
      turn?: number;
      channel?: string;
    };
  },
): Promise<LLMResponse> {
  const started = Date.now();
  const accountId = env.CLOUDFLARE_ACCOUNT_ID || "";
  const gatewayId = env.AI_GATEWAY_ID || "";

  if (!accountId || !gatewayId) {
    throw new Error("AI Gateway not configured — set CLOUDFLARE_ACCOUNT_ID and AI_GATEWAY_ID");
  }

  // Normalize model name for the gateway /compat/ endpoint
  const model = normalizeModelId(opts.model);

  // Build OpenAI-compatible payload
  const payload: Record<string, any> = {
    model,
    messages: messages.map(formatMessage),
  };

  // Only set temperature if explicitly provided (some models like gpt-5-mini reject temperature=0)
  if (opts.temperature !== undefined && opts.temperature > 0) {
    payload.temperature = opts.temperature;
  }

  // OpenAI models use max_completion_tokens (not max_tokens)
  // Google AI Studio and Workers AI use max_tokens
  if (model.includes("openai/") || model.includes("gpt-") || model.includes("/o3") || model.includes("/o4")) {
    payload.max_completion_tokens = opts.max_tokens || 2048;
  } else {
    payload.max_tokens = opts.max_tokens || 2048;
  }

  if (tools.length > 0) {
    payload.tools = tools.map(fixToolSchema);
  }

  // Single endpoint for everything
  const endpoint = `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/compat/chat/completions`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  // Attach metadata for per-agent/session cost tracking in gateway logs
  if (opts.metadata) {
    headers["cf-aig-metadata"] = JSON.stringify(opts.metadata);
  }

  if (env.AI_GATEWAY_TOKEN) {
    headers["cf-aig-authorization"] = `Bearer ${env.AI_GATEWAY_TOKEN}`;
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

  const costUsd = providerCost > 0 ? providerCost : estimateTokenCost(data.model || model, inputTokens, outputTokens);

  return {
    content: msg.content || "",
    model: data.model || model,
    tool_calls: parseToolCalls(msg.tool_calls || []),
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    cost_usd: costUsd,
    latency_ms: latencyMs,
    gateway_log_id: gatewayLogId,
    gateway_event_id: gatewayEventId,
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
  // Workers AI models need workers-ai/ prefix for /compat/ endpoint
  if (model.startsWith("@cf/")) {
    return `workers-ai/${model}`;
  }
  // Everything else is already in the right format for /compat/
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
