/**
 * Webhooks router — CRUD + test delivery + delivery history + replay + secret rotation.
 */
import { createRoute, z } from "@hono/zod-openapi";
import { createOpenAPIRouter } from "../lib/openapi";
import { ErrorSchema, errorResponses, WebhookCreateBody } from "../schemas/openapi";
import { withOrgDb, withAdminDb } from "../db/client";
import { requireScope } from "../middleware/auth";
import { parseJsonColumn } from "../lib/parse-json-column";

export const webhookRoutes = createOpenAPIRouter();

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

// ── GET /webhooks ───────────────────────────────────────────────────────

const listWebhooksRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Webhooks"],
  summary: "List all webhooks",
  middleware: [requireScope("webhooks:read")],
  responses: {
    200: {
      description: "List of webhooks",
      content: { "application/json": { schema: z.array(z.record(z.unknown())) } },
    },
  },
});
webhookRoutes.openapi(listWebhooksRoute, async (c): Promise<any> => {
  const user = c.get("user");
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const rows = await sql`
      SELECT * FROM webhooks ORDER BY created_at DESC
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
});

// ── POST /webhooks ──────────────────────────────────────────────────────

const createWebhookRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Webhooks"],
  summary: "Create a webhook",
  middleware: [requireScope("webhooks:write")],
  request: {
    body: {
      content: {
        "application/json": { schema: WebhookCreateBody },
      },
    },
  },
  responses: {
    200: {
      description: "Webhook created",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(400),
  },
});
webhookRoutes.openapi(createWebhookRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const body = c.req.valid("json");
  const url = String(body.url || "").trim();
  const events = Array.isArray(body.events) ? body.events : [];
  const codemodeHandlerId = body.codemode_handler_id || null;

  // If no codemode handler, URL is required
  if (!codemodeHandlerId) {
    const urlError = validateCallbackUrl(url);
    if (urlError) return c.json({ error: urlError }, 400);
  }

  const webhookId = genId();
  const secret = genId() + genId();
  const eventsJson = JSON.stringify(events);

  return await withOrgDb(c.env, user.org_id, async (sql) => {
    await sql`
      INSERT INTO webhooks (id, org_id, url, secret, events, codemode_handler_id)
      VALUES (${webhookId}, ${user.org_id}, ${url || ''}, ${secret}, ${eventsJson}, ${codemodeHandlerId})
    `;

    return c.json({ webhook_id: webhookId, url: url || null, events, codemode_handler_id: codemodeHandlerId });
  });
});

// ── PUT /webhooks/:webhook_id ───────────────────────────────────────────

const updateWebhookRoute = createRoute({
  method: "put",
  path: "/{webhook_id}",
  tags: ["Webhooks"],
  summary: "Update a webhook",
  middleware: [requireScope("webhooks:write")],
  request: {
    params: z.object({ webhook_id: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            url: z.string().optional(),
            events: z.array(z.string()).optional(),
            is_active: z.boolean().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Webhook updated",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(400),
  },
});
webhookRoutes.openapi(updateWebhookRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { webhook_id: webhookId } = c.req.valid("param");
  const body = c.req.valid("json");
  const url = String(body.url || "").trim();
  const events = body.events;
  const isActive = body.is_active;

  return await withOrgDb(c.env, user.org_id, async (sql) => {
    if (url) {
      const urlError = validateCallbackUrl(url);
      if (urlError) return c.json({ error: urlError }, 400);
      await sql`UPDATE webhooks SET url = ${url} WHERE webhook_id = ${webhookId}`;
    }
    if (events !== undefined) {
      const eventsJson = JSON.stringify(events);
      await sql`UPDATE webhooks SET events = ${eventsJson} WHERE webhook_id = ${webhookId}`;
    }
    if (isActive !== undefined) {
      await sql`UPDATE webhooks SET is_active = ${isActive ? 1 : 0} WHERE webhook_id = ${webhookId}`;
    }

    return c.json({ updated: webhookId });
  });
});

// ── DELETE /webhooks/:webhook_id ────────────────────────────────────────

const deleteWebhookRoute = createRoute({
  method: "delete",
  path: "/{webhook_id}",
  tags: ["Webhooks"],
  summary: "Delete a webhook",
  middleware: [requireScope("webhooks:write")],
  request: {
    params: z.object({ webhook_id: z.string() }),
  },
  responses: {
    200: {
      description: "Webhook deleted",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(404),
  },
});
webhookRoutes.openapi(deleteWebhookRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { webhook_id: webhookId } = c.req.valid("param");
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const result = await sql`
      DELETE FROM webhooks WHERE webhook_id = ${webhookId}
    `;
    if (result.count === 0) return c.json({ error: "Webhook not found" }, 404);
    return c.json({ deleted: webhookId });
  });
});

// ── POST /webhooks/:webhook_id/test ─────────────────────────────────────

const testWebhookRoute = createRoute({
  method: "post",
  path: "/{webhook_id}/test",
  tags: ["Webhooks"],
  summary: "Send a test delivery to a webhook",
  middleware: [requireScope("webhooks:write")],
  request: {
    params: z.object({ webhook_id: z.string() }),
  },
  responses: {
    200: {
      description: "Test delivery result",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(404),
  },
});
webhookRoutes.openapi(testWebhookRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { webhook_id: webhookId } = c.req.valid("param");
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const rows = await sql`
      SELECT * FROM webhooks WHERE webhook_id = ${webhookId}
    `;
    if (rows.length === 0) return c.json({ error: "Webhook not found" }, 404);
    const webhook = rows[0] as any;

    const payload = {
      event: "test",
      timestamp: Date.now() / 1000,
      data: { message: "This is a test webhook delivery from OneShots" },
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

      // Log delivery (webhook_deliveries is NOT RLS — relies on FK to webhooks)
      await sql`
        INSERT INTO webhook_deliveries (webhook_id, event_type, payload, status_code, response_body, duration_ms, success)
        VALUES (${webhookId}, 'test', ${JSON.stringify(payload)}, ${resp.status}, ${respText.slice(0, 500)}, ${duration}, ${resp.status < 400})
      `;

      return c.json({ status: resp.status, duration_ms: Math.round(duration * 10) / 10, success: resp.status < 400 });
    } catch (e: any) {
      return c.json({ status: 0, error: e.message, success: false });
    }
  });
});

// ── GET /webhooks/:webhook_id/deliveries ────────────────────────────────

const listDeliveriesRoute = createRoute({
  method: "get",
  path: "/{webhook_id}/deliveries",
  tags: ["Webhooks"],
  summary: "List delivery history for a webhook",
  middleware: [requireScope("webhooks:read")],
  request: {
    params: z.object({ webhook_id: z.string() }),
    query: z.object({
      limit: z.coerce.number().int().min(1).max(200).default(50).optional(),
    }),
  },
  responses: {
    200: {
      description: "Delivery history",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(404),
  },
});
webhookRoutes.openapi(listDeliveriesRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { webhook_id: webhookId } = c.req.valid("param");
  const query = c.req.valid("query");
  const limit = Math.min(200, Math.max(1, Number(query.limit) || 50));
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    // Verify webhook ownership via RLS
    const wh = await sql`
      SELECT webhook_id FROM webhooks WHERE webhook_id = ${webhookId}
    `;
    if (wh.length === 0) return c.json({ error: "Webhook not found" }, 404);

    // webhook_deliveries is NOT RLS — gated above by the webhooks RLS check
    const rows = await sql`
      SELECT * FROM webhook_deliveries WHERE webhook_id = ${webhookId}
      ORDER BY created_at DESC LIMIT ${limit}
    `;
    return c.json({ deliveries: rows });
  });
});

// ── POST /webhooks/:webhook_id/deliveries/:delivery_id/replay ───────────

const replayDeliveryRoute = createRoute({
  method: "post",
  path: "/{webhook_id}/deliveries/{delivery_id}/replay",
  tags: ["Webhooks"],
  summary: "Replay a webhook delivery",
  middleware: [requireScope("webhooks:write")],
  request: {
    params: z.object({
      webhook_id: z.string(),
      delivery_id: z.string(),
    }),
  },
  responses: {
    200: {
      description: "Replay result",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(404),
  },
});
webhookRoutes.openapi(replayDeliveryRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { webhook_id: webhookId, delivery_id: deliveryId } = c.req.valid("param");
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const wh = await sql`
      SELECT * FROM webhooks WHERE webhook_id = ${webhookId}
    `;
    if (wh.length === 0) return c.json({ error: "Webhook not found" }, 404);
    const webhook = wh[0] as any;

    const deliveries = await sql`
      SELECT * FROM webhook_deliveries WHERE id = ${deliveryId} AND webhook_id = ${webhookId}
    `;
    if (deliveries.length === 0) return c.json({ error: "Delivery not found" }, 404);
    const delivery = deliveries[0] as any;

    let payload: any;
    payload = parseJsonColumn(delivery.payload);

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
        INSERT INTO webhook_deliveries (webhook_id, event_type, payload, status_code, response_body, duration_ms, success)
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
});

// ── POST /webhooks/:webhook_id/incoming ─────────────────────────────────

const incomingWebhookRoute = createRoute({
  method: "post",
  path: "/{webhook_id}/incoming",
  tags: ["Webhooks"],
  summary: "Process incoming webhook via codemode handler",
  request: {
    params: z.object({ webhook_id: z.string() }),
  },
  responses: {
    200: {
      description: "Incoming webhook processed",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(400, 401, 404),
  },
});
webhookRoutes.openapi(incomingWebhookRoute, async (c): Promise<any> => {
  const { webhook_id: webhookId } = c.req.valid("param");

  // Incoming webhook is unauthenticated — look up the webhook + secret via
  // admin connection so we can find ANY org's webhook by id, then verify
  // secret before doing any side effects.
  const webhook = await withAdminDb(c.env, async (sql) => {
    const rows = await sql`
      SELECT * FROM webhooks WHERE webhook_id = ${webhookId} AND is_active = true
    `;
    return rows.length > 0 ? (rows[0] as any) : null;
  });

  if (!webhook) return c.json({ error: "Webhook not found or inactive" }, 404);

  // Verify secret
  const providedSecret = c.req.header("X-AgentOS-Secret") || c.req.header("x-agentos-secret") || "";
  if (webhook.secret && providedSecret !== webhook.secret) {
    return c.json({ error: "Invalid webhook secret" }, 401);
  }

  const payload = await c.req.json().catch(() => ({}));
  const webhookOrgId = String(webhook.org_id || "");

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
            org_id: webhookOrgId,
            payload,
            headers,
          }),
        }),
      );
      const result = await resp.json() as Record<string, unknown>;

      // Log delivery under the webhook owner's org RLS context
      if (webhookOrgId) {
        await withOrgDb(c.env, webhookOrgId, (sql) => sql`
          INSERT INTO webhook_deliveries (webhook_id, event_type, payload, status_code, response_body, duration_ms, success)
          VALUES (${webhookId}, 'codemode', ${JSON.stringify(payload)}, ${resp.status}, ${JSON.stringify(result).slice(0, 500)}, ${0}, ${Boolean(result.processed)})
        `).catch(() => {});
      }

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

    if (webhookOrgId) {
      await withOrgDb(c.env, webhookOrgId, (sql) => sql`
        INSERT INTO webhook_deliveries (webhook_id, event_type, payload, status_code, response_body, duration_ms, success)
        VALUES (${webhookId}, 'incoming', ${JSON.stringify(payload)}, ${resp.status}, ${respText.slice(0, 500)}, ${duration}, ${resp.status < 400})
      `).catch(() => {});
    }

    return c.json({ status: resp.status, duration_ms: Math.round(duration * 10) / 10, success: resp.status < 400 });
  } catch (e: any) {
    return c.json({ status: 0, error: e.message, success: false });
  }
});

// ── POST /webhooks/:webhook_id/rotate-secret ────────────────────────────

const rotateSecretRoute = createRoute({
  method: "post",
  path: "/{webhook_id}/rotate-secret",
  tags: ["Webhooks"],
  summary: "Rotate webhook secret",
  middleware: [requireScope("webhooks:write")],
  request: {
    params: z.object({ webhook_id: z.string() }),
  },
  responses: {
    200: {
      description: "Secret rotated",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(404),
  },
});
webhookRoutes.openapi(rotateSecretRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { webhook_id: webhookId } = c.req.valid("param");
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const rows = await sql`
      SELECT webhook_id FROM webhooks WHERE webhook_id = ${webhookId}
    `;
    if (rows.length === 0) return c.json({ error: "Webhook not found" }, 404);

    const arr = new Uint8Array(32);
    crypto.getRandomValues(arr);
    const newSecret = [...arr].map((b) => b.toString(16).padStart(2, "0")).join("");

    await sql`
      UPDATE webhooks SET secret = ${newSecret} WHERE webhook_id = ${webhookId}
    `;

    return c.json({ webhook_id: webhookId, secret: newSecret, rotated: true });
  });
});
