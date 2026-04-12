import type { AdminSql } from "../db/client";
import { buildPersonalAgentPrompt } from "../prompts/personal-agent";

export interface SeededInternalAgent {
  name: string;
  description: string;
  version: string;
  agentRole: "personal_assistant" | "skill" | "custom";
  config: Record<string, unknown>;
}

export function buildPersonalAssistantAgent(displayName: string): SeededInternalAgent {
  const personalName = "my-assistant";
  return {
    name: personalName,
    description: `${displayName}'s personal AI assistant`,
    version: "2.0.0",
    agentRole: "personal_assistant",
    config: {
      name: personalName,
      description: `${displayName}'s personal AI assistant`,
      system_prompt: buildPersonalAgentPrompt(displayName),
      model: "",
      plan: "free",
      tools: [
        "web-search", "browse",
        "python-exec", "bash",
        "read-file", "write-file", "edit-file",
        "execute-code", "swarm",
        "memory-save", "memory-recall",
        "create-schedule", "list-schedules", "delete-schedule",
      ],
      enabled_skills: [
        "research", "debug", "remember", "batch", "verify", "build-app",
      ],
      max_turns: 50,
      temperature: 0.7,
      tags: ["personal", "assistant"],
      version: "2.0.0",
      governance: { budget_limit_usd: 10 },
      reasoning_strategy: "",
      use_code_mode: true,
      parallel_tool_calls: true,
      is_personal: true,
    },
  };
}

export function buildMemoryAgent(): SeededInternalAgent {
  return {
    name: "memory-agent",
    description: "Internal memory curation subagent",
    version: "1.0.0",
    agentRole: "skill",
    config: {
      name: "memory-agent",
      description: "Internal memory curation subagent",
      system_prompt: "You are the memory curator. Execute memory skills only. Keep outputs structured and concise.",
      model: "",
      plan: "free",
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
      max_turns: 5,
      temperature: 0.2,
      tags: ["internal", "memory", "assistant"],
      version: "1.0.0",
      governance: { budget_limit_usd: 2 },
      reasoning_strategy: "",
      use_code_mode: true,
      parallel_tool_calls: true,
      is_personal: true,
      internal: true,
    },
  };
}

export function buildDefaultInternalAgents(displayName: string): SeededInternalAgent[] {
  return [
    buildPersonalAssistantAgent(displayName),
    buildMemoryAgent(),
  ];
}

export async function seedDefaultInternalAgents(
  sql: AdminSql,
  input: {
    orgId: string;
    userId: string;
    displayName: string;
    nowIso?: string;
  },
): Promise<string[]> {
  const created: string[] = [];
  const nowIso = input.nowIso || new Date().toISOString();

  for (const agent of buildDefaultInternalAgents(input.displayName)) {
    const agentId = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    const rows = await sql`
      INSERT INTO agents (
        agent_id, name, org_id, description, config, version,
        is_active, agent_role, created_by, created_at, updated_at
      )
      VALUES (
        ${agentId},
        ${agent.name},
        ${input.orgId},
        ${agent.description},
        ${JSON.stringify(agent.config)},
        ${agent.version},
        ${true},
        ${agent.agentRole},
        ${input.userId},
        ${nowIso},
        ${nowIso}
      )
      ON CONFLICT (name, org_id) DO NOTHING
      RETURNING name
    `;
    if (rows.length > 0) created.push(agent.name);
  }

  return created;
}
