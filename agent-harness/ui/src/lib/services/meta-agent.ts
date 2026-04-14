/**
 * Meta-agent service — CF Agents SDK primitives.
 *
 * Meta-agent is now consolidated into the personal agent DO. All meta
 * operations (create agent, update agent, evaluate, etc.) are @callable
 * methods on the same Think DO. This service sends meta-agent commands
 * via AgentClient WebSocket using the Think chat protocol.
 */

import { streamAgent, type ChatEvent } from "./chat";

export type MetaModelPath = "auto" | "gemma" | "sonnet";

/**
 * Stream a meta-agent command via AgentClient WebSocket.
 *
 * Since meta-agent is merged into the personal agent, this connects to
 * the "default" agent DO and prefixes the message with a meta-agent
 * routing hint so the Think system prompt activates meta skills.
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
  // Route through the personal agent's SDK connection.
  // The meta-agent context is activated by the message content
  // (e.g., "create an agent", "evaluate agent X") which triggers
  // meta-skills loaded via R2SkillProvider.
  const cleanHistory = history?.map(h => ({
    role: h.role,
    content: h.content,
  }));

  return streamAgent(
    "default", // personal agent handles meta operations
    message,
    onEvent,
    sessionId,
    undefined, // plan
    cleanHistory,
  );
}
