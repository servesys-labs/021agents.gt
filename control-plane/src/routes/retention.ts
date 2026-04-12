/**
 * Retention router — data lifecycle, redaction policies.
 */
import { createRoute, z } from "@hono/zod-openapi";
import { createOpenAPIRouter } from "../lib/openapi";
import { ErrorSchema, errorResponses } from "../schemas/openapi";
import type { CurrentUser } from "../auth/types";
import { withOrgDb } from "../db/client";
import { requireScope } from "../middleware/auth";
import { logSecurityEvent } from "../logic/security-events";
import type { AuditAction, SecurityEventType } from "../telemetry/events";

export const retentionRoutes = createOpenAPIRouter();

function genId(): string {
  const arr = new Uint8Array(6);
  crypto.getRandomValues(arr);
  return [...arr].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const VALID_RESOURCE_TYPES = new Set([
  "sessions", "turns", "episodes", "billing_records", "audit_log", "cost_ledger",
]);

// ── GET / — List retention policies ────────────────────────────────────────
const listRetentionRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Retention"],
  summary: "List retention policies",
  middleware: [requireScope("retention:read")],
  responses: {
    200: { description: "Retention policy list", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(401, 403),
  },
});
retentionRoutes.openapi(listRetentionRoute, async (c): Promise<any> => {
  const user = c.get("user");
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    // RLS filters retention_policies by current org; the OR org_id = ''
    // also returns built-in templates which the policy permits.
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
});

// ── POST / — Create retention policy ───────────────────────────────────────
const createRetentionRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Retention"],
  summary: "Create retention policy",
  middleware: [requireScope("retention:write")],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            resource_type: z.string(),
            retention_days: z.number().optional(),
            redact_pii: z.boolean().optional(),
            redact_fields: z.array(z.string()).optional(),
            archive_before_delete: z.boolean().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Policy created", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(400, 401, 403),
  },
});
retentionRoutes.openapi(createRetentionRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const body = c.req.valid("json");
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

  const policyId = genId();

  return await withOrgDb(c.env, user.org_id, async (sql) => {
    await sql`
      INSERT INTO retention_policies (policy_id, org_id, resource_type, retention_days, redact_pii, redact_fields, archive_before_delete)
      VALUES (${policyId}, ${user.org_id}, ${resourceType}, ${retentionDays}, ${redactPii}, ${JSON.stringify(redactFields)}, ${archiveBeforeDelete})
    `;

    return c.json({ policy_id: policyId, resource_type: resourceType, retention_days: retentionDays });
  });
});

// ── DELETE /{policy_id} — Delete retention policy ──────────────────────────
const deleteRetentionRoute = createRoute({
  method: "delete",
  path: "/{policy_id}",
  tags: ["Retention"],
  summary: "Delete retention policy",
  middleware: [requireScope("retention:write")],
  request: {
    params: z.object({ policy_id: z.string() }),
  },
  responses: {
    200: { description: "Policy deleted", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(401, 403),
  },
});
retentionRoutes.openapi(deleteRetentionRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { policy_id: policyId } = c.req.valid("param");
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    await sql`DELETE FROM retention_policies WHERE policy_id = ${policyId}`;
    return c.json({ deleted: policyId });
  });
});

// ── POST /apply — Apply retention policies ─────────────────────────────────
const applyRetentionRoute = createRoute({
  method: "post",
  path: "/apply",
  tags: ["Retention"],
  summary: "Apply retention policies",
  middleware: [requireScope("retention:write")],
  responses: {
    200: { description: "Applied results", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(401, 403),
  },
});
retentionRoutes.openapi(applyRetentionRoute, async (c): Promise<any> => {
  const user = c.get("user");
  return await withOrgDb(c.env, user.org_id, async (sql) => {

  // Get all active policies for the org
  const policies = await sql`
    SELECT * FROM retention_policies WHERE org_id = ${user.org_id} OR org_id = ''
  `;

  const results: Record<string, number> = {};
  const nowMs = Date.now();

  // Explicit handler functions per table — no dynamic table names
  const RETENTION_HANDLERS: Record<string, (sql: any, cutoff: string, orgId: string) => Promise<number>> = {
    sessions: async (sql, cutoff, orgId) => {
      const r = orgId
        ? await sql`DELETE FROM sessions WHERE created_at < ${cutoff} AND org_id = ${orgId}`
        : await sql`DELETE FROM sessions WHERE created_at < ${cutoff}`;
      return r.count ?? 0;
    },
    turns: async (sql, cutoff, orgId) => {
      const r = orgId
        ? await sql`DELETE FROM turns WHERE created_at < ${cutoff} AND session_id IN (SELECT session_id FROM sessions WHERE org_id = ${orgId})`
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
      // Check immutable_audit mode before deleting
      if (orgId) {
        try {
          const settingsRows = await sql`
            SELECT settings FROM org_settings WHERE org_id = ${orgId} LIMIT 1
          `;
          if (settingsRows.length > 0) {
            const settings = typeof settingsRows[0].settings === "string"
              ? JSON.parse(settingsRows[0].settings)
              : settingsRows[0].settings ?? {};
            if (settings.immutable_audit === true) {
              // Archive rows to R2 before deleting
              const archiveRows = await sql`
                SELECT * FROM audit_log WHERE created_at < ${cutoff} AND org_id = ${orgId}
                ORDER BY created_at ASC LIMIT 10000
              `;
              if (archiveRows.length > 0) {
                // Store archived rows — R2 is accessed via env binding at the route level
                // The archive key uses org + timestamp for uniqueness
                const archiveKey = `audit-archive/${orgId}/${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
                try {
                  // R2 bucket is not directly available here; store archive data in audit_log_archive table
                  await sql`
                    INSERT INTO audit_log_archive (archive_key, org_id, row_count, data, created_at)
                    VALUES (${archiveKey}, ${orgId}, ${archiveRows.length}, ${JSON.stringify(archiveRows)}, ${new Date().toISOString()})
                  `;
                } catch {
                  // If archive table doesn't exist, skip archival but still allow delete
                }

                logSecurityEvent(sql, {
                  org_id: orgId,
                  event_type: "policy.audit_archived" satisfies SecurityEventType,
                  actor_id: "system",
                  actor_type: "system",
                  severity: "medium",
                  details: { archive_key: archiveKey, rows_archived: archiveRows.length },
                });
              }
            }
          }
        } catch {
          // Best-effort immutable audit check
        }
      }

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
    const cutoff = new Date(nowMs - p.retention_days * 86400 * 1000).toISOString();
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
      INSERT INTO audit_log (org_id, actor_id, action, resource_type, details, created_at)
      VALUES (${user.org_id}, ${user.user_id}, ${"retention.applied" satisfies AuditAction}, 'retention', ${JSON.stringify(results)}, ${new Date().toISOString()})
    `;
  } catch {}

  return c.json({ applied: results });
  });
});
