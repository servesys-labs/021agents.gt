/**
 * Slack Channel — Events API webhook handler.
 *
 * Supports: text messages, app mentions, slash commands.
 * Slack signature verification (v0 HMAC-SHA256).
 * Threaded replies for multi-turn conversations.
 */

import { type ChannelMessage, runAgent, chunkMessage } from "./adapter";

interface SlackEnv {
  AGENT_CORE: Fetcher;
  SLACK_SIGNING_SECRET?: string;
  SLACK_BOT_TOKEN?: string;
}

export async function handleSlack(
  request: Request,
  env: SlackEnv,
  agentName: string,
  orgId: string,
  ctx: ExecutionContext,
): Promise<Response> {
  const rawBody = await request.text();

  // Slack signature verification
  if (env.SLACK_SIGNING_SECRET) {
    const timestamp = request.headers.get("x-slack-request-timestamp") || "0";
    const slackSig = request.headers.get("x-slack-signature") || "";
    const baseString = `v0:${timestamp}:${rawBody}`;
    const key = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(env.SLACK_SIGNING_SECRET),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
    );
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(baseString));
    const computed = "v0=" + [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
    if (computed !== slackSig) {
      return Response.json({ error: "Invalid signature" }, { status: 401 });
    }
  }

  const body = JSON.parse(rawBody);

  // URL verification challenge
  if (body.type === "url_verification") {
    return Response.json({ challenge: body.challenge });
  }

  // Event callback
  if (body.type === "event_callback") {
    const event = body.event;
    if (!event) return Response.json({ ok: true });

    // Skip bot messages to prevent loops
    if (event.bot_id || event.subtype === "bot_message") return Response.json({ ok: true });

    const text = event.text || "";
    const userId = event.user || "";
    const channel = event.channel || "";
    const threadTs = event.thread_ts || event.ts; // reply in thread

    if (!text.trim()) return Response.json({ ok: true });

    // Remove bot mention from text (@bot)
    const cleanText = text.replace(/<@[A-Z0-9]+>/g, "").trim();
    if (!cleanText) return Response.json({ ok: true });

    const botToken = env.SLACK_BOT_TOKEN || "";

    // Run agent in background
    ctx.waitUntil((async () => {
      try {
        const result = await runAgent(env.AGENT_CORE, {
          text: cleanText, channel: "slack", userId,
          orgId, agentName,
          metadata: { slack_channel: channel, thread_ts: threadTs },
        });

        // Slack has 4000 char limit for text, supports mrkdwn
        const chunks = chunkMessage(result.text, 3900);
        for (const chunk of chunks) {
          await fetch("https://slack.com/api/chat.postMessage", {
            method: "POST",
            headers: { Authorization: `Bearer ${botToken}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              channel, thread_ts: threadTs,
              text: chunk, mrkdwn: true,
            }),
          });
        }
      } catch (err) {
        console.error("[slack] Agent run failed:", err);
      }
    })());

    return Response.json({ ok: true });
  }

  return Response.json({ ok: true });
}
