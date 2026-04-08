/**
 * Shared LLM call helper for control-plane.
 *
 * Routing:
 * - anthropic/* / claude-* → CF AI Gateway native Anthropic provider (Messages API)
 * - gemma-4* → AI Gateway custom provider (OpenAI format)
 * - @cf/* → AI Gateway Workers AI (OpenAI format)
 *
 * All routes go through CF AI Gateway (credits loaded there).
 * This is the SINGLE entry point for all LLM calls in the control-plane.
 */

export interface GatewayConfig {
  cloudflareAccountId?: string;
  aiGatewayId?: string;
  cloudflareApiToken?: string;
  aiGatewayToken?: string;
  /** @deprecated Not used — all routing goes through AI Gateway. Kept for caller compat. */
  openrouterApiKey?: string;
}

export interface LLMCallOptions {
  model?: string;
  messages: Array<{ role: string; content: string; tool_calls?: any[]; tool_call_id?: string; name?: string }>;
  tools?: any[];
  tool_choice?: string | object;
  max_tokens?: number;
  temperature?: number;
  metadata?: Record<string, string>;
  /** Timeout in milliseconds. Default: 120_000 (2 minutes). */
  timeout_ms?: number;
}

export interface LLMCallResult {
  content: string | null;
  tool_calls: any[];
  model: string;
  usage: { prompt_tokens: number; completion_tokens: number };
}

/**
 * Call an LLM through CF AI Gateway.
 */
export async function callLLMGateway(
  config: GatewayConfig,
  options: LLMCallOptions,
): Promise<LLMCallResult> {
  const model = options.model || "anthropic/claude-sonnet-4-6";
  const { cloudflareAccountId, aiGatewayId, cloudflareApiToken, aiGatewayToken } = config;

  if (!cloudflareAccountId || !aiGatewayId) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID and AI_GATEWAY_ID required.");
  }

  const isCustomModel = model.startsWith("gemma-4") || model.includes("gemma4");
  const isWorkersAI = model.startsWith("@cf/");
  const isAnthropic = model.startsWith("anthropic/") || model.startsWith("claude-");
  const isOpenAI = model.startsWith("openai/") || model.startsWith("gpt-");

  // Anthropic models → native Anthropic Messages API through AI Gateway
  if (isAnthropic) {
    return callAnthropicViaGateway(config, options, model);
  }

  // OpenAI models → AI Gateway OpenAI provider
  if (isOpenAI) {
    return callOpenAIViaGateway(config, options, model);
  }

  // Custom Gemma / Workers AI → OpenAI-compatible format
  const cfToken = aiGatewayToken || cloudflareApiToken || "";
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cfToken) headers["cf-aig-authorization"] = `Bearer ${cfToken}`;
  if (options.metadata) headers["cf-aig-metadata"] = JSON.stringify(options.metadata);

  let endpoint: string;
  if (isCustomModel) {
    const providerPath = model.includes("26b") || model.includes("moe") || model.includes("fast")
      ? "custom-gemma4-fast"
      : "custom-gemma4-local";
    endpoint = `https://gateway.ai.cloudflare.com/v1/${cloudflareAccountId}/${aiGatewayId}/${providerPath}/v1/chat/completions`;
  } else if (isWorkersAI) {
    endpoint = `https://gateway.ai.cloudflare.com/v1/${cloudflareAccountId}/${aiGatewayId}/workers-ai/v1/chat/completions`;
  } else {
    // Unknown provider — try compat endpoint
    endpoint = `https://gateway.ai.cloudflare.com/v1/${cloudflareAccountId}/${aiGatewayId}/compat/chat/completions`;
  }

  const body: Record<string, any> = {
    model,
    messages: options.messages,
  };
  if (options.tools?.length) body.tools = options.tools;
  if (options.tool_choice) body.tool_choice = options.tool_choice;
  if (options.max_tokens) body.max_tokens = options.max_tokens;
  if (options.temperature !== undefined) body.temperature = options.temperature;

  return fetchWithTimeout(endpoint, headers, body, model, options.timeout_ms);
}

// ── Anthropic Messages API via AI Gateway ──────────────────────

async function callAnthropicViaGateway(
  config: GatewayConfig,
  options: LLMCallOptions,
  model: string,
): Promise<LLMCallResult> {
  const { cloudflareAccountId, aiGatewayId, aiGatewayToken, cloudflareApiToken } = config;
  const cfToken = aiGatewayToken || cloudflareApiToken || "";

  const anthropicModel = model.replace(/^anthropic\//, "");
  const endpoint = `https://gateway.ai.cloudflare.com/v1/${cloudflareAccountId}/${aiGatewayId}/anthropic/v1/messages`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": cfToken,
    "anthropic-version": "2023-06-01",
  };
  if (options.metadata) headers["cf-aig-metadata"] = JSON.stringify(options.metadata);

  const { system, messages } = convertToAnthropicMessages(options.messages);

  const body: Record<string, any> = {
    model: anthropicModel,
    messages,
    max_tokens: options.max_tokens || 8192,
  };
  if (system) body.system = system;
  if (options.temperature !== undefined) body.temperature = options.temperature;

  if (options.tools?.length) {
    body.tools = options.tools.map((t: any) => ({
      name: t.function?.name || t.name,
      description: t.function?.description || t.description || "",
      input_schema: t.function?.parameters || t.parameters || { type: "object", properties: {} },
    }));
  }
  if (options.tool_choice) {
    if (options.tool_choice === "auto") {
      body.tool_choice = { type: "auto" };
    } else if (options.tool_choice === "none") {
      body.tool_choice = { type: "none" };
    } else if (typeof options.tool_choice === "object" && (options.tool_choice as any).function?.name) {
      body.tool_choice = { type: "tool", name: (options.tool_choice as any).function.name };
    } else {
      body.tool_choice = { type: "auto" };
    }
  }

  const timeoutMs = options.timeout_ms || 120_000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  let resp: Response;
  try {
    resp = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err: any) {
    clearTimeout(timeoutId);
    if (err?.name === "AbortError") {
      throw new Error(`Anthropic call timed out after ${timeoutMs / 1000}s. Model: ${anthropicModel}`);
    }
    throw err;
  }
  clearTimeout(timeoutId);

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "Unknown error");
    throw new Error(`Anthropic API error (${resp.status}): ${errText.slice(0, 500)}`);
  }

  const data = (await resp.json()) as any;
  return convertAnthropicResponse(data, model);
}

// ── OpenAI via AI Gateway ──────────────────────────────────────

async function callOpenAIViaGateway(
  config: GatewayConfig,
  options: LLMCallOptions,
  model: string,
): Promise<LLMCallResult> {
  const { cloudflareAccountId, aiGatewayId, aiGatewayToken, cloudflareApiToken } = config;
  const cfToken = aiGatewayToken || cloudflareApiToken || "";

  const openaiModel = model.replace(/^openai\//, "");
  const endpoint = `https://gateway.ai.cloudflare.com/v1/${cloudflareAccountId}/${aiGatewayId}/openai/chat/completions`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "cf-aig-authorization": `Bearer ${cfToken}`,
  };
  if (options.metadata) headers["cf-aig-metadata"] = JSON.stringify(options.metadata);

  const body: Record<string, any> = {
    model: openaiModel,
    messages: options.messages,
  };
  if (options.tools?.length) body.tools = options.tools;
  if (options.tool_choice) body.tool_choice = options.tool_choice;
  if (options.max_tokens) body.max_tokens = options.max_tokens;
  if (options.temperature !== undefined) body.temperature = options.temperature;

  return fetchWithTimeout(endpoint, headers, body, model, options.timeout_ms);
}

// ── Format Conversion Helpers ──────────────────────────────────

function convertToAnthropicMessages(
  openaiMessages: Array<{ role: string; content: string; tool_calls?: any[]; tool_call_id?: string }>,
): { system: string; messages: any[] } {
  let system = "";
  const messages: any[] = [];

  for (const msg of openaiMessages) {
    if (msg.role === "system") {
      system += (system ? "\n\n" : "") + msg.content;
    } else if (msg.role === "user") {
      messages.push({ role: "user", content: msg.content });
    } else if (msg.role === "assistant") {
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        const content: any[] = [];
        if (msg.content) content.push({ type: "text", text: msg.content });
        for (const tc of msg.tool_calls) {
          let input: any = {};
          try { input = JSON.parse(tc.function?.arguments || "{}"); } catch {}
          content.push({
            type: "tool_use",
            id: tc.id,
            name: tc.function?.name || "",
            input,
          });
        }
        messages.push({ role: "assistant", content });
      } else {
        messages.push({ role: "assistant", content: msg.content });
      }
    } else if (msg.role === "tool") {
      messages.push({
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: msg.tool_call_id || "",
          content: msg.content,
        }],
      });
    }
  }

  return { system, messages };
}

function convertAnthropicResponse(data: any, model: string): LLMCallResult {
  const contentBlocks: any[] = data.content || [];

  const textParts = contentBlocks
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text);
  const content = textParts.join("") || null;

  const toolUseBlocks = contentBlocks.filter((b: any) => b.type === "tool_use");
  const toolCalls = toolUseBlocks.map((b: any) => ({
    id: b.id,
    type: "function",
    function: {
      name: b.name,
      arguments: JSON.stringify(b.input || {}),
    },
  }));

  return {
    content,
    tool_calls: toolCalls,
    model: data.model || model,
    usage: {
      prompt_tokens: data.usage?.input_tokens || 0,
      completion_tokens: data.usage?.output_tokens || 0,
    },
  };
}

// ── Shared Helpers ────────────────────────────────────────────

async function fetchWithTimeout(
  endpoint: string,
  headers: Record<string, string>,
  body: Record<string, any>,
  model: string,
  timeoutMs?: number,
): Promise<LLMCallResult> {
  const timeout = timeoutMs || 120_000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  let resp: Response;
  try {
    resp = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err: any) {
    clearTimeout(timeoutId);
    if (err?.name === "AbortError") {
      throw new Error(`LLM call timed out after ${timeout / 1000}s. Model: ${model}`);
    }
    throw err;
  }
  clearTimeout(timeoutId);

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "Unknown error");
    throw new Error(`LLM API error (${resp.status}): ${errText.slice(0, 500)}`);
  }

  const data = (await resp.json()) as any;
  const choice = data.choices?.[0]?.message || {};

  return {
    content: choice.content || null,
    tool_calls: choice.tool_calls || [],
    model: data.model || model,
    usage: {
      prompt_tokens: data.usage?.prompt_tokens || 0,
      completion_tokens: data.usage?.completion_tokens || 0,
    },
  };
}

/**
 * Build GatewayConfig from Worker env bindings.
 */
export function gatewayConfigFromEnv(env: any): GatewayConfig {
  return {
    cloudflareAccountId: env.CLOUDFLARE_ACCOUNT_ID || "",
    aiGatewayId: env.AI_GATEWAY_ID || "",
    cloudflareApiToken: env.CLOUDFLARE_API_TOKEN || "",
    aiGatewayToken: env.AI_GATEWAY_TOKEN || "",
  };
}
