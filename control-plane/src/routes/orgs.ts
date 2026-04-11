/**
 * Orgs router — organization CRUD, member management, RBAC.
 */
import { createRoute, z } from "@hono/zod-openapi";
import { createOpenAPIRouter } from "../lib/openapi";
import { ErrorSchema, errorResponses, OrgSummary, OrgMember } from "../schemas/openapi";
import type { CurrentUser } from "../auth/types";
import { withOrgDb } from "../db/client";
import type { Sql } from "../db/client";
import { requireScope } from "../middleware/auth";
import { logSecurityEvent } from "../logic/security-events";
import { parseJsonColumn } from "../lib/parse-json-column";

export const orgRoutes = createOpenAPIRouter();

const ROLE_HIERARCHY: Record<string, number> = { owner: 4, admin: 3, member: 2, viewer: 1 };
const ALLOWED_PLAN_TYPES = ["free", "starter", "pro", "enterprise"] as const;
const ALLOWED_TEAM_SIZES = ["1-10", "11-50", "51-200", "201-1000", "1000+"] as const;
const ALLOWED_DEPLOY_STYLES = ["fast", "balanced", "careful"] as const;
const ALLOWED_SENSITIVITY = ["low", "medium", "high", "regulated", "restricted"] as const;

const OrgSettingsPatch = z.object({
  onboarding_complete: z.boolean().optional(),
  org_name: z.string().trim().min(1).max(120).optional(),
  industry: z.string().trim().min(1).max(80).optional(),
  team_size: z.enum(ALLOWED_TEAM_SIZES).optional(),
  use_cases: z.array(z.string().trim().min(1).max(80)).max(16).optional(),
  data_sensitivity: z.enum(ALLOWED_SENSITIVITY).optional(),
  deploy_style: z.enum(ALLOWED_DEPLOY_STYLES).optional(),
  plan: z.enum(ALLOWED_PLAN_TYPES).optional(),
  default_connectors: z.array(z.string().trim().min(1).max(120)).max(100).optional(),
}).strict();

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

// ── GET / — list orgs for the current user ──────────────────────────────

const listOrgsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Orgs"],
  summary: "List organizations for the current user",
  middleware: [requireScope("orgs:read")],
  responses: {
    200: {
      description: "List of organizations",
      content: { "application/json": { schema: z.array(OrgSummary) } },
    },
    ...errorResponses(401, 500),
  },
});
orgRoutes.openapi(listOrgsRoute, async (c): Promise<any> => {
  const user = c.get("user");
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    // orgs is RLS-enforced (only the current org row is visible) — but the
    // join through org_members + the user filter still produces the correct
    // single-org result for the caller.
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
});

// ── POST / — create a new organization ──────────────────────────────────

const createOrgRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Orgs"],
  summary: "Create a new organization",
  middleware: [requireScope("orgs:write")],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            name: z.string().min(1),
            slug: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Created organization",
      content: { "application/json": { schema: OrgSummary } },
    },
    ...errorResponses(400, 401, 500),
  },
});
orgRoutes.openapi(createOrgRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const body = c.req.valid("json");
  const name = String(body.name || "").trim();
  if (!name) return c.json({ error: "name is required" }, 400);
  const slug = String(body.slug || "").trim() || name.toLowerCase().replace(/\s+/g, "-");

  const orgId = genId();

  return await withOrgDb(c.env, user.org_id, async (sql) => {
    await sql`
      INSERT INTO orgs (org_id, name, slug, owner_user_id) VALUES (${orgId}, ${name}, ${slug}, ${user.user_id})
    `;
    await sql`
      INSERT INTO org_members (org_id, user_id, role) VALUES (${orgId}, ${user.user_id}, 'owner')
    `;

    // Create default org_settings for the new org
    const now = new Date().toISOString();
    try {
      await sql`
        INSERT INTO org_settings (org_id, plan_type, settings, limits, features, created_at, updated_at)
        VALUES (
          ${orgId},
          ${"free"},
          ${JSON.stringify({ onboarding_complete: false, default_connectors: [] })},
          ${JSON.stringify({ max_agents: 50, max_runs_per_month: 1000, max_seats: 1 })},
          ${JSON.stringify(["basic_agents", "basic_observability"])},
          ${now},
          ${now}
        )
      `;
    } catch {}

    return c.json({ org_id: orgId, name, slug, plan: "free", member_count: 1 });
  });
});

// ── GET /:org_id/members — list members ─────────────────────────────────

const listMembersRoute = createRoute({
  method: "get",
  path: "/{org_id}/members",
  tags: ["Orgs"],
  summary: "List members of an organization",
  middleware: [requireScope("orgs:read")],
  request: {
    params: z.object({ org_id: z.string() }),
  },
  responses: {
    200: {
      description: "Member list",
      content: { "application/json": { schema: z.object({ members: z.array(OrgMember) }) } },
    },
    ...errorResponses(400, 401, 403, 404, 500),
  },
});
orgRoutes.openapi(listMembersRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { org_id: orgId } = c.req.valid("param");
  return await withOrgDb(c.env, user.org_id, async (sql) => {
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
});

// ── POST /:org_id/members — invite a member ────────────────────────────

const addMemberRoute = createRoute({
  method: "post",
  path: "/{org_id}/members",
  tags: ["Orgs"],
  summary: "Invite a member to an organization",
  middleware: [requireScope("orgs:write")],
  request: {
    params: z.object({ org_id: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            email: z.string().email(),
            role: z.enum(["owner", "admin", "member", "viewer"]).default("member"),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Member invited",
      content: {
        "application/json": {
          schema: z.object({ invited: z.string(), role: z.string() }),
        },
      },
    },
    ...errorResponses(400, 401, 403, 404, 500),
  },
});
orgRoutes.openapi(addMemberRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { org_id: orgId } = c.req.valid("param");
  const body = c.req.valid("json");
  const email = String(body.email || "").trim();
  const role = String(body.role || "member");

  if (!email) return c.json({ error: "email is required" }, 400);
  if (!["owner", "admin", "member", "viewer"].includes(role)) {
    return c.json({ error: "Invalid role" }, 400);
  }

  return await withOrgDb(c.env, user.org_id, async (sql) => {
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

    // Security event: user invited
    logSecurityEvent(sql, {
      org_id: orgId,
      event_type: "user.invited",
      actor_id: user.user_id,
      actor_type: "user",
      target_id: targetUserId,
      target_type: "user",
      severity: "info",
      details: { email, role },
    });

    return c.json({ invited: email, role });
  });
});

// ── PUT /:org_id — update an organization ───────────────────────────────

const updateOrgRoute = createRoute({
  method: "put",
  path: "/{org_id}",
  tags: ["Orgs"],
  summary: "Update an organization",
  middleware: [requireScope("orgs:write")],
  request: {
    params: z.object({ org_id: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            name: z.string().optional(),
            plan: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Organization updated",
      content: { "application/json": { schema: z.object({ updated: z.string() }) } },
    },
    ...errorResponses(400, 401, 403, 404, 500),
  },
});
orgRoutes.openapi(updateOrgRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { org_id: orgId } = c.req.valid("param");
  const body = c.req.valid("json");
  const name = String(body.name || "").trim();
  const plan = String(body.plan || "").trim();

  return await withOrgDb(c.env, user.org_id, async (sql) => {
    try {
      await requireOrgMember(sql, user, orgId, "admin");
    } catch (e: any) {
      return c.json({ error: e.message }, e.status || 400);
    }

    if (!name && !plan) return c.json({ error: "Nothing to update" }, 400);

    const now = new Date().toISOString();
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
});

// ── DELETE /:org_id — delete an organization ────────────────────────────

const deleteOrgRoute = createRoute({
  method: "delete",
  path: "/{org_id}",
  tags: ["Orgs"],
  summary: "Delete an organization",
  middleware: [requireScope("orgs:write")],
  request: {
    params: z.object({ org_id: z.string() }),
  },
  responses: {
    200: {
      description: "Organization deleted",
      content: { "application/json": { schema: z.object({ deleted: z.string() }) } },
    },
    ...errorResponses(401, 403, 404, 500),
  },
});
orgRoutes.openapi(deleteOrgRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { org_id: orgId } = c.req.valid("param");
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    try {
      await requireOrgMember(sql, user, orgId, "owner");
    } catch (e: any) {
      return c.json({ error: e.message }, e.status || 400);
    }

    await sql`DELETE FROM org_members WHERE org_id = ${orgId}`;
    await sql`DELETE FROM orgs WHERE org_id = ${orgId}`;
    return c.json({ deleted: orgId });
  });
});

// ── PUT /:org_id/members/:member_user_id — update member role ───────────

const updateMemberRoleRoute = createRoute({
  method: "put",
  path: "/{org_id}/members/{member_user_id}",
  tags: ["Orgs"],
  summary: "Update a member's role",
  middleware: [requireScope("orgs:write")],
  request: {
    params: z.object({ org_id: z.string(), member_user_id: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            role: z.enum(["owner", "admin", "member", "viewer"]),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Role updated",
      content: {
        "application/json": {
          schema: z.object({ updated: z.string(), role: z.string() }),
        },
      },
    },
    ...errorResponses(400, 401, 403, 404, 500),
  },
});
orgRoutes.openapi(updateMemberRoleRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { org_id: orgId, member_user_id: memberUserId } = c.req.valid("param");
  const body = c.req.valid("json");
  const role = String(body.role || "");

  if (!["owner", "admin", "member", "viewer"].includes(role)) {
    return c.json({ error: "Invalid role" }, 400);
  }

  return await withOrgDb(c.env, user.org_id, async (sql) => {
    try {
      await requireOrgMember(sql, user, orgId, "admin");
    } catch (e: any) {
      return c.json({ error: e.message }, e.status || 400);
    }

    await sql`
      UPDATE org_members SET role = ${role} WHERE org_id = ${orgId} AND user_id = ${memberUserId}
    `;

    // Security event: role changed
    logSecurityEvent(sql, {
      org_id: orgId,
      event_type: "user.role_changed",
      actor_id: user.user_id,
      actor_type: "user",
      target_id: memberUserId,
      target_type: "user",
      severity: "medium",
      details: { new_role: role },
    });

    return c.json({ updated: memberUserId, role });
  });
});

// ── DELETE /:org_id/members/:member_user_id — remove a member ───────────

const removeMemberRoute = createRoute({
  method: "delete",
  path: "/{org_id}/members/{member_user_id}",
  tags: ["Orgs"],
  summary: "Remove a member from an organization",
  middleware: [requireScope("orgs:write")],
  request: {
    params: z.object({ org_id: z.string(), member_user_id: z.string() }),
  },
  responses: {
    200: {
      description: "Member removed",
      content: { "application/json": { schema: z.object({ removed: z.string() }) } },
    },
    ...errorResponses(401, 403, 404, 500),
  },
});
orgRoutes.openapi(removeMemberRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { org_id: orgId, member_user_id: memberUserId } = c.req.valid("param");
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    try {
      await requireOrgMember(sql, user, orgId, "admin");
    } catch (e: any) {
      return c.json({ error: e.message }, e.status || 400);
    }

    await sql`DELETE FROM org_members WHERE org_id = ${orgId} AND user_id = ${memberUserId}`;

    // Security event: user removed
    logSecurityEvent(sql, {
      org_id: orgId,
      event_type: "user.removed",
      actor_id: user.user_id,
      actor_type: "user",
      target_id: memberUserId,
      target_type: "user",
      severity: "medium",
      details: { removed_user_id: memberUserId },
    });

    return c.json({ removed: memberUserId });
  });
});

// ── GET /settings — read org settings + onboarding state ────────────────

const getSettingsRoute = createRoute({
  method: "get",
  path: "/settings",
  tags: ["Orgs"],
  summary: "Get organization settings and onboarding state",
  responses: {
    200: {
      description: "Org settings",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(401, 500),
  },
});
orgRoutes.openapi(getSettingsRoute, async (c): Promise<any> => {
  const user = c.get("user");
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const rows = await sql`
      SELECT settings, plan_type FROM org_settings LIMIT 1
    `;

    if (rows.length === 0) {
      // No org_settings row — user hasn't completed onboarding
      return c.json({ onboarding_complete: false });
    }

    const settings = parseJsonColumn(rows[0].settings);
    return c.json({
      onboarding_complete: settings.onboarding_complete ?? false,
      default_connectors: settings.default_connectors ?? [],
      org_name: settings.org_name ?? "",
      plan_type: rows[0].plan_type ?? "free",
    });
  });
});

// ── POST /settings — save org settings (onboarding, connectors, name) ───

const updateSettingsRoute = createRoute({
  method: "post",
  path: "/settings",
  tags: ["Orgs"],
  summary: "Save organization settings",
  request: {
    body: {
      content: {
        "application/json": {
          schema: OrgSettingsPatch,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Settings saved",
      content: { "application/json": { schema: z.object({ saved: z.boolean(), settings: z.record(z.unknown()) }) } },
    },
    ...errorResponses(400, 401, 500),
  },
});
orgRoutes.openapi(updateSettingsRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const parsed = c.req.valid("json");

  return await withOrgDb(c.env, user.org_id, async (sql) => {
    // Merge with existing settings
    const existing = await sql`
      SELECT settings FROM org_settings LIMIT 1
    `;
    const current = existing.length > 0
      ? parseJsonColumn(existing[0].settings)
      : {};

    const merged = {
      ...current,
      ...parsed,
    };

    const settingsJson = JSON.stringify(merged);
    const now = new Date().toISOString();

    await sql`
      INSERT INTO org_settings (org_id, settings, plan_type, created_at, updated_at)
      VALUES (${user.org_id}, ${settingsJson}, ${"free"}, ${now}, ${now})
      ON CONFLICT (org_id) DO UPDATE SET
        settings = ${settingsJson},
        updated_at = ${now}
    `;

    // Also update org name if provided
    if (parsed.org_name) {
      await sql`
        UPDATE orgs SET name = ${parsed.org_name}, updated_at = now() WHERE org_id = ${user.org_id}
      `.catch(() => {});
    }

    return c.json({ saved: true, settings: merged });
  });
});
