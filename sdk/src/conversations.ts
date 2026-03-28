import type { HttpClient } from "./http";
import type {
  Conversation,
  ConversationDetail,
  ConversationList,
  CreateConversationOptions,
  GetConversationOptions,
  ListConversationsOptions,
  RunResult,
  SendMessageOptions,
} from "./types";

/**
 * Client for managing agent conversations.
 *
 * Conversations allow multi-turn interactions where the agent retains
 * context across messages. Access via `client.agents.conversations`.
 */
export class ConversationsClient {
  /** @internal */
  constructor(private readonly _http: HttpClient) {}

  /**
   * Create a new conversation for an agent.
   *
   * @param agentName - The agent's unique name.
   * @param options   - Optional title, userId, and metadata.
   * @returns The newly created conversation.
   *
   * @example
   * ```ts
   * const convo = await client.agents.conversations.create("support-bot", {
   *   title: "Billing help",
   *   userId: "user_123",
   * });
   * ```
   */
  async create(
    agentName: string,
    options?: CreateConversationOptions,
  ): Promise<Conversation> {
    return this._http.request<Conversation>(
      "POST",
      `/v1/agents/${encodeURIComponent(agentName)}/conversations`,
      {
        title: options?.title,
        user_id: options?.userId,
        metadata: options?.metadata,
      },
    );
  }

  /**
   * List conversations for an agent.
   *
   * @param agentName - The agent's unique name.
   * @param options   - Pagination and filtering options.
   * @returns A paginated list of conversations.
   *
   * @example
   * ```ts
   * const { conversations, hasMore } = await client.agents.conversations.list(
   *   "support-bot",
   *   { limit: 20, userId: "user_123" },
   * );
   * ```
   */
  async list(
    agentName: string,
    options?: ListConversationsOptions,
  ): Promise<ConversationList> {
    return this._http.request<ConversationList>(
      "GET",
      `/v1/agents/${encodeURIComponent(agentName)}/conversations`,
      undefined,
      {
        limit: options?.limit,
        offset: options?.cursor,
        user_id: options?.userId,
      },
    );
  }

  /**
   * Retrieve a single conversation by ID.
   *
   * @param agentName      - The agent's unique name.
   * @param conversationId - The conversation's unique ID.
   * @param options        - Pass `includeMessages: true` to fetch the full message history.
   * @returns The conversation, optionally including messages.
   *
   * @example
   * ```ts
   * const detail = await client.agents.conversations.get(
   *   "support-bot",
   *   "conv_abc123",
   *   { includeMessages: true },
   * );
   * console.log(detail.messages);
   * ```
   */
  async get(
    agentName: string,
    conversationId: string,
    options?: GetConversationOptions,
  ): Promise<ConversationDetail> {
    return this._http.request<ConversationDetail>(
      "GET",
      `/v1/agents/${encodeURIComponent(agentName)}/conversations/${encodeURIComponent(conversationId)}`,
      undefined,
      {
        includeMessages: options?.includeMessages,
      },
    );
  }

  /**
   * Delete a conversation and all its messages.
   *
   * @param agentName      - The agent's unique name.
   * @param conversationId - The conversation's unique ID.
   *
   * @example
   * ```ts
   * await client.agents.conversations.delete("support-bot", "conv_abc123");
   * ```
   */
  async delete(agentName: string, conversationId: string): Promise<void> {
    await this._http.request<void>(
      "DELETE",
      `/v1/agents/${encodeURIComponent(agentName)}/conversations/${encodeURIComponent(conversationId)}`,
    );
  }

  /**
   * Send a message to an existing conversation and get the agent's response.
   *
   * This is a convenience method equivalent to calling `agents.run()` with
   * a `conversationId`.
   *
   * @param agentName      - The agent's unique name.
   * @param conversationId - The conversation to continue.
   * @param input          - The user's message text.
   * @param options        - Optional metadata.
   * @returns The agent's response.
   *
   * @example
   * ```ts
   * const result = await client.agents.conversations.send(
   *   "support-bot",
   *   "conv_abc123",
   *   "What's the status of my refund?",
   * );
   * console.log(result.output);
   * ```
   */
  async send(
    agentName: string,
    conversationId: string,
    input: string,
    options?: SendMessageOptions,
  ): Promise<RunResult> {
    return this._http.request<RunResult>(
      "POST",
      `/v1/agents/${encodeURIComponent(agentName)}/run`,
      {
        input,
        conversation_id: conversationId,
        metadata: options?.metadata,
      },
    );
  }
}
