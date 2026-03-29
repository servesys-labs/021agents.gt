/**
 * Thin API client for the OneShots widget.
 * Handles conversation creation and SSE-based message streaming.
 */

export interface ConversationResult {
  conversation_id: string;
}

/**
 * Create a new conversation for the given agent.
 */
export async function createConversation(
  baseUrl: string,
  apiKey: string,
  agent: string
): Promise<ConversationResult> {
  const res = await fetch(
    `${baseUrl}/v1/agents/${encodeURIComponent(agent)}/conversations`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({}),
    }
  );

  if (!res.ok) {
    throw new Error(`Failed to create conversation: ${res.status} ${res.statusText}`);
  }

  return res.json();
}

/**
 * Stream a message to the agent and yield tokens as they arrive via SSE.
 *
 * The endpoint is expected to return a text/event-stream with `data:` lines.
 * Each data payload is JSON with at least a `token` or `content` field for
 * partial text, or a `done` field to signal completion.
 */
export async function* streamMessage(
  baseUrl: string,
  apiKey: string,
  agent: string,
  input: string,
  conversationId: string
): AsyncGenerator<string, void, unknown> {
  const res = await fetch(
    `${baseUrl}/v1/agents/${encodeURIComponent(agent)}/run/stream`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        Accept: "text/event-stream",
      },
      body: JSON.stringify({
        input,
        conversation_id: conversationId,
      }),
    }
  );

  if (!res.ok) {
    throw new Error(`Stream request failed: ${res.status} ${res.statusText}`);
  }

  const reader = res.body?.getReader();
  if (!reader) {
    throw new Error("ReadableStream not supported");
  }

  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      // Keep the last (possibly incomplete) line in the buffer.
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(":")) continue; // skip comments / keep-alive

        if (trimmed.startsWith("data:")) {
          const payload = trimmed.slice(5).trim();
          if (payload === "[DONE]") return;

          try {
            const json = JSON.parse(payload);
            // Support multiple common SSE shapes:
            const token =
              json.token ??
              json.content ??
              json.delta?.content ??
              json.choices?.[0]?.delta?.content;

            if (typeof token === "string" && token.length > 0) {
              yield token;
            }

            if (json.done === true || json.finished === true) return;
          } catch {
            // If the payload isn't JSON, treat the raw string as a token.
            if (payload.length > 0 && payload !== "[DONE]") {
              yield payload;
            }
          }
        }
      }
    }

    // Flush remaining buffer
    if (buffer.trim().startsWith("data:")) {
      const payload = buffer.trim().slice(5).trim();
      if (payload && payload !== "[DONE]") {
        try {
          const json = JSON.parse(payload);
          const token =
            json.token ?? json.content ?? json.delta?.content ?? json.choices?.[0]?.delta?.content;
          if (typeof token === "string" && token.length > 0) {
            yield token;
          }
        } catch {
          if (payload.length > 0) yield payload;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Upload files and run a message in one multipart request.
 */
export async function uploadAndRun(
  baseUrl: string,
  apiKey: string,
  agent: string,
  input: string,
  files: File[],
  conversationId: string
): Promise<AsyncGenerator<string, void, unknown>> {
  const formData = new FormData();
  formData.append("input", input);
  formData.append("conversation_id", conversationId);

  for (const file of files) {
    formData.append("files", file, file.name);
  }

  const res = await fetch(
    `${baseUrl}/v1/agents/${encodeURIComponent(agent)}/run/upload`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "text/event-stream",
      },
      body: formData,
    }
  );

  if (!res.ok) {
    throw new Error(`Upload request failed: ${res.status} ${res.statusText}`);
  }

  const reader = res.body?.getReader();
  if (!reader) {
    throw new Error("ReadableStream not supported");
  }

  const decoder = new TextDecoder();
  let buffer = "";

  async function* generate(): AsyncGenerator<string, void, unknown> {
    try {
      while (true) {
        const { done, value } = await reader!.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(":")) continue;

          if (trimmed.startsWith("data:")) {
            const payload = trimmed.slice(5).trim();
            if (payload === "[DONE]") return;

            try {
              const json = JSON.parse(payload);
              const token =
                json.token ??
                json.content ??
                json.delta?.content ??
                json.choices?.[0]?.delta?.content;

              if (typeof token === "string" && token.length > 0) {
                yield token;
              }

              if (json.done === true || json.finished === true) return;
            } catch {
              if (payload.length > 0 && payload !== "[DONE]") {
                yield payload;
              }
            }
          }
        }
      }
    } finally {
      reader!.releaseLock();
    }
  }

  return generate();
}
