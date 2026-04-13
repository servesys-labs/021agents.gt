/**
 * Microsoft Teams Channel — Bot Framework webhook handler.
 *
 * Supports: text messages, mentions, adaptive cards.
 * Uses Bot Framework REST API for replies.
 */

import { type ChannelMessage, runAgent, chunkMessage } from "./adapter";

interface TeamsEnv {
  AGENT_CORE: Fetcher;
  TEAMS_APP_ID?: string;
  TEAMS_APP_SECRET?: string;
}

// Bot Framework OAuth token cache
let _tokenCache: { token: string; expiresAt: number } | null = null;

async function getBotToken(env: TeamsEnv): Promise<string> {
  if (_tokenCache && Date.now() < _tokenCache.expiresAt) return _tokenCache.token;

  const resp = await fetch("https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: env.TEAMS_APP_ID || "",
      client_secret: env.TEAMS_APP_SECRET || "",
      scope: "https://api.botframework.com/.default",
    }),
  });
  const data = await resp.json() as { access_token: string; expires_in: number };
  _tokenCache = { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
  return data.access_token;
}

export async function handleTeams(
  request: Request,
  env: TeamsEnv,
  agentName: string,
  orgId: string,
  ctx: ExecutionContext,
): Promise<Response> {
  const activity = await request.json() as any;

  // Only handle message activities
  if (activity.type !== "message") return new Response("", { status: 200 });

  const text = activity.text || "";
  const userId = activity.from?.id || "";
  const conversationId = activity.conversation?.id || "";
  const serviceUrl = activity.serviceUrl || "";
  const activityId = activity.id || "";

  // Remove @mention from text
  const cleanText = text.replace(/<at>[^<]*<\/at>/g, "").trim();
  if (!cleanText) return new Response("", { status: 200 });

  // Run agent in background
  ctx.waitUntil((async () => {
    try {
      const result = await runAgent(env.AGENT_CORE, {
        text: cleanText, channel: "msteams", userId,
        orgId, agentName,
      });

      const token = await getBotToken(env);
      const replyUrl = `${serviceUrl}/v3/conversations/${conversationId}/activities`;

      const chunks = chunkMessage(result.text, 4000);
      for (const chunk of chunks) {
        await fetch(replyUrl, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "message",
            text: chunk,
            replyToId: activityId,
          }),
        });
      }
    } catch (err) {
      console.error("[teams] Agent run failed:", err);
    }
  })());

  return new Response("", { status: 200 });
}
