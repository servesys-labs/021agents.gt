/**
 * Conversation repair — ensures message arrays are structurally valid.
 *
 * Fixes:
 * 1. Orphaned tool_use (tool_call with no matching tool_result) → inject synthetic result
 * 2. Orphaned tool_result (result with no matching tool_call) → strip
 * 3. Duplicate tool_call IDs across messages → deduplicate
 * 4. Empty tool results → inject descriptive placeholder
 *
 * Inspired by Claude Code's ensureToolResultPairing which maintains cross-message
 * ID tracking and prevents the API from rejecting structurally invalid conversations.
 */

type Message = {
  role: string;
  content: any;
  tool_calls?: Array<{ id: string; name: string; arguments?: string }>;
  tool_call_id?: string;
  name?: string;
};

interface RepairResult {
  messages: Message[];
  repairs: {
    orphanedUses: number;
    orphanedResults: number;
    duplicateIds: number;
    emptyResults: number;
  };
}

/**
 * Repair conversation messages for structural validity.
 * Returns repaired messages + count of repairs made.
 */
export function repairConversation(messages: Message[]): RepairResult {
  const repairs = { orphanedUses: 0, orphanedResults: 0, duplicateIds: 0, emptyResults: 0 };

  // Collect all tool_call IDs and tool_result IDs
  const allToolUseIds = new Set<string>();
  const allToolResultIds = new Set<string>();

  for (const msg of messages) {
    if (msg.role === "assistant" && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        allToolUseIds.add(tc.id);
      }
    }
    if (msg.role === "tool" && msg.tool_call_id) {
      allToolResultIds.add(msg.tool_call_id);
    }
  }

  // Deduplicate tool_call IDs across assistant messages
  const seenUseIds = new Set<string>();
  for (const msg of messages) {
    if (msg.tool_calls) {
      const original = msg.tool_calls.length;
      msg.tool_calls = msg.tool_calls.filter(tc => {
        if (seenUseIds.has(tc.id)) return false;
        seenUseIds.add(tc.id);
        return true;
      });
      repairs.duplicateIds += original - msg.tool_calls.length;
    }
  }

  // Strip orphaned tool_results (result with no matching tool_call)
  const filtered = messages.filter(m => {
    if (m.role === "tool" && m.tool_call_id && !allToolUseIds.has(m.tool_call_id)) {
      repairs.orphanedResults++;
      return false;
    }
    return true;
  });

  // Inject synthetic results for orphaned tool_uses
  const orphanedUses = [...allToolUseIds].filter(id => !allToolResultIds.has(id));
  for (const id of orphanedUses) {
    // Find the tool name from the tool_call
    let toolName = "unknown";
    for (const msg of filtered) {
      const tc = msg.tool_calls?.find(t => t.id === id);
      if (tc) { toolName = tc.name; break; }
    }
    filtered.push({
      role: "tool",
      tool_call_id: id,
      name: toolName,
      content: `[Tool result missing — execution was interrupted]`,
    });
    repairs.orphanedUses++;
  }

  // Guard empty tool results (prevents model stop sequence trigger)
  for (const msg of filtered) {
    if (msg.role === "tool") {
      const content = typeof msg.content === "string" ? msg.content.trim() : "";
      if (!content) {
        msg.content = `(${msg.name || "tool"} completed with no output)`;
        repairs.emptyResults++;
      }
    }
  }

  return { messages: filtered, repairs };
}
