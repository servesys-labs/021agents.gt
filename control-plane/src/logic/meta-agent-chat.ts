/**
 * Conversational meta-agent: lets users talk to an AI that manages their agent.
 * The meta-agent can read config, update settings, check observability,
 * run evals, and proactively fix issues — all via tool calls against
 * the control-plane's own APIs.
 *
 * This is NOT a separate system. It's a standard LLM + tools loop that
 * calls the same SQL/APIs the control-plane routes use.
 */

import { withOrgDb } from "../db/client";
import { generateEvolutionSuggestions } from "./meta-agent";
import { parseJsonColumn } from "../lib/parse-json-column";

/* ── Types ──────────────────────────────────────────────────────── */

export interface MetaChatMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface ToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface MetaChatContext {
  agentName: string;
  orgId: string;
  userId: string;
  userRole?: string;
  hyperdrive: Hyperdrive;
  openrouterApiKey: string;
  cloudflareAccountId?: string;
  aiGatewayId?: string;
  cloudflareApiToken?: string;
  aiGatewayToken?: string;
  gpuServiceKey?: string;
  modelPath?: "auto" | "gemma" | "sonnet";
  /** "demo" = showcase mode (auto-generate, minimal questions), "live" = production interview mode */
  mode?: "demo" | "live";
  env: {
    RUNTIME?: { fetch: (input: RequestInfo, init?: RequestInit) => Promise<Response> };
    SERVICE_TOKEN?: string;
    JOB_QUEUE?: { send: (message: unknown) => Promise<void> };
  };
}

/* ── Progressive tool discovery ─────────────────────────────────── */

// Tool groups — only send relevant tools each turn to save tokens
const TOOL_GROUPS: Record<string, string[]> = {
  config: ["read_agent_config", "update_agent_config"],
  sessions: ["read_sessions", "read_session_messages", "read_observability", "read_conversation_quality"],
  training: ["start_training", "read_training_status", "activate_trained_config", "rollback_training", "read_training_circuit_breaker"],
  eval: ["read_eval_results", "add_eval_test_cases", "test_agent", "analyze_and_suggest", "run_eval", "mine_session_failures"],
  agents: ["create_sub_agent", "manage_connectors"],
  marketplace: ["marketplace_publish", "marketplace_stats"],
  analytics: ["run_query"],
  infrastructure: ["read_session_diagnostics", "read_feature_flags", "set_feature_flag", "read_audit_log", "manage_skills"],
};

// Always-included tools (cheap to send, always useful)
const CORE_TOOLS = ["read_agent_config", "update_agent_config", "run_query"];

function selectMetaTools(context: string): ToolDef[] {
  const selected = new Set(CORE_TOOLS);

  // Match context to tool groups
  if (/session|user|usage|conversation|message|activity|error|fail|log/.test(context)) {
    TOOL_GROUPS.sessions.forEach(t => selected.add(t));
  }
  if (/train|improv|optimi|apo|iteration|score|reward/.test(context)) {
    TOOL_GROUPS.training.forEach(t => selected.add(t));
  }
  if (/eval|test|pass|fail|grader|rubric|quality/.test(context)) {
    TOOL_GROUPS.eval.forEach(t => selected.add(t));
  }
  if (/publish|marketplace|rating|listing|earn/.test(context)) {
    TOOL_GROUPS.marketplace.forEach(t => selected.add(t));
  }
  if (/cost|expensive|spend|billing|credit|budget|bash|tool_calls|diagnos/.test(context)) {
    TOOL_GROUPS.analytics.forEach(t => selected.add(t));
    TOOL_GROUPS.sessions.forEach(t => selected.add(t));
  }
  if (/how.*doing|health|overview|status|check/.test(context)) {
    TOOL_GROUPS.sessions.forEach(t => selected.add(t));
    TOOL_GROUPS.eval.forEach(t => selected.add(t));
  }
  if (/delegat|sub.?agent|specialist|create.*agent|spawn|child/.test(context)) {
    TOOL_GROUPS.agents.forEach(t => selected.add(t));
  }
  if (/connect|integrat|crm|slack|email|calendar|jira|notion|hubspot|salesforce|pipedream|mcp/.test(context)) {
    TOOL_GROUPS.agents.forEach(t => selected.add(t));
  }
  if (/run.*eval|run.*test|test.*suite|benchmark|measure|baseline/.test(context)) {
    TOOL_GROUPS.eval.forEach(t => selected.add(t));
  }
  if (/stop|crash|loop|truncat|cut.?off|forgot|cancel|circuit|breaker|abort|block|ssrf|flag|feature|audit|who.?changed|skill|slash/.test(context)) {
    TOOL_GROUPS.infrastructure.forEach(t => selected.add(t));
  }
  if (/diagnos|debug|why.*stop|why.*fail|what.*happen|went.*wrong/.test(context)) {
    TOOL_GROUPS.infrastructure.forEach(t => selected.add(t));
    TOOL_GROUPS.sessions.forEach(t => selected.add(t));
  }

  // Progressive discovery: if nothing matched beyond core, send core + a
  // starter set (sessions + eval) — NOT all 26 tools. The system prompt
  // documents all capabilities so the LLM knows what to ask for.
  if (selected.size <= CORE_TOOLS.length) {
    TOOL_GROUPS.sessions.forEach(t => selected.add(t));
    TOOL_GROUPS.eval.forEach(t => selected.add(t));
  }

  return META_TOOLS.filter(t => selected.has(t.function.name));
}

/* ── Tool definitions ───────────────────────────────────────────── */

const META_TOOLS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "read_agent_config",
      description:
        "Read the full configuration of the agent including system prompt, tools, model, governance, guardrails, and eval config.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "update_agent_config",
      description:
        "Update specific fields of the agent's configuration. Only include fields you want to change.",
      parameters: {
        type: "object",
        properties: {
          system_prompt: { type: "string", description: "New system prompt" },
          description: { type: "string", description: "Agent description" },
          personality: { type: "string", description: "Personality/tone" },
          model: { type: "string", description: "Model identifier" },
          plan: { type: "string", enum: ["free", "basic", "standard", "premium"], description: "LLM plan tier — controls which models are used for different task types" },
          routing: { type: "object", description: "Custom model routing overrides by category and role" },
          provider: { type: "string", description: "LLM provider (e.g. 'openrouter', 'openai', 'google-ai-studio'). Usually auto-detected from model name." },
          temperature: { type: "number", description: "Sampling temperature" },
          max_tokens: { type: "number", description: "Max output tokens per turn (alias for max_tokens_per_turn)" },
          max_tokens_per_turn: { type: "number", description: "Max output tokens per turn" },
          tools: {
            type: "array",
            items: { type: "string" },
            description: "Full list of tools the agent should have",
          },
          blocked_tools: {
            type: "array",
            items: { type: "string" },
            description: "Tools to explicitly deny, even if in the tools list. Useful for safety.",
          },
          allowed_domains: {
            type: "array",
            items: { type: "string" },
            description: "URL domain allowlist for http-request/browse tools. If set, only these domains are reachable.",
          },
          blocked_domains: {
            type: "array",
            items: { type: "string" },
            description: "URL domain blocklist for http-request/browse tools. These domains are always blocked.",
          },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Agent tags",
          },
          max_turns: { type: "number", description: "Max conversation turns (1-1000)" },
          timeout_seconds: { type: "number", description: "Run timeout in seconds" },
          budget_limit_usd: { type: "number", description: "Max cost per session in USD (0-10000). Set via governance.budget_limit_usd." },
          reasoning_strategy: {
            type: "string",
            enum: ["", "chain-of-thought", "plan-then-execute", "step-back", "decompose", "verify-then-respond"],
            description: "Reasoning strategy. Empty string = auto-select (recommended).",
          },
          parallel_tool_calls: {
            type: "boolean",
            description: "Enable parallel tool execution (default true). Set false to force serial execution for tools with ordering dependencies.",
          },
          require_human_approval: {
            type: "boolean",
            description: "Require human approval before executing destructive actions (default false).",
          },
          use_code_mode: {
            type: "boolean",
            description: "Enable codemode — runs agent logic in sandboxed V8 isolates for massive token savings on complex workflows.",
          },
          governance: {
            type: "object",
            description: "Governance settings (budget_limit_usd, require_confirmation_for_destructive, etc.)",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_sessions",
      description:
        "Read recent user sessions for this agent. Shows session IDs, message counts, timestamps, and channel info. Useful for understanding usage patterns.",
      parameters: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "Max sessions to return (default 20)",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_session_messages",
      description:
        "Read full turn-by-turn details from a session including tool calls, arguments, results, costs, and errors. Use this to diagnose what the agent did, what tools it called, and where it went wrong.",
      parameters: {
        type: "object",
        properties: {
          session_id: { type: "string", description: "Session ID to read" },
          limit: {
            type: "number",
            description: "Max messages to return (default 50)",
          },
        },
        required: ["session_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_observability",
      description:
        "Read observability data: recent incidents, error rates, latency stats, cost breakdown. Helps diagnose issues.",
      parameters: {
        type: "object",
        properties: {
          period: {
            type: "string",
            enum: ["1h", "24h", "7d", "30d"],
            description: "Time period (default 24h)",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_eval_results",
      description:
        "Read the latest evaluation run results: pass rate, failures, latency, cost. Shows how well the agent is performing on its test suite.",
      parameters: {
        type: "object",
        properties: {
          run_id: {
            type: "string",
            description: "Specific eval run ID (default: latest)",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "analyze_and_suggest",
      description:
        "Run the evolution analyzer: examine eval failures and observability data, then generate specific improvement suggestions with optional auto-applicable patches.",
      parameters: {
        type: "object",
        properties: {
          auto_apply_safe: {
            type: "boolean",
            description:
              "If true, automatically apply low-risk suggestions (prompt additions, tool additions). Default false.",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_conversation_quality",
      description:
        "Read conversation intelligence/quality metrics: sentiment trends, resolution rates, common topics, escalation patterns.",
      parameters: {
        type: "object",
        properties: {
          period: {
            type: "string",
            enum: ["24h", "7d", "30d"],
            description: "Time period (default 7d)",
          },
        },
        required: [],
      },
    },
  },

  // ── Training System Tools ─────────────────────────────────────
  {
    type: "function",
    function: {
      name: "start_training",
      description:
        "Start automated training. Algorithms: baseline (random perturbation), apo (LLM prompt optimization), multi (prompt + reasoning + tools). Runs eval suite each iteration.",
      parameters: {
        type: "object",
        properties: {
          algorithm: {
            type: "string",
            enum: ["baseline", "apo", "multi"],
            description: "Training algorithm. 'baseline' = random perturbation (safe, exploratory). 'apo' = LLM-powered prompt optimization (most effective for prompt quality). 'multi' = cycles through prompt + reasoning strategy + tool selection (comprehensive). Default: apo.",
          },
          max_iterations: {
            type: "number",
            description: "Max training iterations (default 10). Each iteration runs a full eval cycle.",
          },
          auto_activate: {
            type: "boolean",
            description: "If true, automatically activate the best-performing config when training completes. If false (default), the trained config is stored as a resource for manual review.",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_training_status",
      description:
        "Read the status of training jobs for this agent. Shows active/completed/failed jobs, current iteration, best score, algorithm used, and improvement trajectory.",
      parameters: {
        type: "object",
        properties: {
          job_id: {
            type: "string",
            description: "Specific job ID (default: latest job)",
          },
          include_iterations: {
            type: "boolean",
            description: "Include per-iteration details (scores, changes made). Default false.",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "activate_trained_config",
      description:
        "Activate a trained configuration from a training job. Applies it live with safety gates and auto-rollback circuit breaker.",
      parameters: {
        type: "object",
        properties: {
          resource_id: {
            type: "string",
            description: "The training resource ID to activate. Get this from read_training_status.",
          },
        },
        required: ["resource_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "rollback_training",
      description:
        "Roll back to the previous active configuration, undoing the last training activation. Use this if the trained config is performing worse than the original.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_training_circuit_breaker",
      description:
        "Check the circuit breaker status for this agent's training. Shows if auto-rollback is armed, current error rate, time since activation, and whether a rollback was triggered.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },

  // ── Marketplace Tools ──────────────────────────────────────
  {
    type: "function",
    function: {
      name: "marketplace_publish",
      description:
        "Publish this agent to the marketplace so other agents and users can discover and use it. Requires a display name, short description, category, and price per task.",
      parameters: {
        type: "object",
        properties: {
          display_name: { type: "string", description: "Human-readable name shown in marketplace" },
          short_description: { type: "string", description: "One-line description of what the agent does (max 200 chars)" },
          category: {
            type: "string",
            enum: ["shopping", "research", "legal", "finance", "travel", "coding", "creative", "support", "data", "health", "education", "marketing", "hr", "operations", "other"],
            description: "Marketplace category",
          },
          tags: { type: "array", items: { type: "string" }, description: "Searchable tags (e.g. ['summarizer', 'pdf'])" },
          price_per_task_usd: { type: "number", description: "Price in USD per task (0 = free). Recommended: 0.01-1.00" },
        },
        required: ["display_name", "short_description", "category", "price_per_task_usd"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "marketplace_stats",
      description:
        "Get this agent's marketplace listing stats: total tasks completed, average rating, quality score, earnings, and whether it's currently published.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_eval_test_cases",
      description:
        "Add test cases to the agent's eval suite. Each test case has an input (what a user would say), expected behavior, and grading criteria. The agent can then be evaluated against these cases. ~20% of cases are auto-assigned as holdout (not used during training optimization).",
      parameters: {
        type: "object",
        properties: {
          test_cases: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string", description: "Short snake_case test name" },
                input: { type: "string", description: "Realistic user message to test" },
                expected: { type: "string", description: "What a correct response should contain" },
                rubric: { type: "string", description: "Grading criteria: Score 1 if... Score 0 if..." },
                tags: { type: "array", items: { type: "string" }, description: "Capability tags" },
                category: { type: "string", description: "Behavioral category: tool_selection, multi_step, follow_up_quality, error_handling, safety, domain_specific, general (default: general)" },
                is_holdout: { type: "boolean", description: "Force this case as holdout (default: auto-assign ~20%)" },
              },
              required: ["name", "input", "expected"],
            },
            description: "Array of test cases to add",
          },
        },
        required: ["test_cases"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "test_agent",
      description:
        "Send a test message to the agent and get back the response. Use this to try out the agent's behavior before and after making config changes. Returns the agent's response, tool calls used, latency, and cost.",
      parameters: {
        type: "object",
        properties: {
          message: { type: "string", description: "The test message to send to the agent" },
        },
        required: ["message"],
      },
    },
  },
  // ── Eval & Sub-agent Tools ────────────────────────────────────
  {
    type: "function",
    function: {
      name: "run_eval",
      description:
        "Run the agent's eval suite NOW and return results. Executes test cases (from eval_test_cases table and config.eval_config), measures pass rate, latency, and cost. By default runs optimization cases only (excludes holdout). Set include_holdout=true for final validation.",
      parameters: {
        type: "object",
        properties: {
          max_cases: { type: "number", description: "Max test cases to run (default: all). Use a smaller number for quick spot-checks." },
          include_holdout: { type: "boolean", description: "Include holdout cases in the run (default: false). Set true for final validation." },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "mine_session_failures",
      description:
        "Scan recent sessions for failures and propose eval test cases. Finds errors, timeouts, and user corrections in the last 7 days and suggests test cases to prevent regression.",
      parameters: {
        type: "object",
        properties: {
          days: { type: "number", description: "Number of days to scan (default 7)" },
          limit: { type: "number", description: "Max failures to return (default 20)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_sub_agent",
      description:
        "Create a specialist sub-agent for delegation via run-agent. Keep tool lists lean (2-5 tools) — sub-agents should be focused specialists, not generalists.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Snake_case name for the sub-agent (e.g., 'research_assistant')" },
          description: { type: "string", description: "What this sub-agent specializes in" },
          system_prompt: { type: "string", description: "Detailed system prompt for the sub-agent (200+ words)" },
          tools: { type: "array", items: { type: "string" }, description: "Tools the sub-agent should have" },
          model: { type: "string", description: "Model (default: same as parent agent)" },
          max_turns: { type: "number", description: "Max turns for sub-agent (default: 15)" },
          budget_limit_usd: { type: "number", description: "Budget per sub-agent session (default: 1.0)" },
        },
        required: ["name", "description", "system_prompt", "tools"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "manage_connectors",
      description:
        "List, add, or remove MCP connectors for this agent. Connectors enable interaction with external apps (CRMs, email, calendars, etc.).",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["list", "add", "remove"],
            description: "Action to perform",
          },
          app: { type: "string", description: "App name for add/remove (e.g., 'hubspot', 'gmail', 'slack', 'jira', 'notion', 'google-calendar', 'salesforce', 'zendesk')" },
          reason: { type: "string", description: "Why this connector is needed (for add)" },
        },
        required: ["action"],
      },
    },
  },

  // ── Infrastructure & Diagnostics Tools ────────────────────────
  {
    type: "function",
    function: {
      name: "read_session_diagnostics",
      description:
        "Read runtime diagnostic events from a session: loops, compressions, repairs, circuit breakers, cancellations, truncations, budget guards. Use when users ask why something went wrong.",
      parameters: {
        type: "object",
        properties: {
          session_id: { type: "string", description: "Session ID to diagnose" },
        },
        required: ["session_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_feature_flags",
      description:
        "Read feature flags for this org: concurrent_tools, context_compression, deferred_tool_loading.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_feature_flag",
      description:
        "Enable or disable a feature flag for this agent's organization. Available flags: concurrent_tools, context_compression, deferred_tool_loading.",
      parameters: {
        type: "object",
        properties: {
          flag: {
            type: "string",
            enum: ["concurrent_tools", "context_compression", "deferred_tool_loading"],
            description: "The feature flag to toggle",
          },
          enabled: { type: "boolean", description: "true to enable, false to disable" },
        },
        required: ["flag", "enabled"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_audit_log",
      description:
        "Read the audit trail of configuration changes for this agent. Shows who changed what, when, and what values were modified. Use when a user asks 'who changed my agent?' or 'what happened to my config?'",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max entries to return (default 20)" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "manage_skills",
      description:
        "List, create, or delete custom /slash-command skills for this agent. Built-in: /batch, /review, /debug, /verify, /remember, /skillify, /schedule, /docs.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["list", "create", "delete"],
            description: "Action to perform",
          },
          name: { type: "string", description: "Skill name (for create/delete). Must be lowercase, hyphens allowed." },
          description: { type: "string", description: "Short description of what the skill does (for create)" },
          prompt_template: { type: "string", description: "The prompt template for the skill (for create). Use {{ARGS}} as a placeholder for user arguments." },
          category: { type: "string", description: "Skill category (for create): workflow, analysis, code, data, creative, ops" },
        },
        required: ["action"],
      },
    },
  },

  {
    type: "function",
    function: {
      name: "run_query",
      description:
        "Run a read-only SELECT query against the database. Tables: sessions, turns, agents, training_jobs, training_iterations, training_resources, eval_test_cases, eval_runs, eval_trials, credit_transactions, billing_records, skills, audit_log, marketplace_listings, feature_flags, agent_versions. See system prompt for column details. Always filter by org_id or agent_name.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "SQL SELECT query to run" },
        },
        required: ["query"],
      },
    },
  },
];

/* ── Tool execution ─────────────────────────────────────────────── */

async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: MetaChatContext,
): Promise<string> {
  return await withOrgDb({ HYPERDRIVE: ctx.hyperdrive }, ctx.orgId, async (sql) => {

  switch (name) {
    case "read_agent_config": {
      const rows = await sql`
        SELECT name, description, config, is_active, created_at, updated_at
        FROM agents WHERE name = ${ctx.agentName} AND org_id = ${ctx.orgId} LIMIT 1
      `;
      if (rows.length === 0) return JSON.stringify({ error: "Agent not found" });
      const row = rows[0] as Record<string, unknown>;
      const config =
        typeof row.config === "string"
          ? JSON.parse(row.config)
          : row.config ?? {};
      return JSON.stringify({
        name: row.name,
        description: row.description,
        is_active: row.is_active,
        created_at: row.created_at,
        updated_at: row.updated_at,
        system_prompt: config.system_prompt,
        personality: config.personality,
        model: config.model,
        plan: config.plan || "standard",
        routing: config.routing || null,
        temperature: config.temperature,
        max_tokens: config.max_tokens,
        tools: config.tools,
        blocked_tools: config.blocked_tools || [],
        allowed_domains: config.allowed_domains || [],
        blocked_domains: config.blocked_domains || [],
        tags: config.tags,
        max_turns: config.max_turns,
        timeout_seconds: config.timeout_seconds,
        reasoning_strategy: config.reasoning_strategy || "(auto)",
        parallel_tool_calls: config.parallel_tool_calls !== false,
        budget_limit_usd: config.governance?.budget_limit_usd ?? 10,
        version: config.version,
        governance: config.governance,
        guardrails: config.guardrails,
        eval_config: config.eval_config
          ? {
              test_case_count: Array.isArray(config.eval_config.test_cases)
                ? config.eval_config.test_cases.length
                : 0,
              pass_threshold: config.eval_config.pass_threshold,
            }
          : null,
        graph_id: null,
      });
    }

    case "update_agent_config": {
      const rows = await sql`
        SELECT config FROM agents
        WHERE name = ${ctx.agentName} AND org_id = ${ctx.orgId} LIMIT 1
      `;
      if (rows.length === 0) return JSON.stringify({ error: "Agent not found" });
      const config =
        typeof rows[0].config === "string"
          ? JSON.parse(rows[0].config as string)
          : (rows[0].config as Record<string, unknown>) ?? {};

      // Apply requested changes
      // Backwards compat: accept max_tokens as alias for max_tokens_per_turn
      if (args.max_tokens !== undefined && args.max_tokens_per_turn === undefined) {
        args.max_tokens_per_turn = args.max_tokens;
      }
      const updatable = [
        "system_prompt",
        "description",
        "personality",
        "model",
        "provider",
        "plan",
        "routing",
        "temperature",
        "max_tokens_per_turn",
        "tools",
        "blocked_tools",
        "allowed_domains",
        "blocked_domains",
        "tags",
        "max_turns",
        "timeout_seconds",
        "reasoning_strategy",
        "parallel_tool_calls",
        "require_human_approval",
        "use_code_mode",
      ] as const;
      const changed: string[] = [];
      for (const key of updatable) {
        if (args[key] !== undefined) {
          (config as any)[key] = args[key];
          changed.push(key);
        }
      }
      // Handle budget_limit_usd — nested under governance
      if (args.budget_limit_usd !== undefined) {
        const gov = (config.governance as any) ?? {};
        gov.budget_limit_usd = Number(args.budget_limit_usd);
        config.governance = gov;
        changed.push("budget_limit_usd");
      }
      if (args.governance && typeof args.governance === "object") {
        config.governance = { ...(config.governance as any ?? {}), ...(args.governance as any) };
        changed.push("governance");
      }

      // Bump version
      const oldVersion = String(config.version ?? "0.1.0");
      const parts = oldVersion.split(".").map(Number);
      parts[2] = (parts[2] ?? 0) + 1;
      const newVersion = parts.join(".");
      config.version = newVersion;

      await sql`
        UPDATE agents
        SET config = ${JSON.stringify(config)},
            description = ${String(config.description || "")},
            updated_at = now()
        WHERE name = ${ctx.agentName} AND org_id = ${ctx.orgId}
      `;

      // Snapshot version
      try {
        await sql`
          INSERT INTO agent_versions (agent_name, version, config, created_by, created_at)
          VALUES (${ctx.agentName}, ${newVersion}, ${JSON.stringify(config)}, ${"meta-agent"}, now())
          ON CONFLICT (agent_name, version) DO UPDATE
          SET config = ${JSON.stringify(config)}, created_by = ${"meta-agent"}
        `;
      } catch {}

      // Audit log the config change
      try {
        await sql`
          INSERT INTO audit_log (org_id, actor_id, action, resource_type, resource_name, details, created_at)
          VALUES (${ctx.orgId}, ${ctx.userId}, 'update_config', 'agent', ${ctx.agentName},
            ${JSON.stringify({ changed_fields: changed, new_version: newVersion, source: "meta-agent" })}, now())
        `;
      } catch {}

      // Notify runtime
      if (ctx.env.RUNTIME) {
        try {
          await ctx.env.RUNTIME.fetch(
            "https://runtime/api/v1/internal/config-invalidate",
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                ...(ctx.env.SERVICE_TOKEN
                  ? { Authorization: `Bearer ${ctx.env.SERVICE_TOKEN}` }
                  : {}),
              },
              body: JSON.stringify({
                agent_name: ctx.agentName,
                version: newVersion,
                timestamp: Date.now(),
              }),
            },
          );
        } catch {}
      }

      return JSON.stringify({
        updated: true,
        changed_fields: changed,
        new_version: newVersion,
      });
    }

    case "read_sessions": {
      const limit = Number(args.limit) || 20;
      const rows = await sql`
        SELECT session_id, model, status, step_count, action_count,
               input_text, output_text, cost_total_usd,
               wall_clock_seconds, created_at, ended_at
        FROM sessions
        WHERE agent_name = ${ctx.agentName} AND (org_id = ${ctx.orgId} OR org_id = '')
        ORDER BY created_at DESC
        LIMIT ${limit}
      `;
      return JSON.stringify({
        total: rows.length,
        sessions: rows.map((r: any) => ({
          session_id: r.session_id,
          model: r.model,
          status: r.status,
          step_count: r.step_count,
          tool_calls: r.action_count,
          input_preview: String(r.input_text || "").slice(0, 200),
          output_preview: String(r.output_text || "").slice(0, 200),
          cost_usd: r.cost_total_usd,
          latency_s: r.wall_clock_seconds,
          created_at: r.created_at,
          ended_at: r.ended_at,
        })),
      });
    }

    case "read_session_messages": {
      const sessionId = String(args.session_id || "");
      if (!sessionId) return JSON.stringify({ error: "session_id required" });
      const limit = Number(args.limit) || 50;
      const rows = await sql`
        SELECT t.turn_number, t.model_used, t.llm_content,
               t.tool_calls, t.tool_results, t.errors,
               t.cost_usd, t.latency_ms,
               t.input_tokens, t.output_tokens, t.execution_mode,
               t.created_at
        FROM turns t
        JOIN sessions s ON t.session_id = s.session_id
        WHERE t.session_id = ${sessionId} AND s.org_id = ${ctx.orgId}
        ORDER BY t.created_at ASC
        LIMIT ${limit}
      `;
      return JSON.stringify({
        session_id: sessionId,
        turn_count: rows.length,
        turns: rows.map((r: any) => {
          let toolCalls: any[] = [];
          let toolResults: any[] = [];
          let errors: any[] = [];
          toolCalls = parseJsonColumn(r.tool_calls, []);
          toolResults = parseJsonColumn(r.tool_results, []);
          errors = parseJsonColumn(r.errors, []);

          return {
            turn: r.turn_number,
            model: r.model_used,
            content: String(r.llm_content || "").slice(0, 1000),
            tool_calls: toolCalls.map((tc: any) => {
              let args: any = {};
              try { args = JSON.parse(tc.arguments || "{}"); } catch {}
              return {
                name: tc.name,
                arguments: args,
              };
            }),
            tool_results: toolResults.map((tr: any) => ({
              name: tr.name,
              result: String(tr.result || "").slice(0, 500),
              error: tr.error || null,
              latency_ms: tr.latency_ms,
              cost_usd: tr.cost_usd,
            })),
            errors,
            cost_usd: r.cost_usd,
            latency_ms: r.latency_ms,
            tokens: (r.input_tokens || 0) + (r.output_tokens || 0),
            created_at: r.created_at,
          };
        }),
      });
    }

    case "read_observability": {
      const period = String(args.period || "24h");
      const intervalMap: Record<string, string> = {
        "1h": "1 hour",
        "24h": "24 hours",
        "7d": "7 days",
        "30d": "30 days",
      };
      const interval = intervalMap[period] || "24 hours";

      // ── Core metrics with latency percentiles + cache + refusal stats ──
      let stats: any = {};
      try {
        const turnStats = await sql`
          SELECT
            COUNT(*) as total_turns,
            COUNT(DISTINCT t.session_id) as active_sessions,
            AVG(t.latency_ms) as avg_latency_ms,
            PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY t.latency_ms) as p50_latency_ms,
            PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY t.latency_ms) as p95_latency_ms,
            PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY t.latency_ms) as p99_latency_ms,
            AVG(COALESCE(t.llm_latency_ms, t.latency_ms)) as avg_llm_latency_ms,
            SUM(t.input_tokens) as total_input_tokens,
            SUM(t.output_tokens) as total_output_tokens,
            SUM(COALESCE(t.cache_read_tokens, 0)) as total_cache_read_tokens,
            SUM(COALESCE(t.cache_write_tokens, 0)) as total_cache_write_tokens,
            COUNT(*) FILTER (WHERE t.refusal = true) as refusal_count,
            COUNT(*) FILTER (WHERE t.errors IS NOT NULL AND t.errors != '[]') as error_turn_count
          FROM turns t
          JOIN sessions s ON t.session_id = s.session_id
          WHERE s.agent_name = ${ctx.agentName}
            AND s.org_id = ${ctx.orgId}
            AND t.created_at > now() - ${interval}::interval
        `;
        stats = turnStats[0] || {};
      } catch {}

      // ── Per-model breakdown ──
      let modelBreakdown: any[] = [];
      try {
        modelBreakdown = await sql`
          SELECT t.model_used as model, COUNT(*) as turn_count,
            SUM(t.input_tokens) as input_tokens, SUM(t.output_tokens) as output_tokens,
            SUM(t.cost_usd) as cost_usd, AVG(t.latency_ms) as avg_latency_ms
          FROM turns t JOIN sessions s ON t.session_id = s.session_id
          WHERE s.agent_name = ${ctx.agentName} AND s.org_id = ${ctx.orgId}
            AND t.created_at > now() - ${interval}::interval
          GROUP BY t.model_used ORDER BY turn_count DESC LIMIT 10
        `;
      } catch {}

      // ── Per-tool health (parsed from tool_results) ──
      let toolHealth: any[] = [];
      try {
        toolHealth = await sql`
          SELECT tool_name, COUNT(*) as call_count,
            COUNT(*) FILTER (WHERE error IS NOT NULL AND error != '') as error_count,
            ROUND(AVG(latency_ms)::numeric, 0) as avg_latency_ms,
            ROUND(COUNT(*) FILTER (WHERE error IS NOT NULL AND error != '')::numeric
              / NULLIF(COUNT(*), 0) * 100, 1) as error_rate_pct
          FROM (
            SELECT jsonb_array_elements(COALESCE(tool_results::jsonb, '[]'::jsonb))->>'name' as tool_name,
              (jsonb_array_elements(COALESCE(tool_results::jsonb, '[]'::jsonb))->>'latency_ms')::numeric as latency_ms,
              jsonb_array_elements(COALESCE(tool_results::jsonb, '[]'::jsonb))->>'error' as error
            FROM turns t JOIN sessions s ON t.session_id = s.session_id
            WHERE s.agent_name = ${ctx.agentName} AND s.org_id = ${ctx.orgId}
              AND t.created_at > now() - ${interval}::interval
              AND t.tool_results IS NOT NULL AND t.tool_results != '[]'
          ) tool_stats WHERE tool_name IS NOT NULL
          GROUP BY tool_name ORDER BY error_rate_pct DESC, call_count DESC LIMIT 20
        `;
      } catch {}

      // ── Session-level stats ──
      let sessionStats: any = {};
      try {
        const sRows = await sql`
          SELECT COUNT(*) as total_sessions,
            COUNT(*) FILTER (WHERE status = 'success') as success_count,
            COUNT(*) FILTER (WHERE status = 'error') as error_count,
            AVG(wall_clock_seconds) as avg_duration_s,
            AVG(step_count) as avg_steps, AVG(action_count) as avg_tool_calls,
            SUM(cost_total_usd) as total_cost_usd
          FROM sessions WHERE agent_name = ${ctx.agentName} AND org_id = ${ctx.orgId}
            AND created_at > now() - ${interval}::interval
        `;
        sessionStats = sRows[0] || {};
      } catch {}

      // ── Cost from billing (authoritative source) ──
      let billingCost = 0;
      try {
        const costRows = await sql`
          SELECT COALESCE(SUM(total_cost_usd), 0) as total_cost FROM billing_records
          WHERE agent_name = ${ctx.agentName} AND org_id = ${ctx.orgId}
            AND created_at > now() - ${interval}::interval
        `;
        billingCost = Number(costRows[0]?.total_cost) || 0;
      } catch {}

      // ── User feedback summary ──
      let feedbackStats: any = {};
      try {
        const fbRows = await sql`
          SELECT COUNT(*) as total_feedback, AVG(rating) as avg_rating,
            COUNT(*) FILTER (WHERE rating >= 4) as positive,
            COUNT(*) FILTER (WHERE rating <= 2) as negative
          FROM session_feedback sf JOIN sessions s ON sf.session_id = s.session_id
          WHERE s.agent_name = ${ctx.agentName} AND s.org_id = ${ctx.orgId}
            AND sf.created_at > now() - ${interval}::interval
        `;
        feedbackStats = fbRows[0] || {};
      } catch {}

      const totalTurns = Number(stats.total_turns) || 0;
      const cacheRead = Number(stats.total_cache_read_tokens) || 0;
      const totalInput = Number(stats.total_input_tokens) || 0;

      return JSON.stringify({
        period,
        total_turns: totalTurns,
        active_sessions: Number(stats.active_sessions) || 0,
        error_turn_count: Number(stats.error_turn_count) || 0,
        error_rate_pct: totalTurns > 0 ? Math.round(Number(stats.error_turn_count) / totalTurns * 1000) / 10 : 0,
        refusal_count: Number(stats.refusal_count) || 0,
        latency: {
          avg_ms: Math.round(Number(stats.avg_latency_ms) || 0),
          p50_ms: Math.round(Number(stats.p50_latency_ms) || 0),
          p95_ms: Math.round(Number(stats.p95_latency_ms) || 0),
          p99_ms: Math.round(Number(stats.p99_latency_ms) || 0),
          avg_llm_ms: Math.round(Number(stats.avg_llm_latency_ms) || 0),
        },
        tokens: {
          total_input: totalInput, total_output: Number(stats.total_output_tokens) || 0,
          cache_read: cacheRead, cache_write: Number(stats.total_cache_write_tokens) || 0,
          cache_hit_rate_pct: totalInput > 0 ? Math.round(cacheRead / totalInput * 1000) / 10 : 0,
        },
        cost: {
          total_usd: Math.round(billingCost * 10000) / 10000,
          from_sessions_usd: Math.round(Number(sessionStats.total_cost_usd) * 10000) / 10000,
        },
        sessions: {
          total: Number(sessionStats.total_sessions) || 0,
          success: Number(sessionStats.success_count) || 0,
          error: Number(sessionStats.error_count) || 0,
          success_rate_pct: Number(sessionStats.total_sessions) > 0
            ? Math.round(Number(sessionStats.success_count) / Number(sessionStats.total_sessions) * 1000) / 10 : 0,
          avg_duration_s: Math.round(Number(sessionStats.avg_duration_s) * 10) / 10 || 0,
          avg_steps: Math.round(Number(sessionStats.avg_steps) * 10) / 10 || 0,
          avg_tool_calls: Math.round(Number(sessionStats.avg_tool_calls) * 10) / 10 || 0,
        },
        by_model: modelBreakdown.map((r: any) => ({
          model: r.model, turns: Number(r.turn_count),
          input_tokens: Number(r.input_tokens), output_tokens: Number(r.output_tokens),
          cost_usd: Math.round(Number(r.cost_usd) * 10000) / 10000,
          avg_latency_ms: Math.round(Number(r.avg_latency_ms)),
        })),
        tool_health: toolHealth.map((r: any) => ({
          tool: r.tool_name, calls: Number(r.call_count), errors: Number(r.error_count),
          avg_latency_ms: Number(r.avg_latency_ms), error_rate_pct: Number(r.error_rate_pct),
        })),
        feedback: {
          total: Number(feedbackStats.total_feedback) || 0,
          avg_rating: feedbackStats.avg_rating ? Math.round(Number(feedbackStats.avg_rating) * 10) / 10 : null,
          positive: Number(feedbackStats.positive) || 0,
          negative: Number(feedbackStats.negative) || 0,
        },
      });
    }

    case "read_eval_results": {
      let evalRows: any[];
      if (args.run_id) {
        evalRows = await sql`
          SELECT * FROM eval_runs
          WHERE id = ${String(args.run_id)} AND org_id = ${ctx.orgId} LIMIT 1
        `;
      } else {
        evalRows = await sql`
          SELECT * FROM eval_runs
          WHERE agent_name = ${ctx.agentName} AND org_id = ${ctx.orgId}
          ORDER BY created_at DESC LIMIT 1
        `;
      }
      if (evalRows.length === 0) {
        return JSON.stringify({ error: "No eval runs found. Run tests first." });
      }
      const run = evalRows[0];

      // Get failure details
      let failures: any[] = [];
      try {
        const trials = await sql`
          SELECT input, expected, actual, reasoning, passed
          FROM eval_trials WHERE eval_run_id = ${run.id}
          ORDER BY created_at LIMIT 50
        `;
        failures = trials
          .filter((t: any) => !t.passed)
          .map((t: any) => ({
            input: String(t.input || "").slice(0, 200),
            expected: String(t.expected || "").slice(0, 200),
            actual: String(t.actual || "").slice(0, 200),
            reasoning: String(t.reasoning || "").slice(0, 200),
          }));
      } catch {}

      return JSON.stringify({
        run_id: run.id,
        pass_rate: run.pass_rate,
        total_tasks: run.total_tasks,
        avg_latency_ms: run.avg_latency_ms,
        total_cost_usd: run.total_cost_usd,
        created_at: run.created_at,
        failures,
      });
    }

    case "analyze_and_suggest": {
      // Load config
      const configRows = await sql`
        SELECT config FROM agents
        WHERE name = ${ctx.agentName} AND org_id = ${ctx.orgId} LIMIT 1
      `;
      if (configRows.length === 0) return JSON.stringify({ error: "Agent not found" });
      const config =
        typeof configRows[0].config === "string"
          ? JSON.parse(configRows[0].config as string)
          : (configRows[0].config as Record<string, unknown>) ?? {};

      // Load latest eval run
      const evalRows = await sql`
        SELECT * FROM eval_runs
        WHERE agent_name = ${ctx.agentName} AND org_id = ${ctx.orgId}
        ORDER BY created_at DESC LIMIT 1
      `;
      if (evalRows.length === 0) {
        return JSON.stringify({
          suggestions: [
            {
              area: "test_cases",
              severity: "high",
              suggestion: "No eval runs found. Run the test suite first.",
              auto_applicable: false,
            },
          ],
        });
      }

      const evalRun = evalRows[0];
      let failures: any[] = [];
      try {
        const trials = await sql`
          SELECT input, expected, actual, reasoning FROM eval_trials
          WHERE eval_run_id = ${evalRun.id} AND passed = false
          ORDER BY created_at
        `;
        failures = trials.map((t: any) => ({
          input: String(t.input || ""),
          expected: String(t.expected || ""),
          actual: String(t.actual || ""),
          reasoning: String(t.reasoning || ""),
        }));
      } catch {}

      const suggestions = await generateEvolutionSuggestions(
        ctx.agentName,
        config,
        {
          pass_rate: Number(evalRun.pass_rate) || 0,
          failures,
          avg_latency_ms: Number(evalRun.avg_latency_ms) || undefined,
          total_cost_usd: Number(evalRun.total_cost_usd) || undefined,
        },
        { openrouterApiKey: ctx.openrouterApiKey },
      );

      // Auto-apply if requested
      let appliedCount = 0;
      if (args.auto_apply_safe) {
        for (const sug of suggestions) {
          if (!sug.auto_applicable || !sug.patch) continue;
          try {
            if (sug.area === "prompt" && sug.patch.system_prompt_append) {
              config.system_prompt =
                String(config.system_prompt || "") +
                "\n\n" +
                String(sug.patch.system_prompt_append);
              appliedCount++;
            }
            if (sug.area === "tools" && Array.isArray(sug.patch.add_tools)) {
              const current = new Set(
                Array.isArray(config.tools) ? config.tools : [],
              );
              for (const t of sug.patch.add_tools) current.add(String(t));
              config.tools = [...current];
              appliedCount++;
            }
          } catch {}
        }

        if (appliedCount > 0) {
          const oldVer = String(config.version ?? "0.1.0");
          const p = oldVer.split(".").map(Number);
          p[2] = (p[2] ?? 0) + 1;
          config.version = p.join(".");

          await sql`
            UPDATE agents SET config = ${JSON.stringify(config)}, updated_at = now()
            WHERE name = ${ctx.agentName} AND org_id = ${ctx.orgId}
          `;
        }
      }

      return JSON.stringify({
        suggestions: suggestions.map((s) => ({
          area: s.area,
          severity: s.severity,
          suggestion: s.suggestion,
          auto_applicable: s.auto_applicable,
          was_applied: args.auto_apply_safe && s.auto_applicable,
        })),
        auto_applied: appliedCount,
      });
    }

    case "read_conversation_quality": {
      const period = String(args.period || "7d");
      const intervalMap: Record<string, string> = {
        "24h": "24 hours",
        "7d": "7 days",
        "30d": "30 days",
      };
      const interval = intervalMap[period] || "7 days";

      // Session-level quality metrics
      let sessionStats: any = {};
      try {
        const rows = await sql`
          SELECT
            COUNT(*) as total_sessions,
            COUNT(*) FILTER (WHERE status = 'success') as successful,
            COUNT(*) FILTER (WHERE status = 'error') as errored,
            AVG(step_count) as avg_turns,
            AVG(cost_total_usd) as avg_cost_usd,
            AVG(wall_clock_seconds) as avg_duration_s,
            PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY wall_clock_seconds) as median_duration_s
          FROM sessions
          WHERE agent_name = ${ctx.agentName}
            AND org_id = ${ctx.orgId}
            AND created_at > now() - ${interval}::interval
        `;
        sessionStats = rows[0] || {};
      } catch {}

      // Tool error frequency — which tools fail most?
      let toolErrors: any[] = [];
      try {
        const errRows = await sql`
          SELECT t.errors FROM turns t
          JOIN sessions s ON t.session_id = s.session_id
          WHERE s.agent_name = ${ctx.agentName}
            AND s.org_id = ${ctx.orgId}
            AND t.created_at > now() - ${interval}::interval
            AND t.errors IS NOT NULL AND t.errors != '[]'
          LIMIT 100
        `;
        const errorCounts: Record<string, number> = {};
        for (const row of errRows as any[]) {
          const errors = parseJsonColumn(row.errors, []);
          for (const err of errors) {
            const toolName = String(err).split(":")[0] || "unknown";
            errorCounts[toolName] = (errorCounts[toolName] || 0) + 1;
          }
        }
        toolErrors = Object.entries(errorCounts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10)
          .map(([tool, count]) => ({ tool, error_count: count }));
      } catch {}

      // Recent user input samples for topic analysis
      let recentTopics: string[] = [];
      try {
        const inputRows = await sql`
          SELECT input_text FROM sessions
          WHERE agent_name = ${ctx.agentName}
            AND org_id = ${ctx.orgId}
            AND created_at > now() - ${interval}::interval
          ORDER BY created_at DESC LIMIT 20
        `;
        recentTopics = inputRows
          .map((r: any) => String(r.input_text || "").slice(0, 150))
          .filter(Boolean);
      } catch {}

      const totalSessions = Number(sessionStats.total_sessions) || 0;
      const successRate = totalSessions > 0
        ? Math.round((Number(sessionStats.successful || 0) / totalSessions) * 100)
        : null;

      return JSON.stringify({
        period,
        total_sessions: totalSessions,
        success_rate_pct: successRate,
        error_count: Number(sessionStats.errored) || 0,
        avg_turns_per_session: Math.round(Number(sessionStats.avg_turns) || 0),
        avg_cost_per_session_usd: Math.round((Number(sessionStats.avg_cost_usd) || 0) * 10000) / 10000,
        avg_duration_seconds: Math.round(Number(sessionStats.avg_duration_s) || 0),
        median_duration_seconds: Math.round(Number(sessionStats.median_duration_s) || 0),
        top_tool_errors: toolErrors,
        recent_user_topics: recentTopics.slice(0, 10),
        quality_assessment: successRate === null ? "No sessions in period"
          : successRate >= 90 ? "Healthy — high success rate"
          : successRate >= 70 ? "Moderate — some failures need attention"
          : "Poor — significant error rate, investigate tool errors and session diagnostics",
      });
    }

    // ── Training System Tool Execution ──────────────────────────
    case "start_training": {
      // Check concurrent training job limit (max 3 per org)
      try {
        const [activeJobs] = await sql`
          SELECT count(*)::int as c FROM training_jobs
          WHERE org_id = ${ctx.orgId} AND status IN ('pending', 'running')
        `;
        if (Number(activeJobs.c) >= 3) {
          return JSON.stringify({
            error: "Training limit reached: max 3 concurrent training jobs per organization. Wait for existing jobs to complete or cancel them.",
            active_jobs: Number(activeJobs.c),
          });
        }
      } catch { /* fail open — allow if check fails */ }

      const algorithm = String(args.algorithm || "apo");
      const maxIterations = Number(args.max_iterations) || 10;
      const autoActivate = args.auto_activate === true;
      // Create training job directly via SQL (training routes are on the control-plane, same process)
      try {
        const jobId = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
        const now = new Date().toISOString();

        // Load optimization eval test cases (exclude holdout) from eval_test_cases table
        let evalTasks: Array<{ input: string; expected: string; grader: string }> = [];
        let holdoutCount = 0;
        let totalCaseCount = 0;
        try {
          const testRows = await sql`
            SELECT input, expected_output, grader, is_holdout FROM eval_test_cases
            WHERE agent_name = ${ctx.agentName} AND org_id = ${ctx.orgId}
            ORDER BY created_at DESC LIMIT 50
          `;
          totalCaseCount = testRows.length;
          holdoutCount = testRows.filter((r: any) => r.is_holdout).length;
          const optimizationRows = testRows.filter((r: any) => !r.is_holdout);
          if (optimizationRows.length > 0) {
            evalTasks = optimizationRows.map((r: any) => ({
              input: String(r.input || ""),
              expected: String(r.expected_output || ""),
              grader: String(r.grader || "contains"),
            }));
          }
        } catch {}

        // Fallback: generate basic test tasks if none exist
        if (evalTasks.length === 0) {
          evalTasks = [
            { input: "Hello, how can you help me?", expected: "", grader: "non_empty" },
            { input: "What tools do you have?", expected: "", grader: "non_empty" },
          ];
        }

        await sql`
          INSERT INTO training_jobs (id, agent_name, org_id, algorithm, max_iterations, auto_activate,
            status, current_iteration, best_score, eval_tasks, created_at)
          VALUES (${jobId}, ${ctx.agentName}, ${ctx.orgId}, ${algorithm}, ${maxIterations}, ${autoActivate},
            'created', 0, NULL, ${JSON.stringify(evalTasks)}, ${now})
        `;

        // Snapshot current system prompt as initial resource
        try {
          const agentRows = await sql`SELECT config FROM agents WHERE name = ${ctx.agentName} AND org_id = ${ctx.orgId}`;
          if (agentRows.length > 0) {
            const config = parseJsonColumn(agentRows[0].config);
            const prompt = String(config.system_prompt ?? "");
            if (prompt) {
              const resId = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
              await sql`
                INSERT INTO training_resources (resource_id, job_id, org_id, agent_name, resource_type, resource_key, version, content_text, source, is_active, created_at)
                VALUES (${resId}, ${jobId}, ${ctx.orgId}, ${ctx.agentName}, 'system_prompt', 'main', 0, ${prompt}, 'initial', true, ${now})
              `;
            }
          }
        } catch {}

        // Enqueue the first training step — MUST include org_id for queue consumer auth
        if (ctx.env.JOB_QUEUE) {
          try {
            await (ctx.env.JOB_QUEUE as any).send({
              type: "training_step",
              payload: { job_id: jobId, org_id: ctx.orgId },
            });
            await sql`UPDATE 0 = ${jobId}`;
          } catch (err) {
            console.error("[meta-agent] Failed to enqueue training step:", err);
          }
        }

        return JSON.stringify({
          job_id: jobId,
          status: "running",
          algorithm,
          max_iterations: maxIterations,
          auto_activate: autoActivate,
          eval_task_count: evalTasks.length,
          holdout_count: holdoutCount,
          total_cases: totalCaseCount,
          message: `Training job started with ${evalTasks.length} optimization eval tasks (${holdoutCount} holdout cases reserved for final validation). Use read_training_status to monitor progress. After training, run_eval with include_holdout=true to validate against holdout set.`,
        });
      } catch (err: any) {
        return JSON.stringify({ error: `Training not available: ${err.message || err}` });
      }
    }

    case "read_training_status": {
      try {
        let jobRows: any[];
        if (args.job_id) {
          jobRows = await sql`
            SELECT * FROM training_jobs
            WHERE id = ${String(args.job_id)} AND org_id = ${ctx.orgId} LIMIT 1
          `;
        } else {
          jobRows = await sql`
            SELECT * FROM training_jobs
            WHERE agent_name = ${ctx.agentName} AND org_id = ${ctx.orgId}
            ORDER BY created_at DESC LIMIT 1
          `;
        }
        if (jobRows.length === 0) {
          return JSON.stringify({ status: "no_training_jobs", message: "No training jobs found for this agent. Use start_training to begin." });
        }
        const job = jobRows[0] as any;
        const result: any = {
          job_id: job.job_id,
          status: job.status,
          algorithm: job.algorithm,
          current_iteration: job.current_iteration,
          max_iterations: job.max_iterations,
          best_score: job.best_score,
          auto_activate: job.auto_activate,
          created_at: job.created_at,
          completed_at: job.completed_at,
        };

        if (args.include_iterations) {
          const iterations = await sql`
            SELECT iteration_number, pass_rate, reward_score, algorithm_output, started_at, completed_at
            FROM training_iterations
            WHERE id = ${job.job_id}
            ORDER BY iteration_number
          `;
          result.iterations = iterations.map((it: any) => ({
            iteration: it.iteration_number,
            pass_rate: it.pass_rate,
            reward_score: it.reward_score,
            algorithm_output: parseJsonColumn(it.algorithm_output),
            started_at: it.started_at,
            completed_at: it.completed_at,
          }));
        }
        return JSON.stringify(result);
      } catch (err: any) {
        return JSON.stringify({ error: `Failed to read training status: ${err.message || err}` });
      }
    }

    case "activate_trained_config": {
      const resourceId = String(args.resource_id || "");
      if (!resourceId) return JSON.stringify({ error: "resource_id is required" });
      try {
        // Read the trained resource
        const resRows = await sql`
          SELECT * FROM training_resources
          WHERE resource_id = ${resourceId} AND agent_name = ${ctx.agentName} AND org_id = ${ctx.orgId} LIMIT 1
        `;
        if (resRows.length === 0) return JSON.stringify({ error: "Training resource not found" });
        const resource = resRows[0] as any;
        // content_text holds prompt content; content holds structured configs
        const rawContent = resource.content_text || resource.content;
        const trainedConfig = typeof rawContent === "string" ? (() => { try { return JSON.parse(rawContent); } catch { return { system_prompt: rawContent }; } })() : (rawContent || {});

        // Read current config for rollback storage
        const currentRows = await sql`
          SELECT config FROM agents WHERE name = ${ctx.agentName} AND org_id = ${ctx.orgId} LIMIT 1
        `;
        const currentConfig = currentRows.length > 0
          ? (typeof currentRows[0].config === "string" ? JSON.parse(currentRows[0].config as string) : currentRows[0].config)
          : {};

        // Apply trained config
        const merged = { ...currentConfig, ...trainedConfig };
        const oldVer = String(merged.version ?? "0.1.0");
        const verParts = oldVer.split(".").map(Number);
        verParts[1] = (verParts[1] ?? 0) + 1;
        verParts[2] = 0;
        merged.version = verParts.join(".");

        await sql`
          UPDATE agents SET config = ${JSON.stringify(merged)}, updated_at = now()
          WHERE name = ${ctx.agentName} AND org_id = ${ctx.orgId}
        `;

        // Mark resource as active
        await sql`
          UPDATE training_resources SET is_active = true
          WHERE resource_id = ${resourceId}
        `;

        // Store rollback point
        await sql`
          INSERT INTO training_resources (resource_id, agent_name, org_id, resource_type, resource_key, version, content_text, job_id, source, is_active, created_at)
          VALUES (${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}, ${ctx.agentName}, ${ctx.orgId}, 'rollback_snapshot', 'main', 0, ${JSON.stringify(currentConfig)}, ${resource.job_id || ''}, 'rollback', false, now())
        `.catch(() => {});

        return JSON.stringify({
          activated: true,
          resource_id: resourceId,
          new_version: merged.version,
          changes: Object.keys(trainedConfig),
          circuit_breaker: "armed — auto-rollback if error rate > 30% within 15 minutes",
        });
      } catch (err: any) {
        return JSON.stringify({ error: `Failed to activate: ${err.message || err}` });
      }
    }

    case "rollback_training": {
      try {
        // Find the currently active resource, then find the previous version
        const activeRows = await sql`
          SELECT resource_id, agent_name, org_id, resource_type, resource_key, version
          FROM training_resources
          WHERE agent_name = ${ctx.agentName} AND org_id = ${ctx.orgId} AND is_active = true
          ORDER BY created_at DESC LIMIT 1
        `;
        let rollbackRows: any[];
        if (activeRows.length > 0) {
          const active = activeRows[0] as any;
          rollbackRows = await sql`
            SELECT content_text, content, version FROM training_resources
            WHERE agent_name = ${ctx.agentName} AND org_id = ${ctx.orgId}
              AND resource_type = ${active.resource_type} AND resource_key = ${active.resource_key}
              AND version < ${active.version}
            ORDER BY version DESC LIMIT 1
          `;
        } else {
          // Fallback: look for rollback_snapshot resources
          rollbackRows = await sql`
            SELECT content_text, content FROM training_resources
            WHERE agent_name = ${ctx.agentName} AND org_id = ${ctx.orgId} AND resource_type = 'rollback_snapshot'
            ORDER BY created_at DESC LIMIT 1
          `;
        }
        if (rollbackRows.length === 0) {
          return JSON.stringify({ error: "No rollback snapshot found. No training activation has been done for this agent." });
        }
        const rawContent = rollbackRows[0].content_text || rollbackRows[0].content;
        const previousConfig = typeof rawContent === "string"
          ? (() => { try { return JSON.parse(rawContent); } catch { return { system_prompt: rawContent }; } })()
          : (rawContent || {});

        await sql`
          UPDATE agents SET config = ${JSON.stringify(previousConfig)}, updated_at = now()
          WHERE name = ${ctx.agentName} AND org_id = ${ctx.orgId}
        `;

        return JSON.stringify({
          rolled_back: true,
          message: "Reverted to configuration before the last training activation.",
          version: previousConfig.version || "unknown",
        });
      } catch (err: any) {
        return JSON.stringify({ error: `Rollback failed: ${err.message || err}` });
      }
    }

    case "read_training_circuit_breaker": {
      try {
        // Check for recent activations and error rates
        const recentActivation = await sql`
          SELECT created_at FROM training_resources
          WHERE agent_name = ${ctx.agentName} AND org_id = ${ctx.orgId} AND is_active = true
          ORDER BY created_at DESC LIMIT 1
        `;

        if (recentActivation.length === 0) {
          return JSON.stringify({ armed: false, message: "No active training resource. Circuit breaker not armed." });
        }

        const activatedAt = recentActivation[0].created_at;
        const msSinceActivation = Date.now() - new Date(String(activatedAt)).getTime();
        const inWindow = msSinceActivation < 15 * 60 * 1000; // 15 min window

        // Count errors since activation
        let errorRate = 0;
        let totalSessions = 0;
        if (inWindow) {
          try {
            const stats = await sql`
              SELECT COUNT(*) as total,
                     COUNT(*) FILTER (WHERE status = 'error') as errors
              FROM sessions
              WHERE agent_name = ${ctx.agentName} AND org_id = ${ctx.orgId}
                AND created_at > ${String(activatedAt)}
            `;
            totalSessions = Number(stats[0]?.total) || 0;
            const errorCount = Number(stats[0]?.errors) || 0;
            errorRate = totalSessions > 0 ? Math.round((errorCount / totalSessions) * 100) : 0;
          } catch {}
        }

        return JSON.stringify({
          armed: inWindow,
          activated_at: activatedAt,
          minutes_since_activation: Math.round(msSinceActivation / 60000),
          monitoring_window: "15 minutes",
          sessions_since_activation: totalSessions,
          error_rate_pct: errorRate,
          rollback_threshold_pct: 30,
          would_rollback: errorRate > 30 && inWindow,
        });
      } catch (err: any) {
        return JSON.stringify({ error: `Circuit breaker check failed: ${err.message || err}` });
      }
    }

    // ── Marketplace Tool Execution ───────────────────────────────
    case "marketplace_publish": {
      if (ctx.userRole !== "owner" && ctx.userRole !== "admin") {
        return JSON.stringify({ error: "Permission denied: only org owners and admins can publish to the marketplace." });
      }
      const displayName = String(args.display_name || ctx.agentName);
      const shortDesc = String(args.short_description || "").slice(0, 200);
      const category = String(args.category || "other");
      const tags = Array.isArray(args.tags) ? args.tags.map(String) : [];
      const pricePerTask = Number(args.price_per_task_usd ?? 0);

      try {
        const listingId = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
        const baseUrl = "https://api.oneshots.co";
        await sql`
          INSERT INTO marketplace_listings (
            id, agent_name, org_id, display_name, short_description, category, tags,
            price_per_task_usd, quality_score, total_tasks_completed, avg_rating, total_ratings,
            is_verified, is_featured, is_published, a2a_endpoint_url, agent_card_url, created_at, updated_at
          ) VALUES (
            ${listingId}, ${ctx.agentName}, ${ctx.orgId}, ${displayName}, ${shortDesc}, ${category}, ${tags},
            ${pricePerTask}, 0.5, 0, 0, 0,
            false, false, true, ${baseUrl + "/a2a"}, ${baseUrl + "/.well-known/agent.json"}, now(), now()
          )
          ON CONFLICT (agent_name, org_id) DO UPDATE SET
            display_name = ${displayName}, short_description = ${shortDesc}, category = ${category},
            tags = ${tags}, price_per_task_usd = ${pricePerTask}, is_published = true, updated_at = now()
        `;

        // Also set pricing in agent config so x-402 works
        if (pricePerTask > 0) {
          await sql`
            UPDATE agents SET config = jsonb_set(
              COALESCE(config::jsonb, '{}'::jsonb),
              '{pricing}',
              ${JSON.stringify({ price_per_task_usd: pricePerTask, requires_payment: true })}::jsonb
            ), updated_at = now()
            WHERE name = ${ctx.agentName} AND org_id = ${ctx.orgId}
          `.catch(() => {});
        }

        return JSON.stringify({
          published: true,
          listing_id: listingId,
          display_name: displayName,
          category,
          price_per_task_usd: pricePerTask,
          message: "Agent is now live on the marketplace. Other agents can discover it via search.",
        });
      } catch (err: any) {
        return JSON.stringify({ error: `Publish failed: ${err.message || err}` });
      }
    }

    case "marketplace_stats": {
      try {
        const rows = await sql`
          SELECT id, display_name, category, price_per_task_usd, quality_score,
                 total_tasks_completed, total_tasks_failed, avg_rating, total_ratings,
                 is_verified, is_featured, is_published, created_at
          FROM marketplace_listings
          WHERE agent_name = ${ctx.agentName} AND org_id = ${ctx.orgId}
          LIMIT 1
        `;
        if (rows.length === 0) {
          return JSON.stringify({ published: false, message: "This agent is not published on the marketplace. Use marketplace_publish to list it." });
        }
        const listing = rows[0] as any;

        // Get earnings from credit_transactions
        let totalEarnings = 0;
        try {
          const [earn] = await sql`
            SELECT COALESCE(SUM(amount_cents), 0) / 100.0 as total
            FROM credit_transactions
            WHERE org_id = ${ctx.orgId} AND type = 'transfer_in'
          `;
          totalEarnings = Number(earn?.total || 0);
        } catch {}

        return JSON.stringify({
          published: listing.is_published,
          listing_id: listing.id,
          display_name: listing.display_name,
          category: listing.category,
          price_per_task_usd: Number(listing.price_per_task_usd),
          quality_score: Number(listing.quality_score),
          total_tasks_completed: Number(listing.total_tasks_completed),
          total_tasks_failed: Number(listing.total_tasks_failed || 0),
          avg_rating: Number(listing.avg_rating),
          total_ratings: Number(listing.total_ratings),
          is_verified: listing.is_verified,
          is_featured: listing.is_featured,
          total_earnings_usd: Math.round(totalEarnings * 10000) / 10000,
          created_at: listing.created_at,
        });
      } catch (err: any) {
        return JSON.stringify({ error: `Stats failed: ${err.message || err}` });
      }
    }

    case "add_eval_test_cases": {
      const testCases = args.test_cases || [];
      if (!Array.isArray(testCases) || testCases.length === 0) {
        return JSON.stringify({ error: "test_cases array is required" });
      }
      try {
        // Read current eval config from agent
        const agentRows = await sql`SELECT config FROM agents WHERE name = ${ctx.agentName} AND org_id = ${ctx.orgId}`;
        if (!agentRows.length) return JSON.stringify({ error: `Agent '${ctx.agentName}' not found` });
        const agent = agentRows[0];
        const config = typeof agent.config === "string" ? JSON.parse(agent.config) : agent.config || {};
        const evalConfig = config.eval_config || { test_cases: [], rubric: { criteria: [], pass_threshold: 0.7 }, scenarios: [] };

        // Add new test cases to config and DB table
        const existing = evalConfig.test_cases || [];
        let holdoutCount = 0;
        for (const tc of testCases) {
          const isHoldout = tc.is_holdout !== undefined ? Boolean(tc.is_holdout) : Math.random() < 0.2;
          const category = String(tc.category || "general");
          const tags = Array.isArray(tc.tags) ? tc.tags : [];
          if (isHoldout) holdoutCount++;

          existing.push({
            name: tc.name,
            input: tc.input,
            expected: tc.expected,
            grader: "llm_rubric",
            rubric: tc.rubric || `Score 1 if the response addresses "${tc.expected}". Score 0 otherwise.`,
            tags,
            category,
            is_holdout: isHoldout,
          });

          // Also insert into eval_test_cases table
          try {
            await sql`
              INSERT INTO eval_test_cases (org_id, agent_name, name, input, expected_output, grader, rubric, tags, category, is_holdout, source)
              VALUES (${ctx.orgId}, ${ctx.agentName}, ${tc.name}, ${tc.input}, ${tc.expected},
                ${"llm_rubric"}, ${tc.rubric || `Score 1 if the response addresses "${tc.expected}". Score 0 otherwise.`},
                ${JSON.stringify(tags)}, ${category}, ${isHoldout}, ${"manual"})
            `;
          } catch {}
        }
        evalConfig.test_cases = existing;
        config.eval_config = evalConfig;

        await sql`UPDATE agents SET config = ${JSON.stringify(config)}, updated_at = now() WHERE name = ${ctx.agentName} AND org_id = ${ctx.orgId}`;

        return JSON.stringify({
          added: testCases.length,
          total_test_cases: existing.length,
          holdout_count: holdoutCount,
          optimization_count: testCases.length - holdoutCount,
          test_names: testCases.map((tc: any) => tc.name),
        });
      } catch (err: any) {
        return JSON.stringify({ error: `Failed to add test cases: ${err.message || err}` });
      }
    }

    case "test_agent": {
      const message = args.message || "";
      if (!message) return JSON.stringify({ error: "message is required" });
      try {
        // Call the runtime to execute a test message
        if (!ctx.env.RUNTIME) return JSON.stringify({ error: "Runtime not available for testing" });

        const resp = await ctx.env.RUNTIME.fetch("https://runtime/run", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(ctx.env.SERVICE_TOKEN ? { Authorization: `Bearer ${ctx.env.SERVICE_TOKEN}` } : {}),
          },
          body: JSON.stringify({
            agent_name: ctx.agentName,
            input: message,
            org_id: ctx.orgId,
            channel: "meta-agent-test",
          }),
        });

        if (!resp.ok) {
          const errText = await resp.text().catch(() => "Runtime error");
          return JSON.stringify({ error: `Test run failed: ${errText}` });
        }

        const result = (await resp.json()) as any;
        return JSON.stringify({
          output: (result.output || "").slice(0, 3000),
          turns: result.turns || 0,
          tool_calls: result.tool_calls || 0,
          cost_usd: result.cost_usd || 0,
          model: result.model || "",
          session_id: result.session_id || "",
          success: result.success !== false,
        });
      } catch (err: any) {
        return JSON.stringify({ error: `Test failed: ${err.message || err}` });
      }
    }

    // ── Run Eval Suite ──────────────────────────────────────────────
    case "run_eval": {
      try {
        const includeHoldout = args.include_holdout === true;
        // Load test cases from DB with holdout info
        let testCases: Array<{ id?: string; name: string; input: string; expected: string; grader: string; rubric?: string; is_holdout: boolean }> = [];
        try {
          const rows = await sql`
            SELECT id, name, input, expected_output, grader, rubric, is_holdout FROM eval_test_cases
            WHERE agent_name = ${ctx.agentName} AND org_id = ${ctx.orgId}
            ORDER BY created_at DESC LIMIT 50
          `;
          testCases = rows.map((r: any) => ({
            id: r.id,
            name: r.name || `test_${rows.indexOf(r)}`,
            input: String(r.input || ""),
            expected: String(r.expected_output || ""),
            grader: String(r.grader || "contains"),
            rubric: r.rubric,
            is_holdout: Boolean(r.is_holdout),
          }));
        } catch {}

        // Also load from config eval_config
        if (testCases.length === 0) {
          try {
            const agentRows = await sql`SELECT config FROM agents WHERE name = ${ctx.agentName} AND org_id = ${ctx.orgId}`;
            if (agentRows.length > 0) {
              const config = typeof agentRows[0].config === "string" ? JSON.parse(agentRows[0].config as string) : agentRows[0].config || {};
              const evalCases = config.eval_config?.test_cases || [];
              testCases = evalCases.map((tc: any) => ({
                name: tc.name || "unnamed",
                input: String(tc.input || ""),
                expected: String(tc.expected || ""),
                grader: String(tc.grader || "llm_rubric"),
                rubric: tc.rubric,
                is_holdout: Boolean(tc.is_holdout),
              }));
            }
          } catch {}
        }

        if (testCases.length === 0) {
          return JSON.stringify({ error: "No eval test cases found. Use add_eval_test_cases to create some first." });
        }

        // Split into optimization and holdout sets
        const optimizationCases = testCases.filter(tc => !tc.is_holdout);
        const holdoutCases = testCases.filter(tc => tc.is_holdout);
        const casesToRun = includeHoldout ? testCases : optimizationCases;

        const maxCases = Number(args.max_cases) || casesToRun.length;
        const casesSliced = casesToRun.slice(0, maxCases);

        if (!ctx.env.RUNTIME) {
          return JSON.stringify({ error: "Runtime not available for eval execution" });
        }

        // Run each test case
        const results: Array<{ id?: string; name: string; input: string; passed: boolean; actual: string; expected: string; cost_usd: number; latency_ms: number; is_holdout: boolean; error?: string }> = [];
        let totalCost = 0;
        const evalStart = Date.now();

        for (const tc of casesSliced) {
          const tcStart = Date.now();
          try {
            const resp = await ctx.env.RUNTIME.fetch("https://runtime/run", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                ...(ctx.env.SERVICE_TOKEN ? { Authorization: `Bearer ${ctx.env.SERVICE_TOKEN}` } : {}),
              },
              body: JSON.stringify({
                agent_name: ctx.agentName,
                input: tc.input,
                org_id: ctx.orgId,
                channel: "eval",
              }),
            });
            const result = resp.ok ? await resp.json() as any : { output: "", cost_usd: 0 };
            const actual = String(result.output || "").slice(0, 1000);
            const cost = Number(result.cost_usd || 0);
            totalCost += cost;

            // Simple grading
            let passed = false;
            if (tc.grader === "non_empty") {
              passed = actual.length > 0;
            } else if (tc.grader === "contains") {
              passed = tc.expected ? actual.toLowerCase().includes(tc.expected.toLowerCase()) : actual.length > 0;
            } else {
              // Default: non-empty response counts as pass for now
              passed = actual.length > 10;
            }

            results.push({
              id: tc.id, name: tc.name, input: tc.input.slice(0, 200), passed, actual: actual.slice(0, 500),
              expected: tc.expected.slice(0, 200), cost_usd: cost, latency_ms: Date.now() - tcStart, is_holdout: tc.is_holdout,
            });
          } catch (err: any) {
            results.push({
              id: tc.id, name: tc.name, input: tc.input.slice(0, 200), passed: false, actual: "",
              expected: tc.expected.slice(0, 200), cost_usd: 0, latency_ms: Date.now() - tcStart, is_holdout: tc.is_holdout,
              error: err.message || String(err),
            });
          }
        }

        // Update pass_count / fail_count on each test case in the DB
        for (const r of results) {
          if (r.id) {
            try {
              if (r.passed) {
                await sql`UPDATE eval_test_cases SET pass_count = pass_count + 1, saturated = CASE WHEN pass_count + 1 > 10 THEN true ELSE saturated END WHERE id = ${r.id}`;
              } else {
                await sql`UPDATE eval_test_cases SET fail_count = fail_count + 1 WHERE id = ${r.id}`;
              }
            } catch {}
          }
        }

        // Calculate scores separately for optimization and holdout
        const optResults = results.filter(r => !r.is_holdout);
        const holdResults = results.filter(r => r.is_holdout);
        const optPassCount = optResults.filter(r => r.passed).length;
        const holdPassCount = holdResults.filter(r => r.passed).length;
        const optScore = optResults.length > 0 ? Math.round((optPassCount / optResults.length) * 100) : null;
        const holdScore = holdResults.length > 0 ? Math.round((holdPassCount / holdResults.length) * 100) : null;

        const totalPassCount = results.filter(r => r.passed).length;
        const overallPassRate = Math.round((totalPassCount / results.length) * 100);

        // Overfitting warning
        let overfitWarning: string | undefined;
        if (optScore !== null && holdScore !== null && optScore - holdScore > 15) {
          overfitWarning = `Warning: optimization score (${optScore}%) is significantly higher than holdout score (${holdScore}%). This may indicate overfitting to the optimization set.`;
        }

        // Write eval run record
        const runId = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
        try {
          await sql`
            INSERT INTO eval_runs (id, agent_name, org_id, pass_rate, total_tasks, avg_latency_ms, total_cost_usd, created_at)
            VALUES (${runId}, ${ctx.agentName}, ${ctx.orgId}, ${overallPassRate / 100}, ${results.length},
              ${Math.round(results.reduce((s, r) => s + r.latency_ms, 0) / results.length)},
              ${totalCost}, now())
          `;
        } catch {}

        return JSON.stringify({
          eval_run_id: runId,
          pass_rate_pct: overallPassRate,
          optimization_score: optScore !== null ? `${optScore}%` : "no optimization cases",
          holdout_score: holdScore !== null ? `${holdScore}%` : (includeHoldout ? "no holdout cases" : "not included (set include_holdout=true)"),
          overfit_warning: overfitWarning,
          passed: totalPassCount,
          failed: results.length - totalPassCount,
          total: results.length,
          optimization_cases: optResults.length,
          holdout_cases: holdResults.length,
          total_cost_usd: Math.round(totalCost * 10000) / 10000,
          total_latency_ms: Date.now() - evalStart,
          results: results.map(r => ({
            name: r.name,
            passed: r.passed,
            is_holdout: r.is_holdout,
            actual_preview: r.actual.slice(0, 200),
            expected: r.expected,
            cost_usd: r.cost_usd,
            latency_ms: r.latency_ms,
            error: r.error,
          })),
          failures: results.filter(r => !r.passed).map(r => ({
            name: r.name,
            input: r.input,
            expected: r.expected,
            actual: r.actual.slice(0, 300),
            is_holdout: r.is_holdout,
            error: r.error,
          })),
        });
      } catch (err: any) {
        return JSON.stringify({ error: `Eval run failed: ${err.message || err}` });
      }
    }

    // ── Mine Session Failures ────────────────────────────────────
    case "mine_session_failures": {
      const days = Number(args.days) || 7;
      const limit = Number(args.limit) || 20;
      const since = new Date(Date.now() - days * 86400_000).toISOString();

      try {
        // Find failed turns
        const failures = await sql`
          SELECT t.input_text, t.error, t.reflection, t.model_used, s.status, s.session_id, t.created_at
          FROM turns t
          JOIN sessions s ON s.session_id = t.session_id
          WHERE s.org_id = ${ctx.orgId} AND s.agent_name = ${ctx.agentName}
            AND t.created_at > ${since}
            AND (t.error IS NOT NULL AND t.error != '' OR s.status IN ('error', 'failed'))
          ORDER BY t.created_at DESC LIMIT ${limit}
        `;

        // Also find sessions with low step counts that might indicate confusion
        const shortSessions = await sql`
          SELECT session_id, status, step_count, wall_clock_seconds, created_at
          FROM sessions
          WHERE org_id = ${ctx.orgId} AND agent_name = ${ctx.agentName}
            AND created_at > ${since}
            AND step_count <= 1 AND status = 'success'
            AND wall_clock_seconds > 30
          ORDER BY created_at DESC LIMIT 5
        `;

        const proposed = failures.map((f: any) => ({
          input: String(f.input_text).slice(0, 500),
          error: String(f.error || f.reflection || "").slice(0, 300),
          model: f.model_used,
          session_id: f.session_id,
          suggestion: `Test that the agent handles: "${String(f.input_text).slice(0, 100)}..." without errors`,
        }));

        return JSON.stringify({
          failures_found: failures.length,
          short_sessions: shortSessions.length,
          proposed_cases: proposed,
          suggestion: failures.length > 0
            ? `Found ${failures.length} failures. Use add_eval_test_cases to create regression tests for these.`
            : "No recent failures found. The agent is performing well.",
        });
      } catch (err: any) {
        return JSON.stringify({ error: `Failed to mine sessions: ${err.message || err}` });
      }
    }

    // ── Create Sub-Agent ──────────────────────────────────────────
    case "create_sub_agent": {
      const name = String(args.name || "").toLowerCase().replace(/[^a-z0-9_-]/g, "-");
      if (!name) return JSON.stringify({ error: "name is required" });
      const description = String(args.description || "");
      const systemPrompt = String(args.system_prompt || "");
      if (!systemPrompt) return JSON.stringify({ error: "system_prompt is required" });
      const tools = Array.isArray(args.tools) ? args.tools.map(String) : [];
      if (tools.length === 0) return JSON.stringify({ error: "tools array is required" });

      try {
        // Read parent agent config for defaults
        const parentRows = await sql`SELECT config FROM agents WHERE name = ${ctx.agentName} AND org_id = ${ctx.orgId} LIMIT 1`;
        const parentConfig = parentRows.length > 0
          ? (typeof parentRows[0].config === "string" ? JSON.parse(parentRows[0].config as string) : parentRows[0].config || {})
          : {};

        const subConfig = {
          system_prompt: systemPrompt,
          model: String(args.model || parentConfig.model || "anthropic/claude-sonnet-4-6"),
          plan: parentConfig.plan || "standard",
          provider: parentConfig.provider || "openrouter",
          tools,
          max_turns: Number(args.max_turns) || 15,
          governance: {
            budget_limit_usd: Number(args.budget_limit_usd) || 1.0,
          },
          parent_agent: ctx.agentName,
          version: "0.1.0",
        };

        await sql`
          INSERT INTO agents (name, org_id, description, config, is_active, created_at, updated_at)
          VALUES (${name}, ${ctx.orgId}, ${description}, ${JSON.stringify(subConfig)}, true, now(), now())
          ON CONFLICT (name, org_id) DO UPDATE SET
            description = ${description}, config = ${JSON.stringify(subConfig)}, updated_at = now()
        `;

        // Also ensure parent agent has run-agent or route-to-agent tool
        try {
          const parentTools: string[] = Array.isArray(parentConfig.tools) ? parentConfig.tools : [];
          if (!parentTools.includes("run-agent") && !parentTools.includes("route-to-agent")) {
            parentTools.push("run-agent");
            parentConfig.tools = parentTools;
            await sql`
              UPDATE agents SET config = ${JSON.stringify(parentConfig)}, updated_at = now()
              WHERE name = ${ctx.agentName} AND org_id = ${ctx.orgId}
            `;
          }
        } catch {}

        return JSON.stringify({
          created: true,
          name,
          description,
          model: subConfig.model,
          tools,
          max_turns: subConfig.max_turns,
          budget_limit_usd: subConfig.governance.budget_limit_usd,
          message: `Sub-agent '${name}' created. The parent agent '${ctx.agentName}' can now delegate to it using the run-agent tool with agent_name='${name}'.`,
        });
      } catch (err: any) {
        return JSON.stringify({ error: `Failed to create sub-agent: ${err.message || err}` });
      }
    }

    // ── Manage MCP Connectors ─────────────────────────────────────
    case "manage_connectors": {
      const action = String(args.action || "list");
      try {
        // Read current config
        const configRows = await sql`SELECT config FROM agents WHERE name = ${ctx.agentName} AND org_id = ${ctx.orgId} LIMIT 1`;
        if (configRows.length === 0) return JSON.stringify({ error: "Agent not found" });
        const config = typeof configRows[0].config === "string"
          ? JSON.parse(configRows[0].config as string)
          : configRows[0].config || {};
        const connectors: Array<{ app: string; reason?: string; tools?: string[] }> = config.mcp_connectors || [];

        if (action === "list") {
          return JSON.stringify({
            connectors: connectors.length > 0 ? connectors : [],
            total: connectors.length,
            note: connectors.length === 0
              ? "No connectors configured. Use action='add' to connect external apps (CRMs, email, calendars, etc.)."
              : undefined,
            available_apps: "hubspot, salesforce, zendesk, gmail, google-calendar, slack, jira, notion, linear, github, stripe, shopify, airtable, asana, trello, discord, twilio, sendgrid, mailchimp, intercom",
          });
        }

        if (action === "add") {
          const app = String(args.app || "").toLowerCase();
          if (!app) return JSON.stringify({ error: "app is required for add" });
          const reason = String(args.reason || `Connect to ${app}`);

          // Check if already added
          if (connectors.some(c => c.app === app)) {
            return JSON.stringify({ message: `Connector '${app}' is already configured.`, connectors });
          }

          connectors.push({ app, reason });
          config.mcp_connectors = connectors;

          // Also ensure mcp-call tool is in the agent's tool list
          const tools: string[] = Array.isArray(config.tools) ? config.tools : [];
          if (!tools.includes("mcp-call")) {
            tools.push("mcp-call");
            config.tools = tools;
          }

          await sql`
            UPDATE agents SET config = ${JSON.stringify(config)}, updated_at = now()
            WHERE name = ${ctx.agentName} AND org_id = ${ctx.orgId}
          `;

          return JSON.stringify({
            added: true,
            app,
            reason,
            total_connectors: connectors.length,
            message: `Connector '${app}' added. The agent can now interact with ${app} via the mcp-call tool. OAuth setup may be required — the user will be prompted on first use.`,
          });
        }

        if (action === "remove") {
          const app = String(args.app || "").toLowerCase();
          if (!app) return JSON.stringify({ error: "app is required for remove" });
          config.mcp_connectors = connectors.filter(c => c.app !== app);
          await sql`
            UPDATE agents SET config = ${JSON.stringify(config)}, updated_at = now()
            WHERE name = ${ctx.agentName} AND org_id = ${ctx.orgId}
          `;
          return JSON.stringify({ removed: true, app, remaining: config.mcp_connectors.length });
        }

        return JSON.stringify({ error: `Unknown action: ${action}. Use list, add, or remove.` });
      } catch (err: any) {
        return JSON.stringify({ error: `Connector management failed: ${err.message || err}` });
      }
    }

    case "run_query": {
      const query = String(args.query || "").trim();
      if (!query) return JSON.stringify({ error: "query is required" });

      // Strict read-only enforcement — use word boundaries to avoid false positives
      // (e.g. "created_at" should NOT match "CREATE")
      const normalized = query.replace(/--.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "").trim().toUpperCase();
      const forbidden = ["INSERT", "UPDATE", "DELETE", "DROP", "ALTER", "TRUNCATE", "CREATE", "GRANT", "REVOKE", "EXEC", "EXECUTE", "COPY"];
      for (const keyword of forbidden) {
        const re = new RegExp(`\\b${keyword}\\b`);
        if (re.test(normalized)) {
          return JSON.stringify({ error: `Forbidden: ${keyword} statements are not allowed. Only SELECT queries permitted.` });
        }
      }
      if (!normalized.startsWith("SELECT") && !normalized.startsWith("WITH") && !normalized.startsWith("EXPLAIN")) {
        return JSON.stringify({ error: "Only SELECT, WITH (CTE), or EXPLAIN queries are allowed." });
      }

      // SECURITY: Force org_id scoping via RLS context + query rewriting.
      // The meta-agent must only see data belonging to its own org.
      const orgId = ctx.orgId;
      try {
        // Set RLS context for this query

        // Validate the query references org-scoped tables only
        const SCOPED_TABLES = [
          // Core telemetry
          "sessions", "turns", "agents", "agent_versions",
          // Cost & billing
          "credit_transactions", "billing_records", "billing_events", "cost_ledger",
          // Eval & training
          "training_jobs", "training_iterations", "training_resources", "training_rewards",
          "eval_test_cases", "eval_runs", "eval_trials",
          // Observability & tracing
          "delegation_events", "tool_executions", "session_progress",
          "trace_annotations", "trace_lineage",
          // Feedback & quality
          "session_feedback", "session_feedback", "span_feedback",
          // Security & audit
          "audit_log", "security_events", "guardrail_events", "api_access_log",
          // Alerting & SLOs
          "alert_configs", "alert_history", "slo_evaluations", "slo_error_budgets",
          // A2A & marketplace
          "a2a_tasks", "marketplace_listings", "marketplace_ratings",
          // Evolution
          "evolution_reports", "evolution_proposals", "evolution_ledger",
          // Infrastructure
          "api_keys", "org_members", "skills", "feature_flags",
          "batch_jobs", "batch_tasks", "autopilot_sessions",
          // Issues & risk
          "issues", "risk_profiles",
          // End-user analytics
          "end_user_usage",
        ];

        // Check for table access outside the allowed set
        const tablePattern = /\bFROM\s+(\w+)|\bJOIN\s+(\w+)/gi;
        let match: RegExpExecArray | null;
        const accessedTables: string[] = [];
        while ((match = tablePattern.exec(normalized)) !== null) {
          const table = (match[1] || match[2] || "").toLowerCase();
          if (table && !SCOPED_TABLES.includes(table)) {
            return JSON.stringify({ error: `Table '${table}' is not accessible. Allowed tables: ${SCOPED_TABLES.join(", ")}` });
          }
          accessedTables.push(table);
        }

        // Run the original query with RLS active + LIMIT + timeout.
        // The RLS context set above ensures org-scoped access at the DB level.
        // statement_timeout prevents long-running queries from hogging resources.
        const rows = await sql.unsafe(
          `SET LOCAL statement_timeout = '5s'; ${query}`,
          [],
          { prepare: false },
        );
        const result = Array.isArray(rows) ? rows : [];

        // Post-filter: strip rows with org_id !== current org (defense in depth)
        const filtered = result.filter((row: any) => {
          if (row.org_id && row.org_id !== orgId) return false;
          return true;
        });

        const maxRows = 100;
        const truncated = filtered.length > maxRows;
        const output = filtered.slice(0, maxRows);

        return JSON.stringify({
          row_count: filtered.length,
          truncated,
          rows: output,
          note: truncated ? `Showing first ${maxRows} of ${filtered.length} rows.` : undefined,
          scoped_to: orgId,
        });
      } catch (err: any) {
        return JSON.stringify({ error: `Query failed: ${err.message || err}` });
      }
    }

    // ── Infrastructure & Diagnostics Tool Execution ──────────────
    case "read_session_diagnostics": {
      const sessionId = String(args.session_id || "");
      if (!sessionId) return JSON.stringify({ error: "session_id required" });
      try {
        // Read turns and extract diagnostic events from errors and tool_results
        const turns = await sql`
          SELECT t.turn_number, t.tool_calls, t.tool_results, t.errors, t.cost_usd, t.created_at
          FROM turns t
          JOIN sessions s ON t.session_id = s.session_id
          WHERE t.session_id = ${sessionId} AND s.org_id = ${ctx.orgId}
          ORDER BY t.turn_number
        `;

        const diagnostics: Array<{ turn: number; type: string; detail: string }> = [];

        for (const turn of turns as any[]) {
          const turnNum = turn.turn_number;
          let errors: any[] = [];
          let toolResults: any[] = [];
          errors = parseJsonColumn(turn.errors, []);
          toolResults = parseJsonColumn(turn.tool_results, []);

          // Loop detection events
          for (const err of errors) {
            const errStr = String(err || "");
            if (errStr.includes("Loop detected") || errStr.includes("loop_detected")) {
              diagnostics.push({ turn: turnNum, type: "loop_detected", detail: errStr });
            }
            if (errStr.includes("budget") || errStr.includes("BUDGET_EXHAUSTED")) {
              diagnostics.push({ turn: turnNum, type: "budget_exhausted", detail: errStr });
            }
          }

          // Tool-level diagnostics from results
          for (const tr of toolResults) {
            const result = String(tr.result || "");
            const error = String(tr.error || "");
            if (error.includes("circuit breaker") || error.includes("CIRCUIT_BREAKER")) {
              diagnostics.push({ turn: turnNum, type: "circuit_breaker_trip", detail: `Tool ${tr.name}: ${error}` });
            }
            if (error.includes("cancelled") || error.includes("aborted") || error.includes("sibling_failed")) {
              diagnostics.push({ turn: turnNum, type: "tool_cancelled", detail: `Tool ${tr.name}: ${error}` });
            }
            if (result.includes("[backpressure:") || result.includes("truncated")) {
              diagnostics.push({ turn: turnNum, type: "backpressure_truncation", detail: `Tool ${tr.name}: result was truncated` });
            }
            if (result.includes("[Tool execution interrupted") || result.includes("assumed succeeded")) {
              diagnostics.push({ turn: turnNum, type: "conversation_repair", detail: `Tool ${tr.name}: result was auto-repaired after crash` });
            }
            if (error.includes("SSRF") || error.includes("blocked")) {
              diagnostics.push({ turn: turnNum, type: "ssrf_blocked", detail: `Tool ${tr.name}: ${error}` });
            }
          }
        }

        // Also check session-level events
        const sessionRows = await sql`
          SELECT status, cost_total_usd, wall_clock_seconds, step_count, output_text
          FROM sessions WHERE session_id = ${sessionId} AND org_id = ${ctx.orgId} LIMIT 1
        `;
        const session = sessionRows[0] as any;

        // Check output for known runtime messages
        const output = String(session?.output_text || "");
        if (output.includes("Loop detected") || output.includes("failing repeatedly")) {
          diagnostics.push({ turn: 0, type: "session_stopped_by_loop", detail: output.slice(0, 300) });
        }
        if (output.includes("Budget") || output.includes("budget limit")) {
          diagnostics.push({ turn: 0, type: "session_stopped_by_budget", detail: output.slice(0, 300) });
        }
        if (output.includes("Session limit reached")) {
          diagnostics.push({ turn: 0, type: "session_limit_reached", detail: output.slice(0, 300) });
        }
        if (output.includes("Shutdown requested by parent")) {
          diagnostics.push({ turn: 0, type: "parent_shutdown", detail: "Session was stopped by parent agent via mailbox IPC" });
        }

        return JSON.stringify({
          session_id: sessionId,
          status: session?.status || "unknown",
          total_turns: turns.length,
          total_cost_usd: session?.cost_total_usd,
          wall_clock_seconds: session?.wall_clock_seconds,
          diagnostic_events: diagnostics,
          event_count: diagnostics.length,
          summary: diagnostics.length === 0
            ? "No diagnostic events found — session ran normally."
            : `Found ${diagnostics.length} diagnostic event(s): ${[...new Set(diagnostics.map(d => d.type))].join(", ")}`,
        });
      } catch (err: any) {
        return JSON.stringify({ error: `Diagnostics failed: ${err.message || err}` });
      }
    }

    case "read_feature_flags": {
      try {
        const flags = ["concurrent_tools", "context_compression", "deferred_tool_loading"];
        const result: Record<string, boolean | null> = {};
        for (const flag of flags) {
          try {
            const rows = await sql`
              SELECT value FROM feature_flags
              WHERE org_id = ${ctx.orgId} AND flag_name = ${flag}
              LIMIT 1
            `;
            result[flag] = rows.length > 0 ? rows[0].value === "true" || rows[0].value === true : null;
          } catch {
            // Table may not exist yet — return defaults
            result[flag] = null;
          }
        }
        return JSON.stringify({
          org_id: ctx.orgId,
          flags: result,
          note: "null means the flag uses its default value (enabled). false means explicitly disabled.",
        });
      } catch (err: any) {
        return JSON.stringify({ error: `Failed to read feature flags: ${err.message || err}` });
      }
    }

    case "set_feature_flag": {
      if (ctx.userRole !== "owner" && ctx.userRole !== "admin") {
        return JSON.stringify({ error: "Permission denied: only org owners and admins can modify feature flags." });
      }
      const flag = String(args.flag || "");
      const enabled = args.enabled === true;
      const validFlags = ["concurrent_tools", "context_compression", "deferred_tool_loading"];
      if (!validFlags.includes(flag)) {
        return JSON.stringify({ error: `Invalid flag. Valid flags: ${validFlags.join(", ")}` });
      }
      try {
        await sql`
          INSERT INTO feature_flags (org_id, flag_name, value, updated_at)
          VALUES (${ctx.orgId}, ${flag}, ${String(enabled)}, now())
          ON CONFLICT (org_id, flag_name) DO UPDATE SET value = ${String(enabled)}, updated_at = now()
        `;
        // Audit the change
        try {
          await sql`
            INSERT INTO audit_log (org_id, actor_id, action, resource_type, resource_name, details, created_at)
            VALUES (${ctx.orgId}, ${ctx.userId}, 'set_feature_flag', 'feature_flag', ${flag}, ${JSON.stringify({ flag, enabled, set_by: "meta-agent" })}, now())
          `;
        } catch {}
        return JSON.stringify({ updated: true, flag, enabled, message: `Feature flag '${flag}' set to ${enabled} for your organization.` });
      } catch (err: any) {
        return JSON.stringify({ error: `Failed to set feature flag: ${err.message || err}` });
      }
    }

    case "read_audit_log": {
      const limit = Number(args.limit) || 20;
      try {
        const rows = await sql`
          SELECT actor_id, action, resource_type, resource_name, details, created_at
          FROM audit_log
          WHERE org_id = ${ctx.orgId}
            AND (resource_name = ${ctx.agentName} OR resource_type = 'feature_flag' OR resource_type = 'training')
          ORDER BY created_at DESC
          LIMIT ${limit}
        `;
        return JSON.stringify({
          entries: rows.map((r: any) => ({
            actor: r.actor_id,
            action: r.action,
            resource_type: r.resource_type,
            resource_name: r.resource_name,
            details: (() => { try { return JSON.parse(r.details || "{}"); } catch { return r.details; } })(),
            when: r.created_at,
          })),
          total: rows.length,
        });
      } catch (err: any) {
        return JSON.stringify({ error: `Failed to read audit log: ${err.message || err}` });
      }
    }

    case "manage_skills": {
      if (ctx.userRole !== "owner" && ctx.userRole !== "admin") {
        return JSON.stringify({ error: "Permission denied: only org owners and admins can manage skills." });
      }
      const action = String(args.action || "list");
      try {
        if (action === "list") {
          const rows = await sql`
            SELECT name, description, category, is_active, created_at
            FROM skills
            WHERE org_id = ${ctx.orgId} AND (agent_name IS NULL OR agent_name = ${ctx.agentName})
            ORDER BY name
          `;
          // Also list built-in skills
          const builtIn = [
            { name: "/batch", description: "Parallel task decomposition", category: "workflow", built_in: true },
            { name: "/review", description: "Three-lens code review (reuse, quality, efficiency)", category: "code", built_in: true },
            { name: "/debug", description: "Session diagnostics and error analysis", category: "ops", built_in: true },
            { name: "/verify", description: "Run tests against changes", category: "code", built_in: true },
            { name: "/remember", description: "Memory curation and deduplication", category: "workflow", built_in: true },
            { name: "/skillify", description: "Extract reusable skill from a process", category: "workflow", built_in: true },
            { name: "/schedule", description: "Create recurring scheduled tasks", category: "ops", built_in: true },
            { name: "/docs", description: "Load reference documentation", category: "data", built_in: true },
          ];
          return JSON.stringify({
            built_in_skills: builtIn,
            custom_skills: rows.map((r: any) => ({
              name: r.name,
              description: r.description,
              category: r.category,
              enabled: r.enabled,
              created_at: r.created_at,
            })),
          });
        }

        if (action === "create") {
          const name = String(args.name || "").toLowerCase().replace(/[^a-z0-9-]/g, "-");
          if (!name) return JSON.stringify({ error: "name is required for create" });
          const description = String(args.description || "");
          const promptTemplate = String(args.prompt_template || "");
          if (!promptTemplate) return JSON.stringify({ error: "prompt_template is required for create" });
          const category = String(args.category || "workflow");

          await sql`
            INSERT INTO skills (name, description, category, prompt, org_id, agent_name, is_active, created_at)
            VALUES (${name}, ${description}, ${category}, ${promptTemplate}, ${ctx.orgId}, ${ctx.agentName}, true, now())
            ON CONFLICT (org_id, name) DO UPDATE SET
              description = ${description}, prompt = ${promptTemplate}, category = ${category}, agent_name = ${ctx.agentName}
          `;
          return JSON.stringify({ created: true, name, description, category, message: `Skill '/${name}' created. Users can activate it by typing /${name} in the chat.` });
        }

        if (action === "delete") {
          const name = String(args.name || "");
          if (!name) return JSON.stringify({ error: "name is required for delete" });
          await sql`DELETE FROM skills WHERE name = ${name} AND org_id = ${ctx.orgId}`;
          return JSON.stringify({ deleted: true, name, message: `Skill '/${name}' deleted.` });
        }

        return JSON.stringify({ error: `Unknown action: ${action}. Use list, create, or delete.` });
      } catch (err: any) {
        return JSON.stringify({ error: `Skills management failed: ${err.message || err}` });
      }
    }

    default:
      return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
  });
}

/* ── System prompt ──────────────────────────────────────────────── */

function buildSystemPrompt(agentName: string, mode: "demo" | "live" = "live"): string {
  // Import the reusable prompt builder
  const { buildMetaAgentChatPrompt } = require("../prompts/meta-agent-chat");
  return buildMetaAgentChatPrompt(agentName, mode);
}

// Legacy prompt kept for reference — replaced by prompts/meta-agent-chat.ts
function _legacyBuildSystemPrompt(agentName: string): string {
  return `You are the Agent Manager for "${agentName}" on the AgentOS platform. You help the agent's owner understand, configure, monitor, and improve their agent through natural conversation.

## Your Capabilities
You have tools to:
- **Read the agent's full configuration** (system prompt, tools, model, plan, routing, governance, etc.)
- **Update any configuration field** (system prompt, tools, temperature, model, plan, routing, etc.)
- **Read user sessions** to understand how people are using the agent
- **Read specific conversations** to diagnose issues or understand patterns
- **Check observability data** (errors, latency, costs, active sessions)
- **Read eval results** to see how the agent performs on its test suite
- **Run the evolution analyzer** to get AI-generated improvement suggestions
- **Check conversation quality** metrics and recent topics
- **Start automated training** to optimize the agent's prompt, reasoning strategy, and tool selection
- **Check training status** to monitor active/completed training jobs
- **Activate trained configs** to apply optimized configurations with safety gates
- **Rollback training** to revert to the previous config if training made things worse
- **Check circuit breaker** to see if the auto-rollback safety net is active
- **Publish to the marketplace** so other agents and users can discover and pay to use this agent
- **Check marketplace stats** to see ratings, task counts, quality score, and earnings

## Reasoning Strategies

The runtime supports 5 reasoning strategies that change HOW the agent thinks before acting. Set via the \`reasoning_strategy\` config field:

- **chain-of-thought**: Step-by-step reasoning. Best for math, logic, multi-step analysis.
- **plan-then-execute**: Creates an explicit plan before using tools. Best for implementation tasks.
- **step-back**: First-principles thinking. Best for debugging and "why" questions.
- **decompose**: Breaks complex tasks into 3-5 sub-tasks. Best for large/ambiguous requests.
- **verify-then-respond**: Re-reads the question and verifies the answer before responding. Best for accuracy-critical tasks.
- **(empty/auto)**: The runtime auto-selects based on task keywords and complexity. This is the default and usually the best choice.

When users say "my agent rushes to answer without thinking" → set reasoning_strategy to "plan-then-execute".
When users say "my agent gives wrong answers" → set reasoning_strategy to "verify-then-respond".

## Extended Thinking

The runtime emits "thinking" traces — visible reasoning the agent does before tool calls. Users can see these in the playground chat as purple thought bubbles. This is automatic when the model produces content alongside tool calls. No config needed.

## Tool Validation

When configuring tools via update_agent_config:
- Tool names are validated against the runtime catalog. Invalid names are silently dropped.
- Valid tool names include: web-search, browse, http-request, web-crawl, python-exec, bash, execute-code, read-file, write-file, edit-file, knowledge-search, store-knowledge, image-generate, text-to-speech, db-query, create-agent, list-agents, discover-api
- If tools is empty or not set, the agent gets 15 default tools (web-search, browse, python-exec, bash, etc.)
- NEVER set tools to an empty array unless the user explicitly wants to restrict the agent to no tools.

## Voice Mode

When the agent receives calls via phone (Twilio ConversationRelay):
- Model is auto-overridden to gpt-5.4-mini for speed
- System prompt gets voice rules injected (short responses, no markdown, conversational tone)
- This is automatic — no config change needed. The voice page in the portal handles setup.

## How to Behave
1. **Be proactive**: When asked about problems, use your tools to investigate before answering. Don't guess — look at the data.
2. **Explain changes**: Before updating config, explain what you'll change and why. After updating, confirm what changed.
3. **Be specific**: Reference actual data from tools. Quote error messages, cite session IDs, show pass rates.
4. **Suggest improvements**: When you see issues in the data, proactively suggest fixes. But always ask before making changes unless the user says to go ahead.
5. **Stay focused**: You manage THIS agent ("${agentName}"). Don't try to manage other agents or do unrelated tasks.
6. **Keep it simple**: The user may be a non-technical business owner. Avoid jargon. Explain what things mean.

## Common Workflows
- "How is my agent doing?" → read_observability + read_eval_results + read_conversation_quality
- "What are users asking about?" → read_sessions + read_session_messages on recent ones
- "My agent gives wrong answers about X" → read_agent_config (check prompt), then update_agent_config to add instructions
- "Make my agent friendlier" → read_agent_config, then update_agent_config with personality/system_prompt changes
- "Why is my agent slow/expensive?" → read_observability, check model and max_tokens
- "Change my agent's plan" → update_agent_config with plan: "basic"|"standard"|"premium". Plans control which LLM models are used for different task types (simple, moderate, complex, coding, research, creative). Basic = Workers AI (free), Standard = GPT/Claude/Gemini mix, Premium = top-tier models.
- "My agent doesn't think before acting" → update_agent_config with reasoning_strategy: "plan-then-execute" or "step-back"
- "My agent gives wrong answers" → update_agent_config with reasoning_strategy: "verify-then-respond"
- "Make my agent think more deeply" → update_agent_config with reasoning_strategy: "chain-of-thought"
- "Set a spending limit" → update_agent_config with budget_limit_usd: <amount>
- "What tools does my agent have?" → read_agent_config, check tools array. Explain each tool in simple terms.
- "Add web search to my agent" → update_agent_config with tools: [...existing, "web-search"]
- "Improve my agent" → analyze_and_suggest to get data-driven recommendations
- "Train my agent" → start_training with algorithm choice. Recommend 'apo' for prompt optimization, 'multi' for comprehensive tuning
- "How is training going?" → read_training_status with include_iterations=true to see progress
- "Apply the trained config" → read_training_status to get the best resource_id, then activate_trained_config
- "Training made it worse" → rollback_training to revert immediately, then read_training_circuit_breaker to verify
- "Is it safe after training?" → read_training_circuit_breaker to check error rate in the monitoring window
- "Publish my agent" → marketplace_publish with display name, description, category, and price
- "How is my agent doing on the marketplace?" → marketplace_stats to see ratings, tasks, and earnings
- "Make my agent free/paid" → marketplace_publish with price_per_task_usd = 0 (free) or > 0 (paid)

## Marketplace

The agent marketplace lets agents earn money by serving other agents via A2A (Agent-to-Agent) protocol:

### How to Publish
Use the \`marketplace_publish\` tool with a display name, short description, category, and price per task. The agent becomes discoverable by other agents and users. Setting price to 0 makes it free.

### How Pricing Works
- When another agent calls this agent via A2A, the x-402 payment protocol automatically charges the caller
- The platform takes a 10% fee on each transaction
- The remaining 90% is credited to this agent's org balance
- Pricing is set per-task (each A2A call = one task)
- Recommended pricing: $0.01-$0.10 for simple tasks, $0.10-$1.00 for complex ones

### How Referral Earnings Work
- When someone signs up using a referral code linked to this org, the org earns a percentage of the platform fee on their transactions
- This is automatic — no action needed from the agent owner
- Referral earnings are separate from task revenue

### Quality Score
The marketplace ranks agents by a quality score (0-1) based on:
- Task completion rate (40%) — how often tasks succeed vs fail
- Average rating (30%) — 1-5 star ratings from callers
- Response time (20%) — faster = higher score
- Verification status (10%) — verified agents get a boost
Higher quality score = more visibility in search results.

## How Training Works

The training system optimizes the agent through automated iteration:
1. **Eval**: Runs the agent's test suite to measure current performance
2. **Reward**: Computes a composite score from eval pass rate (50%), user feedback (20%), guardrail compliance (15%), cost efficiency (10%), latency (5%)
3. **Optimize**: The algorithm proposes changes:
   - **Baseline**: Random perturbations (safe, explores broadly)
   - **APO** (Automatic Prompt Optimization): An LLM rewrites the prompt to fix eval failures (most effective)
   - **Multi-dimension**: Cycles through prompt → reasoning strategy → tool selection (comprehensive)
4. **Safety**: Every proposed change passes through: pre-flight tool checks, prompt safety scan (blocks guardrail stripping), config schema validation
5. **Activate**: Best config is stored as a resource. Can be activated manually or automatically
6. **Circuit breaker**: After activation, monitors error rate for 15 minutes. Auto-rolls back if errors exceed 30%

Always explain training in simple terms. The user may not know what APO means — just say "AI-powered prompt improvement" instead.

## How LLM Plan Routing Works

When a user selects a plan (basic/standard/premium), the runtime automatically routes each turn to the optimal model:

- Each user message is classified by complexity (simple/moderate/complex), category (coding/research/creative/general), and role (planner/implementer/reviewer/debugger/etc.)
- The plan determines which model handles each classification:
  - Basic: Workers AI models (free, fast, on-edge)
  - Standard: GPT-5.4 Mini + Claude Sonnet 4.6 + Gemini 3.1 Flash (balanced)
  - Premium: GPT-5.4 Pro + Claude Opus 4.6 + Gemini 3.1 Pro (best quality)

The agent does NOT need to know about this — routing is transparent. The agent just writes its prompt and the runtime picks the best model for each turn automatically.

Example: If an agent is on the Standard plan and the user asks "debug this Python error", the runtime classifies it as coding/debugger and routes to Claude Sonnet 4.6 (best for iterative debugging). If the same user then asks "write me a poem", it routes to Claude Sonnet 4.6 (creative/write).`;
}

/* ── Chat runner (LLM + tool loop) ──────────────────────────────── */

/**
 * Run a conversational meta-agent turn. Takes the full conversation history,
 * runs an LLM call with tools, executes any tool calls, and returns the
 * updated conversation with the assistant's response.
 */
export async function runMetaChat(
  messages: MetaChatMessage[],
  ctx: MetaChatContext,
): Promise<{ messages: MetaChatMessage[]; response: string; cost_usd?: number; turns?: number; session_id?: string; input_tokens?: number; output_tokens?: number; tool_calls?: number; model?: string; model_path?: "auto" | "gemma" | "sonnet" }> {
  const systemPrompt = buildSystemPrompt(ctx.agentName, ctx.mode || "live");

  // Build messages for OpenRouter
  const llmMessages = [
    { role: "system" as const, content: systemPrompt },
    ...messages.map((m) => {
      if (m.role === "tool") {
        return {
          role: "tool" as const,
          content: m.content,
          tool_call_id: m.tool_call_id || "",
        };
      }
      if (m.tool_calls) {
        return {
          role: m.role as "assistant",
          content: m.content || null,
          tool_calls: m.tool_calls,
        };
      }
      return { role: m.role, content: m.content };
    }),
  ];

  // ── Message history trimming — prevent context overflow ──
  const MAX_CONTEXT_CHARS = 200_000;
  if (JSON.stringify(llmMessages).length > MAX_CONTEXT_CHARS) {
    const system = llmMessages.filter((m: any) => m.role === "system");
    const recent = llmMessages.filter((m: any) => m.role !== "system").slice(-12);
    llmMessages.length = 0;
    llmMessages.push(...system, ...recent);
  }

  // ── Plan-based model selection: free/basic → Gemma, standard/premium → Sonnet ──
  let agentPlan = "free";
  try {
    agentPlan = await withOrgDb({ HYPERDRIVE: ctx.hyperdrive }, ctx.orgId, async (sql) => {
      // RLS on agents filters to current org — no WHERE org_id needed.
      const [row] = await sql`
        SELECT config FROM agents WHERE name = ${ctx.agentName} LIMIT 1
      `;
      if (!row) return "free";
      const cfg = typeof row.config === "string" ? JSON.parse(row.config) : row.config ?? {};
      return cfg.plan || "free";
    });
  } catch { /* fail open — default to free/Gemma */ }

  const selectedModelPath = ctx.modelPath || "auto";
  const metaModel = selectedModelPath === "gemma"
    ? "gemma-4-31b"
    : selectedModelPath === "sonnet"
      ? "anthropic/claude-sonnet-4-6"
      : (agentPlan === "standard" || agentPlan === "premium"
        ? "anthropic/claude-sonnet-4-6"
        : "gemma-4-31b");

  const MAX_TOOL_ROUNDS = 8;
  let round = 0;
  let totalCost = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalToolCalls = 0;
  const outputMessages: MetaChatMessage[] = [];
  const turnRecords: Array<{
    turn: number;
    model: string;
    content: string;
    input_tokens: number;
    output_tokens: number;
    cost_usd: number;
    tool_calls: Array<{ name: string; arguments: Record<string, unknown> }>;
    tool_results: Array<{ name: string; result: string; latency_ms: number; error?: string }>;
  }> = [];
  const sessionId = `meta_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;

  while (round < MAX_TOOL_ROUNDS) {
    round++;

    // ── Progressive tool discovery: select relevant tools for this turn ──
    // Build context from the last user message + recent tool results
    const recentContext = llmMessages
      .slice(-4)
      .map((m: any) => String(m.content || "").slice(0, 200))
      .join(" ")
      .toLowerCase();

    const relevantTools = selectMetaTools(recentContext);

    // Progressive infrastructure docs injection: only include detailed runtime
    // docs when diagnostic/infrastructure tools are selected. Saves ~600 tokens
    // on most turns. Follows Claude Code's deferred loading pattern.
    const hasInfraTools = relevantTools.some(t =>
      TOOL_GROUPS.infrastructure.includes(t.function.name)
    );
    if (hasInfraTools && !llmMessages.some((m: any) => m.content?.includes("Runtime Infrastructure — Detailed"))) {
      const { RUNTIME_INFRASTRUCTURE_DOCS } = await import("../prompts/meta-agent-chat");
      llmMessages.push({ role: "system" as const, content: RUNTIME_INFRASTRUCTURE_DOCS });
    }

    const { callLLMGateway } = await import("../lib/llm-gateway");
    const llmResult = await callLLMGateway(
      {
        cloudflareAccountId: ctx.cloudflareAccountId,
        aiGatewayId: ctx.aiGatewayId,
        cloudflareApiToken: ctx.cloudflareApiToken,
        aiGatewayToken: ctx.aiGatewayToken,
        gpuServiceKey: ctx.gpuServiceKey,
        openrouterApiKey: ctx.openrouterApiKey,
      },
      {
        model: metaModel,
        messages: llmMessages as any,
        tools: relevantTools,
        tool_choice: "auto",
        max_tokens: 8192,
        temperature: 0.3,
        timeout_ms: 300_000,
        metadata: { agent: "meta-agent", org_id: ctx.orgId },
      },
    );

    const turnInputTokens = llmResult.usage?.prompt_tokens || (llmResult as any).usage?.input_tokens || 0;
    const turnOutputTokens = llmResult.usage?.completion_tokens || (llmResult as any).usage?.output_tokens || 0;
    // Calculate cost from tokens — Sonnet 4.6: $3.00/$15.00, Gemma: $0.13/$0.40 per M tokens
    const isGemmaModel = metaModel.startsWith("gemma-");
    const INPUT_COST = isGemmaModel ? 0.13 : 3.00;
    const OUTPUT_COST = isGemmaModel ? 0.40 : 15.00;
    const turnCostUsd = (turnInputTokens / 1_000_000) * INPUT_COST
                      + (turnOutputTokens / 1_000_000) * OUTPUT_COST;
    totalCost += turnCostUsd;
    totalInputTokens += turnInputTokens;
    totalOutputTokens += turnOutputTokens;

    const msg = {
      role: "assistant" as const,
      content: llmResult.content,
      tool_calls: llmResult.tool_calls as ToolCall[] | undefined,
    };
    const toolCalls = msg.tool_calls;

    if (!toolCalls || toolCalls.length === 0) {
      // Final text response — done
      const assistantMsg: MetaChatMessage = {
        role: "assistant",
        content: msg.content || "",
      };
      outputMessages.push(assistantMsg);
      llmMessages.push({ role: "assistant", content: msg.content || "" });
      turnRecords.push({
        turn: round,
        model: metaModel,
        content: msg.content || "",
        input_tokens: turnInputTokens,
        output_tokens: turnOutputTokens,
        cost_usd: turnCostUsd,
        tool_calls: [],
        tool_results: [],
      });
      break;
    }

    // Assistant message with tool calls
    const assistantMsg: MetaChatMessage = {
      role: "assistant",
      content: msg.content || "",
      tool_calls: toolCalls,
    };
    outputMessages.push(assistantMsg);
    llmMessages.push({
      role: "assistant" as const,
      content: msg.content || null,
      tool_calls: toolCalls,
    } as any);

    // Execute each tool call with timing
    const turnToolCalls: typeof turnRecords[0]["tool_calls"] = [];
    const turnToolResults: typeof turnRecords[0]["tool_results"] = [];

    for (const tc of toolCalls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.function.arguments || "{}");
      } catch {}

      const toolStart = Date.now();
      let result: string;
      let toolError: string | undefined;
      try {
        result = await executeTool(tc.function.name, args, ctx);
      } catch (err: any) {
        toolError = err.message || "Tool execution failed";
        result = JSON.stringify({ error: toolError });
      }
      const toolLatencyMs = Date.now() - toolStart;

      turnToolCalls.push({ name: tc.function.name, arguments: args });
      turnToolResults.push({
        name: tc.function.name,
        result: result.slice(0, 2000),
        latency_ms: toolLatencyMs,
        error: toolError,
      });

      totalToolCalls++;

      const toolMsg: MetaChatMessage = {
        role: "tool",
        content: result,
        tool_call_id: tc.id,
      };
      outputMessages.push(toolMsg);
      llmMessages.push({
        role: "tool" as const,
        content: result,
        tool_call_id: tc.id,
      } as any);
    }

    // Record this turn
    turnRecords.push({
      turn: round,
      model: "anthropic/claude-sonnet-4-6",
      content: msg.content || "",
      input_tokens: turnInputTokens,
      output_tokens: turnOutputTokens,
      cost_usd: turnCostUsd,
      tool_calls: turnToolCalls,
      tool_results: turnToolResults,
    });
  }

  // Extract final assistant text
  const lastAssistant = [...outputMessages]
    .reverse()
    .find((m) => m.role === "assistant" && m.content);

  // ── Telemetry: write session + turns + credit deduction ──
  // Same comprehensive telemetry as runtime agents
  const userInput = messages.find(m => m.role === "user")?.content || "";
  try {
    await withOrgDb({ HYPERDRIVE: ctx.hyperdrive }, ctx.orgId, async (sql) => {
      const now = new Date().toISOString();

      // Write session record
      await sql`
        INSERT INTO sessions (session_id, org_id, agent_name, model, status, input_text, output_text,
          step_count, action_count, cost_total_usd, wall_clock_seconds, created_at, ended_at)
        VALUES (
          ${sessionId}, ${ctx.orgId}, ${'meta:' + ctx.agentName}, 'anthropic/claude-sonnet-4-6',
          'success', ${userInput.slice(0, 2000)}, ${(lastAssistant?.content || "").slice(0, 5000)},
          ${round}, ${totalToolCalls}, ${totalCost}, ${0}, ${now}, ${now}
        )
        ON CONFLICT (session_id) DO NOTHING
      `;

      // Write per-turn records
      for (const t of turnRecords) {
        await sql`
          INSERT INTO turns (session_id, turn_number, model_used, llm_content,
            tool_calls, tool_results, errors,
            input_tokens, output_tokens, cost_usd, latency_ms, execution_mode, started_at)
          VALUES (
            ${sessionId}, ${t.turn}, ${t.model}, ${t.content.slice(0, 10000)},
            ${JSON.stringify(t.tool_calls)}, ${JSON.stringify(t.tool_results)}, '[]',
            ${t.input_tokens}, ${t.output_tokens}, ${t.cost_usd}, ${0},
            'meta-agent', ${now}
          )
        `;
      }

      // Write billing record for meta-agent usage (Sonnet 4.6 is paid).
      // RLS filters by current_org_id() so no WHERE org_id needed on
      // the UPDATE to org_credit_balance.
      if (totalCost > 0) {
        await sql`
          INSERT INTO billing_records (
            org_id, customer_id, agent_name, cost_type, description,
            model, provider, input_tokens, output_tokens,
            inference_cost_usd, total_cost_usd, session_id, created_at
          ) VALUES (
            ${ctx.orgId}, ${ctx.userId}, ${'meta:' + ctx.agentName}, 'inference',
            ${'Meta-agent: ' + round + ' turns, ' + totalToolCalls + ' tool calls'},
            'anthropic/claude-sonnet-4-6', 'anthropic',
            ${totalInputTokens}, ${totalOutputTokens},
            ${totalCost}, ${totalCost}, ${sessionId}, ${now}
          )
        `.catch((e: any) => console.warn(`[meta-chat] billing_record write failed: ${e.message}`));

        // Deduct credits
        await sql`
          INSERT INTO credit_transactions (org_id, type, amount_usd, description, reference_id, reference_type, created_at)
          VALUES (${ctx.orgId}, 'burn', ${-totalCost}, ${'meta-agent: ' + ctx.agentName + ' (' + round + ' turns, ' + totalToolCalls + ' tools)'}, ${sessionId}, 'meta_agent', ${now})
        `;
        await sql`
          UPDATE org_credit_balance SET balance_usd = balance_usd - ${totalCost}, updated_at = ${now}
        `.catch(() => {});
      }
    });
  } catch (err) {
    console.error("[meta-agent] Telemetry write failed:", err);
  }

  return {
    messages: outputMessages,
    response: lastAssistant?.content || "I wasn't able to generate a response. Please try again.",
    cost_usd: totalCost,
    turns: round,
    session_id: sessionId,
    input_tokens: totalInputTokens,
    output_tokens: totalOutputTokens,
    tool_calls: totalToolCalls,
    model: metaModel,
    model_path: selectedModelPath,
  };
}
