/**
 * Channel Adapter — unified interface for all agent channels.
 *
 * Every channel (widget, API, Telegram, WhatsApp, Slack, email, voice)
 * implements this same pattern:
 *
 * 1. Receive platform-specific message (webhook, HTTP, WebSocket)
 * 2. Convert to ChannelMessage (standard format)
 * 3. Call runAgent() → routes to the Think DO
 * 4. Convert response back to platform-specific format
 * 5. Send reply via platform API
 *
 * The agent doesn't know which channel it's talking through.
 * Same brain, same tools, same memory, same skills.
 */

// ── Standard message format (channel-agnostic) ─────────────────────

export interface ChannelMessage {
  text: string;
  channel: string;           // "telegram" | "whatsapp" | "slack" | "email" | etc.
  userId: string;            // platform-specific user ID
  orgId: string;             // tenant org ID
  agentName: string;         // which agent to route to
  mediaUrls?: string[];      // attached images, audio, documents
  mediaTypes?: string[];     // MIME types for each media
  replyTo?: string;          // for threading (email In-Reply-To, Slack thread_ts)
  metadata?: Record<string, unknown>; // channel-specific extras
}

export interface ChannelResponse {
  text: string;
  mediaUrls?: string[];      // generated images, files
  metadata?: Record<string, unknown>;
}

// ── Agent runner: calls the Think DO via fetch ─────────────────────

export async function runAgent(
  agentCore: Fetcher,
  msg: ChannelMessage,
): Promise<ChannelResponse> {
  const doName = `${msg.orgId}-${msg.agentName}-u-${msg.userId}`.slice(0, 63);

  const resp = await agentCore.fetch(
    new Request(`http://internal/agents/ChatAgent/${doName}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "cf_agent_use_chat_request",
        messages: [{ role: "user", content: msg.text }],
        channel: msg.channel,
        channel_user_id: msg.userId,
        ...(msg.mediaUrls?.length ? { media_urls: msg.mediaUrls, media_types: msg.mediaTypes } : {}),
      }),
    }),
  );

  if (!resp.ok) {
    const errText = await resp.text().catch(() => resp.statusText);
    return { text: "Sorry, I couldn't process that. Please try again." };
  }

  // For non-streaming channels: collect the full response
  const result = await resp.json() as Record<string, unknown>;
  const output = String(result.output || result.text || result.content || "I didn't generate a response.");

  return { text: output };
}

// ── Markdown stripping for plain-text channels ─────────────────────

export function stripMarkdown(text: string): string {
  return text
    .replace(/#{1,6}\s*/g, "")              // headers
    .replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1") // bold/italic
    .replace(/`{1,3}[^`]*`{1,3}/g, "")      // code blocks
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // links → text only
    .replace(/^[-*•]\s*/gm, "")              // list bullets
    .trim();
}

// ── Message chunking for platforms with size limits ─────────────────

export function chunkMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) { chunks.push(remaining); break; }
    // Find natural break: paragraph > newline > space
    let splitAt = maxLen - 20;
    const dnl = remaining.lastIndexOf("\n\n", splitAt);
    if (dnl > maxLen * 0.3) splitAt = dnl + 1;
    else {
      const nl = remaining.lastIndexOf("\n", splitAt);
      if (nl > maxLen * 0.3) splitAt = nl + 1;
      else {
        const sp = remaining.lastIndexOf(" ", splitAt);
        if (sp > maxLen * 0.3) splitAt = sp + 1;
      }
    }
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }
  return chunks;
}
