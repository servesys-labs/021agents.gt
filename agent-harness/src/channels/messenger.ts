/**
 * Facebook Messenger Channel — Messenger Platform webhook.
 */

import { type ChannelMessage, runAgent, stripMarkdown, chunkMessage } from "./adapter";

interface MessengerEnv {
  AGENT_CORE: Fetcher;
  FACEBOOK_APP_SECRET?: string;
  FACEBOOK_VERIFY_TOKEN?: string;
  FACEBOOK_ACCESS_TOKEN?: string;
}

export function handleMessengerVerify(request: Request, env: MessengerEnv): Response {
  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");
  if (mode === "subscribe" && token === env.FACEBOOK_VERIFY_TOKEN) {
    return new Response(challenge, { status: 200 });
  }
  return new Response("Forbidden", { status: 403 });
}

export async function handleMessenger(
  request: Request,
  env: MessengerEnv,
  agentName: string,
  orgId: string,
  ctx: ExecutionContext,
): Promise<Response> {
  const body = await request.json() as any;
  const entry = body.entry?.[0];
  const messaging = entry?.messaging?.[0];
  if (!messaging?.message?.text) return Response.json({ ok: true });

  const senderId = messaging.sender?.id || "";
  const text = messaging.message.text;
  const accessToken = env.FACEBOOK_ACCESS_TOKEN || "";

  ctx.waitUntil((async () => {
    try {
      const result = await runAgent(env.AGENT_CORE, {
        text, channel: "messenger", userId: senderId, orgId, agentName,
      });
      const plain = stripMarkdown(result.text);
      const chunks = chunkMessage(plain, 2000);
      for (const chunk of chunks) {
        await fetch(`https://graph.facebook.com/v19.0/me/messages?access_token=${accessToken}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            recipient: { id: senderId },
            message: { text: chunk },
          }),
        });
      }
    } catch (err) { console.error("[messenger] Agent run failed:", err); }
  })());

  return Response.json({ ok: true });
}
