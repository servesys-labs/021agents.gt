/**
 * Orgs router — organization CRUD, member management, RBAC.
 * Ported from agentos/api/routers/orgs.py
 */
import { Hono } from "hono";
import type { Env } from "../env";
import type { CurrentUser } from "../auth/types";
import { getDbForOrg } from "../db/client";
import type { Sql } from "../db/client";
import { requireScope } from "../middleware/auth";

type R = { Bindings: Env; Variables: { user: CurrentUser } };
export const orgRoutes = new Hono<R>();

const ROLE_HIERARCHY: Record<string, number> = { owner: 4, admin: 3, member: 2, viewer: 1 };

async function requireOrgMember(sql: Sql, user: CurrentUser, orgId: string, minRole = "viewer") {
  const rows = await sql`
    SELECT role FROM org_members WHERE org_id = ${orgId} AND user_id = ${user.user_id}
  `;
  if (rows.length === 0) throw { status: 404, message: "Organization not found" };
  if ((ROLE_HIERARCHY[rows[0].role] ?? 0) < (ROLE_HIERARCHY[minRole] ?? 0)) {
    throw { status: 403, message: "Insufficient organization role" };
  }
}

function genId(): string {
  const arr = new Uint8Array(8);
  crypto.getRandomValues(arr);
  return [...arr].map((b) => b.toString(16).padStart(2, "0")).join("");
}

orgRoutes.get("/", requireScope("orgs:read"), async (c) => {
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const rows = await sql`
    SELECT o.*, COUNT(m2.user_id) as member_count
    FROM orgs o
    JOIN org_members m ON o.org_id = m.org_id
    LEFT JOIN org_members m2 ON o.org_id = m2.org_id
    WHERE m.user_id = ${user.user_id}
    GROUP BY o.org_id
  `;
  return c.json(
    rows.map((r: any) => ({
      org_id: r.org_id,
      name: r.name,
      slug: r.slug,
      plan: r.plan || "free",
      member_count: Number(r.member_count),
    })),
  );
});

orgRoutes.post("/", requireScope("orgs:write"), async (c) => {
  const user = c.get("user");
  const body = await c.req.json();
  const name = String(body.name || "").trim();
  if (!name) return c.json({ error: "name is required" }, 400);
  const slug = String(body.slug || "").trim() || name.toLowerCase().replace(/\s+/g, "-");

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const orgId = genId();

  await sql`
    INSERT INTO orgs (org_id, name, slug, owner_user_id) VALUES (${orgId}, ${name}, ${slug}, ${user.user_id})
  `;
  await sql`
    INSERT INTO org_members (org_id, user_id, role) VALUES (${orgId}, ${user.user_id}, 'owner')
  `;

  // Create default org_settings for the new org
  const now = Date.now() / 1000;
  try {
    await sql`
      INSERT INTO org_settings (org_id, plan_type, max_agents, max_runs_per_month, max_seats, features, created_at, updated_at)
      VALUES (${orgId}, ${"free"}, ${3}, ${1000}, ${1}, ${JSON.stringify(["basic_agents", "basic_observability"])}, ${now}, ${now})
    `;
  } catch {}

  return c.json({ org_id: orgId, name, slug, plan: "free", member_count: 1 });
});

orgRoutes.get("/:org_id/members", requireScope("orgs:read"), async (c) => {
  const user = c.get("user");
  const orgId = c.req.param("org_id");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  try {
    await requireOrgMember(sql, user, orgId, "viewer");
  } catch (e: any) {
    return c.json({ error: e.message }, e.status || 400);
  }

  const rows = await sql`
    SELECT u.user_id, u.email, u.name, m.role, m.created_at
    FROM org_members m JOIN users u ON m.user_id = u.user_id
    WHERE m.org_id = ${orgId}
  `;
  return c.json({ members: rows });
});

orgRoutes.post("/:org_id/members", requireScope("orgs:write"), async (c) => {
  const user = c.get("user");
  const orgId = c.req.param("org_id");
  const body = await c.req.json();
  const email = String(body.email || "").trim();
  const role = String(body.role || "member");

  if (!email) return c.json({ error: "email is required" }, 400);
  if (!["owner", "admin", "member", "viewer"].includes(role)) {
    return c.json({ error: "Invalid role" }, 400);
  }

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  try {
    await requireOrgMember(sql, user, orgId, "admin");
  } catch (e: any) {
    return c.json({ error: e.message }, e.status || 400);
  }

  // Find or create user
  const userRows = await sql`SELECT user_id FROM users WHERE email = ${email}`;
  let targetUserId: string;
  if (userRows.length > 0) {
    targetUserId = userRows[0].user_id;
  } else {
    targetUserId = genId();
    await sql`INSERT INTO users (user_id, email, name) VALUES (${targetUserId}, ${email}, '')`;
  }

  await sql`
    INSERT INTO org_members (org_id, user_id, role, invited_by)
    VALUES (${orgId}, ${targetUserId}, ${role}, ${user.user_id})
    ON CONFLICT (org_id, user_id) DO NOTHING
  `;

  return c.json({ invited: email, role });
});

orgRoutes.put("/:org_id", requireScope("orgs:write"), async (c) => {
  const user = c.get("user");
  const orgId = c.req.param("org_id");
  const body = await c.req.json();
  const name = String(body.name || "").trim();
  const plan = String(body.plan || "").trim();

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  try {
    await requireOrgMember(sql, user, orgId, "admin");
  } catch (e: any) {
    return c.json({ error: e.message }, e.status || 400);
  }

  if (!name && !plan) return c.json({ error: "Nothing to update" }, 400);

  const now = Date.now() / 1000;
  if (name && plan) {
    await sql`UPDATE orgs SET name = ${name}, plan = ${plan}, updated_at = ${now} WHERE org_id = ${orgId}`;
  } else if (name) {
    await sql`UPDATE orgs SET name = ${name}, updated_at = ${now} WHERE org_id = ${orgId}`;
  } else {
    await sql`UPDATE orgs SET plan = ${plan}, updated_at = ${now} WHERE org_id = ${orgId}`;
  }

  // Sync plan change to org_settings
  if (plan) {
    try {
      await sql`
        INSERT INTO org_settings (org_id, plan_type, created_at, updated_at)
        VALUES (${orgId}, ${plan}, ${now}, ${now})
        ON CONFLICT (org_id) DO UPDATE SET
          plan_type = EXCLUDED.plan_type,
          updated_at = EXCLUDED.updated_at
      `;
    } catch {}
  }

  return c.json({ updated: orgId });
});

orgRoutes.delete("/:org_id", requireScope("orgs:write"), async (c) => {
  const user = c.get("user");
  const orgId = c.req.param("org_id");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  try {
    await requireOrgMember(sql, user, orgId, "owner");
  } catch (e: any) {
    return c.json({ error: e.message }, e.status || 400);
  }

  await sql`DELETE FROM org_members WHERE org_id = ${orgId}`;
  await sql`DELETE FROM orgs WHERE org_id = ${orgId}`;
  return c.json({ deleted: orgId });
});

orgRoutes.put("/:org_id/members/:member_user_id", requireScope("orgs:write"), async (c) => {
  const user = c.get("user");
  const orgId = c.req.param("org_id");
  const memberUserId = c.req.param("member_user_id");
  const body = await c.req.json();
  const role = String(body.role || "");

  if (!["owner", "admin", "member", "viewer"].includes(role)) {
    return c.json({ error: "Invalid role" }, 400);
  }

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  try {
    await requireOrgMember(sql, user, orgId, "admin");
  } catch (e: any) {
    return c.json({ error: e.message }, e.status || 400);
  }

  await sql`
    UPDATE org_members SET role = ${role} WHERE org_id = ${orgId} AND user_id = ${memberUserId}
  `;
  return c.json({ updated: memberUserId, role });
});

orgRoutes.delete("/:org_id/members/:member_user_id", requireScope("orgs:write"), async (c) => {
  const user = c.get("user");
  const orgId = c.req.param("org_id");
  const memberUserId = c.req.param("member_user_id");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  try {
    await requireOrgMember(sql, user, orgId, "admin");
  } catch (e: any) {
    return c.json({ error: e.message }, e.status || 400);
  }

  await sql`DELETE FROM org_members WHERE org_id = ${orgId} AND user_id = ${memberUserId}`;
  return c.json({ removed: memberUserId });
});

// ── GET /org/settings — read org settings + onboarding state ─────────────────

orgRoutes.get("/settings", async (c) => {
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const rows = await sql`
    SELECT settings_json, plan_type FROM org_settings WHERE org_id = ${user.org_id} LIMIT 1
  `;

  if (rows.length === 0) {
    // No org_settings row — user hasn't completed onboarding
    return c.json({ onboarding_complete: false });
  }

  const settings = JSON.parse(String(rows[0].settings_json || "{}"));
  return c.json({
    onboarding_complete: settings.onboarding_complete ?? false,
    default_connectors: settings.default_connectors ?? [],
    org_name: settings.org_name ?? "",
    plan_type: rows[0].plan_type ?? "free",
  });
});

// ── POST /org/settings — save org settings (onboarding, connectors, name) ────

orgRoutes.post("/settings", async (c) => {
  const user = c.get("user");
  const body = await c.req.json();
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  // Merge with existing settings
  const existing = await sql`
    SELECT settings_json FROM org_settings WHERE org_id = ${user.org_id} LIMIT 1
  `;
  const current = existing.length > 0
    ? JSON.parse(String(existing[0].settings_json || "{}"))
    : {};

  const merged = {
    ...current,
    ...body,
  };

  const settingsJson = JSON.stringify(merged);
  const now = Date.now() / 1000;

  await sql`
    INSERT INTO org_settings (org_id, settings_json, plan_type, created_at, updated_at)
    VALUES (${user.org_id}, ${settingsJson}, ${"free"}, ${now}, ${now})
    ON CONFLICT (org_id) DO UPDATE SET
      settings_json = ${settingsJson},
      updated_at = ${now}
  `;

  // Also update org name if provided
  if (body.org_name) {
    await sql`
      UPDATE orgs SET name = ${body.org_name}, updated_at = now() WHERE org_id = ${user.org_id}
    `.catch(() => {});
  }

  return c.json({ saved: true, settings: merged });
});
