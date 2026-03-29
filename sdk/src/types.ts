// ---------------------------------------------------------------------------
// Client configuration
// ---------------------------------------------------------------------------

/** Configuration for the OneShots SDK client. */
export interface AgentOSConfig {
  /** API key — must start with "ak_". */
  apiKey: string;

  /**
   * Base URL of the OneShots API.
   * @default "https://api.agentos.dev"
   */
  baseUrl?: string;

  /**
   * Request timeout in milliseconds.
   * @default 120_000
   */
  timeout?: number;

  /**
   * Custom `fetch` implementation.
   * Useful for Node 16 (via `node-fetch`) or test mocks.
   * Defaults to `globalThis.fetch`.
   */
  fetch?: typeof globalThis.fetch;

  /**
   * Enable debug logging of all HTTP requests and responses.
   * @default false
   */
  debug?: boolean;
}

// ---------------------------------------------------------------------------
// Agent run
// ---------------------------------------------------------------------------

/** Options passed when invoking an agent. */
export interface RunOptions {
  /** The user message / prompt to send to the agent. */
  input: string;

  /** Resume an existing conversation by ID. */
  conversationId?: string;

  /** Identify the end-user making the request. */
  userId?: string;

  /** Arbitrary key-value metadata forwarded to the agent. */
  metadata?: Record<string, unknown>;

  /** Override the agent's system prompt for this request. */
  systemPrompt?: string;

  /** Force structured output: "text" | "json_object" | "json_schema" */
  responseFormat?: "text" | "json_object" | "json_schema";

  /** JSON schema for structured output (when responseFormat is "json_schema") */
  responseSchema?: Record<string, unknown>;

  /** Override the model for this request. */
  model?: string;

  /** Idempotency key to prevent duplicate processing on retries. */
  idempotencyKey?: string;

  /** File IDs to attach (from a previous upload). */
  fileIds?: string[];
}

/** Result returned from a synchronous agent run. */
export interface RunResult {
  /** The agent's final text output. */
  output: string;

  /** Unique session identifier for this run. */
  sessionId: string;

  /** Whether the agent completed successfully. */
  success: boolean;

  /** Number of reasoning turns the agent took. */
  turns: number;

  /** Total number of tool calls made during the run. */
  toolCalls: number;

  /** Estimated cost of this run in USD. */
  costUsd: number;

  /** Wall-clock latency of the run in milliseconds. */
  latencyMs: number;

  /** Model used for the run (e.g. "claude-sonnet-4-20250514"). */
  model: string;

  /** Conversation ID if the run participated in a conversation. */
  conversationId: string | null;

  /** File IDs produced or associated with this run. */
  fileIds?: string[];
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

/** Discriminated union of events emitted during a streaming agent run. */
export type StreamEvent =
  | StreamEventStart
  | StreamEventToken
  | StreamEventDone
  | StreamEventError;

export interface StreamEventStart {
  type: "start";
  agent: string;
  timestamp: number;
}

export interface StreamEventToken {
  type: "token";
  content: string;
}

export interface StreamEventDone {
  type: "done";
  output: string;
  sessionId: string;
  success: boolean;
  turns: number;
  toolCalls: number;
  costUsd: number;
  latencyMs: number;
  model: string;
  conversationId: string | null;
}

export interface StreamEventError {
  type: "error";
  message: string;
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

/** Options for creating a new conversation. */
export interface CreateConversationOptions {
  /** Optional display title for the conversation. */
  title?: string;

  /** Identify the end-user who owns this conversation. */
  userId?: string;

  /** Arbitrary metadata to attach to the conversation. */
  metadata?: Record<string, unknown>;
}

/** A conversation summary (returned from list / create). */
export interface Conversation {
  conversationId: string;
  agentName: string;
  title: string | null;
  userId: string | null;
  status: "active" | "archived";
  metadata: Record<string, unknown>;
  messageCount: number;
  lastMessageAt: string | null;
  createdAt: string;
  updatedAt?: string;
}

/** A single message within a conversation. */
export interface ConversationMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

/** Detailed conversation including messages. */
export interface ConversationDetail extends Conversation {
  messages: ConversationMessage[];
}

/** Paginated list of conversations. */
export interface ConversationList {
  conversations: Conversation[];
}

/** Options for listing conversations. */
export interface ListConversationsOptions {
  /** Maximum number of results to return. */
  limit?: number;

  /** Pagination cursor from a previous response. */
  cursor?: string;

  /** Filter by user ID. */
  userId?: string;
}

/** Options for retrieving a single conversation. */
export interface GetConversationOptions {
  /** Whether to include messages in the response. */
  includeMessages?: boolean;
}

/** Options for sending a message to a conversation. */
export interface SendMessageOptions {
  /** Arbitrary metadata to attach to this message. */
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// File uploads
// ---------------------------------------------------------------------------

/** Options for uploading files with a run. */
export interface RunWithFilesOptions extends RunOptions {
  /** Files to upload (browser File objects or Node.js Buffers with name). */
  files: Array<File | { name: string; data: Blob | ArrayBuffer; type?: string }>;
}

// ---------------------------------------------------------------------------
// Batch processing
// ---------------------------------------------------------------------------

/** Batch job submission options. */
export interface BatchOptions {
  tasks: Array<{
    input: string;
    systemPrompt?: string;
    responseFormat?: "text" | "json_object" | "json_schema";
    responseSchema?: Record<string, unknown>;
    fileIds?: string[];
  }>;
  callbackUrl?: string;
  callbackSecret?: string;
  metadata?: Record<string, unknown>;
}

/** Summary of a batch job. */
export interface BatchJob {
  batchId: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  createdAt: string;
  completedAt: string | null;
}

/** Detailed batch job including individual task results. */
export interface BatchJobDetail extends BatchJob {
  tasks: Array<{
    taskIndex: number;
    input: string;
    status: string;
    output: string;
    sessionId: string;
    costUsd: number;
    latencyMs: number;
    error: string;
  }>;
}

// ---------------------------------------------------------------------------
// End-user tokens (SaaS multi-tenant)
// ---------------------------------------------------------------------------

/** End-user token (for SaaS multi-tenant). */
export interface EndUserToken {
  token: string;
  tokenId: string;
  expiresAt: string;
  endUserId: string;
  allowedAgents?: string[];
  rateLimitRpm?: number;
  rateLimitRpd?: number;
}

/** Options for creating an end-user token. */
export interface EndUserTokenOptions {
  endUserId: string;
  allowedAgents?: string[];
  expiresInSeconds?: number;
  rateLimitRpm?: number;
  rateLimitRpd?: number;
}

/** Usage statistics for an end-user. */
export interface EndUserUsage {
  totalRequests: number;
  totalCostUsd: number;
  byAgent: Array<{
    agentName: string;
    requests: number;
    costUsd: number;
  }>;
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

/** Response from the health-check endpoint. */
export interface HealthCheckResult {
  status: "ok" | "degraded" | "down";
  version: string;
  timestamp: string;
}
