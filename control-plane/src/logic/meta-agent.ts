/**
 * Meta-agent: generate agent config from natural-language description via Workers AI.
 * Ported from agentos/builder.py build_from_description + recommend_tools.
 */

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

/** Tool recommendation keywords. */
const TOOL_KEYWORDS: Record<string, string[]> = {
  web_search: ["search", "browse", "web", "internet", "google", "find online"],
  code_exec: ["code", "python", "script", "execute", "run code", "programming"],
  file_ops: ["file", "read", "write", "csv", "json", "document"],
  calculator: ["math", "calculate", "compute", "numbers", "arithmetic"],
  api_call: ["api", "http", "rest", "endpoint", "webhook"],
  database: ["database", "sql", "query", "data", "records"],
  email: ["email", "mail", "send", "notification"],
  calendar: ["calendar", "schedule", "meeting", "event"],
};

/** ACI (Agent-Computer Interface) tools for code/file tasks. */
const ACI_TOOLS: string[] = [
  "view-file",
  "search-file",
  "find-file",
  "edit-file",
  "git-init",
  "git-commit",
  "git-status",
  "git-diff",
];

/** Keywords that indicate the task involves code or file manipulation. */
const CODE_FILE_KEYWORDS: string[] = [
  "code",
  "file",
  "implement",
  "build",
  "refactor",
  "debug",
  "fix",
  "repository",
  "repo",
  "commit",
  "git",
  "source",
  "codebase",
  "module",
  "function",
  "class",
  "script",
  "deploy",
  "compile",
  "lint",
  "test",
  "ci",
  "cd",
  "pipeline",
];

/** Reasoning strategy keyword mapping — first match wins. */
const REASONING_STRATEGY_KEYWORDS: Array<{ strategy: string; keywords: string[] }> = [
  {
    strategy: "plan-then-execute",
    keywords: ["code", "implement", "build", "refactor"],
  },
  {
    strategy: "step-back",
    keywords: ["debug", "fix", "investigate", "troubleshoot"],
  },
  {
    strategy: "chain-of-thought",
    keywords: ["analyze", "compare", "evaluate", "research"],
  },
  {
    strategy: "verify-then-respond",
    keywords: ["support", "help", "assist"],
  },
];

/** Recommend tools based on description keywords. */
export function recommendTools(description: string): string[] {
  const lower = description.toLowerCase();
  const recommended: string[] = [];
  for (const [tool, keywords] of Object.entries(TOOL_KEYWORDS)) {
    if (keywords.some((kw) => lower.includes(kw))) {
      recommended.push(tool);
    }
  }

  // Add ACI tools when the task involves code or file work
  const needsAci = CODE_FILE_KEYWORDS.some((kw) => lower.includes(kw));
  if (needsAci) {
    for (const tool of ACI_TOOLS) {
      if (!recommended.includes(tool)) {
        recommended.push(tool);
      }
    }
  }

  return recommended;
}

/** Harness settings inferred from the agent description. */
export interface HarnessSettings {
  reasoning_strategy?: string;
  use_code_mode?: boolean;
  extra_tools?: string[];
}

/**
 * Recommend harness-level settings (reasoning strategy, code mode, extra tools)
 * based on a natural-language description of what the agent should do.
 */
export function recommendHarnessSettings(
  description: string,
  currentToolCount: number = 0,
): HarnessSettings {
  const lower = description.toLowerCase();
  const settings: HarnessSettings = {};

  // 1. Reasoning strategy — keyword match, or "decompose" for complex tasks
  if (description.length > 200) {
    settings.reasoning_strategy = "decompose";
  } else {
    for (const { strategy, keywords } of REASONING_STRATEGY_KEYWORDS) {
      if (keywords.some((kw) => lower.includes(kw))) {
        settings.reasoning_strategy = strategy;
        break;
      }
    }
  }

  // 2. ACI extra tools when the task involves code/files
  const needsAci = CODE_FILE_KEYWORDS.some((kw) => lower.includes(kw));
  if (needsAci) {
    settings.extra_tools = [...ACI_TOOLS];
  }

  // 3. Code mode when the total tool count exceeds 15
  const totalTools = currentToolCount + (settings.extra_tools?.length ?? 0);
  if (totalTools > 15) {
    settings.use_code_mode = true;
  } else {
    settings.use_code_mode = false;
  }

  return settings;
}

/** Generate agent config from description using Workers AI. */
export async function buildFromDescription(
  ai: Ai,
  description: string,
  opts: { name?: string; model?: string } = {},
): Promise<Record<string, unknown>> {
  const systemPrompt = `You are an AI agent configuration generator. Given a description of what an agent should do, generate a JSON configuration object.
The config must have these fields:
- name: string (snake_case, derived from description if not provided)
- description: string (1-2 sentence summary)
- system_prompt: string (detailed system prompt for the agent)
- model: string (default "anthropic/claude-sonnet-4.6")
- tools: string[] (recommended tool names)
- max_turns: number (default 50)
- tags: string[] (relevant tags)
- version: string (default "0.1.0")

Return ONLY valid JSON, no markdown fencing.`;

  const userPrompt = `Generate an agent configuration for: ${description}`;

  let configJson: Record<string, unknown>;

  try {
    const result = await ai.run("@cf/meta/llama-3.1-8b-instruct" as any, {
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_tokens: 1024,
    });

    // Extract text from result
    const text =
      typeof result === "string"
        ? result
        : typeof (result as Record<string, unknown>)?.response === "string"
          ? (result as Record<string, unknown>).response as string
          : JSON.stringify(result);

    // Try to parse JSON from response (strip markdown fences if present)
    const cleaned = text.replace(/^```(?:json)?\s*\n?/m, "").replace(/\n?```\s*$/m, "").trim();
    configJson = JSON.parse(cleaned);
  } catch {
    // Fallback: generate config from description without AI
    const slug = description
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "")
      .slice(0, 40);

    configJson = {
      name: opts.name || slug || "generated_agent",
      description: description.slice(0, 200),
      system_prompt: `You are an AI assistant. ${description}`,
      model: opts.model || "anthropic/claude-sonnet-4.6",
      tools: recommendTools(description),
      max_turns: 50,
      tags: ["generated", "meta-agent"],
      version: "0.1.0",
    };
  }

  // Override with explicit opts
  if (opts.name) configJson.name = opts.name;
  if (opts.model) configJson.model = opts.model;

  // Ensure required fields
  configJson.name = configJson.name || "generated_agent";
  configJson.description = configJson.description || description.slice(0, 200);
  configJson.system_prompt =
    configJson.system_prompt || `You are an AI assistant. ${description}`;
  configJson.model = configJson.model || "anthropic/claude-sonnet-4.6";
  configJson.tools = Array.isArray(configJson.tools) ? configJson.tools : [];
  configJson.max_turns = Number(configJson.max_turns) || 50;
  configJson.tags = Array.isArray(configJson.tags) ? configJson.tags : [];
  configJson.version = configJson.version || "0.1.0";

  return configJson;
}
