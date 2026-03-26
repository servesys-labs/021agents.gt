/**
 * Billing router — usage, daily breakdown, trace cost, invoices, pricing catalog.
 * Ported from agentos/api/routers/billing.py
 */
import { Hono } from "hono";
import type { Env } from "../env";
import type { CurrentUser } from "../auth/types";
import { getDb, getDbForOrg } from "../db/client";
import { hasRole } from "../auth/types";
import { requireScope } from "../middleware/auth";

type R = { Bindings: Env; Variables: { user: CurrentUser } };
export const billingRoutes = new Hono<R>();

billingRoutes.get("/usage", requireScope("billing:read"), async (c) => {
  const user = c.get("user");
  const sinceDays = Math.max(1, Math.min(365, Number(c.req.query("since_days")) || 30));
  const since = Date.now() / 1000 - sinceDays * 86400;
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  // Total summary
  const [summary] = await sql`
    SELECT
      COALESCE(SUM(total_cost_usd), 0) as total_cost_usd,
      COALESCE(SUM(CASE WHEN cost_type = 'inference' THEN total_cost_usd ELSE 0 END), 0) as inference_cost_usd,
      COALESCE(SUM(CASE WHEN cost_type = 'gpu_compute' THEN total_cost_usd ELSE 0 END), 0) as gpu_compute_cost_usd,
      COALESCE(SUM(CASE WHEN cost_type = 'connector' THEN total_cost_usd ELSE 0 END), 0) as connector_cost_usd,
      COALESCE(SUM(input_tokens), 0) as total_input_tokens,
      COALESCE(SUM(output_tokens), 0) as total_output_tokens,
      COUNT(*) as total_billing_records,
      COALESCE(SUM(gpu_hours), 0) as total_gpu_hours
    FROM billing_records
    WHERE org_id = ${user.org_id} AND created_at >= ${since}
  `;

  // By cost type
  const costTypeRows = await sql`
    SELECT cost_type, SUM(total_cost_usd) as cost
    FROM billing_records
    WHERE org_id = ${user.org_id} AND created_at >= ${since}
    GROUP BY cost_type ORDER BY cost DESC
  `;
  const byCostType: Record<string, number> = {};
  for (const r of costTypeRows) byCostType[r.cost_type] = Number(r.cost);

  // By model
  const modelRows = await sql`
    SELECT model, SUM(total_cost_usd) as cost
    FROM billing_records
    WHERE org_id = ${user.org_id} AND created_at >= ${since} AND model != ''
    GROUP BY model ORDER BY cost DESC
  `;
  const byModel: Record<string, number> = {};
  for (const r of modelRows) byModel[r.model] = Number(r.cost);

  // By agent
  const agentRows = await sql`
    SELECT agent_name, SUM(total_cost_usd) as cost, COUNT(*) as call_count
    FROM billing_records
    WHERE org_id = ${user.org_id} AND created_at >= ${since} AND agent_name != ''
    GROUP BY agent_name ORDER BY cost DESC
  `;
  const byAgent: Record<string, number> = {};
  for (const r of agentRows) byAgent[r.agent_name] = Number(r.cost);

  return c.json({
    total_cost_usd: Number(summary.total_cost_usd),
    inference_cost_usd: Number(summary.inference_cost_usd),
    gpu_compute_cost_usd: Number(summary.gpu_compute_cost_usd),
    connector_cost_usd: Number(summary.connector_cost_usd),
    total_input_tokens: Number(summary.total_input_tokens),
    total_output_tokens: Number(summary.total_output_tokens),
    total_billing_records: Number(summary.total_billing_records),
    total_gpu_hours: Number(summary.total_gpu_hours),
    by_cost_type: byCostType,
    by_model: byModel,
    by_agent: byAgent,
  });
});

billingRoutes.get("/usage/daily", requireScope("billing:read"), async (c) => {
  const user = c.get("user");
  const days = Math.max(1, Math.min(365, Number(c.req.query("days")) || 30));
  const since = Date.now() / 1000 - days * 86400;
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const rows = await sql`
    SELECT created_at, total_cost_usd, input_tokens, output_tokens
    FROM billing_records
    WHERE org_id = ${user.org_id} AND created_at >= ${since}
    ORDER BY created_at
  `;

  const daily: Record<string, { cost: number; input_tokens: number; output_tokens: number; call_count: number }> = {};
  for (const row of rows) {
    const ts = Number(row.created_at || 0);
    const date = new Date(ts * 1000);
    const day = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
    if (!daily[day]) daily[day] = { cost: 0, input_tokens: 0, output_tokens: 0, call_count: 0 };
    daily[day].cost += Number(row.total_cost_usd || 0);
    daily[day].input_tokens += Number(row.input_tokens || 0);
    daily[day].output_tokens += Number(row.output_tokens || 0);
    daily[day].call_count += 1;
  }

  const out = Object.keys(daily)
    .sort()
    .map((day) => ({ day, ...daily[day] }));
  return c.json({ days: out });
});

billingRoutes.get("/trace/:trace_id", requireScope("billing:read"), async (c) => {
  const user = c.get("user");
  const traceId = c.req.param("trace_id");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const records = await sql`
    SELECT * FROM billing_records
    WHERE trace_id = ${traceId} AND org_id = ${user.org_id}
    ORDER BY created_at
  `;
  if (records.length === 0) return c.json({ error: "Trace not found" }, 404);

  const sessionIds = new Set(records.filter((r: any) => r.session_id).map((r: any) => r.session_id));
  const totalCost = records.reduce((sum: number, r: any) => sum + Number(r.total_cost_usd || 0), 0);
  const totalTokens = records.reduce(
    (sum: number, r: any) => sum + Number(r.input_tokens || 0) + Number(r.output_tokens || 0),
    0,
  );

  return c.json({
    trace_id: traceId,
    rollup: { total_sessions: sessionIds.size, total_cost_usd: totalCost, total_tokens: totalTokens },
    records,
  });
});

billingRoutes.get("/invoices", requireScope("billing:read"), async (c) => {
  return c.json({ invoices: [], note: "Stripe integration pending" });
});

billingRoutes.post("/checkout", requireScope("billing:write"), async (c) => {
  const body = await c.req.json();
  const plan = String(body.plan || "standard");
  const allowed = new Set(["starter", "standard", "pro", "enterprise"]);
  if (!allowed.has(plan)) {
    return c.json({ error: "Invalid plan" }, 400);
  }
  return c.json({
    checkout_url: `https://checkout.stripe.com/placeholder?plan=${encodeURIComponent(plan)}`,
    note: "Stripe integration pending",
  });
});

billingRoutes.get("/pricing", requireScope("billing:read"), async (c) => {
  const resourceType = c.req.query("resource_type") || "";
  const provider = c.req.query("provider") || "";
  const model = c.req.query("model") || "";
  const operation = c.req.query("operation") || "";
  const sql = await getDb(c.env.HYPERDRIVE);

  // Build query dynamically with filters
  let query = "SELECT * FROM pricing_catalog WHERE is_active = 1";
  const params: (string | boolean)[] = [];

  if (resourceType) {
    params.push(resourceType);
    query += ` AND resource_type = $${params.length}`;
  }
  if (provider) {
    params.push(provider);
    query += ` AND provider = $${params.length}`;
  }
  if (model) {
    params.push(model);
    query += ` AND model = $${params.length}`;
  }
  if (operation) {
    params.push(operation);
    query += ` AND operation = $${params.length}`;
  }
  query += " ORDER BY resource_type, provider, model, operation, unit, effective_from DESC";

  const rows = await sql.unsafe(query, params);

  return c.json({ pricing: rows, count: rows.length });
});

billingRoutes.post("/pricing", requireScope("billing:write"), async (c) => {
  const user = c.get("user");
  if (!hasRole(user, "admin")) {
    return c.json({ error: "Admin role required for pricing updates" }, 403);
  }

  const body = await c.req.json();
  const resourceType = String(body.resource_type || "");
  const operation = String(body.operation || "");
  const unit = String(body.unit || "");
  if (!resourceType || !operation || !unit) {
    return c.json({ error: "resource_type, operation, and unit are required" }, 400);
  }

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const provider = String(body.provider || "");
  const model = String(body.model || "");
  const unitPriceUsd = Number(body.unit_price_usd || 0);
  const currency = String(body.currency || "USD");
  const source = String(body.source || "manual");
  const pricingVersion = String(body.pricing_version || "");
  const effectiveFrom = body.effective_from ?? null;
  const effectiveTo = body.effective_to ?? null;
  const isActive = body.is_active !== false;
  const metadataJson = String(body.metadata_json || "{}");

  // Deactivate existing active row for same key
  await sql`
    UPDATE pricing_catalog SET is_active = 0
    WHERE provider = ${provider} AND model = ${model}
      AND resource_type = ${resourceType} AND operation = ${operation}
      AND unit = ${unit} AND is_active = 1
  `;

  const [row] = await sql`
    INSERT INTO pricing_catalog (
      provider, model, resource_type, operation, unit, unit_price_usd,
      currency, source, pricing_version, effective_from, effective_to,
      is_active, metadata_json
    ) VALUES (
      ${provider}, ${model}, ${resourceType}, ${operation}, ${unit}, ${unitPriceUsd},
      ${currency}, ${source}, ${pricingVersion}, ${effectiveFrom}, ${effectiveTo},
      ${isActive}, ${metadataJson}
    ) RETURNING id
  `;

  return c.json({ ok: true, id: row?.id });
});
