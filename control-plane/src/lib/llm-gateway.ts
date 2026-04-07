/**
 * Shared LLM call helper for control-plane.
 * Routes all calls through CF AI Gateway → OpenRouter.
 * Falls back to direct OpenRouter if gateway config is missing.
 *
 * This is the SINGLE entry point for all LLM calls in the control-plane.
 * Meta-agent, evolution analyzer, build-from-description — all use this.
 */

export interface GatewayConfig {
  cloudflareAccountId?: string;
  aiGatewayId?: string;
  cloudflareApiToken?: string;
  aiGatewayToken?: string;
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
}

export interface LLMCallResult {
  content: string | null;
  tool_calls: any[];
  model: string;
  usage: { prompt_tokens: number; completion_tokens: number };
}

/**
 * Call an LLM through CF AI Gateway.
 * Falls back to direct OpenRouter if gateway is not configured.
 */
export async function callLLMGateway(
  config: GatewayConfig,
  options: LLMCallOptions,
): Promise<LLMCallResult> {
  // ── MVP: Only free models — self-hosted Gemma 4 via AI Gateway ──
  // Meta-agent defaults to Dense 31B for complex reasoning.
  // No OpenRouter, no paid models. Fail loud.
  const model = options.model || "gemma-4-31b";
  const { cloudflareAccountId, aiGatewayId, cloudflareApiToken, aiGatewayToken } = config;

  if (!cloudflareAccountId || !aiGatewayId) {
    throw new Error("MVP mode: CLOUDFLARE_ACCOUNT_ID and AI_GATEWAY_ID required. No OpenRouter fallback.");
  }

  const isCustomModel = model.startsWith("gemma-4") || model.includes("gemma4");
  const isWorkersAI = model.startsWith("@cf/");

  if (!isCustomModel && !isWorkersAI) {
    throw new Error(`MVP mode: Only free models allowed (gemma-4-* or @cf/*). Got "${model}". No paid model fallbacks.`);
  }

  let endpoint: string;
  if (isCustomModel) {
    // Route to self-hosted Gemma via AI Gateway custom provider
    // Dense 31B = custom-gemma4-local, MoE 26B = custom-gemma4-fast
    const providerPath = model.includes("26b") || model.includes("moe") || model.includes("fast")
      ? "custom-gemma4-fast"
      : "custom-gemma4-local";
    endpoint = `https://gateway.ai.cloudflare.com/v1/${cloudflareAccountId}/${aiGatewayId}/${providerPath}/v1/chat/completions`;
  } else {
    endpoint = `https://gateway.ai.cloudflare.com/v1/${cloudflareAccountId}/${aiGatewayId}/workers-ai/v1/chat/completions`;
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const cfToken = aiGatewayToken || cloudflareApiToken || "";
  if (cfToken) {
    headers["cf-aig-authorization"] = `Bearer ${cfToken}`;
  }
  if (options.metadata) {
    headers["cf-aig-metadata"] = JSON.stringify(options.metadata);
  }

  const body: Record<string, any> = {
    model,
    messages: options.messages,
  };
  if (options.tools?.length) body.tools = options.tools;
  if (options.tool_choice) body.tool_choice = options.tool_choice;
  if (options.max_tokens) body.max_tokens = options.max_tokens;
  if (options.temperature !== undefined) body.temperature = options.temperature;

  const resp = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "Unknown error");
    throw new Error(`LLM API error (${resp.status}): ${errText.slice(0, 300)}`);
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
    openrouterApiKey: env.OPENROUTER_API_KEY || "",
  };
}
