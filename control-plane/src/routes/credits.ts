/**
 * Credit routes — balance, transactions, packages, checkout, manual adjustment.
 */
import { createRoute, z } from "@hono/zod-openapi";
import { createOpenAPIRouter } from "../lib/openapi";
import { errorResponses } from "../schemas/openapi";
import type { Env } from "../env";
import { getDb, getDbForOrg } from "../db/client";
import { requireScope } from "../middleware/auth";
import { hasRole } from "../auth/types";
import { getBalance, addCredits } from "../logic/credits";
import Stripe from "stripe";

export const creditRoutes = createOpenAPIRouter();

function getStripe(env: Env): Stripe {
  if (!env.STRIPE_SECRET_KEY) {
    throw new Error("Stripe not configured. Set STRIPE_SECRET_KEY.");
  }
  return new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: "2024-12-18.acacia" as any });
}

// ── GET /balance ──────────────────────────────────────────────────

const getBalanceRoute = createRoute({
  method: "get",
  path: "/balance",
  tags: ["Credits"],
  summary: "Get current credit balance",
  middleware: [requireScope("billing:read")],
  responses: {
    200: {
      description: "Credit balance",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(401, 500),
  },
});

creditRoutes.openapi(getBalanceRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const balance = await getBalance(sql, user.org_id);
  return c.json({
    balance_usd: balance.balance_usd,
    lifetime_purchased_usd: balance.lifetime_purchased_usd,
    lifetime_consumed_usd: balance.lifetime_consumed_usd,
  });
});

// ── GET /transactions ─────────────────────────────────────────────

const getTransactionsRoute = createRoute({
  method: "get",
  path: "/transactions",
  tags: ["Credits"],
  summary: "List credit transactions",
  middleware: [requireScope("billing:read")],
  request: {
    query: z.object({
      limit: z.coerce.number().int().min(1).max(200).default(50),
      offset: z.coerce.number().int().min(0).default(0),
      type: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "Transaction history",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(401, 500),
  },
});

creditRoutes.openapi(getTransactionsRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { limit, offset, type } = c.req.valid("query");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  let rows: any[];
  if (type) {
    rows = await sql`
      SELECT * FROM credit_transactions
      WHERE org_id = ${user.org_id} AND type = ${type}
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  } else {
    rows = await sql`
      SELECT * FROM credit_transactions
      WHERE org_id = ${user.org_id}
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  }

  const [countRow] = type
    ? await sql`SELECT COUNT(*)::int as total FROM credit_transactions WHERE org_id = ${user.org_id} AND type = ${type}`
    : await sql`SELECT COUNT(*)::int as total FROM credit_transactions WHERE org_id = ${user.org_id}`;

  return c.json({
    transactions: rows,
    total: Number(countRow.total),
    limit,
    offset,
  });
});

// ── GET /packages ─────────────────────────────────────────────────

const getPackagesRoute = createRoute({
  method: "get",
  path: "/packages",
  tags: ["Credits"],
  summary: "List available credit packages",
  middleware: [requireScope("billing:read")],
  responses: {
    200: {
      description: "Credit packages",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(500),
  },
});

creditRoutes.openapi(getPackagesRoute, async (c): Promise<any> => {
  const sql = await getDb(c.env.HYPERDRIVE);
  const packages = await sql`
    SELECT id, name, credits_cents, price_cents, bonus_pct, sort_order
    FROM credit_packages
    WHERE is_active = true
    ORDER BY sort_order ASC
  `;
  return c.json({
    packages: packages.map((p: any) => ({
      ...p,
      credits_usd: (Number(p.credits_cents) / 100).toFixed(2),
      price_usd: (Number(p.price_cents) / 100).toFixed(2),
    })),
  });
});

// ── POST /checkout ────────────────────────────────────────────────

const checkoutRoute = createRoute({
  method: "post",
  path: "/checkout",
  tags: ["Credits"],
  summary: "Create Stripe checkout session for credit purchase",
  middleware: [requireScope("billing:write")],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            package_id: z.string().min(1),
            success_url: z.string().optional(),
            cancel_url: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Checkout session",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(400, 404, 500),
  },
});

creditRoutes.openapi(checkoutRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const body = c.req.valid("json");
  const successUrl = String(body.success_url || "https://app.oneshots.co/settings?tab=billing&credit_purchase=success");
  const cancelUrl = String(body.cancel_url || "https://app.oneshots.co/settings?tab=billing&credit_purchase=canceled");

  // Look up the package
  const sql = await getDb(c.env.HYPERDRIVE);
  const pkgs = await sql`
    SELECT * FROM credit_packages WHERE id = ${body.package_id} AND is_active = true LIMIT 1
  `;
  if (pkgs.length === 0) {
    return c.json({ error: `Unknown package: ${body.package_id}` }, 404);
  }
  const pkg = pkgs[0] as any;

  let stripe: Stripe;
  try {
    stripe = getStripe(c.env);
  } catch (e: any) {
    return c.json({ error: e.message }, 503);
  }

  // Ensure org has a Stripe customer
  const orgSql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const orgs = await orgSql`SELECT stripe_customer_id FROM orgs WHERE org_id = ${user.org_id}`;
  let customerId = orgs[0]?.stripe_customer_id || "";

  if (!customerId) {
    const customer = await stripe.customers.create({
      email: user.email,
      metadata: { org_id: user.org_id, user_id: user.user_id },
    });
    customerId = customer.id;
    await orgSql`UPDATE orgs SET stripe_customer_id = ${customerId} WHERE org_id = ${user.org_id}`;
  }

  // Create checkout session
  const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [];

  if (pkg.stripe_price_id) {
    // Use a pre-created Stripe Price
    lineItems.push({ price: pkg.stripe_price_id, quantity: 1 });
  } else {
    // Inline price_data for ad-hoc packages
    lineItems.push({
      price_data: {
        currency: "usd",
        product_data: {
          name: `${pkg.name} Credit Package`,
          description: `${(Number(pkg.credits_cents) / 100).toFixed(2)} credits${Number(pkg.bonus_pct) > 0 ? ` (includes ${pkg.bonus_pct}% bonus)` : ""}`,
        },
        unit_amount: Number(pkg.price_cents),
      },
      quantity: 1,
    });
  }

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    payment_method_types: ["card"],
    line_items: lineItems,
    mode: "payment",
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: {
      org_id: user.org_id,
      package_id: body.package_id,
      credits_cents: String(pkg.credits_cents),
      type: "credit_purchase",
    },
  });

  return c.json({ checkout_url: session.url, session_id: session.id });
});

// ── POST /transfer — Transfer credits to another org (A2A payments) ──

const transferRoute = createRoute({
  method: "post",
  path: "/transfer",
  tags: ["Credits"],
  summary: "Transfer credits to another organization for A2A agent payments",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            to_org_id: z.string().min(1),
            amount_usd: z.number().positive().max(1000),
            description: z.string().max(500).default("A2A credit transfer"),
            task_id: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Transfer result", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(400, 500),
  },
});

creditRoutes.openapi(transferRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const body = c.req.valid("json");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const { transferCredits } = await import("../logic/agent-payments");
  const result = await transferCredits(
    sql, user.org_id, body.to_org_id, body.amount_usd,
    body.description, body.task_id || "",
  );

  if (!result.success) {
    return c.json({ error: result.error }, 400);
  }

  return c.json({
    transfer_id: result.transfer_id,
    from_org: user.org_id,
    to_org: body.to_org_id,
    amount_usd: body.amount_usd,
    from_balance_after: result.from_balance_after,
  });
});

// ── POST /add — Manual credit adjustment (admin only) ─────────────

const addCreditsRoute = createRoute({
  method: "post",
  path: "/add",
  tags: ["Credits"],
  summary: "Manual credit adjustment (admin only)",
  middleware: [requireScope("billing:write")],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            amount_cents: z.number().int().min(1),
            description: z.string().min(1),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Credits added",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(400, 401, 403, 500),
  },
});

creditRoutes.openapi(addCreditsRoute, async (c): Promise<any> => {
  const user = c.get("user");
  if (!hasRole(user, "admin")) {
    return c.json({ error: "Admin role required" }, 403);
  }

  const body = c.req.valid("json");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const result = await addCredits(
    sql,
    user.org_id,
    body.amount_cents,
    body.description,
    `manual_${Date.now()}`,
    "manual",
  );

  return c.json({
    ok: true,
    balance_after_usd: result.balance_after_usd,
  });
});
