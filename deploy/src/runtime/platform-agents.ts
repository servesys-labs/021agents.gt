import type { AgentConfig } from "./types";

const MEMORY_AGENT_HANDLE = "memory-agent";
const MEMORY_AGENT_ID = "platform-memory-agent";

export function isAmbientPlatformAgentHandle(handle: string): boolean {
  return String(handle || "").trim().toLowerCase() === MEMORY_AGENT_HANDLE;
}

export function getAmbientPlatformAgentConfig(
  handle: string,
  defaults: { provider: string; model: string; plan: string },
  orgId?: string,
): AgentConfig | null {
  if (!isAmbientPlatformAgentHandle(handle)) return null;
  return {
    agent_id: MEMORY_AGENT_ID,
    agent_handle: MEMORY_AGENT_HANDLE,
    agent_name: MEMORY_AGENT_HANDLE,
    display_name: "Memory Agent",
    system_prompt: "You are the memory curator. Execute memory skills only. Keep outputs structured and concise.",
    provider: "workers-ai",
    model: "@cf/moonshotai/kimi-k2.5",
    plan: "free",
    max_turns: 5,
    budget_limit_usd: 2,
    tools: [
      "memory-save",
      "memory-recall",
      "memory-delete",
      "memory-health",
      "curated-memory",
      "knowledge-search",
    ],
    enabled_skills: [
      "memory-digest",
      "memory-consolidate",
      "memory-recall-deep",
    ],
    blocked_tools: [],
    allowed_domains: [],
    blocked_domains: [],
    max_tokens_per_turn: 0,
    require_confirmation_for_destructive: false,
    parallel_tool_calls: true,
    require_human_approval: false,
    org_id: orgId || "",
    project_id: "",
    enable_workspace_checkpoints: true,
    use_code_mode: true,
    internal: true,
    hidden: true,
  };
}
