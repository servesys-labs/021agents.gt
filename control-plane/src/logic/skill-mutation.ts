/**
 * Skill mutation helper — the learning loop's write path.
 *
 * Phase 6. Invoked by `manage_skills action=append_rule` in
 * meta-agent-chat.ts and (commit 6) by a deploy-side HTTP client that
 * calls the same logic via a dedicated RPC route.
 *
 * Content representation — "overlay-state, not full body":
 *
 *   `before_content` / `after_content` on skill_audit hold the OVERLAY
 *   state, not the full effective skill prompt. Overlays are additive
 *   rule_text fragments that layer on top of the disk SKILL.md at load
 *   time (see commit 5: loadSkills merge). Each audit row captures the
 *   concatenation of all overlays for (org, agent, skill) before and
 *   after this append — not a reconstruction that includes the disk
 *   body. Reasons:
 *
 *     1. The disk body can change independently via git push. Storing a
 *        "full effective body" snapshot would drift from reality.
 *     2. A linear `SELECT * FROM skill_audit WHERE skill_name = X
 *        ORDER BY created_at` still gives a complete overlay history.
 *        Reconstructing the effective prompt at a past date requires
 *        pairing an audit row with `git show <date>:skills/public/X/
 *        SKILL.md` — the honest representation of what actually ran.
 *     3. Avoids bundling ~60 KB of skill bodies into the control-plane
 *        bundle. The lean catalog stays ~2 KB per its original intent.
 *
 * Integrity: `before_sha` / `after_sha` are sha256 of the overlay-state
 * content. The admin revert endpoint (commit 7) asserts
 * `sha256(stored_before_content) === stored_before_sha` before restoring,
 * and refuses if the row was tampered with.
 *
 * Atomicity: every call happens inside `withOrgDb`, which wraps the
 * callback in `sql.begin()` (db/client.ts:79). Overlay + audit inserts
 * therefore commit-or-rollback together for free — no CTE needed.
 */

import { detectInjection } from "./prompt-injection";
import { SKILL_CATALOG_NAMES } from "../lib/skill-catalog.generated";

export const SKILL_MUTATION_RATE_LIMIT_PER_DAY = 10;

/** Separator between overlay rules when concatenating the overlay state. */
export const OVERLAY_JOINER = "\n\n---\n";

/** Max rule_text length — anything longer is two rules, split it. */
const MAX_RULE_TEXT_LEN = 4096;

export interface AppendRuleInput {
  skillName: string;
  ruleText: string;
  source?: string;
  reason?: string;
}

export interface AppendRuleContext {
  orgId: string;
  agentName: string;
  userRole?: string;
}

export interface AppendRuleSuccess {
  appended: true;
  audit_id: string;
  overlay_id: string;
  skill_name: string;
  overlay_count: number;
  before_sha: string;
  after_sha: string;
}

export type AppendRuleErrorCode =
  | "forbidden"
  | "unknown_skill"
  | "injection_blocked"
  | "rate_limited"
  | "invalid_input"
  | "db_error";

export interface AppendRuleError {
  appended: false;
  error: string;
  code: AppendRuleErrorCode;
  detail?: unknown;
}

export type AppendRuleResult = AppendRuleSuccess | AppendRuleError;

/** Web Crypto SHA-256 → lowercase hex. Works in Workers runtime (no Node crypto). */
export async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Append a learned rule to a skill. Thin core used by both the
 * meta-agent `manage_skills` handler and (commit 6) a deploy-side RPC.
 *
 * `sql` must be an OrgSql bound inside withOrgDb — the caller is
 * responsible for the transaction + RLS org scoping.
 */
export async function appendRule(
  sql: any,
  ctx: AppendRuleContext,
  input: AppendRuleInput,
): Promise<AppendRuleResult> {
  if (ctx.userRole !== "owner" && ctx.userRole !== "admin") {
    return {
      appended: false,
      error: "Only org owners and admins can append rules to skills.",
      code: "forbidden",
    };
  }

  const skillName = String(input.skillName || "").trim();
  const ruleText = String(input.ruleText || "").trim();
  const source = String(input.source || "improve").slice(0, 32);
  const reason = String(input.reason || "").slice(0, 512);

  if (!skillName) {
    return { appended: false, error: "skill_name is required", code: "invalid_input" };
  }
  if (!ruleText) {
    return { appended: false, error: "rule_text is required", code: "invalid_input" };
  }
  if (ruleText.length > MAX_RULE_TEXT_LEN) {
    return {
      appended: false,
      error: `rule_text exceeds ${MAX_RULE_TEXT_LEN} chars — split into multiple rules`,
      code: "invalid_input",
    };
  }

  // Skill must exist — either bundled or custom (per-org).
  if (!SKILL_CATALOG_NAMES.has(skillName)) {
    const customRows = await sql`
      SELECT 1 FROM skills
      WHERE name = ${skillName} AND org_id = ${ctx.orgId}
      LIMIT 1
    `;
    if (customRows.length === 0) {
      return {
        appended: false,
        error: `Unknown skill: ${skillName}`,
        code: "unknown_skill",
      };
    }
  }

  // Prompt-injection guard on rule_text. Server-side backstop even though
  // the /improve skill body also instructs callers to avoid injection
  // markers — defense in depth.
  const scan = detectInjection(ruleText);
  if (scan.recommendation === "block") {
    return {
      appended: false,
      error: `Rule rejected: prompt-injection patterns detected (${scan.patterns.join(", ")})`,
      code: "injection_blocked",
      detail: { patterns: scan.patterns, score: scan.score },
    };
  }

  // Serialize concurrent (org, skill) mutations so the rate-limit
  // COUNT→INSERT pair below is atomic. Held until transaction commit by
  // withOrgDb's sql.begin() wrapper. Without this, parallel auto-fire
  // invocations can both read COUNT=9 and both insert, overshooting 10/day.
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`skill-rl:${ctx.orgId}:${skillName}`}, 0))`;

  // Rate limit: 10 successful mutations per day per skill. RLS scopes the
  // count to the current org, so the effective limit is per-org-per-skill.
  const countRows = await sql`
    SELECT COUNT(*)::int AS n FROM skill_audit
    WHERE skill_name = ${skillName}
      AND created_at > NOW() - INTERVAL '1 day'
  `;
  const recentCount = Number(countRows?.[0]?.n ?? 0);
  if (recentCount >= SKILL_MUTATION_RATE_LIMIT_PER_DAY) {
    return {
      appended: false,
      error: `Rate limited: ${SKILL_MUTATION_RATE_LIMIT_PER_DAY} mutations/day/skill reached for '${skillName}'`,
      code: "rate_limited",
      detail: { recent_count: recentCount, limit: SKILL_MUTATION_RATE_LIMIT_PER_DAY },
    };
  }

  // Compute before_content = current overlay-state for (org, agent, skill).
  // Include both agent-scoped rows and the org-wide default (''), sorted
  // by created_at for stability.
  const overlayRows = await sql`
    SELECT rule_text FROM skill_overlays
    WHERE org_id = ${ctx.orgId}
      AND skill_name = ${skillName}
      AND (agent_name = ${ctx.agentName} OR agent_name = '')
    ORDER BY created_at ASC
  `;
  const beforeContent = overlayRows.map((r: any) => r.rule_text).join(OVERLAY_JOINER);
  const beforeSha = await sha256Hex(beforeContent);

  // Insert overlay row first so we have its overlay_id for the audit FK.
  const overlayInsert = await sql`
    INSERT INTO skill_overlays (org_id, agent_name, skill_name, rule_text, source)
    VALUES (${ctx.orgId}, ${ctx.agentName}, ${skillName}, ${ruleText}, ${source})
    RETURNING overlay_id
  `;
  const overlayId = overlayInsert?.[0]?.overlay_id;
  if (!overlayId) {
    return { appended: false, error: "Failed to insert overlay row", code: "db_error" };
  }

  const afterContent = beforeContent
    ? beforeContent + OVERLAY_JOINER + ruleText
    : ruleText;
  const afterSha = await sha256Hex(afterContent);

  const auditInsert = await sql`
    INSERT INTO skill_audit (
      org_id, skill_name, agent_name, overlay_id,
      before_sha, after_sha, before_content, after_content,
      reason, source
    )
    VALUES (
      ${ctx.orgId}, ${skillName}, ${ctx.agentName}, ${overlayId},
      ${beforeSha}, ${afterSha}, ${beforeContent}, ${afterContent},
      ${reason}, ${source}
    )
    RETURNING audit_id
  `;
  const auditId = auditInsert?.[0]?.audit_id;
  if (!auditId) {
    // The outer withOrgDb transaction will roll both inserts back when we
    // throw, but a returned error is more informative to the caller.
    throw new Error("Failed to insert skill_audit row after overlay insert — transaction will roll back");
  }

  return {
    appended: true,
    audit_id: auditId,
    overlay_id: overlayId,
    skill_name: skillName,
    overlay_count: overlayRows.length + 1,
    before_sha: beforeSha,
    after_sha: afterSha,
  };
}

// ── Revert path (Phase 6 commit 6) ─────────────────────────────────

export interface RevertRuleSuccess {
  reverted: true;
  revert_audit_id: string;
  reverted_audit_id: string;
  skill_name: string;
  overlay_count: number;
  before_sha: string;
  after_sha: string;
}

export type RevertRuleErrorCode =
  | "forbidden"
  | "invalid_input"
  | "audit_not_found"
  | "already_reverted"
  | "tamper_detected"
  | "db_error";

export interface RevertRuleError {
  reverted: false;
  error: string;
  code: RevertRuleErrorCode;
  detail?: unknown;
}

export type RevertRuleResult = RevertRuleSuccess | RevertRuleError;

/**
 * Admin-only revert: given an audit_id from a prior append_rule, delete the
 * overlay row it describes and write a new audit row capturing the revert.
 *
 * Integrity check: sha256(audit.before_content) MUST equal audit.before_sha.
 * If not, the audit row has been tampered with — refuse the revert.
 *
 * `sql` must be an OrgSql bound inside withOrgDb (transaction + RLS scoping).
 * The whole flow — SELECT audit / read current overlays / DELETE overlay /
 * re-read state / INSERT revert audit — runs inside the same transaction for
 * free (db/client.ts:79 wraps the callback in sql.begin()).
 */
export async function revertSkillRule(
  sql: any,
  ctx: AppendRuleContext,
  auditId: string,
): Promise<RevertRuleResult> {
  if (ctx.userRole !== "owner" && ctx.userRole !== "admin") {
    return {
      reverted: false,
      error: "Only org owners and admins can revert skill mutations.",
      code: "forbidden",
    };
  }

  const id = String(auditId || "").trim();
  if (!id) {
    return { reverted: false, error: "audit_id is required", code: "invalid_input" };
  }

  const auditRows = await sql`
    SELECT audit_id, skill_name, agent_name, overlay_id, before_sha, before_content, after_content, source
    FROM skill_audit
    WHERE audit_id = ${id}
    LIMIT 1
  `;
  if (auditRows.length === 0) {
    return { reverted: false, error: `No audit row found for audit_id=${id}`, code: "audit_not_found" };
  }

  const audit = auditRows[0];
  if (!audit.overlay_id) {
    // Revert audit rows (and previously-reverted append rows) leave overlay_id NULL.
    return {
      reverted: false,
      error: `Audit ${id} has no overlay_id — already reverted or was itself a revert.`,
      code: "already_reverted",
    };
  }

  // Tamper check: the stored before_content must hash to the stored before_sha.
  const recomputed = await sha256Hex(String(audit.before_content ?? ""));
  if (recomputed !== audit.before_sha) {
    return {
      reverted: false,
      error: "Integrity check failed: stored before_content does not match before_sha. Refusing revert.",
      code: "tamper_detected",
      detail: { audit_id: id, stored_sha: audit.before_sha, recomputed_sha: recomputed },
    };
  }

  // Read current overlay state for this skill — the "before" side of the revert.
  // Scope comes from the AUDIT ROW being reverted, not ctx.agentName: an
  // agent-scoped overlay must be reverted against the same agent's state, and
  // the route handler doesn't know which agent the original mutation targeted.
  const auditAgentName = String(audit.agent_name ?? "");
  const beforeRows = await sql`
    SELECT rule_text FROM skill_overlays
    WHERE org_id = ${ctx.orgId}
      AND skill_name = ${audit.skill_name}
      AND (agent_name = ${auditAgentName} OR agent_name = '')
    ORDER BY created_at ASC
  `;
  const beforeContent = beforeRows.map((r: any) => r.rule_text).join(OVERLAY_JOINER);
  const beforeSha = await sha256Hex(beforeContent);

  // Delete the target overlay. Returns 0 rows if a concurrent revert already
  // removed it — treat that as already_reverted rather than writing a no-op
  // audit row.
  const deleted = await sql`
    DELETE FROM skill_overlays
    WHERE overlay_id = ${audit.overlay_id}
    RETURNING overlay_id
  `;
  if (deleted.length === 0) {
    return {
      reverted: false,
      error: `Overlay ${audit.overlay_id} was already deleted (concurrent revert).`,
      code: "already_reverted",
    };
  }

  // Re-read overlay state post-delete for the "after" side.
  const afterRows = await sql`
    SELECT rule_text FROM skill_overlays
    WHERE org_id = ${ctx.orgId}
      AND skill_name = ${audit.skill_name}
      AND (agent_name = ${auditAgentName} OR agent_name = '')
    ORDER BY created_at ASC
  `;
  const afterContent = afterRows.map((r: any) => r.rule_text).join(OVERLAY_JOINER);
  const afterSha = await sha256Hex(afterContent);

  const revertInsert = await sql`
    INSERT INTO skill_audit (
      org_id, skill_name, agent_name, overlay_id,
      before_sha, after_sha, before_content, after_content,
      reason, source
    )
    VALUES (
      ${ctx.orgId}, ${audit.skill_name}, ${auditAgentName}, ${null},
      ${beforeSha}, ${afterSha}, ${beforeContent}, ${afterContent},
      ${`revert of audit ${id}`}, ${"revert"}
    )
    RETURNING audit_id
  `;
  const revertAuditId = revertInsert?.[0]?.audit_id;
  if (!revertAuditId) {
    throw new Error("Failed to insert revert audit row — transaction will roll back");
  }

  return {
    reverted: true,
    revert_audit_id: revertAuditId,
    reverted_audit_id: id,
    skill_name: audit.skill_name,
    overlay_count: afterRows.length,
    before_sha: beforeSha,
    after_sha: afterSha,
  };
}
