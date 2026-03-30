/**
 * Referral program routes — codes, stats, apply.
 */
import { createRoute, z } from "@hono/zod-openapi";
import { createOpenAPIRouter } from "../lib/openapi";
import { errorResponses } from "../schemas/openapi";
import { getDbForOrg } from "../db/client";
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
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const stats = await getReferralStats(sql, user.org_id);
  return c.json(stats);
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
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  // Enforce total invite budget: max 10 codes per org, each with max 5 uses = 50 total invites max
  const MAX_CODES_PER_ORG = 10;
  const codeCount = await sql`SELECT COUNT(*)::int as cnt FROM referral_codes WHERE org_id = ${user.org_id}`.catch(() => [{ cnt: 0 }]);
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
      share_url: `https://app.oneshots.co/login?ref=${encodeURIComponent(result.code)}`,
    });
  } catch (err: any) {
    return c.json({ error: err.message?.includes("duplicate") ? "Code already exists" : err.message }, 400);
  }
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
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const result = await applyReferralCode(sql, user.org_id, code);
  if (!result.success) return c.json({ error: result.error }, 400);
  return c.json({ applied: true, referrer_org_id: result.referrer_org_id });
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
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const rows = await sql`
    SELECT re.*, o.name as source_org_name
    FROM referral_earnings re LEFT JOIN orgs o ON o.org_id = re.source_org_id
    WHERE re.earner_org_id = ${user.org_id}
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
