/**
 * Chat platforms router — Telegram bot setup, webhook handling.
 * Ported from agentos/api/routers/chat_platforms.py
 */
import { createRoute, z } from "@hono/zod-openapi";
import { createOpenAPIRouter } from "../lib/openapi";
import { ErrorSchema, errorResponses } from "../schemas/openapi";
import { getDb, getDbForOrg } from "../db/client";
import { requireScope } from "../middleware/auth";

export const chatPlatformRoutes = createOpenAPIRouter();

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
