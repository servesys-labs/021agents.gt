/**
 * Chat platforms router — Telegram, WhatsApp, Slack, Instagram, Facebook Messenger.
 * Each platform follows the same pattern:
 *   1. connect endpoint (stores token/credentials)
 *   2. webhook endpoint (receives messages, invokes agent via RUNTIME)
 *   3. optional verify endpoint (platform handshake)
 */
import { createRoute, z } from "@hono/zod-openapi";
import { createOpenAPIRouter } from "../lib/openapi";
import { ErrorSchema, errorResponses } from "../schemas/openapi";
import { getDb, getDbForOrg } from "../db/client";
import { requireScope } from "../middleware/auth";

export const chatPlatformRoutes = createOpenAPIRouter();

// ── Helpers ──────────────────────────────────────────────────────────────

/** Get a secret by name for an org. */
async function getSecret(sql: any, name: string, orgId?: string): Promise<string> {
  try {
    const rows = orgId
      ? await sql`SELECT value_encrypted FROM secrets WHERE name = ${name} AND org_id = ${orgId} ORDER BY created_at DESC LIMIT 1`
      : await sql`SELECT value_encrypted FROM secrets WHERE name = ${name} ORDER BY created_at DESC LIMIT 1`;
    if (rows.length > 0 && rows[0].value_encrypted) return String(rows[0].value_encrypted);
  } catch {}
  return "";
}

/** Store a secret (upsert). */
async function storeSecret(sql: any, name: string, value: string, orgId: string): Promise<void> {
  const now = new Date().toISOString();
  await sql`
    INSERT INTO secrets (name, value_encrypted, org_id, created_at, updated_at)
    VALUES (${name}, ${value}, ${orgId}, ${now}, ${now})
    ON CONFLICT (org_id, name, project_id, env) DO UPDATE SET value_encrypted = EXCLUDED.value_encrypted, updated_at = EXCLUDED.updated_at
  `;
}

/** Resolve agent name for a channel in an org. Falls back to channel-specific agent or org default. */
async function resolveChannelAgent(sql: any, orgId: string, channel: string): Promise<string> {
  // Check channel_configs for an explicit agent_name
  try {
    const rows = await sql`
      SELECT agent_name FROM channel_configs
      WHERE org_id = ${orgId} AND channel = ${channel} AND is_active = true
      LIMIT 1
    `;
    if (rows.length > 0 && rows[0].agent_name) return String(rows[0].agent_name);
  } catch {}
  // Fallback: first active agent in the org
  try {
    const rows = await sql`
      SELECT name FROM agents WHERE org_id = ${orgId} AND is_active = 1 ORDER BY created_at ASC LIMIT 1
    `;
    if (rows.length > 0) return String(rows[0].name);
  } catch {}
  return channel + "-bot";
}

/** Invoke agent via RUNTIME service binding and return the text output. */
async function invokeAgent(
  env: any,
  agentName: string,
  input: string,
  channel: string,
  channelUserId: string,
  orgId?: string,
): Promise<string> {
  try {
    const resp = await env.RUNTIME.fetch("https://runtime/api/v1/runtime-proxy/runnable/invoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_name: agentName,
        input,
        channel,
        channel_user_id: channelUserId,
        org_id: orgId,
        wait: true,
      }),
    });
    const data = await resp.json() as any;
    return typeof data.output === "string" ? data.output : String(data.output || "");
  } catch (e: any) {
    return `Sorry, I encountered an error: ${String(e.message).slice(0, 200)}`;
  }
}

/** HMAC-SHA256 verification for Meta platforms (WhatsApp, Instagram, Messenger). */
async function verifyMetaSignature(appSecret: string, rawBody: ArrayBuffer, signature: string): Promise<boolean> {
  if (!appSecret || !signature) return !appSecret; // skip verification if no secret configured
  const expected = signature.startsWith("sha256=") ? signature.slice(7) : signature;
  try {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(appSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = await crypto.subtle.sign("HMAC", key, rawBody);
    const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
    return hex === expected;
  } catch {
    return false;
  }
}

/** Slack request signature verification. */
async function verifySlackSignature(signingSecret: string, timestamp: string, body: string, signature: string): Promise<boolean> {
  if (!signingSecret) return true; // skip if not configured
  const basestring = `v0:${timestamp}:${body}`;
  try {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(signingSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(basestring));
    const hex = "v0=" + [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
    return hex === signature;
  } catch {
    return false;
  }
}

async function getTelegramToken(sql: any): Promise<string> {
  try {
    const rows = await sql`
      SELECT value_encrypted FROM secrets WHERE name = 'TELEGRAM_BOT_TOKEN' ORDER BY created_at DESC LIMIT 1
    `;
    if (rows.length > 0 && rows[0].value_encrypted) return String(rows[0].value_encrypted);
  } catch {}
  return "";
}

async function sendTelegramMessage(token: string, chatId: number, text: string, replyTo?: number) {
  const body: any = { chat_id: chatId, text };
  if (replyTo) body.reply_to_message_id = replyTo;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => {});
}

// ── POST /chat/telegram/webhook ────────────────────────────────────────

const telegramWebhookRoute = createRoute({
  method: "post",
  path: "/telegram/webhook",
  tags: ["Chat Platforms"],
  summary: "Receive Telegram webhook updates",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.record(z.unknown()),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Webhook processed",
      content: { "application/json": { schema: z.object({ ok: z.boolean() }) } },
    },
    503: { description: "Service unavailable", content: { "application/json": { schema: ErrorSchema } } },
  },
});
chatPlatformRoutes.openapi(telegramWebhookRoute, async (c): Promise<any> => {
  const sql = await getDb(c.env.HYPERDRIVE);
  const botToken = await getTelegramToken(sql);
  if (!botToken) return c.json({ error: "TELEGRAM_BOT_TOKEN not configured" }, 503);

  const payload = c.req.valid("json");
  const message = (payload as any)?.message;
  if (!message || !message.text) return c.json({ ok: true });

  const chatId = message.chat?.id;
  const text = String(message.text || "");
  const messageId = message.message_id;

  // Handle commands
  if (text.startsWith("/start")) {
    await sendTelegramMessage(botToken, chatId, "Hi! I'm your AgentOS agent. Send me a message and I'll help.");
    return c.json({ ok: true });
  }
  if (text.startsWith("/help")) {
    await sendTelegramMessage(botToken, chatId, "I can help with research, code, data analysis, and more. Just send a message.");
    return c.json({ ok: true });
  }
  if (text.startsWith("/status")) {
    await sendTelegramMessage(botToken, chatId, "Agent is running.");
    return c.json({ ok: true });
  }

  // Send typing indicator
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendChatAction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, action: "typing" }),
    });
  } catch {}

  // Invoke agent via RUNTIME service binding
  let output = "";
  try {
    const inputText = text.startsWith("/ask ") ? text.slice(5) : text;
    const resp = await c.env.RUNTIME.fetch("https://runtime/api/v1/runtime-proxy/runnable/invoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_name: "telegram-bot",
        input: inputText,
        channel: "telegram",
        channel_user_id: String(chatId),
        wait: true,
      }),
    });
    const data = await resp.json() as any;
    output = typeof data.output === "string" ? data.output : String(data.output || "");
  } catch (e: any) {
    output = `Sorry, I encountered an error: ${String(e.message).slice(0, 200)}`;
  }

  // Send reply (split long messages for Telegram 4096 char limit)
  if (output) {
    for (let i = 0; i < output.length; i += 4000) {
      const chunk = output.slice(i, i + 4000);
      await sendTelegramMessage(botToken, chatId, chunk, i === 0 ? messageId : undefined);
    }
  }

  return c.json({ ok: true });
});

// ── POST /chat/telegram/connect ────────────────────────────────────────

const telegramConnectRoute = createRoute({
  method: "post",
  path: "/telegram/connect",
  tags: ["Chat Platforms"],
  summary: "Connect a Telegram bot (one-click setup)",
  middleware: [requireScope("integrations:write")],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            bot_token: z.string().min(1),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Connection result",
      content: {
        "application/json": {
          schema: z.object({
            success: z.boolean(),
            bot_username: z.string(),
            deep_link: z.string(),
            webhook_registered: z.boolean(),
            webhook_url: z.string(),
            secret_stored: z.boolean(),
          }),
        },
      },
    },
    ...errorResponses(400),
  },
});
chatPlatformRoutes.openapi(telegramConnectRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const body = c.req.valid("json");
  const botToken = body.bot_token.trim();
  if (!botToken) return c.json({ error: "bot_token is required" }, 400);

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const now = new Date().toISOString();

  // Store in secrets
  try {
    await sql`
      INSERT INTO secrets (name, value_encrypted, org_id, created_at, updated_at)
      VALUES ('TELEGRAM_BOT_TOKEN', ${botToken}, ${user.org_id}, ${now}, ${now})
      ON CONFLICT (org_id, name, project_id, env) DO UPDATE SET value_encrypted = EXCLUDED.value_encrypted, updated_at = EXCLUDED.updated_at
    `;
  } catch {}

  // Register webhook with Telegram
  const webhookUrl = `${c.env.RUNTIME_WORKER_URL}/api/v1/chat/telegram/webhook`;
  let webhookRegistered = false;
  try {
    const resp = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: webhookUrl }),
    });
    const data = await resp.json() as any;
    webhookRegistered = Boolean(data.ok);
  } catch {}

  // Get bot info
  let botUsername = "";
  try {
    const resp = await fetch(`https://api.telegram.org/bot${botToken}/getMe`);
    const data = await resp.json() as any;
    botUsername = data.result?.username || "";
  } catch {}

  const deepLink = botUsername ? `https://t.me/${botUsername}?start=default` : "";

  return c.json({
    success: true,
    bot_username: botUsername,
    deep_link: deepLink,
    webhook_registered: webhookRegistered,
    webhook_url: webhookUrl,
    secret_stored: true,
  });
});

// ── POST /chat/telegram/setup ──────────────────────────────────────────

const telegramSetupRoute = createRoute({
  method: "post",
  path: "/telegram/setup",
  tags: ["Chat Platforms"],
  summary: "Set Telegram webhook URL manually",
  middleware: [requireScope("integrations:write")],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            webhook_url: z.string().min(1),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Setup result",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(400),
    502: { description: "Bad gateway", content: { "application/json": { schema: ErrorSchema } } },
    503: { description: "Service unavailable", content: { "application/json": { schema: ErrorSchema } } },
  },
});
chatPlatformRoutes.openapi(telegramSetupRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const body = c.req.valid("json");
  const webhookUrl = body.webhook_url.trim();
  if (!webhookUrl) return c.json({ error: "webhook_url is required" }, 400);

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const botToken = await getTelegramToken(sql);
  if (!botToken) return c.json({ error: "TELEGRAM_BOT_TOKEN not configured" }, 503);

  try {
    const resp = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: webhookUrl }),
    });
    return c.json(await resp.json());
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 502);
  }
});

// ── GET /chat/telegram/qr ──────────────────────────────────────────────

const telegramQrRoute = createRoute({
  method: "get",
  path: "/telegram/qr",
  tags: ["Chat Platforms"],
  summary: "Get Telegram bot deep link / QR data",
  middleware: [requireScope("integrations:read")],
  request: {
    query: z.object({
      agent_name: z.string().default("default").openapi({ description: "Agent name for deep link" }),
    }),
  },
  responses: {
    200: {
      description: "QR / deep link data",
      content: {
        "application/json": {
          schema: z.object({
            deep_link: z.string(),
            bot_username: z.string(),
            agent_name: z.string(),
            instructions: z.string(),
          }),
        },
      },
    },
    ...errorResponses(500),
    503: { description: "Service unavailable", content: { "application/json": { schema: ErrorSchema } } },
  },
});
chatPlatformRoutes.openapi(telegramQrRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const botToken = await getTelegramToken(sql);
  if (!botToken) return c.json({ error: "TELEGRAM_BOT_TOKEN not configured" }, 503);

  let botUsername = "";
  try {
    const resp = await fetch(`https://api.telegram.org/bot${botToken}/getMe`);
    const data = await resp.json() as any;
    botUsername = data.result?.username || "";
  } catch {}

  if (!botUsername) return c.json({ error: "Could not retrieve bot username" }, 500);

  const { agent_name: agentName } = c.req.valid("query");
  const deepLink = `https://t.me/${botUsername}?start=${agentName}`;

  return c.json({
    deep_link: deepLink,
    bot_username: botUsername,
    agent_name: agentName,
    instructions: `Open ${deepLink} to start chatting with your agent on Telegram.`,
  });
});

// ── DELETE /chat/telegram/webhook ──────────────────────────────────────

const deleteTelegramWebhookRoute = createRoute({
  method: "delete",
  path: "/telegram/webhook",
  tags: ["Chat Platforms"],
  summary: "Delete Telegram webhook",
  middleware: [requireScope("integrations:write")],
  responses: {
    200: {
      description: "Webhook deleted",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    502: { description: "Bad gateway", content: { "application/json": { schema: ErrorSchema } } },
    503: { description: "Service unavailable", content: { "application/json": { schema: ErrorSchema } } },
  },
});
chatPlatformRoutes.openapi(deleteTelegramWebhookRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const botToken = await getTelegramToken(sql);
  if (!botToken) return c.json({ error: "TELEGRAM_BOT_TOKEN not configured" }, 503);

  try {
    const resp = await fetch(`https://api.telegram.org/bot${botToken}/deleteWebhook`);
    return c.json(await resp.json());
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 502);
  }
});

// ══════════════════════════════════════════════════════════════════════════
// ██ WhatsApp Cloud API
// ══════════════════════════════════════════════════════════════════════════

// GET /chat/whatsapp/webhook — Meta verification handshake
const whatsappVerifyRoute = createRoute({
  method: "get",
  path: "/whatsapp/webhook",
  tags: ["Chat Platforms"],
  summary: "WhatsApp webhook verification (Meta handshake)",
  request: {
    query: z.object({
      "hub.mode": z.string().optional(),
      "hub.verify_token": z.string().optional(),
      "hub.challenge": z.string().optional(),
    }),
  },
  responses: {
    200: { description: "Challenge response", content: { "text/plain": { schema: z.string() } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
  },
});
chatPlatformRoutes.openapi(whatsappVerifyRoute, async (c): Promise<any> => {
  const query = c.req.valid("query");
  const mode = query["hub.mode"];
  const token = query["hub.verify_token"];
  const challenge = query["hub.challenge"];
  const expected = c.env.WHATSAPP_VERIFY_TOKEN || "agentos-whatsapp-verify";
  if (mode === "subscribe" && token === expected) {
    return new Response(challenge || "", { status: 200, headers: { "Content-Type": "text/plain" } });
  }
  return c.json({ error: "Verification failed" }, 403);
});

// POST /chat/whatsapp/webhook — Receive WhatsApp messages
const whatsappWebhookRoute = createRoute({
  method: "post",
  path: "/whatsapp/webhook",
  tags: ["Chat Platforms"],
  summary: "Receive WhatsApp Cloud API webhook events",
  request: { body: { content: { "application/json": { schema: z.record(z.unknown()) } } } },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: z.object({ ok: z.boolean() }) } } },
    ...errorResponses(401),
  },
});
chatPlatformRoutes.openapi(whatsappWebhookRoute, async (c): Promise<any> => {
  // Signature verification
  const rawBody = await c.req.arrayBuffer();
  const sig = c.req.header("x-hub-signature-256") ?? "";
  const appSecret = c.env.WHATSAPP_APP_SECRET ?? "";
  if (appSecret && !(await verifyMetaSignature(appSecret, rawBody, sig))) {
    return c.json({ error: "Invalid signature" }, 401);
  }

  let payload: any;
  try {
    payload = JSON.parse(new TextDecoder().decode(rawBody));
  } catch {
    return c.json({ ok: true });
  }

  // WhatsApp Cloud API sends: { object: "whatsapp_business_account", entry: [...] }
  if (payload.object !== "whatsapp_business_account") return c.json({ ok: true });

  const sql = await getDb(c.env.HYPERDRIVE);

  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      if (change.field !== "messages") continue;
      const value = change.value || {};
      const phoneNumberId = value.metadata?.phone_number_id || "";
      const messages = value.messages || [];

      for (const msg of messages) {
        if (msg.type !== "text" || !msg.text?.body) continue;
        const from = String(msg.from || "");
        const text = String(msg.text.body);

        // Resolve org from phone_number_id stored in channel_configs
        let orgId = "";
        try {
          const rows = await sql`
            SELECT org_id FROM channel_configs
            WHERE channel = 'whatsapp' AND config->>'phone_number_id' = ${phoneNumberId} AND is_active = true
            LIMIT 1
          `;
          if (rows.length > 0) orgId = String(rows[0].org_id);
        } catch {}

        if (!orgId) continue;

        const agentName = await resolveChannelAgent(sql, orgId, "whatsapp");
        const output = await invokeAgent(c.env, agentName, text, "whatsapp", from, orgId);

        // Reply via WhatsApp Cloud API
        const waToken = await getSecret(sql, "WHATSAPP_ACCESS_TOKEN", orgId);
        if (waToken && phoneNumberId && output) {
          try {
            await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
              method: "POST",
              headers: { Authorization: `Bearer ${waToken}`, "Content-Type": "application/json" },
              body: JSON.stringify({
                messaging_product: "whatsapp",
                to: from,
                type: "text",
                text: { body: output.slice(0, 4096) },
              }),
            });
          } catch {}
        }
      }
    }
  }

  return c.json({ ok: true });
});

// POST /chat/whatsapp/connect — Store WhatsApp credentials
const whatsappConnectRoute = createRoute({
  method: "post",
  path: "/whatsapp/connect",
  tags: ["Chat Platforms"],
  summary: "Connect WhatsApp Business (Cloud API)",
  middleware: [requireScope("integrations:write")],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            access_token: z.string().min(1),
            phone_number_id: z.string().min(1),
            business_account_id: z.string().default(""),
            agent_name: z.string().default(""),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Connected", content: { "application/json": { schema: z.object({ ok: z.boolean(), phone_number_id: z.string(), webhook_url: z.string() }) } } },
    ...errorResponses(400),
  },
});
chatPlatformRoutes.openapi(whatsappConnectRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const body = c.req.valid("json");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  // Store access token
  await storeSecret(sql, "WHATSAPP_ACCESS_TOKEN", body.access_token, user.org_id);

  // Upsert channel config
  const now = new Date().toISOString();
  const config = JSON.stringify({
    phone_number_id: body.phone_number_id,
    business_account_id: body.business_account_id,
  });
  await sql`
    INSERT INTO channel_configs (org_id, channel, agent_name, config, is_active, created_at, updated_at)
    VALUES (${user.org_id}, 'whatsapp', ${body.agent_name || ""}, ${config}::jsonb, true, ${now}, ${now})
    ON CONFLICT (org_id, channel) DO UPDATE
    SET config = ${config}::jsonb, agent_name = COALESCE(NULLIF(${body.agent_name}, ''), channel_configs.agent_name),
        is_active = true, updated_at = ${now}
  `;

  const webhookUrl = `${c.env.RUNTIME_WORKER_URL}/api/v1/chat/whatsapp/webhook`;

  return c.json({ ok: true, phone_number_id: body.phone_number_id, webhook_url: webhookUrl });
});

// ══════════════════════════════════════════════════════════════════════════
// ██ Slack (Events API + OAuth)
// ══════════════════════════════════════════════════════════════════════════

// POST /chat/slack/webhook — Slack Events API
const slackWebhookRoute = createRoute({
  method: "post",
  path: "/slack/webhook",
  tags: ["Chat Platforms"],
  summary: "Receive Slack Events API events (messages, app_mentions)",
  request: { body: { content: { "application/json": { schema: z.record(z.unknown()) } } } },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(401),
  },
});
chatPlatformRoutes.openapi(slackWebhookRoute, async (c): Promise<any> => {
  const rawBody = await c.req.text();

  // Signature verification
  const signingSecret = c.env.SLACK_SIGNING_SECRET ?? "";
  const timestamp = c.req.header("x-slack-request-timestamp") ?? "";
  const slackSig = c.req.header("x-slack-signature") ?? "";
  if (signingSecret && !(await verifySlackSignature(signingSecret, timestamp, rawBody, slackSig))) {
    return c.json({ error: "Invalid signature" }, 401);
  }

  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return c.json({ ok: true });
  }

  // Slack URL verification challenge
  if (payload.type === "url_verification") {
    return c.json({ challenge: payload.challenge });
  }

  // Event callback
  if (payload.type !== "event_callback") return c.json({ ok: true });

  const event = payload.event;
  if (!event) return c.json({ ok: true });

  // Only respond to messages (not bot messages) and app_mentions
  const isMessage = event.type === "message" && !event.bot_id && !event.subtype && event.text;
  const isMention = event.type === "app_mention" && event.text;
  if (!isMessage && !isMention) return c.json({ ok: true });

  const text = String(event.text || "").replace(/<@[A-Z0-9]+>/g, "").trim();
  if (!text) return c.json({ ok: true });

  const channelId = event.channel || "";
  const userId = event.user || "";
  const teamId = payload.team_id || "";

  // Resolve org from team_id
  const sql = await getDb(c.env.HYPERDRIVE);
  let orgId = "";
  try {
    const rows = await sql`
      SELECT org_id FROM channel_configs
      WHERE channel = 'slack' AND config->>'team_id' = ${teamId} AND is_active = true
      LIMIT 1
    `;
    if (rows.length > 0) orgId = String(rows[0].org_id);
  } catch {}

  if (!orgId) return c.json({ ok: true });

  const agentName = await resolveChannelAgent(sql, orgId, "slack");
  const output = await invokeAgent(c.env, agentName, text, "slack", userId, orgId);

  // Reply via Slack Web API
  const botToken = await getSecret(sql, "SLACK_BOT_TOKEN", orgId);
  if (botToken && channelId && output) {
    try {
      await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: { Authorization: `Bearer ${botToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          channel: channelId,
          text: output.slice(0, 3000),
          ...(event.ts && isMessage ? { thread_ts: event.ts } : {}),
        }),
      });
    } catch {}
  }

  return c.json({ ok: true });
});

// POST /chat/slack/connect — Store Slack credentials
const slackConnectRoute = createRoute({
  method: "post",
  path: "/slack/connect",
  tags: ["Chat Platforms"],
  summary: "Connect Slack workspace",
  middleware: [requireScope("integrations:write")],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            bot_token: z.string().min(1),
            team_id: z.string().min(1),
            team_name: z.string().default(""),
            agent_name: z.string().default(""),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Connected", content: { "application/json": { schema: z.object({ ok: z.boolean(), team_id: z.string(), webhook_url: z.string() }) } } },
    ...errorResponses(400),
  },
});
chatPlatformRoutes.openapi(slackConnectRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const body = c.req.valid("json");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  await storeSecret(sql, "SLACK_BOT_TOKEN", body.bot_token, user.org_id);

  const now = new Date().toISOString();
  const config = JSON.stringify({ team_id: body.team_id, team_name: body.team_name });
  await sql`
    INSERT INTO channel_configs (org_id, channel, agent_name, config, is_active, created_at, updated_at)
    VALUES (${user.org_id}, 'slack', ${body.agent_name || ""}, ${config}::jsonb, true, ${now}, ${now})
    ON CONFLICT (org_id, channel) DO UPDATE
    SET config = ${config}::jsonb, agent_name = COALESCE(NULLIF(${body.agent_name}, ''), channel_configs.agent_name),
        is_active = true, updated_at = ${now}
  `;

  const webhookUrl = `${c.env.RUNTIME_WORKER_URL}/api/v1/chat/slack/webhook`;
  return c.json({ ok: true, team_id: body.team_id, webhook_url: webhookUrl });
});

// GET /chat/slack/oauth — Slack OAuth callback
const slackOAuthRoute = createRoute({
  method: "get",
  path: "/slack/oauth",
  tags: ["Chat Platforms"],
  summary: "Slack OAuth callback — exchanges code for bot token",
  request: {
    query: z.object({
      code: z.string().min(1),
      state: z.string().default(""),
    }),
  },
  responses: {
    200: { description: "OAuth result", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(400),
  },
});
chatPlatformRoutes.openapi(slackOAuthRoute, async (c): Promise<any> => {
  const { code, state } = c.req.valid("query");
  const clientId = c.env.SLACK_CLIENT_ID ?? "";
  const clientSecret = c.env.SLACK_CLIENT_SECRET ?? "";
  if (!clientId || !clientSecret) return c.json({ error: "Slack OAuth not configured" }, 400);

  // Exchange code for token
  const resp = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret }),
  });
  const data = await resp.json() as any;
  if (!data.ok) return c.json({ error: data.error || "Slack OAuth failed" }, 400);

  const botToken = data.access_token || "";
  const teamId = data.team?.id || "";
  const teamName = data.team?.name || "";

  // If state contains orgId, save automatically
  if (state && botToken && teamId) {
    const sql = await getDb(c.env.HYPERDRIVE);
    try {
      await storeSecret(sql, "SLACK_BOT_TOKEN", botToken, state);
      const now = new Date().toISOString();
      const config = JSON.stringify({ team_id: teamId, team_name: teamName });
      await sql`
        INSERT INTO channel_configs (org_id, channel, agent_name, config, is_active, created_at, updated_at)
        VALUES (${state}, 'slack', '', ${config}::jsonb, true, ${now}, ${now})
        ON CONFLICT (org_id, channel) DO UPDATE
        SET config = ${config}::jsonb, is_active = true, updated_at = ${now}
      `;
    } catch {}
  }

  return c.json({
    ok: true,
    team_id: teamId,
    team_name: teamName,
    bot_user_id: data.bot_user_id || "",
    scope: data.scope || "",
  });
});

// ══════════════════════════════════════════════════════════════════════════
// ██ Instagram DMs (via Facebook Graph API / Messenger Platform)
// ══════════════════════════════════════════════════════════════════════════

// GET /chat/instagram/webhook — Meta verification handshake
const instagramVerifyRoute = createRoute({
  method: "get",
  path: "/instagram/webhook",
  tags: ["Chat Platforms"],
  summary: "Instagram webhook verification (Meta handshake)",
  request: {
    query: z.object({
      "hub.mode": z.string().optional(),
      "hub.verify_token": z.string().optional(),
      "hub.challenge": z.string().optional(),
    }),
  },
  responses: {
    200: { description: "Challenge response", content: { "text/plain": { schema: z.string() } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
  },
});
chatPlatformRoutes.openapi(instagramVerifyRoute, async (c): Promise<any> => {
  const query = c.req.valid("query");
  const expected = c.env.INSTAGRAM_VERIFY_TOKEN || c.env.FACEBOOK_VERIFY_TOKEN || "agentos-meta-verify";
  if (query["hub.mode"] === "subscribe" && query["hub.verify_token"] === expected) {
    return new Response(query["hub.challenge"] || "", { status: 200, headers: { "Content-Type": "text/plain" } });
  }
  return c.json({ error: "Verification failed" }, 403);
});

// POST /chat/instagram/webhook — Receive Instagram DM events
const instagramWebhookRoute = createRoute({
  method: "post",
  path: "/instagram/webhook",
  tags: ["Chat Platforms"],
  summary: "Receive Instagram DM webhook events",
  request: { body: { content: { "application/json": { schema: z.record(z.unknown()) } } } },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: z.object({ ok: z.boolean() }) } } },
    ...errorResponses(401),
  },
});
chatPlatformRoutes.openapi(instagramWebhookRoute, async (c): Promise<any> => {
  const rawBody = await c.req.arrayBuffer();
  const sig = c.req.header("x-hub-signature-256") ?? "";
  const appSecret = c.env.INSTAGRAM_APP_SECRET ?? c.env.FACEBOOK_APP_SECRET ?? "";
  if (appSecret && !(await verifyMetaSignature(appSecret, rawBody, sig))) {
    return c.json({ error: "Invalid signature" }, 401);
  }

  let payload: any;
  try {
    payload = JSON.parse(new TextDecoder().decode(rawBody));
  } catch {
    return c.json({ ok: true });
  }

  if (payload.object !== "instagram") return c.json({ ok: true });

  const sql = await getDb(c.env.HYPERDRIVE);

  for (const entry of payload.entry || []) {
    const igUserId = entry.id || "";
    for (const messaging of entry.messaging || []) {
      const senderId = messaging.sender?.id || "";
      const recipientId = messaging.recipient?.id || "";
      const msgText = messaging.message?.text || "";
      if (!msgText || !senderId || senderId === recipientId) continue;

      // Resolve org from IG page/user ID
      let orgId = "";
      try {
        const rows = await sql`
          SELECT org_id FROM channel_configs
          WHERE channel = 'instagram' AND (config->>'page_id' = ${igUserId} OR config->>'ig_user_id' = ${recipientId})
                AND is_active = true
          LIMIT 1
        `;
        if (rows.length > 0) orgId = String(rows[0].org_id);
      } catch {}

      if (!orgId) continue;

      const agentName = await resolveChannelAgent(sql, orgId, "instagram");
      const output = await invokeAgent(c.env, agentName, msgText, "instagram", senderId, orgId);

      // Reply via Instagram Messaging API
      const pageToken = await getSecret(sql, "INSTAGRAM_PAGE_TOKEN", orgId);
      if (pageToken && output) {
        try {
          await fetch(`https://graph.facebook.com/v21.0/${recipientId}/messages`, {
            method: "POST",
            headers: { Authorization: `Bearer ${pageToken}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              recipient: { id: senderId },
              message: { text: output.slice(0, 1000) },
            }),
          });
        } catch {}
      }
    }
  }

  return c.json({ ok: true });
});

// POST /chat/instagram/connect — Store Instagram credentials
const instagramConnectRoute = createRoute({
  method: "post",
  path: "/instagram/connect",
  tags: ["Chat Platforms"],
  summary: "Connect Instagram Business account",
  middleware: [requireScope("integrations:write")],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            page_token: z.string().min(1),
            page_id: z.string().min(1),
            ig_user_id: z.string().default(""),
            ig_username: z.string().default(""),
            agent_name: z.string().default(""),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Connected", content: { "application/json": { schema: z.object({ ok: z.boolean(), webhook_url: z.string() }) } } },
    ...errorResponses(400),
  },
});
chatPlatformRoutes.openapi(instagramConnectRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const body = c.req.valid("json");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  await storeSecret(sql, "INSTAGRAM_PAGE_TOKEN", body.page_token, user.org_id);

  const now = new Date().toISOString();
  const config = JSON.stringify({
    page_id: body.page_id,
    ig_user_id: body.ig_user_id,
    ig_username: body.ig_username,
  });
  await sql`
    INSERT INTO channel_configs (org_id, channel, agent_name, config, is_active, created_at, updated_at)
    VALUES (${user.org_id}, 'instagram', ${body.agent_name || ""}, ${config}::jsonb, true, ${now}, ${now})
    ON CONFLICT (org_id, channel) DO UPDATE
    SET config = ${config}::jsonb, agent_name = COALESCE(NULLIF(${body.agent_name}, ''), channel_configs.agent_name),
        is_active = true, updated_at = ${now}
  `;

  const webhookUrl = `${c.env.RUNTIME_WORKER_URL}/api/v1/chat/instagram/webhook`;
  return c.json({ ok: true, webhook_url: webhookUrl });
});

// ══════════════════════════════════════════════════════════════════════════
// ██ Facebook Messenger
// ══════════════════════════════════════════════════════════════════════════

// GET /chat/messenger/webhook — Meta verification handshake
const messengerVerifyRoute = createRoute({
  method: "get",
  path: "/messenger/webhook",
  tags: ["Chat Platforms"],
  summary: "Facebook Messenger webhook verification (Meta handshake)",
  request: {
    query: z.object({
      "hub.mode": z.string().optional(),
      "hub.verify_token": z.string().optional(),
      "hub.challenge": z.string().optional(),
    }),
  },
  responses: {
    200: { description: "Challenge response", content: { "text/plain": { schema: z.string() } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
  },
});
chatPlatformRoutes.openapi(messengerVerifyRoute, async (c): Promise<any> => {
  const query = c.req.valid("query");
  const expected = c.env.FACEBOOK_VERIFY_TOKEN || "agentos-meta-verify";
  if (query["hub.mode"] === "subscribe" && query["hub.verify_token"] === expected) {
    return new Response(query["hub.challenge"] || "", { status: 200, headers: { "Content-Type": "text/plain" } });
  }
  return c.json({ error: "Verification failed" }, 403);
});

// POST /chat/messenger/webhook — Receive Messenger events
const messengerWebhookRoute = createRoute({
  method: "post",
  path: "/messenger/webhook",
  tags: ["Chat Platforms"],
  summary: "Receive Facebook Messenger webhook events",
  request: { body: { content: { "application/json": { schema: z.record(z.unknown()) } } } },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: z.object({ ok: z.boolean() }) } } },
    ...errorResponses(401),
  },
});
chatPlatformRoutes.openapi(messengerWebhookRoute, async (c): Promise<any> => {
  const rawBody = await c.req.arrayBuffer();
  const sig = c.req.header("x-hub-signature-256") ?? "";
  const appSecret = c.env.FACEBOOK_APP_SECRET ?? "";
  if (appSecret && !(await verifyMetaSignature(appSecret, rawBody, sig))) {
    return c.json({ error: "Invalid signature" }, 401);
  }

  let payload: any;
  try {
    payload = JSON.parse(new TextDecoder().decode(rawBody));
  } catch {
    return c.json({ ok: true });
  }

  if (payload.object !== "page") return c.json({ ok: true });

  const sql = await getDb(c.env.HYPERDRIVE);

  for (const entry of payload.entry || []) {
    const pageId = entry.id || "";
    for (const messaging of entry.messaging || []) {
      const senderId = messaging.sender?.id || "";
      const recipientId = messaging.recipient?.id || "";
      const msgText = messaging.message?.text || "";
      if (!msgText || !senderId || senderId === recipientId) continue;

      // Resolve org from page_id
      let orgId = "";
      try {
        const rows = await sql`
          SELECT org_id FROM channel_configs
          WHERE channel = 'messenger' AND config->>'page_id' = ${pageId} AND is_active = true
          LIMIT 1
        `;
        if (rows.length > 0) orgId = String(rows[0].org_id);
      } catch {}

      if (!orgId) continue;

      const agentName = await resolveChannelAgent(sql, orgId, "messenger");
      const output = await invokeAgent(c.env, agentName, msgText, "messenger", senderId, orgId);

      // Reply via Messenger Send API
      const pageToken = await getSecret(sql, "FACEBOOK_PAGE_TOKEN", orgId);
      if (pageToken && output) {
        try {
          await fetch(`https://graph.facebook.com/v21.0/${pageId}/messages`, {
            method: "POST",
            headers: { Authorization: `Bearer ${pageToken}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              recipient: { id: senderId },
              message: { text: output.slice(0, 2000) },
              messaging_type: "RESPONSE",
            }),
          });
        } catch {}
      }
    }
  }

  return c.json({ ok: true });
});

// POST /chat/messenger/connect — Store Messenger page credentials
const messengerConnectRoute = createRoute({
  method: "post",
  path: "/messenger/connect",
  tags: ["Chat Platforms"],
  summary: "Connect Facebook Messenger page",
  middleware: [requireScope("integrations:write")],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            page_token: z.string().min(1),
            page_id: z.string().min(1),
            page_name: z.string().default(""),
            agent_name: z.string().default(""),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Connected", content: { "application/json": { schema: z.object({ ok: z.boolean(), webhook_url: z.string() }) } } },
    ...errorResponses(400),
  },
});
chatPlatformRoutes.openapi(messengerConnectRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const body = c.req.valid("json");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  await storeSecret(sql, "FACEBOOK_PAGE_TOKEN", body.page_token, user.org_id);

  const now = new Date().toISOString();
  const config = JSON.stringify({ page_id: body.page_id, page_name: body.page_name });
  await sql`
    INSERT INTO channel_configs (org_id, channel, agent_name, config, is_active, created_at, updated_at)
    VALUES (${user.org_id}, 'messenger', ${body.agent_name || ""}, ${config}::jsonb, true, ${now}, ${now})
    ON CONFLICT (org_id, channel) DO UPDATE
    SET config = ${config}::jsonb, agent_name = COALESCE(NULLIF(${body.agent_name}, ''), channel_configs.agent_name),
        is_active = true, updated_at = ${now}
  `;

  const webhookUrl = `${c.env.RUNTIME_WORKER_URL}/api/v1/chat/messenger/webhook`;
  return c.json({ ok: true, webhook_url: webhookUrl });
});

// ══════════════════════════════════════════════════════════════════════════
// ██ Channel Config Persistence (all platforms)
// ══════════════════════════════════════════════════════════════════════════

// GET /chat/channels — List all channel configs for an org
const listChannelsRoute = createRoute({
  method: "get",
  path: "/channels",
  tags: ["Chat Platforms"],
  summary: "List all configured channels for the org",
  middleware: [requireScope("integrations:read")],
  request: {
    query: z.object({ agent_name: z.string().default("") }),
  },
  responses: {
    200: {
      description: "Channel configs",
      content: {
        "application/json": {
          schema: z.object({
            channels: z.array(z.object({
              channel: z.string(),
              agent_name: z.string(),
              is_active: z.boolean(),
              config: z.record(z.unknown()),
              created_at: z.string(),
              updated_at: z.string(),
            })),
          }),
        },
      },
    },
  },
});
chatPlatformRoutes.openapi(listChannelsRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { agent_name: agentName } = c.req.valid("query");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  let rows;
  if (agentName) {
    rows = await sql`
      SELECT channel, agent_name, is_active, config, created_at, updated_at
      FROM channel_configs WHERE org_id = ${user.org_id} AND (agent_name = ${agentName} OR agent_name = '')
      ORDER BY channel
    `;
  } else {
    rows = await sql`
      SELECT channel, agent_name, is_active, config, created_at, updated_at
      FROM channel_configs WHERE org_id = ${user.org_id}
      ORDER BY channel
    `;
  }

  return c.json({
    channels: rows.map((r: any) => ({
      channel: r.channel,
      agent_name: r.agent_name || "",
      is_active: Boolean(r.is_active),
      config: typeof r.config === "string" ? JSON.parse(r.config) : (r.config || {}),
      created_at: r.created_at?.toISOString?.() || String(r.created_at || ""),
      updated_at: r.updated_at?.toISOString?.() || String(r.updated_at || ""),
    })),
  });
});

// PUT /chat/channels/:channel — Upsert a channel config
const upsertChannelRoute = createRoute({
  method: "put",
  path: "/channels/{channel}",
  tags: ["Chat Platforms"],
  summary: "Create or update a channel config",
  middleware: [requireScope("integrations:write")],
  request: {
    params: z.object({ channel: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            agent_name: z.string().default(""),
            is_active: z.boolean().default(true),
            config: z.record(z.unknown()).default({}),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Saved", content: { "application/json": { schema: z.object({ ok: z.boolean(), channel: z.string() }) } } },
    ...errorResponses(400),
  },
});
chatPlatformRoutes.openapi(upsertChannelRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { channel } = c.req.valid("param");
  const body = c.req.valid("json");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const now = new Date().toISOString();
  const configStr = JSON.stringify(body.config || {});

  await sql`
    INSERT INTO channel_configs (org_id, channel, agent_name, config, is_active, created_at, updated_at)
    VALUES (${user.org_id}, ${channel}, ${body.agent_name || ""}, ${configStr}::jsonb, ${body.is_active}, ${now}, ${now})
    ON CONFLICT (org_id, channel) DO UPDATE
    SET config = ${configStr}::jsonb, agent_name = COALESCE(NULLIF(${body.agent_name}, ''), channel_configs.agent_name),
        is_active = ${body.is_active}, updated_at = ${now}
  `;

  return c.json({ ok: true, channel });
});

// DELETE /chat/channels/:channel — Deactivate a channel
const deleteChannelRoute = createRoute({
  method: "delete",
  path: "/channels/{channel}",
  tags: ["Chat Platforms"],
  summary: "Deactivate a channel",
  middleware: [requireScope("integrations:write")],
  request: {
    params: z.object({ channel: z.string() }),
  },
  responses: {
    200: { description: "Deactivated", content: { "application/json": { schema: z.object({ ok: z.boolean() }) } } },
  },
});
chatPlatformRoutes.openapi(deleteChannelRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { channel } = c.req.valid("param");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  await sql`
    UPDATE channel_configs SET is_active = false, updated_at = ${new Date().toISOString()}
    WHERE org_id = ${user.org_id} AND channel = ${channel}
  `;

  return c.json({ ok: true });
});
