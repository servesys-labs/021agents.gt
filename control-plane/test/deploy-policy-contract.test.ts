import { describe, expect, it } from "vitest";
import {
  applyDeployPolicyToConfigJson,
  buildDeployPolicyForConfig,
  DEPLOY_POLICY_SCHEMA_VERSION,
  synthesizeLegacyDeployPolicy,
  validateDeployPolicyConsistency,
} from "../src/logic/deploy-policy-contract";

describe("deploy-policy-contract", () => {
  it("synthesizes v1 policy from legacy flat config", () => {
    const p = synthesizeLegacyDeployPolicy({
      tools: ["search", "browser"],
      blocked_tools: ["shell"],
      allowed_domains: ["example.com"],
      max_turns: 20,
      governance: { budget_limit_usd: 5, max_tokens_per_turn: 1024 },
      eval_config: { min_pass_rate: 0.9, min_trials: 5 },
      release_strategy: {},
    });
    expect(p.schema_version).toBe(DEPLOY_POLICY_SCHEMA_VERSION);
    expect(p.tools.enabled).toEqual(["search", "browser"]);
    expect(p.tools.blocked).toEqual(["shell"]);
    expect(p.domains.allowed).toEqual(["example.com"]);
    expect(p.budgets.budget_limit_usd).toBe(5);
    expect(p.budgets.max_turns).toBe(20);
    expect(p.budgets.max_tokens_per_turn).toBe(1024);
    expect(p.eval_release?.min_eval_pass_rate).toBe(0.9);
    expect(p.eval_release?.min_eval_trials).toBe(5);
    expect(validateDeployPolicyConsistency(p)).toEqual([]);
  });

  it("rejects overlapping enabled/blocked tools", () => {
    const p = synthesizeLegacyDeployPolicy({
      tools: ["x", "y"],
      blocked_tools: ["y"],
    });
    expect(validateDeployPolicyConsistency(p)).toEqual([
      expect.stringContaining("enabled and blocked"),
    ]);
  });

  it("applyDeployPolicyToConfigJson writes deploy_policy on valid legacy config", () => {
    const cfg: Record<string, unknown> = {
      tools: ["a"],
      governance: { budget_limit_usd: 3 },
    };
    const r = applyDeployPolicyToConfigJson(cfg);
    expect(r.ok).toBe(true);
    expect(cfg.deploy_policy).toBeDefined();
    expect((cfg.deploy_policy as { schema_version: number }).schema_version).toBe(1);
  });

  it("ignores unsupported schema_version overlay with warning (legacy fallback)", () => {
    const cfg: Record<string, unknown> = {
      tools: ["t"],
      deploy_policy: { schema_version: 99, tools: { enabled: ["bad"], blocked: ["bad"] } },
    };
    const { policy, warnings } = buildDeployPolicyForConfig(cfg);
    expect(warnings.some((w) => w.includes("schema_version 99"))).toBe(true);
    expect(policy.tools.enabled).toEqual(["t"]);
    expect(validateDeployPolicyConsistency(policy)).toEqual([]);
  });

  it("strip_overlay fallback recovers when overlay introduces conflicts", () => {
    const cfg: Record<string, unknown> = {
      tools: ["same"],
      blocked_tools: [],
      deploy_policy: {
        schema_version: 1,
        tools: { blocked: ["same"] },
      },
    };
    const strict = applyDeployPolicyToConfigJson(cfg);
    expect(strict.ok).toBe(false);

    const cfg2: Record<string, unknown> = {
      tools: ["same"],
      blocked_tools: [],
      deploy_policy: {
        schema_version: 1,
        tools: { blocked: ["same"] },
      },
    };
    const fb = applyDeployPolicyToConfigJson(cfg2, { fallbackStripOverlay: true });
    expect(fb.ok).toBe(true);
    expect(fb.warnings.some((w) => w.includes("fell back"))).toBe(true);
    expect((cfg2.deploy_policy as { tools: { enabled: string[] } }).tools.enabled).toEqual(["same"]);
  });
});
