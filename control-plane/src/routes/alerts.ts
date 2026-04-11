/**
 * Alert configuration routes — CRUD for metric-based alerts with webhook delivery.
 *
 * Alerts monitor error_rate, latency_p95, cost_daily, agent_down,
 * webhook_failures, and batch_failures. When a threshold is breached,
 * a webhook is fired and an alert_history row is recorded.
 */
import { createRoute, z } from "@hono/zod-openapi";
import { createOpenAPIRouter } from "../lib/openapi";
import { ErrorSchema, errorResponses } from "../schemas/openapi";
import type { CurrentUser } from "../auth/types";
import { withOrgDb } from "../db/client";
import { requireScope } from "../middleware/auth";
import { deliverWebhook } from "../logic/webhook-delivery";

export const alertRoutes = createOpenAPIRouter();

const VALID_TYPES = new Set([
  "error_rate",
  "latency_p95",
  "cost_daily",
  "agent_down",
  "webhook_failures",
  "batch_failures",
]);
const VALID_COMPARISONS = new Set(["gte", "lte", "gt", "lt"]);

// ── GET / — List alert configs for the org ────────────────────────────────
const listAlertsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Alerts"],
  summary: "List alert configs for the org",
  middleware: [requireScope("observability:write")],
  responses: {
    200: { description: "Alert config list", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(401, 403),
  },
});
alertRoutes.openapi(listAlertsRoute, async (c): Promise<any> => {
  const user = c.get("user");
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const rows = await sql`
      SELECT * FROM alert_configs
      ORDER BY created_at DESC
    `;

    return c.json({ alerts: rows });
  });
});

// ── POST / — Create alert config ──────────────────────────────────────────
const createAlertRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Alerts"],
  summary: "Create alert config",
  middleware: [requireScope("observability:write")],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            name: z.string().min(1),
            type: z.string(),
            threshold: z.number(),
            comparison: z.string().optional(),
            window_minutes: z.number().optional(),
            webhook_url: z.string().optional(),
            webhook_secret: z.string().optional(),
            agent_name: z.string().optional(),
            cooldown_minutes: z.number().optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: { description: "Alert config created", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(400, 401, 403),
  },
});
alertRoutes.openapi(createAlertRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const body = c.req.valid("json");

  const name = String(body.name || "").trim();
  const type = String(body.type || "");
  const threshold = Number(body.threshold);
  const comparison = String(body.comparison || "gte");
  const windowMinutes = Number(body.window_minutes || 60);
  const webhookUrl = String(body.webhook_url || "");
  const webhookSecret = String(body.webhook_secret || "");
  const agentName = String(body.agent_name || "");
  const cooldownMinutes = Number(body.cooldown_minutes || 15);

  if (!name) return c.json({ error: "name is required" }, 400);
  if (!VALID_TYPES.has(type)) return c.json({ error: `Invalid alert type: ${type}` }, 400);
  if (!VALID_COMPARISONS.has(comparison)) return c.json({ error: `Invalid comparison: ${comparison}` }, 400);
  if (isNaN(threshold)) return c.json({ error: "threshold must be a number" }, 400);

  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const rows = await sql`
      INSERT INTO alert_configs (org_id, name, alert_type, agent_name, threshold, comparison, window_minutes, webhook_url, webhook_secret, cooldown_minutes)
      VALUES (${user.org_id}, ${name}, ${type}, ${agentName}, ${threshold}, ${comparison}, ${windowMinutes}, ${webhookUrl}, ${webhookSecret}, ${cooldownMinutes})
      RETURNING *
    `;

    return c.json({ alert: rows[0] }, 201);
  });
});

// ── PUT /{id} — Update alert config ────────────────────────────────────────
const updateAlertRoute = createRoute({
  method: "put",
  path: "/{id}",
  tags: ["Alerts"],
  summary: "Update alert config",
  middleware: [requireScope("observability:write")],
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            name: z.string().optional(),
            type: z.string().optional(),
            threshold: z.number().optional(),
            comparison: z.string().optional(),
            window_minutes: z.number().optional(),
            webhook_url: z.string().optional(),
            webhook_secret: z.string().optional(),
            agent_name: z.string().optional(),
            cooldown_minutes: z.number().optional(),
            is_active: z.boolean().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Alert config updated", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(400, 401, 403, 404),
  },
});
alertRoutes.openapi(updateAlertRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");

  return await withOrgDb(c.env, user.org_id, async (sql) => {
    // Verify ownership (RLS enforces org isolation)
    const existing = await sql`
      SELECT id FROM alert_configs WHERE id = ${id}
    `;
    if (!existing.length) return c.json({ error: "Alert config not found" }, 404);

    // Build typed update values (null = keep existing via COALESCE)
    let uName: string | null = null;
    let uType: string | null = null;
    let uThreshold: number | null = null;
    let uComparison: string | null = null;
    let uWindowMinutes: number | null = null;
    let uWebhookUrl: string | null = null;
    let uWebhookSecret: string | null = null;
    let uAgentName: string | null = null;
    let uCooldownMinutes: number | null = null;
    let uEnabled: boolean | null = null;

    if (body.name !== undefined) uName = String(body.name).trim();
    if (body.type !== undefined) {
      if (!VALID_TYPES.has(body.type)) return c.json({ error: `Invalid alert type: ${body.type}` }, 400);
      uType = body.type;
    }
    if (body.threshold !== undefined) uThreshold = Number(body.threshold);
    if (body.comparison !== undefined) {
      if (!VALID_COMPARISONS.has(body.comparison)) return c.json({ error: `Invalid comparison: ${body.comparison}` }, 400);
      uComparison = body.comparison;
    }
    if (body.window_minutes !== undefined) uWindowMinutes = Number(body.window_minutes);
    if (body.webhook_url !== undefined) uWebhookUrl = String(body.webhook_url);
    if (body.webhook_secret !== undefined) uWebhookSecret = String(body.webhook_secret);
    if (body.agent_name !== undefined) uAgentName = String(body.agent_name);
    if (body.cooldown_minutes !== undefined) uCooldownMinutes = Number(body.cooldown_minutes);
    if (body.is_active !== undefined) uEnabled = Boolean(body.is_active);

    const rows = await sql`
      UPDATE alert_configs SET
        name = COALESCE(${uName}, name),
        alert_type = COALESCE(${uType}, alert_type),
        threshold = COALESCE(${uThreshold}, threshold),
        comparison = COALESCE(${uComparison}, comparison),
        window_minutes = COALESCE(${uWindowMinutes}, window_minutes),
        webhook_url = COALESCE(${uWebhookUrl}, webhook_url),
        webhook_secret = COALESCE(${uWebhookSecret}, webhook_secret),
        agent_name = COALESCE(${uAgentName}, agent_name),
        cooldown_minutes = COALESCE(${uCooldownMinutes}, cooldown_minutes),
        is_active = COALESCE(${uEnabled}, is_active),
        updated_at = now()
      WHERE id = ${id}
      RETURNING *
    `;

    return c.json({ alert: rows[0] });
  });
});

// ── DELETE /{id} — Delete alert config ─────────────────────────────────────
const deleteAlertRoute = createRoute({
  method: "delete",
  path: "/{id}",
  tags: ["Alerts"],
  summary: "Delete alert config",
  middleware: [requireScope("observability:write")],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: { description: "Alert config deleted", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(401, 403),
  },
});
alertRoutes.openapi(deleteAlertRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { id } = c.req.valid("param");
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    await sql`DELETE FROM alert_configs WHERE id = ${id}`;
    return c.json({ deleted: id });
  });
});

// ── GET /history — Recent alert history (last 7 days) ─────────────────────
const alertHistoryRoute = createRoute({
  method: "get",
  path: "/history",
  tags: ["Alerts"],
  summary: "Recent alert history (last 7 days)",
  middleware: [requireScope("observability:write")],
  request: {
    query: z.object({
      limit: z.coerce.number().optional(),
    }),
  },
  responses: {
    200: { description: "Alert history", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(401, 403),
  },
});
alertRoutes.openapi(alertHistoryRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const query = c.req.valid("query");
  const limit = Math.min(Number(query.limit || 100), 500);
  const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();

  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const rows = await sql`
      SELECT h.*, ac.name as alert_name
      FROM alert_history h
      LEFT JOIN alert_configs ac ON ac.id = h.alert_config_id
      WHERE h.created_at >= ${since}
      ORDER BY h.created_at DESC
      LIMIT ${limit}
    `;

    return c.json({ history: rows });
  });
});

// ── POST /{id}/test — Fire a test alert ────────────────────────────────────
const testAlertRoute = createRoute({
  method: "post",
  path: "/{id}/test",
  tags: ["Alerts"],
  summary: "Fire a test alert",
  middleware: [requireScope("observability:write")],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: { description: "Test alert result", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(400, 401, 403, 404),
  },
});
alertRoutes.openapi(testAlertRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { id } = c.req.valid("param");
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const rows = await sql`
      SELECT * FROM alert_configs WHERE id = ${id}
    `;
    if (!rows.length) return c.json({ error: "Alert config not found" }, 404);

    const config = rows[0] as any;
    if (!config.webhook_url) {
      return c.json({ error: "No webhook_url configured for this alert" }, 400);
    }

    const testPayload = {
      event: "alert.test",
      timestamp: new Date().toISOString(),
      data: {
        alert_config_id: config.id,
        alert_name: config.name,
        type: config.type,
        agent_name: config.agent_name || "(all)",
        metric_value: 0,
        threshold: Number(config.threshold),
        comparison: config.comparison,
        test: true,
      },
    };

    const delivered = await deliverWebhook(
      config.webhook_url,
      JSON.stringify(testPayload),
      config.webhook_secret || "",
    );

    return c.json({ delivered, payload: testPayload });
  });
});
