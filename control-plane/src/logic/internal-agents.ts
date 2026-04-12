import type { Sql } from "../db/client";
import { buildPersonalAgentPrompt } from "../prompts/personal-agent";
import { decorateAgentConfigIdentity, defaultDisplayNameFromHandle } from "./agent-identity";

export interface SeededInternalAgent {
  handle: string;
  displayName: string;
  description: string;
  version: string;
  agentRole: "personal_assistant" | "skill" | "custom";
  config: Record<string, unknown>;
}

export function buildPersonalAssistantAgent(displayName: string): SeededInternalAgent {
  const personalHandle = "my-assistant";
  const personalDisplayName = defaultDisplayNameFromHandle(personalHandle);
  return {
    handle: personalHandle,
    displayName: personalDisplayName,
    description: `${displayName}'s personal AI assistant`,
    version: "2.0.0",
    agentRole: "personal_assistant",
    config: decorateAgentConfigIdentity({
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
    }, {
      handle: personalHandle,
      displayName: personalDisplayName,
    }),
  };
}

export function buildMemoryAgent(): SeededInternalAgent {
  const memoryHandle = "memory-agent";
  const memoryDisplayName = "Memory Agent";
  return {
    handle: memoryHandle,
    displayName: memoryDisplayName,
    description: "Internal memory curation subagent",
    version: "1.0.0",
    agentRole: "skill",
    config: decorateAgentConfigIdentity({
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
      hidden: true,
      visibility: "hidden",
    }, {
      handle: memoryHandle,
      displayName: memoryDisplayName,
    }),
  };
}

function normalizeHandle(value: string): string {
  return String(value || "").trim().toLowerCase();
}

export function buildAmbientInternalAgents(): SeededInternalAgent[] {
  return [buildMemoryAgent()];
}

export function isAmbientAgentHandle(handle: string): boolean {
  const normalized = normalizeHandle(handle);
  return buildAmbientInternalAgents().some((agent) => normalizeHandle(agent.handle) === normalized);
}

export function buildDefaultInternalAgents(displayName: string): SeededInternalAgent[] {
  // Persist only user-facing defaults. Platform-owned internal workers
  // like memory-agent resolve ambiently at runtime.
  return [
    buildPersonalAssistantAgent(displayName),
  ];
}

export async function seedDefaultInternalAgents(
  sql: Sql,
  input: {
    orgId: string;
    userId: string;
    displayName: string;
    nowIso?: string;
  },
): Promise<string[]> {
  const seeded: string[] = [];
  const nowIso = input.nowIso || new Date().toISOString();

  for (const agent of buildDefaultInternalAgents(input.displayName)) {
    const agentId = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    const rows = await sql`
      INSERT INTO agents (
        agent_id, handle, display_name, name, org_id, description, config, version,
        is_active, agent_role, created_by, created_at, updated_at
      )
      VALUES (
        ${agentId},
        ${agent.handle},
        ${agent.displayName},
        ${agent.handle},
        ${input.orgId},
        ${agent.description},
        ${JSON.stringify(decorateAgentConfigIdentity(agent.config, {
          agentId,
          handle: agent.handle,
          displayName: agent.displayName,
        }))}::jsonb,
        ${agent.version},
        ${true},
        ${agent.agentRole},
        ${input.userId},
        ${nowIso},
        ${nowIso}
      )
      ON CONFLICT (handle, org_id) DO UPDATE SET
        display_name = EXCLUDED.display_name,
        name = EXCLUDED.name,
        description = EXCLUDED.description,
        config = EXCLUDED.config,
        version = EXCLUDED.version,
        is_active = EXCLUDED.is_active,
        agent_role = EXCLUDED.agent_role,
        updated_at = EXCLUDED.updated_at
      RETURNING handle
    `;
    if (rows.length > 0) seeded.push(agent.handle);
  }

  return seeded;
}
