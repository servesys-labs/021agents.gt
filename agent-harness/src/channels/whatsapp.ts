/**
 * WhatsApp Channel — Cloud API webhook handler.
 *
 * Supports: text, images, audio, documents, location.
 * HMAC signature verification for webhook security.
 */

import { type ChannelMessage, runAgent, stripMarkdown, chunkMessage } from "./adapter";

interface WhatsAppEnv {
  AGENT_CORE: Fetcher;
  WHATSAPP_APP_SECRET?: string;
  WHATSAPP_VERIFY_TOKEN?: string;
  WHATSAPP_ACCESS_TOKEN?: string;
}

// GET = Meta verification handshake
export function handleWhatsAppVerify(request: Request, env: WhatsAppEnv): Response {
  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");
  if (mode === "subscribe" && token === env.WHATSAPP_VERIFY_TOKEN) {
    return new Response(challenge, { status: 200 });
  }
  return new Response("Forbidden", { status: 403 });
}

// POST = incoming message
export async function handleWhatsApp(
  request: Request,
  env: WhatsAppEnv,
  agentName: string,
  orgId: string,
  ctx: ExecutionContext,
): Promise<Response> {
  const rawBody = await request.arrayBuffer();

  // HMAC signature verification
  if (env.WHATSAPP_APP_SECRET) {
    const signature = request.headers.get("x-hub-signature-256") || "";
    const key = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(env.WHATSAPP_APP_SECRET),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
    );
    const expected = await crypto.subtle.sign("HMAC", key, rawBody);
    const expectedHex = "sha256=" + [...new Uint8Array(expected)].map(b => b.toString(16).padStart(2, "0")).join("");
    if (signature !== expectedHex) {
      return Response.json({ error: "Invalid signature" }, { status: 401 });
    }
  }

  const body = JSON.parse(new TextDecoder().decode(rawBody));
  const entry = body.entry?.[0];
  const changes = entry?.changes?.[0];
  const value = changes?.value;
  if (!value?.messages?.length) return Response.json({ ok: true });

  const waMsg = value.messages[0];
  const from = waMsg.from; // phone number
  const phoneNumberId = value.metadata?.phone_number_id;
  const accessToken = env.WHATSAPP_ACCESS_TOKEN || "";

  // Extract text
  let text = "";
  const mediaUrls: string[] = [];
  const mediaTypes: string[] = [];

  if (waMsg.type === "text") {
    text = waMsg.text?.body || "";
  } else if (waMsg.type === "image" || waMsg.type === "audio" || waMsg.type === "document") {
    const mediaId = waMsg[waMsg.type]?.id;
    if (mediaId && accessToken) {
      try {
        const mediaResp = await fetch(`https://graph.facebook.com/v19.0/${mediaId}`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        const mediaData = await mediaResp.json() as any;
        if (mediaData.url) {
          mediaUrls.push(mediaData.url);
          mediaTypes.push(waMsg[waMsg.type]?.mime_type || "application/octet-stream");
        }
      } catch {}
    }
    text = waMsg[waMsg.type]?.caption || `[${waMsg.type} attached]`;
  } else if (waMsg.type === "location") {
    text = `[Location: ${waMsg.location?.latitude}, ${waMsg.location?.longitude}]`;
  }

  if (!text) return Response.json({ ok: true });

  // Run agent in background
  ctx.waitUntil((async () => {
    try {
      const result = await runAgent(env.AGENT_CORE, {
        text, channel: "whatsapp", userId: from,
        orgId, agentName, mediaUrls, mediaTypes,
      });

      // WhatsApp has 4096 char limit, strip markdown (no rich formatting)
      const plain = stripMarkdown(result.text);
      const chunks = chunkMessage(plain, 4096);
      for (const chunk of chunks) {
        await fetch(`https://graph.facebook.com/v19.0/${phoneNumberId}/messages`, {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            messaging_product: "whatsapp", to: from,
            type: "text", text: { body: chunk },
          }),
        });
      }
    } catch (err) {
      console.error("[whatsapp] Agent run failed:", err);
    }
  })());

  return Response.json({ ok: true });
}
