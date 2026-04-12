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

export async function callGemma(
  config: GatewayConfig,
  messages: LLMMessage[],
  tools: ToolDef[],
  model = "gemma-4-31b",
): Promise<LLMResult> {
  // Route to the correct AI Gateway provider based on model name
  const isCustomGemma = model.startsWith("gemma-4") || model.includes("gemma4");
  const providerPath = isCustomGemma
    ? (model.includes("26b") || model.includes("moe") || model.includes("fast") ? "custom-gemma4-fast" : "custom-gemma4-local")
    : "openai";
  const url = `https://gateway.ai.cloudflare.com/v1/${config.accountId}/${config.gatewayId}/${providerPath}/v1/chat/completions`;

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.aiGatewayToken) headers["cf-aig-authorization"] = `Bearer ${config.aiGatewayToken}`;
  if (config.gpuServiceKey) headers["Authorization"] = `Bearer ${config.gpuServiceKey}`;

  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
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
