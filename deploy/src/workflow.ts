/**
 * AgentRunWorkflow — Durable agent execution using Cloudflare Workflows.
 *
 * Each agent turn is a step.do() — automatic retries, crash recovery, no state corruption.
 * The DO triggers the Workflow, polls progress from KV, and pushes events to the client.
 *
 * Architecture:
 *   Client ←WebSocket/SSE→ DO (real-time push, session state)
 *                            ↓ env.AGENT_RUN_WORKFLOW.create()
 *                        Workflow (durable turn loop)
 *                            ↓ writes to KV after each step
 *                           KV ← DO reads & pushes to client
 *
 * Each turn uses ~2-3 steps: LLM call + tool execution + progress write.
 * With 10,000 step limit on paid plans, supports ~3,300 turns per run.
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
  /** KV key prefix for progress updates (DO polls this) */
  progress_key: string;
}

interface LLMResult {
  content: string;
  tool_calls: Array<{ id: string; name: string; arguments: string }>;
  model: string;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
}

interface ToolResult {
  tool: string;
  tool_call_id: string;
  result: string;
  error?: string;
  latency_ms: number;
}

interface TurnOutput {
  turn: number;
  llm_content: string;
  tool_calls: LLMResult["tool_calls"];
  tool_results: ToolResult[];
  model: string;
  cost_usd: number;
  done: boolean;
}

interface RunOutput {
  output: string;
  turns: number;
  tool_calls: number;
  cost_usd: number;
  session_id: string;
}

// ── Workflow ─────────────────────────────────────────────────

export class AgentRunWorkflow extends WorkflowEntrypoint<Env, AgentRunParams> {
  async run(event: WorkflowEvent<AgentRunParams>, step: WorkflowStep): Promise<RunOutput> {
    const { agent_name, input, org_id, history, progress_key } = event.payload;
    const sessionId = event.instanceId.slice(0, 16);

    // Step 1: Load agent config
    const config = await step.do("load-config", {
      retries: { limit: 3, delay: "2 seconds", backoff: "exponential" },
      timeout: "30 seconds",
    }, async () => {
      const { loadAgentConfig } = await import("./runtime/db");
      return await loadAgentConfig(this.env.HYPERDRIVE, agent_name, {
        provider: this.env.DEFAULT_PROVIDER || "openrouter",
        model: this.env.DEFAULT_MODEL || "openai/gpt-5.4-mini",
        plan: "standard",
      });
    });

    // Step 2: Build initial messages
    const messages: Array<{ role: string; content: string; tool_calls?: any[]; tool_call_id?: string; name?: string }> = [];
    if (config.system_prompt) {
      messages.push({ role: "system", content: config.system_prompt });
    }
    for (const msg of history) {
      messages.push({ role: msg.role, content: msg.content });
    }
    messages.push({ role: "user", content: input });

    // Step 3: Select reasoning strategy
    const reasoningPrompt = await step.do("select-reasoning", async () => {
      const { selectReasoningStrategy, autoSelectStrategy } = await import("./runtime/reasoning-strategies");
      const { getToolDefinitions } = await import("./runtime/tools");
      const toolDefs = getToolDefinitions(config.tools, config.blocked_tools);
      return selectReasoningStrategy(config.reasoning_strategy as string | undefined, input, 1)
        || autoSelectStrategy(input, toolDefs.length);
    });

    if (reasoningPrompt) {
      messages.push({ role: "system", content: reasoningPrompt });
      await this.writeProgress(progress_key, { type: "reasoning", strategy: "auto", turn: 0 });
    }

    // Step 4: Agentic turn loop
    let totalCost = 0;
    let totalToolCalls = 0;
    let finalOutput = "";
    const maxTurns = config.max_turns || 50;

    for (let turn = 1; turn <= maxTurns; turn++) {
      // Budget check
      if (totalCost >= (config.budget_limit_usd || 10)) {
        await this.writeProgress(progress_key, { type: "error", message: "Budget exhausted" });
        break;
      }

      // LLM call — each call is its own step with retries
      const llmResult = await step.do(`llm-turn-${turn}`, {
        retries: { limit: 3, delay: "5 seconds", backoff: "exponential" },
        timeout: "2 minutes",
      }, async () => {
        const routerMod = await import("./runtime/router");
        const { resolvePlanRouting } = await import("./runtime/db");
        const planRouting = resolvePlanRouting(config.plan, config.routing as Record<string, any> | undefined);
        const route = await routerMod.selectModel(input, planRouting as any, config.model, String(config.provider || "openrouter"), {
          AI: this.env.AI,
          CLOUDFLARE_ACCOUNT_ID: this.env.CLOUDFLARE_ACCOUNT_ID || "",
          AI_GATEWAY_ID: this.env.AI_GATEWAY_ID || "",
          AI_GATEWAY_TOKEN: this.env.AI_GATEWAY_TOKEN || "",
          CLOUDFLARE_API_TOKEN: this.env.CLOUDFLARE_API_TOKEN || "",
        } as any);

        const { getToolDefinitions } = await import("./runtime/tools");
        const toolDefs = getToolDefinitions(config.tools, config.blocked_tools);

        // Non-streaming LLM call (Workflows don't stream)
        const { callLLM } = await import("./runtime/llm");
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

      totalCost += llmResult.cost_usd;

      // Write thinking trace if content alongside tool calls
      if (llmResult.tool_calls.length > 0 && llmResult.content) {
        await this.writeProgress(progress_key, { type: "thinking", content: llmResult.content, turn });
      }

      // No tool calls → final answer
      if (llmResult.tool_calls.length === 0) {
        finalOutput = llmResult.content;
        await this.writeProgress(progress_key, {
          type: "done",
          output: finalOutput,
          turn,
          model: llmResult.model,
          cost_usd: totalCost,
          tool_calls: totalToolCalls,
        });
        break;
      }

      // Tool execution — its own step with retries
      const toolResults = await step.do(`tools-turn-${turn}`, {
        retries: { limit: 2, delay: "3 seconds", backoff: "linear" },
        timeout: "5 minutes",
      }, async () => {
        const { executeTools, getToolDefinitions } = await import("./runtime/tools");
        const results = await executeTools(
          {
            AI: this.env.AI,
            HYPERDRIVE: this.env.HYPERDRIVE,
            VECTORIZE: this.env.VECTORIZE,
            STORAGE: this.env.STORAGE,
            SANDBOX: this.env.SANDBOX,
            LOADER: this.env.LOADER,
            BROWSER: this.env.BROWSER,
            BRAVE_SEARCH_KEY: this.env.BRAVE_SEARCH_KEY,
            CLOUDFLARE_ACCOUNT_ID: this.env.CLOUDFLARE_ACCOUNT_ID,
            CLOUDFLARE_API_TOKEN: this.env.CLOUDFLARE_API_TOKEN,
            AI_GATEWAY_ID: this.env.AI_GATEWAY_ID,
            AI_GATEWAY_TOKEN: this.env.AI_GATEWAY_TOKEN,
          } as any,
          llmResult.tool_calls.map(tc => ({
            id: tc.id, name: tc.name, arguments: tc.arguments,
          })),
          sessionId,
          config.parallel_tool_calls !== false,
          config.tools,
        );
        return results.map(r => ({
          tool: r.tool,
          tool_call_id: r.tool_call_id,
          result: typeof r.result === "string" ? r.result : JSON.stringify(r.result),
          error: r.error,
          latency_ms: r.latency_ms || 0,
        }));
      });

      totalToolCalls += llmResult.tool_calls.length;

      // Add to messages for next turn
      messages.push({
        role: "assistant",
        content: llmResult.content || "",
        tool_calls: llmResult.tool_calls,
      });
      for (let i = 0; i < llmResult.tool_calls.length; i++) {
        const tc = llmResult.tool_calls[i];
        const tr = toolResults[i];
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          name: tc.name,
          content: tr?.error ? `Error: ${tr.error}` : (tr?.result || ""),
        });
      }

      // Write progress for this turn
      await step.do(`progress-turn-${turn}`, async () => {
        await this.writeProgress(progress_key, {
          type: "turn_end",
          turn,
          model: llmResult.model,
          cost_usd: llmResult.cost_usd,
          tool_calls: llmResult.tool_calls.map(tc => tc.name),
          tool_results: toolResults.map(tr => ({
            name: tr.tool,
            error: tr.error,
            latency_ms: tr.latency_ms,
            result_preview: (tr.result || "").slice(0, 200),
          })),
        });
      });
    }

    // If loop ended without a final answer, capture last content
    if (!finalOutput && messages.length > 0) {
      const lastAssistant = [...messages].reverse().find(m => m.role === "assistant");
      finalOutput = lastAssistant?.content || "";
    }

    // Final output
    const result: RunOutput = {
      output: finalOutput,
      turns: totalToolCalls > 0 ? Math.ceil(totalToolCalls) : 1,
      tool_calls: totalToolCalls,
      cost_usd: Math.round(totalCost * 1_000_000) / 1_000_000,
      session_id: sessionId,
    };

    // Write final status
    await step.do("write-final", async () => {
      await this.writeProgress(progress_key, {
        type: "done",
        ...result,
      });
    });

    return result;
  }

  /** Write progress to KV for the DO to poll and push to the client. */
  private async writeProgress(key: string, data: Record<string, unknown>) {
    try {
      // Append to progress list in KV
      const existing = await this.env.AGENT_PROGRESS_KV?.get(key);
      const events = existing ? JSON.parse(existing) : [];
      events.push({ ...data, timestamp: Date.now() });
      // Keep last 100 events
      const trimmed = events.slice(-100);
      await this.env.AGENT_PROGRESS_KV?.put(key, JSON.stringify(trimmed), { expirationTtl: 3600 });
    } catch {} // non-blocking
  }
}
