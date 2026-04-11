/**
 * Compliance routes — GDPR Art. 17 account deletion, Art. 20 data portability.
 * Provides full account erasure and data export endpoints for regulatory compliance.
 */
import { createRoute, z } from "@hono/zod-openapi";
import type { CurrentUser } from "../auth/types";
import { hasRole } from "../auth/types";
import { createOpenAPIRouter } from "../lib/openapi";
import { ErrorSchema, errorResponses } from "../schemas/openapi";
import { withOrgDb, type OrgSql } from "../db/client";
import { requireScope } from "../middleware/auth";

export const complianceRoutes = createOpenAPIRouter();

function genId(): string {
  const arr = new Uint8Array(12);
  crypto.getRandomValues(arr);
  return [...arr].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Fire-and-forget security event log */
async function logSecurityEvent(
  sql: OrgSql,
  orgId: string,
  userId: string,
  action: string,
  details: Record<string, unknown>,
): Promise<void> {
  try {
    await sql`
      INSERT INTO security_events (org_id, user_id, event_type, details, created_at)
      VALUES (${orgId}, ${userId}, ${action}, ${JSON.stringify(details)}, now())
    `;
  } catch { /* non-critical */ }
}

/** Fire-and-forget audit log */
async function auditLog(
  sql: OrgSql,
  orgId: string,
  userId: string,
  action: string,
  resourceType: string,
  resourceId: string,
  details: Record<string, unknown>,
): Promise<void> {
  try {
    await sql`
      INSERT INTO audit_log (org_id, actor_id, action, resource_type, resource_name, details, created_at)
      VALUES (${orgId}, ${userId}, ${action}, ${resourceType}, ${resourceId}, ${JSON.stringify(details)}, now())
    `;
  } catch { /* non-critical */ }
}

// ── Zod schemas ─────────────────────────────────────────────────

const deleteAccountBody = z.object({
  user_id: z.string().min(1),
  reason: z.string().optional(),
});

// ── DELETE /account — Full account deletion (GDPR Art. 17) ──────────────

const deleteAccountRoute = createRoute({
  method: "delete",
  path: "/account",
  tags: ["Compliance"],
  summary: "Delete a user account (GDPR Art. 17 erasure)",
  middleware: [requireScope("admin")],
  request: { body: { content: { "application/json": { schema: deleteAccountBody } } } },
  responses: {
    200: { description: "Account deleted", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(400, 401, 403, 500),
  },
});

complianceRoutes.openapi(deleteAccountRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { user_id: targetUserId, reason: rawReason } = c.req.valid("json");
  const reason = rawReason ?? "GDPR Art. 17 erasure request";

  if (!targetUserId) {
    return c.json({ error: "user_id is required" }, 400);
  }

  // Self-deletion is always allowed; otherwise require admin/owner role
  const isSelf = targetUserId === user.user_id;
  if (!isSelf && !hasRole(user, "admin")) {
    return c.json({ error: "Admin or owner role required to delete other accounts" }, 403);
  }

  const requestId = genId();
  const orgId = user.org_id;

  return await withOrgDb(c.env, user.org_id, async (sql) => {
    // Create deletion request record
    await sql`
      INSERT INTO account_deletion_requests (request_id, org_id, user_id, requested_by, reason, status, created_at)
      VALUES (${requestId}, ${orgId}, ${targetUserId}, ${user.user_id}, ${reason}, 'processing', now())
    `;

    let rowsDeleted = 0;
    const tablesPurged: string[] = [];

    try {
    // 1. conversation_messages (via conversation_id join)
    const msgResult = await sql`
      DELETE FROM conversation_messages
      WHERE conversation_id IN (
        SELECT conversation_id FROM conversations
        WHERE org_id = ${orgId} AND external_user_id = ${targetUserId}
      )
    `;
    const msgCount = msgResult.count ?? 0;
    if (msgCount > 0) { rowsDeleted += msgCount; tablesPurged.push("conversation_messages"); }

    // 2. conversations
    const convResult = await sql`
      DELETE FROM conversations WHERE org_id = ${orgId} AND external_user_id = ${targetUserId}
    `;
    const convCount = convResult.count ?? 0;
    if (convCount > 0) { rowsDeleted += convCount; tablesPurged.push("conversations"); }

    // 3. turns (via session_id join)
    const turnsResult = await sql`
      DELETE FROM turns
      WHERE session_id IN (
        SELECT session_id FROM sessions
        WHERE org_id = ${orgId} AND user_id = ${targetUserId}
      )
    `;
    const turnsCount = turnsResult.count ?? 0;
    if (turnsCount > 0) { rowsDeleted += turnsCount; tablesPurged.push("turns"); }

    // 4. sessions
    const sessResult = await sql`
      DELETE FROM sessions WHERE org_id = ${orgId} AND user_id = ${targetUserId}
    `;
    const sessCount = sessResult.count ?? 0;
    if (sessCount > 0) { rowsDeleted += sessCount; tablesPurged.push("sessions"); }

    // 5. end_user_usage
    const usageResult = await sql`
      DELETE FROM end_user_usage WHERE end_user_id = ${targetUserId}
    `;
    const usageCount = usageResult.count ?? 0;
    if (usageCount > 0) { rowsDeleted += usageCount; tablesPurged.push("end_user_usage"); }

    // 6. end_user_tokens
    const eutResult = await sql`
      DELETE FROM end_user_tokens WHERE end_user_id = ${targetUserId}
    `;
    const eutCount = eutResult.count ?? 0;
    if (eutCount > 0) { rowsDeleted += eutCount; tablesPurged.push("end_user_tokens"); }

    // 7. api_keys
    const akResult = await sql`
      DELETE FROM api_keys WHERE user_id = ${targetUserId}
    `;
    const akCount = akResult.count ?? 0;
    if (akCount > 0) { rowsDeleted += akCount; tablesPurged.push("api_keys"); }

    // 8. file_uploads — also purge from R2
    const files = await sql`
      SELECT file_id, r2_key FROM file_uploads WHERE uploaded_by = ${targetUserId}
    `;
    if (files.length > 0) {
      for (const file of files) {
        if (file.r2_key) {
          try { await c.env.STORAGE.delete(file.r2_key); } catch { /* best effort */ }
        }
      }
      await sql`DELETE FROM file_uploads WHERE uploaded_by = ${targetUserId}`;
      rowsDeleted += files.length;
      tablesPurged.push("file_uploads");
    }

    // 9. session_feedback
    const fbResult = await sql`
      DELETE FROM session_feedback WHERE user_id = ${targetUserId}
    `;
    const fbCount = fbResult.count ?? 0;
    if (fbCount > 0) { rowsDeleted += fbCount; tablesPurged.push("session_feedback"); }

    // 10. org_members
    const omResult = await sql`
      DELETE FROM org_members WHERE user_id = ${targetUserId}
    `;
    const omCount = omResult.count ?? 0;
    if (omCount > 0) { rowsDeleted += omCount; tablesPurged.push("org_members"); }

    // 11. users
    const uResult = await sql`
      DELETE FROM users WHERE user_id = ${targetUserId}
    `;
    const uCount = uResult.count ?? 0;
    if (uCount > 0) { rowsDeleted += uCount; tablesPurged.push("users"); }

    // Anonymize audit_log and security_events (retained for compliance)
    const anonymizedId = `[deleted-${requestId}]`;

    await sql`
      UPDATE audit_log SET user_id = ${anonymizedId}
      WHERE user_id = ${targetUserId} AND org_id = ${orgId}
    `;

    await sql`
      UPDATE security_events SET user_id = ${anonymizedId}
      WHERE user_id = ${targetUserId} AND org_id = ${orgId}
    `;

    // Mark deletion request as completed
    await sql`
      UPDATE account_deletion_requests
      SET status = 'completed', rows_deleted = ${rowsDeleted},
          tables_purged = ${JSON.stringify(tablesPurged)}, completed_at = now()
      WHERE request_id = ${requestId}
    `;

    await logSecurityEvent(sql, orgId, user.user_id, "account.deletion_completed", {
      request_id: requestId,
      target_user_id: targetUserId,
      rows_deleted: rowsDeleted,
      tables_purged: tablesPurged,
      reason,
    });

    return c.json({
      request_id: requestId,
      status: "completed",
      rows_deleted: rowsDeleted,
      tables_purged: tablesPurged,
    });
  } catch (err: any) {
    // Mark as failed
    await sql`
      UPDATE account_deletion_requests
      SET status = 'failed', completed_at = now()
      WHERE request_id = ${requestId}
    `.catch(() => {});

    await logSecurityEvent(sql, orgId, user.user_id, "account.deletion_failed", {
      request_id: requestId,
      target_user_id: targetUserId,
      error: err?.message ?? "unknown",
    });

      return c.json({ error: "Account deletion failed", request_id: requestId }, 500);
    }
  });
});

// ── POST /data-export — Request full data export (GDPR Art. 20) ─────────

const dataExportRoute = createRoute({
  method: "post",
  path: "/data-export",
  tags: ["Compliance"],
  summary: "Request full data export (GDPR Art. 20 portability)",
  middleware: [requireScope("admin")],
  responses: {
    200: { description: "Data export result", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(401, 500),
  },
});

complianceRoutes.openapi(dataExportRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const orgId = user.org_id;
  const exportId = genId();

  return await withOrgDb(c.env, user.org_id, async (sql) => {
    // Create export request record
    await sql`
      INSERT INTO data_export_requests (export_id, org_id, requested_by, status, created_at)
      VALUES (${exportId}, ${orgId}, ${user.user_id}, 'pending', now())
    `;

    try {
    // Collect all org data
    const [
      agents,
      agentVersions,
      sessions,
      turns,
      conversations,
      conversationMessages,
      apiKeys,
      billingRecords,
      webhooks,
      webhookDeliveries,
      fileUploads,
      orgSettings,
      orgMembers,
    ] = await Promise.all([
      sql`SELECT * FROM agents LIMIT 10000`,
      sql`SELECT * FROM agent_versions LIMIT 10000`,
      sql`SELECT * FROM sessions LIMIT 10000`,
      sql`SELECT t.* FROM turns t JOIN sessions s ON t.session_id = s.session_id LIMIT 10000`,
      sql`SELECT * FROM conversations LIMIT 10000`,
      sql`SELECT cm.* FROM conversation_messages cm
          JOIN conversations cv ON cm.conversation_id = cv.conversation_id
          LIMIT 10000`,
      sql`SELECT key_id, org_id, user_id, name, scopes, created_at, expires_at, last_used_at, revoked
          FROM api_keys LIMIT 10000`,
      sql`SELECT * FROM billing_records LIMIT 10000`,
      sql`SELECT * FROM webhooks LIMIT 10000`,
      sql`SELECT wd.* FROM webhook_deliveries wd
          JOIN webhooks w ON wd.webhook_id = w.webhook_id
          LIMIT 10000`,
      sql`SELECT file_id, org_id, uploaded_by, filename, content_type, size_bytes, created_at
          FROM file_uploads LIMIT 10000`,
      sql`SELECT * FROM org_settings LIMIT 10000`,
      sql`SELECT * FROM org_members WHERE org_id = ${orgId} LIMIT 10000`,
    ]);

    // Attach turns to sessions, messages to conversations
    const sessionsWithTurns = sessions.map((s: any) => ({
      ...s,
      turns: turns.filter((t: any) => t.session_id === s.session_id),
    }));

    const conversationsWithMessages = conversations.map((cv: any) => ({
      ...cv,
      messages: conversationMessages.filter((m: any) => m.conversation_id === cv.conversation_id),
    }));

    const agentsWithVersions = agents.map((a: any) => ({
      ...a,
      versions: agentVersions.filter((v: any) => v.agent_id === a.agent_id),
    }));

    const exportData = {
      export_id: exportId,
      org_id: orgId,
      exported_at: new Date().toISOString(),
      agents: agentsWithVersions,
      sessions: sessionsWithTurns,
      conversations: conversationsWithMessages,
      api_keys: apiKeys,
      billing_records: billingRecords,
      webhooks: webhooks,
      webhook_deliveries: webhookDeliveries,
      file_uploads: fileUploads,
      org_settings: orgSettings,
      org_members: orgMembers,
    };

    const jsonBody = JSON.stringify(exportData, null, 2);
    const sizeBytes = new TextEncoder().encode(jsonBody).byteLength;
    const r2Key = `exports/${orgId}/${exportId}.json`;

    // Upload to R2
    await c.env.STORAGE.put(r2Key, jsonBody, {
      httpMetadata: { contentType: "application/json" },
      customMetadata: { org_id: orgId, export_id: exportId },
    });

    // Expires in 7 days
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    await sql`
      UPDATE data_export_requests
      SET status = 'completed', r2_key = ${r2Key}, size_bytes = ${sizeBytes},
          expires_at = ${expiresAt}, completed_at = now()
      WHERE export_id = ${exportId}
    `;

    await auditLog(sql, orgId, user.user_id, "data_export.completed", "compliance", exportId, {
      size_bytes: sizeBytes,
    });

    return c.json({
      export_id: exportId,
      status: "completed",
      download_url: `/api/v1/compliance/data-export/${exportId}`,
      size_bytes: sizeBytes,
      expires_at: expiresAt,
    });
    } catch (err: any) {
      await sql`
        UPDATE data_export_requests
        SET status = 'failed', completed_at = now()
        WHERE export_id = ${exportId}
      `.catch(() => {});

      return c.json({ error: "Data export failed", export_id: exportId }, 500);
    }
  });
});

// ── GET /data-export/:export_id — Download data export ──────────────────

const downloadExportRoute = createRoute({
  method: "get",
  path: "/data-export/{export_id}",
  tags: ["Compliance"],
  summary: "Download a data export by ID",
  middleware: [requireScope("admin")],
  request: {
    params: z.object({ export_id: z.string() }),
  },
  responses: {
    200: { description: "Export file (JSON)", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(400, 401, 404),
  },
});

complianceRoutes.openapi(downloadExportRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { export_id: exportId } = c.req.valid("param");

  const exportReq = await withOrgDb(c.env, user.org_id, async (sql) => {
    const rows = await sql`
      SELECT * FROM data_export_requests
      WHERE export_id = ${exportId}
      LIMIT 1
    `;
    return rows.length > 0 ? (rows[0] as any) : null;
  });

  if (!exportReq) {
    return c.json({ error: "Export not found" }, 404);
  }

  if (exportReq.status !== "completed" || !exportReq.r2_key) {
    return c.json({ error: "Export not ready or failed", status: exportReq.status }, 400);
  }

  // Check expiry
  if (exportReq.expires_at && new Date(exportReq.expires_at) < new Date()) {
    return c.json({ error: "Export has expired" }, 404);
  }

  const obj = await c.env.STORAGE.get(exportReq.r2_key);
  if (!obj) {
    return c.json({ error: "Export file not found in storage" }, 404);
  }

  return new Response(obj.body, {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="export-${exportId}.json"`,
    },
  });
});

// ── GET /data-export — List export requests ─────────────────────────────

const listExportsRoute = createRoute({
  method: "get",
  path: "/data-export",
  tags: ["Compliance"],
  summary: "List data export requests",
  middleware: [requireScope("admin")],
  responses: {
    200: { description: "List of exports", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(401),
  },
});

complianceRoutes.openapi(listExportsRoute, async (c): Promise<any> => {
  const user = c.get("user");
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const rows = await sql`
      SELECT export_id, org_id, requested_by, status, size_bytes, expires_at, created_at, completed_at
      FROM data_export_requests
      ORDER BY created_at DESC
      LIMIT 50
    `;

    return c.json({ exports: rows });
  });
});

// ── GET /deletion-requests — List deletion requests ─────────────────────

const listDeletionRequestsRoute = createRoute({
  method: "get",
  path: "/deletion-requests",
  tags: ["Compliance"],
  summary: "List account deletion requests",
  middleware: [requireScope("admin")],
  responses: {
    200: { description: "List of deletion requests", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(401),
  },
});

complianceRoutes.openapi(listDeletionRequestsRoute, async (c): Promise<any> => {
  const user = c.get("user");
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const rows = await sql`
      SELECT request_id, org_id, user_id, requested_by, reason, status,
             rows_deleted, tables_purged, created_at, completed_at
      FROM account_deletion_requests
      ORDER BY created_at DESC
      LIMIT 50
    `;

    const result = rows.map((r: any) => {
      const d = { ...r };
      try { d.tables_purged = JSON.parse(d.tables_purged || "[]"); } catch { d.tables_purged = []; }
      return d;
    });

    return c.json({ deletion_requests: result });
  });
});
