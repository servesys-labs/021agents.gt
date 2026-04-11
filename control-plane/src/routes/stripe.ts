/**
 * Stripe billing router — checkout, portal, webhooks, subscription status.
 *
 * Uses Stripe npm package via c.env.STRIPE_SECRET_KEY.
 */
import { createRoute, z } from "@hono/zod-openapi";
import { createOpenAPIRouter } from "../lib/openapi";
import { ErrorSchema, errorResponses } from "../schemas/openapi";
import type { Env } from "../env";
import { withOrgDb, withAdminDb } from "../db/client";
import Stripe from "stripe";
import { requireScope } from "../middleware/auth";
import { addCredits } from "../logic/credits";
import { failSafe } from "../lib/error-response";

export const stripeRoutes = createOpenAPIRouter();

/**
 * Resolve the default portal URL for post-checkout / post-portal redirects.
 * The old code hardcoded `http://localhost:3000/billing` which sent real
 * users to a broken URL in production if the client forgot to pass the
 * success/cancel/return_url in the request body. Now reads from
 * PORTAL_BASE_URL env (set in wrangler vars) and falls back to a safe
 * relative path rather than an absolute localhost URL.
 */
function portalBillingUrl(env: Env, suffix = ""): string {
  const base = String((env as { PORTAL_BASE_URL?: string }).PORTAL_BASE_URL || "").replace(/\/+$/, "");
  if (base) return `${base}/billing${suffix}`;
  // Last-resort fallback: relative path. Browsers resolve it against the
  // current origin, so a user hitting the API from app.example.com ends
  // up on app.example.com/billing instead of a dead localhost URL.
  return `/billing${suffix}`;
}

const PLAN_PRICES: Record<string, string> = {
  basic: "price_basic_monthly",
  standard: "price_standard_monthly",
  premium: "price_premium_monthly",
  enterprise: "price_enterprise_monthly",
};

function getStripe(env: Env): Stripe {
  if (!env.STRIPE_SECRET_KEY) {
    // Use a structured error so route handlers can map this to a stable
    // code without leaking the env var name into user-facing strings.
    throw Object.assign(new Error("Stripe is not configured on this environment."), {
      code: "stripe_not_configured",
    });
  }
  return new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: "2024-12-18.acacia" as any });
}

// ── POST /stripe/checkout ───────────────────────────────────────────────

const checkoutRoute = createRoute({
  method: "post",
  path: "/checkout",
  tags: ["Stripe"],
  summary: "Create a Stripe checkout session",
  middleware: [requireScope("billing:write")],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            plan: z.string().optional(),
            success_url: z.string().optional(),
            cancel_url: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Checkout session created",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(400, 404, 500),
  },
});
stripeRoutes.openapi(checkoutRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const body = c.req.valid("json");
  const plan = String(body.plan || "standard");
  const successUrl = String(body.success_url || portalBillingUrl(c.env, "?success=true"));
  const cancelUrl = String(body.cancel_url || portalBillingUrl(c.env, "?canceled=true"));

  let stripe: Stripe;
  try {
    stripe = getStripe(c.env);
  } catch (e) {
    return c.json(failSafe(e, "stripe/checkout:init", {
      userMessage: "Payments are temporarily unavailable. Please try again later.",
      code: "stripe_unavailable",
    }), 503);
  }

  const priceId = PLAN_PRICES[plan];
  if (!priceId) return c.json({ error: `Unknown plan: ${plan}` }, 400);

  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const orgs = await sql`SELECT * FROM orgs`;
    if (orgs.length === 0) return c.json({ error: "Org not found" }, 404);
    const org = orgs[0] as any;

    let customerId = org.stripe_customer_id || "";
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: { org_id: user.org_id, user_id: user.user_id },
      });
      customerId = customer.id;
      await sql`UPDATE orgs SET stripe_customer_id = ${customerId}`;
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
});

// ── POST /stripe/portal ────────────────────────────────────────────────

const portalRoute = createRoute({
  method: "post",
  path: "/portal",
  tags: ["Stripe"],
  summary: "Create a Stripe billing portal session",
  middleware: [requireScope("billing:write")],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            return_url: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Portal session created",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(400, 500),
  },
});
stripeRoutes.openapi(portalRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const body = c.req.valid("json");
  const returnUrl = String(body.return_url || portalBillingUrl(c.env));

  let stripe: Stripe;
  try {
    stripe = getStripe(c.env);
  } catch (e) {
    return c.json(failSafe(e, "stripe/portal:init", {
      userMessage: "Payments are temporarily unavailable. Please try again later.",
      code: "stripe_unavailable",
    }), 503);
  }

  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const orgs = await sql`SELECT stripe_customer_id FROM orgs`;
    if (orgs.length === 0 || !orgs[0].stripe_customer_id) {
      return c.json({ error: "No Stripe customer found. Subscribe to a plan first." }, 400);
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: orgs[0].stripe_customer_id,
      return_url: returnUrl,
    });
    return c.json({ portal_url: session.url });
  });
});

// ── POST /stripe/webhook ───────────────────────────────────────────────

const webhookRoute = createRoute({
  method: "post",
  path: "/webhook",
  tags: ["Stripe"],
  summary: "Handle Stripe webhook events",
  responses: {
    200: {
      description: "Event processed",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(400, 500),
  },
});
stripeRoutes.openapi(webhookRoute, async (c): Promise<any> => {
  let stripe: Stripe;
  try {
    stripe = getStripe(c.env);
  } catch (e) {
    return c.json(failSafe(e, "stripe/webhook:init", {
      userMessage: "Webhook processing unavailable.",
      code: "stripe_unavailable",
    }), 503);
  }

  const body = await c.req.text();
  const sigHeader = c.req.header("stripe-signature") || "";

  if (!c.env.STRIPE_WEBHOOK_SECRET) {
    // Log the missing secret server-side (operators need to know) but
    // return a generic message to Stripe's webhook retry pipeline.
    console.error("[stripe/webhook] STRIPE_WEBHOOK_SECRET is not set — refusing to process webhook");
    return c.json({ error: "Webhook processing unavailable." }, 503);
  }

  let event: any;
  try {
    event = stripe.webhooks.constructEvent(body, sigHeader, c.env.STRIPE_WEBHOOK_SECRET);
  } catch {
    return c.json({ error: "Webhook signature verification failed" }, 400);
  }

  const eventType = event.type || "";
  const eventId = event.id || "";
  const data = event.data?.object || {};
  const now = new Date().toISOString();

  // ── Idempotency check + resolve org context (admin connection — no
  //    org context yet, signature already verified above). stripe_events_processed
  //    is NOT RLS, and we need to read orgs.stripe_customer_id without an org GUC.
  const dedupeAndResolve = await withAdminDb(c.env, async (sql) => {
    if (eventId) {
      const existing = await sql`
        SELECT 1 FROM stripe_events_processed WHERE event_id = ${eventId} LIMIT 1
      `.catch(() => []);
      if (existing.length > 0) {
        return { duplicate: true as const };
      }
    }

    // Resolve org_id from event payload (metadata or customer lookup)
    let orgId: string = data.metadata?.org_id || "";
    if (!orgId && (eventType === "customer.subscription.deleted" || eventType === "invoice.paid")) {
      const customerId = data.customer || "";
      if (customerId) {
        const orgs = await sql`SELECT org_id FROM orgs WHERE stripe_customer_id = ${customerId}`;
        if (orgs.length > 0) orgId = String(orgs[0].org_id || "");
      }
    }
    return { duplicate: false as const, orgId };
  });

  if (dedupeAndResolve.duplicate) {
    return c.json({ received: true, deduplicated: true });
  }

  const resolvedOrgId = dedupeAndResolve.orgId;

  // ── Apply state mutations under the resolved org's RLS context ────
  if (resolvedOrgId) {
    await withOrgDb(c.env, resolvedOrgId, async (sql) => {
      if (eventType === "checkout.session.completed") {
        const packageId = data.metadata?.package_id || "";
        const isCreditPurchase = data.metadata?.type === "credit_purchase";

        if (isCreditPurchase && packageId) {
          // credit_packages is NOT RLS — keep direct lookup
          const pkgs = await sql`
            SELECT credits_usd, name FROM credit_packages WHERE id = ${packageId} LIMIT 1
          `;
          if (pkgs.length > 0) {
            const pkg = pkgs[0] as any;
            const creditsUsd = Number(pkg.credits_usd);
            await addCredits(
              sql,
              resolvedOrgId,
              creditsUsd,
              `Credit purchase: ${pkg.name}`,
              data.id || eventId,
              "stripe_checkout",
            );
            console.log(`[stripe] Credited $${creditsUsd} to org ${resolvedOrgId} (package: ${packageId})`);
          }
        } else {
          // ── Subscription checkout (existing flow) ─────────────
          const plan = data.metadata?.plan || "standard";
          const subscriptionId = data.subscription || "";
          await sql`
            UPDATE orgs SET plan = ${plan}, stripe_subscription_id = ${subscriptionId}, updated_at = ${now}
          `;
        }
      } else if (eventType === "customer.subscription.deleted") {
        await sql`
          UPDATE orgs SET plan = 'free', stripe_subscription_id = '', updated_at = ${now}
        `;
      } else if (eventType === "invoice.paid") {
        const amount = (data.amount_paid || 0) / 100;
        await sql`
          INSERT INTO billing_records (org_id, cost_type, total_cost_usd, description, created_at)
          VALUES (${resolvedOrgId}, 'subscription', ${amount}, ${`Stripe invoice: ${data.id || ""}`}, ${now})
        `;

        // If invoice has credit metadata, allocate credits for subscription renewals
        const invoiceMeta = data.subscription_details?.metadata || data.lines?.data?.[0]?.metadata || {};
        const invoiceCredits = Number(invoiceMeta.credits_usd || invoiceMeta.credits_cents ? Number(invoiceMeta.credits_cents) / 100 : 0);
        if (invoiceCredits > 0) {
          await addCredits(
            sql,
            resolvedOrgId,
            invoiceCredits,
            `Subscription credit allocation: invoice ${data.id || ""}`,
            data.id || "",
            "stripe_invoice",
          );
        }
      }
    });
  }

  // ── Mark event as processed (admin — stripe_events_processed is global) ──
  if (eventId) {
    await withAdminDb(c.env, async (sql) => {
      await sql`
        INSERT INTO stripe_events_processed (event_id, event_type, processed_at)
        VALUES (${eventId}, ${eventType}, ${now})
        ON CONFLICT (event_id) DO NOTHING
      `.catch(() => {});
    });
  }

  return c.json({ received: true });
});

// ── GET /stripe/status ─────────────────────────────────────────────────

const statusRoute = createRoute({
  method: "get",
  path: "/status",
  tags: ["Stripe"],
  summary: "Get subscription status",
  middleware: [requireScope("billing:read")],
  responses: {
    200: {
      description: "Subscription status",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
  },
});
stripeRoutes.openapi(statusRoute, async (c): Promise<any> => {
  const user = c.get("user");
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const orgs = await sql`
      SELECT plan, stripe_customer_id, stripe_subscription_id FROM orgs
    `;
    if (orgs.length === 0) return c.json({ plan: "free", subscription: null });
    const org = orgs[0] as any;
    return c.json({
      plan: org.plan || "free",
      has_stripe: Boolean(org.stripe_customer_id),
      subscription_id: org.stripe_subscription_id || null,
    });
  });
});
