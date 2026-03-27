import { buildToolPolicyEnvelope } from "./policy-envelope";
import type { AgentConfig, RuntimeEnv } from "./types";

/** Parent context when this run is a delegated child (run-agent). */
export type DelegationContextInput = {
  parent_session_id?: string;
  parent_trace_id?: string;
  parent_agent_name?: string;
  /** Depth of the parent session in the delegation chain (0 = root). */
  parent_depth?: number;
};

export type DelegationLineage = {
  session_id: string;
  trace_id: string;
  agent_name: string;
  org_id: string;
  project_id: string;
  depth: number;
  parent_session_id?: string;
  parent_trace_id?: string;
  parent_agent_name?: string;
  budget_limit_usd: number;
  max_turns: number;
  turn: number;
  cumulative_cost_usd: number;
  policy_hints: {
    policy_version: number;
    blocked_tools: string[];
    allowed_domains: string[];
    blocked_domains: string[];
    require_confirmation_for_destructive: boolean;
    max_tokens_per_turn: number;
  };
};

function clampDepth(raw: unknown): number {
  return Math.max(0, Math.min(32, Number(raw) || 0));
}

export function attachDelegationLineage(
  env: RuntimeEnv,
  config: AgentConfig,
  ids: { session_id: string; trace_id: string },
  opts?: {
    org_id?: string;
    project_id?: string;
    agent_name?: string;
    delegation?: DelegationContextInput;
  },
): DelegationLineage {
  const del = opts?.delegation;
  const parentSessionId = String(del?.parent_session_id || "").trim();
  const parentDepth = parentSessionId ? clampDepth(del?.parent_depth) : 0;
  const sessionDepth = parentSessionId ? parentDepth + 1 : 0;

  const policyEnv = buildToolPolicyEnvelope(config);
  const lineage: DelegationLineage = {
    session_id: ids.session_id,
    trace_id: ids.trace_id,
    agent_name: config.agent_name || opts?.agent_name || "",
    org_id: config.org_id || opts?.org_id || "",
    project_id: config.project_id || opts?.project_id || "",
    depth: sessionDepth,
    parent_session_id: parentSessionId || undefined,
    parent_trace_id: String(del?.parent_trace_id || "").trim() || undefined,
    parent_agent_name: String(del?.parent_agent_name || "").trim() || undefined,
    budget_limit_usd: Number(config.budget_limit_usd || 0),
    max_turns: Number(config.max_turns || 0),
    turn: 1,
    cumulative_cost_usd: 0,
    policy_hints: {
      policy_version: policyEnv.policy_version,
      blocked_tools: policyEnv.blocked_tools.slice(0, 40),
      allowed_domains: policyEnv.allowed_domains.slice(0, 15),
      blocked_domains: policyEnv.blocked_domains.slice(0, 15),
      require_confirmation_for_destructive: policyEnv.require_confirmation_for_destructive,
      max_tokens_per_turn: policyEnv.max_tokens_per_turn,
    },
  };

  (env as unknown as { __delegationLineage?: DelegationLineage }).__delegationLineage = lineage;
  return lineage;
}
