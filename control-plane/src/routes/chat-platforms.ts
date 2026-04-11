/**
 * Chat platforms router — Telegram, WhatsApp, Slack, Instagram, Facebook Messenger, SMS (Twilio), TikTok DM.
 * Each platform follows the same pattern:
 *   1. connect endpoint (stores token/credentials)
 *   2. webhook endpoint (receives messages, invokes agent via RUNTIME)
 *   3. optional verify endpoint (platform handshake)
 */
import { createRoute, z } from "@hono/zod-openapi";
import { createOpenAPIRouter } from "../lib/openapi";
import { ErrorSchema, errorResponses } from "../schemas/openapi";
import { withOrgDb, withAdminDb } from "../db/client";
import { requireScope } from "../middleware/auth";

export const chatPlatformRoutes = createOpenAPIRouter();

// ── Helpers ──────────────────────────────────────────────────────────────

/** Get a secret by name for an org. */
async function getSecret(sql: any, name: string, orgId?: string): Promise<string> {
  try {
    const rows = orgId
      ? await sql`SELECT encrypted_value FROM secrets WHERE name = ${name} AND org_id = ${orgId} ORDER BY created_at DESC LIMIT 1`
      : await sql`SELECT encrypted_value FROM secrets WHERE name = ${name} ORDER BY created_at DESC LIMIT 1`;
    if (rows.length > 0 && rows[0].encrypted_value) return String(rows[0].encrypted_value);
  } catch {}
  return "";
}

/** Store a secret (upsert). */
async function storeSecret(sql: any, name: string, value: string, orgId: string): Promise<void> {
  const now = new Date().toISOString();
  await sql`
    INSERT INTO secrets (name, encrypted_value, org_id, created_at, updated_at)
    VALUES (${name}, ${value}, ${orgId}, ${now}, ${now})
    ON CONFLICT (org_id, name, project_id, env) DO UPDATE SET encrypted_value = EXCLUDED.encrypted_value, updated_at = EXCLUDED.updated_at
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
      SELECT name FROM agents WHERE org_id = ${orgId} AND is_active = true ORDER BY created_at ASC LIMIT 1
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
    const resp = await env.RUNTIME.fetch("https://runtime/run", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(env.SERVICE_TOKEN ? { Authorization: `Bearer ${env.SERVICE_TOKEN}` } : {}),
      },
      body: JSON.stringify({
        agent_name: agentName,
        input,
        channel,
        channel_user_id: channelUserId,
        org_id: orgId,
      }),
    });
    if (resp.status >= 400) {
      const text = await resp.text().catch(() => "");
      return `Sorry, I hit a runtime error (${resp.status}). ${text.slice(0, 180)}`;
    }
    const data = await resp.json().catch(() => ({})) as Record<string, unknown>;
    return typeof data.output === "string"
      ? data.output
      : typeof data.response === "string"
        ? data.response
        : "";
  } catch (e: any) {
    return `Sorry, I encountered an error: ${String(e.message).slice(0, 200)}`;
  }
}

async function resetChannelSession(
  env: any,
  agentName: string,
  orgId: string,
  channelUserId: string,
): Promise<boolean> {
  try {
    const resp = await env.RUNTIME.fetch("https://runtime/api/v1/runtime-proxy/runnable/stream", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(env.SERVICE_TOKEN ? { Authorization: `Bearer ${env.SERVICE_TOKEN}` } : {}),
      },
      body: JSON.stringify({
        __reset: true,
        agent_name: agentName,
        org_id: orgId || "",
        channel_user_id: channelUserId,
      }),
    });
    return resp.status < 500;
  } catch {
    return false;
  }
}

const CHANNEL_SESSION_MAX = 20;

function sessionStateKey(orgId: string, channel: string, channelUserId: string): string {
  return `chan-sess:${orgId}:${channel}:${channelUserId}`;
}

function sessionLastInputKey(orgId: string, channel: string, channelUserId: string, sessionName: string): string {
  return `chan-sess-last:${orgId}:${channel}:${channelUserId}:${sessionName}`;
}

function sanitizeSessionName(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9:_-]/g, "-").replace(/-+/g, "-").slice(0, 40) || "main";
}

function scopedChannelUserId(channelUserId: string, sessionName: string): string {
  return sessionName === "main" ? channelUserId : `${channelUserId}::${sessionName}`;
}

type ChannelSessionState = {
  current: string;
  sessions: Array<{ name: string; last_used_ms: number }>;
};

async function getChannelSessionState(
  env: any,
  orgId: string,
  channel: "telegram" | "whatsapp" | "slack",
  channelUserId: string,
): Promise<ChannelSessionState> {
  const fallback: ChannelSessionState = {
    current: "main",
    sessions: [{ name: "main", last_used_ms: Date.now() }],
  };
  const kv = env.AGENT_PROGRESS_KV;
  if (!kv) return fallback;
  try {
    const raw = await kv.get(sessionStateKey(orgId, channel, channelUserId));
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<ChannelSessionState>;
    const sessions = Array.isArray(parsed.sessions)
      ? parsed.sessions
          .filter((s) => s && typeof s.name === "string")
          .map((s) => ({ name: sanitizeSessionName(s.name), last_used_ms: Number(s.last_used_ms) || Date.now() }))
      : [];
    const dedup = new Map<string, number>();
    for (const s of sessions) dedup.set(s.name, Math.max(dedup.get(s.name) || 0, s.last_used_ms));
    if (!dedup.has("main")) dedup.set("main", Date.now());
    const normalized = [...dedup.entries()]
      .map(([name, last_used_ms]) => ({ name, last_used_ms }))
      .sort((a, b) => b.last_used_ms - a.last_used_ms)
      .slice(0, CHANNEL_SESSION_MAX);
    const current = sanitizeSessionName(String(parsed.current || "main"));
    if (!normalized.some((s) => s.name === current)) normalized.unshift({ name: current, last_used_ms: Date.now() });
    return {
      current,
      sessions: normalized.slice(0, CHANNEL_SESSION_MAX),
    };
  } catch {
    return fallback;
  }
}

async function saveChannelSessionState(
  env: any,
  orgId: string,
  channel: "telegram" | "whatsapp" | "slack",
  channelUserId: string,
  state: ChannelSessionState,
) {
  const kv = env.AGENT_PROGRESS_KV;
  if (!kv) return;
  await kv.put(
    sessionStateKey(orgId, channel, channelUserId),
    JSON.stringify(state),
    { expirationTtl: 60 * 60 * 24 * 120 },
  );
}

async function getSessionLastInput(
  env: any,
  orgId: string,
  channel: "telegram" | "whatsapp" | "slack",
  channelUserId: string,
  sessionName: string,
): Promise<string> {
  const kv = env.AGENT_PROGRESS_KV;
  if (!kv) return "";
  return (await kv.get(sessionLastInputKey(orgId, channel, channelUserId, sanitizeSessionName(sessionName)))) || "";
}

async function setSessionLastInput(
  env: any,
  orgId: string,
  channel: "telegram" | "whatsapp" | "slack",
  channelUserId: string,
  sessionName: string,
  input: string,
) {
  const kv = env.AGENT_PROGRESS_KV;
  if (!kv) return;
  await kv.put(
    sessionLastInputKey(orgId, channel, channelUserId, sanitizeSessionName(sessionName)),
    String(input || "").slice(0, 12000),
    { expirationTtl: 60 * 60 * 24 * 30 },
  );
}

async function deleteSessionLastInput(
  env: any,
  orgId: string,
  channel: "telegram" | "whatsapp" | "slack",
  channelUserId: string,
  sessionName: string,
) {
  const kv = env.AGENT_PROGRESS_KV;
  if (!kv) return;
  await kv.delete(sessionLastInputKey(orgId, channel, channelUserId, sanitizeSessionName(sessionName)));
}

async function touchChannelSession(
  env: any,
  orgId: string,
  channel: "telegram" | "whatsapp" | "slack",
  channelUserId: string,
  sessionName: string,
): Promise<ChannelSessionState> {
  const state = await getChannelSessionState(env, orgId, channel, channelUserId);
  const name = sanitizeSessionName(sessionName);
  const now = Date.now();
  const sessions = state.sessions.filter((s) => s.name !== name);
  sessions.unshift({ name, last_used_ms: now });
  const next: ChannelSessionState = {
    current: name,
    sessions: sessions.slice(0, CHANNEL_SESSION_MAX),
  };
  await saveChannelSessionState(env, orgId, channel, channelUserId, next);
  return next;
}

type ChannelCommandResult = {
  handled: boolean;
  reply?: string;
  activeSession: string;
  retryInput?: string;
};

async function handleCommonChannelCommand(
  env: any,
  channel: "telegram" | "whatsapp" | "slack",
  text: string,
  agentName: string,
  orgId: string,
  channelUserId: string,
): Promise<ChannelCommandResult> {
  const state = await getChannelSessionState(env, orgId, channel, channelUserId);
  const raw = String(text || "").trim();
  if (!raw.startsWith("/")) {
    await touchChannelSession(env, orgId, channel, channelUserId, state.current);
    return { handled: false, activeSession: state.current };
  }

  const [cmd, ...rest] = raw.split(/\s+/);
  const arg = rest.join(" ").trim();
  const normalized = cmd.toLowerCase();
  const channelLabel = channel === "telegram" ? "Telegram" : channel === "whatsapp" ? "WhatsApp" : "Slack";

  if (normalized === "/start") {
    return { handled: true, activeSession: state.current, reply: "Hi! I'm your OneShots agent. Send me a message and I'll help." };
  }
  if (normalized === "/help") {
    return {
      handled: true,
      activeSession: state.current,
      reply: "Commands:\n/start\n/help\n/status\n/new\n/reset\n/stop\n/cancel\n/retry\n/undo\n/sessions\n/session [name|#]\n/session rename <name>\n/session delete <name|#>\n\nUse /new for a fresh session and /sessions to switch.",
    };
  }
  if (normalized === "/status") {
    return {
      handled: true,
      activeSession: state.current,
      reply: `Status: ready\nChannel: ${channelLabel}\nAgent: ${agentName}\nSession: ${state.current}`,
    };
  }
  if (normalized === "/sessions") {
    const lines = state.sessions.slice(0, 10).map((s, i) =>
      `${i + 1}. ${s.name}${s.name === state.current ? " (active)" : ""}`
    );
    return {
      handled: true,
      activeSession: state.current,
      reply: lines.length
        ? `Recent sessions:\n${lines.join("\n")}\n\nUse /session <number|name> to switch.`
        : "No sessions yet. Use /new to start one.",
    };
  }
  if (normalized === "/session") {
    const lowerArg = arg.toLowerCase();
    if (lowerArg.startsWith("rename ")) {
      const nextName = sanitizeSessionName(arg.slice(7).trim());
      if (!nextName) {
        return { handled: true, activeSession: state.current, reply: "Usage: /session rename <name>" };
      }
      const prev = state.current;
      if (nextName === prev) {
        return { handled: true, activeSession: state.current, reply: `Session is already named ${state.current}.` };
      }
      const migratedSessions = state.sessions
        .map((s) => ({ ...s, name: s.name === prev ? nextName : s.name }))
        .filter((s, idx, arr) => arr.findIndex((x) => x.name === s.name) === idx);
      const nextState: ChannelSessionState = {
        current: nextName,
        sessions: migratedSessions.slice(0, CHANNEL_SESSION_MAX),
      };
      await saveChannelSessionState(env, orgId, channel, channelUserId, nextState);
      const last = await getSessionLastInput(env, orgId, channel, channelUserId, prev);
      if (last) await setSessionLastInput(env, orgId, channel, channelUserId, nextName, last);
      await deleteSessionLastInput(env, orgId, channel, channelUserId, prev);
      return { handled: true, activeSession: nextName, reply: `Renamed session ${prev} -> ${nextName}` };
    }
    if (lowerArg.startsWith("delete ")) {
      const targetRaw = arg.slice(7).trim();
      if (!targetRaw) return { handled: true, activeSession: state.current, reply: "Usage: /session delete <name|#>" };
      let target = "";
      const idx = Number(targetRaw);
      if (Number.isFinite(idx) && idx >= 1 && idx <= state.sessions.length) {
        target = state.sessions[idx - 1].name;
      } else {
        target = sanitizeSessionName(targetRaw);
      }
      if (target === "main") {
        return { handled: true, activeSession: state.current, reply: "Cannot delete the main session." };
      }
      const nextSessions = state.sessions.filter((s) => s.name !== target);
      const nextCurrent = state.current === target ? "main" : state.current;
      const nextState: ChannelSessionState = {
        current: nextCurrent,
        sessions: nextSessions.length > 0 ? nextSessions : [{ name: "main", last_used_ms: Date.now() }],
      };
      await saveChannelSessionState(env, orgId, channel, channelUserId, nextState);
      await deleteSessionLastInput(env, orgId, channel, channelUserId, target);
      await resetChannelSession(env, agentName, orgId, scopedChannelUserId(channelUserId, target));
      return { handled: true, activeSession: nextCurrent, reply: `Deleted session ${target}. Active: ${nextCurrent}` };
    }
    if (!arg) {
      return {
        handled: true,
        activeSession: state.current,
        reply: `Active session: ${state.current}\nUse /sessions to list, /session <number|name> to switch.`,
      };
    }
    let selected = "";
    const idx = Number(arg);
    if (Number.isFinite(idx) && idx >= 1 && idx <= state.sessions.length) {
      selected = state.sessions[idx - 1].name;
    } else {
      selected = sanitizeSessionName(arg);
    }
    const next = await touchChannelSession(env, orgId, channel, channelUserId, selected);
    return {
      handled: true,
      activeSession: next.current,
      reply: `Switched to session: ${next.current}`,
    };
  }
  if (normalized === "/new") {
    const newSession = `s-${Date.now().toString(36)}`;
    const next = await touchChannelSession(env, orgId, channel, channelUserId, newSession);
    return {
      handled: true,
      activeSession: next.current,
      reply: `Started a fresh session: ${next.current}`,
    };
  }
  if (normalized === "/retry") {
    const last = await getSessionLastInput(env, orgId, channel, channelUserId, state.current);
    if (!last) {
      return { handled: true, activeSession: state.current, reply: "No previous input found in this session to retry." };
    }
    return {
      handled: true,
      activeSession: state.current,
      reply: "Retrying your previous request...",
      retryInput: last,
    };
  }
  if (normalized === "/undo") {
    const scopedId = scopedChannelUserId(channelUserId, state.current);
    const ok = await resetChannelSession(env, agentName, orgId, scopedId);
    await deleteSessionLastInput(env, orgId, channel, channelUserId, state.current);
    return {
      handled: true,
      activeSession: state.current,
      reply: ok ? `Undid the last turn by resetting session ${state.current}.` : "I couldn't undo right now. Please try again.",
    };
  }
  if (normalized === "/reset" || normalized === "/stop" || normalized === "/cancel") {
    const scopedId = scopedChannelUserId(channelUserId, state.current);
    const ok = await resetChannelSession(env, agentName, orgId, scopedId);
    if (normalized === "/stop" || normalized === "/cancel") {
      return {
        handled: true,
        activeSession: state.current,
        reply: ok ? `Stopped current run and cleared session ${state.current}.` : "I couldn't stop right now. Please try again.",
      };
    }
    return {
      handled: true,
      activeSession: state.current,
      reply: ok ? `Reset session ${state.current}.` : "I couldn't reset right now. Please try again.",
    };
  }
  return { handled: false, activeSession: state.current };
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

/** Twilio request signature verification (HMAC-SHA1). */
async function verifyTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
  signature: string,
): Promise<boolean> {
  if (!authToken || !signature) return !authToken; // skip if no token configured
  try {
    // Sort param keys and concatenate key+value
    const sortedKeys = Object.keys(params).sort();
    const data = url + sortedKeys.map((k) => k + params[k]).join("");
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(authToken),
      { name: "HMAC", hash: "SHA-1" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
    // Twilio signature is base64-encoded
    const expected = btoa(String.fromCharCode(...new Uint8Array(sig)));
    return expected === signature;
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

async function getTelegramToken(sql: any, orgId?: string): Promise<string> {
  try {
    const rows = orgId
      ? await sql`SELECT encrypted_value FROM secrets WHERE name = 'TELEGRAM_BOT_TOKEN' AND org_id = ${orgId} ORDER BY created_at DESC LIMIT 1`
      : await sql`SELECT encrypted_value FROM secrets WHERE name = 'TELEGRAM_BOT_TOKEN' ORDER BY created_at DESC LIMIT 1`;
    if (rows.length > 0 && rows[0].encrypted_value) return String(rows[0].encrypted_value);
  } catch {}
  return "";
}

// ── Markdown-aware message chunking ──────────────────────────────────────
// Inspired by Hermes: splits at natural boundaries, preserves code blocks

function chunkMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  let insideCodeBlock = false;
  let codeLang = "";

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    // Reserve space for chunk indicator and possible code fence
    const reserve = 20;
    let splitAt = maxLen - reserve;

    // Find a good split point: prefer double newline, then newline, then space
    let best = -1;
    const doubleNl = remaining.lastIndexOf("\n\n", splitAt);
    if (doubleNl > maxLen * 0.3) best = doubleNl + 1;
    if (best === -1) {
      const nl = remaining.lastIndexOf("\n", splitAt);
      if (nl > maxLen * 0.3) best = nl + 1;
    }
    if (best === -1) {
      const sp = remaining.lastIndexOf(" ", splitAt);
      if (sp > maxLen * 0.3) best = sp + 1;
    }
    if (best === -1) best = splitAt;

    let chunk = remaining.slice(0, best);
    remaining = remaining.slice(best);

    // Track code fences in this chunk
    const fences = chunk.match(/```/g);
    const fenceCount = fences ? fences.length : 0;

    if (insideCodeBlock) {
      // We're continuing from a split inside a code block — reopen
      chunk = "```" + codeLang + "\n" + chunk;
    }

    // Check if we end inside a code block
    const totalFences = (insideCodeBlock ? 1 : 0) + fenceCount;
    if (totalFences % 2 === 1) {
      // Odd fences = we're inside a code block at the end, close it
      chunk = chunk + "\n```";
      insideCodeBlock = true;
      // Try to detect language from the opening fence
      const langMatch = chunk.match(/```(\w+)/);
      codeLang = langMatch ? langMatch[1] : "";
    } else {
      insideCodeBlock = false;
      codeLang = "";
    }

    chunks.push(chunk);
  }

  // Add chunk indicators if multiple
  if (chunks.length > 1) {
    return chunks.map((c, i) => `${c}\n(${i + 1}/${chunks.length})`);
  }
  return chunks;
}

// ── Telegram helpers ────────────────────────────────────────────────────

const TG_API = "https://api.telegram.org";

async function sendTelegramMessage(
  token: string,
  chatId: number,
  text: string,
  replyTo?: number,
  parseMode: string = "Markdown",
): Promise<number | undefined> {
  const body: any = { chat_id: chatId, text, parse_mode: parseMode };
  if (replyTo) body.reply_to_message_id = replyTo;
  try {
    const resp = await fetch(`${TG_API}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await resp.json() as any;
    if (data?.ok && typeof data?.result?.message_id === "number") {
      return data.result.message_id;
    }
    // Retry without parse mode if markdown fails
    if (!data.ok && String(data.description || "").toLowerCase().includes("can't parse")) {
      delete body.parse_mode;
      const retryResp = await fetch(`${TG_API}/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const retryData = await retryResp.json().catch(() => ({})) as any;
      if (retryData?.ok && typeof retryData?.result?.message_id === "number") {
        return retryData.result.message_id;
      }
    }
  } catch {}
  return undefined;
}

/** Send typing indicator. */
async function sendTelegramTyping(token: string, chatId: number) {
  await fetch(`${TG_API}/bot${token}/sendChatAction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, action: "typing" }),
  }).catch(() => {});
}

/** Edit an existing Telegram message (used for long-run status updates). */
async function editTelegramMessage(
  token: string,
  chatId: number,
  messageId: number,
  text: string,
) {
  const body: any = { chat_id: chatId, message_id: messageId, text, parse_mode: "Markdown" };
  try {
    const resp = await fetch(`${TG_API}/bot${token}/editMessageText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await resp.json().catch(() => ({})) as any;
    if (!data.ok && String(data.description || "").toLowerCase().includes("can't parse")) {
      delete body.parse_mode;
      await fetch(`${TG_API}/bot${token}/editMessageText`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).catch(() => {});
    }
  } catch {}
}

/** Get a Telegram file's download URL. */
async function getTelegramFileUrl(token: string, fileId: string): Promise<string | null> {
  try {
    const resp = await fetch(`${TG_API}/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`);
    const data = await resp.json() as any;
    if (data.ok) return `${TG_API}/file/bot${token}/${data.result.file_path}`;
  } catch {}
  return null;
}

/** Download a file from Telegram into bytes. */
async function downloadTelegramFile(token: string, fileId: string): Promise<{ bytes: ArrayBuffer; path: string } | null> {
  try {
    const resp = await fetch(`${TG_API}/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`);
    const data = await resp.json() as any;
    if (!data.ok) return null;
    const filePath = data.result.file_path as string;
    const fileResp = await fetch(`${TG_API}/file/bot${token}/${filePath}`);
    if (!fileResp.ok) return null;
    return { bytes: await fileResp.arrayBuffer(), path: filePath };
  } catch {}
  return null;
}

/** Send a photo via Telegram (from URL). */
async function sendTelegramPhoto(token: string, chatId: number, photoUrl: string, caption?: string, replyTo?: number) {
  const body: any = { chat_id: chatId, photo: photoUrl };
  if (caption) body.caption = caption.slice(0, 1024);
  if (replyTo) body.reply_to_message_id = replyTo;
  await fetch(`${TG_API}/bot${token}/sendPhoto`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => {});
}

/** Send a document via Telegram (from URL). */
async function sendTelegramDocument(token: string, chatId: number, docUrl: string, caption?: string, filename?: string, replyTo?: number) {
  const body: any = { chat_id: chatId, document: docUrl };
  if (caption) body.caption = caption.slice(0, 1024);
  if (filename) body.caption = (body.caption ? body.caption + "\n" : "") + filename;
  if (replyTo) body.reply_to_message_id = replyTo;
  await fetch(`${TG_API}/bot${token}/sendDocument`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => {});
}

/** Send a voice/audio via Telegram (from URL). */
async function sendTelegramVoice(token: string, chatId: number, audioUrl: string, replyTo?: number) {
  const body: any = { chat_id: chatId, voice: audioUrl };
  if (replyTo) body.reply_to_message_id = replyTo;
  await fetch(`${TG_API}/bot${token}/sendVoice`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => {});
}

/** Get bot info (username, id). */
async function getTelegramBotInfo(token: string): Promise<{ id: number; username: string } | null> {
  try {
    const resp = await fetch(`${TG_API}/bot${token}/getMe`);
    const data = await resp.json() as any;
    if (data.ok) return { id: data.result.id, username: data.result.username || "" };
  } catch {}
  return null;
}

/** Check if a group message mentions the bot or is a reply to the bot. */
function shouldProcessGroupMessage(
  message: any,
  botId: number,
  botUsername: string,
): boolean {
  // Always process DMs
  const chatType = message.chat?.type || "private";
  if (chatType === "private") return true;

  // Always process commands
  const text = message.text || message.caption || "";
  if (text.startsWith("/")) return true;

  // Check if replying to the bot
  const replyTo = message.reply_to_message;
  if (replyTo?.from?.id === botId) return true;

  // Check for @mention in text
  if (botUsername && text.toLowerCase().includes(`@${botUsername.toLowerCase()}`)) return true;

  // Check entities for mentions
  const entities = message.entities || message.caption_entities || [];
  for (const ent of entities) {
    if (ent.type === "mention") {
      const mentionText = text.slice(ent.offset, ent.offset + ent.length);
      if (mentionText.toLowerCase() === `@${botUsername.toLowerCase()}`) return true;
    }
    if (ent.type === "text_mention" && ent.user?.id === botId) return true;
  }

  return false;
}

/** Strip @bot mention from text for cleaner agent input. */
function stripBotMention(text: string, botUsername: string): string {
  if (!botUsername) return text;
  return text.replace(new RegExp(`@${botUsername}\\b`, "gi"), "").trim();
}

/** Parse Telegram message to extract text + media info. */
function parseTelegramMessage(message: any): {
  text: string;
  hasPhoto: boolean;
  hasDocument: boolean;
  hasVoice: boolean;
  hasAudio: boolean;
  hasVideo: boolean;
  hasSticker: boolean;
  fileId: string;
  fileName: string;
  mimeType: string;
  caption: string;
} {
  const text = message.text || "";
  const caption = message.caption || "";
  let hasPhoto = false, hasDocument = false, hasVoice = false, hasAudio = false, hasVideo = false, hasSticker = false;
  let fileId = "", fileName = "", mimeType = "";

  if (message.photo?.length) {
    hasPhoto = true;
    fileId = message.photo[message.photo.length - 1].file_id; // Highest res
  }
  if (message.document) {
    hasDocument = true;
    fileId = message.document.file_id;
    fileName = message.document.file_name || "";
    mimeType = message.document.mime_type || "";
  }
  if (message.voice) {
    hasVoice = true;
    fileId = message.voice.file_id;
    mimeType = message.voice.mime_type || "audio/ogg";
  }
  if (message.audio) {
    hasAudio = true;
    fileId = message.audio.file_id;
    fileName = message.audio.file_name || "";
    mimeType = message.audio.mime_type || "audio/mpeg";
  }
  if (message.video) {
    hasVideo = true;
    fileId = message.video.file_id;
    mimeType = message.video.mime_type || "video/mp4";
  }
  if (message.sticker) {
    hasSticker = true;
    fileId = message.sticker.file_id;
  }

  return { text, hasPhoto, hasDocument, hasVoice, hasAudio, hasVideo, hasSticker, fileId, fileName, mimeType, caption };
}

// ── WhatsApp helpers ────────────────────────────────────────────────────

/** Mark a WhatsApp message as read. */
async function markWhatsAppRead(token: string, phoneNumberId: string, messageId: string) {
  await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      status: "read",
      message_id: messageId,
    }),
  }).catch(() => {});
}

/** Download WhatsApp media by media ID. */
async function downloadWhatsAppMedia(token: string, mediaId: string): Promise<{ url: string; mimeType: string } | null> {
  try {
    // Step 1: Get media URL
    const resp = await fetch(`https://graph.facebook.com/v21.0/${mediaId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await resp.json() as any;
    if (!data.url) return null;
    return { url: data.url, mimeType: data.mime_type || "" };
  } catch {}
  return null;
}

/** Send a WhatsApp image message. */
async function sendWhatsAppImage(token: string, phoneNumberId: string, to: string, imageUrl: string, caption?: string) {
  await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "image",
      image: { link: imageUrl, ...(caption ? { caption: caption.slice(0, 1024) } : {}) },
    }),
  }).catch(() => {});
}

/** Send a WhatsApp document message. */
async function sendWhatsAppDocument(token: string, phoneNumberId: string, to: string, docUrl: string, filename?: string, caption?: string) {
  await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "document",
      document: { link: docUrl, ...(filename ? { filename } : {}), ...(caption ? { caption: caption.slice(0, 1024) } : {}) },
    }),
  }).catch(() => {});
}

/** Send a WhatsApp text reply with chunking. */
async function sendWhatsAppText(token: string, phoneNumberId: string, to: string, text: string, contextMessageId?: string) {
  const chunks = chunkMessage(text, 4096);
  for (let i = 0; i < chunks.length; i++) {
    const body: any = {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: chunks[i] },
    };
    // Reply context on first chunk only
    if (i === 0 && contextMessageId) {
      body.context = { message_id: contextMessageId };
    }
    await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => {});
  }
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
  // Webhook is unauthenticated; the org is resolved from channel_configs
  // below. Use admin connection (BYPASSRLS) so the lookup can see all orgs;
  // helper queries below still filter by org_id explicitly.
  return await withAdminDb(c.env, async (sql) => {
  const payload = c.req.valid("json") as any;
  const message = payload?.message || payload?.edited_message;
  if (!message) return c.json({ ok: true });

  const chatId = message.chat?.id;
  if (!chatId) return c.json({ ok: true });
  const messageId = message.message_id;

  // Parse media and text
  const parsed = parseTelegramMessage(message);
  const hasContent = parsed.text || parsed.caption || parsed.hasPhoto || parsed.hasDocument || parsed.hasVoice || parsed.hasAudio || parsed.hasVideo;
  if (!hasContent) return c.json({ ok: true });

  // Resolve org from channel_configs (multi-tenant)
  let orgId = "";
  try {
    const rows = await sql`
      SELECT org_id FROM channel_configs
      WHERE channel = 'telegram' AND is_active = true
      ORDER BY created_at ASC LIMIT 1
    `;
    if (rows.length > 0) orgId = String(rows[0].org_id);
  } catch {}

  // Get bot token (org-scoped if possible, else global)
  const botToken = orgId ? await getTelegramToken(sql, orgId) : await getTelegramToken(sql);
  if (!botToken) return c.json({ error: "TELEGRAM_BOT_TOKEN not configured" }, 503);

  // Group filtering: only process if DM, command, reply-to-bot, or @mention
  const chatType = message.chat?.type || "private";
  if (chatType === "group" || chatType === "supergroup") {
    const botInfo = await getTelegramBotInfo(botToken);
    if (botInfo && !shouldProcessGroupMessage(message, botInfo.id, botInfo.username)) {
      return c.json({ ok: true }); // Silently ignore non-addressed group messages
    }
  }

  const rawText = parsed.text || parsed.caption || "";

  // Handle shared slash commands
  const agentNameForCommand = orgId ? await resolveChannelAgent(sql, orgId, "telegram") : "telegram-bot";
  const commandResult = await handleCommonChannelCommand(
    c.env,
    "telegram",
    rawText,
    agentNameForCommand,
    orgId,
    String(chatId),
  );
  if (commandResult.handled) {
    if (commandResult.reply) await sendTelegramMessage(botToken, chatId, commandResult.reply);
    return c.json({ ok: true });
  }
  const telegramScopedUserId = scopedChannelUserId(String(chatId), commandResult.activeSession);

  // Send initial typing indicator
  await sendTelegramTyping(botToken, chatId);

  // Build agent input — include media context
  const inputParts: string[] = [];

  // Strip bot mention from text for cleaner input
  const botInfo = chatType !== "private" ? await getTelegramBotInfo(botToken) : null;
  let cleanText = rawText.startsWith("/ask ") ? rawText.slice(5) : rawText;
  if (botInfo) cleanText = stripBotMention(cleanText, botInfo.username);
  if (cleanText) inputParts.push(cleanText);

  // Handle media: download and pass URL/description to agent
  const mediaUrls: string[] = [];
  const mediaTypes: string[] = [];

  if (parsed.fileId && (parsed.hasPhoto || parsed.hasDocument || parsed.hasVoice || parsed.hasAudio || parsed.hasVideo)) {
    const fileUrl = await getTelegramFileUrl(botToken, parsed.fileId);
    if (fileUrl) {
      mediaUrls.push(fileUrl);
      if (parsed.hasPhoto) {
        mediaTypes.push("image");
        inputParts.push("[User sent a photo]");
      } else if (parsed.hasVoice) {
        mediaTypes.push("audio/ogg");
        inputParts.push("[User sent a voice message]");
      } else if (parsed.hasAudio) {
        mediaTypes.push(parsed.mimeType || "audio/mpeg");
        inputParts.push(`[User sent audio${parsed.fileName ? ": " + parsed.fileName : ""}]`);
      } else if (parsed.hasDocument) {
        mediaTypes.push(parsed.mimeType || "application/octet-stream");
        inputParts.push(`[User sent document: ${parsed.fileName || "file"}]`);
        // For text-readable docs, try to inject content
        if (parsed.mimeType?.startsWith("text/") || /\.(txt|md|csv|json|yaml|yml|xml|log|py|js|ts|html|css)$/i.test(parsed.fileName)) {
          const downloaded = await downloadTelegramFile(botToken, parsed.fileId);
          if (downloaded && downloaded.bytes.byteLength < 100_000) {
            const textContent = new TextDecoder().decode(downloaded.bytes);
            inputParts.push(`[Content of ${parsed.fileName}]:\n${textContent}`);
          }
        }
      } else if (parsed.hasVideo) {
        mediaTypes.push(parsed.mimeType || "video/mp4");
        inputParts.push("[User sent a video]");
      }
    }
  }

  const input = inputParts.join("\n");
  if (!input) return c.json({ ok: true });

  // Resolve agent name
  const agentName = agentNameForCommand;

  // Invoke agent via RUNTIME service binding
  let typingHeartbeat: ReturnType<typeof setInterval> | null = null;
  let progressNudge: ReturnType<typeof setTimeout> | null = null;
  let statusMessageId: number | undefined;
  let output = "";
  try {
    // Keep Telegram "typing..." visible while longer jobs run.
    typingHeartbeat = setInterval(() => {
      sendTelegramTyping(botToken, chatId).catch(() => {});
    }, 4500);
    // For slower tasks, post one progress message and edit it later.
    progressNudge = setTimeout(() => {
      sendTelegramMessage(
        botToken,
        chatId,
        "Working on it... this one may take a little longer.",
      ).then((id) => {
        statusMessageId = id;
      }).catch(() => {});
    }, 12000);

    const resp = await c.env.RUNTIME.fetch("https://runtime/run", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(c.env.SERVICE_TOKEN ? { Authorization: `Bearer ${c.env.SERVICE_TOKEN}` } : {}),
      },
      body: JSON.stringify({
        agent_name: agentName,
        input,
        channel: "telegram",
        channel_user_id: telegramScopedUserId,
        org_id: orgId || undefined,
        // Pass media context so agent can process images/audio
        ...(mediaUrls.length > 0 ? { media_urls: mediaUrls, media_types: mediaTypes } : {}),
      }),
    });
    if (resp.status >= 400) {
      const errText = await resp.text().catch(() => "");
      output = `Sorry, I hit a runtime error (${resp.status}). Please try again. ${errText ? `\n\n${errText.slice(0, 180)}` : ""}`;
    } else {
      const data = await resp.json().catch(() => ({})) as Record<string, unknown>;
      output = typeof data.output === "string"
        ? data.output
        : typeof data.response === "string"
          ? data.response
          : "";
      if (!output) {
        output = "I finished processing but didn't produce a response. Please try rephrasing.";
      }
    }
  } catch (e: any) {
    output = `Sorry, I encountered an error: ${String(e.message).slice(0, 200)}`;
  } finally {
    if (typingHeartbeat) clearInterval(typingHeartbeat);
    if (progressNudge) clearTimeout(progressNudge);
  }

  if (statusMessageId) {
    await editTelegramMessage(
      botToken,
      chatId,
      statusMessageId,
      "Done. Sending your response now...",
    );
  }

  // Send reply with markdown-aware chunking
  if (output) {
    const chunks = chunkMessage(output, 4096);
    for (let i = 0; i < chunks.length; i++) {
      await sendTelegramMessage(botToken, chatId, chunks[i], i === 0 ? messageId : undefined);
    }
  }

  return c.json({ ok: true });
  });
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

  await withOrgDb(c.env, user.org_id, async (sql) => {
    const now = new Date().toISOString();
    // Store in secrets (RLS enforces org isolation)
    try {
      await sql`
        INSERT INTO secrets (name, encrypted_value, org_id, created_at, updated_at)
        VALUES ('TELEGRAM_BOT_TOKEN', ${botToken}, ${user.org_id}, ${now}, ${now})
        ON CONFLICT (org_id, name, project_id, env) DO UPDATE SET encrypted_value = EXCLUDED.encrypted_value, updated_at = EXCLUDED.updated_at
      `;
    } catch {}
  });

  // Register webhook to control-plane handler, which reads org-scoped secrets.
  const webhookUrl = `${new URL(c.req.url).origin}/api/v1/chat/telegram/webhook`;
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

  const botToken = await withOrgDb(c.env, user.org_id, async (sql) => {
    return await getTelegramToken(sql);
  });
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
  const botToken = await withOrgDb(c.env, user.org_id, async (sql) => {
    return await getTelegramToken(sql);
  });
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
  const botToken = await withOrgDb(c.env, user.org_id, async (sql) => {
    return await getTelegramToken(sql);
  });
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

  // Webhook is unauthenticated; org is resolved from channel_configs below.
  return await withAdminDb(c.env, async (sql) => {
  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      if (change.field !== "messages") continue;
      const value = change.value || {};
      const phoneNumberId = value.metadata?.phone_number_id || "";
      const messages = value.messages || [];

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

      const waToken = await getSecret(sql, "WHATSAPP_ACCESS_TOKEN", orgId);
      if (!waToken) continue;

      for (const msg of messages) {
        const from = String(msg.from || "");
        const msgId = msg.id || "";
        const msgType = msg.type || "";

        // Mark message as read immediately
        if (msgId) {
          await markWhatsAppRead(waToken, phoneNumberId, msgId);
        }

        // Build agent input from various message types
        const inputParts: string[] = [];
        const mediaUrls: string[] = [];
        const mediaTypes: string[] = [];

        if (msgType === "text" && msg.text?.body) {
          inputParts.push(String(msg.text.body));

        } else if (msgType === "image" && msg.image) {
          // Image message: download via Cloud API
          if (msg.image.caption) inputParts.push(String(msg.image.caption));
          inputParts.push("[User sent an image]");
          const mediaInfo = await downloadWhatsAppMedia(waToken, msg.image.id);
          if (mediaInfo) {
            mediaUrls.push(mediaInfo.url);
            mediaTypes.push(mediaInfo.mimeType || "image/jpeg");
          }

        } else if (msgType === "document" && msg.document) {
          // Document message
          const fileName = msg.document.filename || "document";
          if (msg.document.caption) inputParts.push(String(msg.document.caption));
          inputParts.push(`[User sent document: ${fileName}]`);
          const mediaInfo = await downloadWhatsAppMedia(waToken, msg.document.id);
          if (mediaInfo) {
            mediaUrls.push(mediaInfo.url);
            mediaTypes.push(mediaInfo.mimeType || "application/octet-stream");
          }

        } else if (msgType === "audio" && msg.audio) {
          // Audio message
          inputParts.push("[User sent an audio message]");
          const mediaInfo = await downloadWhatsAppMedia(waToken, msg.audio.id);
          if (mediaInfo) {
            mediaUrls.push(mediaInfo.url);
            mediaTypes.push(mediaInfo.mimeType || "audio/ogg");
          }

        } else if (msgType === "video" && msg.video) {
          // Video message
          if (msg.video.caption) inputParts.push(String(msg.video.caption));
          inputParts.push("[User sent a video]");
          const mediaInfo = await downloadWhatsAppMedia(waToken, msg.video.id);
          if (mediaInfo) {
            mediaUrls.push(mediaInfo.url);
            mediaTypes.push(mediaInfo.mimeType || "video/mp4");
          }

        } else if (msgType === "sticker" && msg.sticker) {
          inputParts.push("[User sent a sticker]");

        } else if (msgType === "location" && msg.location) {
          inputParts.push(`[User shared location: ${msg.location.latitude}, ${msg.location.longitude}${msg.location.name ? " — " + msg.location.name : ""}]`);

        } else if (msgType === "contacts" && msg.contacts?.length) {
          for (const contact of msg.contacts) {
            const name = contact.name?.formatted_name || "Unknown";
            const phone = contact.phones?.[0]?.phone || "";
            inputParts.push(`[User shared contact: ${name}${phone ? " " + phone : ""}]`);
          }

        } else if (msgType === "reaction" && msg.reaction) {
          // Reactions — acknowledge but don't invoke agent
          continue;

        } else {
          // Unsupported type — skip
          continue;
        }

        const input = inputParts.join("\n");
        if (!input) continue;

        const agentName = await resolveChannelAgent(sql, orgId, "whatsapp");
        const commandResult = await handleCommonChannelCommand(
          c.env,
          "whatsapp",
          msgType === "text" ? String(msg.text?.body || "") : "",
          agentName,
          orgId,
          from,
        );
        if (commandResult.handled) {
          if (phoneNumberId) {
            await sendWhatsAppText(waToken, phoneNumberId, from, commandResult.reply || "Done.", msgId);
          }
          continue;
        }
        const waScopedUserId = scopedChannelUserId(from, commandResult.activeSession);
        const output = await invokeAgent(c.env, agentName, input, "whatsapp", waScopedUserId, orgId);

        // Reply with markdown-aware chunking
        if (output && phoneNumberId) {
          await sendWhatsAppText(waToken, phoneNumberId, from, output, msgId);
        }
      }
    }
  }

  return c.json({ ok: true });
  });
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
  await withOrgDb(c.env, user.org_id, async (sql) => {
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
  });

  // Webhook URL points to deploy worker (handles all chat webhooks with ctx.waitUntil)
  const webhookUrl = `${c.env.RUNTIME_WORKER_URL}/chat/whatsapp/webhook`;

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

  // Handle messages (not bot), app_mentions, and file_share subtypes
  const isMessage = event.type === "message" && !event.bot_id && !event.subtype && event.text;
  const isFileShare = event.type === "message" && !event.bot_id && event.subtype === "file_share";
  const isMention = event.type === "app_mention" && event.text;
  if (!isMessage && !isMention && !isFileShare) return c.json({ ok: true });

  const channelId = event.channel || "";
  const userId = event.user || "";
  const teamId = payload.team_id || "";
  // Thread support: reply in thread if message is in a thread, or create thread from the message
  const threadTs = event.thread_ts || event.ts || "";

  // Resolve org from team_id (webhook is unauthenticated; admin DB)
  return await withAdminDb(c.env, async (sql) => {
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

  const botToken = await getSecret(sql, "SLACK_BOT_TOKEN", orgId);
  if (!botToken) return c.json({ ok: true });

  // Build input: text + file context
  const inputParts: string[] = [];
  const mediaUrls: string[] = [];
  const mediaTypes: string[] = [];

  // Strip @mentions from text
  const cleanText = String(event.text || "").replace(/<@[A-Z0-9]+>/g, "").trim();
  if (cleanText) inputParts.push(cleanText);

  // Handle file attachments (images, documents, etc.)
  if (event.files?.length) {
    for (const file of event.files) {
      const fileType = file.filetype || "";
      const fileName = file.name || "file";
      const mimeType = file.mimetype || "";

      if (mimeType.startsWith("image/") && file.url_private) {
        mediaUrls.push(file.url_private);
        mediaTypes.push(mimeType);
        inputParts.push(`[User shared image: ${fileName}]`);
      } else if (file.url_private) {
        mediaUrls.push(file.url_private);
        mediaTypes.push(mimeType || "application/octet-stream");
        inputParts.push(`[User shared file: ${fileName} (${fileType})]`);

        // For text-readable files, try to download and inject content
        if ((mimeType.startsWith("text/") || /^(txt|md|csv|json|yaml|yml|xml|log|py|js|ts|html|css)$/.test(fileType)) && (file.size || 0) < 100_000) {
          try {
            const dlResp = await fetch(file.url_private, {
              headers: { Authorization: `Bearer ${botToken}` },
            });
            if (dlResp.ok) {
              const content = await dlResp.text();
              inputParts.push(`[Content of ${fileName}]:\n${content}`);
            }
          } catch {}
        }
      }
    }
  }

  const input = inputParts.join("\n");
  if (!input) return c.json({ ok: true });

  const agentName = await resolveChannelAgent(sql, orgId, "slack");
  const commandResult = await handleCommonChannelCommand(
    c.env,
    "slack",
    cleanText,
    agentName,
    orgId,
    userId,
  );
  const slackScopedUserId = scopedChannelUserId(userId, commandResult.activeSession);
  const output = commandResult.handled
    ? (commandResult.reply || "Done.")
    : await invokeAgent(c.env, agentName, input, "slack", slackScopedUserId, orgId);

  // Reply via Slack Web API with chunking and thread support
  if (botToken && channelId && output) {
    const chunks = chunkMessage(output, 3000); // Slack limit ~4000 but leave room for formatting
    for (let i = 0; i < chunks.length; i++) {
      try {
        await fetch("https://slack.com/api/chat.postMessage", {
          method: "POST",
          headers: { Authorization: `Bearer ${botToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            channel: channelId,
            text: chunks[i],
            thread_ts: threadTs,
            // Unfurl links in first chunk only
            unfurl_links: i === 0,
            unfurl_media: i === 0,
          }),
        });
      } catch {}
    }
  }

  return c.json({ ok: true });
  });
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
  await withOrgDb(c.env, user.org_id, async (sql) => {
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
  });

  const webhookUrl = `${c.env.RUNTIME_WORKER_URL}/chat/slack/webhook`;
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

  // If state contains orgId, save automatically (state IS the org_id from
  // the OAuth init handshake; use withOrgDb so RLS enforces isolation)
  if (state && botToken && teamId) {
    try {
      await withOrgDb(c.env, state, async (sql) => {
        await storeSecret(sql, "SLACK_BOT_TOKEN", botToken, state);
        const now = new Date().toISOString();
        const config = JSON.stringify({ team_id: teamId, team_name: teamName });
        await sql`
          INSERT INTO channel_configs (org_id, channel, agent_name, config, is_active, created_at, updated_at)
          VALUES (${state}, 'slack', '', ${config}::jsonb, true, ${now}, ${now})
          ON CONFLICT (org_id, channel) DO UPDATE
          SET config = ${config}::jsonb, is_active = true, updated_at = ${now}
        `;
      });
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

  return await withAdminDb(c.env, async (sql) => {
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
  await withOrgDb(c.env, user.org_id, async (sql) => {
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
  });

  // Webhook URL points to deploy worker (handles all chat webhooks with ctx.waitUntil)
  const webhookUrl = `${c.env.RUNTIME_WORKER_URL}/chat/instagram/webhook`;
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

  return await withAdminDb(c.env, async (sql) => {
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
  await withOrgDb(c.env, user.org_id, async (sql) => {
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
  });

  // Webhook URL points to deploy worker (handles all chat webhooks with ctx.waitUntil)
  const webhookUrl = `${c.env.RUNTIME_WORKER_URL}/chat/messenger/webhook`;
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
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    let rows;
    if (agentName) {
      rows = await sql`
        SELECT channel, agent_name, is_active, config, created_at, updated_at
        FROM channel_configs WHERE agent_name = ${agentName} OR agent_name = ''
        ORDER BY channel
      `;
    } else {
      rows = await sql`
        SELECT channel, agent_name, is_active, config, created_at, updated_at
        FROM channel_configs
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
  return await withOrgDb(c.env, user.org_id, async (sql) => {
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
  await withOrgDb(c.env, user.org_id, async (sql) => {
    await sql`
      UPDATE channel_configs SET is_active = false, updated_at = ${new Date().toISOString()}
      WHERE channel = ${channel}
    `;
  });

  return c.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════
// Email Channel — auto-setup and remove custom domain email routing
// ═══════════════════════════════════════════════════════════════════════

const emailSetupRoute = createRoute({
  method: "post",
  path: "/email/setup",
  tags: ["Chat Platforms"],
  summary: "Set up email channel — auto-configures CF Email Routing for custom domains",
  middleware: [requireScope("agents:write")],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            agent_name: z.string().min(1),
            custom_email: z.string().email().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Email setup result", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(400, 404, 500),
  },
});

chatPlatformRoutes.openapi(emailSetupRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { agent_name, custom_email } = c.req.valid("json");

  const orgShort = user.org_id.slice(-8);
  const defaultEmail = `${agent_name}.${orgShort}@oneshots.co`;

  const setupResult = await withOrgDb(c.env, user.org_id, async (sql): Promise<{ notFound?: true } | { ok: true }> => {
    const agentRows = await sql`SELECT name FROM agents WHERE name = ${agent_name} LIMIT 1`;
    if (agentRows.length === 0) return { notFound: true };

    const now = new Date().toISOString();
    // Save config
    await sql`
      INSERT INTO channel_configs (org_id, channel, agent_name, is_active, config, created_at, updated_at)
      VALUES (${user.org_id}, 'email', ${agent_name}, true,
        ${JSON.stringify({ default_email: defaultEmail, custom_email: custom_email || null })}::jsonb, ${now}, ${now})
      ON CONFLICT (org_id, channel) DO UPDATE SET
        agent_name = ${agent_name}, is_active = true,
        config = ${JSON.stringify({ default_email: defaultEmail, custom_email: custom_email || null })}::jsonb,
        updated_at = ${now}
    `.catch(() => {});

    return { ok: true };
  });

  if ("notFound" in setupResult) return c.json({ error: "Agent not found" }, 404);

  let customDomainStatus = null;
  if (custom_email) {
    customDomainStatus = await setupEmailRouting(c.env, custom_email, agent_name);
  }

  return c.json({ ok: true, agent_name, default_email: defaultEmail, custom_email, custom_domain_status: customDomainStatus });
});

const emailRemoveRoute = createRoute({
  method: "post",
  path: "/email/remove",
  tags: ["Chat Platforms"],
  summary: "Remove custom email routing rule for an agent",
  middleware: [requireScope("agents:write")],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            agent_name: z.string().min(1),
            custom_email: z.string().email(),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Removal result", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(400, 500),
  },
});

chatPlatformRoutes.openapi(emailRemoveRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { agent_name, custom_email } = c.req.valid("json");

  // Remove the custom email from config
  const orgShort = user.org_id.slice(-8);
  const defaultEmail = `${agent_name}.${orgShort}@oneshots.co`;

  await withOrgDb(c.env, user.org_id, async (sql) => {
    const now = new Date().toISOString();
    await sql`
      UPDATE channel_configs SET config = ${JSON.stringify({ default_email: defaultEmail, custom_email: null })}::jsonb, updated_at = ${now}
      WHERE channel = 'email'
    `.catch(() => {});
  });

  // Try to remove the CF Email Routing rule
  const removeResult = await removeEmailRouting(c.env, custom_email);

  return c.json({ ok: true, removed: custom_email, result: removeResult });
});

// ── Helpers for CF Email Routing API ──

async function setupEmailRouting(env: any, email: string, agentName: string): Promise<Record<string, unknown>> {
  const domain = email.split("@")[1];
  const cfApiToken = env.CLOUDFLARE_API_TOKEN || "";
  const cfAccountId = env.CLOUDFLARE_ACCOUNT_ID || "";

  if (!cfApiToken || !cfAccountId) {
    return { status: "error", message: "Cloudflare API not configured" };
  }

  try {
    // Look up zone
    const zoneResp = await fetch(
      `https://api.cloudflare.com/client/v4/zones?name=${domain}&account.id=${cfAccountId}`,
      { headers: { Authorization: `Bearer ${cfApiToken}` } },
    );
    const zoneData = (await zoneResp.json()) as any;
    const zone = zoneData.result?.[0];

    if (zone) {
      // Domain on this account — create email routing rule
      const ruleResp = await fetch(
        `https://api.cloudflare.com/client/v4/zones/${zone.id}/email/routing/rules`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${cfApiToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            name: `OneShots: ${agentName} (${email})`,
            enabled: true,
            matchers: [{ type: "literal", field: "to", value: email }],
            actions: [{ type: "worker", value: ["agentos"] }],
          }),
        },
      );
      const ruleData = (await ruleResp.json()) as any;

      if (ruleData.success) {
        return { status: "active", message: `Routing active. Emails to ${email} → agent "${agentName}"`, rule_id: ruleData.result?.id };
      }
      return { status: "error", message: ruleData.errors?.[0]?.message || "Failed to create rule" };
    }

    // Domain not on this account — manual DNS setup needed
    return {
      status: "dns_required",
      message: `Add these DNS records to ${domain}, then enable Email Routing in Cloudflare:`,
      dns: [
        { type: "MX", name: domain, content: "route1.mx.cloudflare.net", priority: 69 },
        { type: "MX", name: domain, content: "route2.mx.cloudflare.net", priority: 27 },
        { type: "MX", name: domain, content: "route3.mx.cloudflare.net", priority: 93 },
        { type: "TXT", name: domain, content: "v=spf1 include:_spf.mx.cloudflare.net ~all" },
      ],
    };
  } catch (err: any) {
    return { status: "error", message: err.message };
  }
}

async function removeEmailRouting(env: any, email: string): Promise<Record<string, unknown>> {
  const domain = email.split("@")[1];
  const cfApiToken = env.CLOUDFLARE_API_TOKEN || "";
  const cfAccountId = env.CLOUDFLARE_ACCOUNT_ID || "";

  if (!cfApiToken || !cfAccountId) {
    return { status: "error", message: "Cloudflare API not configured" };
  }

  try {
    // Find the zone
    const zoneResp = await fetch(
      `https://api.cloudflare.com/client/v4/zones?name=${domain}&account.id=${cfAccountId}`,
      { headers: { Authorization: `Bearer ${cfApiToken}` } },
    );
    const zoneData = (await zoneResp.json()) as any;
    const zone = zoneData.result?.[0];
    if (!zone) return { status: "not_found", message: "Domain not on this account" };

    // List rules and find the one matching this email
    const rulesResp = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${zone.id}/email/routing/rules`,
      { headers: { Authorization: `Bearer ${cfApiToken}` } },
    );
    const rulesData = (await rulesResp.json()) as any;
    const rule = (rulesData.result || []).find((r: any) =>
      r.matchers?.some((m: any) => m.value === email),
    );

    if (!rule) return { status: "not_found", message: "No routing rule found for this email" };

    // Delete the rule
    const delResp = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${zone.id}/email/routing/rules/${rule.id}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${cfApiToken}` } },
    );
    const delData = (await delResp.json()) as any;

    if (delData.success) return { status: "removed", message: `Routing rule for ${email} removed` };
    return { status: "error", message: delData.errors?.[0]?.message || "Failed to remove rule" };
  } catch (err: any) {
    return { status: "error", message: err.message };
  }
}

// ══════════════════════════════════════════════════════════════════════════
// ██ SMS via Twilio
// ══════════════════════════════════════════════════════════════════════════

// POST /chat/sms/connect — Store Twilio credentials, configure webhook
const smsConnectRoute = createRoute({
  method: "post",
  path: "/sms/connect",
  tags: ["Chat Platforms"],
  summary: "Connect SMS via Twilio",
  middleware: [requireScope("integrations:write")],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            agent_name: z.string().default(""),
            account_sid: z.string().min(1),
            auth_token: z.string().min(1),
            phone_number: z.string().min(1),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Connected",
      content: {
        "application/json": {
          schema: z.object({
            ok: z.boolean(),
            webhook_url: z.string(),
            phone_number: z.string(),
            webhook_configured: z.boolean(),
          }),
        },
      },
    },
    ...errorResponses(400),
  },
});
chatPlatformRoutes.openapi(smsConnectRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const body = c.req.valid("json");
  await withOrgDb(c.env, user.org_id, async (sql) => {
    const now = new Date().toISOString();

    // Store Twilio credentials as secrets
    await storeSecret(sql, "TWILIO_ACCOUNT_SID", body.account_sid, user.org_id);
    await storeSecret(sql, "TWILIO_AUTH_TOKEN", body.auth_token, user.org_id);
    await storeSecret(sql, "TWILIO_PHONE_NUMBER", body.phone_number, user.org_id);

    // Save channel config
    const config = JSON.stringify({
      phone_number: body.phone_number,
      account_sid: body.account_sid,
    });
    await sql`
      INSERT INTO channel_configs (org_id, channel, agent_name, config, is_active, created_at, updated_at)
      VALUES (${user.org_id}, 'sms', ${body.agent_name || ""}, ${config}::jsonb, true, ${now}, ${now})
      ON CONFLICT (org_id, channel) DO UPDATE
      SET config = ${config}::jsonb, agent_name = COALESCE(NULLIF(${body.agent_name}, ''), channel_configs.agent_name),
          is_active = true, updated_at = ${now}
    `;
  });

  // Configure Twilio phone number webhook
  const webhookUrl = `${c.env.RUNTIME_WORKER_URL}/chat/sms/webhook`;
  let webhookConfigured = false;
  try {
    // First, find the phone number SID
    const authHeader = "Basic " + btoa(`${body.account_sid}:${body.auth_token}`);
    const listResp = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${body.account_sid}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(body.phone_number)}`,
      { headers: { Authorization: authHeader } },
    );
    const listData = (await listResp.json()) as any;
    const phoneNumbers = listData.incoming_phone_numbers || [];
    if (phoneNumbers.length > 0) {
      const phoneSid = phoneNumbers[0].sid;
      // Update the phone number's SMS webhook URL
      const updateResp = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${body.account_sid}/IncomingPhoneNumbers/${phoneSid}.json`,
        {
          method: "POST",
          headers: {
            Authorization: authHeader,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: `SmsUrl=${encodeURIComponent(webhookUrl)}&SmsMethod=POST`,
        },
      );
      webhookConfigured = updateResp.ok;
    }
  } catch {}

  return c.json({ ok: true, webhook_url: webhookUrl, phone_number: body.phone_number, webhook_configured: webhookConfigured });
});

// POST /chat/sms/webhook — Receive inbound SMS from Twilio
const smsWebhookRoute = createRoute({
  method: "post",
  path: "/sms/webhook",
  tags: ["Chat Platforms"],
  summary: "Receive inbound SMS via Twilio webhook",
  request: {
    body: {
      content: {
        "application/x-www-form-urlencoded": {
          schema: z.record(z.string()),
        },
      },
    },
  },
  responses: {
    200: {
      description: "TwiML response",
      content: { "text/xml": { schema: z.string() } },
    },
    401: { description: "Invalid signature", content: { "application/json": { schema: ErrorSchema } } },
  },
});
chatPlatformRoutes.openapi(smsWebhookRoute, async (c): Promise<any> => {
  // Parse form-urlencoded body
  const rawBody = await c.req.text();
  const params: Record<string, string> = {};
  for (const pair of rawBody.split("&")) {
    const [key, val] = pair.split("=").map(decodeURIComponent);
    if (key) params[key] = val || "";
  }

  const from = params.From || "";
  const to = params.To || "";
  const msgBody = params.Body || "";
  if (!from || !msgBody) {
    return new Response("<Response></Response>", { status: 200, headers: { "Content-Type": "text/xml" } });
  }

  // Webhook is unauthenticated; resolve org from channel_configs.
  return await withAdminDb(c.env, async (sql) => {
  // Look up org from channel_configs by phone number
  let orgId = "";
  try {
    const rows = await sql`
      SELECT org_id FROM channel_configs
      WHERE channel = 'sms' AND config->>'phone_number' = ${to} AND is_active = true
      LIMIT 1
    `;
    if (rows.length > 0) orgId = String(rows[0].org_id);
  } catch {}

  if (!orgId) {
    return new Response(
      "<Response><Message>This number is not configured.</Message></Response>",
      { status: 200, headers: { "Content-Type": "text/xml" } },
    );
  }

  // Validate Twilio request signature
  const authToken = await getSecret(sql, "TWILIO_AUTH_TOKEN", orgId);
  const twilioSig = c.req.header("X-Twilio-Signature") ?? "";
  const requestUrl = `${c.env.RUNTIME_WORKER_URL}/chat/sms/webhook`;
  if (authToken && twilioSig) {
    const valid = await verifyTwilioSignature(authToken, requestUrl, params, twilioSig);
    if (!valid) {
      return c.json({ error: "Invalid Twilio signature" }, 401);
    }
  }

  // Resolve agent and invoke
  const agentName = await resolveChannelAgent(sql, orgId, "sms");
  const output = await invokeAgent(c.env, agentName, msgBody, "sms", from, orgId);

  // Respond with TwiML — Twilio sends the <Message> content back as SMS
  const safeOutput = (output || "Sorry, I could not process your message.").slice(0, 1600);
  const twiml = `<Response><Message>${safeOutput.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</Message></Response>`;
  return new Response(twiml, { status: 200, headers: { "Content-Type": "text/xml" } });
  });
});

// DELETE /chat/sms/disconnect — Remove Twilio webhook and deactivate channel
const smsDisconnectRoute = createRoute({
  method: "post",
  path: "/sms/disconnect",
  tags: ["Chat Platforms"],
  summary: "Disconnect SMS (Twilio) channel",
  middleware: [requireScope("integrations:write")],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            agent_name: z.string().default(""),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Disconnected", content: { "application/json": { schema: z.object({ ok: z.boolean() }) } } },
    ...errorResponses(400),
  },
});
chatPlatformRoutes.openapi(smsDisconnectRoute, async (c): Promise<any> => {
  const user = c.get("user");
  return await withOrgDb(c.env, user.org_id, async (sql) => {

  // Get stored credentials to remove webhook
  const accountSid = await getSecret(sql, "TWILIO_ACCOUNT_SID", user.org_id);
  const authToken = await getSecret(sql, "TWILIO_AUTH_TOKEN", user.org_id);
  const phoneNumber = await getSecret(sql, "TWILIO_PHONE_NUMBER", user.org_id);

  if (accountSid && authToken && phoneNumber) {
    try {
      const authHeader = "Basic " + btoa(`${accountSid}:${authToken}`);
      const listResp = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(phoneNumber)}`,
        { headers: { Authorization: authHeader } },
      );
      const listData = (await listResp.json()) as any;
      const phoneNumbers = listData.incoming_phone_numbers || [];
      if (phoneNumbers.length > 0) {
        const phoneSid = phoneNumbers[0].sid;
        // Clear the SMS webhook URL
        await fetch(
          `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/IncomingPhoneNumbers/${phoneSid}.json`,
          {
            method: "POST",
            headers: {
              Authorization: authHeader,
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: "SmsUrl=&SmsMethod=POST",
          },
        );
      }
    } catch {}
  }

  // Deactivate the channel config
  const now = new Date().toISOString();
  await sql`
    UPDATE channel_configs SET is_active = false, updated_at = ${now}
    WHERE channel = 'sms'
  `;

  return c.json({ ok: true });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// ██ TikTok DMs
// ══════════════════════════════════════════════════════════════════════════

const TIKTOK_API = "https://open.tiktokapis.com/v2";

// GET /chat/tiktok/webhook — TikTok webhook verification
const tiktokVerifyRoute = createRoute({
  method: "get",
  path: "/tiktok/webhook",
  tags: ["Chat Platforms"],
  summary: "TikTok webhook verification challenge",
  request: {
    query: z.object({
      challenge: z.string().optional(),
    }),
  },
  responses: {
    200: { description: "Challenge response", content: { "application/json": { schema: z.object({ challenge: z.string() }) } } },
  },
});
chatPlatformRoutes.openapi(tiktokVerifyRoute, async (c): Promise<any> => {
  const query = c.req.valid("query");
  const challenge = query.challenge || "";
  return c.json({ challenge });
});

// POST /chat/tiktok/webhook — Receive TikTok DM events
const tiktokWebhookRoute = createRoute({
  method: "post",
  path: "/tiktok/webhook",
  tags: ["Chat Platforms"],
  summary: "Receive TikTok DM webhook events",
  request: { body: { content: { "application/json": { schema: z.record(z.unknown()) } } } },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: z.object({ ok: z.boolean() }) } } },
  },
});
chatPlatformRoutes.openapi(tiktokWebhookRoute, async (c): Promise<any> => {
  let payload: any;
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ ok: true });
  }

  // TikTok sends events with event type
  const event = payload.event || "";
  if (event !== "receive_message") return c.json({ ok: true });

  const content = payload.content || {};
  const msgText = content.text || "";
  const senderId = content.sender_id || payload.user?.open_id || "";
  const conversationId = content.conversation_id || "";
  if (!msgText || !senderId) return c.json({ ok: true });

  // Webhook is unauthenticated; resolve org from channel_configs.
  return await withAdminDb(c.env, async (sql) => {
  // Resolve org from channel_configs
  let orgId = "";
  try {
    const rows = await sql`
      SELECT org_id FROM channel_configs
      WHERE channel = 'tiktok' AND is_active = true
      ORDER BY created_at ASC LIMIT 1
    `;
    if (rows.length > 0) orgId = String(rows[0].org_id);
  } catch {}

  if (!orgId) return c.json({ ok: true });

  // Invoke agent
  const agentName = await resolveChannelAgent(sql, orgId, "tiktok");
  const output = await invokeAgent(c.env, agentName, msgText, "tiktok", senderId, orgId);

  // Reply via TikTok Send Message API
  if (output) {
    const accessToken = await getSecret(sql, "TIKTOK_ACCESS_TOKEN", orgId);
    if (accessToken) {
      try {
        await fetch(`${TIKTOK_API}/direct_message/send/`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            conversation_id: conversationId,
            text: output.slice(0, 1000),
          }),
        });
      } catch {}
    }
  }

  return c.json({ ok: true });
  });
});

// POST /chat/tiktok/connect — Store TikTok credentials
const tiktokConnectRoute = createRoute({
  method: "post",
  path: "/tiktok/connect",
  tags: ["Chat Platforms"],
  summary: "Connect TikTok DM channel",
  middleware: [requireScope("integrations:write")],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            agent_name: z.string().default(""),
            client_key: z.string().min(1),
            client_secret: z.string().min(1),
            access_token: z.string().min(1),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Connected",
      content: {
        "application/json": {
          schema: z.object({
            ok: z.boolean(),
            webhook_url: z.string(),
            webhook_subscribed: z.boolean(),
          }),
        },
      },
    },
    ...errorResponses(400),
  },
});
chatPlatformRoutes.openapi(tiktokConnectRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const body = c.req.valid("json");
  await withOrgDb(c.env, user.org_id, async (sql) => {
    const now = new Date().toISOString();

    // Store TikTok credentials as secrets
    await storeSecret(sql, "TIKTOK_CLIENT_KEY", body.client_key, user.org_id);
    await storeSecret(sql, "TIKTOK_CLIENT_SECRET", body.client_secret, user.org_id);
    await storeSecret(sql, "TIKTOK_ACCESS_TOKEN", body.access_token, user.org_id);

    // Save channel config
    const config = JSON.stringify({
      client_key: body.client_key,
    });
    await sql`
      INSERT INTO channel_configs (org_id, channel, agent_name, config, is_active, created_at, updated_at)
      VALUES (${user.org_id}, 'tiktok', ${body.agent_name || ""}, ${config}::jsonb, true, ${now}, ${now})
      ON CONFLICT (org_id, channel) DO UPDATE
      SET config = ${config}::jsonb, agent_name = COALESCE(NULLIF(${body.agent_name}, ''), channel_configs.agent_name),
          is_active = true, updated_at = ${now}
    `;
  });

  // Register webhook with TikTok
  const webhookUrl = `${c.env.RUNTIME_WORKER_URL}/chat/tiktok/webhook`;
  let webhookSubscribed = false;
  try {
    const resp = await fetch(`${TIKTOK_API}/webhook/subscribe/`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${body.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        event_type: "direct_message",
        callback_url: webhookUrl,
      }),
    });
    webhookSubscribed = resp.ok;
  } catch {}

  return c.json({ ok: true, webhook_url: webhookUrl, webhook_subscribed: webhookSubscribed });
});

// POST /chat/tiktok/disconnect — Unsubscribe webhook and deactivate channel
const tiktokDisconnectRoute = createRoute({
  method: "post",
  path: "/tiktok/disconnect",
  tags: ["Chat Platforms"],
  summary: "Disconnect TikTok DM channel",
  middleware: [requireScope("integrations:write")],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            agent_name: z.string().default(""),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Disconnected", content: { "application/json": { schema: z.object({ ok: z.boolean() }) } } },
    ...errorResponses(400),
  },
});
chatPlatformRoutes.openapi(tiktokDisconnectRoute, async (c): Promise<any> => {
  const user = c.get("user");
  return await withOrgDb(c.env, user.org_id, async (sql) => {

  // Attempt to unsubscribe webhook
  const accessToken = await getSecret(sql, "TIKTOK_ACCESS_TOKEN", user.org_id);
  if (accessToken) {
    try {
      await fetch(`${TIKTOK_API}/webhook/unsubscribe/`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ event_type: "direct_message" }),
      });
    } catch {}
  }

  // Deactivate the channel config
  const now = new Date().toISOString();
  await sql`
    UPDATE channel_configs SET is_active = false, updated_at = ${now}
    WHERE channel = 'tiktok'
  `;

  return c.json({ ok: true });
  });
});
