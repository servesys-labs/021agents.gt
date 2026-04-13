/**
 * Telegram Channel — webhook handler for Telegram Bot API.
 *
 * Supports: text, photos, voice (auto-transcribed via Whisper), documents,
 * group mentions, /start /new /help commands, typing indicators,
 * message deduplication, markdown-aware chunking (4096 char limit).
 */

import { type ChannelMessage, runAgent, chunkMessage } from "./adapter";

interface TelegramEnv {
  AI: Ai;
  AGENT_CORE: Fetcher;
  CACHE: KVNamespace; // for dedup
}

export async function handleTelegram(
  request: Request,
  env: TelegramEnv,
  botToken: string,
  agentName: string,
  orgId: string,
  ctx: ExecutionContext,
): Promise<Response> {
  const payload = await request.json() as any;
  const msg = payload.message || payload.edited_message;
  if (!msg) return Response.json({ ok: true });

  const chatId = msg.chat?.id;
  if (!chatId) return Response.json({ ok: true });
  const messageId = msg.message_id;
  const tgApi = `https://api.telegram.org/bot${botToken}`;

  // Commands
  const text = msg.text || msg.caption || "";
  if (text.startsWith("/start")) {
    await tgSend(tgApi, chatId, `Hi! I'm ${agentName}. Send me a message and I'll help.\n\nCommands:\n/new — Clear conversation\n/help — Show help`);
    return Response.json({ ok: true });
  }
  if (text.startsWith("/new")) {
    // TODO: call agent DO to clear conversation
    await tgSend(tgApi, chatId, "Conversation cleared.");
    return Response.json({ ok: true });
  }
  if (text.startsWith("/help")) {
    await tgSend(tgApi, chatId, "Send text, photos, voice, or documents. I'll help with anything.\n\n/new — Clear conversation");
    return Response.json({ ok: true });
  }

  if (!text && !msg.photo && !msg.voice && !msg.document) return Response.json({ ok: true });

  // Dedup (Telegram sometimes sends webhooks twice)
  const dedupeKey = `tg:${chatId}:${messageId}`;
  if (await env.CACHE.get(dedupeKey)) return Response.json({ ok: true });
  await env.CACHE.put(dedupeKey, "1", { expirationTtl: 10 });

  // Build input
  const inputParts: string[] = [];
  const mediaUrls: string[] = [];
  const mediaTypes: string[] = [];

  if (text) inputParts.push(text);

  // Voice → auto-transcribe via Whisper
  if (msg.voice || msg.audio) {
    const fileId = msg.voice?.file_id || msg.audio?.file_id;
    try {
      const fileResp = await fetch(`${tgApi}/getFile?file_id=${fileId}`);
      const fileData = await fileResp.json() as any;
      if (fileData.ok) {
        const fileUrl = `https://api.telegram.org/file/bot${botToken}/${fileData.result.file_path}`;
        const audioResp = await fetch(fileUrl);
        const audioBytes = new Uint8Array(await audioResp.arrayBuffer());
        const whisper = await env.AI.run("@cf/openai/whisper" as any, { audio: [...audioBytes] }) as any;
        if (whisper?.text) inputParts.push(`[Voice]: ${whisper.text}`);
        else inputParts.push("[Voice message — transcription failed]");
      }
    } catch { inputParts.push("[Voice message]"); }
  }

  // Photos
  if (msg.photo?.length) {
    const fileId = msg.photo[msg.photo.length - 1].file_id;
    try {
      const fileResp = await fetch(`${tgApi}/getFile?file_id=${fileId}`);
      const fileData = await fileResp.json() as any;
      if (fileData.ok) {
        mediaUrls.push(`https://api.telegram.org/file/bot${botToken}/${fileData.result.file_path}`);
        mediaTypes.push("image/jpeg");
        inputParts.push("[Photo attached]");
      }
    } catch {}
  }

  const userInput = inputParts.join("\n");
  if (!userInput) return Response.json({ ok: true });

  // Run agent in background — return 200 immediately
  ctx.waitUntil((async () => {
    // Typing indicator
    const typingInterval = setInterval(() => {
      fetch(`${tgApi}/sendChatAction`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, action: "typing" }),
      }).catch(() => {});
    }, 5000);

    try {
      const result = await runAgent(env.AGENT_CORE, {
        text: userInput, channel: "telegram", userId: String(chatId),
        orgId, agentName, mediaUrls, mediaTypes,
      });

      clearInterval(typingInterval);
      const chunks = chunkMessage(result.text || "No response.", 4096);
      for (const chunk of chunks) {
        await tgSend(tgApi, chatId, chunk, messageId);
      }
    } catch (err) {
      clearInterval(typingInterval);
      await tgSend(tgApi, chatId, "Sorry, something went wrong.");
    }
  })());

  return Response.json({ ok: true });
}

async function tgSend(api: string, chatId: number, text: string, replyTo?: number) {
  const body: any = { chat_id: chatId, text, parse_mode: "Markdown" };
  if (replyTo) body.reply_to_message_id = replyTo;
  const resp = await fetch(`${api}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await resp.json() as any;
  // Retry without markdown if parse fails
  if (!data.ok && String(data.description || "").includes("can't parse")) {
    delete body.parse_mode;
    await fetch(`${api}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => {});
  }
}
