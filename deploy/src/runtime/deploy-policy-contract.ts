/**
 * Deploy-time policy contract (schema v1).
 * Mirror: `control-plane/src/logic/deploy-policy-contract.ts` — keep in sync.
 *
 * Canonical persisted field: `deploy_policy` on agent `config`.
 * Legacy flat fields (tools, governance.*, eval_config, release_strategy) are
 * synthesized when `deploy_policy` is absent or partially overridden.
 */

import { z } from "zod";

export const DEPLOY_POLICY_SCHEMA_VERSION = 1 as const;

export const deployPolicyToolsSchema = z.object({
  enabled: z.array(z.string()),
  blocked: z.array(z.string()),
});

export const deployPolicyDomainsSchema = z.object({
  allowed: z.array(z.string()),
  blocked: z.array(z.string()),
});

export const deployPolicyBudgetsSchema = z.object({
  budget_limit_usd: z.number().min(0).max(500_000),
  max_turns: z.number().int().min(1).max(10_000).optional(),
  max_tokens_per_turn: z.number().min(0).max(2_000_000).optional(),
  timeout_seconds: z.number().int().min(1).max(86_400).optional(),
});

export const deployPolicyEvalReleaseSchema = z.object({
  min_eval_pass_rate: z.number().min(0).max(1).optional(),
  min_eval_trials: z.number().int().min(0).max(1_000_000).optional(),
  require_graph_lint_for_production: z.boolean().optional(),
  override_requires_approval: z.boolean().optional(),
});

export const deployPolicyRuntimeFlagsSchema = z.object({
  require_confirmation_for_destructive: z.boolean().optional(),
  parallel_tool_calls: z.boolean().optional(),
  require_human_approval: z.boolean().optional(),
});

export const deployPolicyV1Schema = z.object({
  schema_version: z.literal(1),
  tools: deployPolicyToolsSchema,
  domains: deployPolicyDomainsSchema,
  budgets: deployPolicyBudgetsSchema,
  eval_release: deployPolicyEvalReleaseSchema.optional(),
  runtime_flags: deployPolicyRuntimeFlagsSchema.optional(),
});

export type DeployPolicyV1 = z.infer<typeof deployPolicyV1Schema>;

function asRecord(v: unknown): Record<string, unknown> | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

function stringArray(v: unknown): string[] {
  if (Array.isArray(v)) {
    return [...new Set(v.map((x) => String(x).trim()).filter(Boolean))];
  }
  if (typeof v === "string" && v.trim()) return [v.trim()];
  return [];
}

function numInRange(v: unknown, fallback: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function optionalInt(v: unknown): number | undefined {
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  return Math.trunc(n);
}

function optionalRate01(v: unknown): number | undefined {
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(1, Math.max(0, n));
}

function boolish(v: unknown): boolean | undefined {
  if (v === true || v === false) return v;
  if (v === "true") return true;
  if (v === "false") return false;
  return undefined;
}

/** Baseline policy from legacy / flat agent config (no deploy_policy overlay). */
export function synthesizeLegacyDeployPolicy(configJson: Record<string, unknown>): DeployPolicyV1 {
  const gov = asRecord(configJson.governance) ?? {};
  const evalCfg = asRecord(configJson.eval_config) ?? {};
  const releaseStrat = asRecord(configJson.release_strategy) ?? {};

  const enabled = stringArray(configJson.tools);
  const blocked = stringArray(configJson.blocked_tools ?? gov.blocked_tools);

  const allowed = stringArray(configJson.allowed_domains ?? gov.allowed_domains);
  const blockedDomains = stringArray(configJson.blocked_domains ?? gov.blocked_domains);

  const maxTurns = optionalInt(configJson.max_turns);
  const maxTok = optionalInt(configJson.max_tokens_per_turn ?? gov.max_tokens_per_turn);
  const timeout = optionalInt(configJson.timeout_seconds);

  const er: NonNullable<DeployPolicyV1["eval_release"]> = {};
  const mr = optionalRate01(evalCfg.min_pass_rate ?? evalCfg.minEvalPassRate);
  const mt = optionalInt(evalCfg.min_trials ?? evalCfg.minEvalTrials);
  if (mr !== undefined) er.min_eval_pass_rate = mr;
  if (mt !== undefined) er.min_eval_trials = mt;
  const rg = boolish(releaseStrat.require_graph_lint_for_production);
  if (rg !== undefined) er.require_graph_lint_for_production = rg;
  const oa = boolish(releaseStrat.override_requires_approval);
  if (oa !== undefined) er.override_requires_approval = oa;

  const rf: NonNullable<DeployPolicyV1["runtime_flags"]> = {};
  const rcd = boolish(configJson.require_confirmation_for_destructive ?? gov.require_confirmation_for_destructive);
  if (rcd !== undefined) rf.require_confirmation_for_destructive = rcd;
  if (configJson.parallel_tool_calls === false || configJson.parallelToolCalls === false) {
    rf.parallel_tool_calls = false;
  } else {
    rf.parallel_tool_calls = true;
  }
  const rha = boolish(configJson.require_human_approval ?? gov.require_human_approval);
  if (rha !== undefined) rf.require_human_approval = rha;

  const budgets: DeployPolicyV1["budgets"] = {
    budget_limit_usd: numInRange(
      configJson.budget_limit_usd ?? gov.budget_limit_usd,
      10,
      0,
      500_000,
    ),
  };
  if (maxTurns !== undefined && maxTurns >= 1) budgets.max_turns = maxTurns;
  if (maxTok !== undefined && maxTok >= 0) budgets.max_tokens_per_turn = maxTok;
  if (timeout !== undefined && timeout >= 1) budgets.timeout_seconds = timeout;

  return {
    schema_version: 1,
    tools: { enabled, blocked },
    domains: { allowed, blocked: blockedDomains },
    budgets,
    eval_release: Object.keys(er).length ? er : undefined,
    runtime_flags: Object.keys(rf).length ? rf : undefined,
  };
}

function mergeDeployPolicyV1(base: DeployPolicyV1, overlay: Record<string, unknown>): DeployPolicyV1 {
  const out: DeployPolicyV1 = {
    schema_version: 1,
    tools: {
      enabled: [...base.tools.enabled],
      blocked: [...base.tools.blocked],
    },
    domains: {
      allowed: [...base.domains.allowed],
      blocked: [...base.domains.blocked],
    },
    budgets: { ...base.budgets },
    eval_release: base.eval_release ? { ...base.eval_release } : undefined,
    runtime_flags: base.runtime_flags ? { ...base.runtime_flags } : undefined,
  };

  const ot = asRecord(overlay.tools);
  if (ot) {
    if (ot.enabled !== undefined) out.tools.enabled = stringArray(ot.enabled);
    if (ot.blocked !== undefined) out.tools.blocked = stringArray(ot.blocked);
  }

  const od = asRecord(overlay.domains);
  if (od) {
    if (od.allowed !== undefined) out.domains.allowed = stringArray(od.allowed);
    if (od.blocked !== undefined) out.domains.blocked = stringArray(od.blocked);
  }

  const ob = asRecord(overlay.budgets);
  if (ob) {
    if (ob.budget_limit_usd !== undefined) {
      out.budgets.budget_limit_usd = numInRange(ob.budget_limit_usd, out.budgets.budget_limit_usd, 0, 500_000);
    }
    const mt = optionalInt(ob.max_turns);
    if (mt !== undefined && mt >= 1) out.budgets.max_turns = mt;
    const mtt = optionalInt(ob.max_tokens_per_turn);
    if (mtt !== undefined && mtt >= 0) out.budgets.max_tokens_per_turn = mtt;
    const ts = optionalInt(ob.timeout_seconds);
    if (ts !== undefined && ts >= 1) out.budgets.timeout_seconds = ts;
  }

  const oe = asRecord(overlay.eval_release);
  if (oe) {
    const er = { ...(out.eval_release ?? {}) };
    const mr = optionalRate01(oe.min_eval_pass_rate);
    if (mr !== undefined) er.min_eval_pass_rate = mr;
    const mt = optionalInt(oe.min_eval_trials);
    if (mt !== undefined) er.min_eval_trials = mt;
    const rg = boolish(oe.require_graph_lint_for_production);
    if (rg !== undefined) er.require_graph_lint_for_production = rg;
    const oa = boolish(oe.override_requires_approval);
    if (oa !== undefined) er.override_requires_approval = oa;
    out.eval_release = Object.keys(er).length ? er : undefined;
  }

  const orf = asRecord(overlay.runtime_flags);
  if (orf) {
    const rf = { ...(out.runtime_flags ?? {}) };
    const rcd = boolish(orf.require_confirmation_for_destructive);
    if (rcd !== undefined) rf.require_confirmation_for_destructive = rcd;
    const pc = boolish(orf.parallel_tool_calls);
    if (pc !== undefined) rf.parallel_tool_calls = pc;
    const rha = boolish(orf.require_human_approval);
    if (rha !== undefined) rf.require_human_approval = rha;
    out.runtime_flags = Object.keys(rf).length ? rf : undefined;
  }

  return out;
}

export function buildDeployPolicyForConfig(configJson: Record<string, unknown>): {
  policy: DeployPolicyV1;
  warnings: string[];
} {
  const warnings: string[] = [];
  const legacy = synthesizeLegacyDeployPolicy(configJson);
  const raw = configJson.deploy_policy;
  if (raw === undefined || raw === null) {
    return { policy: legacy, warnings };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    warnings.push("deploy_policy must be an object; ignoring overlay");
    return { policy: legacy, warnings };
  }
  const overlay = raw as Record<string, unknown>;
  const sv = overlay.schema_version;
  if (sv !== undefined && sv !== 1) {
    warnings.push(`unsupported deploy_policy.schema_version ${String(sv)}; ignoring overlay`);
    return { policy: legacy, warnings };
  }
  return { policy: mergeDeployPolicyV1(legacy, overlay), warnings };
}

/** Zod + cross-field rules (enabled/blocked overlap). */
export function validateDeployPolicyConsistency(policy: DeployPolicyV1): string[] {
  const zErr = deployPolicyV1Schema.safeParse(policy);
  if (!zErr.success) {
    return zErr.error.issues.map((e) => e.path.join(".") + ": " + e.message);
  }
  const en = new Set(policy.tools.enabled.map((t) => t.trim()).filter(Boolean));
  const bl = new Set(policy.tools.blocked.map((t) => t.trim()).filter(Boolean));
  const toolDups = [...en].filter((t) => bl.has(t));
  if (toolDups.length) {
    return [`tools: same name in enabled and blocked: ${toolDups.join(", ")}`];
  }
  const da = new Set(policy.domains.allowed.map((s) => s.trim()).filter(Boolean));
  const db = new Set(policy.domains.blocked.map((s) => s.trim()).filter(Boolean));
  const domDups = [...da].filter((d) => db.has(d));
  if (domDups.length) {
    return [`domains: same host in allowed and blocked: ${domDups.join(", ")}`];
  }
  return [];
}

export type ApplyDeployPolicyResult =
  | { ok: true; warnings: string[] }
  | { ok: false; errors: string[]; warnings: string[] };

/**
 * Mutates `configJson` with a normalized `deploy_policy` field.
 * @param opts.fallbackStripOverlay — if validation fails after merge, drop `deploy_policy` and rebuild from legacy only (runtime / best-effort restore).
 */
export function applyDeployPolicyToConfigJson(
  configJson: Record<string, unknown>,
  opts?: { fallbackStripOverlay?: boolean },
): ApplyDeployPolicyResult {
  const first = buildDeployPolicyForConfig(configJson);
  let errors = validateDeployPolicyConsistency(first.policy);
  if (errors.length === 0) {
    configJson.deploy_policy = first.policy as unknown as Record<string, unknown>;
    return { ok: true, warnings: first.warnings };
  }
  if (opts?.fallbackStripOverlay && configJson.deploy_policy !== undefined) {
    delete configJson.deploy_policy;
    const second = buildDeployPolicyForConfig(configJson);
    errors = validateDeployPolicyConsistency(second.policy);
    if (errors.length === 0) {
      configJson.deploy_policy = second.policy as unknown as Record<string, unknown>;
      return {
        ok: true,
        warnings: [
          ...first.warnings,
          "deploy_policy overlay failed validation; fell back to legacy fields only",
        ],
      };
    }
  }
  return { ok: false, errors, warnings: first.warnings };
}
