/**
 * Webhook delivery for agent-output events.
 *
 * After an agent run completes via the public API, this module:
 *   1. Looks up active webhooks for the org that subscribe to "agent.run.completed"
 *   2. Signs the payload with HMAC-SHA256 using the webhook secret
 *   3. Delivers to each webhook URL with retry (via JOB_QUEUE)
 *
 * Webhook payload format:
 * {
 *   "event": "agent.run.completed",
 *   "timestamp": "2026-03-27T...",
 *   "data": {
 *     "agent_name": "my-bot",
 *     "session_id": "...",
 *     "conversation_id": "...",
 *     "output": "...",
 *     "success": true,
 *     "turns": 3,
 *     "tool_calls": 1,
 *     "cost_usd": 0.005,
 *     "latency_ms": 2340,
 *     "model": "deepseek/deepseek-chat-v3-0324"
 *   }
 * }
 */

import type { Sql } from "../db/client";
import type { WebhookEventType } from "../telemetry/events";

export interface AgentRunEvent {
  agent_name: string;
  session_id: string;
  conversation_id?: string | null;
  output: string;
  success: boolean;
  turns: number;
  tool_calls: number;
  cost_usd: number;
  latency_ms: number;
  model: string;
}

/**
 * Sign a webhook payload with HMAC-SHA256.
 */
async function signPayload(payload: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Dispatch agent.run.completed webhooks for an org.
 *
 * Fire-and-forget: errors are logged but don't block the caller.
 * For guaranteed delivery, use the JOB_QUEUE to enqueue deliveries.
 */
export async function dispatchRunCompletedWebhooks(
  sql: Sql,
  orgId: string,
  event: AgentRunEvent,
  jobQueue?: { send(msg: unknown): Promise<void> },
): Promise<void> {
  try {
    // Find active webhooks that subscribe to agent.run.completed
    const rows = await sql`
      SELECT webhook_id, url, secret, events
      FROM webhooks
      WHERE org_id = ${orgId} AND is_active = true
    `;

    const payload = {
      event: "agent.run.completed",
      timestamp: new Date().toISOString(),
      data: event,
    };

    const payloadJson = JSON.stringify(payload);

    for (const row of rows) {
      // Check if this webhook subscribes to agent.run.completed
      let events: string[] = [];
      try {
        events = typeof row.events === "string" ? JSON.parse(row.events) : row.events || [];
      } catch {}

      if (events.length > 0 && !events.includes("agent.run.completed") && !events.includes("*")) {
        continue;
      }

      // If job queue available, dispatch async (guaranteed delivery with retry)
      if (jobQueue) {
        await jobQueue.send({
          type: "webhook_delivery",
          payload: {
            webhook_id: row.webhook_id,
            url: row.url,
            secret: row.secret || "",
            body: payloadJson,
            org_id: orgId,
            event_type: "agent.run.completed" satisfies WebhookEventType,
          },
        }).catch(() => {});
      } else {
        // Direct delivery (best-effort)
        deliverWebhook(row.url, payloadJson, row.secret || "", sql, row.webhook_id).catch(() => {});
      }
    }
  } catch (err) {
    console.error("[webhook] Failed to dispatch run completed webhooks:", err);
  }
}

/**
 * Validate webhook URL against SSRF blocklist.
 */
function validateWebhookUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) return "Invalid webhook URL protocol";
    const host = parsed.hostname;
    if (!host) return "Invalid webhook URL";
    // Block private/internal networks
    if (host === "localhost" || host === "0.0.0.0" || host.endsWith(".local") || host.endsWith(".internal")) {
      return "Webhook URL host not allowed (internal)";
    }
    if (/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|127\.|169\.254\.)/.test(host)) {
      return "Webhook URL host not allowed (private IP)";
    }
    // Block metadata endpoints
    if (host === "metadata.google.internal" || host === "169.254.169.254") {
      return "Webhook URL host not allowed (cloud metadata)";
    }
    return null;
  } catch {
    return "Invalid webhook URL";
  }
}

/**
 * Deliver a single webhook with signature and record the result.
 */
export async function deliverWebhook(
  url: string,
  body: string,
  secret: string,
  sql?: Sql,
  webhookId?: string,
): Promise<boolean> {
  // SSRF protection: block internal/private URLs
  const urlErr = validateWebhookUrl(url);
  if (urlErr) {
    console.warn(`[webhook] Blocked delivery to ${url}: ${urlErr}`);
    return false;
  }

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signaturePayload = `${timestamp}.${body}`;
  const signature = secret ? await signPayload(signaturePayload, secret) : "";

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "AgentOS-Webhook/1.0",
    "X-AgentOS-Timestamp": timestamp,
  };
  if (signature) {
    headers["X-AgentOS-Signature"] = `sha256=${signature}`;
  }

  let status = 0;
  let success = false;
  let responseBody = "";

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(10_000),
    });
    status = resp.status;
    success = resp.ok;
    responseBody = await resp.text().catch(() => "");
  } catch (err) {
    responseBody = err instanceof Error ? err.message : String(err);
  }

  // Record delivery attempt
  if (sql && webhookId) {
    try {
      await sql`
        INSERT INTO webhook_deliveries (webhook_id, event_type, status_code, success, response_body, created_at)
        VALUES (${webhookId}, 'agent.run.completed', ${status}, ${success}, ${responseBody.slice(0, 1000)}, now())
      `;
    } catch {}
  }

  return success;
}
