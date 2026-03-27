/**
 * Audit router — compliance audit log with export and tamper evidence.
 * Ported from agentos/api/routers/audit.py
 *
 * Hash chain export uses SHA-256 chaining for tamper evidence.
 */
import { Hono } from "hono";
import type { Env } from "../env";
import type { CurrentUser } from "../auth/types";
import { getDb, getDbForOrg } from "../db/client";

type R = { Bindings: Env; Variables: { user: CurrentUser } };
export const auditRoutes = new Hono<R>();

async function sha256Hex(data: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

auditRoutes.get("/log", async (c) => {
  const user = c.get("user");
  const action = c.req.query("action") || "";
  const userId = c.req.query("user_id") || "";
  const sinceDays = Math.max(1, Math.min(365, Number(c.req.query("since_days")) || 30));
  const limit = Math.min(10000, Math.max(1, Number(c.req.query("limit")) || 100));
  const since = new Date(Date.now() - sinceDays * 86400 * 1000).toISOString();

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  let rows;
  if (action && userId) {
    rows = await sql`
      SELECT * FROM audit_log
      WHERE org_id = ${user.org_id} AND action = ${action} AND user_id = ${userId} AND created_at >= ${since}
      ORDER BY created_at DESC LIMIT ${limit}
    `;
  } else if (action) {
    rows = await sql`
      SELECT * FROM audit_log
      WHERE org_id = ${user.org_id} AND action = ${action} AND created_at >= ${since}
      ORDER BY created_at DESC LIMIT ${limit}
    `;
  } else if (userId) {
    rows = await sql`
      SELECT * FROM audit_log
      WHERE org_id = ${user.org_id} AND user_id = ${userId} AND created_at >= ${since}
      ORDER BY created_at DESC LIMIT ${limit}
    `;
  } else {
    rows = await sql`
      SELECT * FROM audit_log
      WHERE org_id = ${user.org_id} AND created_at >= ${since}
      ORDER BY created_at DESC LIMIT ${limit}
    `;
  }

  return c.json({ entries: rows, total: rows.length });
});

auditRoutes.get("/export", async (c) => {
  const user = c.get("user");
  const sinceDays = Math.max(1, Math.min(365, Number(c.req.query("since_days")) || 30));
  const limit = Math.min(10000, Math.max(1, Number(c.req.query("limit")) || 10000));
  const since = new Date(Date.now() - sinceDays * 86400 * 1000).toISOString();

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const entries = await sql`
    SELECT * FROM audit_log
    WHERE org_id = ${user.org_id} AND created_at >= ${since}
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

// ── DELETE /log — Immutable audit mode guard ──────────────────────────────
auditRoutes.delete("/log", async (c) => {
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  // Check immutable_audit setting
  try {
    const settingsRows = await sql`
      SELECT settings_json FROM org_settings WHERE org_id = ${user.org_id} LIMIT 1
    `;
    if (settingsRows.length > 0) {
      const settings = typeof settingsRows[0].settings_json === "string"
        ? JSON.parse(settingsRows[0].settings_json)
        : settingsRows[0].settings_json ?? {};
      if (settings.immutable_audit === true) {
        return c.json({ error: "Audit log is in immutable mode" }, 403);
      }
    }
  } catch {
    // If we can't verify, deny by default for safety
    return c.json({ error: "Unable to verify audit immutability setting" }, 500);
  }

  // If not immutable, allow deletion with filters
  const sinceDays = Math.max(1, Math.min(365, Number(c.req.query("since_days")) || 30));
  const since = new Date(Date.now() - sinceDays * 86400 * 1000).toISOString();

  const result = await sql`
    DELETE FROM audit_log
    WHERE org_id = ${user.org_id} AND created_at < ${since}
  `;

  return c.json({ deleted: result.count ?? 0 });
});

// ── DELETE /log/:entry_id — Delete a single audit entry (immutable guard) ──
auditRoutes.delete("/log/:entry_id", async (c) => {
  const user = c.get("user");
  const entryId = c.req.param("entry_id");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  // Check immutable_audit setting
  try {
    const settingsRows = await sql`
      SELECT settings_json FROM org_settings WHERE org_id = ${user.org_id} LIMIT 1
    `;
    if (settingsRows.length > 0) {
      const settings = typeof settingsRows[0].settings_json === "string"
        ? JSON.parse(settingsRows[0].settings_json)
        : settingsRows[0].settings_json ?? {};
      if (settings.immutable_audit === true) {
        return c.json({ error: "Audit log is in immutable mode" }, 403);
      }
    }
  } catch {
    return c.json({ error: "Unable to verify audit immutability setting" }, 500);
  }

  const result = await sql`
    DELETE FROM audit_log
    WHERE org_id = ${user.org_id} AND id = ${entryId}
  `;

  return c.json({ deleted: result.count ?? 0 });
});

auditRoutes.get("/events", async (c) => {
  const sql = await getDb(c.env.HYPERDRIVE);
  try {
    const rows = await sql`SELECT * FROM event_types ORDER BY category, event_type`;
    return c.json({ event_types: rows });
  } catch {
    return c.json({ event_types: [] });
  }
});
