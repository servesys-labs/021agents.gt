/**
 * Policies router — reusable governance policy templates.
 */
import { createRoute, z } from "@hono/zod-openapi";
import type { CurrentUser } from "../auth/types";
import { createOpenAPIRouter } from "../lib/openapi";
import { ErrorSchema, errorResponses } from "../schemas/openapi";
import { withOrgDb } from "../db/client";
import { requireScope } from "../middleware/auth";
import { parseJsonColumn } from "../lib/parse-json-column";
import type { AuditAction } from "../telemetry/events";

export const policyRoutes = createOpenAPIRouter();

function genId(): string {
  const arr = new Uint8Array(6);
  crypto.getRandomValues(arr);
  return [...arr].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ── Zod schemas ─────────────────────────────────────────────────

const policyCreateBody = z.object({
  name: z.string().min(1),
  budget_limit_usd: z.number().optional(),
  blocked_tools: z.array(z.string()).optional(),
  allowed_domains: z.array(z.string()).optional(),
  require_confirmation: z.boolean().optional(),
  max_turns: z.number().int().optional(),
});

// ── GET / ───────────────────────────────────────────────────────

const listPoliciesRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Policies"],
  summary: "List all policy templates",
  middleware: [requireScope("policies:read")],
  responses: {
    200: { description: "List of policies", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(401),
  },
});

policyRoutes.openapi(listPoliciesRoute, async (c): Promise<any> => {
  const user = c.get("user");
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    // policy_templates is NOT RLS-enforced; keep the explicit WHERE clause
    // (also includes built-in templates with org_id = '').
    const rows = await sql`
      SELECT * FROM policy_templates WHERE org_id = ${user.org_id} OR org_id = '' ORDER BY name
    `;
    return c.json({ policies: rows });
  });
});

// ── POST / ──────────────────────────────────────────────────────

const createPolicyRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Policies"],
  summary: "Create a policy template",
  middleware: [requireScope("policies:write")],
  request: { body: { content: { "application/json": { schema: policyCreateBody } } } },
  responses: {
    200: { description: "Policy created", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(400, 401),
  },
});

policyRoutes.openapi(createPolicyRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const body = c.req.valid("json");
  const name = String(body.name || "").trim();
  if (!name) return c.json({ error: "name is required" }, 400);

  const budgetLimitUsd = Number(body.budget_limit_usd ?? 10.0);
  const blockedTools = Array.isArray(body.blocked_tools) ? body.blocked_tools : [];
  const allowedDomains = Array.isArray(body.allowed_domains) ? body.allowed_domains : [];
  const requireConfirmation = body.require_confirmation !== false;
  const maxTurns = Number(body.max_turns || 50);

  const policy = {
    budget_limit_usd: budgetLimitUsd,
    blocked_tools: blockedTools,
    allowed_domains: allowedDomains,
    require_confirmation_for_destructive: requireConfirmation,
    max_turns: maxTurns,
  };

  const policyId = genId();
  const policyJson = JSON.stringify(policy);

  return await withOrgDb(c.env, user.org_id, async (sql) => {
    await sql`
      INSERT INTO policy_templates (id, name, description, category, template)
      VALUES (${policyId}, ${name}, ${''}, ${''}, ${policyJson})
    `;

    // Audit
    const now = new Date().toISOString();
    try {
      await sql`
        INSERT INTO audit_log (org_id, actor_id, action, resource_type, resource_name, details, created_at)
        VALUES (${user.org_id}, ${user.user_id}, ${"policy.create" satisfies AuditAction}, 'policy', ${policyId}, ${JSON.stringify({ name })}, ${now})
      `;
    } catch {}

    return c.json({ policy_id: policyId, name, policy });
  });
});

// ── GET /:policy_id ─────────────────────────────────────────────

const getPolicyRoute = createRoute({
  method: "get",
  path: "/{policy_id}",
  tags: ["Policies"],
  summary: "Get a policy template by ID",
  middleware: [requireScope("policies:read")],
  request: {
    params: z.object({ policy_id: z.string() }),
  },
  responses: {
    200: { description: "Policy detail", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(401, 404),
  },
});

policyRoutes.openapi(getPolicyRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { policy_id: policyId } = c.req.valid("param");
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const rows = await sql`SELECT * FROM policy_templates WHERE policy_id = ${policyId} AND (org_id = ${user.org_id} OR org_id = '')`;
    if (rows.length === 0) return c.json({ error: "Policy not found" }, 404);
    const d: any = { ...rows[0] };
    d.policy = parseJsonColumn(d.policy);
    delete d.policy;
    return c.json(d);
  });
});

// ── DELETE /:policy_id ──────────────────────────────────────────

const deletePolicyRoute = createRoute({
  method: "delete",
  path: "/{policy_id}",
  tags: ["Policies"],
  summary: "Delete a policy template",
  middleware: [requireScope("policies:write")],
  request: {
    params: z.object({ policy_id: z.string() }),
  },
  responses: {
    200: { description: "Policy deleted", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(401),
  },
});

policyRoutes.openapi(deletePolicyRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { policy_id: policyId } = c.req.valid("param");
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    await sql`DELETE FROM policy_templates WHERE policy_id = ${policyId} AND org_id = ${user.org_id}`;
    return c.json({ deleted: policyId });
  });
});
