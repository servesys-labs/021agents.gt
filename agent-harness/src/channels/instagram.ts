/**
 * Instagram DM Channel — Messenger Platform webhook for Instagram.
 * Same webhook format as Facebook Messenger but with Instagram-specific APIs.
 */

import { type ChannelMessage, runAgent, stripMarkdown, chunkMessage } from "./adapter";

interface InstagramEnv {
  AGENT_CORE: Fetcher;
  INSTAGRAM_APP_SECRET?: string;
  INSTAGRAM_VERIFY_TOKEN?: string;
  INSTAGRAM_ACCESS_TOKEN?: string;
}

export function handleInstagramVerify(request: Request, env: InstagramEnv): Response {
  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");
  if (mode === "subscribe" && token === env.INSTAGRAM_VERIFY_TOKEN) {
    return new Response(challenge, { status: 200 });
  }
  return new Response("Forbidden", { status: 403 });
}

export async function handleInstagram(
  request: Request,
  env: InstagramEnv,
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
  const accessToken = env.INSTAGRAM_ACCESS_TOKEN || "";

  ctx.waitUntil((async () => {
    try {
      const result = await runAgent(env.AGENT_CORE, {
        text, channel: "instagram", userId: senderId, orgId, agentName,
      });
      const plain = stripMarkdown(result.text);
      const chunks = chunkMessage(plain, 1000); // Instagram DM limit
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
    } catch (err) { console.error("[instagram] Agent run failed:", err); }
  })());

  return Response.json({ ok: true });
}
