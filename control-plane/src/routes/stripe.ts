/**
 * Stripe billing router — checkout, portal, webhooks, subscription status.
 * Ported from agentos/api/routers/stripe_billing.py
 *
 * Uses Stripe npm package via c.env.STRIPE_SECRET_KEY.
 */
import { Hono } from "hono";
import type { Env } from "../env";
import type { CurrentUser } from "../auth/types";
import { getDb } from "../db/client";
import Stripe from "stripe";
import { requireScope } from "../middleware/auth";

type R = { Bindings: Env; Variables: { user: CurrentUser } };
export const stripeRoutes = new Hono<R>();

const PLAN_PRICES: Record<string, string> = {
  basic: "price_basic_monthly",
  standard: "price_standard_monthly",
  premium: "price_premium_monthly",
  enterprise: "price_enterprise_monthly",
};

function getStripe(env: Env): Stripe {
  if (!env.STRIPE_SECRET_KEY) {
    throw new Error("Stripe not configured. Set STRIPE_SECRET_KEY.");
  }
  return new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: "2024-12-18.acacia" as any });
}

stripeRoutes.post("/checkout", requireScope("billing:write"), async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}));
  const plan = String(body.plan || "standard");
  const successUrl = String(body.success_url || "http://localhost:3000/billing?success=true");
  const cancelUrl = String(body.cancel_url || "http://localhost:3000/billing?canceled=true");

  let stripe: Stripe;
  try {
    stripe = getStripe(c.env);
  } catch (e: any) {
    return c.json({ error: e.message }, 503);
  }

  const priceId = PLAN_PRICES[plan];
  if (!priceId) return c.json({ error: `Unknown plan: ${plan}` }, 400);

  const sql = await getDb(c.env.HYPERDRIVE);
  const orgs = await sql`SELECT * FROM orgs WHERE org_id = ${user.org_id}`;
  if (orgs.length === 0) return c.json({ error: "Org not found" }, 404);
  const org = orgs[0] as any;

  let customerId = org.stripe_customer_id || "";
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: user.email,
      metadata: { org_id: user.org_id, user_id: user.user_id },
    });
    customerId = customer.id;
    await sql`UPDATE orgs SET stripe_customer_id = ${customerId} WHERE org_id = ${user.org_id}`;
  }

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    payment_method_types: ["card"],
    line_items: [{ price: priceId, quantity: 1 }],
    mode: "subscription",
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: { org_id: user.org_id, plan },
  });

  return c.json({ checkout_url: session.url, session_id: session.id });
});

stripeRoutes.post("/portal", requireScope("billing:write"), async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}));
  const returnUrl = String(body.return_url || "http://localhost:3000/billing");

  let stripe: Stripe;
  try {
    stripe = getStripe(c.env);
  } catch (e: any) {
    return c.json({ error: e.message }, 503);
  }

  const sql = await getDb(c.env.HYPERDRIVE);
  const orgs = await sql`SELECT stripe_customer_id FROM orgs WHERE org_id = ${user.org_id}`;
  if (orgs.length === 0 || !orgs[0].stripe_customer_id) {
    return c.json({ error: "No Stripe customer found. Subscribe to a plan first." }, 400);
  }

  const session = await stripe.billingPortal.sessions.create({
    customer: orgs[0].stripe_customer_id,
    return_url: returnUrl,
  });
  return c.json({ portal_url: session.url });
});

stripeRoutes.post("/webhook", async (c) => {
  let stripe: Stripe;
  try {
    stripe = getStripe(c.env);
  } catch (e: any) {
    return c.json({ error: e.message }, 503);
  }

  const body = await c.req.text();
  const sigHeader = c.req.header("stripe-signature") || "";

  if (!c.env.STRIPE_WEBHOOK_SECRET) {
    return c.json({ error: "Webhook secret not configured" }, 503);
  }

  let event: any;
  try {
    event = stripe.webhooks.constructEvent(body, sigHeader, c.env.STRIPE_WEBHOOK_SECRET);
  } catch {
    return c.json({ error: "Webhook signature verification failed" }, 400);
  }

  const eventType = event.type || "";
  const data = event.data?.object || {};
  const sql = await getDb(c.env.HYPERDRIVE);
  const now = new Date().toISOString();

  if (eventType === "checkout.session.completed") {
    const orgId = data.metadata?.org_id || "";
    const plan = data.metadata?.plan || "standard";
    const subscriptionId = data.subscription || "";
    if (orgId) {
      await sql`
        UPDATE orgs SET plan = ${plan}, stripe_subscription_id = ${subscriptionId}, updated_at = ${now}
        WHERE org_id = ${orgId}
      `;
    }
  } else if (eventType === "customer.subscription.deleted") {
    const customerId = data.customer || "";
    const orgs = await sql`SELECT org_id FROM orgs WHERE stripe_customer_id = ${customerId}`;
    if (orgs.length > 0) {
      await sql`
        UPDATE orgs SET plan = 'free', stripe_subscription_id = '', updated_at = ${now}
        WHERE org_id = ${orgs[0].org_id}
      `;
    }
  } else if (eventType === "invoice.paid") {
    const customerId = data.customer || "";
    const amount = (data.amount_paid || 0) / 100;
    const orgs = await sql`SELECT org_id FROM orgs WHERE stripe_customer_id = ${customerId}`;
    if (orgs.length > 0) {
      await sql`
        INSERT INTO billing_records (org_id, cost_type, total_cost_usd, description, created_at)
        VALUES (${orgs[0].org_id}, 'subscription', ${amount}, ${`Stripe invoice: ${data.id || ""}`}, ${now})
      `;
    }
  }

  return c.json({ received: true });
});

stripeRoutes.get("/status", requireScope("billing:read"), async (c) => {
  const user = c.get("user");
  const sql = await getDb(c.env.HYPERDRIVE);
  const orgs = await sql`
    SELECT plan, stripe_customer_id, stripe_subscription_id FROM orgs WHERE org_id = ${user.org_id}
  `;
  if (orgs.length === 0) return c.json({ plan: "free", subscription: null });
  const org = orgs[0] as any;
  return c.json({
    plan: org.plan || "free",
    has_stripe: Boolean(org.stripe_customer_id),
    subscription_id: org.stripe_subscription_id || null,
  });
});
