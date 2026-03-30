/**
 * AgentRunWorkflow — The single execution engine for all agent runs.
 *
 * Replaces streamRun and edge_graph as the primary execution path.
 * Every agent run goes through here — crash-safe, retryable, no state corruption.
 *
 * Architecture:
 *   Client ←WS/SSE→ DO (connection + session state only)
 *                      ↓ env.AGENT_RUN_WORKFLOW.create()
 *                  Workflow (durable agent loop)
 *                      ↓ writes events to KV after each step
 *                     KV ← DO polls & pushes to client in real-time
 *
 * Graph equivalents:
 *   LangGraph node       = step.do("node-name", { retries, timeout }, fn)
 *   Conditional edge      = if/else between steps
 *   Parallel branches     = Promise.all([step.do("a"), step.do("b")])
 *   Human-in-the-loop    = step.waitForEvent("approval")
 *   Sub-graph/delegation  = child Workflow via env.AGENT_RUN_WORKFLOW.create()
 *   State persistence     = KV (progress) + DO SQLite (conversation)
 *   Checkpointing         = automatic per step (Workflow runtime)
 */

import {
  WorkflowEntrypoint,
  WorkflowStep,
  WorkflowEvent,
  NonRetryableError,
} from "cloudflare:workers";

// ── Types ────────────────────────────────────────────────────

export interface AgentRunParams {
  agent_name: string;
  input: string;
  org_id: string;
  project_id: string;
  channel: string;
  channel_user_id: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  progress_key: string;
  /** If set, this is a delegated sub-agent run */
  parent_session_id?: string;
  parent_depth?: number;
  /** Override the system prompt for this run (used by training eval) */
  system_prompt_override?: string;
}

export interface RunOutput {
  output: string;
  turns: number;
  tool_calls: number;
  cost_usd: number;
  session_id: string;
  trace_id: string;
}

interface LLMResult {
  content: string;
  tool_calls: Array<{ id: string; name: string; arguments: string }>;
  model: string;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
}

// ── Workflow ─────────────────────────────────────────────────

export class AgentRunWorkflow extends WorkflowEntrypoint<Env, AgentRunParams> {
  async run(event: WorkflowEvent<AgentRunParams>, step: WorkflowStep): Promise<RunOutput> {
    const p = event.payload;
    const sessionId = event.instanceId.slice(0, 16);
    const traceId = crypto.randomUUID().slice(0, 16);

    // ═══════════════════════════════════════════════════════════
    // STEP 1: BOOTSTRAP — load config, skills, reasoning strategy
    // ═══════════════════════════════════════════════════════════

    const bootstrap = await step.do("bootstrap", {
      retries: { limit: 3, delay: "2 seconds", backoff: "exponential" },
      timeout: "30 seconds",
    }, async () => {
      const { loadAgentConfig } = await import("./runtime/db");
      const config = await loadAgentConfig(this.env.HYPERDRIVE, p.agent_name, {
        provider: this.env.DEFAULT_PROVIDER || "openrouter",
        model: this.env.DEFAULT_MODEL || "openai/gpt-5.4-mini",
        plan: "standard",
      });

      // Reasoning strategy
      const { selectReasoningStrategy, autoSelectStrategy } = await import("./runtime/reasoning-strategies");
      const { getToolDefinitions } = await import("./runtime/tools");
      const toolDefs = getToolDefinitions(config.tools, config.blocked_tools);
      const reasoningPrompt = selectReasoningStrategy(
        config.reasoning_strategy as string | undefined, p.input, 1,
      ) || autoSelectStrategy(p.input, toolDefs.length);

      return {
        config: {
          system_prompt: config.system_prompt,
          model: config.model,
          provider: String(config.provider || "openrouter"),
          plan: config.plan,
          tools: config.tools,
          blocked_tools: config.blocked_tools || [],
          max_turns: config.max_turns || 50,
          budget_limit_usd: config.budget_limit_usd || 10,
          parallel_tool_calls: config.parallel_tool_calls !== false,
          reasoning_strategy: config.reasoning_strategy,
          routing: config.routing,
        },
        reasoning_prompt: reasoningPrompt,
        tool_count: toolDefs.length,
      };
    });

    const config = bootstrap.config;

    await this.emit(p.progress_key, {
      type: "session_start", session_id: sessionId, trace_id: traceId,
      agent_name: p.agent_name,
    });

    if (bootstrap.reasoning_prompt) {
      await this.emit(p.progress_key, {
        type: "reasoning", strategy: config.reasoning_strategy || "auto",
      });
    }

    // ═══════════════════════════════════════════════════════════
    // STEP 2: BUILD MESSAGES
    // ═══════════════════════════════════════════════════════════

    let messages: Array<{ role: string; content: string; tool_calls?: any[]; tool_call_id?: string; name?: string }> = [];
    // Use system_prompt_override if provided (training eval), otherwise use agent config
    const effectiveSystemPrompt = p.system_prompt_override || config.system_prompt;
    if (effectiveSystemPrompt) {
      messages.push({ role: "system", content: effectiveSystemPrompt });
    }
    if (bootstrap.reasoning_prompt) {
      messages.push({ role: "system", content: bootstrap.reasoning_prompt });
    }
    for (const msg of p.history) {
      messages.push({ role: msg.role, content: msg.content });
    }
    messages.push({ role: "user", content: p.input });

    // ═══════════════════════════════════════════════════════════
    // STEP 3: AGENTIC TURN LOOP
    // ═══════════════════════════════════════════════════════════

    let totalCost = 0;
    let totalToolCalls = 0;
    let finalOutput = "";

    for (let turn = 1; turn <= config.max_turns; turn++) {

      // ── Budget check (no step needed — pure logic) ──
      if (totalCost >= config.budget_limit_usd) {
        await this.emit(p.progress_key, { type: "error", message: "Budget exhausted", code: "BUDGET_EXHAUSTED" });
        break;
      }

      // ── LLM call — retryable, checkpointed ──
      await this.emit(p.progress_key, { type: "turn_start", turn, model: config.model });

      const llm = await step.do(`llm-${turn}`, {
        retries: { limit: 3, delay: "5 seconds", backoff: "exponential" },
        timeout: "2 minutes",
      }, async () => {
        const { callLLM } = await import("./runtime/llm");
        const { getToolDefinitions } = await import("./runtime/tools");
        const { resolvePlanRouting } = await import("./runtime/db");
        const routerMod = await import("./runtime/router");

        const planRouting = resolvePlanRouting(config.plan, config.routing as any);
        const route = await routerMod.selectModel(p.input, planRouting as any, config.model, config.provider, {
          AI: this.env.AI,
          CLOUDFLARE_ACCOUNT_ID: this.env.CLOUDFLARE_ACCOUNT_ID || "",
          AI_GATEWAY_ID: this.env.AI_GATEWAY_ID || "",
          AI_GATEWAY_TOKEN: this.env.AI_GATEWAY_TOKEN || "",
          CLOUDFLARE_API_TOKEN: this.env.CLOUDFLARE_API_TOKEN || "",
        } as any);

        const toolDefs = getToolDefinitions(config.tools, config.blocked_tools);
        const response = await callLLM(
          { AI: this.env.AI, CLOUDFLARE_ACCOUNT_ID: this.env.CLOUDFLARE_ACCOUNT_ID, AI_GATEWAY_ID: this.env.AI_GATEWAY_ID, AI_GATEWAY_TOKEN: this.env.AI_GATEWAY_TOKEN, CLOUDFLARE_API_TOKEN: this.env.CLOUDFLARE_API_TOKEN } as any,
          messages.map(m => ({ role: m.role as any, content: m.content || "", tool_calls: m.tool_calls, tool_call_id: m.tool_call_id, name: m.name })),
          toolDefs,
          { model: route.model, provider: route.provider, max_tokens: route.max_tokens },
        );

        return {
          content: response.content || "",
          tool_calls: response.tool_calls || [],
          model: response.model || route.model,
          cost_usd: response.cost_usd || 0,
          input_tokens: response.usage?.input_tokens || 0,
          output_tokens: response.usage?.output_tokens || 0,
        } as LLMResult;
      });

      totalCost += llm.cost_usd;

      // ── Thinking trace ──
      if (llm.tool_calls.length > 0 && llm.content) {
        await this.emit(p.progress_key, { type: "thinking", content: llm.content, turn });
      }

      // ── No tools → final answer ──
      if (llm.tool_calls.length === 0) {
        finalOutput = llm.content;
        await this.emit(p.progress_key, {
          type: "turn_end", turn, model: llm.model, cost_usd: llm.cost_usd,
          tokens: llm.input_tokens + llm.output_tokens, done: true,
        });
        break;
      }

      // ── PARALLEL TOOL EXECUTION ──
      // Each tool is its own step.do() — independent retries, checkpointing.
      // Promise.all runs them concurrently. This is the real parallelism.
      await this.emit(p.progress_key, {
        type: "tool_calls", tools: llm.tool_calls.map(tc => tc.name), turn,
      });

      const toolResultEntries = await Promise.all(
        llm.tool_calls.map((tc, i) =>
          step.do(`tool-${turn}-${i}-${tc.name}`, {
            retries: { limit: 2, delay: "3 seconds", backoff: "linear" },
            timeout: "5 minutes",
          }, async () => {
            const { executeTools } = await import("./runtime/tools");
            const results = await executeTools(
              {
                AI: this.env.AI, HYPERDRIVE: this.env.HYPERDRIVE,
                VECTORIZE: this.env.VECTORIZE, STORAGE: this.env.STORAGE,
                SANDBOX: this.env.SANDBOX, LOADER: this.env.LOADER,
                BROWSER: this.env.BROWSER, BRAVE_SEARCH_KEY: this.env.BRAVE_SEARCH_KEY,
                CLOUDFLARE_ACCOUNT_ID: this.env.CLOUDFLARE_ACCOUNT_ID,
                CLOUDFLARE_API_TOKEN: this.env.CLOUDFLARE_API_TOKEN,
                AI_GATEWAY_ID: this.env.AI_GATEWAY_ID,
                AI_GATEWAY_TOKEN: this.env.AI_GATEWAY_TOKEN,
                // Workflow + KV bindings for sub-agent delegation
                AGENT_RUN_WORKFLOW: this.env.AGENT_RUN_WORKFLOW,
                AGENT_PROGRESS_KV: this.env.AGENT_PROGRESS_KV,
                // Auth + API bindings for marketplace/feed/memory/mcp tools
                SERVICE_TOKEN: (this.env as any).SERVICE_TOKEN,
                CONTROL_PLANE_URL: (this.env as any).CONTROL_PLANE_URL,
                OPENROUTER_API_KEY: (this.env as any).OPENROUTER_API_KEY,
                // Agent config for plan-aware tool routing (vision model, etc.)
                __agentConfig: config,
              } as any,
              [{ id: tc.id, name: tc.name, arguments: tc.arguments }],
              sessionId,
              false, // single tool per step
              config.tools,
            );
            const r = results[0];
            return {
              tool_call_id: tc.id,
              name: tc.name,
              result: typeof r?.result === "string" ? r.result : JSON.stringify(r?.result || ""),
              error: r?.error || undefined,
              latency_ms: r?.latency_ms || 0,
              cost_usd: r?.cost_usd || 0,
            };
          })
        )
      );

      totalToolCalls += llm.tool_calls.length;

      // Accumulate tool costs (was missing — caused silent zero billing for tools)
      for (const tr of toolResultEntries) {
        totalCost += tr.cost_usd || 0;
      }

      // Emit tool results
      for (const tr of toolResultEntries) {
        await this.emit(p.progress_key, {
          type: "tool_result", name: tr.name, tool_call_id: tr.tool_call_id,
          result: (tr.result || "").slice(0, 500),
          error: tr.error, latency_ms: tr.latency_ms,
        });
      }

      // ── Build messages for next turn ──
      messages.push({
        role: "assistant", content: llm.content || "",
        tool_calls: llm.tool_calls,
      });
      for (const tr of toolResultEntries) {
        messages.push({
          role: "tool", tool_call_id: tr.tool_call_id,
          name: tr.name,
          content: tr.error ? `Error: ${tr.error}` : tr.result,
        });
      }

      await this.emit(p.progress_key, {
        type: "turn_end", turn, model: llm.model, cost_usd: llm.cost_usd,
        tokens: llm.input_tokens + llm.output_tokens, done: false,
        tool_calls: llm.tool_calls.length,
      });

      // ── Loop detection (simple: same tool call 3x in a row) ──
      if (turn >= 3) {
        const recentTools = [];
        for (let t = turn; t >= Math.max(1, turn - 2); t--) {
          const stepName = `llm-${t}`;
          // We can check the tool_calls from this turn's LLM result
          // For simplicity, check if ALL recent turns called the same tools
        }
        // TODO: implement proper loop detection by comparing tool signatures
      }

      // Keep messages under 1 MiB (Workflow step return limit)
      if (JSON.stringify(messages).length > 800_000) {
        // Trim old messages, keep system + last 10
        const system = messages.filter(m => m.role === "system");
        const recent = messages.filter(m => m.role !== "system").slice(-10);
        messages = [...system, ...recent];
      }
    }

    // ═══════════════════════════════════════════════════════════
    // STEP 4: FINALIZE
    // ═══════════════════════════════════════════════════════════

    // If loop ended without final answer, do one more LLM call without tools
    if (!finalOutput && totalToolCalls > 0) {
      const recovery = await step.do("recovery-llm", {
        retries: { limit: 2, delay: "3 seconds", backoff: "exponential" },
        timeout: "2 minutes",
      }, async () => {
        const { callLLM } = await import("./runtime/llm");
        const response = await callLLM(
          { AI: this.env.AI, CLOUDFLARE_ACCOUNT_ID: this.env.CLOUDFLARE_ACCOUNT_ID, AI_GATEWAY_ID: this.env.AI_GATEWAY_ID, AI_GATEWAY_TOKEN: this.env.AI_GATEWAY_TOKEN, CLOUDFLARE_API_TOKEN: this.env.CLOUDFLARE_API_TOKEN } as any,
          messages.map(m => ({ role: m.role as any, content: m.content || "", tool_calls: m.tool_calls, tool_call_id: m.tool_call_id, name: m.name })),
          [], // no tools — force text response
          { model: config.model, provider: config.provider, max_tokens: 4096 },
        );
        return { content: response.content || "", cost_usd: response.cost_usd || 0 };
      });
      finalOutput = recovery.content;
      totalCost += recovery.cost_usd;
    }

    const result: RunOutput = {
      output: finalOutput,
      turns: totalToolCalls > 0 ? Math.ceil(totalToolCalls) : 1,
      tool_calls: totalToolCalls,
      cost_usd: Math.round(totalCost * 1_000_000) / 1_000_000,
      session_id: sessionId,
      trace_id: traceId,
    };

    // Emit final done event
    await step.do("finalize", async () => {
      await this.emit(p.progress_key, { type: "done", ...result });
    });

    return result;
  }

  // ── Progress emission to KV ────────────────────────────────

  private async emit(key: string, event: Record<string, unknown>) {
    if (!this.env.AGENT_PROGRESS_KV) return;
    try {
      const raw = await this.env.AGENT_PROGRESS_KV.get(key);
      const events: any[] = raw ? JSON.parse(raw) : [];
      events.push({ ...event, ts: Date.now() });
      // Keep last 200 events, expire after 1 hour
      await this.env.AGENT_PROGRESS_KV.put(key, JSON.stringify(events.slice(-200)), { expirationTtl: 3600 });
    } catch {}
  }
}
