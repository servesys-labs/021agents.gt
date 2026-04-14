/**
 * Email Channel — CF Email Workers for inbound, fetch API for outbound.
 *
 * Inbound: CF Email Routing → Worker email() handler → agent
 * Outbound: MailChannels API (free for CF Workers) or custom SMTP
 *
 * Auto-reply detection prevents infinite loops.
 * Supports threading via In-Reply-To / References headers.
 */

import { type ChannelMessage, runAgent, stripMarkdown } from "./adapter";
import { isAutoReplyEmail } from "agents/email";

interface EmailEnv {
  AGENT_CORE: Fetcher;
}

// ── Inbound email handler (called from Worker email() export) ──

export async function handleInboundEmail(
  message: ForwardableEmailMessage,
  env: EmailEnv,
  agentName: string,
  orgId: string,
): Promise<void> {
  // Auto-reply detection — prevent infinite loops
  const headerArray = [...message.headers].map(([key, value]) => ({ key, value }));
  if (isAutoReplyEmail(headerArray)) {
    console.log(`[email] Skipping auto-reply from ${message.from}`);
    return;
  }

  const from = message.from;
  const to = message.to;
  const subject = message.headers.get("subject") || "(no subject)";
  const messageId = message.headers.get("message-id") || "";

  // Read email body (text/plain preferred)
  let body = "";
  try {
    const reader = message.raw.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    const raw = new TextDecoder().decode(
      chunks.reduce((acc, c) => new Uint8Array([...acc, ...c]), new Uint8Array()),
    );
    // Simple text/plain extraction
    const plainMatch = raw.match(/Content-Type:\s*text\/plain[\s\S]*?\r?\n\r?\n([\s\S]*?)(?:\r?\n--|\r?\n\r?\n)/i);
    body = plainMatch ? plainMatch[1].trim() : raw.slice(0, 4000);
  } catch {
    body = `Email from ${from}: ${subject}`;
  }

  const input = `[Email from ${from}]\nSubject: ${subject}\n\n${body}`.slice(0, 8000);

  // Run agent
  try {
    const result = await runAgent(env.AGENT_CORE, {
      text: input,
      channel: "email",
      userId: from,
      orgId,
      agentName,
      replyTo: messageId,
    });

    // Reply via MIME
    const replyMime = buildMIME({
      from: to, to: from,
      subject: `Re: ${subject}`,
      body: stripMarkdown(result.text),
      inReplyTo: messageId,
    });

    await message.reply(new Response(replyMime) as any);
  } catch (err) {
    console.error(`[email] Agent run failed for ${from}:`, err);
    const errMime = buildMIME({
      from: to, to: from,
      subject: `Re: ${subject}`,
      body: "I'm sorry, I wasn't able to process your email. Please try again later.",
      inReplyTo: messageId,
    });
    await message.reply(new Response(errMime) as any).catch(() => {});
  }
}

// ── Outbound email (for agent-initiated emails) ──

export async function sendEmail(opts: {
  from: string;
  to: string;
  subject: string;
  body: string;
  inReplyTo?: string;
}): Promise<boolean> {
  // MailChannels API — free for Cloudflare Workers
  try {
    const resp = await fetch("https://api.mailchannels.net/tx/v1/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: opts.to }] }],
        from: { email: opts.from },
        subject: opts.subject,
        content: [{ type: "text/plain", value: opts.body }],
      }),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

// ── MIME builder ──

function buildMIME(opts: { from: string; to: string; subject: string; body: string; inReplyTo?: string }): string {
  const mid = `<${crypto.randomUUID()}@agent.harness>`;
  let mime = `From: ${opts.from}\r\n`;
  mime += `To: ${opts.to}\r\n`;
  mime += `Subject: ${opts.subject}\r\n`;
  mime += `Message-ID: ${mid}\r\n`;
  mime += `Date: ${new Date().toUTCString()}\r\n`;
  if (opts.inReplyTo) {
    mime += `In-Reply-To: ${opts.inReplyTo}\r\n`;
    mime += `References: ${opts.inReplyTo}\r\n`;
  }
  mime += `MIME-Version: 1.0\r\n`;
  mime += `Content-Type: text/plain; charset=UTF-8\r\n`;
  mime += `\r\n`;
  mime += opts.body;
  return mime;
}
