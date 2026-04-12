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

// Types used for token estimation only — no runtime deps needed

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
 * Lightweight pre-compaction pass: replace old tool result bodies with short
 * summaries. Tool results are the highest-token, lowest-value content in long
 * sessions. This defers expensive LLM summarization by cheaply shrinking the
 * conversation first. Only prunes results outside the `keepRecent` tail.
 */
export function pruneToolResults(
  messages: Array<{ role: string; content: string; tool_calls?: any[]; tool_call_id?: string; name?: string }>,
  keepRecent: number = 6,
): { messages: Array<{ role: string; content: string; tool_calls?: any[]; tool_call_id?: string; name?: string }>; pruned: number } {
  const system = messages.filter(m => m.role === "system");
  const conversation = messages.filter(m => m.role !== "system");

  if (conversation.length <= keepRecent + 2) {
    return { messages, pruned: 0 };
  }

  const cutoff = conversation.length - keepRecent;
  let pruned = 0;

  const prunedConversation = conversation.map((msg, i) => {
    if (i >= cutoff) return msg; // in the keep-recent tail
    if (msg.role !== "tool") return msg;
    const body = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content || "");
    if (body.length <= 200) return msg; // already small
    pruned++;
    const isError = body.toLowerCase().includes("error") || body.toLowerCase().includes("failed");
    const preview = isError ? body.slice(0, 200) : `OK (${body.length} chars)`;
    return { ...msg, content: `[tool result pruned: ${msg.name || "unknown"} → ${preview}]` };
  });

  return { messages: [...system, ...prunedConversation], pruned };
}

/**
 * Compress conversation by summarizing old messages.
 * Keeps system prompts + last N messages intact.
 * Middle section is summarized into a single "conversation summary" message.
 */
export async function compactMessages(
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

  // Build structured summary from old messages.
  // Inspired by Claude Code's 9-section compaction that preserves critical context
  // even when old messages are removed. Key insight: categorize by PURPOSE not by
  // message order, so the model retains the "why" even when "what" is compressed.

  // Extract structured sections from old messages
  const userRequests: string[] = [];
  const filesAndCode: string[] = [];
  const toolActions: string[] = [];
  const errors: string[] = [];
  const decisions: string[] = [];

  for (const msg of toSummarize) {
    const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content || "");
    if (msg.role === "user") {
      userRequests.push(content.slice(0, 300));
    } else if (msg.role === "assistant") {
      if (msg.tool_calls?.length) {
        // Track tool call decisions (what the agent decided to do)
        for (const tc of msg.tool_calls) {
          const name = tc.function?.name || tc.name || "unknown";
          let args = "";
          try {
            const parsed = JSON.parse(tc.function?.arguments || tc.arguments || "{}");
            args = parsed.path || parsed.query || parsed.command?.slice(0, 80) || parsed.file_path || "";
          } catch {}
          toolActions.push(`${name}${args ? `: ${args}` : ""}`);
        }
      }
      if (content && !msg.tool_calls?.length) {
        decisions.push(content.slice(0, 200));
      }
    } else if (msg.role === "tool") {
      const result = content.slice(0, 150);
      const toolName = msg.name || "unknown";
      // Capture errors separately — they're high-value context
      if (result.toLowerCase().includes("error") || result.toLowerCase().includes("failed")) {
        errors.push(`${toolName}: ${result}`);
      }
      // Track file paths mentioned in tool results
      const pathMatch = result.match(/\/[\w./-]+\.\w+/);
      if (pathMatch) filesAndCode.push(pathMatch[0]);
    }
  }

  // Deduplicate file paths
  const uniqueFiles = [...new Set(filesAndCode)].slice(0, 15);

  // Build the structured summary
  const sections: string[] = [];

  sections.push(`[Conversation summary — ${toSummarize.length} messages compressed]`);

  if (userRequests.length > 0) {
    sections.push(`\n**User requests:**\n${userRequests.map(r => `- ${r}`).join("\n")}`);
  }

  if (uniqueFiles.length > 0) {
    sections.push(`\n**Files referenced:** ${uniqueFiles.join(", ")}`);
  }

  if (toolActions.length > 0) {
    // Show unique tool actions (deduplicated), max 20
    const uniqueActions = [...new Set(toolActions)].slice(0, 20);
    sections.push(`\n**Actions taken:** ${uniqueActions.join("; ")}`);
  }

  if (errors.length > 0) {
    sections.push(`\n**Errors encountered:**\n${errors.slice(0, 5).map(e => `- ${e}`).join("\n")}`);
  }

  if (decisions.length > 0) {
    sections.push(`\n**Key decisions:**\n${decisions.slice(0, 3).map(d => `- ${d}`).join("\n")}`);
  }

  const summaryText = sections.join("\n");

  return [
    ...system,
    { role: "user", content: summaryText },
    ...toKeep,
  ];
}
