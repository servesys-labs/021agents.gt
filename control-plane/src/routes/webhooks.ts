/**
 * Webhooks router — CRUD + test delivery + delivery history + replay + secret rotation.
 * Ported from agentos/api/routers/webhooks.py
 */
import { Hono } from "hono";
import type { Env } from "../env";
import type { CurrentUser } from "../auth/types";
import { getDb, getDbForOrg } from "../db/client";
import { requireScope } from "../middleware/auth";

type R = { Bindings: Env; Variables: { user: CurrentUser } };
export const webhookRoutes = new Hono<R>();

function genId(): string {
  const arr = new Uint8Array(6);
  crypto.getRandomValues(arr);
  return [...arr].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function validateCallbackUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) return "Invalid webhook URL";
    const host = parsed.hostname;
    if (!host) return "Invalid webhook URL";
    if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) {
      return "Webhook URL host is not allowed";
    }
    // Basic private IP check
    if (/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|127\.)/.test(host)) {
      return "Webhook URL host is not allowed";
    }
    return null;
  } catch {
    return "Invalid webhook URL";
  }
}

webhookRoutes.get("/", requireScope("webhooks:read"), async (c) => {
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const rows = await sql`
    SELECT * FROM webhooks WHERE org_id = ${user.org_id} ORDER BY created_at DESC
  `;
  return c.json(
    rows.map((r: any) => ({
      webhook_id: r.webhook_id,
      url: r.url,
      events: (() => { try { return JSON.parse(r.events); } catch { return []; } })(),
      is_active: Boolean(r.is_active),
      failure_count: Number(r.failure_count || 0),
      last_triggered_at: r.last_triggered_at || null,
    })),
  );
});

webhookRoutes.post("/", requireScope("webhooks:write"), async (c) => {
  const user = c.get("user");
  const body = await c.req.json();
  const url = String(body.url || "").trim();
  const events = Array.isArray(body.events) ? body.events : [];
  const codemodeHandlerId = body.codemode_handler_id || null;

  // If no codemode handler, URL is required
  if (!codemodeHandlerId) {
    const urlError = validateCallbackUrl(url);
    if (urlError) return c.json({ error: urlError }, 400);
  }

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const webhookId = genId();
  const secret = genId() + genId();
  const eventsJson = JSON.stringify(events);

  await sql`
    INSERT INTO webhooks (webhook_id, org_id, url, secret, events, codemode_handler_id)
    VALUES (${webhookId}, ${user.org_id}, ${url || ''}, ${secret}, ${eventsJson}, ${codemodeHandlerId})
  `;

  return c.json({ webhook_id: webhookId, url: url || null, events, codemode_handler_id: codemodeHandlerId });
});

webhookRoutes.put("/:webhook_id", requireScope("webhooks:write"), async (c) => {
  const user = c.get("user");
  const webhookId = c.req.param("webhook_id");
  const body = await c.req.json();
  const url = String(body.url || "").trim();
  const events = body.events;
  const isActive = body.is_active;

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  if (url) {
    const urlError = validateCallbackUrl(url);
    if (urlError) return c.json({ error: urlError }, 400);
    await sql`UPDATE webhooks SET url = ${url} WHERE webhook_id = ${webhookId} AND org_id = ${user.org_id}`;
  }
  if (events !== undefined) {
    const eventsJson = JSON.stringify(events);
    await sql`UPDATE webhooks SET events = ${eventsJson} WHERE webhook_id = ${webhookId} AND org_id = ${user.org_id}`;
  }
  if (isActive !== undefined) {
    await sql`UPDATE webhooks SET is_active = ${isActive ? 1 : 0} WHERE webhook_id = ${webhookId} AND org_id = ${user.org_id}`;
  }

  return c.json({ updated: webhookId });
});

webhookRoutes.delete("/:webhook_id", requireScope("webhooks:write"), async (c) => {
  const user = c.get("user");
  const webhookId = c.req.param("webhook_id");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const result = await sql`
    DELETE FROM webhooks WHERE webhook_id = ${webhookId} AND org_id = ${user.org_id}
  `;
  if (result.count === 0) return c.json({ error: "Webhook not found" }, 404);
  return c.json({ deleted: webhookId });
});

webhookRoutes.post("/:webhook_id/test", requireScope("webhooks:write"), async (c) => {
  const user = c.get("user");
  const webhookId = c.req.param("webhook_id");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const rows = await sql`
    SELECT * FROM webhooks WHERE webhook_id = ${webhookId} AND org_id = ${user.org_id}
  `;
  if (rows.length === 0) return c.json({ error: "Webhook not found" }, 404);
  const webhook = rows[0] as any;

  const payload = {
    event: "test",
    timestamp: Date.now() / 1000,
    data: { message: "This is a test webhook delivery from AgentOS" },
  };

  try {
    const start = performance.now();
    const resp = await fetch(webhook.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-AgentOS-Secret": webhook.secret,
      },
      body: JSON.stringify(payload),
    });
    const duration = performance.now() - start;
    const respText = await resp.text().catch(() => "");

    // Log delivery
    await sql`
      INSERT INTO webhook_deliveries (webhook_id, event_type, payload_json, response_status, response_body, duration_ms, success)
      VALUES (${webhookId}, 'test', ${JSON.stringify(payload)}, ${resp.status}, ${respText.slice(0, 500)}, ${duration}, ${resp.status < 400})
    `;

    return c.json({ status: resp.status, duration_ms: Math.round(duration * 10) / 10, success: resp.status < 400 });
  } catch (e: any) {
    return c.json({ status: 0, error: e.message, success: false });
  }
});

webhookRoutes.get("/:webhook_id/deliveries", requireScope("webhooks:read"), async (c) => {
  const user = c.get("user");
  const webhookId = c.req.param("webhook_id");
  const limit = Math.min(200, Math.max(1, Number(c.req.query("limit")) || 50));
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const wh = await sql`
    SELECT webhook_id FROM webhooks WHERE webhook_id = ${webhookId} AND org_id = ${user.org_id}
  `;
  if (wh.length === 0) return c.json({ error: "Webhook not found" }, 404);

  const rows = await sql`
    SELECT * FROM webhook_deliveries WHERE webhook_id = ${webhookId}
    ORDER BY created_at DESC LIMIT ${limit}
  `;
  return c.json({ deliveries: rows });
});

webhookRoutes.post("/:webhook_id/deliveries/:delivery_id/replay", requireScope("webhooks:write"), async (c) => {
  const user = c.get("user");
  const webhookId = c.req.param("webhook_id");
  const deliveryId = c.req.param("delivery_id");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const wh = await sql`
    SELECT * FROM webhooks WHERE webhook_id = ${webhookId} AND org_id = ${user.org_id}
  `;
  if (wh.length === 0) return c.json({ error: "Webhook not found" }, 404);
  const webhook = wh[0] as any;

  const deliveries = await sql`
    SELECT * FROM webhook_deliveries WHERE id = ${deliveryId} AND webhook_id = ${webhookId}
  `;
  if (deliveries.length === 0) return c.json({ error: "Delivery not found" }, 404);
  const delivery = deliveries[0] as any;

  let payload: any;
  try { payload = JSON.parse(delivery.payload_json || "{}"); } catch { payload = {}; }

  try {
    const start = performance.now();
    const resp = await fetch(webhook.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-AgentOS-Secret": webhook.secret,
      },
      body: JSON.stringify(payload),
    });
    const duration = performance.now() - start;
    const respText = await resp.text().catch(() => "");

    await sql`
      INSERT INTO webhook_deliveries (webhook_id, event_type, payload_json, response_status, response_body, duration_ms, success)
      VALUES (${webhookId}, ${delivery.event_type || "replay"}, ${JSON.stringify(payload)}, ${resp.status}, ${respText.slice(0, 500)}, ${duration}, ${resp.status < 400})
    `;

    return c.json({
      replayed: deliveryId,
      status: resp.status,
      duration_ms: Math.round(duration * 10) / 10,
      success: resp.status < 400,
    });
  } catch (e: any) {
    return c.json({ replayed: deliveryId, status: 0, error: e.message, success: false });
  }
});

// -- POST /webhooks/:webhook_id/incoming -- Process incoming webhook via codemode handler --
webhookRoutes.post("/:webhook_id/incoming", async (c) => {
  const webhookId = c.req.param("webhook_id");
  const sql = await getDb(c.env.HYPERDRIVE);

  const rows = await sql`
    SELECT * FROM webhooks WHERE webhook_id = ${webhookId} AND is_active = 1
  `;
  if (rows.length === 0) return c.json({ error: "Webhook not found or inactive" }, 404);
  const webhook = rows[0] as any;

  // Verify secret
  const providedSecret = c.req.header("X-AgentOS-Secret") || c.req.header("x-agentos-secret") || "";
  if (webhook.secret && providedSecret !== webhook.secret) {
    return c.json({ error: "Invalid webhook secret" }, 401);
  }

  const payload = await c.req.json().catch(() => ({}));

  // If webhook has a codemode handler, process via codemode
  if (webhook.codemode_handler_id) {
    try {
      // Collect incoming headers
      const headers: Record<string, string> = {};
      c.req.raw.headers.forEach((v: string, k: string) => { headers[k] = v; });

      const resp = await c.env.RUNTIME.fetch(
        new Request("https://runtime/api/v1/codemode/webhook-handler", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(c.env.SERVICE_TOKEN ? { Authorization: `Bearer ${c.env.SERVICE_TOKEN}` } : {}),
          },
          body: JSON.stringify({
            snippet_id: webhook.codemode_handler_id,
            org_id: webhook.org_id,
            payload,
            headers,
          }),
        }),
      );
      const result = await resp.json() as Record<string, unknown>;

      // Log delivery
      await sql`
        INSERT INTO webhook_deliveries (webhook_id, event_type, payload_json, response_status, response_body, duration_ms, success)
        VALUES (${webhookId}, 'codemode', ${JSON.stringify(payload)}, ${resp.status}, ${JSON.stringify(result).slice(0, 500)}, ${0}, ${Boolean(result.processed)})
      `.catch(() => {});

      return c.json(result);
    } catch (err) {
      console.error("[webhook] codemode handler failed:", err);
      return c.json({ error: "Webhook codemode handler failed" }, 502);
    }
  }

  // No codemode handler — forward to webhook URL as before
  if (!webhook.url) return c.json({ error: "Webhook has no URL or codemode handler" }, 400);

  try {
    const start = performance.now();
    const resp = await fetch(webhook.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-AgentOS-Secret": webhook.secret },
      body: JSON.stringify(payload),
    });
    const duration = performance.now() - start;
    const respText = await resp.text().catch(() => "");

    await sql`
      INSERT INTO webhook_deliveries (webhook_id, event_type, payload_json, response_status, response_body, duration_ms, success)
      VALUES (${webhookId}, 'incoming', ${JSON.stringify(payload)}, ${resp.status}, ${respText.slice(0, 500)}, ${duration}, ${resp.status < 400})
    `.catch(() => {});

    return c.json({ status: resp.status, duration_ms: Math.round(duration * 10) / 10, success: resp.status < 400 });
  } catch (e: any) {
    return c.json({ status: 0, error: e.message, success: false });
  }
});

webhookRoutes.post("/:webhook_id/rotate-secret", requireScope("webhooks:write"), async (c) => {
  const user = c.get("user");
  const webhookId = c.req.param("webhook_id");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const rows = await sql`
    SELECT webhook_id FROM webhooks WHERE webhook_id = ${webhookId} AND org_id = ${user.org_id}
  `;
  if (rows.length === 0) return c.json({ error: "Webhook not found" }, 404);

  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  const newSecret = [...arr].map((b) => b.toString(16).padStart(2, "0")).join("");

  await sql`
    UPDATE webhooks SET secret = ${newSecret} WHERE webhook_id = ${webhookId} AND org_id = ${user.org_id}
  `;

  return c.json({ webhook_id: webhookId, secret: newSecret, rotated: true });
});
