/**
 * Policies router — reusable governance policy templates.
 * Ported from agentos/api/routers/policies.py
 */
import { Hono } from "hono";
import type { Env } from "../env";
import type { CurrentUser } from "../auth/types";
import { getDbForOrg } from "../db/client";
import { requireScope } from "../middleware/auth";

type R = { Bindings: Env; Variables: { user: CurrentUser } };
export const policyRoutes = new Hono<R>();

function genId(): string {
  const arr = new Uint8Array(6);
  crypto.getRandomValues(arr);
  return [...arr].map((b) => b.toString(16).padStart(2, "0")).join("");
}

policyRoutes.get("/", requireScope("policies:read"), async (c) => {
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const rows = await sql`
    SELECT * FROM policy_templates WHERE org_id = ${user.org_id} OR org_id = '' ORDER BY name
  `;
  return c.json({ policies: rows });
});

policyRoutes.post("/", requireScope("policies:write"), async (c) => {
  const user = c.get("user");
  const body = await c.req.json();
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

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const policyId = genId();
  const policyJson = JSON.stringify(policy);

  await sql`
    INSERT INTO policy_templates (policy_id, org_id, name, policy_json)
    VALUES (${policyId}, ${user.org_id}, ${name}, ${policyJson})
  `;

  // Audit
  const now = Date.now() / 1000;
  try {
    await sql`
      INSERT INTO audit_log (org_id, user_id, action, resource_type, resource_id, changes_json, created_at)
      VALUES (${user.org_id}, ${user.user_id}, 'policy.create', 'policy', ${policyId}, ${JSON.stringify({ name })}, ${now})
    `;
  } catch {}

  return c.json({ policy_id: policyId, name, policy });
});

policyRoutes.get("/:policy_id", requireScope("policies:read"), async (c) => {
  const user = c.get("user");
  const policyId = c.req.param("policy_id");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const rows = await sql`SELECT * FROM policy_templates WHERE policy_id = ${policyId}`;
  if (rows.length === 0) return c.json({ error: "Policy not found" }, 404);
  const d: any = { ...rows[0] };
  try {
    d.policy = JSON.parse(d.policy_json || "{}");
  } catch {
    d.policy = {};
  }
  delete d.policy_json;
  return c.json(d);
});

policyRoutes.delete("/:policy_id", requireScope("policies:write"), async (c) => {
  const user = c.get("user");
  const policyId = c.req.param("policy_id");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  await sql`DELETE FROM policy_templates WHERE policy_id = ${policyId} AND org_id = ${user.org_id}`;
  return c.json({ deleted: policyId });
});
