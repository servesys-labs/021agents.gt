import { api } from "./api";
import type { ChatEvent } from "./chat";

export type MetaModelPath = "auto" | "gemma" | "sonnet";

interface MetaChatResponse {
  response: string;
  messages: Array<{
    role: string;
    content: string;
    tool_calls?: Array<{
      id: string;
      function: { name: string; arguments: string };
    }>;
    tool_call_id?: string;
  }>;
  cost_usd: number;
  turns: number;
  model?: string;
  model_path?: MetaModelPath;
}

/**
 * Send a message to the meta-agent.
 * Returns a regular JSON response (not SSE streaming).
 * The response includes the full conversation with tool calls.
 */
export async function sendMetaAgentMessage(
  agentName: string,
  messages: Array<{ role: string; content: string; tool_call_id?: string; tool_calls?: unknown[] }>,
  modelPath?: MetaModelPath,
): Promise<MetaChatResponse> {
  return api.post<MetaChatResponse>(
    `/agents/${encodeURIComponent(agentName)}/meta-chat`,
    { messages, ...(modelPath ? { model_path: modelPath } : {}) },
  );
}

/**
 * Adapter that converts the meta-agent JSON response into ChatEvent-like
 * callbacks so the MetaAgentPanel can reuse the same rendering logic.
 */
export function streamMetaAgent(
  agentName: string,
  message: string,
  onEvent: (event: ChatEvent) => void,
  sessionId?: string,
  history?: Array<{ role: string; content: string; tool_call_id?: string; tool_calls?: unknown[] }>,
  mode?: "demo" | "live",
  modelPath?: MetaModelPath,
): { abort: () => void } {
  const controller = new AbortController();

  const run = async () => {
    try {
      // Build messages array — include history for multi-turn
      const messages = [
        ...(history || []),
        { role: "user" as const, content: message },
      ];

      const res = await fetch(`${api.baseUrl}/agents/${encodeURIComponent(agentName)}/meta-chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(api.token ? { Authorization: `Bearer ${api.token}` } : {}),
        },
        body: JSON.stringify({
          messages,
          ...(mode ? { mode } : {}),
          ...(modelPath ? { model_path: modelPath } : {}),
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => res.statusText);
        onEvent({ type: "error", data: { message: `HTTP ${res.status}: ${text}` } });
        return;
      }

      const data = (await res.json()) as MetaChatResponse;

      // Emit tool calls from the conversation messages
      for (const msg of data.messages || []) {
        if (msg.role === "assistant" && msg.tool_calls?.length) {
          for (const tc of msg.tool_calls) {
            onEvent({
              type: "tool_call",
              data: {
                name: tc.function?.name || "unknown",
                tool_call_id: tc.id,
                args_preview: tc.function?.arguments || "{}",
              },
            });
          }
        }
        if (msg.role === "tool" && msg.tool_call_id) {
          onEvent({
            type: "tool_result",
            data: {
              tool_call_id: msg.tool_call_id,
              result: msg.content || "",
            },
          });
        }
      }

      // Emit the final response as tokens
      if (data.response) {
        onEvent({ type: "token", data: { content: data.response } });
      }

      // Done
      onEvent({
        type: "done",
        data: {
          cost_usd: data.cost_usd || 0,
          turns: data.turns || 0,
          output: data.response,
          model: data.model || "",
          model_path: data.model_path || "auto",
        },
      });
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      onEvent({
        type: "error",
        data: { message: `Meta-agent error: ${(err as Error).message}` },
      });
    }
  };

  run();

  return { abort: () => controller.abort() };
}
