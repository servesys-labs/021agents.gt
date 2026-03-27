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
  return {
    policy_version: 1,
    enabled_tools: Array.isArray(config.tools) ? config.tools : [],
    blocked_tools: Array.isArray(config.blocked_tools) ? config.blocked_tools : [],
    allowed_domains: Array.isArray(config.allowed_domains) ? config.allowed_domains : [],
    blocked_domains: Array.isArray((config as any).blocked_domains) ? (config as any).blocked_domains : [],
    require_confirmation_for_destructive: Boolean(config.require_confirmation_for_destructive),
    max_tokens_per_turn: Number(config.max_tokens_per_turn || 0),
  };
}

export function attachToolPolicyEnvelope(env: RuntimeEnv, config: AgentConfig): void {
  (env as any).__agentConfig = buildToolPolicyEnvelope(config);
}
