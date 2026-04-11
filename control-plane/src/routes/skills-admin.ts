/**
 * Phase 6 commit 6: admin endpoints for the skill learning loop.
 *
 * Exposes /admin/skills/revert so a human admin can undo an individual
 * skill_overlays mutation. The revert path is intentionally NOT available
 * to agents — only owners/admins via an authenticated HTTP request.
 *
 * Integrity: the helper at control-plane/src/logic/skill-mutation.ts
 * verifies sha256(audit.before_content) === audit.before_sha BEFORE
 * touching the overlay table. A tampered audit row is refused.
 */

import { createOpenAPIRouter } from "../lib/openapi";
import { withOrgDb } from "../db/client";
import { revertSkillRule } from "../logic/skill-mutation";

export const skillsAdminRoutes = createOpenAPIRouter();

// POST /admin/skills/revert — body: { audit_id: string }
skillsAdminRoutes.post("/revert", async (c) => {
  const user = c.get("user");
  if (user.role !== "owner" && user.role !== "admin") {
    return c.json({ error: "Only org owners and admins can revert skill mutations" }, 403);
  }

  const body = (await c.req.json().catch(() => ({}))) as { audit_id?: string };
  const auditId = String(body.audit_id || "").trim();
  if (!auditId) {
    return c.json({ error: "audit_id is required" }, 400);
  }

  const env = c.env as any;
  const result = await withOrgDb({ HYPERDRIVE: env.HYPERDRIVE }, user.org_id, (sql) =>
    revertSkillRule(sql, { orgId: user.org_id, agentName: "", userRole: user.role }, auditId),
  );

  if (!result.reverted) {
    const status =
      result.code === "forbidden" ? 403 :
      result.code === "audit_not_found" ? 404 :
      result.code === "already_reverted" ? 409 :
      result.code === "tamper_detected" ? 422 :
      result.code === "invalid_input" ? 400 :
      500;
    return c.json(result, status);
  }

  return c.json(result);
});
