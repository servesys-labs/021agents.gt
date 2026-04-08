/**
 * Unified Channel Router — routes all channels through fast-agent first,
 * escalates to the full Workflow/DO pipeline when needed.
 *
 * Replaces the scattered per-channel handler logic with a single entry point:
 * channelAgentTurn(). Each channel handler in index.ts calls this instead of
 * directly calling runViaAgent or fastAgentTurn.
 *
 * Provides callbacks for channel-specific UX during escalation:
 * - onEscalationStart: send typing indicators, interim messages, hold audio
 * - onProgress: update UI during long operations
 * - onResponse: format and deliver the final response
 */

import { fastAgentTurn, type FastAgentResult, type FastAgentOpts } from "./fast-agent";
import { getChannelConfig, isVoiceChannel, isRealtimeChannel, type ChannelId } from "./channel-prompts";

// ── Types ─────────────────────────────────────────────────────

/** The full pipeline function signature (matches runViaAgent in index.ts). */
export type FullPipelineFn = (
  env: any,
  agentName: string,
  task: string,
  opts?: {
    org_id?: string;
    project_id?: string;
    channel?: string;
    channel_user_id?: string;
    api_key_id?: string;
    delegation?: Record<string, unknown>;
    system_prompt_override?: string;
    media_urls?: string[];
    media_types?: string[];
    session_id?: string;
  },
) => Promise<{
  output: string;
  success: boolean;
  error?: string;
  turns: number;
  tool_calls: number;
  cost_usd: number;
  latency_ms: number;
  session_id: string;
  trace_id: string;
  stop_reason: string;
  [key: string]: unknown;
}>;

export interface ChannelCallbacks {
  /**
   * Called when the fast path escalates to the full pipeline.
   * Use this to send typing indicators, interim voice messages, spinners, etc.
   * @param message The interim message to show the user
   */
  onEscalationStart?: (message: string) => void | Promise<void>;

  /**
   * Called with progress updates during the full pipeline.
   * @param step Current step description
   */
  onProgress?: (step: string) => void | Promise<void>;
}

export interface ChannelTurnOpts {
  org_id: string;
  channel: string;
  channel_user_id?: string;
  session_id?: string;
  history?: Array<{ role: string; content: string }>;
  media_urls?: string[];
  media_types?: string[];
  api_key_id?: string;
}

export interface ChannelTurnResult {
  output: string;
  /** Which path handled the request. */
  path: "fast" | "full" | "fast-only";
  input_tokens: number;
  output_tokens: number;
  latency_ms: number;
  model: string;
  tool_calls: Array<{ name: string; result: string }>;
  /** Full pipeline results (only when escalated). */
  full_result?: {
    turns: number;
    tool_calls: number;
    cost_usd: number;
    session_id: string;
    trace_id: string;
  };
}

// ── Main Entry Point ──────────────────────────────────────────

/**
 * Unified channel agent turn — the single entry point for all channels.
 *
 * Flow:
 * 1. Try fast-agent first (sub-5s response)
 * 2. If fast-agent escalates → fire onEscalationStart callback → run full pipeline
 * 3. Return the final result regardless of which path handled it
 *
 * For execution_mode="full" agents, skips fast path entirely.
 * For execution_mode="fast-only" agents, never escalates.
 */
export async function channelAgentTurn(
  env: any,
  agentName: string,
  userMessage: string,
  opts: ChannelTurnOpts,
  runFullPipeline: FullPipelineFn,
  callbacks?: ChannelCallbacks,
): Promise<ChannelTurnResult> {
  const started = Date.now();
  const channel = opts.channel || "web";

  // Step 1: Try the fast path
  const fastResult = await fastAgentTurn(env, agentName, userMessage, {
    org_id: opts.org_id,
    channel,
    session_id: opts.session_id,
    history: opts.history,
  });

  // Step 2: If not escalated, return the fast result
  if (!fastResult.escalated) {
    return {
      output: fastResult.output,
      path: "fast",
      input_tokens: fastResult.input_tokens,
      output_tokens: fastResult.output_tokens,
      latency_ms: fastResult.latency_ms,
      model: fastResult.model,
      tool_calls: fastResult.tool_calls,
    };
  }

  // Step 3: Fast path escalated — notify the channel and run full pipeline

  // Fire the escalation callback (typing indicator, interim message, etc.)
  if (callbacks?.onEscalationStart) {
    try {
      await callbacks.onEscalationStart(fastResult.escalation_message);
    } catch (err) {
      console.warn(`[channel-router] onEscalationStart callback failed: ${err}`);
    }
  }

  // Run the full Workflow/DO pipeline
  try {
    const fullResult = await runFullPipeline(env, agentName, userMessage, {
      org_id: opts.org_id,
      channel,
      channel_user_id: opts.channel_user_id,
      session_id: opts.session_id,
      api_key_id: opts.api_key_id,
      media_urls: opts.media_urls,
      media_types: opts.media_types,
    });

    return {
      output: fullResult.output || "I processed your request but couldn't generate a response.",
      path: "full",
      input_tokens: fastResult.input_tokens + (fullResult as any).input_tokens_total || 0,
      output_tokens: fastResult.output_tokens + (fullResult as any).output_tokens_total || 0,
      latency_ms: Date.now() - started,
      model: fastResult.model,
      tool_calls: fastResult.tool_calls,
      full_result: {
        turns: fullResult.turns,
        tool_calls: fullResult.tool_calls,
        cost_usd: fullResult.cost_usd,
        session_id: fullResult.session_id,
        trace_id: fullResult.trace_id,
      },
    };
  } catch (err) {
    console.error(`[channel-router] Full pipeline failed: ${err}`);

    // If the fast path had partial output (e.g. from tool calls), use that
    if (fastResult.output) {
      return {
        output: fastResult.output,
        path: "fast",
        input_tokens: fastResult.input_tokens,
        output_tokens: fastResult.output_tokens,
        latency_ms: Date.now() - started,
        model: fastResult.model,
        tool_calls: fastResult.tool_calls,
      };
    }

    return {
      output: "Sorry, I encountered an issue processing your request. Please try again.",
      path: "full",
      input_tokens: fastResult.input_tokens,
      output_tokens: fastResult.output_tokens,
      latency_ms: Date.now() - started,
      model: fastResult.model,
      tool_calls: [],
    };
  }
}

// ── Channel-Specific Callback Factories ───────────────────────

/**
 * Create callbacks for a Telegram chat — sends typing action and interim message.
 */
export function telegramCallbacks(
  botToken: string,
  chatId: number | string,
): ChannelCallbacks {
  return {
    onEscalationStart: async (message: string) => {
      // Send typing indicator
      await fetch(`https://api.telegram.org/bot${botToken}/sendChatAction`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, action: "typing" }),
      }).catch(() => {});

      // Send interim message if provided
      if (message) {
        await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text: message,
          }),
        }).catch(() => {});
      }
    },
  };
}

/**
 * Create callbacks for WhatsApp — sends typing indicator.
 */
export function whatsappCallbacks(
  accessToken: string,
  phoneNumberId: string,
  recipientId: string,
): ChannelCallbacks {
  return {
    onEscalationStart: async (_message: string) => {
      // WhatsApp typing indicator via Cloud API
      await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: recipientId,
          type: "reaction",
          // Typing indicator via read receipt
        }),
      }).catch(() => {});
    },
  };
}

/**
 * Create callbacks for Slack — sends typing indicator in thread.
 */
export function slackCallbacks(
  botToken: string,
  channelId: string,
): ChannelCallbacks {
  return {
    onEscalationStart: async (_message: string) => {
      // Slack doesn't have a true typing API, but we can post a message
      // that we update later. For now, just acknowledge.
    },
  };
}

/**
 * Create callbacks for a WebSocket channel (voice test, widget).
 */
export function websocketCallbacks(
  ws: WebSocket,
): ChannelCallbacks {
  return {
    onEscalationStart: async (message: string) => {
      try {
        ws.send(JSON.stringify({
          type: "status",
          step: "escalating",
          message: message || "Processing your request...",
        }));
      } catch {}
    },
    onProgress: async (step: string) => {
      try {
        ws.send(JSON.stringify({
          type: "status",
          step: "processing",
          message: step,
        }));
      } catch {}
    },
  };
}

/**
 * Create callbacks for Instagram DMs.
 */
export function instagramCallbacks(
  pageToken: string,
  recipientId: string,
): ChannelCallbacks {
  return {
    onEscalationStart: async (_message: string) => {
      // Instagram doesn't support typing indicators via API
    },
  };
}

/**
 * Create callbacks for Facebook Messenger.
 */
export function messengerCallbacks(
  pageToken: string,
  recipientId: string,
): ChannelCallbacks {
  return {
    onEscalationStart: async (_message: string) => {
      // Send typing indicator
      await fetch(`https://graph.facebook.com/v21.0/me/messages?access_token=${pageToken}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipient: { id: recipientId },
          sender_action: "typing_on",
        }),
      }).catch(() => {});
    },
  };
}
