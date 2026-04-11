/**
 * A2A Client — Call external A2A agents via HTTP.
 *
 *
 * Usage:
 *   const client = new A2AClient("https://agent.example.com");
 *   const result = await client.sendMessage("What is the weather?");
 *   for await (const chunk of client.sendStreamingMessage("Tell me a story")) {
 *     console.log(chunk);
 *   }
 */

export interface A2AMessage {
  id?: string;
  role: "user" | "agent";
  parts: Array<{ text: string } | { type: string; data?: unknown }>;
  timestamp?: string;
}

export interface A2ATask {
  id: string;
  status: {
    state: "WORKING" | "COMPLETED" | "FAILED" | "CANCELED";
    timestamp: string;
  };
  messages: A2AMessage[];
  artifacts?: Array<{
    id: string;
    name?: string;
    parts: A2AMessage["parts"];
  }>;
  createdAt?: string;
}

export interface A2AStreamingUpdate {
  message?: A2AMessage;
  statusUpdate?: {
    taskId: string;
    status: A2ATask["status"];
  };
  error?: string;
}

export interface SendMessageOptions {
  agentName?: string;
  taskId?: string;
  history?: A2AMessage[];
}

export interface SendStreamingOptions extends SendMessageOptions {
  onTurn?: (update: A2AStreamingUpdate) => void;
}

/** Error thrown when A2A request fails. */
export class A2AError extends Error {
  constructor(
    message: string,
    public readonly code?: number,
    public readonly response?: Response,
  ) {
    super(message);
    this.name = "A2AError";
  }
}

/** Client for interacting with external A2A agents. */
export class A2AClient {
  constructor(
    private readonly baseUrl: string,
    private readonly options: {
      timeoutMs?: number;
      headers?: Record<string, string>;
    } = {},
  ) {}

  /** Fetch agent card from /.well-known/agent.json */
  async getAgentCard(): Promise<Record<string, unknown>> {
    const url = new URL("/.well-known/agent.json", this.baseUrl).toString();
    const resp = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        ...this.options.headers,
      },
    });

    if (!resp.ok) {
      throw new A2AError(
        `Failed to fetch agent card: ${resp.statusText}`,
        resp.status,
        resp,
      );
    }

    return (await resp.json()) as Record<string, unknown>;
  }

  /**
   * Send a message to the agent and wait for the complete response.
   *
   * @param text - The message text to send
   * @param options - Optional agent name, task ID, and message history
   * @returns The completed task with response
   */
  async sendMessage(text: string, options: SendMessageOptions = {}): Promise<A2ATask> {
    const message: A2AMessage = {
      id: this.generateId(),
      role: "user",
      parts: [{ text }],
      timestamp: this.isoNow(),
    };

    const history = options.history || [];
    const payload = {
      jsonrpc: "2.0",
      id: this.generateId(),
      method: "SendMessage",
      params: {
        message,
        history,
        ...(options.agentName ? { agentName: options.agentName } : {}),
        ...(options.taskId ? { taskId: options.taskId } : {}),
      },
    };

    const resp = await this.fetchJSON("/a2a", payload);
    return this.extractTask(resp);
  }

  /**
   * Send a message and stream the response via SSE.
   *
   * @param text - The message text to send
   * @param options - Optional callbacks and configuration
   * @yields Streaming updates from the agent
   */
  async *sendStreamingMessage(
    text: string,
    options: SendStreamingOptions = {},
  ): AsyncGenerator<A2AStreamingUpdate> {
    const message: A2AMessage = {
      id: this.generateId(),
      role: "user",
      parts: [{ text }],
      timestamp: this.isoNow(),
    };

    const history = options.history || [];
    const payload = {
      jsonrpc: "2.0",
      id: this.generateId(),
      method: "SendStreamingMessage",
      params: {
        message,
        history,
        ...(options.agentName ? { agentName: options.agentName } : {}),
        ...(options.taskId ? { taskId: options.taskId } : {}),
      },
    };

    const url = new URL("/a2a", this.baseUrl).toString();
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      this.options.timeoutMs || 300_000, // 5 minute default
    );

    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          ...this.options.headers,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!resp.ok) {
        throw new A2AError(
          `Streaming request failed: ${resp.statusText}`,
          resp.status,
          resp,
        );
      }

      if (!resp.body) {
        throw new A2AError("No response body for streaming request");
      }

      // Parse SSE stream
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith("data: ")) {
            const data = trimmed.slice(6);
            if (data === "[DONE]") {
              return;
            }
            try {
              const update = JSON.parse(data) as A2AStreamingUpdate;
              if (options.onTurn) {
                options.onTurn(update);
              }
              yield update;
            } catch {
              // Skip invalid JSON lines
            }
          }
        }
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /** Get the current status of a task. */
  async getTask(taskId: string): Promise<A2ATask> {
    const payload = {
      jsonrpc: "2.0",
      id: this.generateId(),
      method: "GetTask",
      params: { id: taskId },
    };

    const resp = await this.fetchJSON("/a2a", payload);
    return this.extractTask(resp);
  }

  /** Cancel a running task. */
  async cancelTask(taskId: string): Promise<A2ATask> {
    const payload = {
      jsonrpc: "2.0",
      id: this.generateId(),
      method: "CancelTask",
      params: { id: taskId },
    };

    const resp = await this.fetchJSON("/a2a", payload);
    return this.extractTask(resp);
  }

  /** List all known tasks (server-dependent support). */
  async listTasks(): Promise<A2ATask[]> {
    const payload = {
      jsonrpc: "2.0",
      id: this.generateId(),
      method: "ListTasks",
      params: {},
    };

    const resp = await this.fetchJSON("/a2a", payload);
    const result = (resp as { result?: { tasks?: A2ATask[] } }).result;
    return result?.tasks || [];
  }

  /** Helper: POST JSON to A2A endpoint. */
  private async fetchJSON(
    path: string,
    payload: unknown,
  ): Promise<Record<string, unknown>> {
    const url = new URL(path, this.baseUrl).toString();
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      this.options.timeoutMs || 60_000, // 1 minute default
    );

    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          ...this.options.headers,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const data = (await resp.json()) as Record<string, unknown>;

      if (!resp.ok) {
        const error = (data as { error?: { message?: string; code?: number } }).error;
        throw new A2AError(
          error?.message || `Request failed: ${resp.statusText}`,
          error?.code || resp.status,
          resp,
        );
      }

      if ("error" in data) {
        const error = (data as { error: { message: string; code: number } }).error;
        throw new A2AError(error.message, error.code);
      }

      return data;
    } catch (e) {
      clearTimeout(timeoutId);
      if (e instanceof A2AError) throw e;
      throw new A2AError(`Request failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Helper: Extract task from JSON-RPC response. */
  private extractTask(resp: Record<string, unknown>): A2ATask {
    const result = (resp as { result?: { task?: A2ATask } }).result;
    if (!result?.task) {
      throw new A2AError("Invalid response: missing task");
    }
    return result.task;
  }

  /** Generate a short unique ID. */
  private generateId(): string {
    return crypto.randomUUID().slice(0, 16);
  }

  /** Get current ISO timestamp. */
  private isoNow(): string {
    return new Date().toISOString();
  }
}

/** Factory function to create an A2A client. */
export function createA2AClient(
  baseUrl: string,
  options?: { timeoutMs?: number; headers?: Record<string, string> },
): A2AClient {
  return new A2AClient(baseUrl, options);
}
