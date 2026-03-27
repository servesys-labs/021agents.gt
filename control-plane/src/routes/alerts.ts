/**
 * Alert configuration routes — CRUD for metric-based alerts with webhook delivery.
 *
 * Alerts monitor error_rate, latency_p95, cost_daily, agent_down,
 * webhook_failures, and batch_failures. When a threshold is breached,
 * a webhook is fired and an alert_history row is recorded.
 */
import { Hono } from "hono";
import type { Env } from "../env";
import type { CurrentUser } from "../auth/types";
import { getDbForOrg } from "../db/client";
import { requireScope } from "../middleware/auth";
import { deliverWebhook } from "../logic/webhook-delivery";

type R = { Bindings: Env; Variables: { user: CurrentUser } };
export const alertRoutes = new Hono<R>();

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
alertRoutes.get("/", requireScope("observability:write"), async (c) => {
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const rows = await sql`
    SELECT * FROM alert_configs
    WHERE org_id = ${user.org_id}
    ORDER BY created_at DESC
  `;

  return c.json({ alerts: rows });
});

// ── POST / — Create alert config ──────────────────────────────────────────
alertRoutes.post("/", requireScope("observability:write"), async (c) => {
  const user = c.get("user");
  const body = await c.req.json();

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

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const rows = await sql`
    INSERT INTO alert_configs (org_id, name, type, agent_name, threshold, comparison, window_minutes, webhook_url, webhook_secret, cooldown_minutes)
    VALUES (${user.org_id}, ${name}, ${type}, ${agentName}, ${threshold}, ${comparison}, ${windowMinutes}, ${webhookUrl}, ${webhookSecret}, ${cooldownMinutes})
    RETURNING *
  `;

  return c.json({ alert: rows[0] }, 201);
});

// ── PUT /:id — Update alert config ────────────────────────────────────────
alertRoutes.put("/:id", requireScope("observability:write"), async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const body = await c.req.json();

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  // Verify ownership
  const existing = await sql`
    SELECT id FROM alert_configs WHERE id = ${id} AND org_id = ${user.org_id}
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
  if (body.enabled !== undefined) uEnabled = Boolean(body.enabled);

  const rows = await sql`
    UPDATE alert_configs SET
      name = COALESCE(${uName}, name),
      type = COALESCE(${uType}, type),
      threshold = COALESCE(${uThreshold}, threshold),
      comparison = COALESCE(${uComparison}, comparison),
      window_minutes = COALESCE(${uWindowMinutes}, window_minutes),
      webhook_url = COALESCE(${uWebhookUrl}, webhook_url),
      webhook_secret = COALESCE(${uWebhookSecret}, webhook_secret),
      agent_name = COALESCE(${uAgentName}, agent_name),
      cooldown_minutes = COALESCE(${uCooldownMinutes}, cooldown_minutes),
      enabled = COALESCE(${uEnabled}, enabled),
      updated_at = now()
    WHERE id = ${id} AND org_id = ${user.org_id}
    RETURNING *
  `;

  return c.json({ alert: rows[0] });
});

// ── DELETE /:id — Delete alert config ─────────────────────────────────────
alertRoutes.delete("/:id", requireScope("observability:write"), async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  await sql`DELETE FROM alert_configs WHERE id = ${id} AND org_id = ${user.org_id}`;

  return c.json({ deleted: id });
});

// ── GET /history — Recent alert history (last 7 days) ─────────────────────
alertRoutes.get("/history", requireScope("observability:write"), async (c) => {
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const limit = Math.min(Number(c.req.query("limit") || 100), 500);
  const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();

  const rows = await sql`
    SELECT h.*, ac.name as alert_name
    FROM alert_history h
    LEFT JOIN alert_configs ac ON ac.id = h.alert_config_id
    WHERE h.org_id = ${user.org_id}
      AND h.created_at >= ${since}
    ORDER BY h.created_at DESC
    LIMIT ${limit}
  `;

  return c.json({ history: rows });
});

// ── POST /:id/test — Fire a test alert ────────────────────────────────────
alertRoutes.post("/:id/test", requireScope("observability:write"), async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const rows = await sql`
    SELECT * FROM alert_configs WHERE id = ${id} AND org_id = ${user.org_id}
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
