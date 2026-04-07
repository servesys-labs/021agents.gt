/**
 * Billing router — usage, daily breakdown, trace cost, invoices, pricing catalog.
 * Ported from agentos/api/routers/billing.py
 */
import { createRoute, z } from "@hono/zod-openapi";
import type { CurrentUser } from "../auth/types";
import { createOpenAPIRouter } from "../lib/openapi";
import { ErrorSchema, errorResponses } from "../schemas/openapi";
import { getDb, getDbForOrg } from "../db/client";
import { hasRole } from "../auth/types";
import { requireScope } from "../middleware/auth";

export const billingRoutes = createOpenAPIRouter();

// ── GET /usage ──────────────────────────────────────────────────

const getUsageRoute = createRoute({
  method: "get",
  path: "/usage",
  tags: ["Billing"],
  summary: "Get billing usage summary",
  middleware: [requireScope("billing:read")],
  request: {
    query: z.object({
      since_days: z.coerce.number().int().min(1).max(365).default(30),
    }),
  },
  responses: {
    200: { description: "Usage summary", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(401, 500),
  },
});

billingRoutes.openapi(getUsageRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { since_days: sinceDays } = c.req.valid("query");
  const since = new Date(Date.now() - sinceDays * 86400 * 1000).toISOString();
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  // Total summary
  const [summary] = await sql`
    SELECT
      COALESCE(SUM(total_cost_usd), 0) as total_cost_usd,
      COALESCE(SUM(CASE WHEN cost_type = 'inference' THEN total_cost_usd ELSE 0 END), 0) as inference_cost_usd,
      COALESCE(SUM(CASE WHEN cost_type = 'gpu_compute' THEN total_cost_usd ELSE 0 END), 0) as gpu_compute_cost_usd,
      COALESCE(SUM(CASE WHEN cost_type = 'connector' THEN total_cost_usd ELSE 0 END), 0) as connector_cost_usd,
      COALESCE(SUM(CASE WHEN cost_type = 'telephony' THEN total_cost_usd ELSE 0 END), 0) as telephony_cost_usd,
      COALESCE(SUM(input_tokens), 0) as total_input_tokens,
      COALESCE(SUM(output_tokens), 0) as total_output_tokens,
      COUNT(*) as total_billing_records
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

  let by_billing_subject: Array<{
    billing_user_id: string;
    api_key_id: string;
    cost_usd: number;
    record_count: number;
  }> = [];
  try {
    const subjectRows = await sql`
      SELECT billing_user_id, api_key_id,
             SUM(total_cost_usd) as cost,
             COUNT(*)::int as record_count
      FROM billing_records
      WHERE org_id = ${user.org_id} AND created_at >= ${since}
        AND (COALESCE(TRIM(billing_user_id), '') != '' OR COALESCE(TRIM(api_key_id), '') != '')
      GROUP BY billing_user_id, api_key_id
      ORDER BY cost DESC
      LIMIT 100
    `;
    by_billing_subject = subjectRows.map((r: Record<string, unknown>) => ({
      billing_user_id: String(r.billing_user_id ?? ""),
      api_key_id: String(r.api_key_id ?? ""),
      cost_usd: Number(r.cost) || 0,
      record_count: Number(r.record_count) || 0,
    }));
  } catch {
    /* Older DBs without billing_user_id / api_key_id columns */
  }

  return c.json({
    total_cost_usd: Number(summary.total_cost_usd),
    inference_cost_usd: Number(summary.inference_cost_usd),
    gpu_compute_cost_usd: Number(summary.gpu_compute_cost_usd),
    connector_cost_usd: Number(summary.connector_cost_usd),
    telephony_cost_usd: Number(summary.telephony_cost_usd),
    total_input_tokens: Number(summary.total_input_tokens),
    total_output_tokens: Number(summary.total_output_tokens),
    total_billing_records: Number(summary.total_billing_records),
    by_cost_type: byCostType,
    by_model: byModel,
    by_agent: byAgent,
    by_billing_subject,
  });
});

// ── GET /usage/daily ────────────────────────────────────────────

const getDailyUsageRoute = createRoute({
  method: "get",
  path: "/usage/daily",
  tags: ["Billing"],
  summary: "Get daily billing breakdown",
  middleware: [requireScope("billing:read")],
  request: {
    query: z.object({
      days: z.coerce.number().int().min(1).max(365).default(30),
    }),
  },
  responses: {
    200: { description: "Daily breakdown", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(401, 500),
  },
});

billingRoutes.openapi(getDailyUsageRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { days } = c.req.valid("query");
  const since = new Date(Date.now() - days * 86400 * 1000).toISOString();
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

// ── GET /trace/:trace_id ────────────────────────────────────────

const getTraceCostRoute = createRoute({
  method: "get",
  path: "/trace/{trace_id}",
  tags: ["Billing"],
  summary: "Get trace billing cost",
  middleware: [requireScope("billing:read")],
  request: {
    params: z.object({ trace_id: z.string() }),
  },
  responses: {
    200: { description: "Trace cost", content: { "application/json": { schema: z.record(z.unknown()) } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    ...errorResponses(401, 500),
  },
});

billingRoutes.openapi(getTraceCostRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { trace_id: traceId } = c.req.valid("param");
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

// ── GET /invoices ───────────────────────────────────────────────

const listInvoicesRoute = createRoute({
  method: "get",
  path: "/invoices",
  tags: ["Billing"],
  summary: "List invoices",
  middleware: [requireScope("billing:read")],
  responses: {
    200: { description: "Invoice list", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(401, 500),
  },
});

billingRoutes.openapi(listInvoicesRoute, async (c): Promise<any> => {
  return c.json({ invoices: [], note: "Stripe integration pending" });
});

// ── POST /checkout ──────────────────────────────────────────────

const checkoutRoute = createRoute({
  method: "post",
  path: "/checkout",
  tags: ["Billing"],
  summary: "Create checkout session",
  middleware: [requireScope("billing:write")],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            plan: z.string().default("standard"),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Checkout URL", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(400, 401, 500),
  },
});

billingRoutes.openapi(checkoutRoute, async (c): Promise<any> => {
  const body = c.req.valid("json");
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

// ── GET /quota ──────────────────────────────────────────────────

const getQuotaRoute = createRoute({
  method: "get",
  path: "/quota",
  tags: ["Billing"],
  summary: "Get billing quota",
  middleware: [requireScope("billing:read")],
  responses: {
    200: { description: "Quota info", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(401, 500),
  },
});

billingRoutes.openapi(getQuotaRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  let used = 0;
  try {
    const [row] = await sql`
      SELECT COALESCE(SUM(total_cost_usd), 0) as total
      FROM billing_records
      WHERE org_id = ${user.org_id}
    `;
    used = Number(row.total);
  } catch {}

  return c.json({ limit: 1000, used, unit: "credits" });
});

// ── GET /pricing ────────────────────────────────────────────────

const getPricingRoute = createRoute({
  method: "get",
  path: "/pricing",
  tags: ["Billing"],
  summary: "Get pricing catalog",
  middleware: [requireScope("billing:read")],
  request: {
    query: z.object({
      resource_type: z.string().default(""),
      provider: z.string().default(""),
      model: z.string().default(""),
      operation: z.string().default(""),
    }),
  },
  responses: {
    200: { description: "Pricing catalog", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(401, 500),
  },
});

billingRoutes.openapi(getPricingRoute, async (c): Promise<any> => {
  const { resource_type: resourceType, provider, model, operation } = c.req.valid("query");
  const sql = await getDb(c.env.HYPERDRIVE);

  // Build query dynamically with filters
  let query = "SELECT * FROM pricing_catalog WHERE is_active = true";
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

// ── POST /pricing ───────────────────────────────────────────────

const upsertPricingRoute = createRoute({
  method: "post",
  path: "/pricing",
  tags: ["Billing"],
  summary: "Create or update pricing entry",
  middleware: [requireScope("billing:write")],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            resource_type: z.string().min(1),
            operation: z.string().min(1),
            unit: z.string().min(1),
            provider: z.string().default(""),
            model: z.string().default(""),
            unit_price_usd: z.number().default(0),
            currency: z.string().default("USD"),
            source: z.string().default("manual"),
            pricing_version: z.string().default(""),
            effective_from: z.string().nullable().optional(),
            effective_to: z.string().nullable().optional(),
            is_active: z.boolean().default(true),
            metadata: z.string().default("{}"),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Pricing entry created", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(400, 401, 403, 500),
  },
});

billingRoutes.openapi(upsertPricingRoute, async (c): Promise<any> => {
  const user = c.get("user");
  if (!hasRole(user, "admin")) {
    return c.json({ error: "Admin role required for pricing updates" }, 403);
  }

  const body = c.req.valid("json");
  const resourceType = body.resource_type;
  const operation = body.operation;
  const unit = body.unit;

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const provider = body.provider;
  const model = body.model;
  const unitPriceUsd = body.unit_price_usd;
  const currency = body.currency;
  const source = body.source;
  const pricingVersion = body.pricing_version;
  const effectiveFrom = body.effective_from ?? null;
  const effectiveTo = body.effective_to ?? null;
  const isActive = body.is_active;
  const metadataJson = body.metadata;

  // Deactivate existing active row for same key
  await sql`
    UPDATE pricing_catalog SET is_active = false
    WHERE provider = ${provider} AND model = ${model}
      AND resource_type = ${resourceType} AND operation = ${operation}
      AND unit = ${unit} AND is_active = true
  `;

  const [row] = await sql`
    INSERT INTO pricing_catalog (
      provider, model, resource_type, operation, unit, unit_price_usd,
      currency, source, pricing_version, effective_from, effective_to,
      is_active, metadata
    ) VALUES (
      ${provider}, ${model}, ${resourceType}, ${operation}, ${unit}, ${unitPriceUsd},
      ${currency}, ${source}, ${pricingVersion}, ${effectiveFrom}, ${effectiveTo},
      ${isActive}, ${metadataJson}
    ) RETURNING id
  `;

  return c.json({ ok: true, id: row?.id });
});
