/**
 * Channel Router — registers all channel webhook handlers.
 *
 * Called from the main server.ts fetch handler.
 * Each channel is a separate file that implements the ChannelAdapter pattern.
 *
 * To add a new channel:
 * 1. Create channels/{name}.ts implementing the handler
 * 2. Add the route here
 * 3. Add secrets to wrangler.jsonc
 *
 * All channels share the same runAgent() → Think DO interface.
 */

import { handleTelegram } from "./telegram";
import { handleWhatsApp, handleWhatsAppVerify } from "./whatsapp";
import { handleSlack } from "./slack";
import { handleTeams } from "./msteams";
import { handleInstagram, handleInstagramVerify } from "./instagram";
import { handleMessenger, handleMessengerVerify } from "./messenger";
import { handleInboundEmail } from "./email";

interface ChannelEnv {
  AI: Ai;
  AGENT_CORE: Fetcher;
  CACHE: KVNamespace;
  // Platform secrets
  TELEGRAM_BOT_TOKEN?: string;
  WHATSAPP_APP_SECRET?: string;
  WHATSAPP_VERIFY_TOKEN?: string;
  WHATSAPP_ACCESS_TOKEN?: string;
  SLACK_SIGNING_SECRET?: string;
  SLACK_BOT_TOKEN?: string;
  TEAMS_APP_ID?: string;
  TEAMS_APP_SECRET?: string;
  INSTAGRAM_APP_SECRET?: string;
  INSTAGRAM_VERIFY_TOKEN?: string;
  INSTAGRAM_ACCESS_TOKEN?: string;
  FACEBOOK_APP_SECRET?: string;
  FACEBOOK_VERIFY_TOKEN?: string;
  FACEBOOK_ACCESS_TOKEN?: string;
}

/**
 * Route a /chat/* request to the correct channel handler.
 * Returns null if the path doesn't match any channel.
 *
 * URL pattern: /chat/{platform}/{agentName}/webhook
 * Or:          /chat/{platform}/webhook (uses default agent)
 */
export async function routeChannel(
  request: Request,
  env: ChannelEnv,
  ctx: ExecutionContext,
  orgId: string,
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;

  // ── Telegram ──
  const tgMatch = path.match(/^\/chat\/telegram(?:\/([a-zA-Z0-9_-]+))?\/webhook$/);
  if (tgMatch && request.method === "POST") {
    const agentName = tgMatch[1] || "default";
    const botToken = env.TELEGRAM_BOT_TOKEN || "";
    if (!botToken) return Response.json({ error: "Telegram bot token not configured" }, { status: 503 });
    return handleTelegram(request, env, botToken, agentName, orgId, ctx);
  }

  // ── WhatsApp ──
  if (path.match(/^\/chat\/whatsapp\/webhook$/) || path.match(/^\/chat\/whatsapp\/([a-zA-Z0-9_-]+)\/webhook$/)) {
    const agentName = path.match(/\/chat\/whatsapp\/([a-zA-Z0-9_-]+)\/webhook$/)?.[1] || "default";
    if (request.method === "GET") return handleWhatsAppVerify(request, env);
    return handleWhatsApp(request, env, agentName, orgId, ctx);
  }

  // ── Slack ──
  if (path.match(/^\/chat\/slack\/webhook$/) || path.match(/^\/chat\/slack\/([a-zA-Z0-9_-]+)\/webhook$/)) {
    const agentName = path.match(/\/chat\/slack\/([a-zA-Z0-9_-]+)\/webhook$/)?.[1] || "default";
    return handleSlack(request, env, agentName, orgId, ctx);
  }

  // ── MS Teams ──
  if (path.match(/^\/chat\/teams\/webhook$/) || path.match(/^\/chat\/teams\/([a-zA-Z0-9_-]+)\/webhook$/)) {
    const agentName = path.match(/\/chat\/teams\/([a-zA-Z0-9_-]+)\/webhook$/)?.[1] || "default";
    return handleTeams(request, env, agentName, orgId, ctx);
  }

  // ── Instagram ──
  if (path.match(/^\/chat\/instagram\/webhook$/)) {
    if (request.method === "GET") return handleInstagramVerify(request, env);
    return handleInstagram(request, env, "default", orgId, ctx);
  }

  // ── Facebook Messenger ──
  if (path.match(/^\/chat\/messenger\/webhook$/)) {
    if (request.method === "GET") return handleMessengerVerify(request, env);
    return handleMessenger(request, env, "default", orgId, ctx);
  }

  return null; // no channel matched
}

// Re-export email handler for the Worker email() export
export { handleInboundEmail };
