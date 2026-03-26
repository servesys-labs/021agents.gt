/**
 * Meta-agent: generate agent config from natural-language description.
 * Uses Claude Sonnet 4.6 via OpenRouter for high-quality generation.
 * Has full awareness of the platform's tool inventory.
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

/* ── Platform tool inventory ────────────────────────────────────── */
/*
 * This is the actual tool inventory from deploy/src/runtime/tools.ts.
 * The meta-agent uses this to select appropriate tools for each agent.
 */

const PLATFORM_TOOLS = {
  // Data & Research
  "web-search": "Search the web for real-time information",
  "browse": "Load and read a specific URL",
  "web-crawl": "Crawl a website and extract structured data",
  "browser-render": "Render a page in a headless browser (screenshots, JS execution)",
  "knowledge-search": "Semantic search across the agent's knowledge base (RAG)",
  "store-knowledge": "Store documents in the knowledge base for RAG retrieval",

  // Code & Execution
  "bash": "Execute shell commands in a sandboxed environment",
  "python-exec": "Execute Python code in a sandboxed environment",
  "sandbox-exec": "Run code in an isolated sandbox container",
  "dynamic-exec": "Execute dynamically generated code (JS/TS) in a V8 isolate",

  // File Operations
  "read-file": "Read file contents with optional offset/limit pagination",
  "write-file": "Write or overwrite a file",
  "edit-file": "Edit a file with lint-on-edit validation (rejects bad syntax)",
  "view-file": "Stateful file viewer with 100-line windows and line numbers",
  "search-file": "Search within a file for a pattern",
  "find-file": "Find files by name pattern (glob)",
  "grep": "Search file contents across the project",
  "glob": "Find files matching a glob pattern",

  // Communication
  "send-email": "Send an email notification",
  "a2a-send": "Send a task to another agent via A2A protocol",
  "route-to-agent": "Delegate a subtask to a specialist agent",
  "submit-feedback": "Submit user feedback on an agent session",

  // Data & APIs
  "http-request": "Make HTTP requests to external APIs",
  "db-query": "Execute a SQL query against the database",
  "db-batch": "Execute multiple SQL queries in a transaction",
  "db-report": "Generate a formatted report from a SQL query",
  "query-pipeline": "Query data from a pipeline",
  "send-to-pipeline": "Send data into a pipeline for processing",

  // Media
  "image-generate": "Generate images from text descriptions",
  "text-to-speech": "Convert text to speech audio",

  // Platform Management
  "create-agent": "Create a new agent programmatically",
  "delete-agent": "Delete an agent",
  "run-agent": "Execute an agent with a task",
  "eval-agent": "Run evaluation trials on an agent",
  "evolve-agent": "Analyze agent performance and generate improvement proposals",
  "list-agents": "List all agents in the project",
  "list-tools": "List all available tools",
  "security-scan": "Run a security scan on an agent",
  "conversation-intel": "Analyze conversation quality and sentiment",
  "manage-issues": "Create, update, or resolve agent issues",
  "compliance": "Check compliance status and policies",
  "view-costs": "View cost breakdowns by agent and session",
  "view-traces": "View execution traces for debugging",
  "manage-releases": "Manage release channels and deployments",
  "autoresearch": "Run automated research on a topic",

  // DevOps
  "git-init": "Initialize a git repository",
  "git-status": "Show git working tree status",
  "git-diff": "Show file differences",
  "git-commit": "Stage and commit changes",
  "git-log": "Show commit history",
  "git-branch": "List or create branches",
  "git-stash": "Stash or pop working changes",

  // Scheduling & Workflows
  "create-schedule": "Create a cron schedule for recurring tasks",
  "list-schedules": "List active schedules",
  "manage-workflows": "Create and run multi-step workflows",
  "todo": "Manage a task list within a session",

  // Advanced
  "run-codemode": "Execute a codemode snippet in a sandboxed V8 isolate",
  "manage-rag": "Manage RAG indices and documents",
  "manage-mcp": "Manage MCP server connections",
  "manage-secrets": "Manage encrypted secrets",
  "discover-api": "Discover available API endpoints and their schemas",
} as const;

/** All platform tool names. */
export const PLATFORM_TOOL_NAMES = Object.keys(PLATFORM_TOOLS);

/** Recommend tools based on description — uses the actual platform inventory. */
export function recommendTools(description: string): string[] {
  const lower = description.toLowerCase();
  const recommended: string[] = [];

  const KEYWORD_MAP: Record<string, string[]> = {
    "web-search": ["search", "browse", "web", "internet", "find", "lookup", "research", "google"],
    "browse": ["url", "website", "page", "scrape", "crawl"],
    "bash": ["shell", "command", "terminal", "script", "cli"],
    "python-exec": ["python", "script", "compute", "analyze", "data science", "ml"],
    "sandbox-exec": ["code", "execute", "run", "sandbox", "programming"],
    "read-file": ["file", "read", "csv", "json", "document", "parse"],
    "write-file": ["write", "save", "export", "generate report", "output", "create file"],
    "http-request": ["api", "http", "rest", "endpoint", "webhook", "fetch", "request", "integration"],
    "db-query": ["database", "sql", "query", "data", "records", "table", "postgres"],
    "send-email": ["email", "mail", "send", "notification", "alert"],
    "a2a-send": ["delegate", "multi-agent", "collaborate", "hand off"],
    "knowledge-search": ["knowledge", "rag", "semantic", "vector", "context", "docs", "faq"],
    "store-knowledge": ["store", "index", "ingest", "upload", "knowledge base"],
    "image-generate": ["image", "picture", "visual", "design", "graphic"],
    "manage-issues": ["ticket", "issue", "bug", "track", "triage"],
    "autoresearch": ["research", "study", "investigate", "literature", "survey"],
    "security-scan": ["security", "scan", "vulnerability", "audit"],
    "create-schedule": ["schedule", "cron", "recurring", "periodic", "automate"],
    "eval-agent": ["evaluate", "test", "benchmark", "quality"],
    "git-commit": ["git", "version control", "commit", "repository"],
    "text-to-speech": ["voice", "speak", "audio", "tts", "podcast"],
    "todo": ["task", "checklist", "plan", "organize"],
    "conversation-intel": ["sentiment", "quality", "analytics", "conversation"],
    "manage-workflows": ["workflow", "pipeline", "orchestrate", "multi-step"],
  };

  for (const [tool, keywords] of Object.entries(KEYWORD_MAP)) {
    if (keywords.some((kw) => lower.includes(kw))) {
      recommended.push(tool);
    }
  }

  // Always include web-search as baseline for agents that interact with users
  if (recommended.length === 0 || lower.includes("assist") || lower.includes("help") || lower.includes("support")) {
    if (!recommended.includes("web-search")) recommended.push("web-search");
  }

  return recommended;
}

/** Resolve the default model from the org's plan, or fall back to platform default. */
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
      if (routing.default?.model) return routing.default.model;
      if (routing.general?.model) return routing.general.model;
    }
  } catch {
    // DB query failed — use platform default
  }

  return PLATFORM_DEFAULT;
}

/* ── Agent config generation via OpenRouter ─────────────────────── */

/**
 * Generate agent config from description using Claude Sonnet 4.6 via OpenRouter.
 * NO FALLBACK — if the LLM call fails, the error propagates to the caller.
 */
export async function buildFromDescription(
  _ai: Ai, // kept for API compat but not used — we call OpenRouter directly
  description: string,
  opts: {
    name?: string;
    model?: string;
    hyperdrive?: Hyperdrive;
    orgId?: string;
    openrouterApiKey?: string;
  } = {},
): Promise<Record<string, unknown>> {
  if (!opts.openrouterApiKey) {
    throw new Error("OPENROUTER_API_KEY is required for agent generation. Check worker secrets.");
  }

  // Resolve the model the generated agent should use
  const agentModel = opts.model
    || (opts.hyperdrive && opts.orgId
      ? await resolveDefaultModel(opts.hyperdrive, opts.orgId)
      : "anthropic/claude-sonnet-4-6");

  // Build the tool inventory string for the prompt
  const toolInventory = Object.entries(PLATFORM_TOOLS)
    .map(([name, desc]) => `  - ${name}: ${desc}`)
    .join("\n");

  const systemPrompt = `You are the AgentOS Meta-Agent — an expert AI architect that designs agent configurations for the AgentOS platform.

You have deep knowledge of the platform's capabilities and tool inventory. Your job is to generate high-quality, production-ready agent configurations from natural language descriptions.

## Platform Tool Inventory
These are ALL available tools on the platform. Select the ones most relevant to the agent's purpose:

${toolInventory}

## Output Format
Generate a JSON configuration with these fields:

- **name**: string — snake_case identifier (short, descriptive, max 30 chars)
- **description**: string — 1-2 sentence summary of the agent's purpose
- **system_prompt**: string — DETAILED instructions for the agent (see guidelines below)
- **model**: "${agentModel}" (always use this exact model)
- **tools**: string[] — selected from the tool inventory above
- **max_turns**: number — 25 for focused tasks, 50 for complex multi-step workflows
- **tags**: string[] — 2-4 categorization tags
- **version**: "0.1.0"

## System Prompt Guidelines
The system_prompt field is the most important part. It must be:
1. **Specific**: Define the agent's exact role, responsibilities, and domain
2. **Structured**: Use sections for Role, Capabilities, Constraints, and Behavior
3. **Tool-aware**: Mention which tools to use for which tasks
4. **Bounded**: Specify what the agent should NOT do
5. **Toned**: Define communication style (professional, friendly, concise, etc.)
6. **Minimum 200 words** — generic one-liners are unacceptable

Example system_prompt structure:
"You are [role] specialized in [domain].\\n\\n## Responsibilities\\n- [specific task 1]\\n- [specific task 2]\\n\\n## Tools\\n- Use web-search for [purpose]\\n- Use db-query for [purpose]\\n\\n## Constraints\\n- Never [constraint]\\n- Always [requirement]\\n\\n## Communication Style\\n[tone and format expectations]"

Return ONLY valid JSON. No markdown fences, no explanation, no preamble.`;

  const userPrompt = `Design an agent for: ${description}`;

  // Call Claude Sonnet 4.6 via OpenRouter
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${opts.openrouterApiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://agentos-portal.servesys.workers.dev",
      "X-Title": "AgentOS Meta-Agent",
    },
    body: JSON.stringify({
      model: "anthropic/claude-sonnet-4-6",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_tokens: 4096,
      temperature: 0.3, // Low temp for structured output
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenRouter API error (${response.status}): ${errText}`);
  }

  const result = await response.json() as {
    choices?: Array<{ message?: { content?: string } }>;
    error?: { message?: string };
  };

  if (result.error) {
    throw new Error(`OpenRouter error: ${result.error.message}`);
  }

  const text = result.choices?.[0]?.message?.content ?? "";
  if (!text.trim()) {
    throw new Error("Meta-agent returned empty response");
  }

  // Parse JSON — strip markdown fences if present
  const cleaned = text.replace(/^```(?:json)?\s*\n?/m, "").replace(/\n?```\s*$/m, "").trim();

  let configJson: Record<string, unknown>;
  try {
    configJson = JSON.parse(cleaned);
  } catch (e) {
    throw new Error(`Meta-agent returned invalid JSON: ${(e as Error).message}\n\nRaw response:\n${cleaned.slice(0, 500)}`);
  }

  // Validate required fields exist
  if (!configJson.name || !configJson.system_prompt) {
    throw new Error(`Meta-agent response missing required fields. Got: ${Object.keys(configJson).join(", ")}`);
  }

  // Override model to plan-resolved value (don't trust LLM)
  configJson.model = agentModel;

  // Validate tools are from the platform inventory
  if (Array.isArray(configJson.tools)) {
    const validTools = new Set(PLATFORM_TOOL_NAMES);
    configJson.tools = (configJson.tools as string[]).filter((t) => validTools.has(t));
    if ((configJson.tools as string[]).length === 0) {
      configJson.tools = recommendTools(description);
    }
  } else {
    configJson.tools = recommendTools(description);
  }

  // Ensure defaults for optional fields
  configJson.max_turns = Number(configJson.max_turns) || 25;
  configJson.tags = Array.isArray(configJson.tags) ? configJson.tags : [];
  configJson.version = configJson.version || "0.1.0";

  return configJson;
}
