/**
 * Edge Runtime — Middleware.
 *
 * Stateless message-inspection functions that run in the turn loop:
 *   1. Loop Detection — detect repetitive tool calls, warn then halt
 *   2. Context Summarization — auto-compress long conversations
 *
 * These run before/after LLM calls. They inspect messages and
 * return modifications (injected warnings, summarized history).
 */

import type { LLMMessage, RuntimeEnv } from "./types";
import { callLLM } from "./llm";

// ── Loop Detection ────────────────────────────────────────────

interface LoopState {
  /** Recent tool call signatures (name + args hash) */
  recentCalls: string[];
  /** Number of consecutive warnings issued */
  warningCount: number;
}

export function createLoopState(): LoopState {
  return { recentCalls: [], warningCount: 0 };
}

/**
 * Check for repetitive tool call loops after each LLM response.
 *
 * Returns:
 *   - null: no loop detected
 *   - { warn: string }: inject a warning message
 *   - { halt: string }: stop execution (loop confirmed)
 */
export function detectLoop(
  state: LoopState,
  toolCalls: Array<{ name: string; arguments: string }>,
  opts: { windowSize?: number; repeatThreshold?: number; maxWarnings?: number } = {},
): { warn?: string; halt?: string } | null {
  const windowSize = opts.windowSize || 6;
  const repeatThreshold = opts.repeatThreshold || 3;
  const maxWarnings = opts.maxWarnings || 2;

  if (toolCalls.length === 0) {
    // No tools called — reset state
    state.warningCount = 0;
    return null;
  }

  // Build signature for this turn's tool calls
  const sig = toolCalls
    .map((tc) => `${tc.name}:${simpleHash(tc.arguments)}`)
    .sort()
    .join("|");

  state.recentCalls.push(sig);

  // Keep window bounded
  if (state.recentCalls.length > windowSize) {
    state.recentCalls = state.recentCalls.slice(-windowSize);
  }

  // Count consecutive identical signatures
  let consecutive = 0;
  for (let i = state.recentCalls.length - 1; i >= 0; i--) {
    if (state.recentCalls[i] === sig) consecutive++;
    else break;
  }

  if (consecutive >= repeatThreshold) {
    if (state.warningCount >= maxWarnings) {
      return {
        halt: `Loop detected: the same tool call pattern repeated ${consecutive} times. ` +
          `Stopping to prevent infinite loop. Try a different approach.`,
      };
    }
    state.warningCount++;
    return {
      warn: `Warning: You are repeating the same tool calls (${consecutive}x). ` +
        `Try a different approach or provide a final answer without tools.`,
    };
  }

  return null;
}

// ── Context Summarization ─────────────────────────────────────

/**
 * Check if messages need summarization and compress if so.
 *
 * Triggers when total message content exceeds maxChars.
 * Keeps the system prompt, first user message, and last N messages intact.
 * Summarizes the middle section into a single system message.
 */
export async function maybeSummarize(
  env: RuntimeEnv,
  messages: LLMMessage[],
  opts: {
    maxChars?: number;
    keepRecentCount?: number;
    model?: string;
    provider?: string;
  } = {},
): Promise<{ messages: LLMMessage[]; summarized: boolean; cost_usd: number }> {
  const maxChars = opts.maxChars || 50_000;
  const keepRecentCount = opts.keepRecentCount || 6;

  // Count total characters
  const totalChars = messages.reduce((sum, m) => sum + (m.content?.length || 0), 0);
  if (totalChars <= maxChars) {
    return { messages, summarized: false, cost_usd: 0 };
  }

  // Find boundaries: keep system prompt(s) at start + first user msg, keep last N messages
  let headEnd = 0;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "system") {
      headEnd = i + 1;
    } else if (messages[i].role === "user" && headEnd <= i) {
      headEnd = i + 1;
      break;
    }
  }

  const tailStart = Math.max(headEnd, messages.length - keepRecentCount);
  if (tailStart <= headEnd) {
    // Not enough messages to summarize
    return { messages, summarized: false, cost_usd: 0 };
  }

  // Middle section to summarize
  const middle = messages.slice(headEnd, tailStart);
  if (middle.length < 3) {
    return { messages, summarized: false, cost_usd: 0 };
  }

  // Build summary prompt
  const middleText = middle
    .map((m) => `[${m.role}]: ${(m.content || "").slice(0, 500)}`)
    .join("\n");

  try {
    const summaryResponse = await callLLM(env, [
      {
        role: "system",
        content: "Summarize the following conversation excerpt in 2-3 concise sentences. " +
          "Focus on key decisions, tool results, and current state. Be factual.",
      },
      { role: "user", content: middleText.slice(0, 8000) },
    ], [], {
      model: opts.model || "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      provider: opts.provider || "workers-ai",
      max_tokens: 300,
      temperature: 0,
    });

    const summary = summaryResponse.content || "(conversation history)";

    // Reconstruct: head + summary + tail
    const head = messages.slice(0, headEnd);
    const tail = messages.slice(tailStart);
    const summaryMsg: LLMMessage = {
      role: "system",
      content: `[Conversation summary — ${middle.length} messages condensed]\n${summary}`,
    };

    return {
      messages: [...head, summaryMsg, ...tail],
      summarized: true,
      cost_usd: summaryResponse.cost_usd || 0,
    };
  } catch {
    // Summarization failed — return original messages
    return { messages, summarized: false, cost_usd: 0 };
  }
}

// ── Helpers ───────────────────────────────────────────────────

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}
