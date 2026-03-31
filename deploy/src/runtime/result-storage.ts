/**
 * Cloud Pattern C3.1: Large Tool Result Persistence to R2
 *
 * Problem: Tool results > 30K chars are truncated and the full data is LOST.
 * The agent can never retrieve the original result.
 *
 * Solution: Persist large results to R2 with a preview + signed URL returned
 * to the agent. The agent can use read-file or a new retrieve-result tool
 * to access the full content when needed.
 *
 * Inspired by Claude Code's toolResultStorage.ts which persists to disk
 * with preview + file path reference, using write-once semantics.
 */

import type { RuntimeEnv } from "./types";

const PERSIST_THRESHOLD_CHARS = 30_000;   // Store in R2 above this
const PREVIEW_CHARS = 2000;               // First N chars sent inline
const R2_TTL_DAYS = 7;                    // Auto-cleanup after 7 days

/**
 * Process a tool result: if large, persist to R2 and return preview + reference.
 * If small, return as-is.
 */
export async function processToolResult(
  env: RuntimeEnv,
  result: string,
  opts: {
    sessionId: string;
    toolCallId: string;
    toolName: string;
  },
): Promise<{ content: string; persisted: boolean; r2Key?: string }> {
  if (!result || result.length <= PERSIST_THRESHOLD_CHARS) {
    return { content: result, persisted: false };
  }

  const storage = env.STORAGE;
  if (!storage) {
    // No R2 available — fall back to truncation
    return {
      content: result.slice(0, PERSIST_THRESHOLD_CHARS) + `\n[truncated — ${result.length} chars total, R2 not available]`,
      persisted: false,
    };
  }

  // Write full result to R2
  const r2Key = `results/${opts.sessionId}/${opts.toolCallId}.txt`;
  try {
    await storage.put(r2Key, result, {
      customMetadata: {
        tool_name: opts.toolName,
        session_id: opts.sessionId,
        size: String(result.length),
        created_at: new Date().toISOString(),
      },
    });

    // Return preview + reference
    const preview = result.slice(0, PREVIEW_CHARS);
    const content = `${preview}\n\n[Full result (${result.length} chars) persisted to storage. Use retrieve-result tool with key "${r2Key}" to access the complete output.]`;

    return { content, persisted: true, r2Key };
  } catch (e) {
    // R2 write failed — fall back to truncation
    return {
      content: result.slice(0, PERSIST_THRESHOLD_CHARS) + `\n[truncated — ${result.length} chars, R2 write failed]`,
      persisted: false,
    };
  }
}

/**
 * Retrieve a full tool result from R2 by key.
 * Called by the retrieve-result tool when agent needs full content.
 */
export async function retrieveToolResult(
  env: RuntimeEnv,
  r2Key: string,
): Promise<string | null> {
  const storage = env.STORAGE;
  if (!storage) return null;

  try {
    const obj = await storage.get(r2Key);
    if (!obj) return null;
    return await obj.text();
  } catch {
    return null;
  }
}

/**
 * Clean up old result files for a session.
 * Called during session cleanup or via scheduled task.
 */
export async function cleanupSessionResults(
  env: RuntimeEnv,
  sessionId: string,
): Promise<number> {
  const storage = env.STORAGE;
  if (!storage) return 0;

  try {
    const listed = await storage.list({ prefix: `results/${sessionId}/` });
    const keys = listed.objects.map((o: any) => o.key);
    for (const key of keys) {
      await storage.delete(key);
    }
    return keys.length;
  } catch {
    return 0;
  }
}
