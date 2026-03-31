/**
 * Context compression — prevents token overflow in long sessions.
 *
 * Two strategies:
 * 1. shouldCompact(): Check if messages exceed ~85% of context window
 * 2. compactMessages(): Summarize old messages, keep recent context
 *
 * Inspired by Claude Code's 4-layer compaction (auto, micro, reactive, session).
 * This implements the auto-compact layer for AgentOS Workflows.
 */

import type { LLMMessage, RuntimeEnv } from "./types";

// Token estimation: ~4 chars per token for English text, ~2 for JSON/code
function estimateTokens(text: string): number {
  if (!text) return 0;
  // JSON-heavy content (tool results) uses ~2 chars/token
  const isJson = text.startsWith("{") || text.startsWith("[");
  return Math.ceil(text.length / (isJson ? 2 : 4));
}

function estimateMessagesTokens(messages: Array<{ role: string; content: any }>): number {
  let total = 0;
  for (const msg of messages) {
    const content = typeof msg.content === "string"
      ? msg.content
      : JSON.stringify(msg.content || "");
    total += estimateTokens(content) + 4; // 4 tokens overhead per message
  }
  return total;
}

/**
 * Check if conversation needs compaction.
 * Returns true when estimated tokens exceed 85% of the model's context window.
 */
export function shouldCompact(
  messages: Array<{ role: string; content: any }>,
  modelMaxTokens: number = 128_000,
): boolean {
  const estimated = estimateMessagesTokens(messages);
  const threshold = Math.floor(modelMaxTokens * 0.85);
  return estimated > threshold;
}

/**
 * Compress conversation by summarizing old messages.
 * Keeps system prompts + last N messages intact.
 * Middle section is summarized into a single "conversation summary" message.
 */
export async function compactMessages(
  env: RuntimeEnv,
  messages: Array<{ role: string; content: string; tool_calls?: any[]; tool_call_id?: string; name?: string }>,
  keepRecent: number = 6,
): Promise<Array<{ role: string; content: string; tool_calls?: any[]; tool_call_id?: string; name?: string }>> {
  // Separate system messages and conversation
  const system = messages.filter(m => m.role === "system");
  const conversation = messages.filter(m => m.role !== "system");

  // If conversation is short enough, no compaction needed
  if (conversation.length <= keepRecent + 2) {
    return messages;
  }

  // Split: old messages to summarize + recent to keep
  const toSummarize = conversation.slice(0, -keepRecent);
  const toKeep = conversation.slice(-keepRecent);

  // Build summary from old messages (without LLM call — fast extraction)
  const summaryParts: string[] = [];
  for (const msg of toSummarize) {
    if (msg.role === "user") {
      const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
      summaryParts.push(`User: ${text.slice(0, 200)}`);
    } else if (msg.role === "assistant" && !msg.tool_calls?.length) {
      summaryParts.push(`Assistant: ${(msg.content || "").slice(0, 200)}`);
    } else if (msg.role === "tool") {
      const result = (msg.content || "").slice(0, 100);
      summaryParts.push(`Tool(${msg.name || "unknown"}): ${result}`);
    }
  }

  const summaryText = `[Conversation summary — ${toSummarize.length} messages compressed]\n${summaryParts.join("\n")}`;

  return [
    ...system,
    { role: "user", content: summaryText },
    ...toKeep,
  ];
}
