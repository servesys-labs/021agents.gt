/**
 * Lightweight LLM client for the personal agent eval harness.
 * Calls Gemma via Cloudflare AI Gateway — same path as production.
 */

export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
  tool_calls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolDef {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface LLMResult {
  content: string;
  tool_calls: ToolCall[];
  usage: { prompt_tokens: number; completion_tokens: number };
}

export interface GatewayConfig {
  accountId: string;
  gatewayId: string;
  /** Cloudflare API token for AI Gateway auth (cf-aig-authorization header) */
  aiGatewayToken: string;
  /** GPU service key for custom-gemma4 origin (Authorization header) */
  gpuServiceKey: string;
}

/**
 * Resolve AI Gateway provider path and auth headers for a given model.
 */
type ProviderType = "anthropic" | "workers-ai" | "custom-gemma" | "openai";

function resolveProvider(model: string): { providerPath: string; type: ProviderType } {
  if (model.includes("claude") || model.includes("haiku") || model.includes("sonnet") || model.includes("opus")) {
    return { providerPath: "anthropic", type: "anthropic" };
  }
  if (model.startsWith("@cf/")) {
    return { providerPath: "workers-ai", type: "workers-ai" };
  }
  const isCustomGemma = model.startsWith("gemma-4") || model.includes("gemma4");
  if (isCustomGemma) {
    const isFast = model.includes("26b") || model.includes("moe") || model.includes("fast");
    return { providerPath: isFast ? "custom-gemma4-fast" : "custom-gemma4-local", type: "custom-gemma" };
  }
  return { providerPath: "openai", type: "openai" };
}

export async function callLLM(
  config: GatewayConfig,
  messages: LLMMessage[],
  tools: ToolDef[],
  model = "gemma-4-31b",
): Promise<LLMResult> {
  const { providerPath, type } = resolveProvider(model);

  if (type === "anthropic") {
    return callAnthropic(config, messages, tools, model, providerPath);
  }

  // Workers AI uses the /compat endpoint with "workers-ai/@cf/..." model prefix
  // Custom Gemma and OpenAI use their own provider paths
  let url: string;
  let requestModel: string;
  const headers: Record<string, string> = { "Content-Type": "application/json" };

  if (type === "workers-ai") {
    // AI Gateway compat endpoint: model = "workers-ai/@cf/moonshotai/kimi-k2.5"
    url = `https://gateway.ai.cloudflare.com/v1/${config.accountId}/${config.gatewayId}/compat/v1/chat/completions`;
    requestModel = `workers-ai/${model}`;
    // Workers AI via compat uses the AI Gateway token as the API key
    if (config.aiGatewayToken) headers["Authorization"] = `Bearer ${config.aiGatewayToken}`;
  } else {
    // Custom Gemma or OpenAI
    url = `https://gateway.ai.cloudflare.com/v1/${config.accountId}/${config.gatewayId}/${providerPath}/v1/chat/completions`;
    requestModel = model;
    if (config.aiGatewayToken) headers["cf-aig-authorization"] = `Bearer ${config.aiGatewayToken}`;
    if (config.gpuServiceKey) headers["Authorization"] = `Bearer ${config.gpuServiceKey}`;
  }

  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: requestModel,
      messages,
      tools: tools.length > 0 ? tools : undefined,
      tool_choice: tools.length > 0 ? "auto" : undefined,
      max_tokens: 4096,
      temperature: 0.1,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`AI Gateway ${resp.status}: ${body.slice(0, 300)}`);
  }

  const data = (await resp.json()) as any;
  const choice = data.choices?.[0];
  return {
    content: choice?.message?.content || "",
    tool_calls: choice?.message?.tool_calls || [],
    usage: data.usage || { prompt_tokens: 0, completion_tokens: 0 },
  };
}

/** Anthropic Messages API via AI Gateway */
async function callAnthropic(
  config: GatewayConfig,
  messages: LLMMessage[],
  tools: ToolDef[],
  model: string,
  providerPath: string,
): Promise<LLMResult> {
  const url = `https://gateway.ai.cloudflare.com/v1/${config.accountId}/${config.gatewayId}/${providerPath}/v1/messages`;

  const anthropicKey = process.env.ANTHROPIC_API_KEY || "";
  if (!anthropicKey) throw new Error("ANTHROPIC_API_KEY required for Claude models");

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": anthropicKey,
    "anthropic-version": "2023-06-01",
  };
  if (config.aiGatewayToken) headers["cf-aig-authorization"] = `Bearer ${config.aiGatewayToken}`;

  // Convert OpenAI-style messages to Anthropic format
  const systemMsg = messages.find(m => m.role === "system");
  const nonSystemMsgs = messages.filter(m => m.role !== "system");

  // Convert OpenAI tool defs to Anthropic tool format
  const anthropicTools = tools.map(t => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }));

  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      system: systemMsg?.content || "",
      messages: nonSystemMsgs.map(m => ({ role: m.role, content: m.content })),
      tools: anthropicTools.length > 0 ? anthropicTools : undefined,
      max_tokens: 4096,
      temperature: 0.1,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Anthropic Gateway ${resp.status}: ${body.slice(0, 300)}`);
  }

  const data = (await resp.json()) as any;

  // Parse Anthropic response format (content blocks)
  let content = "";
  const toolCalls: ToolCall[] = [];
  for (const block of data.content || []) {
    if (block.type === "text") {
      content += block.text;
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: { name: block.name, arguments: JSON.stringify(block.input) },
      });
    }
  }

  return {
    content,
    tool_calls: toolCalls,
    usage: { prompt_tokens: data.usage?.input_tokens || 0, completion_tokens: data.usage?.output_tokens || 0 },
  };
}

/** @deprecated Use callLLM instead */
export const callGemma = callLLM;
