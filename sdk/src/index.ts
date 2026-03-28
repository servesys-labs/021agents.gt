/**
 * @agentos/sdk — Official TypeScript SDK for AgentOS
 *
 * @example
 * ```ts
 * import { AgentOS } from "@agentos/sdk";
 *
 * const client = new AgentOS({ apiKey: "ak_live_..." });
 *
 * // Synchronous run
 * const result = await client.agents.run("my-agent", { input: "Hello!" });
 *
 * // Streaming run
 * for await (const event of client.agents.stream("my-agent", { input: "Hello!" })) {
 *   if (event.type === "token") process.stdout.write(event.content);
 * }
 * ```
 *
 * @packageDocumentation
 */

// Main client
export { AgentOS } from "./client";

// Resource clients
export { AgentsClient } from "./agents";
export { ConversationsClient } from "./conversations";
export { EndUsersClient } from "./end-users";

// Errors
export { AgentOSError, AgentOSAuthError, AgentOSTimeoutError } from "./errors";

// Types
export type {
  AgentOSConfig,
  RunOptions,
  RunResult,
  RunWithFilesOptions,
  StreamEvent,
  StreamEventStart,
  StreamEventToken,
  StreamEventDone,
  StreamEventError,
  Conversation,
  ConversationDetail,
  ConversationList,
  ConversationMessage,
  CreateConversationOptions,
  GetConversationOptions,
  ListConversationsOptions,
  SendMessageOptions,
  BatchOptions,
  BatchJob,
  BatchJobDetail,
  EndUserToken,
  EndUserTokenOptions,
  EndUserUsage,
  HealthCheckResult,
} from "./types";
