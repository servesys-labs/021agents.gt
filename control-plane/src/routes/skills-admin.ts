/**
 * Phase 6 / 6.5: admin endpoints for the skill learning loop.
 *
 * /revert       — human-admin-only undo for individual skill_overlays rows.
 * /append-rule  — owner/admin OR service-token auto-fire path (Phase 6.5).
 *                 Service-token calls synthesize role=owner via the auth
 *                 middleware (middleware/auth.ts:48-63) with org_id taken
 *                 from the X-Org-Id header. All calls pass agentName=""
 *                 for org-wide overlay scope — see skill-feedback.ts.
 *
 * Integrity: the helper at control-plane/src/logic/skill-mutation.ts
 * verifies sha256(audit.before_content) === audit.before_sha BEFORE
 * touching the overlay table. A tampered audit row is refused.
 */

import { createOpenAPIRouter } from "../lib/openapi";
import { withOrgDb } from "../db/client";
import { appendRule, revertSkillRule } from "../logic/skill-mutation";

export const skillsAdminRoutes = createOpenAPIRouter();

// POST /admin/skills/append-rule — body: { skill_name, rule_text, source?, reason? }
//
// Used both by human admins (/improve manual runs) and by the Phase 6.5
// auto-fire detector (deploy/src/runtime/skill-feedback.ts) via the
// CONTROL_PLANE service binding. Both paths route through the same
// appendRule helper and inherit rate limit (source-partitioned — see
// Phase 6.5 dual-bucket commit), injection scan, and audit trail.
skillsAdminRoutes.post("/append-rule", async (c) => {
  const user = c.get("user");
  if (user.role !== "owner" && user.role !== "admin") {
    return c.json({ error: "Only org owners and admins can append rules to skills" }, 403);
  }
  if (!user.org_id) {
    return c.json({ error: "org_id required (JWT or X-Org-Id header for service-token calls)" }, 400);
  }

  const body = (await c.req.json().catch(() => ({}))) as {
    skill_name?: string;
    rule_text?: string;
    source?: string;
    reason?: string;
  };
  const skillName = String(body.skill_name || "").trim();
  const ruleText = String(body.rule_text || "").trim();
  if (!skillName || !ruleText) {
    return c.json({ error: "skill_name and rule_text are required" }, 400);
  }

  const env = c.env as any;
  const result = await withOrgDb({ HYPERDRIVE: env.HYPERDRIVE }, user.org_id, (sql) =>
    appendRule(
      sql,
      {
        orgId: user.org_id,
        // Org-wide scope: see skill-feedback.ts and loadSkillOverlays at
        // deploy/src/runtime/skills.ts:75 — agent_name="" loads under
        // ANY agent's invocation, including the meta-agent's /improve.
        agentName: "",
        userRole: user.role,
      },
      { skillName, ruleText, source: body.source, reason: body.reason },
    ),
  );

  if (!result.appended) {
    const status =
      result.code === "forbidden" ? 403 :
      result.code === "unknown_skill" ? 404 :
      result.code === "injection_blocked" ? 422 :
      result.code === "rate_limited" ? 429 :
      result.code === "invalid_input" ? 400 :
      500;
    return c.json(result, status);
  }

  return c.json(result);
});

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
