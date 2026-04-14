/**
 * AgentOS Channels Worker — Chat Platform Webhook Router
 *
 * Composable building block: receives webhooks from Telegram, WhatsApp,
 * Slack, Instagram, and Facebook Messenger, then delegates agent execution
 * to the Agent Core worker via service binding.
 *
 * Phase 1 (current): Thin proxy — forwards raw requests to Agent Core
 * which still contains the full handler logic. This lets us deploy and
 * route independently while progressively moving handler logic here.
 *
 * Phase 2 (next): Move platform-specific parsing, verification, and
 * response formatting into this worker. Agent Core only receives
 * normalized { agent_name, input, channel, channel_user_id } payloads.
 */

export interface Env {
  // Service binding to the agent core (runtime) worker
  AGENT_CORE: Fetcher;
  // Hyperdrive for bot token + agent config lookups
  HYPERDRIVE: Hyperdrive;
  // KV for message deduplication
  DEDUP_KV: KVNamespace;
  // AI for voice/audio transcription (Whisper STT)
  AI: Ai;
  // Platform secrets
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_AGENT_NAME?: string;
  WHATSAPP_APP_SECRET?: string;
  WHATSAPP_VERIFY_TOKEN?: string;
  SLACK_SIGNING_SECRET?: string;
  INSTAGRAM_APP_SECRET?: string;
  INSTAGRAM_VERIFY_TOKEN?: string;
  FACEBOOK_APP_SECRET?: string;
  FACEBOOK_VERIFY_TOKEN?: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === "/health") {
      return Response.json({ status: "ok", service: "channels" });
    }

    // ── Route all /chat/* paths to Agent Core via service binding ──
    // Phase 1: transparent proxy. The Agent Core still has the full
    // webhook handler logic. We just forward the raw request.
    // Phase 2: we'll move the handler logic HERE and send only
    // normalized payloads to Agent Core.
    if (url.pathname.startsWith("/chat/") || url.pathname.startsWith("/api/v1/chat/")) {
      // Forward the request to Agent Core, preserving method, headers, body.
      // Service bindings are zero-latency (same-thread, no network hop).
      const coreRequest = new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.method !== "GET" ? request.body : undefined,
      });
      return env.AGENT_CORE.fetch(coreRequest);
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
