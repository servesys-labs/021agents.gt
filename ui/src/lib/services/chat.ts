import { api } from "./api";

export type ChatEventType =
  | "session_start"
  | "setup_done"
  | "governance_pass"
  | "checkpoint_resumed"
  | "turn_start"
  | "thinking"
  | "tool_call"
  | "tool_result"
  | "token"
  | "turn_end"
  | "done"
  | "error";

export interface ChatEvent {
  type: ChatEventType;
  data: Record<string, unknown>;
}

export interface TurnStartData {
  turn: number;
  model: string;
}

export interface TokenData {
  content: string;
}

export interface ThinkingData {
  content: string;
  turn: number;
}

export interface ToolCallData {
  name: string;
  tool_call_id: string;
  args_preview: string;
}

export interface ToolResultData {
  name: string;
  tool_call_id: string;
  result: string;
  latency_ms: number;
}

export interface DoneData {
  output: string;
  cost_usd: number;
  session_id: string;
  turns: number;
  tool_calls: number;
}

export interface ErrorData {
  message: string;
}

/** Single-shot (non-streaming) agent run */
export async function runAgent(
  agentName: string,
  message: string,
  sessionId?: string
): Promise<{ response: string; session_id: string }> {
  return api.post<{ response: string; session_id: string }>(
    "/runtime-proxy/agent/run",
    { agent_name: agentName, message, session_id: sessionId }
  );
}

/** Streaming agent run via SSE */
export function streamAgent(
  agentName: string,
  message: string,
  onEvent: (event: ChatEvent) => void,
  sessionId?: string,
  plan?: string,
  history?: Array<{ role: string; content: string }>,
  conversationId?: string,
): { abort: () => void } {
  const controller = new AbortController();

  const run = async () => {
    let res: Response;
    try {
      res = await fetch(`${api.baseUrl}/runtime-proxy/runnable/stream`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(api.token ? { Authorization: `Bearer ${api.token}` } : {}),
        },
        body: JSON.stringify({
          agent_name: agentName,
          input: message,
          session_id: sessionId,
          ...(plan ? { plan } : {}),
          ...(history && history.length > 0 ? { history } : {}),
          ...(conversationId ? { conversation_id: conversationId } : {}),
        }),
        signal: controller.signal,
      });
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      onEvent({
        type: "error",
        data: { message: `Connection failed: ${(err as Error).message}` },
      });
      return;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      onEvent({ type: "error", data: { message: `HTTP ${res.status}: ${text}` } });
      return;
    }

    const reader = res.body?.getReader();
    if (!reader) {
      onEvent({ type: "error", data: { message: "No readable stream" } });
      return;
    }

    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(":")) continue;

          if (trimmed.startsWith("data:")) {
            const raw = trimmed.slice(5).trim();
            if (!raw || raw === "[DONE]") continue;

            try {
              const parsed = JSON.parse(raw);
              const eventType: ChatEventType = parsed.type ?? "token";

              // The runtime sends flat events: { type, content, name, ... }
              // Map them into our ChatEvent shape, passing the whole object as data.
              onEvent({ type: eventType, data: parsed });
            } catch {
              // Non-JSON line: treat as raw token text
              onEvent({ type: "token", data: { content: raw } });
            }
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        onEvent({
          type: "error",
          data: { message: `Stream error: ${(err as Error).message}` },
        });
      }
      return;
    }

    // Flush remaining buffer
    if (buffer.trim().startsWith("data:")) {
      const raw = buffer.trim().slice(5).trim();
      if (raw && raw !== "[DONE]") {
        try {
          const parsed = JSON.parse(raw);
          onEvent({ type: parsed.type ?? "token", data: parsed });
        } catch {
          // ignore
        }
      }
    }

    onEvent({ type: "done", data: {} });
  };

  run().catch((err) => {
    if (err.name !== "AbortError") {
      onEvent({ type: "error", data: { message: err.message } });
    }
  });

  return { abort: () => controller.abort() };
}
