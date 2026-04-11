/**
 * A2A Agent Card — describes agent capabilities for discovery.
 *
 * Published at /.well-known/agent.json so other agents and systems
 * can discover what this agent can do.
 *
 */

/** A capability the agent can perform. */
export interface AgentSkill {
  id: string;
  name: string;
  description: string;
  tags?: string[];
  examples?: string[];
}

/** A2A Agent Card — the public identity of an agent. */
export interface AgentCard {
  id: string;
  name: string;
  description: string;
  version: string;
  provider: {
    organization: string;
  };
  capabilities: {
    streaming: boolean;
    pushNotifications: boolean;
    multiTurn: boolean;
  };
  skills: AgentSkill[];
  securitySchemes: Array<Record<string, unknown>>;
  interfaces: Array<Record<string, unknown>>;
  url: string;
}

/** Agent configuration input (subset of agent config). */
export interface AgentConfig {
  name: string;
  agent_id?: string;
  description: string;
  version: string;
  tools?: Array<string | { name?: string }>;
  tags?: string[];
}

/**
 * Build an A2A Agent Card from an AgentConfig.
 *
 * @param config - AgentConfig instance
 * @param baseUrl - The URL where this agent is served (e.g., http://localhost:8340)
 * @returns AgentCard — the public identity card for A2A discovery
 */
export function buildAgentCard(config: AgentConfig, baseUrl: string = ""): AgentCard {
  // Build skills from tools
  const skills: AgentSkill[] = [];

  if (config.tools) {
    for (let i = 0; i < config.tools.length; i++) {
      const tool = config.tools[i];
      const toolName = typeof tool === "string" ? tool : tool.name || `tool-${i}`;
      skills.push({
        id: `${config.name}-${toolName}`,
        name: toolName,
        description: `Tool: ${toolName}`,
        tags: [toolName],
      });
    }
  }

  // Add a primary skill for the agent itself
  skills.unshift({
    id: config.name,
    name: config.name,
    description: config.description,
    tags: config.tags || [],
  });

  return {
    id: config.agent_id || config.name,
    name: config.name,
    description: config.description,
    version: config.version,
    provider: { organization: "AgentOS" },
    capabilities: {
      streaming: true,
      pushNotifications: false,
      multiTurn: true,
    },
    // x-402 pricing (if agent charges for services)
    ...((config as any).pricing ? {
      pricing: {
        price_per_task_usd: (config as any).pricing.price_per_task_usd || 0,
        price_per_1k_tokens_usd: (config as any).pricing.price_per_1k_tokens_usd || 0,
        accepts: ["oneshots-credits"],
        protocol: "x-402",
      },
    } : {}),
    skills,
    securitySchemes: [{ type: "http", scheme: "bearer" }],
    interfaces: [
      {
        type: "jsonrpc",
        url: baseUrl ? `${baseUrl}/a2a` : "/a2a",
      },
    ],
    url: baseUrl,
  };
}

/** Convert AgentCard to a plain JSON object. */
export function agentCardToJSON(card: AgentCard): Record<string, unknown> {
  return {
    id: card.id,
    name: card.name,
    description: card.description,
    version: card.version,
    provider: card.provider,
    capabilities: card.capabilities,
    skills: card.skills.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      ...(s.tags?.length ? { tags: s.tags } : {}),
      ...(s.examples?.length ? { examples: s.examples } : {}),
    })),
    securitySchemes: card.securitySchemes,
    interfaces: card.interfaces,
    url: card.url,
    ...((card as any).pricing ? { pricing: (card as any).pricing } : {}),
  };
}
