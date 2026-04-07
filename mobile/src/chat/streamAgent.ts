import type { ChatEvent, ChatEventType, StreamAgentOptions } from "./types";
import { logError } from "../telemetry/logger";

function safeEmit(
  onEvent: (event: ChatEvent) => void,
  type: ChatEventType,
  data: Record<string, unknown>,
) {
  onEvent({ type, data });
}

function parseSseChunk(onEvent: (event: ChatEvent) => void, chunk: string) {
  const lines = chunk.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(":")) continue;
    if (!trimmed.startsWith("data:")) continue;
    const raw = trimmed.slice(5).trim();
    if (!raw || raw === "[DONE]") continue;
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const eventType = String(parsed.type ?? "token") as ChatEventType;
      safeEmit(onEvent, eventType, parsed);
    } catch {
      safeEmit(onEvent, "token", { content: raw });
    }
  }
}

export function streamAgent(options: StreamAgentOptions): { abort: () => void } {
  const controller = new AbortController();

  const run = async () => {
    const {
      baseUrl,
      token,
      agentName,
      message,
      sessionId,
      history,
      plan,
      onEvent,
    } = options;

    let res: Response;
    try {
      res = await fetch(`${baseUrl}/api/v1/runtime-proxy/runnable/stream`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          agent_name: agentName,
          input: message,
          message,
          session_id: sessionId,
          history,
          plan,
        }),
        signal: controller.signal,
      });
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      safeEmit(onEvent, "error", {
        message: `Connection failed: ${(err as Error).message}`,
      });
      return;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      safeEmit(onEvent, "error", { message: `HTTP ${res.status}: ${text}` });
      return;
    }

    const reader = res.body?.getReader();
    if (!reader) {
      // React Native may not always expose a streaming reader.
      // Fallback to buffered SSE parsing so chat still works.
      const text = await res.text().catch(() => "");
      if (!text.trim()) {
        safeEmit(onEvent, "error", {
          message: "No stream data returned from runtime.",
        });
        return;
      }
      parseSseChunk(onEvent, text);
      safeEmit(onEvent, "done", {});
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

        parseSseChunk(onEvent, lines.join("\n"));
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        safeEmit(onEvent, "error", {
          message: `Stream error: ${(err as Error).message}`,
        });
      }
      return;
    }

    if (buffer.trim().startsWith("data:")) {
      parseSseChunk(onEvent, buffer.trim());
    }

    safeEmit(onEvent, "done", {});
  };

  run().catch((err) => {
    if (err?.name !== "AbortError") {
      logError("chat.stream_run_error", err, { agent: options.agentName });
      safeEmit(options.onEvent, "error", { message: String(err?.message ?? err) });
    }
  });

  return { abort: () => controller.abort() };
}

