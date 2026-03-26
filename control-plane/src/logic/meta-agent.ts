/**
 * Meta-agent: generate agent config from natural-language description via Workers AI.
 * Uses the plan's default model for the generated agent, and a capable model for generation itself.
 */

import { getDb } from "../db/client";

/** Default no-code starter graph template. */
export function defaultNoCodeGraph(): Record<string, unknown> {
  return {
    id: "no-code-starter",
    nodes: [
      { id: "bootstrap", kind: "bootstrap" },
      { id: "route_llm", kind: "route_llm" },
      { id: "tools", kind: "tools" },
      { id: "after_tools", kind: "after_tools" },
      { id: "final", kind: "final" },
      {
        id: "telemetry_emit",
        kind: "telemetry_emit",
        async: true,
        idempotency_key: "session:${session_id}:turn:${turn}:telemetry_emit",
      },
    ],
    edges: [
      { source: "bootstrap", target: "route_llm" },
      { source: "route_llm", target: "tools" },
      { source: "tools", target: "after_tools" },
      { source: "after_tools", target: "final" },
      { source: "bootstrap", target: "telemetry_emit" },
    ],
  };
}

/** Tool recommendation keywords — expanded to match actual platform tools. */
const TOOL_KEYWORDS: Record<string, string[]> = {
  web_search: ["search", "browse", "web", "internet", "google", "find online", "lookup", "research"],
  sandbox_exec: ["code", "python", "script", "execute", "run code", "programming", "compute", "sandbox"],
  file_read: ["file", "read", "csv", "json", "document", "parse", "load"],
  file_write: ["file", "write", "save", "export", "generate report", "output"],
  http_request: ["api", "http", "rest", "endpoint", "webhook", "fetch", "request"],
  query_database: ["database", "sql", "query", "data", "records", "table", "postgres"],
  send_email: ["email", "mail", "send", "notification", "alert", "notify"],
  slack_send_message: ["slack", "message", "chat", "team", "channel"],
  knowledge_search: ["knowledge", "rag", "semantic", "vector", "embedding", "context"],
  create_ticket: ["ticket", "issue", "jira", "linear", "bug", "task", "backlog"],
  search_docs: ["docs", "documentation", "manual", "help", "faq", "support"],
};

/** Recommend tools based on description keywords. */
export function recommendTools(description: string): string[] {
  const lower = description.toLowerCase();
  const recommended: string[] = [];
  for (const [tool, keywords] of Object.entries(TOOL_KEYWORDS)) {
    if (keywords.some((kw) => lower.includes(kw))) {
      recommended.push(tool);
    }
  }
  // Always include web_search as a baseline unless explicitly a closed-domain agent
  if (recommended.length === 0) {
    recommended.push("web_search");
  }
  return recommended;
}

/** Resolve the default model from the org's plan routing table, or fall back to platform default. */
async function resolveDefaultModel(
  hyperdrive: Hyperdrive,
  orgId: string,
): Promise<string> {
  const PLATFORM_DEFAULT = "anthropic/claude-sonnet-4-6";
  if (!orgId) return PLATFORM_DEFAULT;

  try {
    const sql = getDb(hyperdrive);
    const rows = await sql`
      SELECT config_json FROM projects
      WHERE org_id = ${orgId}
      ORDER BY created_at DESC LIMIT 1
    `;
    if (rows.length > 0) {
      const config = JSON.parse(String(rows[0].config_json || "{}"));
      const routing = config.routing ?? config.plan_routing ?? {};
      // Check for a default model in routing
      if (routing.default?.model) return routing.default.model;
      if (routing.general?.model) return routing.general.model;
    }

    // Check org_settings for plan-level default
    const orgRows = await sql`
      SELECT settings_json FROM org_settings
      WHERE org_id = ${orgId}
      LIMIT 1
    `;
    if (orgRows.length > 0) {
      const settings = JSON.parse(String(orgRows[0].settings_json || "{}"));
      if (settings.default_model) return settings.default_model;
    }
  } catch {
    // DB query failed — use platform default
  }

  return PLATFORM_DEFAULT;
}

/** Generate agent config from description using Workers AI. */
export async function buildFromDescription(
  ai: Ai,
  description: string,
  opts: { name?: string; model?: string; hyperdrive?: Hyperdrive; orgId?: string } = {},
): Promise<Record<string, unknown>> {
  // Resolve the model the generated agent should use
  const agentModel = opts.model
    || (opts.hyperdrive && opts.orgId
      ? await resolveDefaultModel(opts.hyperdrive, opts.orgId)
      : "anthropic/claude-sonnet-4-6");

  const availableTools = Object.keys(TOOL_KEYWORDS).join(", ");

  const systemPrompt = `You are an AI agent configuration generator for the AgentOS platform.
Given a description of what an agent should do, generate a JSON configuration object.

The config MUST have these fields:
- name: string (snake_case, short, derived from the purpose)
- description: string (1-2 sentence summary of what the agent does)
- system_prompt: string (DETAILED system prompt with specific instructions, personality, constraints, and expected behaviors — at least 3-4 sentences)
- model: string (use "${agentModel}")
- tools: string[] (select from: ${availableTools})
- max_turns: number (default 25 for simple tasks, 50 for complex multi-step)
- tags: string[] (2-4 relevant categorization tags)
- version: string (always "0.1.0")

Guidelines for the system_prompt field:
- Be specific about the agent's role, responsibilities, and constraints
- Include what the agent should and should NOT do
- Specify the tone (professional, friendly, concise, etc.)
- Mention which tools the agent should prefer for which tasks
- Include any domain-specific knowledge the agent needs

Guidelines for tool selection:
- Include tools that match the agent's purpose
- Every agent that interacts with external data should have web_search
- Agents that process data should have sandbox_exec
- Agents that serve users should have knowledge_search

Return ONLY valid JSON. No markdown fences, no explanation.`;

  const userPrompt = `Generate an agent configuration for: ${description}`;

  let configJson: Record<string, unknown>;

  try {
    const result = await ai.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast" as any, {
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_tokens: 2048,
    });

    const text =
      typeof result === "string"
        ? result
        : typeof (result as Record<string, unknown>)?.response === "string"
          ? (result as Record<string, unknown>).response as string
          : JSON.stringify(result);

    const cleaned = text.replace(/^```(?:json)?\s*\n?/m, "").replace(/\n?```\s*$/m, "").trim();
    configJson = JSON.parse(cleaned);
  } catch {
    // Fallback: generate a reasonable config without AI
    const slug = description
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "")
      .slice(0, 40);

    const tools = recommendTools(description);

    configJson = {
      name: opts.name || slug || "generated_agent",
      description: description.slice(0, 200),
      system_prompt: `You are a specialized AI assistant designed to ${description.toLowerCase()}.

Your responsibilities:
- Understand user requests carefully before acting
- Use the available tools (${tools.join(", ")}) to accomplish tasks
- Provide clear, concise, and accurate responses
- Ask clarifying questions when the request is ambiguous
- Never fabricate information — use tools to verify facts

Be professional, helpful, and proactive in suggesting next steps.`,
      model: agentModel,
      tools,
      max_turns: 25,
      tags: ["generated"],
      version: "0.1.0",
    };
  }

  // Override with explicit opts
  if (opts.name) configJson.name = opts.name;

  // Ensure required fields with quality defaults
  configJson.name = configJson.name || "generated_agent";
  configJson.description = configJson.description || description.slice(0, 200);
  if (!configJson.system_prompt || String(configJson.system_prompt).length < 50) {
    configJson.system_prompt = `You are a specialized AI assistant designed to ${description.toLowerCase()}. Be thorough, accurate, and helpful.`;
  }
  configJson.model = agentModel; // Always use plan-resolved model, not whatever LLM hallucinated
  configJson.tools = Array.isArray(configJson.tools) ? configJson.tools : recommendTools(description);
  configJson.max_turns = Number(configJson.max_turns) || 25;
  configJson.tags = Array.isArray(configJson.tags) ? configJson.tags : [];
  configJson.version = configJson.version || "0.1.0";

  return configJson;
}
