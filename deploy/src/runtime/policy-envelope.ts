import type { AgentConfig, RuntimeEnv } from "./types";

export type ToolPolicyEnvelope = {
  policy_version: number;
  enabled_tools: string[];
  blocked_tools: string[];
  allowed_domains: string[];
  blocked_domains: string[];
  require_confirmation_for_destructive: boolean;
  max_tokens_per_turn: number;
};

export function buildToolPolicyEnvelope(config: AgentConfig): ToolPolicyEnvelope {
  const p = config.deploy_policy;
  if (p && p.schema_version === 1) {
    return {
      policy_version: p.schema_version,
      enabled_tools: p.tools.enabled,
      blocked_tools: p.tools.blocked,
      allowed_domains: p.domains.allowed,
      blocked_domains: p.domains.blocked,
      require_confirmation_for_destructive:
        p.runtime_flags?.require_confirmation_for_destructive === true,
      max_tokens_per_turn: Number(p.budgets.max_tokens_per_turn ?? config.max_tokens_per_turn ?? 0),
    };
  }
  return {
    policy_version: 1,
    enabled_tools: Array.isArray(config.tools) ? config.tools : [],
    blocked_tools: Array.isArray(config.blocked_tools) ? config.blocked_tools : [],
    allowed_domains: Array.isArray(config.allowed_domains) ? config.allowed_domains : [],
    blocked_domains: Array.isArray(config.blocked_domains) ? config.blocked_domains : [],
    require_confirmation_for_destructive: Boolean(config.require_confirmation_for_destructive),
    max_tokens_per_turn: Number(config.max_tokens_per_turn || 0),
  };
}

export function attachToolPolicyEnvelope(env: RuntimeEnv, config: AgentConfig): void {
  (env as any).__agentConfig = {
    ...buildToolPolicyEnvelope(config),
    // Include identity fields so tools can resolve org_id / agent name
    org_id: config.org_id || "",
    orgId: config.org_id || "",
    name: config.agent_name || "",
    agent_name: config.agent_name || "",
  };
}
