/**
 * Alert evaluation logic — checks each enabled alert config against
 * live metrics and fires webhooks when thresholds are breached.
 *
 * Called from the cron handler on a regular schedule.
 */
import type { Sql } from "../db/client";
import { deliverWebhook } from "./webhook-delivery";

export interface FiredAlert {
  alert_config_id: string;
  name: string;
  type: string;
  agent_name: string;
  metric_value: number;
  threshold: number;
  comparison: string;
  webhook_delivered: boolean;
}

/**
 * Compare a metric value against a threshold using the given operator.
 */
function isBreached(value: number, threshold: number, comparison: string): boolean {
  switch (comparison) {
    case "gte": return value >= threshold;
    case "lte": return value <= threshold;
    case "gt": return value > threshold;
    case "lt": return value < threshold;
    default: return false;
  }
}

/**
 * Evaluate all enabled alerts for an org and fire any that are breached.
 *
 * Returns an array of alerts that were fired in this evaluation cycle.
 */
export async function evaluateAlerts(sql: Sql, orgId: string): Promise<FiredAlert[]> {
  // 1. Fetch all enabled alert configs for the org
  const configs = await sql`
    SELECT * FROM alert_configs
    WHERE org_id = ${orgId} AND is_active = true
  `;

  const fired: FiredAlert[] = [];

  for (const row of configs) {
    const config = row as any;
    const windowInterval = `${config.window_minutes} minutes`;

    // Check cooldown — skip if recently triggered
    if (config.last_triggered_at) {
      const cooldownEnd = new Date(config.last_triggered_at).getTime() + config.cooldown_minutes * 60_000;
      if (Date.now() < cooldownEnd) continue;
    }

    // 2. Query the relevant metric
    let metricValue: number | null = null;

    try {
      switch (config.type) {
        case "error_rate": {
          const agentFilter = config.agent_name
            ? sql`AND agent_name = ${config.agent_name}`
            : sql``;
          const rows = await sql`
            SELECT
              COUNT(*) as total,
              SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as errors
            FROM sessions
            WHERE org_id = ${orgId}
              AND created_at > now() - ${windowInterval}::interval
              ${agentFilter}
          `;
          const total = Number(rows[0]?.total || 0);
          const errors = Number(rows[0]?.errors || 0);
          metricValue = total > 0 ? errors / total : 0;
          break;
        }

        case "latency_p95": {
          const agentFilter = config.agent_name
            ? sql`AND agent_name = ${config.agent_name}`
            : sql``;
          const rows = await sql`
            SELECT PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY wall_clock_seconds) as val
            FROM sessions
            WHERE org_id = ${orgId}
              AND created_at > now() - ${windowInterval}::interval
              ${agentFilter}
          `;
          metricValue = rows[0]?.val != null ? Number(rows[0].val) : null;
          break;
        }

        case "cost_daily": {
          const agentFilter = config.agent_name
            ? sql`AND agent_name = ${config.agent_name}`
            : sql``;
          const rows = await sql`
            SELECT COALESCE(SUM(amount_usd), 0) as val
            FROM billing_events
            WHERE org_id = ${orgId}
              AND created_at > now() - interval '24 hours'
              ${agentFilter}
          `;
          metricValue = Number(rows[0]?.val || 0);
          break;
        }

        case "agent_down": {
          // Metric: minutes since last successful session for the agent.
          // Threshold is in minutes. Fires when agent hasn't had a success in > threshold minutes.
          if (!config.agent_name) break; // agent_down requires a specific agent
          const rows = await sql`
            SELECT MAX(created_at) as last_success
            FROM sessions
            WHERE org_id = ${orgId}
              AND agent_name = ${config.agent_name}
              AND status = 'success'
          `;
          if (rows[0]?.last_success) {
            const lastSuccess = new Date(rows[0].last_success).getTime();
            metricValue = (Date.now() - lastSuccess) / 60_000; // minutes since last success
          } else {
            metricValue = Infinity; // never succeeded
          }
          break;
        }

        case "webhook_failures": {
          const rows = await sql`
            SELECT COUNT(*) FILTER (WHERE success = false) as val
            FROM webhook_deliveries
            WHERE created_at > now() - ${windowInterval}::interval
          `;
          metricValue = Number(rows[0]?.val || 0);
          break;
        }

        case "batch_failures": {
          const agentFilter = config.agent_name
            ? sql`AND agent_name = ${config.agent_name}`
            : sql``;
          const rows = await sql`
            SELECT COUNT(*) as val
            FROM batch_jobs
            WHERE org_id = ${orgId}
              AND status = 'failed'
              AND created_at > now() - ${windowInterval}::interval
              ${agentFilter}
          `;
          metricValue = Number(rows[0]?.val || 0);
          break;
        }
      }
    } catch (err) {
      console.error(`[alert-evaluator] Failed to query metric for alert ${config.id} (${config.type}):`, err);
      continue;
    }

    if (metricValue === null) continue;

    // 3. Compare metric to threshold
    if (!isBreached(metricValue, Number(config.threshold), config.comparison)) continue;

    // 4. Threshold breached — fire alert
    let webhookDelivered = false;

    // Deliver webhook if configured
    if (config.webhook_url) {
      const alertPayload = {
        event: "alert.fired",
        timestamp: new Date().toISOString(),
        data: {
          alert_config_id: config.id,
          alert_name: config.name,
          type: config.type,
          agent_name: config.agent_name || "(all)",
          metric_value: metricValue === Infinity ? null : metricValue,
          threshold: Number(config.threshold),
          comparison: config.comparison,
          window_minutes: config.window_minutes,
        },
      };

      try {
        webhookDelivered = await deliverWebhook(
          config.webhook_url,
          JSON.stringify(alertPayload),
          config.webhook_secret || "",
        );
      } catch {
        // Webhook delivery is best-effort
      }
    }

    // Insert alert_history row
    try {
      await sql`
        INSERT INTO alert_history (org_id, alert_config_id, type, agent_name, metric_value, threshold, status, webhook_delivered)
        VALUES (
          ${orgId},
          ${config.id},
          ${config.type},
          ${config.agent_name || ""},
          ${metricValue === Infinity ? -1 : metricValue},
          ${Number(config.threshold)},
          'fired',
          ${webhookDelivered}
        )
      `;
    } catch (err) {
      console.error(`[alert-evaluator] Failed to insert alert_history for ${config.id}:`, err);
    }

    // Update last_triggered_at
    try {
      await sql`
        UPDATE alert_configs SET last_triggered_at = now() WHERE id = ${config.id}
      `;
    } catch {}

    fired.push({
      alert_config_id: config.id,
      name: config.name,
      type: config.type,
      agent_name: config.agent_name || "",
      metric_value: metricValue === Infinity ? -1 : metricValue,
      threshold: Number(config.threshold),
      comparison: config.comparison,
      webhook_delivered: webhookDelivered,
    });
  }

  return fired;
}
