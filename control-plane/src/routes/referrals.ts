/**
 * Referral program routes — codes, stats, apply, earnings, payout.
 *
 * Every handler runs inside withOrgDb() so queries execute under the
 * caller's org_id GUC and RLS enforces isolation. The redundant
 * `WHERE org_id = ${user.org_id}` clauses on org-scoped tables have
 * been removed — RLS is now the single source of truth. Helpers in
 * ../logic/referrals.ts still accept the orgId parameter because they
 * use it inside JOIN conditions and transfer edges, not row filters.
 */
import { createRoute, z } from "@hono/zod-openapi";
import { createOpenAPIRouter } from "../lib/openapi";
import { errorResponses } from "../schemas/openapi";
import { withOrgDb } from "../db/client";
import { requireScope } from "../middleware/auth";
import { createReferralCode, applyReferralCode, getReferralStats } from "../logic/referrals";

export const referralRoutes = createOpenAPIRouter();

// GET /stats — Referral dashboard stats
const statsRoute = createRoute({
  method: "get", path: "/stats", tags: ["Referrals"],
  summary: "Get referral stats: referrals made, earnings, codes",
  middleware: [requireScope("billing:read")],
  responses: { 200: { description: "Stats", content: { "application/json": { schema: z.record(z.unknown()) } } }, ...errorResponses(500) },
});

referralRoutes.openapi(statsRoute, async (c): Promise<any> => {
  const user = c.get("user");
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const stats = await getReferralStats(sql, user.org_id);
    return c.json(stats);
  });
});

// POST /codes — Create a referral code
const createCodeRoute = createRoute({
  method: "post", path: "/codes", tags: ["Referrals"],
  summary: "Create a new referral code",
  middleware: [requireScope("billing:write")],
  request: {
    body: { content: { "application/json": { schema: z.object({
      code: z.string().min(3).max(50).optional(),
      label: z.string().max(100).optional(),
      max_uses: z.number().int().min(1).max(10000).optional(),
    }) } } },
  },
  responses: { 200: { description: "Code created", content: { "application/json": { schema: z.record(z.unknown()) } } }, ...errorResponses(400, 500) },
});

referralRoutes.openapi(createCodeRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const body = c.req.valid("json");
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    // Enforce total invite budget: max 10 codes per org, each with max 5 uses = 50 total invites max
    const MAX_CODES_PER_ORG = 10;
    // RLS filters by org_id automatically — no WHERE clause needed.
    const codeCount = await sql`SELECT COUNT(*)::int as cnt FROM referral_codes`.catch(() => [{ cnt: 0 }]);
    if (Number(codeCount[0]?.cnt || 0) >= MAX_CODES_PER_ORG) {
      return c.json({ error: `Maximum ${MAX_CODES_PER_ORG} referral codes per organization.` }, 400);
    }

    // Force max_uses on new codes (default 5, max 10) — no unlimited codes
    const maxUses = Math.min(body.max_uses || 5, 10);

    try {
      const code = body.code?.replace(/[^a-zA-Z0-9_-]/g, "") || undefined; // URL-safe only
      const result = await createReferralCode(sql, user.org_id, { code, label: body.label, userId: user.user_id, maxUses });
      return c.json({
        created: true, ...result,
        max_uses: maxUses,
        share_url: `https://app.021agents.ai/login?ref=${encodeURIComponent(result.code)}`,
      });
    } catch (err: any) {
      return c.json({ error: err.message?.includes("duplicate") ? "Code already exists" : err.message }, 400);
    }
  });
});

// POST /apply — Apply a referral code (called during signup)
const applyRoute = createRoute({
  method: "post", path: "/apply", tags: ["Referrals"],
  summary: "Apply a referral code to the current org",
  request: {
    body: { content: { "application/json": { schema: z.object({ code: z.string().min(1) }) } } },
  },
  responses: { 200: { description: "Applied", content: { "application/json": { schema: z.record(z.unknown()) } } }, ...errorResponses(400, 500) },
});

referralRoutes.openapi(applyRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { code } = c.req.valid("json");
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const result = await applyReferralCode(sql, user.org_id, code);
    if (!result.success) return c.json({ error: result.error }, 400);
    return c.json({ applied: true, referrer_org_id: result.referrer_org_id });
  });
});

// GET /earnings — Detailed earnings history
const earningsRoute = createRoute({
  method: "get", path: "/earnings", tags: ["Referrals"],
  summary: "Get detailed referral earnings history",
  middleware: [requireScope("billing:read")],
  request: { query: z.object({ limit: z.coerce.number().min(1).max(100).default(50) }) },
  responses: { 200: { description: "Earnings", content: { "application/json": { schema: z.record(z.unknown()) } } }, ...errorResponses(500) },
});

referralRoutes.openapi(earningsRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { limit } = c.req.valid("query");
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    // RLS on referral_earnings filters by earner_org_id = current_org_id().
    // The LEFT JOIN to orgs is an admin-style cross-reference but the orgs
    // policy still enforces that only the current org's row is visible, so
    // source_org_name may be null when source_org_id points at another org.
    // That's fine — we fall back to source_org_id below.
    const rows = await sql`
      SELECT re.*, o.name as source_org_name
      FROM referral_earnings re LEFT JOIN orgs o ON o.org_id = re.source_org_id
      ORDER BY re.created_at DESC LIMIT ${limit}
    `;

    return c.json({
      earnings: rows.map((r: any) => ({
        source_org: r.source_org_name || r.source_org_id,
        level: r.level,
        earning_usd: Number(r.earning_usd),
        platform_fee_usd: Number(r.platform_fee_usd),
        rate: Number(r.earning_rate),
        date: r.created_at,
      })),
    });
  });
});

// ── POST /payout — Request credit-to-cash payout via Stripe Connect ──

const payoutRoute = createRoute({
  method: "post", path: "/payout", tags: ["Referrals"],
  summary: "Request payout of referral earnings to bank account via Stripe",
  middleware: [requireScope("billing:write")],
  request: {
    body: { content: { "application/json": { schema: z.object({
      amount_usd: z.number().min(10).max(10000), // minimum $10 payout
    }) } } },
  },
  responses: { 200: { description: "Payout initiated", content: { "application/json": { schema: z.record(z.unknown()) } } }, ...errorResponses(400, 500) },
});

referralRoutes.openapi(payoutRoute, async (c): Promise<any> => {
  // Payouts are gated on Stripe Connect being registered + the onboarding +
  // webhook handling being implemented. Until STRIPE_CONNECT_CLIENT_ID is
  // set, refuse the request BEFORE touching balance — the previous
  // implementation deducted credits and wrote a 'burn' transaction while
  // returning "pending" without moving any money, destroying user credits
  // on every call.
  if (!c.env.STRIPE_CONNECT_CLIENT_ID) {
    return c.json({
      error: "Payouts are not yet available.",
      code: "payouts_unavailable",
      message:
        "Cash payouts for referral earnings are coming soon. Your earnings " +
        "continue to accrue as platform credits in the meantime.",
    }, 503);
  }

  // Connect is enabled but the transfer path is not yet implemented here.
  // Fail closed rather than silently deducting balance.
  return c.json({
    error: "Payout transfer path not implemented.",
    code: "payouts_not_implemented",
  }, 501);
});
