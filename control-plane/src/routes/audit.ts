/**
 * Audit router — compliance audit log with export and tamper evidence.
 * Ported from agentos/api/routers/audit.py
 *
 * Hash chain export uses SHA-256 chaining for tamper evidence.
 */
import { createRoute, z } from "@hono/zod-openapi";
import { createOpenAPIRouter } from "../lib/openapi";
import { ErrorSchema, errorResponses } from "../schemas/openapi";
import type { CurrentUser } from "../auth/types";
import { withOrgDb, withAdminDb } from "../db/client";

export const auditRoutes = createOpenAPIRouter();

async function sha256Hex(data: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ── GET /log — Query audit log ────────────────────────────────────────────
const auditLogRoute = createRoute({
  method: "get",
  path: "/log",
  tags: ["Audit"],
  summary: "Query audit log",
  request: {
    query: z.object({
      action: z.string().optional(),
      user_id: z.string().optional(),
      since_days: z.coerce.number().optional(),
      limit: z.coerce.number().optional(),
    }),
  },
  responses: {
    200: { description: "Audit log entries", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(401),
  },
});
auditRoutes.openapi(auditLogRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const query = c.req.valid("query");
  const action = query.action || "";
  const userId = query.user_id || "";
  const sinceDays = Math.max(1, Math.min(365, Number(query.since_days) || 30));
  const limit = Math.min(10000, Math.max(1, Number(query.limit) || 100));
  const since = new Date(Date.now() - sinceDays * 86400 * 1000).toISOString();

  return await withOrgDb(c.env, user.org_id, async (sql) => {
    let rows;
    if (action && userId) {
      rows = await sql`
        SELECT * FROM audit_log
        WHERE action = ${action} AND user_id = ${userId} AND created_at >= ${since}
        ORDER BY created_at DESC LIMIT ${limit}
      `;
    } else if (action) {
      rows = await sql`
        SELECT * FROM audit_log
        WHERE action = ${action} AND created_at >= ${since}
        ORDER BY created_at DESC LIMIT ${limit}
      `;
    } else if (userId) {
      rows = await sql`
        SELECT * FROM audit_log
        WHERE user_id = ${userId} AND created_at >= ${since}
        ORDER BY created_at DESC LIMIT ${limit}
      `;
    } else {
      rows = await sql`
        SELECT * FROM audit_log
        WHERE created_at >= ${since}
        ORDER BY created_at DESC LIMIT ${limit}
      `;
    }

    return c.json({ entries: rows, total: rows.length });
  });
});

// ── GET /export — Export audit log with hash chain ────────────────────────
const auditExportRoute = createRoute({
  method: "get",
  path: "/export",
  tags: ["Audit"],
  summary: "Export audit log with tamper-evident hash chain",
  request: {
    query: z.object({
      since_days: z.coerce.number().optional(),
      limit: z.coerce.number().optional(),
    }),
  },
  responses: {
    200: { description: "Audit export with integrity hash", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(401),
  },
});
auditRoutes.openapi(auditExportRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const query = c.req.valid("query");
  const sinceDays = Math.max(1, Math.min(365, Number(query.since_days) || 30));
  const limit = Math.min(10000, Math.max(1, Number(query.limit) || 10000));
  const since = new Date(Date.now() - sinceDays * 86400 * 1000).toISOString();

  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const entries = await sql`
      SELECT * FROM audit_log
      WHERE created_at >= ${since}
      ORDER BY created_at ASC LIMIT ${limit}
    `;

    // Build hash chain for tamper evidence
    const chain: any[] = [];
    let prevHash = "genesis";
    for (const entry of entries) {
      const entryJson = JSON.stringify(entry, Object.keys(entry as any).sort());
      const currentHash = await sha256Hex(`${prevHash}:${entryJson}`);
      chain.push({ ...entry, chain_hash: currentHash });
      prevHash = currentHash;
    }

    // Final integrity hash
    const allHashes = JSON.stringify(chain.map((e: any) => e.chain_hash));
    const integrityHash = await sha256Hex(allHashes);

    return c.json({
      entries: chain,
      total: chain.length,
      exported_at: Date.now() / 1000,
      integrity_hash: integrityHash,
      org_id: user.org_id,
    });
  });
});

// ── DELETE /log — Immutable audit mode guard ──────────────────────────────
const deleteAuditLogRoute = createRoute({
  method: "delete",
  path: "/log",
  tags: ["Audit"],
  summary: "Delete audit log entries (immutable mode guard)",
  request: {
    query: z.object({
      since_days: z.coerce.number().optional(),
    }),
  },
  responses: {
    200: { description: "Deleted count", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(401, 403, 500),
  },
});
auditRoutes.openapi(deleteAuditLogRoute, async (c): Promise<any> => {
  const user = c.get("user");
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    // Check immutable_audit setting
    try {
      const settingsRows = await sql`
        SELECT settings FROM org_settings LIMIT 1
      `;
      if (settingsRows.length > 0) {
        const settings = typeof settingsRows[0].settings === "string"
          ? JSON.parse(settingsRows[0].settings)
          : settingsRows[0].settings ?? {};
        if (settings.immutable_audit === true) {
          return c.json({ error: "Audit log is in immutable mode" }, 403);
        }
      }
    } catch {
      // If we can't verify, deny by default for safety
      return c.json({ error: "Unable to verify audit immutability setting" }, 500);
    }

    // If not immutable, allow deletion with filters
    const query = c.req.valid("query");
    const sinceDays = Math.max(1, Math.min(365, Number(query.since_days) || 30));
    const since = new Date(Date.now() - sinceDays * 86400 * 1000).toISOString();

    const result = await sql`
      DELETE FROM audit_log
      WHERE created_at < ${since}
    `;

    return c.json({ deleted: result.count ?? 0 });
  });
});

// ── DELETE /log/{entry_id} — Delete a single audit entry (immutable guard)
const deleteAuditEntryRoute = createRoute({
  method: "delete",
  path: "/log/{entry_id}",
  tags: ["Audit"],
  summary: "Delete a single audit entry (immutable mode guard)",
  request: {
    params: z.object({ entry_id: z.string() }),
  },
  responses: {
    200: { description: "Deleted count", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(401, 403, 500),
  },
});
auditRoutes.openapi(deleteAuditEntryRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { entry_id: entryId } = c.req.valid("param");
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    // Check immutable_audit setting
    try {
      const settingsRows = await sql`
        SELECT settings FROM org_settings LIMIT 1
      `;
      if (settingsRows.length > 0) {
        const settings = typeof settingsRows[0].settings === "string"
          ? JSON.parse(settingsRows[0].settings)
          : settingsRows[0].settings ?? {};
        if (settings.immutable_audit === true) {
          return c.json({ error: "Audit log is in immutable mode" }, 403);
        }
      }
    } catch {
      return c.json({ error: "Unable to verify audit immutability setting" }, 500);
    }

    const result = await sql`
      DELETE FROM audit_log
      WHERE id = ${entryId}
    `;

    return c.json({ deleted: result.count ?? 0 });
  });
});

// ── GET /events — List event types ────────────────────────────────────────
const eventTypesRoute = createRoute({
  method: "get",
  path: "/events",
  tags: ["Audit"],
  summary: "List event types",
  responses: {
    200: { description: "Event type list", content: { "application/json": { schema: z.record(z.unknown()) } } },
  },
});
auditRoutes.openapi(eventTypesRoute, async (c): Promise<any> => {
  // event_types is a global catalog table — use admin connection.
  return await withAdminDb(c.env, async (sql) => {
    try {
      const rows = await sql`SELECT * FROM event_types ORDER BY category, event_type`;
      return c.json({ event_types: rows });
    } catch {
      return c.json({ event_types: [] });
    }
  });
});
