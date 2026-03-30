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
        "Read the full configuration of the agent including system prompt, tools, model, governance, guardrails, and eval config.",
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
          max_turns: { type: "number", description: "Max conversation turns (1-1000)" },
          timeout_seconds: { type: "number", description: "Run timeout in seconds" },
          budget_limit_usd: { type: "number", description: "Max cost per session in USD (0-10000). Set via governance.budget_limit_usd." },
          reasoning_strategy: {
            type: "string",
            enum: ["", "chain-of-thought", "plan-then-execute", "step-back", "decompose", "verify-then-respond"],
            description: "Reasoning strategy. Empty string = auto-select (recommended).",
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

  // ── Training System Tools ─────────────────────────────────────
  {
    type: "function",
    function: {
      name: "start_training",
      description:
        "Start an automated training job for this agent. Training runs eval suites, computes rewards, and uses algorithms (Baseline, APO, or Multi-dimension) to optimize the agent's prompt, reasoning strategy, and tool selection. Includes safety gates: pre-flight tool checks, prompt safety validation, config schema validation, and auto-rollback circuit breaker.",
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
        "Activate a trained resource (prompt, config) produced by a training job. Applies it as the agent's live configuration. Includes validation gates: config schema check, prompt safety scan, and enables the auto-rollback circuit breaker (reverts if error rate > 30% within 15 minutes).",
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
        reasoning_strategy: config.reasoning_strategy || "(auto)",
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
        "reasoning_strategy",
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

    // ── Training System Tool Execution ──────────────────────────
    case "start_training": {
      const algorithm = String(args.algorithm || "apo");
      const maxIterations = Number(args.max_iterations) || 10;
      const autoActivate = args.auto_activate === true;
      // Create training job directly via SQL (training routes are on the control-plane, same process)
      try {
        const jobId = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
        const now = new Date().toISOString();
        await sql`
          INSERT INTO training_jobs (job_id, agent_name, org_id, algorithm, max_iterations, auto_activate, status, current_iteration, best_score, created_at)
          VALUES (${jobId}, ${ctx.agentName}, ${ctx.orgId}, ${algorithm}, ${maxIterations}, ${autoActivate}, 'created', 0, NULL, ${now})
        `;

        // NOTE: To start the first training step, the caller should use
        // POST /training/jobs/{id}/auto-step or the JOB_QUEUE binding.
        // The meta-agent cannot directly access the Queue binding from logic code.

        return JSON.stringify({
          job_id: jobId,
          status: "created",
          algorithm,
          max_iterations: maxIterations,
          auto_activate: autoActivate,
          message: "Training job created. Call POST /training/jobs/{id}/auto-step to begin iterations, then use read_training_status to monitor progress.",
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
            WHERE job_id = ${String(args.job_id)} AND org_id = ${ctx.orgId} LIMIT 1
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
            SELECT iteration_number, pass_rate, reward_score, algorithm_output_json, started_at, completed_at
            FROM training_iterations
            WHERE job_id = ${job.job_id}
            ORDER BY iteration_number
          `;
          result.iterations = iterations.map((it: any) => ({
            iteration: it.iteration_number,
            pass_rate: it.pass_rate,
            reward_score: it.reward_score,
            algorithm_output: (() => { try { return JSON.parse(it.algorithm_output_json || "{}"); } catch { return {}; } })(),
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
        // content_text holds prompt content; content_json holds structured configs
        const rawContent = resource.content_text || resource.content_json;
        const trainedConfig = typeof rawContent === "string" ? (() => { try { return JSON.parse(rawContent); } catch { return { system_prompt: rawContent }; } })() : (rawContent || {});

        // Read current config for rollback storage
        const currentRows = await sql`
          SELECT config_json FROM agents WHERE name = ${ctx.agentName} AND org_id = ${ctx.orgId} LIMIT 1
        `;
        const currentConfig = currentRows.length > 0
          ? (typeof currentRows[0].config_json === "string" ? JSON.parse(currentRows[0].config_json as string) : currentRows[0].config_json)
          : {};

        // Apply trained config
        const merged = { ...currentConfig, ...trainedConfig };
        const oldVer = String(merged.version ?? "0.1.0");
        const verParts = oldVer.split(".").map(Number);
        verParts[1] = (verParts[1] ?? 0) + 1;
        verParts[2] = 0;
        merged.version = verParts.join(".");

        await sql`
          UPDATE agents SET config_json = ${JSON.stringify(merged)}, updated_at = now()
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
            SELECT content_text, content_json, version FROM training_resources
            WHERE agent_name = ${ctx.agentName} AND org_id = ${ctx.orgId}
              AND resource_type = ${active.resource_type} AND resource_key = ${active.resource_key}
              AND version < ${active.version}
            ORDER BY version DESC LIMIT 1
          `;
        } else {
          // Fallback: look for rollback_snapshot resources
          rollbackRows = await sql`
            SELECT content_text, content_json FROM training_resources
            WHERE agent_name = ${ctx.agentName} AND org_id = ${ctx.orgId} AND resource_type = 'rollback_snapshot'
            ORDER BY created_at DESC LIMIT 1
          `;
        }
        if (rollbackRows.length === 0) {
          return JSON.stringify({ error: "No rollback snapshot found. No training activation has been done for this agent." });
        }
        const rawContent = rollbackRows[0].content_text || rollbackRows[0].content_json;
        const previousConfig = typeof rawContent === "string"
          ? (() => { try { return JSON.parse(rawContent); } catch { return { system_prompt: rawContent }; } })()
          : (rawContent || {});

        await sql`
          UPDATE agents SET config_json = ${JSON.stringify(previousConfig)}, updated_at = now()
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
            UPDATE agents SET config_json = jsonb_set(
              COALESCE(config_json::jsonb, '{}'::jsonb),
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
            SELECT COALESCE(SUM(amount_usd), 0) as total
            FROM credit_transactions
            WHERE org_id = ${ctx.orgId} AND type = 'transfer_in' AND reference_type = 'a2a_payment'
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
