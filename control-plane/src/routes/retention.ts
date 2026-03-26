/**
 * Retention router — data lifecycle, redaction policies.
 * Ported from agentos/api/routers/retention.py
 */
import { Hono } from "hono";
import type { Env } from "../env";
import type { CurrentUser } from "../auth/types";
import { getDbForOrg } from "../db/client";
import { requireScope } from "../middleware/auth";

type R = { Bindings: Env; Variables: { user: CurrentUser } };
export const retentionRoutes = new Hono<R>();

function genId(): string {
  const arr = new Uint8Array(6);
  crypto.getRandomValues(arr);
  return [...arr].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const VALID_RESOURCE_TYPES = new Set([
  "sessions", "turns", "episodes", "billing_records", "audit_log", "cost_ledger",
]);

retentionRoutes.get("/", requireScope("retention:read"), async (c) => {
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const rows = await sql`
    SELECT * FROM retention_policies WHERE org_id = ${user.org_id} OR org_id = '' ORDER BY resource_type
  `;
  const result = rows.map((r: any) => {
    const d = { ...r };
    try { d.redact_fields = JSON.parse(d.redact_fields || "[]"); } catch { d.redact_fields = []; }
    return d;
  });
  return c.json({ policies: result });
});

retentionRoutes.post("/", requireScope("retention:write"), async (c) => {
  const user = c.get("user");
  const body = await c.req.json();
  const resourceType = String(body.resource_type || "");
  const retentionDays = Number(body.retention_days || 90);
  const redactPii = Boolean(body.redact_pii);
  const redactFields = Array.isArray(body.redact_fields) ? body.redact_fields : [];
  const archiveBeforeDelete = body.archive_before_delete !== false;

  if (!VALID_RESOURCE_TYPES.has(resourceType)) {
    return c.json(
      { error: `Invalid resource_type. Must be one of: ${[...VALID_RESOURCE_TYPES].join(", ")}` },
      400,
    );
  }

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const policyId = genId();

  await sql`
    INSERT INTO retention_policies (policy_id, org_id, resource_type, retention_days, redact_pii, redact_fields, archive_before_delete)
    VALUES (${policyId}, ${user.org_id}, ${resourceType}, ${retentionDays}, ${redactPii}, ${JSON.stringify(redactFields)}, ${archiveBeforeDelete})
  `;

  return c.json({ policy_id: policyId, resource_type: resourceType, retention_days: retentionDays });
});

retentionRoutes.delete("/:policy_id", requireScope("retention:write"), async (c) => {
  const user = c.get("user");
  const policyId = c.req.param("policy_id");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  await sql`DELETE FROM retention_policies WHERE policy_id = ${policyId} AND org_id = ${user.org_id}`;
  return c.json({ deleted: policyId });
});

retentionRoutes.post("/apply", requireScope("retention:write"), async (c) => {
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  // Get all active policies for the org
  const policies = await sql`
    SELECT * FROM retention_policies WHERE org_id = ${user.org_id} OR org_id = ''
  `;

  const results: Record<string, number> = {};
  const now = Date.now() / 1000;

  // Explicit handler functions per table — no dynamic table names
  const RETENTION_HANDLERS: Record<string, (sql: any, cutoff: number, orgId: string) => Promise<number>> = {
    sessions: async (sql, cutoff, orgId) => {
      const r = orgId
        ? await sql`DELETE FROM sessions WHERE created_at < ${cutoff} AND org_id = ${orgId}`
        : await sql`DELETE FROM sessions WHERE created_at < ${cutoff}`;
      return r.count ?? 0;
    },
    turns: async (sql, cutoff, orgId) => {
      const r = orgId
        ? await sql`DELETE FROM turns WHERE created_at < ${cutoff} AND org_id = ${orgId}`
        : await sql`DELETE FROM turns WHERE created_at < ${cutoff}`;
      return r.count ?? 0;
    },
    episodes: async (sql, cutoff, orgId) => {
      const r = orgId
        ? await sql`DELETE FROM episodes WHERE created_at < ${cutoff} AND org_id = ${orgId}`
        : await sql`DELETE FROM episodes WHERE created_at < ${cutoff}`;
      return r.count ?? 0;
    },
    billing_records: async (sql, cutoff, orgId) => {
      const r = orgId
        ? await sql`DELETE FROM billing_records WHERE created_at < ${cutoff} AND org_id = ${orgId}`
        : await sql`DELETE FROM billing_records WHERE created_at < ${cutoff}`;
      return r.count ?? 0;
    },
    audit_log: async (sql, cutoff, orgId) => {
      const r = orgId
        ? await sql`DELETE FROM audit_log WHERE created_at < ${cutoff} AND org_id = ${orgId}`
        : await sql`DELETE FROM audit_log WHERE created_at < ${cutoff}`;
      return r.count ?? 0;
    },
    cost_ledger: async (sql, cutoff, orgId) => {
      const r = orgId
        ? await sql`DELETE FROM cost_ledger WHERE created_at < ${cutoff} AND org_id = ${orgId}`
        : await sql`DELETE FROM cost_ledger WHERE created_at < ${cutoff}`;
      return r.count ?? 0;
    },
  };

  for (const policy of policies) {
    const p = policy as any;
    const cutoff = now - p.retention_days * 86400;
    const table = p.resource_type as string;

    // Only delete from known tables
    if (!VALID_RESOURCE_TYPES.has(table)) continue;

    const handler = RETENTION_HANDLERS[table];
    if (!handler) continue;

    try {
      results[table] = await handler(sql, cutoff, p.org_id || "");
    } catch {
      results[table] = 0;
    }
  }

  // Audit the retention application
  try {
    await sql`
      INSERT INTO audit_log (org_id, user_id, action, resource_type, changes_json, created_at)
      VALUES (${user.org_id}, ${user.user_id}, 'retention.applied', 'retention', ${JSON.stringify(results)}, ${now})
    `;
  } catch {}

  return c.json({ applied: results });
});
