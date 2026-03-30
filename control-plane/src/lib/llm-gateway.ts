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
  const model = options.model || "anthropic/claude-sonnet-4-6";
  const { cloudflareAccountId, aiGatewayId, cloudflareApiToken, aiGatewayToken, openrouterApiKey } = config;

  // Determine endpoint and auth
  const useGateway = !!(cloudflareAccountId && aiGatewayId);
  const isWorkersAI = model.startsWith("@cf/") || model.startsWith("workers-ai/");
  const providerPath = isWorkersAI ? "compat" : "openrouter";
  const endpoint = useGateway
    ? `https://gateway.ai.cloudflare.com/v1/${cloudflareAccountId}/${aiGatewayId}/${providerPath}/chat/completions`
    : "https://openrouter.ai/api/v1/chat/completions";

  const headers: Record<string, string> = { "Content-Type": "application/json" };

  if (useGateway) {
    const cfToken = aiGatewayToken || cloudflareApiToken || "";
    if (cfToken) {
      headers["cf-aig-authorization"] = `Bearer ${cfToken}`;
    }
    if (options.metadata) {
      headers["cf-aig-metadata"] = JSON.stringify(options.metadata);
    }
  } else if (openrouterApiKey) {
    headers["Authorization"] = `Bearer ${openrouterApiKey}`;
  } else {
    throw new Error("No LLM credentials configured. Set CLOUDFLARE_ACCOUNT_ID + AI_GATEWAY_ID, or OPENROUTER_API_KEY.");
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
