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

/* ── Pipedream MCP Connector Discovery ──────────────────────────── */
/*
 * Instead of a hardcoded catalog, the meta-agent proposes app names
 * based on its own judgment, then we validate against Pipedream's
 * live API and pull real tool schemas.
 */

type PipedreamApp = {
  name_slug: string;
  name: string;
  description?: string;
};

type PipedreamAction = {
  key: string;
  name: string;
  description?: string;
};

type ValidatedConnector = {
  app: string;
  app_name: string;
  reason: string;
  recommended_tools: string[];
  validated: boolean;
};

/**
 * Query Pipedream's API to search for apps by name.
 * Returns matching app slugs and descriptions.
 */
async function searchPipedreamApps(
  query: string,
  clientId: string,
  clientSecret: string,
  projectId: string,
): Promise<PipedreamApp[]> {
  try {
    // Get access token via client credentials
    const tokenResp = await fetch("https://api.pipedream.com/v1/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });
    if (!tokenResp.ok) return [];
    const tokenData = await tokenResp.json() as { access_token?: string };
    const accessToken = tokenData.access_token;
    if (!accessToken) return [];

    // Search apps
    const resp = await fetch(
      `https://api.pipedream.com/v1/connect/apps?q=${encodeURIComponent(query)}&limit=5`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "x-pd-project-id": projectId,
        },
      },
    );
    if (!resp.ok) return [];
    const data = await resp.json() as { data?: PipedreamApp[] };
    return data.data ?? [];
  } catch {
    return [];
  }
}

/**
 * Get available actions (tools) for a specific Pipedream app.
 */
async function getPipedreamActions(
  appSlug: string,
  clientId: string,
  clientSecret: string,
  projectId: string,
): Promise<string[]> {
  try {
    const tokenResp = await fetch("https://api.pipedream.com/v1/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });
    if (!tokenResp.ok) return [];
    const tokenData = await tokenResp.json() as { access_token?: string };
    const accessToken = tokenData.access_token;
    if (!accessToken) return [];

    const resp = await fetch(
      `https://api.pipedream.com/v1/connect/apps/${appSlug}/actions?limit=10`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "x-pd-project-id": projectId,
        },
      },
    );
    if (!resp.ok) return [];
    const data = await resp.json() as { data?: PipedreamAction[] };
    return (data.data ?? []).map((a) => a.name || a.key).slice(0, 5);
  } catch {
    return [];
  }
}

/**
 * Validate and enrich connector recommendations from the LLM
 * against Pipedream's live API. Returns connectors with real tool names.
 */
export async function validateConnectors(
  proposed: Array<{ app: string; reason: string; recommended_tools?: string[] }>,
  pipedreamCreds: { clientId: string; clientSecret: string; projectId: string },
): Promise<ValidatedConnector[]> {
  const results: ValidatedConnector[] = [];

  // Process in parallel (bounded to 5)
  const tasks = proposed.slice(0, 8).map(async (connector) => {
    const apps = await searchPipedreamApps(
      connector.app, pipedreamCreds.clientId, pipedreamCreds.clientSecret, pipedreamCreds.projectId,
    );

    if (apps.length === 0) {
      // App not found on Pipedream — return as unvalidated with LLM's tools
      return {
        app: connector.app,
        app_name: connector.app,
        reason: connector.reason,
        recommended_tools: connector.recommended_tools ?? [],
        validated: false,
      };
    }

    const matched = apps[0];
    // Get real tools for this app
    const tools = await getPipedreamActions(
      matched.name_slug, pipedreamCreds.clientId, pipedreamCreds.clientSecret, pipedreamCreds.projectId,
    );

    return {
      app: matched.name_slug,
      app_name: matched.name || matched.name_slug,
      reason: connector.reason,
      recommended_tools: tools.length > 0 ? tools : (connector.recommended_tools ?? []),
      validated: true,
    };
  });

  const settled = await Promise.allSettled(tasks);
  for (const result of settled) {
    if (result.status === "fulfilled") {
      results.push(result.value);
    }
  }

  return results;
}

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
    pipedream?: { clientId: string; clientSecret: string; projectId: string };
    orgDefaultConnectors?: string[];
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

  const systemPrompt = `You are the AgentOS Meta-Agent — a senior AI architect that designs complete, production-ready agent deployment packages for the AgentOS platform.

You don't just create a config — you design the entire operational package: agent config, execution graph, sub-agents, reusable skills, custom codemode tools, governance policies, guardrails, evaluation criteria, and release strategy.

## Platform Tool Inventory (64 tools)
${toolInventory}

## Platform Capabilities
- **Graph execution**: Agents run on a declarative DAG. Nodes can be: bootstrap, route_llm, tools, after_tools, final, telemetry_emit, approval_gate, sub_agent, codemode_exec. Edges connect nodes. Nodes can be async (parallel branches). Breakpoints pause for human approval.
- **Sub-agents**: Agents can spawn specialist sub-agents via route-to-agent and create-agent tools. Each sub-agent gets its own config, tools, and prompt.
- **Codemode**: Custom JavaScript/TypeScript snippets that run in sandboxed V8 isolates. Use for: data transforms, scoring algorithms, template rendering, API field mapping, custom validation — anything the 64 built-in tools don't cover.
- **Skills**: Reusable prompt templates (type: "prompt"), tool chains (type: "tool-chain"), or workflows (type: "workflow") stored in the Skills Library and attachable to any agent.
- **Guardrails**: Safety rules enforced at runtime — rate limits, content policies, PII detection, compliance checks.
- **Governance**: Budget limits, tool restrictions, confirmation gates for destructive/bulk actions.
- **Evaluation**: Automated test scenarios with pass/fail thresholds that gate deployment.
- **Releases**: Channel-based deployment (staging → canary → production) with traffic splitting.
- **MCP Connectors**: 3,000+ external app integrations via Pipedream MCP. OAuth managed automatically. Any SaaS app the agent needs (Gmail, Slack, HubSpot, Salesforce, LinkedIn, Calendly, Stripe, Jira, Notion, Zendesk, Shopify, Twilio, etc.) can be connected. The platform validates app availability automatically.

## External Integrations (Pipedream MCP — 3,000+ apps)
You have access to 3,000+ external apps via Pipedream's MCP connector infrastructure. When an agent needs to interact with external services, freely recommend ANY apps you think are relevant. Common categories:
- CRM: HubSpot, Salesforce, Pipedrive, Close, Apollo
- Email: Gmail, Outlook, SendGrid, Mailchimp, Resend
- Chat: Slack, Discord, Microsoft Teams, Intercom
- Social: LinkedIn, Twitter/X, Facebook, Instagram
- Scheduling: Calendly, Google Calendar, Cal.com
- Payments: Stripe, Square, PayPal, QuickBooks
- Project Management: Jira, Linear, Asana, Notion, Trello, Monday
- DevOps: GitHub, GitLab, Datadog, PagerDuty, Sentry
- Analytics: Google Analytics, Mixpanel, Amplitude, Segment
- Storage: Google Sheets, Airtable, Google Drive, Dropbox, S3
- Support: Zendesk, Freshdesk, Help Scout
- E-commerce: Shopify, WooCommerce, Stripe
- Communication: Twilio (SMS/Voice/WhatsApp), Vonage

Don't limit yourself to this list — propose any app that makes sense for the agent's purpose. The platform will validate each app against Pipedream's live API and pull real tool schemas.
${opts.orgDefaultConnectors && opts.orgDefaultConnectors.length > 0 ? `
## Organization's Preferred Tools
This organization has already configured these apps as their defaults: ${opts.orgDefaultConnectors.join(", ")}
ALWAYS include these in your mcp_connectors recommendations when relevant to the agent's purpose. These are pre-approved by the org.
` : ""}
Include a "mcp_connectors" array in your output with the apps you recommend, why each is needed, and suggested tool names.

## Output Format — Complete Agent Package

Return a JSON object with ALL of these top-level fields:

{
  "agent": {
    "name": "snake_case_name",
    "description": "1-2 sentence summary",
    "system_prompt": "DETAILED 200+ word prompt (see guidelines)",
    "model": "${agentModel}",
    "tools": ["tool-name-1", "tool-name-2"],
    "max_turns": 50,
    "tags": ["tag1", "tag2"],
    "version": "0.1.0"
  },

  "graph": {
    "id": "agent-name-graph",
    "nodes": [
      { "id": "bootstrap", "kind": "bootstrap" },
      { "id": "research", "kind": "tools", "async": true, "tools": ["web-search", "autoresearch"] },
      { "id": "route_llm", "kind": "route_llm" },
      { "id": "tools", "kind": "tools" },
      { "id": "approval", "kind": "approval_gate", "breakpoint": true },
      { "id": "sub_specialist", "kind": "sub_agent", "agent_name": "specialist-name" },
      { "id": "telemetry_emit", "kind": "telemetry_emit", "async": true },
      { "id": "final", "kind": "final" }
    ],
    "edges": [
      { "source": "bootstrap", "target": "research" },
      { "source": "bootstrap", "target": "route_llm" },
      { "source": "route_llm", "target": "tools" },
      { "source": "tools", "target": "approval" },
      { "source": "approval", "target": "final" }
    ]
  },

  "sub_agents": [
    {
      "name": "specialist-name",
      "description": "What this specialist does",
      "system_prompt": "Detailed prompt for the specialist",
      "model": "${agentModel}",
      "tools": ["relevant-tools"],
      "max_turns": 15
    }
  ],

  "skills": [
    {
      "name": "skill-name",
      "description": "What this skill does",
      "category": "prompt|tool-chain|workflow",
      "content": "The full skill content (markdown prompt template, tool chain definition, or workflow steps)"
    }
  ],

  "codemode_snippets": [
    {
      "name": "snippet-name",
      "description": "What this custom tool does",
      "scope": "agent",
      "code": "// JavaScript code that runs in sandboxed V8\\nexport default async function(input, ctx) { ... }"
    }
  ],

  "governance": {
    "budget_limit_usd": 50,
    "require_confirmation_for": ["bulk email sends", "CRM writes"],
    "blocked_tools": ["delete-agent", "manage-secrets"]
  },

  "guardrails": [
    {
      "name": "guardrail-name",
      "type": "rate_limit|content_policy|compliance",
      "rule": "Description of the rule",
      "action": "block|warn|log"
    }
  ],

  "eval_config": {
    "scenarios": ["scenario description 1", "scenario description 2"],
    "metrics": ["metric_name"],
    "thresholds": { "metric_name": 0.8 }
  },

  "release_strategy": {
    "initial_channel": "staging",
    "canary_percent": 10,
    "promote_after": "eval pass + 24h soak"
  },

  "mcp_connectors": [
    {
      "app": "hubspot",
      "reason": "Why this agent needs this external app",
      "recommended_tools": ["create-contact", "update-deal"]
    }
  ]
}

## System Prompt Guidelines
1. Minimum 200 words, structured with ## sections
2. Sections: Role, Responsibilities, Tools (which tool for which task), Constraints, Communication Style
3. Tool-aware: explicitly mention tool names and when to use each
4. Include what the agent should NOT do
5. Domain-specific knowledge and terminology

## Graph Design Guidelines
1. NEVER use a flat linear pipeline. Design a real DAG with parallel branches.
2. Use async nodes for independent research/data gathering that can run in parallel
3. Add approval_gate nodes with breakpoint:true before bulk/destructive actions
4. Use sub_agent nodes for specialist delegation
5. Always include telemetry_emit as an async branch from bootstrap
6. Tools node should be after route_llm, final should be the terminal node

## Codemode Guidelines
Create codemode snippets for logic that doesn't exist in the 64 built-in tools:
- Data transformation/enrichment
- Scoring algorithms
- Template rendering with merge fields
- API response mapping/normalization
- Custom validation rules

Return ONLY valid JSON. No markdown fences, no explanation.`;

  const userPrompt = `Design a complete agent package for: ${description}`;

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
      max_tokens: 16384, // Large output for full package
      temperature: 0.3,
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

  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(cleaned);
  } catch (e) {
    throw new Error(`Meta-agent returned invalid JSON: ${(e as Error).message}\n\nRaw response:\n${cleaned.slice(0, 500)}`);
  }

  // The LLM returns { agent: {...}, graph: {...}, sub_agents: [...], ... }
  // Extract the agent config and attach the rest as metadata
  const agentConfig = (pkg.agent ?? pkg) as Record<string, unknown>;

  // Validate required fields
  if (!agentConfig.name || !agentConfig.system_prompt) {
    throw new Error(`Meta-agent response missing required fields. Got keys: ${Object.keys(agentConfig).join(", ")}`);
  }

  // Override model to plan-resolved value
  agentConfig.model = agentModel;

  // Validate tools against platform inventory
  if (Array.isArray(agentConfig.tools)) {
    const validTools = new Set(PLATFORM_TOOL_NAMES);
    agentConfig.tools = (agentConfig.tools as string[]).filter((t) => validTools.has(t));
    if ((agentConfig.tools as string[]).length === 0) {
      agentConfig.tools = recommendTools(description);
    }
  } else {
    agentConfig.tools = recommendTools(description);
  }

  // Ensure defaults
  agentConfig.max_turns = Number(agentConfig.max_turns) || 25;
  agentConfig.tags = Array.isArray(agentConfig.tags) ? agentConfig.tags : [];
  agentConfig.version = agentConfig.version || "0.1.0";

  // Attach the full package metadata alongside the flat agent config
  // The route handler decides what to persist
  agentConfig._package = {
    graph: pkg.graph ?? null,
    sub_agents: Array.isArray(pkg.sub_agents) ? pkg.sub_agents : [],
    skills: Array.isArray(pkg.skills) ? pkg.skills : [],
    codemode_snippets: Array.isArray(pkg.codemode_snippets) ? pkg.codemode_snippets : [],
    governance: pkg.governance ?? null,
    guardrails: Array.isArray(pkg.guardrails) ? pkg.guardrails : [],
    eval_config: pkg.eval_config ?? null,
    release_strategy: pkg.release_strategy ?? null,
    mcp_connectors: Array.isArray(pkg.mcp_connectors) ? pkg.mcp_connectors : [],
  };

  // Validate MCP connectors against Pipedream's live API
  const proposedConnectors = (agentConfig._package as Record<string, unknown>).mcp_connectors as Array<{ app: string; reason: string; recommended_tools?: string[] }>;
  if (proposedConnectors.length > 0 && opts.pipedream) {
    try {
      const validated = await validateConnectors(proposedConnectors, opts.pipedream);
      (agentConfig._package as Record<string, unknown>).mcp_connectors = validated;
    } catch {
      // Validation failed — keep LLM's unvalidated suggestions
    }
  }

  return agentConfig;
}
