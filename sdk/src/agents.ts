import { ConversationsClient } from "./conversations";
import type { HttpClient } from "./http";
import type {
  BatchJob,
  BatchJobDetail,
  BatchOptions,
  RunOptions,
  RunResult,
  RunWithFilesOptions,
  StreamEvent,
} from "./types";

/**
 * Client for running agents and managing their conversations.
 *
 * Access via `client.agents`.
 *
 * @example
 * ```ts
 * const client = new AgentOS({ apiKey: "ak_..." });
 *
 * // Synchronous run
 * const result = await client.agents.run("my-agent", {
 *   input: "Summarize today's news",
 * });
 * console.log(result.output);
 *
 * // Streaming run
 * for await (const event of client.agents.stream("my-agent", {
 *   input: "Write a poem",
 * })) {
 *   if (event.type === "token") process.stdout.write(event.content);
 * }
 * ```
 */
export class AgentsClient {
  /** Sub-client for conversation management. */
  readonly conversations: ConversationsClient;

  /** @internal */
  constructor(private readonly _http: HttpClient) {
    this.conversations = new ConversationsClient(_http);
  }

  /**
   * Run an agent synchronously and wait for the full response.
   *
   * @param agentName - The agent's unique name (e.g. "support-bot").
   * @param options   - Input text and optional conversation/user context.
   * @returns The complete run result including output, cost, and timing.
   *
   * @example
   * ```ts
   * const result = await client.agents.run("my-agent", {
   *   input: "What is the weather in SF?",
   *   userId: "user_123",
   * });
   * console.log(result.output);
   * console.log(`Cost: $${result.costUsd.toFixed(4)}`);
   * ```
   */
  async run(agentName: string, options: RunOptions): Promise<RunResult> {
    return this._http.request<RunResult>(
      "POST",
      `/v1/agents/${encodeURIComponent(agentName)}/run`,
      this._buildRunBody(options),
    );
  }

  /**
   * Run an agent with Server-Sent Events (SSE) streaming.
   *
   * Returns an async generator that yields {@link StreamEvent} objects
   * as the agent processes the request. Tokens are streamed incrementally,
   * allowing you to display partial output in real time.
   *
   * @param agentName - The agent's unique name.
   * @param options   - Input text and optional conversation/user context.
   * @returns An async generator of stream events.
   *
   * @example
   * ```ts
   * for await (const event of client.agents.stream("my-agent", {
   *   input: "Tell me a story",
   * })) {
   *   switch (event.type) {
   *     case "start":
   *       console.log(`Agent ${event.agent} started`);
   *       break;
   *     case "token":
   *       process.stdout.write(event.content);
   *       break;
   *     case "done":
   *       console.log(`\nFinished in ${event.latencyMs}ms`);
   *       break;
   *     case "error":
   *       console.error(event.message);
   *       break;
   *   }
   * }
   * ```
   */
  async *stream(
    agentName: string,
    options: RunOptions & { signal?: AbortSignal },
  ): AsyncGenerator<StreamEvent, void, undefined> {
    yield* this._http.stream(
      `/v1/agents/${encodeURIComponent(agentName)}/run/stream`,
      this._buildRunBody(options),
      options.signal,
    );
  }

  /**
   * Run an agent with file uploads (multipart).
   *
   * Files are uploaded as multipart form data alongside the run options.
   *
   * @param agentName - The agent's unique name.
   * @param options   - Run options plus files to upload.
   * @returns The complete run result.
   *
   * @example
   * ```ts
   * const result = await client.agents.runWithFiles("doc-reader", {
   *   input: "Summarize this PDF",
   *   files: [myFile],
   * });
   * ```
   */
  async runWithFiles(
    agentName: string,
    options: RunWithFilesOptions,
  ): Promise<RunResult> {
    const form = new FormData();
    form.append("input", options.input);
    if (options.conversationId) form.append("conversation_id", options.conversationId);
    if (options.userId) form.append("user_id", options.userId);
    if (options.metadata) form.append("metadata", JSON.stringify(options.metadata));
    if (options.systemPrompt) form.append("system_prompt", options.systemPrompt);
    if (options.responseFormat) form.append("response_format", options.responseFormat);
    if (options.responseSchema) form.append("response_schema", JSON.stringify(options.responseSchema));
    if (options.model) form.append("model", options.model);
    if (options.idempotencyKey) form.append("idempotency_key", options.idempotencyKey);
    if (options.fileIds) form.append("file_ids", JSON.stringify(options.fileIds));

    for (const file of options.files) {
      if (file instanceof File) {
        form.append("files", file, file.name);
      } else {
        const blob = file.data instanceof Blob ? file.data : new Blob([file.data], { type: file.type });
        form.append("files", blob, file.name);
      }
    }

    return this._http.requestMultipart<RunResult>(
      `/v1/agents/${encodeURIComponent(agentName)}/run`,
      form,
    );
  }

  /**
   * Submit a batch of tasks for asynchronous processing.
   *
   * @param agentName - The agent's unique name.
   * @param options   - Batch tasks and optional callback configuration.
   * @returns The created batch job summary.
   *
   * @example
   * ```ts
   * const job = await client.agents.batch("summarizer", {
   *   tasks: [
   *     { input: "Summarize article 1" },
   *     { input: "Summarize article 2" },
   *   ],
   *   callbackUrl: "https://example.com/webhook",
   * });
   * console.log(job.batchId);
   * ```
   */
  async batch(agentName: string, options: BatchOptions): Promise<BatchJob> {
    return this._http.request<BatchJob>(
      "POST",
      `/v1/agents/${encodeURIComponent(agentName)}/run/batch`,
      {
        tasks: options.tasks.map((t) => ({
          input: t.input,
          system_prompt: t.systemPrompt,
          response_format: t.responseFormat,
          response_schema: t.responseSchema,
          file_ids: t.fileIds,
        })),
        callback_url: options.callbackUrl,
        callback_secret: options.callbackSecret,
        metadata: options.metadata,
      },
    );
  }

  /**
   * Get batch job status and results.
   *
   * @param agentName - The agent's unique name.
   * @param batchId   - The batch job ID.
   * @returns Detailed batch job info including individual task results.
   */
  async getBatch(agentName: string, batchId: string): Promise<BatchJobDetail> {
    return this._http.request<BatchJobDetail>(
      "GET",
      `/v1/agents/${encodeURIComponent(agentName)}/batches/${encodeURIComponent(batchId)}`,
    );
  }

  /**
   * List batch jobs for an agent.
   *
   * @param agentName - The agent's unique name.
   * @param options   - Optional limit for pagination.
   * @returns A list of batch job summaries.
   */
  async listBatches(
    agentName: string,
    options?: { limit?: number },
  ): Promise<{ batches: BatchJob[] }> {
    return this._http.request<{ batches: BatchJob[] }>(
      "GET",
      `/v1/agents/${encodeURIComponent(agentName)}/batches`,
      undefined,
      { limit: options?.limit },
    );
  }

  /**
   * Cancel a running batch job.
   *
   * @param agentName - The agent's unique name.
   * @param batchId   - The batch job ID to cancel.
   */
  async cancelBatch(agentName: string, batchId: string): Promise<void> {
    await this._http.request<void>(
      "POST",
      `/v1/agents/${encodeURIComponent(agentName)}/batches/${encodeURIComponent(batchId)}/cancel`,
    );
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /** Build the JSON body for run / stream requests. */
  private _buildRunBody(options: RunOptions): Record<string, unknown> {
    return {
      input: options.input,
      conversation_id: options.conversationId,
      user_id: options.userId,
      metadata: options.metadata,
      system_prompt: options.systemPrompt,
      response_format: options.responseFormat,
      response_schema: options.responseSchema,
      model: options.model,
      idempotency_key: options.idempotencyKey,
      file_ids: options.fileIds,
    };
  }
}
