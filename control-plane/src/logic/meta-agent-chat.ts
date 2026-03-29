/**
 * Conversational meta-agent: lets users talk to an AI that manages their agent.
 * The meta-agent can read config, update settings, check observability,
 * run evals, and proactively fix issues — all via tool calls against
 * the control-plane's own APIs.
 *
 * This is NOT a separate system. It's a standard LLM + tools loop that
 * calls the same SQL/APIs the control-plane routes use.
 */

import { getDbForOrg } from "../db/client";
import { generateEvolutionSuggestions } from "./meta-agent";

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
  hyperdrive: Hyperdrive;
  openrouterApiKey: string;
  env: {
    RUNTIME?: { fetch: (input: RequestInfo, init?: RequestInit) => Promise<Response> };
    SERVICE_TOKEN?: string;
  };
}

/* ── Tool definitions ───────────────────────────────────────────── */

const META_TOOLS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "read_agent_config",
      description:
        "Read the full configuration of the agent including system prompt, tools, model, graph, governance, guardrails, and eval config.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "update_agent_config",
      description:
        "Update specific fields of the agent's configuration. Only include fields you want to change. Supports: system_prompt, description, personality, model, plan (basic/standard/premium), routing (custom routing overrides), temperature, max_tokens, tools (array of tool names), tags, max_turns, timeout_seconds, governance (object with budget_limit_usd etc).",
      parameters: {
        type: "object",
        properties: {
          system_prompt: { type: "string", description: "New system prompt" },
          description: { type: "string", description: "Agent description" },
          personality: { type: "string", description: "Personality/tone" },
          model: { type: "string", description: "Model identifier" },
          plan: { type: "string", enum: ["basic", "standard", "premium"], description: "LLM plan tier — controls which models are used for different task types" },
          routing: { type: "object", description: "Custom model routing overrides by category and role (e.g. { general: { moderate: { model: '...', provider: '...' } } })" },
          temperature: { type: "number", description: "Sampling temperature" },
          max_tokens: { type: "number", description: "Max output tokens" },
          tools: {
            type: "array",
            items: { type: "string" },
            description: "Full list of tools the agent should have",
          },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Agent tags",
          },
          max_turns: { type: "number", description: "Max conversation turns" },
          timeout_seconds: { type: "number", description: "Run timeout" },
          governance: {
            type: "object",
            description: "Governance settings (budget_limit_usd, etc.)",
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
        "Read messages from a specific session to understand what happened in a conversation.",
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
];

/* ── Tool execution ─────────────────────────────────────────────── */

async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: MetaChatContext,
): Promise<string> {
  const sql = await getDbForOrg(ctx.hyperdrive, ctx.orgId);

  switch (name) {
    case "read_agent_config": {
      const rows = await sql`
        SELECT name, description, config_json, is_active, created_at, updated_at
        FROM agents WHERE name = ${ctx.agentName} AND org_id = ${ctx.orgId} LIMIT 1
      `;
      if (rows.length === 0) return JSON.stringify({ error: "Agent not found" });
      const row = rows[0] as Record<string, unknown>;
      const config =
        typeof row.config_json === "string"
          ? JSON.parse(row.config_json)
          : row.config_json ?? {};
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
        tags: config.tags,
        max_turns: config.max_turns,
        timeout_seconds: config.timeout_seconds,
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
        graph_id: config.harness?.declarative_graph?.id ?? null,
      });
    }

    case "update_agent_config": {
      const rows = await sql`
        SELECT config_json FROM agents
        WHERE name = ${ctx.agentName} AND org_id = ${ctx.orgId} LIMIT 1
      `;
      if (rows.length === 0) return JSON.stringify({ error: "Agent not found" });
      const config =
        typeof rows[0].config_json === "string"
          ? JSON.parse(rows[0].config_json as string)
          : (rows[0].config_json as Record<string, unknown>) ?? {};

      // Apply requested changes
      const updatable = [
        "system_prompt",
        "description",
        "personality",
        "model",
        "plan",
        "routing",
        "temperature",
        "max_tokens",
        "tools",
        "tags",
        "max_turns",
        "timeout_seconds",
      ] as const;
      const changed: string[] = [];
      for (const key of updatable) {
        if (args[key] !== undefined) {
          (config as any)[key] = args[key];
          changed.push(key);
        }
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
        SET config_json = ${JSON.stringify(config)},
            description = ${String(config.description || "")},
            updated_at = now()
        WHERE name = ${ctx.agentName} AND org_id = ${ctx.orgId}
      `;

      // Snapshot version
      try {
        await sql`
          INSERT INTO agent_versions (agent_name, version_number, config_json, created_by, created_at)
          VALUES (${ctx.agentName}, ${newVersion}, ${JSON.stringify(config)}, ${"meta-agent"}, now())
          ON CONFLICT (agent_name, version_number) DO UPDATE
          SET config_json = ${JSON.stringify(config)}, created_by = ${"meta-agent"}
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
        SELECT session_id, channel, message_count, created_at, updated_at
        FROM sessions
        WHERE agent_name = ${ctx.agentName} AND org_id = ${ctx.orgId}
        ORDER BY updated_at DESC
        LIMIT ${limit}
      `;
      return JSON.stringify({
        total: rows.length,
        sessions: rows.map((r: any) => ({
          session_id: r.session_id,
          channel: r.channel,
          message_count: r.message_count,
          created_at: r.created_at,
          updated_at: r.updated_at,
        })),
      });
    }

    case "read_session_messages": {
      const sessionId = String(args.session_id || "");
      if (!sessionId) return JSON.stringify({ error: "session_id required" });
      const limit = Number(args.limit) || 50;
      const rows = await sql`
        SELECT role, content, created_at
        FROM turns
        WHERE session_id = ${sessionId} AND org_id = ${ctx.orgId}
        ORDER BY created_at ASC
        LIMIT ${limit}
      `;
      return JSON.stringify({
        session_id: sessionId,
        message_count: rows.length,
        messages: rows.map((r: any) => ({
          role: r.role,
          content: String(r.content || "").slice(0, 500),
          created_at: r.created_at,
        })),
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

      // Aggregate stats from turns table
      let stats: any = {};
      try {
        const turnStats = await sql`
          SELECT
            COUNT(*) as total_turns,
            COUNT(DISTINCT session_id) as active_sessions,
            AVG(EXTRACT(EPOCH FROM (updated_at - created_at))) as avg_turn_duration_s
          FROM turns
          WHERE agent_name = ${ctx.agentName}
            AND org_id = ${ctx.orgId}
            AND created_at > now() - ${interval}::interval
        `;
        stats = turnStats[0] || {};
      } catch {}

      // Error count
      let errorCount = 0;
      try {
        const errRows = await sql`
          SELECT COUNT(*) as cnt FROM turns
          WHERE agent_name = ${ctx.agentName}
            AND org_id = ${ctx.orgId}
            AND created_at > now() - ${interval}::interval
            AND (content LIKE '%[error]%' OR content LIKE '%Error:%')
        `;
        errorCount = Number(errRows[0]?.cnt) || 0;
      } catch {}

      // Cost from billing
      let totalCost = 0;
      try {
        const costRows = await sql`
          SELECT COALESCE(SUM(cost_usd), 0) as total_cost FROM billing_records
          WHERE agent_name = ${ctx.agentName}
            AND org_id = ${ctx.orgId}
            AND created_at > now() - ${interval}::interval
        `;
        totalCost = Number(costRows[0]?.total_cost) || 0;
      } catch {}

      return JSON.stringify({
        period,
        total_turns: Number(stats.total_turns) || 0,
        active_sessions: Number(stats.active_sessions) || 0,
        avg_turn_duration_s: Number(stats.avg_turn_duration_s)
          ? Math.round(Number(stats.avg_turn_duration_s) * 100) / 100
          : null,
        error_count: errorCount,
        total_cost_usd: Math.round(totalCost * 10000) / 10000,
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
          SELECT input, expected, actual, reasoning, pass
          FROM eval_trials WHERE run_id = ${run.id}
          ORDER BY trial_number LIMIT 50
        `;
        failures = trials
          .filter((t: any) => !t.pass)
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
        SELECT config_json FROM agents
        WHERE name = ${ctx.agentName} AND org_id = ${ctx.orgId} LIMIT 1
      `;
      if (configRows.length === 0) return JSON.stringify({ error: "Agent not found" });
      const config =
        typeof configRows[0].config_json === "string"
          ? JSON.parse(configRows[0].config_json as string)
          : (configRows[0].config_json as Record<string, unknown>) ?? {};

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
          WHERE run_id = ${evalRun.id} AND pass = false
          ORDER BY trial_number
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
            UPDATE agents SET config_json = ${JSON.stringify(config)}, updated_at = now()
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

      let sessionCount = 0;
      let avgMessages = 0;
      try {
        const rows = await sql`
          SELECT COUNT(*) as cnt, AVG(message_count) as avg_msg
          FROM sessions
          WHERE agent_name = ${ctx.agentName}
            AND org_id = ${ctx.orgId}
            AND created_at > now() - ${interval}::interval
        `;
        sessionCount = Number(rows[0]?.cnt) || 0;
        avgMessages = Math.round(Number(rows[0]?.avg_msg) || 0);
      } catch {}

      // Get recent turn content to sample quality
      let recentTopics: string[] = [];
      try {
        const turnRows = await sql`
          SELECT content FROM turns
          WHERE agent_name = ${ctx.agentName}
            AND org_id = ${ctx.orgId}
            AND role = 'user'
            AND created_at > now() - ${interval}::interval
          ORDER BY created_at DESC LIMIT 20
        `;
        recentTopics = turnRows
          .map((r: any) => String(r.content || "").slice(0, 100))
          .filter(Boolean);
      } catch {}

      return JSON.stringify({
        period,
        total_sessions: sessionCount,
        avg_messages_per_session: avgMessages,
        recent_user_messages_sample: recentTopics.slice(0, 10),
      });
    }

    default:
      return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
}

/* ── System prompt ──────────────────────────────────────────────── */

function buildSystemPrompt(agentName: string): string {
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
- "Improve my agent" → analyze_and_suggest to get data-driven recommendations`;
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
): Promise<{ messages: MetaChatMessage[]; response: string }> {
  const systemPrompt = buildSystemPrompt(ctx.agentName);

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

  const MAX_TOOL_ROUNDS = 8;
  let round = 0;
  const outputMessages: MetaChatMessage[] = [];

  while (round < MAX_TOOL_ROUNDS) {
    round++;

    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ctx.openrouterApiKey}`,
        "HTTP-Referer": "https://app.oneshots.co",
        "X-Title": "AgentOS Meta-Agent",
      },
      body: JSON.stringify({
        model: "anthropic/claude-sonnet-4-6",
        messages: llmMessages,
        tools: META_TOOLS,
        tool_choice: "auto",
        max_tokens: 4096,
        temperature: 0.3,
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "Unknown error");
      throw new Error(`OpenRouter API error (${resp.status}): ${errText}`);
    }

    const data = (await resp.json()) as {
      choices: Array<{
        message: {
          role: string;
          content: string | null;
          tool_calls?: ToolCall[];
        };
        finish_reason: string;
      }>;
    };

    const choice = data.choices?.[0];
    if (!choice) throw new Error("No response from LLM");

    const msg = choice.message;
    const toolCalls = msg.tool_calls;

    if (!toolCalls || toolCalls.length === 0) {
      // Final text response — done
      const assistantMsg: MetaChatMessage = {
        role: "assistant",
        content: msg.content || "",
      };
      outputMessages.push(assistantMsg);
      llmMessages.push({ role: "assistant", content: msg.content || "" });
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

    // Execute each tool call
    for (const tc of toolCalls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.function.arguments || "{}");
      } catch {}

      let result: string;
      try {
        result = await executeTool(tc.function.name, args, ctx);
      } catch (err: any) {
        result = JSON.stringify({ error: err.message || "Tool execution failed" });
      }

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
  }

  // Extract final assistant text
  const lastAssistant = [...outputMessages]
    .reverse()
    .find((m) => m.role === "assistant" && m.content);

  return {
    messages: outputMessages,
    response: lastAssistant?.content || "I wasn't able to generate a response. Please try again.",
  };
}
