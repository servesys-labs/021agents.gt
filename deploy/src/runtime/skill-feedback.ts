/**
 * Phase 6.5 — second-ask auto-fire detector for the skill learning loop.
 *
 * Scans evolve-agent analyzer output for failure_clusters that have recurred
 * enough to warrant a learned rule, and routes proposals through the
 * control-plane append-rule endpoint. The control-plane enforces all the
 * safety rails (rate limit, injection scan, audit trail, admin revert).
 *
 * Correctness invariant — org-wide overlay scope. Rules are written with
 * agentName="" because the meta-agent runs /improve under its own agent
 * name, not the analyzed agent's. See loadSkillOverlays at
 * deploy/src/runtime/skills.ts:75:
 *
 *     WHERE agent_name = ${agentName} OR agent_name = ''
 *
 * An overlay written under agent_name="" loads for ANY agent's invocation,
 * including the meta-agent's /improve runs. An overlay written under the
 * target agent's name would never load under the meta-agent's /improve and
 * would silently be dead code — rule stored, audited, rate-limited, never
 * read. The org-wide scope is the whole reason this detector can ship.
 *
 * Fail-open: all detector errors are caught, logged, and swallowed. A
 * broken detector must not break the analyzer response path.
 *
 * Phase 6.6 follow-up — rule text quality. The current v1 rule text is
 * descriptive-but-fuzzy ("prefer configurations that avoid it") because
 * writing concrete imperatives requires pattern→remediation mapping, which
 * is a rabbit hole deferred to Phase 6.6 once real audit rows surface
 * which phrasings actually change model behavior. Ship with acknowledged
 * fuzziness; iterate once there's a reward signal to iterate against.
 */

import { log } from "./log";

/** Cluster count threshold — fewer occurrences are noise, not signal. */
const MIN_CLUSTER_COUNT = 3;

/** Max length for any example_error embedded in a rule. Overlays ship
 * verbatim to the model on every /improve call, so untruncated error
 * bodies risk pinning large amounts of prose into the prompt budget. */
const MAX_EXAMPLE_LEN = 120;

/** Secret patterns scrubbed from example_errors before they land in an
 * overlay. Defense in depth — error messages pulled from production
 * sessions can carry API keys, tokens, or user PII. The injection scanner
 * handles prompt-injection patterns; this handles credential leaks. */
const SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  /sk-ant-[A-Za-z0-9_-]{10,}/g,                        // Anthropic-style
  /sk-[A-Za-z0-9]{10,}/g,                              // OpenAI-style
  /Bearer\s+[A-Za-z0-9._\-]{10,}/gi,                   // Bearer tokens
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,   // emails
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,                     // Slack tokens
  /ghp_[A-Za-z0-9]{20,}/g,                             // GitHub PATs
  /AKIA[A-Z0-9]{16}/g,                                 // AWS access keys
];

const REDACTED = "[REDACTED]";

interface FailureCluster {
  pattern: string;
  count: number;
  severity?: number;
  example_errors?: string[];
  affected_sessions?: string[];
}

interface EvolveReportLike {
  failure_clusters?: FailureCluster[];
}

export interface RuleProposal {
  skillName: string;
  ruleText: string;
  source: string;
  reason: string;
}

export interface FireContext {
  orgId: string;
}

/** Scrub secret patterns and truncate to MAX_EXAMPLE_LEN. */
function scrubAndTruncate(text: string): string {
  let out = String(text ?? "");
  for (const pat of SECRET_PATTERNS) out = out.replace(pat, REDACTED);
  if (out.length > MAX_EXAMPLE_LEN) {
    out = out.slice(0, MAX_EXAMPLE_LEN - 1) + "…";
  }
  return out;
}

/**
 * Scan an evolve-agent analyzer report for failure clusters meeting the
 * auto-fire threshold. Returns zero or more RuleProposals — one per cluster
 * with count >= MIN_CLUSTER_COUNT.
 *
 * Session IDs are intentionally dropped: the meta-agent reading the rule at
 * /improve invocation time has no tool to fetch session bodies, and the IDs
 * are inference-useless noise. Session forensics belong in skill_audit
 * rows, not in overlays that ship to the model.
 */
export function detectEvolveFeedback(
  report: EvolveReportLike | null | undefined,
  originatingAgent: string,
): RuleProposal[] {
  const clusters = report?.failure_clusters ?? [];
  const agent = String(originatingAgent || "unknown").slice(0, 60);
  const out: RuleProposal[] = [];
  for (const c of clusters) {
    if (!c || typeof c.count !== "number" || c.count < MIN_CLUSTER_COUNT) continue;
    const pattern = String(c.pattern || "").slice(0, 80);
    if (!pattern) continue;
    const examples = (c.example_errors ?? [])
      .slice(0, 2)
      .map(scrubAndTruncate)
      .filter((s) => s.length > 0);
    const exampleClause = examples.length
      ? ` Recent examples: ${examples.join(" | ")}`
      : "";
    out.push({
      skillName: "improve",
      ruleText:
        `ATTENTION: Pattern '${pattern}' has produced ${c.count} recent ` +
        `failures on agent '${agent}'. When proposing changes related to ` +
        `this pattern, prefer configurations that avoid it.${exampleClause}`,
      source: "auto-fire:evolve",
      reason: `failure_cluster pattern=${pattern} count=${c.count} severity=${c.severity ?? 0} agent=${agent}`,
    });
  }
  return out;
}

/**
 * POST RuleProposals to the control-plane append-rule endpoint via the
 * CONTROL_PLANE service binding. Fire-and-forget semantics: each proposal
 * is awaited independently, errors are logged but never rethrown, and the
 * caller's response path is unaffected by detector failures.
 *
 * Routes to /api/v1/admin/skills/append-rule. The control-plane route
 * reads the synthetic service-token user (role=owner, org from X-Org-Id
 * header), wraps the call in withOrgDb, and calls appendRule with
 * agentName="" — the org-wide overlay scope that lets the rule load under
 * any agent's /improve invocation.
 *
 * TODO(phase-6.5.2a): server-side dedup. A user clicking "analyze" three
 * times in ten minutes currently fires three identical proposals per
 * qualifying cluster, burning 3 slots against the 5/day auto bucket for
 * no learning gain. Dedup check belongs in the control-plane route (not
 * this client) so any future caller inherits it for free. Tracked as a
 * sibling commit to 6.5.3 (evolve-agent wiring).
 */
export async function fireSkillFeedback(
  env: unknown,
  ctx: FireContext,
  proposals: RuleProposal[],
): Promise<void> {
  if (proposals.length === 0) return;
  const controlPlane = (env as any)?.CONTROL_PLANE;
  const serviceToken = (env as any)?.SERVICE_TOKEN;
  if (!controlPlane || !serviceToken) {
    log.warn("[skill-feedback] CONTROL_PLANE or SERVICE_TOKEN missing; auto-fire disabled");
    return;
  }
  for (const p of proposals) {
    try {
      const resp = await controlPlane.fetch(
        "https://internal/api/v1/admin/skills/append-rule",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${serviceToken}`,
            "X-Org-Id": ctx.orgId,
          },
          body: JSON.stringify({
            skill_name: p.skillName,
            rule_text: p.ruleText,
            source: p.source,
            reason: p.reason,
          }),
        },
      );
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        log.warn(`[skill-feedback] append-rule returned ${resp.status}: ${body.slice(0, 200)}`);
      }
    } catch (err: any) {
      log.warn(`[skill-feedback] append-rule fetch failed: ${err?.message || err}`);
    }
  }
}
